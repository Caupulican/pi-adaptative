/**
 * Admission of routine runs when a host claims them: the due clock slots of a routine, the host events it decides, the notices of
 * slots that were not run, and the away refusals a host records for routines it cannot run. The functions change the routine state
 * they are given; `persist` is the store's save, called where the write is made.
 */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isCiAttemptEvent } from "../events/host-event-contract.ts";
import { HOST_EVENT_LISTENER_LIMITS } from "../events/host-event-kinds.ts";
import type { WorkerReceiptOrigin } from "../orchestration/worker-receipt-origin.ts";
import {
	countCalendarSlots,
	latestCalendarSlotAtOrBefore,
	MAX_CALENDAR_MISSED_COUNT,
} from "../routines/calendar-schedule.ts";
import {
	type AwayEventDecisionInput,
	type AwayEventDecisionResult,
	decideRoutineEvents,
	MAX_ROUTINE_EVENT_MISSED_COUNT,
	MAX_ROUTINE_OCCURRENCES,
	MAX_ROUTINE_SUMMARY_CHARS,
	nextRoutineAt,
	ROUTINE_AWAY_HELD_REASON,
	ROUTINE_AWAY_SPEND_REFUSAL,
	ROUTINE_NO_NEXT_RUN_AT,
	type RoutineClaimResult,
	type RoutineCursor,
	type RoutineDefinitionView,
	type RoutineHostEventFact,
	type RoutineHostEventFeed,
	type RoutineOccurrence,
	type RoutineOccurrenceClaimInput,
	rebasedRoutineCursor,
	routineAwayHeld,
	routineAwaySpendRoom,
	routineCursorAfter,
	routineEnded,
	routineEventKey,
	routineOccurrenceId,
	routineOccurrenceReplayKeys,
	routineOpensAt,
	routinePreviousSlot,
	routineStartDeadline,
	routineStartWindow,
	routineZoneUnsupported,
} from "../routines/routine-contract.ts";
import { routineReceiptOrigin } from "../routines/routine-save-origin.ts";
import {
	createClaimedOccurrence,
	createPendingOccurrence,
	type RoutineStoreState,
	routineHasJournalShare,
	routineJournalHasRoom,
} from "./routine-occurrence-journal.ts";
import { withResult } from "./routine-result-writes.ts";
import { admittedProgressFields, withRoutineRunState } from "./routine-run-state.ts";

export function latestDueTrigger(
	routine: RoutineDefinitionView,
	firstDueAt: number,
	nowMs: number,
): Extract<RoutineOccurrence["trigger"], { kind: "schedule" }> {
	if (routine.schedule.kind === "event") throw new Error("Event routines have no clock slot.");
	if (routine.schedule.kind === "once") return { kind: "schedule", scheduledAt: firstDueAt, missedCount: 0 };
	if (routine.schedule.kind === "calendar") {
		const scheduledAt = latestCalendarSlotAtOrBefore(routine.schedule, nowMs, firstDueAt);
		return {
			kind: "schedule",
			scheduledAt,
			missedCount: Math.min(
				MAX_CALENDAR_MISSED_COUNT,
				(routine.cursor.kind === "calendar" ? (routine.cursor.skipped ?? 0) : 0) +
					countCalendarSlots(routine.schedule, firstDueAt, scheduledAt, MAX_CALENDAR_MISSED_COUNT),
			),
		};
	}
	const lastIndex = Math.floor((nowMs - routine.schedule.anchorAt) / routine.schedule.intervalMs);
	const scheduledAt = routine.schedule.anchorAt + routine.schedule.intervalMs * lastIndex;
	const firstIndex = routine.cursor.kind === "interval" ? routine.cursor.nextIndex : 1;
	return { kind: "schedule", scheduledAt, missedCount: Math.max(0, lastIndex - firstIndex) };
}

/** Records why a due routine was not run away; the same reason is recorded once, and any claim clears it. */
export function recordAwayRefusal(state: RoutineStoreState, routineId: string, reason: string, nowMs: number): boolean {
	const routine = state.routines.get(routineId);
	if (!routine || routine.awayRefusal?.reason === reason) return false;
	state.routines.set(routineId, { ...routine, awayRefusal: { reason, at: nowMs } });
	return true;
}

/**
 * Admits the due slot of one clock routine: the slot's occurrence is claimed and appended to `output`, or, when the
 * slot was not run, recorded as a cancelled notice; the cursor moves past it. `journalFull`: the due slot stays due
 * because the journal has no room for its occurrence or notice. `refused`: the due slot stays due because `admitRun`
 * (the away spend bound) did not admit its run; slots that are only reported are not charged. `held`: away, the due
 * slot stays due because an earlier run away of the routine is not yet delivered ({@link routineAwayHeld}).
 */
export function admitClockRoutine(
	state: RoutineStoreState,
	id: string,
	stored: RoutineDefinitionView,
	input: RoutineOccurrenceClaimInput,
	output: RoutineOccurrence[],
	admitRun: () => boolean,
): {
	readonly changed: boolean;
	readonly journalFull: boolean;
	readonly refused?: true;
	readonly held?: true;
	readonly shareFull?: true;
} {
	const schedule = stored.schedule;
	const unchanged = { changed: false, journalFull: false };
	if (schedule.kind === "event") return unchanged;
	const parentOrigin = stored.target.kind === "session" ? routineReceiptOrigin(stored) : input.receiptOrigin;
	if (!parentOrigin || (input.parentSessionId && parentOrigin.sessionId !== input.parentSessionId)) return unchanged;
	const unsupported = routineZoneUnsupported(schedule);
	if (unsupported !== undefined) {
		// No slot can be placed here. The first due slot is reported once (its notice sets lastRunAt to it), and the
		// cursor waits for a runtime with the zone or an update to a supported zone.
		const slot = stored.cursor.kind === "calendar" ? stored.cursor.nextAt : null;
		if (slot === null || slot > input.nowMs || (stored.lastRunAt ?? Number.NEGATIVE_INFINITY) >= slot)
			return unchanged;
		const trigger = { kind: "schedule" as const, scheduledAt: slot, missedCount: 0 };
		const occurrenceId = routineOccurrenceId(stored, trigger);
		if (state.occurrences.has(occurrenceId)) return unchanged;
		if (!routineJournalHasRoom(state, input.nowMs)) return { changed: false, journalFull: true };
		recordRoutineNotice(
			state,
			stored,
			occurrenceId,
			trigger,
			input,
			parentOrigin,
			`${unsupported} It was not run, and later slots are not reported separately; the routine runs again on a runtime that supports the zone or after an update to a supported zone.`,
		);
		return { changed: true, journalFull: false };
	}
	let routine = stored;
	let changed = false;
	const rebased = rebasedRoutineCursor(
		schedule,
		stored.cursor,
		input.nowMs,
		routinePreviousSlot(schedule, stored.cursor),
	);
	if (rebased) {
		routine = {
			...stored,
			cursor: rebased,
			nextRunAt: nextRoutineAt(schedule, rebased) ?? ROUTINE_NO_NEXT_RUN_AT,
		};
		state.routines.set(id, routine);
		changed = true;
	}
	const dueAt = nextRoutineAt(schedule, routine.cursor);
	if (dueAt === undefined) return { changed, journalFull: false };
	// A `readyBy` window may open before the slot; the run still belongs to the slot (its identity and deadline).
	const early = dueAt > input.nowMs;
	if (
		early &&
		(routineStartWindow(routine, routine.cursor, state.occurrences.values())?.opensAt ?? dueAt) > input.nowMs
	)
		return { changed, journalFull: false };
	const trigger = latestDueTrigger(routine, dueAt, Math.max(input.nowMs, dueAt));
	const occurrenceId = routineOccurrenceId(routine, trigger);
	const after = routineCursorAfter(schedule, trigger.scheduledAt);
	// A slot consumed before its time records when, so the clock restart does not read it as a clock fault.
	const cursorAfter: RoutineCursor =
		early && (after.kind === "interval" || after.kind === "calendar") ? { ...after, consumedAt: input.nowMs } : after;
	const advance = (from: RoutineDefinitionView, cursor: RoutineCursor): { changed: true; journalFull: false } => {
		state.routines.set(id, {
			...from,
			cursor,
			nextRunAt: nextRoutineAt(schedule, cursor) ?? ROUTINE_NO_NEXT_RUN_AT,
		});
		return { changed: true, journalFull: false };
	};
	// A restarted cursor reached a slot that already has its occurrence: that slot is consumed, never repeated.
	if (state.occurrences.has(occurrenceId)) return advance(routine, cursorAfter);
	const deadline = routineStartDeadline(schedule, trigger.scheduledAt);
	const late = deadline !== undefined && input.nowMs > deadline;
	if (late && schedule.kind === "calendar" && routine.cursor.kind === "calendar") {
		// A slot past its lateness bound is passed over and counted in the next run's missed count. The first one of a
		// streak (no earlier skip pending) is reported once; later ones in the streak are only counted.
		const cursor: RoutineCursor = {
			kind: "calendar",
			nextAt: cursorAfter.kind === "calendar" ? cursorAfter.nextAt : null,
			skipped: Math.min(MAX_CALENDAR_MISSED_COUNT, trigger.missedCount + 1),
		};
		if (routine.cursor.skipped !== undefined) return advance(routine, cursor);
		if (!routineJournalHasRoom(state, input.nowMs)) return { changed, journalFull: true };
		const earlier = trigger.missedCount;
		const covered =
			earlier > 0
				? ` and ${earlier >= MAX_CALENDAR_MISSED_COUNT ? "at least " : ""}${earlier} earlier ${earlier === 1 ? "slot" : "slots"}`
				: "";
		recordRoutineNotice(
			state,
			routine,
			occurrenceId,
			trigger,
			input,
			parentOrigin,
			`This routine slot${covered} could not start within the schedule's maxLatenessMs and did not run. Later slots that also miss it are not reported separately: the next run's missed count includes them and these.`,
		);
		return advance(state.routines.get(id) ?? routine, cursor);
	}
	// Nothing is consumed without its occurrence: a full journal leaves the slot due until results are delivered.
	if (!routineJournalHasRoom(state, input.nowMs)) return { changed, journalFull: true };
	if (late) {
		// A one-off whose start window closed is reported once instead of run late.
		recordRoutineNotice(
			state,
			routine,
			occurrenceId,
			trigger,
			input,
			parentOrigin,
			"Routine start window closed before it could start; it was not run.",
		);
		return advance(state.routines.get(id) ?? routine, cursorAfter);
	}
	// A routine holding its whole journal share starts no run: the slot stays due, as for a full journal.
	if (!routineHasJournalShare(state, id, input.nowMs)) return { changed, journalFull: false, shareFull: true };
	// Away, one run per routine waits for its session at a time: later slots stay due and fold into its missed count.
	if (input.away && routineAwayHeld(state.occurrences.values(), routine, input.nowMs))
		return { changed, journalFull: false, held: true };
	if (!admitRun()) return { changed, journalFull: false, refused: true };
	const created = createClaimedOccurrence(
		state,
		routine,
		occurrenceId,
		trigger,
		input.owner,
		input.leaseMs,
		input.nowMs,
		parentOrigin,
	);
	const claimed: RoutineOccurrence = input.away ? { ...created, executor: "away" } : created;
	state.occurrences.set(occurrenceId, claimed);
	output.push(claimed);
	return advance(withRoutineRunState(routine, claimed), cursorAfter);
}

/**
 * Records a slot that was not run as a terminal cancelled occurrence, which is delivered to the parent once, and makes
 * it the routine's last run.
 */
export function recordRoutineNotice(
	state: RoutineStoreState,
	routine: RoutineDefinitionView,
	occurrenceId: string,
	trigger: Extract<RoutineOccurrence["trigger"], { kind: "schedule" }>,
	input: RoutineOccurrenceClaimInput,
	parentOrigin: WorkerReceiptOrigin,
	summary: string,
): void {
	const claimed = createClaimedOccurrence(
		state,
		routine,
		occurrenceId,
		trigger,
		input.owner,
		input.leaseMs,
		input.nowMs,
		parentOrigin,
	);
	state.routines.set(routine.routineId, withRoutineRunState(routine, claimed));
	state.occurrences.set(
		occurrenceId,
		withResult(state, { ...claimed, phase: "terminal" }, "cancelled", summary, parentOrigin.sessionId),
	);
}

/**
 * Decides one event routine against its session's retained host events. At most one undispatched run exists per
 * routine: the latest new attempt runs, older new attempts and superseded ones become its missed count. Returns
 * whether the cursor or the journal changed, or that a new attempt stays undecided because the journal is full; a
 * new occurrence is appended to `output`, claimed under `claim`, or pending without it.
 */
export function decideEventRoutine(
	state: RoutineStoreState,
	routine: RoutineDefinitionView,
	input: { readonly nowMs: number; readonly parentSessionId?: string },
	feed: RoutineHostEventFeed,
	output: RoutineOccurrence[],
	claim: { readonly owner: string; readonly leaseMs: number } | undefined,
): "changed" | "unchanged" | "journal-full" | "share-full" {
	if (routine.schedule.kind !== "event" || routine.schedule.source === "watch" || routine.cursor.kind !== "event")
		return "unchanged";
	for (const occurrence of state.occurrences.values())
		if (
			occurrence.routineId === routine.routineId &&
			(occurrence.phase === "pending" || occurrence.phase === "claimed")
		)
			return "unchanged";
	const decision = decideRoutineEvents(routine.schedule, routine.cursor, feed);
	// A run carries its deciding event last; a GitHub run also carries the earlier fresh occurrences, oldest first.
	const eventTrigger = (
		carried: readonly RoutineHostEventFact[],
		missedCount: number,
	): RoutineOccurrence["trigger"] => {
		const latest = carried.at(-1)!;
		const base = {
			kind: "event" as const,
			triggeredAt: input.nowMs,
			acceptedOrdinal: latest.acceptedOrdinal,
			missedCount,
			...(decision.cursor.historyGap ? { historyGap: true as const } : {}),
		};
		if (isCiAttemptEvent(latest.event)) return { ...base, event: latest.event };
		const earlier = carried.slice(0, -1).flatMap((fact) => (isCiAttemptEvent(fact.event) ? [] : [fact.event]));
		return { ...base, event: latest.event, ...(earlier.length ? { earlier } : {}) };
	};
	// The same event is the same work: an event a journaled run carries or a tombstone records never runs again.
	const known = new Set([...state.occurrences.values()].flatMap(routineOccurrenceReplayKeys));
	const fresh = decision.candidates.filter((fact) => {
		const key = routineEventKey(routine, fact.event);
		return !known.has(key) && !state.replayTombstones.has(key);
	});
	const carried = fresh.slice(routine.schedule.source === "github" ? -HOST_EVENT_LISTENER_LIMITS.maxBatch : -1);
	const latest = carried.at(-1);
	if (latest) {
		const parentOrigin = routineReceiptOrigin(routine);
		if (!parentOrigin || (input.parentSessionId && parentOrigin.sessionId !== input.parentSessionId))
			return "unchanged";
		// Without journal room, or with the routine's share held, the attempt stays undecided until results settle.
		if (!routineJournalHasRoom(state, input.nowMs)) return "journal-full";
		if (!routineHasJournalShare(state, routine.routineId, input.nowMs)) return "share-full";
		const coalesced = fresh
			.slice(0, fresh.length - carried.length)
			.filter((fact) => fact.acceptedOrdinal <= decision.cursor.throughOrdinal).length;
		const trigger = eventTrigger(
			carried,
			Math.min(MAX_ROUTINE_EVENT_MISSED_COUNT, (decision.cursor.skipped ?? 0) + coalesced),
		);
		const occurrenceId = routineOccurrenceId(routine, trigger);
		const occurrence = claim
			? createClaimedOccurrence(
					state,
					routine,
					occurrenceId,
					trigger,
					claim.owner,
					claim.leaseMs,
					input.nowMs,
					parentOrigin,
				)
			: createPendingOccurrence(state, routine, occurrenceId, trigger, input.nowMs, parentOrigin);
		state.occurrences.set(occurrenceId, occurrence);
		const cursor: RoutineCursor = {
			kind: "event",
			throughOrdinal: decision.cursor.throughOrdinal,
			replayGaps: decision.cursor.replayGaps,
			// A one-run routine is spent in the write that records its run, so no second attempt can start it.
			...(routine.schedule.stopAfterFirstRun ? { spent: true as const } : {}),
		};
		state.routines.set(routine.routineId, { ...withRoutineRunState(routine, occurrence), cursor });
		output.push(occurrence);
		return "changed";
	}
	if (isDeepStrictEqual(decision.cursor, routine.cursor)) return "unchanged";
	state.routines.set(routine.routineId, { ...routine, cursor: decision.cursor });
	return "changed";
}

export function recordRoutineAwayRefusals(
	state: RoutineStoreState,
	input: {
		refusals: readonly { readonly routineId: string; readonly reason: string }[];
		nowMs: number;
	},
	persist: () => void,
): void {
	let changed = false;
	for (const { routineId, reason } of input.refusals) {
		const routine = state.routines.get(routineId);
		if (
			!routine?.enabled ||
			(routine.schedule.kind !== "event" && routineOpensAt(routine, state.occurrences.values()) > input.nowMs)
		)
			continue;
		const bounded = reason.trim().slice(0, MAX_ROUTINE_SUMMARY_CHARS) || "This routine cannot run away.";
		if (recordAwayRefusal(state, routineId, bounded, input.nowMs)) changed = true;
	}
	if (changed) persist();
}

export function clearRoutineAwayRefusals(
	state: RoutineStoreState,
	input: { routineIds: readonly string[]; reasonPrefix: string },
	persist: () => void,
): void {
	let changed = false;
	for (const routineId of input.routineIds) {
		const routine = state.routines.get(routineId);
		if (!routine?.awayRefusal?.reason.startsWith(input.reasonPrefix)) continue;
		const { awayRefusal: _refusal, ...cleared } = routine;
		state.routines.set(routineId, cleared);
		changed = true;
	}
	if (changed) persist();
}

export function releaseLapsedAwayClaims(
	state: RoutineStoreState,
	input: { parentSessionId: string; nowMs: number },
	persist: () => void,
): boolean {
	let changed = false;
	for (const item of state.occurrences.values()) {
		if (
			item.executor !== "away" ||
			item.parentOrigin.sessionId !== input.parentSessionId ||
			(item.phase !== "pending" && (item.phase !== "claimed" || item.claim!.leaseUntil > input.nowMs))
		)
			continue;
		const { claim: _claim, executor: _executor, ...pending } = item;
		state.occurrences.set(item.occurrenceId, {
			...pending,
			phase: "pending",
			updatedAt: Math.max(item.updatedAt, input.nowMs),
		});
		changed = true;
	}
	if (changed) persist();
	return changed;
}

export function claimDueRoutineOccurrences(
	state: RoutineStoreState,
	input: RoutineOccurrenceClaimInput,
	persist: () => void,
): RoutineClaimResult {
	if (
		!Number.isSafeInteger(input.nowMs) ||
		input.nowMs < 0 ||
		!Number.isSafeInteger(input.leaseMs) ||
		input.leaseMs <= 0 ||
		!Number.isSafeInteger(input.nowMs + input.leaseMs) ||
		!Number.isFinite(new Date(input.nowMs + input.leaseMs).getTime()) ||
		!Number.isSafeInteger(input.limit) ||
		input.limit < 1 ||
		!input.owner ||
		input.owner.trim() !== input.owner ||
		input.owner.length > 256 ||
		input.owner.includes("\0")
	)
		throw new Error("Routine claim requires a valid owner, bounded count and positive lease.");
	const output: RoutineOccurrence[] = [];
	let changed = false;
	const limit = Math.min(input.limit, MAX_ROUTINE_OCCURRENCES);
	const eligible = input.eligibleRoutineIds ? new Set(input.eligibleRoutineIds) : undefined;
	const eligibleOccurrences = input.eligibleOccurrenceIds ? new Set(input.eligibleOccurrenceIds) : undefined;
	// An away claim admits a run only while its full per-run bound still fits the rolling day's bound; a refused
	// run claims nothing and stays due for its parent.
	const away = input.away;
	const awayRoom = away ? routineAwaySpendRoom(state.occurrences.values(), away, input.nowMs) : undefined;
	let awayAdmitted = 0;
	const awayRefused: string[] = [];
	const awayHeld: string[] = [];
	const admitAway = (): boolean => {
		if (!awayRoom) return true;
		if (!awayRoom.fits(awayAdmitted)) return false;
		awayAdmitted++;
		return true;
	};
	const refuseAway = (routineId: string, reason: string, into: string[]): void => {
		if (!into.includes(routineId)) into.push(routineId);
		if (recordAwayRefusal(state, routineId, reason, input.nowMs)) changed = true;
	};
	// Accepted work owns its original definition independently of the schedule cursor.
	// Recover it first, including consumed one-offs and manual occurrences.
	for (const [occurrenceId, occurrence] of state.occurrences) {
		if (output.length >= limit) break;
		if (occurrence.phase !== "pending" && occurrence.phase !== "claimed") continue;
		if (input.nowMs < occurrence.updatedAt) continue;
		if (occurrence.claim && occurrence.claim.leaseUntil > input.nowMs) continue;
		if (input.routineId && occurrence.routineId !== input.routineId) continue;
		if (
			eligibleOccurrences ? !eligibleOccurrences.has(occurrenceId) : eligible && !eligible.has(occurrence.routineId)
		)
			continue;
		if (occurrence.target.kind === "session" && occurrence.target.parentSessionId !== input.parentSessionId) continue;
		if (input.parentSessionId && occurrence.parentOrigin.sessionId !== input.parentSessionId) continue;
		const definition = state.routines.get(occurrence.routineId);
		if (
			!definition ||
			definition.incarnationId !== occurrence.definition.incarnationId ||
			(!definition.enabled && occurrence.trigger.kind !== "manual")
		)
			continue;
		if (occurrence.dispatchKey || occurrence.executionRef || occurrence.result)
			throw new Error("An undispatched routine occurrence contains execution state.");
		const deadline =
			occurrence.trigger.kind === "schedule"
				? routineStartDeadline(occurrence.definition.schedule, occurrence.trigger.scheduledAt)
				: undefined;
		if (deadline !== undefined && input.nowMs > deadline) {
			state.occurrences.set(
				occurrenceId,
				withResult(
					state,
					{ ...occurrence, phase: "terminal", updatedAt: input.nowMs },
					"cancelled",
					"Routine start window closed before dispatch; it was not run.",
					occurrence.parentOrigin.sessionId,
				),
			);
			changed = true;
			continue;
		}
		// An away run reclaimed is already charged; any other one is admitted under the bound.
		if (occurrence.executor !== "away" && !admitAway()) {
			refuseAway(occurrence.routineId, ROUTINE_AWAY_SPEND_REFUSAL, awayRefused);
			continue;
		}
		// A queued run reads its routine's record as it stands now: its brief is fixed before its dispatch identity.
		const { executor: _executor, progressBrief: _brief, progressUntrusted: _tainted, ...undispatched } = occurrence;
		const reclaimed: RoutineOccurrence = {
			...undispatched,
			...admittedProgressFields(definition, occurrence),
			...(away ? { executor: "away" as const } : {}),
			phase: "claimed",
			updatedAt: input.nowMs,
			claim: { token: randomUUID(), owner: input.owner, leaseUntil: input.nowMs + input.leaseMs },
		};
		state.occurrences.set(occurrenceId, reclaimed);
		output.push(reclaimed);
		// The claim admits the routine again, as a new slot's claim does.
		const owning = state.routines.get(occurrence.routineId);
		if (owning?.awayRefusal) {
			const { awayRefusal: _refusal, ...admitted } = owning;
			state.routines.set(owning.routineId, admitted);
		}
	}
	let journalFull = false;
	const journalShareFull: string[] = [];
	const unschedulable: { routineId: string; reason: string }[] = [];
	for (const [id, stored] of state.routines) {
		if (output.length >= limit) break;
		if (!stored.enabled || (input.routineId && input.routineId !== id)) continue;
		if (eligible && !eligible.has(id)) continue;
		// An ended routine starts nothing more; `retireEndedRoutines` removes it once its runs are delivered.
		if (routineEnded(stored, input.nowMs)) continue;
		if (stored.target.kind === "session" && stored.target.parentSessionId !== input.parentSessionId) continue;
		// An occurrence is never older than its definition: with the clock behind the last edit, wait for it.
		if (input.nowMs < Date.parse(stored.updatedAt)) continue;
		// A watch is decided by the monitor's observations (`observeWatch`), never by the host-event ledger.
		if (stored.schedule.kind === "event" && stored.schedule.source === "watch") continue;
		if (stored.schedule.kind === "event") {
			const decided = input.hostEvents
				? decideEventRoutine(state, stored, input, input.hostEvents, output, {
						owner: input.owner,
						leaseMs: input.leaseMs,
					})
				: "unchanged";
			if (decided === "changed") changed = true;
			else if (decided === "journal-full") journalFull = true;
			else if (decided === "share-full") journalShareFull.push(id);
			continue;
		}
		// One routine whose slots cannot be computed here is skipped and reported; the others are still claimed.
		try {
			const admitted = admitClockRoutine(state, id, stored, input, output, admitAway);
			if (admitted.changed) changed = true;
			if (admitted.journalFull) journalFull = true;
			if (admitted.refused) refuseAway(id, ROUTINE_AWAY_SPEND_REFUSAL, awayRefused);
			if (admitted.held) refuseAway(id, ROUTINE_AWAY_HELD_REASON, awayHeld);
			if (admitted.shareFull) journalShareFull.push(id);
		} catch (error) {
			unschedulable.push({ routineId: id, reason: error instanceof Error ? error.message : String(error) });
		}
	}
	if (output.length || changed) persist();
	const awayRetryAt =
		awayRefused.length > 0 && away
			? routineAwaySpendRoom(state.occurrences.values(), away, input.nowMs).exit
			: undefined;
	return {
		claimed: output.map((item) => structuredClone(item)),
		journalFull,
		journalShareFull,
		unschedulable,
		awayRefused,
		...(awayRetryAt === undefined ? {} : { awayRetryAt }),
		awayHeld,
	};
}

export function decideAwayEventRoutines(
	state: RoutineStoreState,
	input: AwayEventDecisionInput,
	persist: () => void,
): AwayEventDecisionResult {
	const output: RoutineOccurrence[] = [];
	const held: string[] = [];
	const shareFull: string[] = [];
	let journalFull = false;
	let changed = false;
	for (const routineId of input.routineIds) {
		const stored = state.routines.get(routineId);
		if (
			!stored?.enabled ||
			stored.schedule.kind !== "event" ||
			stored.schedule.source === "watch" ||
			stored.target.kind !== "session" ||
			stored.target.parentSessionId !== input.parentSessionId ||
			routineEnded(stored, input.nowMs) ||
			input.nowMs < Date.parse(stored.updatedAt)
		)
			continue;
		if (routineAwayHeld(state.occurrences.values(), stored, input.nowMs)) {
			held.push(routineId);
			continue;
		}
		const decided = decideEventRoutine(state, stored, input, input.hostEvents, output, undefined);
		if (decided === "changed") changed = true;
		else if (decided === "journal-full") journalFull = true;
		else if (decided === "share-full") shareFull.push(routineId);
	}
	if (changed) persist();
	return { decided: output.map((item) => item.occurrenceId), held, journalFull, shareFull };
}
