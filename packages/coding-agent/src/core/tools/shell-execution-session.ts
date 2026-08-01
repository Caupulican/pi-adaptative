/** One production lifecycle boundary for every process/state resource owned by a shell session. */

import { disposePersistentShellSession } from "./shell-session.ts";
import { disposeWindowsShellEngineSession } from "./windows-shell-engine.ts";
import { disposeWindowsShellState } from "./windows-shell-state.ts";

/** Idempotently dispose both execution tiers and their shared authoritative Windows state. */
export function disposeShellExecutionSession(sessionKey: string): void {
	disposeWindowsShellEngineSession(sessionKey);
	disposePersistentShellSession(sessionKey);
	disposeWindowsShellState(sessionKey);
}
