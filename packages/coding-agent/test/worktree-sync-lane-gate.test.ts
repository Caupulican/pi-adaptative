import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execCommand } from "../src/core/exec.ts";
import {
	createDefaultWorktreeSyncExec,
	createLane,
	landLane,
	syncLane,
	type WorktreeSyncEngineDeps,
} from "../src/core/worktree-sync/git-engine.ts";
import { classifyLaneBashCommand, WorktreeLaneGate } from "../src/core/worktree-sync/lane-gate.ts";

const cleanups: string[] = [];

afterEach(() => {
	while (cleanups.length > 0) {
		const dir = cleanups.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

async function git(cwd: string, ...args: string[]): Promise<string> {
	const result = await execCommand("git", args, cwd);
	if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
	return result.stdout.trim();
}

async function initRepo(): Promise<{ repo: string; deps: WorktreeSyncEngineDeps }> {
	const root = mkdtempSync(join(tmpdir(), "pi-wt-sync-gate-"));
	cleanups.push(root);
	const repo = join(root, "repo");
	await git(root, "init", "-b", "main", repo);
	await git(repo, "config", "user.email", "it@example.invalid");
	await git(repo, "config", "user.name", "worktree-sync-it");
	await git(repo, "config", "commit.gpgsign", "false");
	writeFileSync(join(repo, "README.md"), "line1\n", "utf-8");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-m", "base");
	return {
		repo,
		deps: {
			exec: createDefaultWorktreeSyncExec(),
			cwd: repo,
			worktreesBaseDir: join(root, "worktrees"),
			options: { maxLanes: 4 },
		},
	};
}

describe("classifyLaneBashCommand (G10)", () => {
	it("refuses pushes, checkout escapes, and main-branch ref mutations; allowlists WIP-saving git while sync_required", () => {
		expect(classifyLaneBashCommand("git push origin main", "main").verdict).toBe("main_mutation_refused");
		expect(classifyLaneBashCommand("cd x && git push", "main").verdict).toBe("main_mutation_refused");
		expect(classifyLaneBashCommand("git -C /hub merge pi/wt/a-1", "main").verdict).toBe("main_mutation_refused");
		expect(classifyLaneBashCommand("git --git-dir=/repo/.git branch -f main abc", "main").verdict).toBe(
			"main_mutation_refused",
		);
		expect(classifyLaneBashCommand("git branch -f main abc123", "main").verdict).toBe("main_mutation_refused");
		expect(classifyLaneBashCommand("git branch -D master", "master").verdict).toBe("main_mutation_refused");
		expect(classifyLaneBashCommand("git update-ref refs/heads/main abc", "main").verdict).toBe(
			"main_mutation_refused",
		);

		expect(classifyLaneBashCommand("git add -A", "main").verdict).toBe("allowed_even_when_sync_required");
		expect(classifyLaneBashCommand('git commit -m "wip"', "main").verdict).toBe("allowed_even_when_sync_required");
		expect(classifyLaneBashCommand("git status --porcelain", "main").verdict).toBe("allowed_even_when_sync_required");
		expect(classifyLaneBashCommand("git log main..HEAD --oneline", "main").verdict).toBe(
			"allowed_even_when_sync_required",
		);

		expect(classifyLaneBashCommand("npm test", "main").verdict).toBe("allowed");
		expect(classifyLaneBashCommand("git branch --list", "main").verdict).toBe("allowed");
		expect(classifyLaneBashCommand("echo git push is a string", "main").verdict).toBe("allowed");
	});
});

describe("WorktreeLaneGate (G8, real git)", () => {
	it("blocks mutations on a sync_required lane, keeps WIP-saving git available, and clears on sync", async () => {
		const { deps } = await initRepo();
		const createdA = await createLane(deps, { laneKey: "a" });
		const createdB = await createLane(deps, { laneKey: "b" });
		expect(createdA.code).toBe("ok");
		expect(createdB.code).toBe("ok");
		if (createdA.code !== "ok" || createdB.code !== "ok") return;

		const gate = new WorktreeLaneGate({
			laneKey: "b",
			engineDeps: () => deps,
			policy: () => "on_land_mandatory",
		});

		// Fresh lane: everything allowed (and the verdict caches).
		expect(await gate.checkMutation("edit")).toEqual({ allowed: true });
		expect(await gate.checkMutation("write")).toEqual({ allowed: true });

		// Lane a lands a commit -> b is stale -> mandatory policy fails b's mutations closed.
		writeFileSync(join(createdA.lane.worktreePath, "a.txt"), "a\n", "utf-8");
		await git(createdA.lane.worktreePath, "add", "-A");
		await git(createdA.lane.worktreePath, "commit", "-m", "a: add a.txt");
		expect((await landLane(deps, { laneKey: "a", gate: "off" })).code).toBe("ok");

		const blocked = await gate.checkMutation("edit");
		expect(blocked.allowed).toBe(false);
		if (!blocked.allowed) {
			expect(blocked.code).toBe("sync_required");
			expect(blocked.message).toContain("worktree_sync");
		}
		// Saving WIP stays possible while blocked (the prescribed step BEFORE syncing).
		expect(await gate.checkMutation("bash", "git add -A")).toEqual({ allowed: true });
		expect(await gate.checkMutation("bash", 'git commit -m "wip"')).toEqual({ allowed: true });
		// G10 refusals hold regardless of staleness.
		const push = await gate.checkMutation("bash", "git push");
		expect(push.allowed).toBe(false);
		if (!push.allowed) expect(push.code).toBe("main_mutation_refused");
		// Arbitrary bash mutation stays blocked while sync_required.
		const arbitrary = await gate.checkMutation("bash", "rm -rf build");
		expect(arbitrary.allowed).toBe(false);

		// Sync clears the block on the very next check -- no restart, no cache staleness.
		expect((await syncLane(deps, { laneKey: "b" })).code).toBe("sync_clean");
		expect(await gate.checkMutation("edit")).toEqual({ allowed: true });
		expect(await gate.checkMutation("bash", "rm -rf build")).toEqual({ allowed: true });
	}, 60_000);

	it("land_time_only keeps staleness advisory: mutations stay allowed", async () => {
		const { deps } = await initRepo();
		const createdA = await createLane(deps, { laneKey: "a" });
		expect(createdA.code).toBe("ok");
		if (createdA.code !== "ok") return;
		await createLane(deps, { laneKey: "b" });

		writeFileSync(join(createdA.lane.worktreePath, "a.txt"), "a\n", "utf-8");
		await git(createdA.lane.worktreePath, "add", "-A");
		await git(createdA.lane.worktreePath, "commit", "-m", "a: add a.txt");
		expect((await landLane(deps, { laneKey: "a", gate: "off" })).code).toBe("ok");

		const gate = new WorktreeLaneGate({ laneKey: "b", engineDeps: () => deps, policy: () => "land_time_only" });
		expect(await gate.checkMutation("edit")).toEqual({ allowed: true });
	}, 60_000);
});
