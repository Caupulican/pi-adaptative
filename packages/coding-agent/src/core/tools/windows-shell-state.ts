/**
 * Per-session Windows shell-engine state (D4 — the engine is the sole state mutator).
 *
 * `cwd`/`envDelta` are threaded into every `python-engine` invocation and updated from the
 * engine's control frame after each run; the PS tier consumes the same state through the
 * EXISTING `shell-session.ts` seams (`lastRequestedCwd` re-entry, `shallowEnvEquals` respawn).
 * This module owns no process/spawn logic — it is pure state carriage.
 */

export interface WindowsShellState {
	cwd: string;
	/** Host-requested cwd used to detect an intentional caller cwd change. */
	hostCwd?: string;
	envDelta: Record<string, string | null>;
}

/** The engine control-frame shape this module consumes (subset of the full §1.3 frame). */
export interface EngineFrameState {
	cwd: string;
	envDelta: Record<string, string | null>;
}

const windowsShellStates = new Map<string, WindowsShellState>();

/** Get or lazily create the per-session-key Windows shell state. */
export function getOrCreateWindowsShellState(sessionKey: string): WindowsShellState {
	let state = windowsShellStates.get(sessionKey);
	if (!state) {
		state = { cwd: "", envDelta: {} };
		windowsShellStates.set(sessionKey, state);
	}
	return state;
}

/** Drop a session's engine state (agent teardown). Safe to call for keys that never ran. */
export function disposeWindowsShellState(sessionKey: string): void {
	windowsShellStates.delete(sessionKey);
}

/**
 * Fold an engine control frame into the session state: `cwd` is set verbatim; `envDelta` entries
 * apply string => set, `null` => delete (§1.3).
 */
export function applyEngineFrame(state: WindowsShellState, frame: EngineFrameState): void {
	state.cwd = frame.cwd;
	for (const [key, value] of Object.entries(frame.envDelta)) {
		state.envDelta[key] = value;
	}
}

/**
 * The cwd a NEXT call (engine or PS tier) must use: the state-adjusted cwd once the engine has run
 * at least one `cd`, otherwise the host-requested cwd. Both tiers call this with the SAME session
 * state so a `cd` in the engine is observed by the very next PS-tier call.
 */
export function resolveEffectiveCwd(state: WindowsShellState, requestedCwd: string): string {
	if (state.hostCwd !== requestedCwd) {
		state.hostCwd = requestedCwd;
		state.cwd = requestedCwd;
	}
	return state.cwd;
}

/**
 * The env a NEXT call (engine or PS tier) must use: the base env plus every `export`/`unset` the
 * engine has applied so far.
 */
export function mergeEffectiveEnv(state: WindowsShellState, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const merged: NodeJS.ProcessEnv = { ...baseEnv };
	for (const [key, value] of Object.entries(state.envDelta)) {
		if (value === null) delete merged[key];
		else merged[key] = value;
	}
	return merged;
}
