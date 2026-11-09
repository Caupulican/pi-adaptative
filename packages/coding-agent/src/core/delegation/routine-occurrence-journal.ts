/**
 * The routine store state shared with the store by reference (definitions, occurrences, replay tombstones and intake records),
 * the occurrence journal's capacity and per-routine share, and the construction of pending and claimed occurrences. The store
 * keeps the lock and the save; these functions only change the maps they are given.
 */
import { randomUUID } from "node:crypto";
import type { WorkerReceiptOrigin } from "../orchestration/worker-receipt-origin.ts";
import {
	MAX_ROUTINE_OCCURRENCES,
	MAX_ROUTINE_REPLAY_TOMBSTONES,
	type PersistentRoutineDefinition,
	type RoutineDefinitionView,
	type RoutineIntakeConsumption,
	type RoutineIntakeSession,
	type RoutineOccurrence,
	routineJournalRemovable,
	routineJournalShare,
	routineOccurrenceReplayKeys,
} from "../routines/routine-contract.ts";
import { admittedProgressFields } from "./routine-run-state.ts";

/** The routine state the store owns, shared with these modules by reference (reload clears the maps, never replaces them). */
export interface RoutineStoreState {
	readonly routines: Map<string, RoutineDefinitionView>;
	readonly occurrences: Map<string, RoutineOccurrence>;
	readonly replayTombstones: Set<string>;
	readonly intakeOrigins: Map<string, RoutineIntakeConsumption>;
	readonly intakeSessions: Map<string, RoutineIntakeSession>;
}

export function createClaimedOccurrence(
	state: RoutineStoreState,
	definition: RoutineDefinitionView,
	occurrenceId: string,
	trigger: RoutineOccurrence["trigger"],
	owner: string,
	leaseMs: number,
	nowMs: number,
	parentOrigin: WorkerReceiptOrigin,
): RoutineOccurrence {
	return {
		...createPendingOccurrence(state, definition, occurrenceId, trigger, nowMs, parentOrigin),
		phase: "claimed",
		claim: { token: randomUUID(), owner, leaseUntil: nowMs + leaseMs },
	};
}

/** An accepted occurrence no host has claimed yet: whichever host may run it claims it through recovery. */
export function createPendingOccurrence(
	state: RoutineStoreState,
	definition: RoutineDefinitionView,
	occurrenceId: string,
	trigger: RoutineOccurrence["trigger"],
	nowMs: number,
	parentOrigin: WorkerReceiptOrigin,
): RoutineOccurrence {
	if (!routineJournalHasRoom(state, nowMs))
		throw new Error("Routine occurrence journal is full of active, uncertain or undelivered entries.");
	const definitionSnapshot: PersistentRoutineDefinition = {
		routineId: definition.routineId,
		incarnationId: definition.incarnationId,
		revision: definition.revision,
		target: definition.target,
		prompt: definition.prompt,
		schedule: definition.schedule,
		enabled: definition.enabled,
		...(definition.executionSnapshot ? { executionSnapshot: definition.executionSnapshot } : {}),
		...(definition.origin ? { origin: definition.origin } : {}),
		createdAt: definition.createdAt,
		updatedAt: definition.updatedAt,
	};
	return {
		occurrenceId,
		routineId: definition.routineId,
		routineRevision: definition.revision,
		definition: definitionSnapshot,
		parentOrigin,
		target: definition.target,
		trigger,
		phase: "pending",
		createdAt: nowMs,
		updatedAt: nowMs,
		// A queued run's brief is refreshed when it is claimed to run (`reclaimed`), before its dispatch identity is fixed.
		...admittedProgressFields(definition, { definition: definitionSnapshot, target: definition.target, trigger }),
	};
}

/** Whether a routine may admit one more run: it holds fewer than its journal share of unsettled entries. */
export function routineHasJournalShare(state: RoutineStoreState, routineId: string, nowMs: number): boolean {
	return routineJournalShare(state.occurrences.values(), routineId, nowMs).fits;
}

/**
 * Prunes settled history when the journal is at capacity, oldest first; whether one more occurrence then fits. A run
 * away the away spend bound still charges is kept until its charge ends.
 */
export function routineJournalHasRoom(state: RoutineStoreState, nowMs: number): boolean {
	if (state.occurrences.size < MAX_ROUTINE_OCCURRENCES) return true;
	const removable = Array.from(state.occurrences.values())
		.filter((item) => routineJournalRemovable(item, nowMs))
		.sort((a, b) => a.updatedAt - b.updatedAt);
	while (state.occurrences.size >= MAX_ROUTINE_OCCURRENCES && removable.length > 0) {
		const item = removable.shift();
		if (!item) continue;
		// Slot occurrences cannot recur behind their cursor, nor an end notice after its routine is removed; manual
		// commands and host events can be re-presented. A GitHub run tombstones every occurrence it carried, or none.
		if (item.trigger.kind === "manual" || item.trigger.kind === "event") {
			const keys = routineOccurrenceReplayKeys(item).filter((key) => !state.replayTombstones.has(key));
			if (state.replayTombstones.size + keys.length > MAX_ROUTINE_REPLAY_TOMBSTONES) continue;
			for (const key of keys) state.replayTombstones.add(key);
		}
		state.occurrences.delete(item.occurrenceId);
	}
	return state.occurrences.size < MAX_ROUTINE_OCCURRENCES;
}
