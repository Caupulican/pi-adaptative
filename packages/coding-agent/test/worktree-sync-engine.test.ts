import { mkdtempSync, rmSync } from "node:fs";
import { hostname as osHostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecResult } from "../src/core/exec.ts";
import type { LaneRegistration } from "../src/core/worktree-sync/codes.ts";
import {
	createLane,
	parseWorktreeList,
	reconcile,
	releaseLane,
	resolveRepoContext,
	type WorktreeSyncEngineDeps,
	type WorktreeSyncExec,
} from "../src/core/worktree-sync/git-engine.ts";
import {
	acquireIntegrationLock,
	readLane,
	readLockHolder,
	repoSlug,
	syncStorePaths,
	writeLane,
} from "../src/core/worktree-sync/store.ts";

/**
 * Scripted faux git: interprets the engine's git invocations against a small in-memory repo
 * model (branches, worktrees, per-checkout porcelain status, ancestry) -- the same
 * faux-driven style as the tmux dispatch-adapter tests. The STORE side runs against a real
 * temp dir; only git itself is faked here (real git is exercised by the integration suite).
 */
interface FauxRepo {
	topLevel: string;
	commonDir: string;
	branches: Map<string, string>;
	worktrees: Array<{ path: string; branchRef?: string; headSha?: string }>;
	statusByPath: Map<string, string>;
	config: Map<string, string>;
	/** isAncestor(a, b): is commit `a` an ancestor of commit `b`? */
	isAncestor: (a: string, b: string) => boolean;
	/** `git rev-list --left-right --count` output ("<behind>\t<ahead>"). */
	counts?: string;
}

interface ExecCall {
	args: string[];
	cwd: string;
}

function ok(stdout = ""): ExecResult {
	return { stdout, stderr: "", code: 0, killed: false, stdoutTruncated: false, stderrTruncated: false };
}

function fail(code = 1, stderr = ""): ExecResult {
	return { stdout: "", stderr, code, killed: false, stdoutTruncated: false, stderrTruncated: false };
}

function fauxGitExec(repo: FauxRepo, calls?: ExecCall[]): WorktreeSyncExec {
	return async (command, args, options) => {
		calls?.push({ args, cwd: options.cwd });
		if (command !== "git") return fail(127, `not git: ${command}`);
		const joined = args.join(" ");
		if (joined === "rev-parse --path-format=absolute --show-toplevel --git-common-dir") {
			return ok(`${repo.topLevel}\n${repo.commonDir}\n`);
		}
		if (args[0] === "rev-parse" && args[1] === "--verify") {
			const name = (args[3] ?? "").replace("refs/heads/", "");
			const sha = repo.branches.get(name);
			return sha ? ok(`${sha}\n`) : fail(1);
		}
		if (joined === "worktree list --porcelain") {
			const blocks = repo.worktrees.map((wt) => {
				const lines = [`worktree ${wt.path}`, `HEAD ${wt.headSha ?? "0".repeat(40)}`];
				lines.push(wt.branchRef !== undefined ? `branch ${wt.branchRef}` : "detached");
				return lines.join("\n");
			});
			return ok(`${blocks.join("\n\n")}\n`);
		}
		if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
			return repo.isAncestor(args[2] ?? "", args[3] ?? "") ? ok() : fail(1);
		}
		if (args[0] === "rev-list") return ok(`${repo.counts ?? "0\t0"}\n`);
		if (args[0] === "status") return ok(repo.statusByPath.get(options.cwd) ?? "");
		if (args[0] === "rev-parse" && args.includes("--git-path")) {
			return ok(`${options.cwd}/.git/rebase-merge\n${options.cwd}/.git/rebase-apply\n`);
		}
		if (args[0] === "config" && args[1] === "--get") {
			const value = repo.config.get(args[2] ?? "");
			return value !== undefined ? ok(`${value}\n`) : fail(1);
		}
		if (args[0] === "config") {
			repo.config.set(args[1] ?? "", args[2] ?? "");
			return ok();
		}
		if (args[0] === "worktree" && args[1] === "add") {
			const branch = args[3] ?? "";
			const path = args[4] ?? "";
			repo.branches.set(branch, `sha-${branch}`);
			repo.worktrees.push({ path, branchRef: `refs/heads/${branch}` });
			return ok();
		}
		if (args[0] === "worktree" && args[1] === "remove") {
			const path = args.at(-1) ?? "";
			const index = repo.worktrees.findIndex((wt) => wt.path === path);
			if (index >= 0) repo.worktrees.splice(index, 1);
			return ok();
		}
		if (args[0] === "branch" && (args[1] === "-d" || args[1] === "-D")) {
			repo.branches.delete(args[2] ?? "");
			return ok();
		}
		if (args[0] === "worktree" && args[1] === "prune") return ok();
		return fail(1, `unhandled git args: ${joined}`);
	};
}

const cleanups: string[] = [];

afterEach(() => {
	while (cleanups.length > 0) {
		const dir = cleanups.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function fauxRepo(overrides: Partial<FauxRepo> = {}): FauxRepo {
	const commonDir = mkdtempSync(join(tmpdir(), "pi-wt-sync-engine-"));
	cleanups.push(commonDir);
	return {
		topLevel: "/repo",
		commonDir,
		branches: new Map([["main", "sha-main"]]),
		worktrees: [{ path: "/repo", branchRef: "refs/heads/main", headSha: "sha-main" }],
		statusByPath: new Map(),
		config: new Map(),
		isAncestor: () => true,
		...overrides,
	};
}

function engineDeps(
	repo: FauxRepo,
	overrides: Partial<WorktreeSyncEngineDeps> & { present?: Set<string>; calls?: ExecCall[] } = {},
): WorktreeSyncEngineDeps {
	const { present, calls, ...deps } = overrides;
	return {
		exec: fauxGitExec(repo, calls),
		cwd: repo.topLevel,
		worktreesBaseDir: "/wtbase",
		options: { maxLanes: 5 },
		now: () => "2026-07-19T12:00:00.000Z",
		pid: 4242,
		sessionId: "sess-1",
		fileExists: (path) => (present ?? new Set()).has(path),
		isPidAlive: (pid) => pid === 4242,
		...deps,
	};
}

function registration(overrides: Partial<LaneRegistration> = {}): LaneRegistration {
	return {
		laneKey: "adhoc-1",
		branch: "pi/wt/adhoc-1",
		worktreePath: "/wtbase/slug/adhoc-1",
		status: "active",
		createdAt: "T0",
		updatedAt: "T0",
		...overrides,
	};
}

describe("parseWorktreeList", () => {
	it("parses porcelain blocks including detached checkouts", () => {
		const parsed = parseWorktreeList(
			[
				"worktree /repo",
				"HEAD aaa",
				"branch refs/heads/main",
				"",
				"worktree /wt/x",
				"HEAD bbb",
				"detached",
				"",
			].join("\n"),
		);
		expect(parsed).toEqual([
			{ path: "/repo", headSha: "aaa", branchRef: "refs/heads/main" },
			{ path: "/wt/x", headSha: "bbb" },
		]);
	});
});

describe("resolveRepoContext", () => {
	it("refuses outside a git repo with not_a_git_repo", async () => {
		const deps = engineDeps(fauxRepo(), { exec: async () => fail(128, "fatal: not a git repository") });
		const ctx = await resolveRepoContext(deps);
		expect("code" in ctx && ctx.code).toBe("not_a_git_repo");
	});

	it("resolves master when main is absent (D13 order) and finds the hub checkout", async () => {
		const repo = fauxRepo({
			branches: new Map([["master", "sha-master"]]),
			worktrees: [{ path: "/repo", branchRef: "refs/heads/master" }],
		});
		const ctx = await resolveRepoContext(engineDeps(repo));
		expect("code" in ctx).toBe(false);
		if (!("code" in ctx)) {
			expect(ctx.mainBranch).toBe("master");
			expect(ctx.mainSha).toBe("sha-master");
			expect(ctx.hubPath).toBe("/repo");
			expect(ctx.paths.root).toBe(syncStorePaths(repo.commonDir).root);
		}
	});

	it("a configured override that does not exist refuses with default_branch_unresolved -- never guesses on", async () => {
		const repo = fauxRepo();
		const ctx = await resolveRepoContext(engineDeps(repo, { options: { maxLanes: 5, mainBranchOverride: "trunk" } }));
		expect("code" in ctx && ctx.code).toBe("default_branch_unresolved");
	});
});

describe("createLane", () => {
	it("creates a lane: deterministic key, worktree add from main, registration, config, audit", async () => {
		const repo = fauxRepo();
		const calls: ExecCall[] = [];
		const deps = engineDeps(repo, { calls });
		const result = await createLane(deps);
		expect(result.code).toBe("ok");
		if (result.code !== "ok") return;

		const slug = repoSlug(repo.topLevel, repo.commonDir);
		expect(result.lane.laneKey).toBe("adhoc-1");
		expect(result.lane.branch).toBe("pi/wt/adhoc-1");
		expect(result.lane.worktreePath).toBe(join("/wtbase", slug, "adhoc-1"));
		expect(result.lane.ownerPid).toBe(4242);

		const addCall = calls.find((call) => call.args[0] === "worktree" && call.args[1] === "add");
		expect(addCall?.args).toEqual(["worktree", "add", "-b", "pi/wt/adhoc-1", result.lane.worktreePath, "main"]);

		// Registration persisted; deterministic conflict substrate configured (D7).
		const paths = syncStorePaths(repo.commonDir);
		expect(await readLane(paths, "adhoc-1")).toMatchObject({ status: "active", branch: "pi/wt/adhoc-1" });
		expect(repo.config.get("rerere.enabled")).toBe("true");
		expect(repo.config.get("merge.conflictStyle")).toBe("zdiff3");
	});

	it("allocates the lowest free goal-scoped key, skipping registrations and existing branches", async () => {
		const repo = fauxRepo();
		repo.branches.set("pi/wt/g1-2", "sha-taken");
		const paths = syncStorePaths(repo.commonDir);
		await writeLane(paths, registration({ laneKey: "g1-1", branch: "pi/wt/g1-1" }));
		const result = await createLane(engineDeps(repo), { goalId: "G1!" });
		expect(result.code).toBe("ok");
		if (result.code === "ok") expect(result.lane.laneKey).toBe("g1-3");
	});

	it("refuses an invalid explicit laneKey and an existing one", async () => {
		const repo = fauxRepo();
		expect((await createLane(engineDeps(repo), { laneKey: "Bad_Key" })).code).toBe("invalid_lane_key");
		repo.branches.set("pi/wt/custom", "sha-custom");
		expect((await createLane(engineDeps(repo), { laneKey: "custom" })).code).toBe("lane_exists");
	});

	it("refuses beyond maxLanes", async () => {
		const repo = fauxRepo();
		await writeLane(syncStorePaths(repo.commonDir), registration());
		const result = await createLane(engineDeps(repo, { options: { maxLanes: 1 } }));
		expect(result.code).toBe("max_lanes_reached");
	});
});

describe("releaseLane", () => {
	it("refuses unknown lanes", async () => {
		const result = await releaseLane(engineDeps(fauxRepo()), { laneKey: "nope" });
		expect(result.code).toBe("lane_not_found");
	});

	it("G11: unlanded commits refuse release without the explicit discard confirmation", async () => {
		const repo = fauxRepo({ isAncestor: () => false, counts: "0\t2" });
		repo.branches.set("pi/wt/adhoc-1", "sha-lane");
		const paths = syncStorePaths(repo.commonDir);
		await writeLane(paths, registration());

		const refused = await releaseLane(engineDeps(repo), { laneKey: "adhoc-1" });
		expect(refused.code).toBe("lane_unlanded_work");

		const calls: ExecCall[] = [];
		const present = new Set(["/wtbase/slug/adhoc-1"]);
		const discarded = await releaseLane(engineDeps(repo, { calls, present }), {
			laneKey: "adhoc-1",
			confirm: "yes-discard-lane",
		});
		expect(discarded.code).toBe("released");
		expect(calls.some((call) => call.args.join(" ") === "worktree remove --force /wtbase/slug/adhoc-1")).toBe(true);
		expect(calls.some((call) => call.args.join(" ") === "branch -D pi/wt/adhoc-1")).toBe(true);
		expect(await readLane(paths, "adhoc-1")).toMatchObject({ status: "released" });
	});

	it("a fully-landed clean lane releases without force and is idempotent", async () => {
		const repo = fauxRepo({ isAncestor: () => true });
		repo.branches.set("pi/wt/adhoc-1", "sha-lane");
		const paths = syncStorePaths(repo.commonDir);
		await writeLane(paths, registration());

		const calls: ExecCall[] = [];
		const present = new Set(["/wtbase/slug/adhoc-1"]);
		const released = await releaseLane(engineDeps(repo, { calls, present }), { laneKey: "adhoc-1" });
		expect(released.code).toBe("released");
		expect(calls.some((call) => call.args.join(" ") === "worktree remove /wtbase/slug/adhoc-1")).toBe(true);
		expect(calls.some((call) => call.args.join(" ") === "branch -d pi/wt/adhoc-1")).toBe(true);

		expect((await releaseLane(engineDeps(repo), { laneKey: "adhoc-1" })).code).toBe("released");
	});
});

describe("reconcile", () => {
	it("marks vanished lanes orphaned, self-heals returned ones, re-registers lost worktrees, clears dead owners, releases a stale lock", async () => {
		const repo = fauxRepo();
		const paths = syncStorePaths(repo.commonDir);

		// gone-1: registered active, but branch+checkout are gone -> orphaned (never deleted).
		await writeLane(
			paths,
			registration({ laneKey: "gone-1", branch: "pi/wt/gone-1", worktreePath: "/wtbase/s/gone-1" }),
		);
		// back-1: registered orphaned, but branch+checkout exist -> self-heals to active.
		repo.branches.set("pi/wt/back-1", "sha-back");
		await writeLane(
			paths,
			registration({
				laneKey: "back-1",
				branch: "pi/wt/back-1",
				worktreePath: "/wtbase/s/back-1",
				status: "orphaned",
			}),
		);
		// dead-owner-1: alive checkout, dead ownerPid -> owner cleared, lane stays active.
		repo.branches.set("pi/wt/dead-owner-1", "sha-dead");
		await writeLane(
			paths,
			registration({
				laneKey: "dead-owner-1",
				branch: "pi/wt/dead-owner-1",
				worktreePath: "/wtbase/s/dead-owner-1",
				ownerPid: 111,
				ownerSessionId: "old",
			}),
		);
		// lost-1: git knows the worktree+branch, the registry does not -> re-registered from git facts.
		repo.branches.set("pi/wt/lost-1", "sha-lost");
		repo.worktrees.push({ path: "/wtbase/s/lost-1", branchRef: "refs/heads/pi/wt/lost-1" });
		// Stale integration lock owned by a dead same-host pid -> released.
		await acquireIntegrationLock(paths, { pid: 777, hostname: osHostname() }, { isPidAlive: () => true });

		const present = new Set(["/wtbase/s/back-1", "/wtbase/s/dead-owner-1", "/wtbase/s/lost-1"]);
		const result = await reconcile(engineDeps(repo, { present }));
		expect(result.code).toBe("reconciled");
		if (result.code !== "reconciled") return;

		expect(result.orphanedLaneKeys).toEqual(["gone-1"]);
		expect(result.reRegisteredLaneKeys.sort()).toEqual(["back-1", "lost-1"]);
		expect(result.ownerClearedLaneKeys).toEqual(["dead-owner-1"]);
		expect(result.staleLockReleased).toBe(true);

		expect(await readLane(paths, "gone-1")).toMatchObject({ status: "orphaned" });
		expect(await readLane(paths, "back-1")).toMatchObject({ status: "active" });
		expect((await readLane(paths, "dead-owner-1"))?.ownerPid).toBeUndefined();
		expect(await readLane(paths, "lost-1")).toMatchObject({ status: "active", branch: "pi/wt/lost-1" });
		expect(await readLockHolder(paths)).toBeUndefined();
	});
});
