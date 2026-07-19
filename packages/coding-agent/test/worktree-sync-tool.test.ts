import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execCommand } from "../src/core/exec.ts";
import type { ResolvedWorktreeSyncSettings } from "../src/core/settings-manager.ts";
import { createWorktreeSyncToolDefinition, type WorktreeSyncToolDeps } from "../src/core/tools/worktree-sync.ts";
import { createDefaultWorktreeSyncExec, type WorktreeSyncEngineDeps } from "../src/core/worktree-sync/git-engine.ts";

/**
 * Drives the `worktree_sync` ToolDefinition itself (not the engine directly) against a real temp
 * git repo, so the tool's laneKey-defaulting, response shaping, and tagged-code passthrough are
 * exercised the way an agent's tool call actually would be.
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
	const root = mkdtempSync(join(tmpdir(), "pi-wt-sync-tool-"));
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
		sessionId: "tool-test-session",
	};
	return { repo, deps };
}

async function laneCommit(worktreePath: string, file: string, content: string, message: string): Promise<string> {
	writeFileSync(join(worktreePath, file), content, "utf-8");
	await git(worktreePath, "add", "-A");
	await git(worktreePath, "commit", "-m", message);
	return git(worktreePath, "rev-parse", "HEAD");
}

const SETTINGS: ResolvedWorktreeSyncSettings = {
	enabled: true,
	syncPolicy: "on_land_mandatory",
	gate: "off",
	gateTimeoutMs: 900_000,
	maxLanes: 8,
	workerLand: "deny",
};

function makeDeps(
	engineDeps: WorktreeSyncEngineDeps,
	boundLaneKey: () => string | undefined,
	options: { isWorker?: () => boolean; settings?: ResolvedWorktreeSyncSettings } = {},
): WorktreeSyncToolDeps {
	return {
		engineDeps: () => engineDeps,
		settings: () => options.settings ?? SETTINGS,
		boundLaneKey,
		isWorker: options.isWorker ?? (() => false),
	};
}

describe("worktree_sync tool", () => {
	it("drives create_lane, status, land refusal/success, sync default-laneKey fallback, and release_lane", async () => {
		const { deps } = await initRepo();
		const laneKey = "a";
		const toolDeps = makeDeps(deps, () => laneKey);
		const def = createWorktreeSyncToolDefinition(toolDeps);

		const created = await def.execute(
			"call-1",
			{ action: "create_lane", laneKey },
			undefined,
			undefined,
			undefined as never,
		);
		expect(created.details).toMatchObject({ code: "ok" });
		const createdLane =
			created.details && typeof created.details === "object" && "lane" in created.details
				? (created.details as { lane: { worktreePath: string } }).lane
				: undefined;
		if (!createdLane) throw new Error("expected create_lane to return a lane");

		const status = await def.execute("call-2", { action: "status" }, undefined, undefined, undefined as never);
		expect(status.details).toMatchObject({ code: "ok" });
		expect(status.content[0]?.type).toBe("text");
		expect((status.content[0] as { type: "text"; text: string }).text).toContain(laneKey);

		// Freshly created lane has no commits beyond main -- land refuses nothing_to_land.
		const noopLand = await def.execute(
			"call-3",
			{ action: "land", laneKey },
			undefined,
			undefined,
			undefined as never,
		);
		expect(noopLand.details).toMatchObject({ code: "nothing_to_land" });

		// A real commit on the lane, then land for real (gate "off" per settings).
		await laneCommit(createdLane.worktreePath, "README.md", "from-a\n", "a: change readme");
		const landed = await def.execute("call-4", { action: "land", laneKey }, undefined, undefined, undefined as never);
		expect(landed.details).toMatchObject({ code: "ok", epoch: 1 });
		expect((landed.details as { mainSha?: string }).mainSha).toBeTruthy();

		// sync with NO laneKey in the input falls back to deps.boundLaneKey(). The lane just landed
		// its own tip, so it is trivially fresh -- sync_clean/alreadyFresh.
		const synced = await def.execute("call-5", { action: "sync" }, undefined, undefined, undefined as never);
		expect(synced.details).toMatchObject({ code: "sync_clean", alreadyFresh: true });

		const released = await def.execute(
			"call-6",
			{ action: "release_lane", laneKey },
			undefined,
			undefined,
			undefined as never,
		);
		expect(released.details).toMatchObject({ code: "released" });
	}, 60_000);
});

describe("worktree_sync tool -- worker scoping (D3)", () => {
	it("refuses create_lane/land/release_lane/reconcile as role_forbidden, but allows status/sync/continue/abort_sync", async () => {
		const { deps } = await initRepo();
		const laneKey = "a";
		const toolDeps = makeDeps(deps, () => laneKey, { isWorker: () => true });
		const def = createWorktreeSyncToolDefinition(toolDeps);

		for (const action of ["create_lane", "land", "release_lane", "reconcile"] as const) {
			const result = await def.execute(
				`refuse-${action}`,
				{ action, laneKey },
				undefined,
				undefined,
				undefined as never,
			);
			expect(result.details).toMatchObject({ code: "role_forbidden" });
		}

		// These stay allowed for a worker without touching role_forbidden -- their own preconditions
		// (e.g. "no lane" for a not-yet-created lane) still apply, just never role_forbidden.
		for (const action of ["status", "sync", "continue", "abort_sync"] as const) {
			const result = await def.execute(
				`allow-${action}`,
				{ action, laneKey },
				undefined,
				undefined,
				undefined as never,
			);
			expect((result.details as { code?: string } | undefined)?.code).not.toBe("role_forbidden");
		}
	}, 60_000);

	it("refuses an explicit laneKey that differs from the worker's bound lane", async () => {
		const { deps } = await initRepo();
		const toolDeps = makeDeps(deps, () => "bound-lane", { isWorker: () => true });
		const def = createWorktreeSyncToolDefinition(toolDeps);

		const result = await def.execute(
			"cross-lane",
			{ action: "status", laneKey: "other-lane" },
			undefined,
			undefined,
			undefined as never,
		);
		expect(result.details).toMatchObject({ code: "role_forbidden" });
	}, 60_000);

	it("refuses land by default (workerLand: deny) but reaches the engine when workerLand: allow", async () => {
		const { deps } = await initRepo();
		const laneKey = "a";
		// Lanes are created through a MAIN-role tool instance sharing the same repo/engine deps --
		// workers cannot create_lane either (covered by the first test above).
		const mainDef = createWorktreeSyncToolDefinition(makeDeps(deps, () => laneKey));
		const created = await mainDef.execute(
			"create",
			{ action: "create_lane", laneKey },
			undefined,
			undefined,
			undefined as never,
		);
		expect(created.details).toMatchObject({ code: "ok" });

		const denyDef = createWorktreeSyncToolDefinition(makeDeps(deps, () => laneKey, { isWorker: () => true }));
		const denied = await denyDef.execute(
			"land-deny",
			{ action: "land", laneKey },
			undefined,
			undefined,
			undefined as never,
		);
		expect(denied.details).toMatchObject({ code: "role_forbidden" });

		const allowSettings: ResolvedWorktreeSyncSettings = { ...SETTINGS, workerLand: "allow" };
		const allowDef = createWorktreeSyncToolDefinition(
			makeDeps(deps, () => laneKey, { isWorker: () => true, settings: allowSettings }),
		);
		// The action now reaches the ENGINE (never role_forbidden): the freshly-created lane has no
		// commits beyond main yet, so the engine itself refuses nothing_to_land -- proof the worker
		// scoping layer stepped aside rather than short-circuiting.
		const allowed = await allowDef.execute(
			"land-allow",
			{ action: "land", laneKey },
			undefined,
			undefined,
			undefined as never,
		);
		expect(allowed.details).toMatchObject({ code: "nothing_to_land" });
	}, 60_000);
});
