/**
 * Whom a watch wakes when it fires: the address the armer had when it saved the watch, fixed at creation. A watch armed in
 * a session wakes that session; a watch a worker runtime armed for its own wait wakes that runtime. The address is
 * host-authored from the caller that saved the watch (never a tool argument), and a stored record without one wakes the
 * session it targets, so watches saved before the address existed keep their meaning.
 */
import { hasOnlyKeys, isPlainRecord } from "../util/value-guards.ts";
import type { PersistentRoutineTarget } from "./routine-contract.ts";
import { boundedRoutineText } from "./routine-field-guards.ts";

const MAX_WAKE_ID_CHARS = 200;

export type RoutineWakeAddress =
	| { readonly kind: "session"; readonly sessionId: string }
	| { readonly kind: "worker"; readonly parentSessionId: string; readonly runtimeId: string };

/** The stored address; a malformed one makes the whole routine unreadable. */
export function parseRoutineWakeAddress(value: unknown): RoutineWakeAddress {
	if (isPlainRecord(value) && value.kind === "session" && hasOnlyKeys(value, ["kind", "sessionId"]))
		return { kind: "session", sessionId: boundedRoutineText(value.sessionId, MAX_WAKE_ID_CHARS, "wake session id") };
	if (isPlainRecord(value) && value.kind === "worker" && hasOnlyKeys(value, ["kind", "parentSessionId", "runtimeId"]))
		return {
			kind: "worker",
			parentSessionId: boundedRoutineText(value.parentSessionId, MAX_WAKE_ID_CHARS, "wake parent session id"),
			runtimeId: boundedRoutineText(value.runtimeId, MAX_WAKE_ID_CHARS, "wake runtime id"),
		};
	throw new TypeError("Routine wake address is invalid.");
}

/** The session an address belongs to: the one whose routine runtime delivers the wake. */
export function wakeAddressSession(address: RoutineWakeAddress): string {
	return address.kind === "session" ? address.sessionId : address.parentSessionId;
}

/** Whom a watch routine wakes: its stored address, else the session its target names. Undefined for a bot or team target. */
export function routineWakeAddress(routine: {
	readonly target: PersistentRoutineTarget;
	readonly wake?: RoutineWakeAddress;
}): RoutineWakeAddress | undefined {
	if (routine.wake) return routine.wake;
	return routine.target.kind === "session"
		? { kind: "session", sessionId: routine.target.parentSessionId }
		: undefined;
}
