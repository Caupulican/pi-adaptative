import { createHash } from "node:crypto";
import { parentInputOriginalDetails } from "../../kernel/session/parent-input-ledger.ts";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import type { TurnOriginRecord } from "../../kernel/turn-origin-stamp.ts";
import { isCiAttemptEvent } from "../events/host-event-contract.ts";
import { HOST_EVENT_KINDS } from "../events/host-event-kinds.ts";
import type { WorkerReceiptOrigin } from "../orchestration/worker-receipt-origin.ts";
import type { ParentInputDelivery } from "../parent-input-delivery.ts";
import { wrapUntrustedText } from "../security/untrusted-boundary.ts";
import { MAX_CALENDAR_MISSED_COUNT } from "./calendar-schedule.ts";
import {
	MAX_ROUTINE_EVENT_MISSED_COUNT,
	type RoutineDelivery,
	type RoutineEventTrigger,
	type RoutineIntakeNoticeRecord,
	type RoutineOccurrence,
	type RoutineResult,
	routineTriggerEvents,
} from "./routine-contract.ts";
import { describeWatchFired } from "./watch-contract.ts";

export const ROUTINE_COMPLETION_TYPE = "routine-completion";
/** Longest preview of a run's report the owner's history row carries; the model reads the whole fenced report. */
export const MAX_RESULT_PREVIEW_CHARS = 160;

/** The first words of a run's report on one line, control characters collapsed, for the owner's history row and a retired routine's record. */
export function resultPreview(summary: string): string | undefined {
	const flat = summary.replace(/[\p{Cc}\s]+/gu, " ").trim();
	if (flat.length === 0) return undefined;
	return flat.length > MAX_RESULT_PREVIEW_CHARS ? `${flat.slice(0, MAX_RESULT_PREVIEW_CHARS - 1)}…` : flat;
}
/** Why a result that would start a parent turn rides with the owner's next turn instead. */
export const ROUTINE_RESULT_WAKES_HOLD = "max_result_wakes_per_day_reached";
export const ROUTINE_INTAKE_NOTICE_TYPE = "routine-intake";

/**
 * Who wrote the words a routine run carries, when not the owner: an event trigger carrying any occurrence of a
 * third-party-authored kind, or a progress brief a third party's run wrote (`progressUntrusted`). It travels with the run,
 * in its worker dispatch and in its result, and derives from the occurrence alone, so a replay and a redelivery carry
 * the same origin.
 */
export function routineTurnOrigin(
	occurrence: Pick<RoutineOccurrence, "trigger" | "progressUntrusted">,
): TurnOriginRecord | undefined {
	if (occurrence.progressUntrusted === true) return { v: 1, k: "host-event", thirdParty: true };
	const trigger = occurrence.trigger;
	// A watch firing's excerpt (a command's output, a page's words) is untrusted data: the run that reads it is not the owner's.
	if (trigger.kind === "watch")
		return trigger.event.excerpt === undefined ? undefined : { v: 1, k: "host-event", thirdParty: true };
	if (
		trigger.kind !== "event" ||
		!routineTriggerEvents(trigger).some((event) => HOST_EVENT_KINDS[event.kind].authorship === "third-party-authored")
	)
		return undefined;
	return { v: 1, k: "host-event", thirdParty: true };
}

/** What the parent reads about the event trigger, outside the worker's evidence: the host's own facts. */
function routineEventCause(trigger: RoutineEventTrigger, count: string): string {
	const { missedCount } = trigger;
	if (isCiAttemptEvent(trigger.event)) {
		const missed =
			missedCount > 0
				? ` It also covers ${count} earlier matching CI ${missedCount === 1 ? "attempt that did not start a run of its own" : "attempts that did not start a run of their own"}.`
				: "";
		const gap = trigger.historyGap
			? " Some CI history was not observed by this session; attempts in between may be missing."
			: "";
		return ` It ran for a CI ${trigger.event.conclusion} result.${missed}${gap}`;
	}
	const carried = routineTriggerEvents(trigger).length;
	const missed =
		missedCount > 0
			? ` ${count} more matching GitHub ${missedCount === 1 ? "occurrence was" : "occurrences were"} not carried by any run.`
			: "";
	const gap = trigger.historyGap
		? " Some GitHub history was not observed by this session; occurrences in between may be missing."
		: "";
	return ` It ran for ${carried} GitHub ${carried === 1 ? "occurrence" : "occurrences"}, the latest a ${trigger.event.kind} by ${trigger.event.author}.${missed}${gap}`;
}

/**
 * Whether a result carries to the owner's next turn because it is quiet. A run's `ownerUpdate: "none"` answers whether
 * the OWNER needs to hear it, never whether the session that armed the routine wakes: a watch is armed because that
 * session's own work waits on the change, so its result always starts that session's turn.
 */
export function routineResultIsQuiet(
	result: Pick<RoutineResult, "ownerUpdate">,
	trigger: Pick<RoutineOccurrence["trigger"], "kind">,
): boolean {
	return result.ownerUpdate === "none" && trigger.kind !== "watch";
}

/**
 * The words the model reads after a routine's fenced report. A quiet result waits for the owner; a held one waited for the
 * wake bound; a watch's quiet result wakes the session that armed it, which decides what the owner hears.
 */
function routineResultContent(
	flags: { readonly quiet: boolean; readonly ownerQuiet: boolean; readonly holds: boolean },
	report: string,
): string {
	if (flags.quiet)
		return `${report}\nNo owner update is needed; mention it only if it bears on what the owner asks next. Later quiet runs before the owner's next turn are recorded but not delivered.`;
	if (flags.holds)
		return `${report}\nRoutine results reached the day's bound on parent turns (routines.maxResultWakesPerDay), so this one waited for the owner's turn. Use the saved task and this evidence to decide whether the owner needs an update or further work. Later results of this routine before the owner's next turn are recorded on the routine but not delivered.`;
	if (flags.ownerQuiet)
		return `${report}\nThe owner needs no update from this result alone, but you armed this watch because your own work waits on it: continue that work now, or end the turn if none waits.`;
	return `${report}\nUse the saved task and this evidence to decide whether the owner needs an update or further work.`;
}

/**
 * Host identity is separate from the worker's untrusted summary. A quiet result rides with the owner's next turn; every
 * other outcome (a watch's result included, whatever its `ownerUpdate`) starts a parent turn unless `held`: the
 * routine-result wake bound was reached when it was first saved, so it rides with the owner's next turn too. The caller
 * repeats a saved input's `held`, so a redelivery after restart presents the same identity and payload.
 */
export function routineParentInput(delivery: RoutineDelivery, held = false): ParentInputDelivery {
	const { occurrence, result } = delivery;
	const trigger = occurrence.trigger;
	if (trigger.kind === "expiry") return routineExpiryNotice(delivery, trigger.expiresAt);
	if (trigger.kind === "condition") return routineConditionNotice(delivery, trigger);
	const ownerQuiet = result.ownerUpdate === "none";
	const quiet = routineResultIsQuiet(result, trigger);
	const holds = held && !quiet;
	const missedCount = trigger.kind === "manual" || trigger.kind === "watch" ? 0 : trigger.missedCount;
	// A count recorded at its saturation bound stands for that many or more.
	const saturated =
		trigger.kind === "event"
			? missedCount >= MAX_ROUTINE_EVENT_MISSED_COUNT
			: occurrence.definition.schedule.kind === "calendar" && missedCount >= MAX_CALENDAR_MISSED_COUNT;
	const count = saturated ? `at least ${missedCount}` : `${missedCount}`;
	let missed = "";
	if (trigger.kind === "event") missed = routineEventCause(trigger, count);
	else if (trigger.kind === "watch") missed = ` It ran because of this: ${describeWatchFired(trigger.event)}.`;
	else if (missedCount > 0)
		missed = ` It also covers ${count} earlier scheduled ${missedCount === 1 ? "slot" : "slots"} that did not run.`;
	const evidence = wrapUntrustedText(result.summary, `routine-result:${occurrence.occurrenceId}`, {
		nonce: result.digest,
	});
	const head = `Routine ${occurrence.routineId} ended: ${ownerQuiet ? "succeeded with nothing for the owner" : result.outcome}.`;
	const message = {
		customType: ROUTINE_COMPLETION_TYPE,
		display: true,
		content: routineResultContent({ quiet, ownerQuiet, holds }, `${head}${missed}\n${evidence}`),
		details: {
			occurrenceId: occurrence.occurrenceId,
			routineId: occurrence.routineId,
			routineRevision: occurrence.routineRevision,
			outcome: result.outcome,
			resultDigest: result.digest,
			...(resultPreview(result.summary) ? { resultPreview: resultPreview(result.summary) } : {}),
			...(missedCount > 0 ? { missedCount } : {}),
			...(saturated ? { missedCountIsLowerBound: true as const } : {}),
			...(trigger.kind === "event"
				? {
						hostEvent: {
							eventId: trigger.event.eventId,
							...(isCiAttemptEvent(trigger.event)
								? { runAttempt: trigger.event.identity.runAttempt, conclusion: trigger.event.conclusion }
								: { eventIds: routineTriggerEvents(trigger).map((event) => event.eventId) }),
							...(trigger.historyGap ? { historyGap: true as const } : {}),
						},
					}
				: {}),
			...(trigger.kind === "watch"
				? {
						cause: describeWatchFired(trigger.event),
						watch: { condition: trigger.event.condition, change: trigger.event.change },
					}
				: {}),
			...(ownerQuiet ? { ownerUpdate: "none" as const } : {}),
			...(holds ? { deliveryHold: ROUTINE_RESULT_WAKES_HOLD } : {}),
			// The run's report can quote the third party's words: the turn that reads it is a third party's run.
			...(routineTurnOrigin(occurrence) ? { thirdParty: true as const } : {}),
		},
	};
	return routineCompletionInput({ occurrence, result }, message, quiet || holds);
}

/** One stored result's parent input: its identity is the occurrence and result digest, so a redelivery is the same. */
function routineCompletionInput(
	{ occurrence, result }: RoutineDelivery,
	message: ParentInputDelivery["message"],
	nextOwnerTurn: boolean,
): ParentInputDelivery {
	return {
		deliveryId: `routine:${createHash("sha256")
			.update(JSON.stringify([occurrence.occurrenceId, result.digest]))
			.digest("hex")}`,
		payloadDigest: createHash("sha256").update(JSON.stringify(message)).digest("hex"),
		message,
		origin: occurrence.parentOrigin,
		...(nextOwnerTurn ? { mode: "next-owner-turn" as const } : {}),
	};
}

/**
 * The host's one notice that a routine reached its end time and was removed. It carries no worker text and rides
 * with the owner's next turn; its identity is the stored occurrence's, so a redelivery after restart is the same input.
 */
function routineExpiryNotice(delivery: RoutineDelivery, expiresAt: number): ParentInputDelivery {
	const { occurrence, result } = delivery;
	const message = {
		customType: ROUTINE_COMPLETION_TYPE,
		display: true,
		content: `Routine ${occurrence.routineId} reached the end time it was saved with and was removed; it stopped watching and will not run again. Tell the owner once, briefly, when it bears on what they ask next; they can ask for it again or for a later end.`,
		details: {
			occurrenceId: occurrence.occurrenceId,
			routineId: occurrence.routineId,
			routineRevision: occurrence.routineRevision,
			outcome: result.outcome,
			resultDigest: result.digest,
			expiresAt,
		},
	};
	return routineCompletionInput(delivery, message, true);
}

/**
 * The host's one notice that a run of the routine reported the end the owner stated as met and the routine was
 * removed. It carries no worker text (the reporting run's own result carries its evidence) and rides with the owner's
 * next turn; its identity is the stored occurrence's, so a redelivery after restart is the same input.
 */
function routineConditionNotice(
	delivery: RoutineDelivery,
	trigger: Extract<RoutineDelivery["occurrence"]["trigger"], { kind: "condition" }>,
): ParentInputDelivery {
	const { occurrence, result } = delivery;
	const end = occurrence.definition.origin?.endCondition ?? "";
	const message = {
		customType: ROUTINE_COMPLETION_TYPE,
		display: true,
		content: `Routine ${occurrence.routineId} ended: ${JSON.stringify(end)} was reported met by its run ${trigger.occurrenceId}, so the host removed it; it will not run again. The host did not check the end itself: that run's result holds the evidence. Tell the owner once, briefly, when it bears on what they ask next; they can ask for it again.`,
		details: {
			occurrenceId: occurrence.occurrenceId,
			routineId: occurrence.routineId,
			routineRevision: occurrence.routineRevision,
			outcome: result.outcome,
			resultDigest: result.digest,
			conditionMetBy: trigger.occurrenceId,
		},
	};
	return routineCompletionInput(delivery, message, true);
}

/**
 * The owner-visible notice of one decided intake request, carried with the owner's next turn: the host's plain cadence
 * and every timing part the host chose because the owner left it open, why a request was refused, or which words read
 * as a request the host could not compile. Its identity and payload derive from the retained record alone (the
 * request and how it ended), so a redelivery after restart is the same input; `origin` is captured per delivery.
 */
export function routineIntakeNotice(
	record: RoutineIntakeNoticeRecord,
	origin: WorkerReceiptOrigin,
): ParentInputDelivery {
	const { outcome } = record;
	const defaults = record.defaults?.length
		? `\nThe owner did not state everything, so the host chose: ${record.defaults.join("; ")}. The owner can change it in plain words.`
		: "";
	let content: string;
	if (outcome.kind === "created")
		content = `Scheduled (read-only): ${outcome.cadence} - ${JSON.stringify(record.prompt)}\nRoutine ${outcome.routineId} was created from the owner's own words. Its worker cannot edit existing files, create files outside its scratch area or use the network. The owner can ask to change, widen or cancel it.${defaults}`;
	else if (outcome.kind === "refused")
		content = `Not scheduled: ${outcome.reason} - ${JSON.stringify(record.prompt)}\nThe owner's request was recognized but no routine was created.`;
	else
		content = `Could not schedule what reads as a request: ${outcome.reason} - ${JSON.stringify(record.prompt)}\nNo routine was created. If it was meant, the owner can restate it.`;
	const message = {
		customType: ROUTINE_INTAKE_NOTICE_TYPE,
		display: true,
		content,
		details: {
			routineIntakeKey: record.key,
			sourceId: record.sourceId,
			...(outcome.kind === "created" ? { routineId: outcome.routineId } : { [outcome.kind]: outcome.reason }),
		},
	};
	return {
		deliveryId: routineIntakeNoticeId(record),
		payloadDigest: createHash("sha256").update(JSON.stringify(message)).digest("hex"),
		message,
		origin,
		mode: "next-owner-turn",
	};
}

/** One notice per request and outcome: a request's record always delivers under the same id. */
export function routineIntakeNoticeId(record: RoutineIntakeNoticeRecord): string {
	return `${ROUTINE_INTAKE_NOTICE_TYPE}:${createHash("sha256")
		.update(JSON.stringify([record.key, record.outcome.kind]))
		.digest("hex")}`;
}

/**
 * Whether a canonical parent input is a result of this routine carried for the owner's next turn for the same cause:
 * a quiet result (`quiet`), or one the wake bound held (`held`).
 */
export function isCarriedRoutineCompletion(
	entry: SessionEntry | undefined,
	routineId: string,
	cause: "quiet" | "held",
): boolean {
	if (entry?.type !== "custom_message" || entry.customType !== ROUTINE_COMPLETION_TYPE) return false;
	const details = parentInputOriginalDetails(entry);
	if (typeof details !== "object" || details === null || !("routineId" in details) || details.routineId !== routineId)
		return false;
	// A watch's quiet result that the wake bound held carries both marks; it is the held one.
	return cause === "quiet"
		? "ownerUpdate" in details && details.ownerUpdate === "none" && !("deliveryHold" in details)
		: "deliveryHold" in details && details.deliveryHold === ROUTINE_RESULT_WAKES_HOLD;
}
