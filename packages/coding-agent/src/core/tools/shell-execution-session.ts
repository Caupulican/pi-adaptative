/** One production lifecycle boundary for every process/state resource owned by a shell session. */

import { PERSISTENT_PROCESS_DISPOSAL_WATCHDOG_MS } from "./persistent-process-coordinator.ts";
import { disposePersistentShellSession } from "./shell-session.ts";
import { disposeWindowsShellEngineSession } from "./windows-shell-engine.ts";
import { disposeWindowsShellState } from "./windows-shell-state.ts";

const inFlightTerminalPromises = new Map<string, Promise<void>>();
const inFlightDisposalWaits = new Map<string, Promise<void>>();

/** Synchronously dispose both execution tiers and their shared authoritative Windows state. */
export function disposeShellExecutionSession(sessionKey: string): void {
	if (!inFlightTerminalPromises.has(sessionKey)) {
		disposeWindowsShellState(sessionKey);
	}
	const p1 = disposeWindowsShellEngineSession(sessionKey);
	const p2 = disposePersistentShellSession(sessionKey);

	const previous = inFlightTerminalPromises.get(sessionKey);
	const combined = Promise.all([previous ?? Promise.resolve(), p1, p2])
		.then(() => undefined)
		.finally(() => {
			if (inFlightTerminalPromises.get(sessionKey) === combined) {
				inFlightTerminalPromises.delete(sessionKey);
			}
		});

	inFlightTerminalPromises.set(sessionKey, combined);
}

/**
 * Awaitable disposal that guarantees child processes in both execution tiers have reached
 * physical terminal close before resolving. Concurrent callers for the same sessionKey share
 * the identical pending wait promise.
 */
export function disposeShellExecutionSessionAndWait(
	sessionKey: string,
	timeoutMs: number = PERSISTENT_PROCESS_DISPOSAL_WATCHDOG_MS,
): Promise<void> {
	const existing = inFlightDisposalWaits.get(sessionKey);
	if (existing) return existing;

	disposeShellExecutionSession(sessionKey);
	const terminalPromise = inFlightTerminalPromises.get(sessionKey) ?? Promise.resolve();

	let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
	const watchdogPromise = new Promise<void>((_, reject) => {
		watchdogTimer = setTimeout(() => {
			reject(
				new Error(
					`Shell execution session terminal release timed out after ${timeoutMs}ms before child close event`,
				),
			);
		}, timeoutMs);
		if (typeof watchdogTimer === "object" && watchdogTimer && "unref" in watchdogTimer) {
			watchdogTimer.unref();
		}
	});

	const waitPromise = Promise.race([terminalPromise, watchdogPromise])
		.then(() => undefined)
		.finally(() => {
			if (watchdogTimer) clearTimeout(watchdogTimer);
			if (inFlightDisposalWaits.get(sessionKey) === waitPromise) {
				inFlightDisposalWaits.delete(sessionKey);
			}
		});

	inFlightDisposalWaits.set(sessionKey, waitPromise);
	return waitPromise;
}
