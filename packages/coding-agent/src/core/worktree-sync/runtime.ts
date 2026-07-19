/**
 * Worktree-sync runtime composition: the pieces main.ts / RuntimeBuilder wire together.
 *
 * The lane binding is an ENVIRONMENT contract: a session launched with `PI_WORKTREE_LANE=<key>`
 * (set by the `--worktree-lane` CLI flag, or directly by any launcher -- tmux panes inherit it
 * from the launch command line) is lane-bound: its file-mutation tools run behind the lane gate
 * (G8/G10) and its epoch watcher injects staleness notices. The env form is deliberate -- it
 * crosses EVERY process boundary (tmux, exec, nested shells) without per-launcher plumbing.
 */

import { worktreesDir } from "../agent-paths.ts";
import type { SettingsManager } from "../settings-manager.ts";
import {
	createDefaultWorktreeSyncExec,
	reconcile,
	resolveRepoContext,
	type WorktreeSyncEngineDeps,
} from "./git-engine.ts";
import { type EpochWatcherHandle, startEpochWatcher } from "./watcher.ts";

export const PI_WORKTREE_LANE_ENV = "PI_WORKTREE_LANE";

const LANE_KEY_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The lane this process is bound to, from the cross-process env contract. Invalid values are
 * ignored (never a crash on a malformed env). */
export function getBoundWorktreeLaneKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const value = env[PI_WORKTREE_LANE_ENV]?.trim();
	return value && LANE_KEY_RE.test(value) ? value : undefined;
}

export interface WorktreeSyncEngineConfig {
	cwd: string;
	agentDir: string;
	settingsManager: SettingsManager;
	sessionId?: string;
	signal?: AbortSignal;
}

/** Build production engine deps from session facts + resolved settings. */
export function buildWorktreeSyncEngineDeps(config: WorktreeSyncEngineConfig): WorktreeSyncEngineDeps {
	const settings = config.settingsManager.getWorktreeSyncSettings();
	return {
		exec: createDefaultWorktreeSyncExec(),
		cwd: config.cwd,
		worktreesBaseDir: settings.worktreesRoot ?? worktreesDir(config.agentDir),
		options: {
			maxLanes: settings.maxLanes,
			...(settings.mainBranch !== undefined ? { mainBranchOverride: settings.mainBranch } : {}),
		},
		...(config.sessionId !== undefined ? { sessionId: config.sessionId } : {}),
		...(config.signal !== undefined ? { signal: config.signal } : {}),
	};
}

export interface WorktreeSyncRuntimeConfig extends WorktreeSyncEngineConfig {
	/** Structural notice injection into the running session (host `sendCustomMessage` seam):
	 * "steer" mid-turn, trigger a turn when idle -- the host closure decides the mechanics. */
	notify: (text: string) => void;
	/** Diagnostics sink for startup-reconcile findings (never throws into the session). */
	onDiagnostic?: (message: string) => void;
}

export interface WorktreeSyncRuntimeHandle {
	stop(): void;
}

const NOOP_HANDLE: WorktreeSyncRuntimeHandle = { stop: () => {} };

/**
 * Start the per-session worktree-sync runtime (main.ts composition root):
 * 1. one startup reconcile pass (registry vs git reality -- orphans marked, lost lanes
 *    re-registered, dead owners cleared, provably-stale lock released), and
 * 2. for a LANE-BOUND session, the epoch watcher: a land anywhere on this machine injects a
 *    deterministic staleness notice into this session promptly (the pull-guaranteed channel is
 *    still the lane gate + turn-start checks -- enforcement never rides on the watcher).
 *
 * No-op when worktree-sync is disabled. Never throws: this runs at session start and a broken
 * repo state must surface as a diagnostic, not a startup crash.
 */
export async function startWorktreeSyncRuntime(config: WorktreeSyncRuntimeConfig): Promise<WorktreeSyncRuntimeHandle> {
	const settings = config.settingsManager.getWorktreeSyncSettings();
	if (!settings.enabled) return NOOP_HANDLE;
	const deps = buildWorktreeSyncEngineDeps(config);

	try {
		const reconciled = await reconcile(deps);
		if (reconciled.code === "reconciled") {
			const findings: string[] = [];
			if (reconciled.orphanedLaneKeys.length > 0)
				findings.push(`orphaned: ${reconciled.orphanedLaneKeys.join(", ")}`);
			if (reconciled.reRegisteredLaneKeys.length > 0) {
				findings.push(`re-registered: ${reconciled.reRegisteredLaneKeys.join(", ")}`);
			}
			if (reconciled.staleLockReleased) findings.push("released a stale integration lock");
			if (findings.length > 0) config.onDiagnostic?.(`worktree-sync reconcile: ${findings.join("; ")}`);
		} else if (reconciled.code !== "not_a_git_repo" && reconciled.code !== "default_branch_unresolved") {
			// Now that the runtime starts in every session, these two codes are benign absence, not a
			// problem to surface: a non-repo cwd, or a repo whose default branch isn't named main/master.
			// Every other refusal still gets a diagnostic.
			config.onDiagnostic?.(`worktree-sync reconcile skipped: [${reconciled.code}] ${reconciled.message}`);
		}
	} catch (error) {
		config.onDiagnostic?.(
			`worktree-sync reconcile failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const laneKey = getBoundWorktreeLaneKey();
	if (!laneKey) return NOOP_HANDLE;

	let watcher: EpochWatcherHandle | undefined;
	try {
		const ctx = await resolveRepoContext(deps);
		if (!("code" in ctx)) {
			watcher = startEpochWatcher({
				epochFile: ctx.paths.epochFile,
				laneKey,
				notify: config.notify,
			});
		}
	} catch (error) {
		config.onDiagnostic?.(`worktree-sync watcher failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	return { stop: () => watcher?.stop() };
}
