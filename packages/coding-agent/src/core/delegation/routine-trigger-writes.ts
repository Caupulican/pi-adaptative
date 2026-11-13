/**
 * Writes that record a routine trigger outside the clock and host-event paths: one observation of a watch condition, a manual claim
 * of a routine, and the retirement of an ended routine with its terminal notice. The functions change the routine state they are
 * given; `persist` is the store's save.
 */
import { isDeepStrictEqual } from "node:util";
import type { WorkerReceiptOrigin } from "../orchestration/worker-receipt-origin.ts";
import {
	decideWatchObservation,
	MAX_ROUTINE_COMMAND_ID_CHARS,
	ROUTINE_JOURNAL_SHARE,
	type RoutineCursor,
	type RoutineOccurrence,
	type RoutineRetireInput,
	type RoutineWatchObservationInput,
	type RoutineWatchOutcome,
	routineEnded,
	routineOccurrenceId,
	routineOccurrencesSettled,
} from "../routines/routine-contract.ts";
import {
	createClaimedOccurrence,
	createPendingOccurrence,
	type RoutineStoreState,
	recordRetiredRoutine,
	routineHasJournalShare,
	routineJournalHasRoom,
} from "./routine-occurrence-journal.ts";
import { withResult } from "./routine-result-writes.ts";
import { withRoutineRunState } from "./routine-run-state.ts";

export function retireEndedRoutines(
	state: RoutineStoreState,
	input: RoutineRetireInput,
	persist: () => void,
): { readonly retired: readonly string[]; readonly journalFull: boolean } {
	const retired: string[] = [];
	let journalFull = false;
	for (const routineId of new Set(input.routineIds)) {
		const routine = state.routines.get(routineId);
		if (!routine || input.nowMs < Date.parse(routine.updatedAt)) continue;
		if (routine.target.kind === "session" && routine.target.parentSessionId !== input.parentSessionId) continue;
		const ended = routineEnded(routine, input.nowMs);
		if (!ended || !routineOccurrencesSettled(state.occurrences.values(), routine)) continue;
		const met = ended === "condition" ? routine.conditionMet : undefined;
		if (met && input.nowMs < met.at) continue;
		const trigger: RoutineOccurrence["trigger"] | undefined = met
			? { kind: "condition", occurrenceId: met.occurrenceId, metAt: met.at }
			: ended === "expired" && routine.schedule.kind !== "once" && routine.schedule.expiresAt !== undefined
				? { kind: "expiry", expiresAt: routine.schedule.expiresAt }
				: undefined;
		if (trigger) {
			const parentOrigin =
				routine.target.kind === "session"
					? routine.executionSnapshot?.savedIntent.receiptOrigin
					: input.receiptOrigin;
			if (!parentOrigin || parentOrigin.sessionId !== input.parentSessionId) continue;
			if (!routineJournalHasRoom(state, input.nowMs)) {
				journalFull = true;
				continue;
			}
			const notice = createClaimedOccurrence(
				state,
				routine,
				routineOccurrenceId(routine, trigger),
				trigger,
				input.owner,
				input.leaseMs,
				input.nowMs,
				parentOrigin,
			);
			state.occurrences.set(
				notice.occurrenceId,
				withResult(
					state,
					{ ...notice, phase: "terminal" },
					"cancelled",
					trigger.kind === "condition"
						? "A run reported the end the owner stated as met; the routine was removed."
						: "The routine reached its end time and was removed.",
					parentOrigin.sessionId,
				),
			);
		}
		recordRetiredRoutine(state, routine, ended, input.nowMs);
		state.routines.delete(routineId);
		retired.push(routineId);
	}
	if (retired.length > 0) persist();
	return { retired, journalFull };
}

export function observeWatch(
	state: RoutineStoreState,
	input: RoutineWatchObservationInput,
	persist: () => void,
): RoutineWatchOutcome {
	const routine = state.routines.get(input.routineId);
	if (
		!routine?.enabled ||
		routine.incarnationId !== input.incarnationId ||
		routine.schedule.kind !== "event" ||
		routine.schedule.source !== "watch" ||
		routine.cursor.kind !== "watch" ||
		routine.target.kind !== "session" ||
		routine.target.parentSessionId !== input.parentSessionId ||
		routineEnded(routine, input.nowMs) ||
		input.nowMs < Date.parse(routine.updatedAt)
	)
		return "stale";
	const decision = decideWatchObservation(routine.cursor, input.observation);
	if (!decision.fire) {
		if (isDeepStrictEqual(decision.cursor, routine.cursor)) return "unchanged";
		state.routines.set(routine.routineId, { ...routine, cursor: decision.cursor });
		persist();
		return "recorded";
	}
	for (const occurrence of state.occurrences.values())
		if (
			occurrence.routineId === routine.routineId &&
			(occurrence.phase === "pending" || occurrence.phase === "claimed")
		)
			return "held";
	const parentOrigin = routine.executionSnapshot?.savedIntent.receiptOrigin;
	if (!parentOrigin || parentOrigin.sessionId !== input.parentSessionId) return "stale";
	if (!routineJournalHasRoom(state, input.nowMs) || !routineHasJournalShare(state, routine.routineId, input.nowMs))
		return "held";
	const sequence = routine.cursor.fires + 1;
	const trigger = { kind: "watch" as const, triggeredAt: input.nowMs, sequence, event: input.event };
	const occurrenceId = routineOccurrenceId(routine, trigger);
	// A replay of a firing already journaled advances the cursor past it without a second occurrence.
	const occurrence =
		state.occurrences.get(occurrenceId) ??
		createPendingOccurrence(state, routine, occurrenceId, trigger, input.nowMs, parentOrigin);
	state.occurrences.set(occurrenceId, occurrence);
	const cursor: RoutineCursor = {
		...decision.cursor,
		fires: sequence,
		// A one-run routine is spent in the write that records its run, so no second edge can start it.
		...(routine.schedule.stopAfterFirstRun ? { spent: true as const } : {}),
	};
	state.routines.set(routine.routineId, { ...withRoutineRunState(routine, occurrence), cursor });
	persist();
	return "fired";
}

export function claimManualRoutineOccurrence(
	state: RoutineStoreState,
	input: {
		routineId: string;
		expectedRevision?: number;
		parentSessionId?: string;
		receiptOrigin?: WorkerReceiptOrigin;
		commandId: string;
		nowMs: number;
		owner: string;
		leaseMs: number;
	},
	persist: () => void,
): RoutineOccurrence {
	if (
		!Number.isSafeInteger(input.nowMs) ||
		input.nowMs < 0 ||
		input.nowMs > 8_640_000_000_000_000 ||
		!Number.isSafeInteger(input.leaseMs) ||
		input.leaseMs <= 0 ||
		!Number.isSafeInteger(input.nowMs + input.leaseMs) ||
		input.nowMs + input.leaseMs > 8_640_000_000_000_000 ||
		!input.owner ||
		input.owner.trim() !== input.owner ||
		input.owner.length > 256 ||
		input.owner.includes("\0")
	)
		throw new Error("Routine manual claim requires a valid owner, clock and lease.");
	const routine = state.routines.get(input.routineId);
	if (!routine) throw new Error("Routine does not exist.");
	if (input.expectedRevision !== undefined && input.expectedRevision !== routine.revision)
		throw new Error("Routine revision changed; read current state before retrying.");
	if (routine.target.kind === "session" && routine.target.parentSessionId !== input.parentSessionId)
		throw new Error("Routine belongs to another parent session.");
	if (input.nowMs < Date.parse(routine.updatedAt))
		throw new Error(
			`This host's clock reads earlier than the routine's last edit (${routine.updatedAt}); run it once the clock has passed that time.`,
		);
	if (
		!input.commandId ||
		input.commandId.length > MAX_ROUTINE_COMMAND_ID_CHARS ||
		input.commandId.trim() !== input.commandId ||
		input.commandId.includes("\0")
	)
		throw new Error("Routine manual command identity is invalid.");
	const trigger = { kind: "manual" as const, commandId: input.commandId, requestedAt: input.nowMs };
	const id = routineOccurrenceId(routine, trigger);
	const existing = state.occurrences.get(id);
	if (existing) return structuredClone(existing);
	if (state.replayTombstones.has(id))
		throw new Error("This manual request was already consumed and has expired from the bounded replay journal.");
	const origin =
		routine.target.kind === "session" ? routine.executionSnapshot?.savedIntent.receiptOrigin : input.receiptOrigin;
	if (!origin || (input.parentSessionId && origin.sessionId !== input.parentSessionId))
		throw new Error("Routine parent receipt origin is unavailable.");
	if (!routineHasJournalShare(state, routine.routineId, input.nowMs))
		throw new Error(
			`Routine ${routine.routineId} already holds ${ROUTINE_JOURNAL_SHARE} unfinished, uncertain or undelivered runs; run it again once its results are delivered.`,
		);
	const occurrence = createClaimedOccurrence(
		state,
		routine,
		id,
		trigger,
		input.owner,
		input.leaseMs,
		input.nowMs,
		origin,
	);
	state.occurrences.set(id, occurrence);
	state.routines.set(routine.routineId, withRoutineRunState(routine, occurrence));
	persist();
	return structuredClone(occurrence);
}
