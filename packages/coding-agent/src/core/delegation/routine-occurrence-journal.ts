/**
 * The routine store state shared with the store by reference (definitions, occurrences, replay tombstones, intake records and retired routines' records),
 * the occurrence journal's capacity and per-routine share, and the construction of pending and claimed occurrences. The store
 * keeps the lock and the save; these functions only change the maps they are given.
 */
import { randomUUID } from "node:crypto";
import type { WorkerReceiptOrigin } from "../orchestration/worker-receipt-origin.ts";
import {
	MAX_ROUTINE_INTAKE_ORIGINS,
	MAX_ROUTINE_INTAKE_SESSIONS,
	MAX_ROUTINE_OCCURRENCES,
	MAX_ROUTINE_REPLAY_TOMBSTONES,
	type PersistentRoutineDefinition,
	parseRoutineDefinitionView,
	parseRoutineOccurrence,
	type RoutineDefinitionView,
	type RoutineIntakeConsumption,
	type RoutineIntakeSession,
	type RoutineOccurrence,
	routineJournalRemovable,
	routineJournalShare,
	routineOccurrenceReplayKeys,
} from "../routines/routine-contract.ts";
import {
	MAX_RETIRED_ROUTINES,
	type RetiredRoutineRecord,
	type RoutineRetiredReason,
	retiredRoutineRecord,
} from "../routines/routine-retired.ts";
import { admittedProgressFields } from "./routine-run-state.ts";

/** The routine state the store owns, shared with these modules by reference (reload clears the maps, never replaces them). */
export interface RoutineStoreState {
	readonly routines: Map<string, RoutineDefinitionView>;
	readonly occurrences: Map<string, RoutineOccurrence>;
	readonly replayTombstones: Set<string>;
	readonly intakeOrigins: Map<string, RoutineIntakeConsumption>;
	readonly intakeSessions: Map<string, RoutineIntakeSession>;
	/** Retired routines' records by incarnation, oldest first (`routine-retired.ts`). */
	readonly retired: Map<string, RetiredRoutineRecord>;
}

/** A copy of every routine collection, taken before a reload so a malformed file restores what was loaded. */
export function snapshotRoutineState(state: RoutineStoreState): RoutineStoreState {
	return {
		routines: new Map(state.routines),
		occurrences: new Map(state.occurrences),
		replayTombstones: new Set(state.replayTombstones),
		intakeOrigins: new Map(state.intakeOrigins),
		intakeSessions: new Map(state.intakeSessions),
		retired: new Map(state.retired),
	};
}

export function clearRoutineState(state: RoutineStoreState): void {
	state.routines.clear();
	state.occurrences.clear();
	state.replayTombstones.clear();
	state.intakeOrigins.clear();
	state.intakeSessions.clear();
	state.retired.clear();
}

/** Puts a snapshot back into the shared collections, which keep their identity. */
export function restoreRoutineState(state: RoutineStoreState, snapshot: RoutineStoreState): void {
	clearRoutineState(state);
	for (const [id, value] of snapshot.routines) state.routines.set(id, value);
	for (const [id, value] of snapshot.occurrences) state.occurrences.set(id, value);
	for (const value of snapshot.replayTombstones) state.replayTombstones.add(value);
	for (const [key, value] of snapshot.intakeOrigins) state.intakeOrigins.set(key, value);
	for (const [key, value] of snapshot.intakeSessions) state.intakeSessions.set(key, value);
	for (const [id, value] of snapshot.retired) state.retired.set(id, value);
}

/** Throws when the shared collections hold more than their bounds or a record the next load would refuse. */
export function assertRoutineStatePersistable(state: RoutineStoreState): void {
	if (state.routines.size > MAX_ROUTINE_OCCURRENCES)
		throw new Error("Routine definition registry exceeds its bounded capacity.");
	if (
		state.occurrences.size > MAX_ROUTINE_OCCURRENCES ||
		state.replayTombstones.size > MAX_ROUTINE_REPLAY_TOMBSTONES ||
		state.intakeOrigins.size > MAX_ROUTINE_INTAKE_ORIGINS ||
		state.intakeSessions.size > MAX_ROUTINE_INTAKE_SESSIONS ||
		state.retired.size > MAX_RETIRED_ROUTINES
	)
		throw new Error("Routine occurrence custody exceeds its bounded capacity.");
	for (const routine of state.routines.values()) {
		if (!parseRoutineDefinitionView(routine))
			throw new Error("Refusing to persist an invalid routine definition or cursor.");
	}
	for (const occurrence of state.occurrences.values()) {
		if (!parseRoutineOccurrence(occurrence)) throw new Error("Refusing to persist an invalid routine occurrence.");
	}
}

/**
 * Keeps the record of a session's routine the store removes; it becomes the newest, and the oldest leave once the bound is
 * passed. A routine that targets a bot or team has no session to read it and leaves none.
 */
export function recordRetiredRoutine(
	state: RoutineStoreState,
	routine: RoutineDefinitionView,
	reason: RoutineRetiredReason,
	nowMs: number,
): void {
	if (routine.target.kind !== "session") return;
	const record = retiredRoutineRecord(routine, routine.target.parentSessionId, reason, nowMs);
	state.retired.delete(record.incarnationId);
	state.retired.set(record.incarnationId, record);
	for (const oldest of state.retired.keys()) {
		if (state.retired.size <= MAX_RETIRED_ROUTINES) break;
		state.retired.delete(oldest);
	}
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
		...(definition.receiptOrigin ? { receiptOrigin: definition.receiptOrigin } : {}),
		...(definition.origin ? { origin: definition.origin } : {}),
		...(definition.armedBy ? { armedBy: definition.armedBy } : {}),
		...(definition.wake ? { wake: definition.wake } : {}),
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
