import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execCommand } from "../src/core/exec.ts";
import {
	abortSync,
	buildSyncStatus,
	continueSync,
	createDefaultWorktreeSyncExec,
	createLane,
	landLane,
	syncLane,
	type WorktreeSyncEngineDeps,
} from "../src/core/worktree-sync/git-engine.ts";
import { acquireIntegrationLock, releaseIntegrationLock, syncStorePaths } from "../src/core/worktree-sync/store.ts";

/**
 * REAL-git integration suite: every scenario runs against actual repositories in temp dirs --
 * the serialized land gate, the epoch CAS (G3), conflict worklists, marker-verified continue,
 * rerere mechanical replay, and the linearity of main are all exercised for real. The scripted
 * unit suites cover refusal-code breadth; this suite proves the git mechanics.
 */

const cleanups: string[] = [];

afterEach(() => {
	while (cleanups.length > 0) {
		const dir = cleanups.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

async function git(cwd: string, ...args: string[]): Promise<string> {
	const result = await execCommand("git", args, cwd);
	if (result.code !== 0) {
		throw new Error(`git ${args.join(" ")} failed (${result.code}): ${result.stderr || result.stdout}`);
	}
	return result.stdout.trim();
}

interface Harness {
	repo: string;
	deps: WorktreeSyncEngineDeps;
}

async function initRepo(): Promise<Harness> {
	const root = mkdtempSync(join(tmpdir(), "pi-wt-sync-it-"));
	cleanups.push(root);
	const repo = join(root, "repo");
	await git(root, "init", "-b", "main", repo);
	await git(repo, "config", "user.email", "it@example.invalid");
	await git(repo, "config", "user.name", "worktree-sync-it");
	await git(repo, "config", "commit.gpgsign", "false");
	// Environment-independence: a global core.autocrlf would rewrite checkouts to CRLF and break
	// byte-exact content assertions.
	await git(repo, "config", "core.autocrlf", "false");
	writeFileSync(join(repo, "README.md"), "line1\n", "utf-8");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-m", "base");
	const deps: WorktreeSyncEngineDeps = {
		exec: createDefaultWorktreeSyncExec(),
		cwd: repo,
		worktreesBaseDir: join(root, "worktrees"),
		options: { maxLanes: 8 },
		sessionId: "it-session",
	};
	return { repo, deps };
}

async function laneCommit(worktreePath: string, file: string, content: string, message: string): Promise<string> {
	writeFileSync(join(worktreePath, file), content, "utf-8");
	await git(worktreePath, "add", "-A");
	await git(worktreePath, "commit", "-m", message);
	return git(worktreePath, "rev-parse", "HEAD");
}

async function mustCreateLane(deps: WorktreeSyncEngineDeps, laneKey: string) {
	const created = await createLane(deps, { laneKey });
	expect(created.code).toBe("ok");
	if (created.code !== "ok") throw new Error("lane creation failed");
	return created.lane;
}

describe("worktree-sync against real git", () => {
	it("two lanes: A lands, B is refused stale (G3), syncs through a real conflict, continues, lands; main stays linear", async () => {
		const { repo, deps } = await initRepo();
		const laneA = await mustCreateLane(deps, "a");
		const laneB = await mustCreateLane(deps, "b");

		await laneCommit(laneA.worktreePath, "README.md", "from-a\n", "a: change readme");
		const landA = await landLane(deps, { laneKey: "a", gate: "off" });
		expect(landA).toMatchObject({ code: "ok", epoch: 1, gate: "off" });

		const tipB = await laneCommit(laneB.worktreePath, "README.md", "from-b\n", "b: change readme");
		const staleLand = await landLane(deps, { laneKey: "b", gate: "off" });
		expect(staleLand.code).toBe("stale_lane");

		const sync = await syncLane(deps, { laneKey: "b" });
		expect(sync.code).toBe("sync_conflicts");
		if (sync.code !== "sync_conflicts") throw new Error("expected conflicts");
		expect(sync.worklist.files).toEqual([{ path: "README.md", kind: "both_modified", resolvedByRerere: false }]);
		expect(sync.worklist.step).toBe("1/1");
		expect(sync.worklist.stoppedAtCommit?.sha).toBe(tipB);

		// zdiff3 hunks include the base section (D7) -- verify the substrate is really on.
		const conflicted = readFileSync(join(laneB.worktreePath, "README.md"), "utf-8");
		expect(conflicted).toContain("|||||||");

		// The agent resolves; markers still present -> mechanically refused (G9).
		const premature = await continueSync(deps, { laneKey: "b" });
		expect(premature.code).toBe("conflict_markers_present");
		expect(premature.code === "conflict_markers_present" && premature.paths).toEqual(["README.md"]);

		writeFileSync(join(laneB.worktreePath, "README.md"), "resolved\n", "utf-8");
		const continued = await continueSync(deps, { laneKey: "b" });
		expect(continued).toMatchObject({ code: "sync_clean" });

		const landB = await landLane(deps, { laneKey: "b", gate: "on", gateCommand: "exit 0" });
		expect(landB).toMatchObject({ code: "ok", epoch: 2, gate: "passed" });

		expect(readFileSync(join(repo, "README.md"), "utf-8")).toBe("resolved\n");
		expect(await git(repo, "rev-list", "--count", "main")).toBe("3");
		expect(await git(repo, "rev-list", "--merges", "--count", "main")).toBe("0");

		// After epoch 2, lane b IS current main; lane a (fully landed, no new work) genuinely
		// does not contain b's commit -- honestly stale, and its catch-up sync is a trivial
		// mechanical fast-forward with no conflicts.
		const status = await buildSyncStatus(deps, { policy: "on_land_mandatory" });
		expect(status.code).toBe("ok");
		if (status.code === "ok") {
			expect(status.epoch).toBe(2);
			expect(status.lanes.find((lane) => lane.laneKey === "b")?.fresh).toBe(true);
			const a = status.lanes.find((lane) => lane.laneKey === "a");
			expect(a?.stale).toBe(true);
			expect(a?.aheadOfMain).toBe(0);
		}
		expect((await syncLane(deps, { laneKey: "a" })).code).toBe("sync_clean");
		const caughtUp = await buildSyncStatus(deps, { policy: "on_land_mandatory" });
		expect(caughtUp.code).toBe("ok");
		if (caughtUp.code === "ok") {
			expect(caughtUp.lanes.every((lane) => lane.fresh)).toBe(true);
			expect(caughtUp.advice).toBe("all lanes fresh");
		}
	}, 60_000);

	it("staleness propagation policies: on_land_mandatory gates every stale lane, overlap_mandatory only on file overlap, land_time_only never", async () => {
		const { deps } = await initRepo();
		await mustCreateLane(deps, "a");
		const laneB = await mustCreateLane(deps, "b");

		// A freshly-created lane syncs as an idempotent no-op.
		const freshSync = await syncLane(deps, { laneKey: "a" });
		expect(freshSync).toMatchObject({ code: "sync_clean", alreadyFresh: true });

		// Lane c lands a change to file2.txt.
		const created = await createLane(deps, { laneKey: "c" });
		expect(created.code).toBe("ok");
		if (created.code !== "ok") return;
		await laneCommit(created.lane.worktreePath, "file2.txt", "v1\n", "c: add file2");
		expect((await landLane(deps, { laneKey: "c", gate: "off" })).code).toBe("ok");

		const mandatory = await buildSyncStatus(deps, { policy: "on_land_mandatory" });
		expect(mandatory.code).toBe("ok");
		if (mandatory.code === "ok") {
			const b = mandatory.lanes.find((lane) => lane.laneKey === "b");
			expect(b?.stale).toBe(true);
			expect(b?.syncRequired).toBe(true);
			expect(mandatory.advice).toContain("must rebase main");
		}

		const advisory = await buildSyncStatus(deps, { policy: "land_time_only" });
		expect(advisory.code).toBe("ok");
		if (advisory.code === "ok") {
			expect(advisory.lanes.find((lane) => lane.laneKey === "b")?.syncRequired).toBe(false);
		}

		// No overlap yet: B changed nothing. Then B touches the landed file -> overlap gates it.
		const overlapBefore = await buildSyncStatus(deps, { policy: "overlap_mandatory" });
		expect(overlapBefore.code).toBe("ok");
		if (overlapBefore.code === "ok") {
			expect(overlapBefore.lanes.find((lane) => lane.laneKey === "b")?.syncRequired).toBe(false);
		}
		await laneCommit(laneB.worktreePath, "file2.txt", "v2\n", "b: also touch file2");
		const overlapAfter = await buildSyncStatus(deps, { policy: "overlap_mandatory" });
		expect(overlapAfter.code).toBe("ok");
		if (overlapAfter.code === "ok") {
			const b = overlapAfter.lanes.find((lane) => lane.laneKey === "b");
			expect(b?.syncRequired).toBe(true);
			expect(b?.overlapWithLastLand).toEqual(["file2.txt"]);
		}
	}, 60_000);

	it("land gates: dirty lane (G2), failing/unset gate command (G4), overlap-only hub dirt (G6), busy lock (G1)", async () => {
		const { repo, deps } = await initRepo();
		const lane = await mustCreateLane(deps, "a");

		writeFileSync(join(lane.worktreePath, "README.md"), "wip\n", "utf-8");
		const dirtyRefusal = await landLane(deps, { laneKey: "a", gate: "off" });
		expect(dirtyRefusal.code).toBe("lane_dirty");
		expect(dirtyRefusal.code === "lane_dirty" && dirtyRefusal.paths).toEqual(["README.md"]);

		await git(lane.worktreePath, "add", "-A");
		await git(lane.worktreePath, "commit", "-m", "a: wip readme");

		expect((await landLane(deps, { laneKey: "a", gate: "on" })).code).toBe("gate_command_unset");
		const gateFailed = await landLane(deps, { laneKey: "a", gate: "on", gateCommand: "exit 3" });
		expect(gateFailed.code).toBe("gate_failed");

		// Hub dirt on the SAME file the land would update -> refused with exactly that path.
		writeFileSync(join(repo, "README.md"), "hub-local-edit\n", "utf-8");
		const endangered = await landLane(deps, { laneKey: "a", gate: "off" });
		expect(endangered.code).toBe("hub_dirty");
		expect(endangered.code === "hub_dirty" && endangered.paths).toEqual(["README.md"]);
		await git(repo, "checkout", "--", "README.md");

		// Unrelated hub dirt does NOT block (overlap-based G6).
		writeFileSync(join(repo, "unrelated.txt"), "scratch\n", "utf-8");

		const paths = syncStorePaths(await git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"));
		await acquireIntegrationLock(paths, { pid: process.pid, hostname: hostname() });
		const busy = await landLane(deps, { laneKey: "a", gate: "off" });
		expect(busy.code).toBe("lock_busy");
		expect(busy.code === "lock_busy" && busy.holder?.pid).toBe(process.pid);
		await releaseIntegrationLock(paths);

		expect((await landLane(deps, { laneKey: "a", gate: "off" })).code).toBe("ok");
	}, 60_000);

	it("abort_sync returns the lane to its pre-sync tip, honestly still stale; rerere mechanically replays an identical conflict on the next sync", async () => {
		const { deps } = await initRepo();
		const laneP = await mustCreateLane(deps, "p");
		const laneQ = await mustCreateLane(deps, "q");

		await laneCommit(laneP.worktreePath, "README.md", "from-p\n", "p: change readme");
		expect((await landLane(deps, { laneKey: "p", gate: "off" })).code).toBe("ok");

		const preSyncTip = await laneCommit(laneQ.worktreePath, "README.md", "from-q\n", "q: change readme");

		// First sync: conflict; abort; tip unchanged and still stale.
		expect((await syncLane(deps, { laneKey: "q" })).code).toBe("sync_conflicts");
		expect((await abortSync(deps, { laneKey: "q" })).code).toBe("ok");
		expect(await git(laneQ.worktreePath, "rev-parse", "HEAD")).toBe(preSyncTip);
		const afterAbort = await buildSyncStatus(deps, { policy: "on_land_mandatory" });
		expect(afterAbort.code === "ok" && afterAbort.lanes.find((lane) => lane.laneKey === "q")?.stale).toBe(true);

		// Second sync: same conflict; resolve manually; rerere records the resolution.
		expect((await syncLane(deps, { laneKey: "q" })).code).toBe("sync_conflicts");
		writeFileSync(join(laneQ.worktreePath, "README.md"), "resolved-pq\n", "utf-8");
		expect((await continueSync(deps, { laneKey: "q" })).code).toBe("sync_clean");

		// Rewind to the identical pre-sync state: the third sync hits the SAME conflict and
		// rerere replays the recorded resolution -- fully mechanical, zero agent involvement.
		await git(laneQ.worktreePath, "reset", "--hard", preSyncTip);
		const replayed = await syncLane(deps, { laneKey: "q" });
		expect(replayed.code).toBe("sync_clean");
		if (replayed.code === "sync_clean") expect(replayed.autoContinued).toBeGreaterThan(0);
		expect(readFileSync(join(laneQ.worktreePath, "README.md"), "utf-8")).toBe("resolved-pq\n");
	}, 60_000);

	it("concurrent lands serialize under the integration lock: exactly one wins, the loser syncs and lands after", async () => {
		const { repo, deps } = await initRepo();
		const laneA = await mustCreateLane(deps, "a");
		const laneB = await mustCreateLane(deps, "b");
		await laneCommit(laneA.worktreePath, "a.txt", "a\n", "a: add a.txt");
		await laneCommit(laneB.worktreePath, "b.txt", "b\n", "b: add b.txt");

		const [landA, landB] = await Promise.all([
			landLane(deps, { laneKey: "a", gate: "off" }),
			landLane(deps, { laneKey: "b", gate: "off" }),
		]);
		const codes = [landA.code, landB.code];
		expect(codes.filter((code) => code === "ok")).toHaveLength(1);
		const loserCode = codes.find((code) => code !== "ok");
		expect(["lock_busy", "stale_lane"]).toContain(loserCode);

		const loserKey = landA.code === "ok" ? "b" : "a";
		const loserSync = await syncLane(deps, { laneKey: loserKey });
		expect(loserSync.code).toBe("sync_clean");
		expect((await landLane(deps, { laneKey: loserKey, gate: "off" })).code).toBe("ok");
		expect(await git(repo, "rev-list", "--count", "main")).toBe("3");
		expect(await git(repo, "rev-list", "--merges", "--count", "main")).toBe("0");
	}, 60_000);
});
