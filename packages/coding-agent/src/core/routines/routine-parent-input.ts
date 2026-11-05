import { createHash } from "node:crypto";
import { parentInputOriginalDetails } from "../../kernel/session/parent-input-ledger.ts";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import { formatDurationIntervalMs } from "../delegation/bot-team-routine-helpers.ts";
import type { WorkerReceiptOrigin } from "../orchestration/worker-receipt-origin.ts";
import type { ParentInputDelivery } from "../parent-input-delivery.ts";
import { wrapUntrustedText } from "../security/untrusted-boundary.ts";
import { MAX_CALENDAR_MISSED_COUNT } from "./calendar-schedule.ts";
import {
	MAX_ROUTINE_EVENT_MISSED_COUNT,
	type RoutineDelivery,
	type RoutineIntakeRequest,
	type RoutineScheduleInput,
} from "./routine-contract.ts";

const ROUTINE_COMPLETION_TYPE = "routine-completion";
const ROUTINE_INTAKE_NOTICE_TYPE = "routine-intake";

/**
 * Host identity is separate from the worker's untrusted summary. The delivery mode comes only from the persisted
 * result, so a redelivery after restart presents the same identity: a quiet result rides with the owner's next turn,
 * every other outcome starts a parent turn.
 */
export function routineParentInput({ occurrence, result }: RoutineDelivery): ParentInputDelivery {
	const quiet = result.ownerUpdate === "none";
	const trigger = occurrence.trigger;
	const missedCount = trigger.kind === "manual" ? 0 : trigger.missedCount;
	// A count recorded at its saturation bound stands for that many or more.
	const saturated =
		trigger.kind === "event"
			? missedCount >= MAX_ROUTINE_EVENT_MISSED_COUNT
			: occurrence.definition.schedule.kind === "calendar" && missedCount >= MAX_CALENDAR_MISSED_COUNT;
	const count = saturated ? `at least ${missedCount}` : `${missedCount}`;
	let missed = "";
	if (missedCount > 0 && trigger.kind === "event")
		missed = ` It also covers ${count} earlier matching CI ${missedCount === 1 ? "attempt that did not start a run of its own" : "attempts that did not start a run of their own"}.`;
	else if (missedCount > 0)
		missed = ` It also covers ${count} earlier scheduled ${missedCount === 1 ? "slot" : "slots"} that did not run.`;
	if (trigger.kind === "event") {
		missed = ` It ran for a CI ${trigger.event.conclusion} result.${missed}`;
		if (trigger.historyGap)
			missed += " Some CI history was not observed by this session; attempts in between may be missing.";
	}
	const evidence = wrapUntrustedText(result.summary, `routine-result:${occurrence.occurrenceId}`, {
		nonce: result.digest,
	});
	const message = {
		customType: ROUTINE_COMPLETION_TYPE,
		display: true,
		content: quiet
			? `Routine ${occurrence.routineId} ended: succeeded with nothing for the owner.${missed}\n${evidence}\nNo owner update is needed; mention it only if it bears on what the owner asks next. Later quiet runs before the owner's next turn are recorded but not delivered.`
			: `Routine ${occurrence.routineId} ended: ${result.outcome}.${missed}\n${evidence}\nUse the saved task and this evidence to decide whether the owner needs an update or further work.`,
		details: {
			occurrenceId: occurrence.occurrenceId,
			routineId: occurrence.routineId,
			routineRevision: occurrence.routineRevision,
			outcome: result.outcome,
			resultDigest: result.digest,
			...(missedCount > 0 ? { missedCount } : {}),
			...(saturated ? { missedCountIsLowerBound: true as const } : {}),
			...(trigger.kind === "event"
				? {
						hostEvent: {
							eventId: trigger.event.eventId,
							runAttempt: trigger.event.identity.runAttempt,
							conclusion: trigger.event.conclusion,
							...(trigger.historyGap ? { historyGap: true as const } : {}),
						},
					}
				: {}),
			...(quiet ? { ownerUpdate: "none" as const } : {}),
		},
	};
	return {
		deliveryId: `routine:${createHash("sha256")
			.update(JSON.stringify([occurrence.occurrenceId, result.digest]))
			.digest("hex")}`,
		payloadDigest: createHash("sha256").update(JSON.stringify(message)).digest("hex"),
		message,
		origin: occurrence.parentOrigin,
		...(quiet ? { mode: "next-owner-turn" as const } : {}),
	};
}

/** Plain words for an authored schedule: the owner's intake notice and the intake judge read the same text. */
export function describeRoutineSchedule(schedule: RoutineScheduleInput): string {
	switch (schedule.kind) {
		case "interval":
			return `every ${formatDurationIntervalMs(schedule.intervalMs)}`;
		case "once":
			return `once at ${new Date(schedule.at).toISOString()}`;
		case "calendar":
			return `on the calendar rule "${schedule.cron}" (minute hour day-of-month month day-of-week) in ${schedule.timeZone ?? "this host's time zone"}`;
		case "event":
			return `when a CI attempt of the checked-out revision ends in ${(schedule.conclusions ?? ["failure"]).join(" or ")}${schedule.workflowPath === undefined ? "" : ` for ${schedule.workflowPath}`}`;
	}
}

/**
 * The owner-visible notice of one intake decision, carried with the owner's next turn. Its identity derives from the
 * request alone and its anchor is the pass's retained one, so a redelivery after restart is the same input.
 */
export function routineIntakeNotice(
	request: RoutineIntakeRequest,
	origin: WorkerReceiptOrigin,
	outcome: { readonly created: string } | { readonly refused: string },
): ParentInputDelivery {
	const cadence = describeRoutineSchedule(request.schedule);
	const message = {
		customType: ROUTINE_INTAKE_NOTICE_TYPE,
		display: true,
		content:
			"created" in outcome
				? `Scheduled (read-only): ${cadence} - ${JSON.stringify(request.prompt)}\nRoutine ${outcome.created} was created from the owner's own words without write authority. The owner can ask to change, widen or cancel it.`
				: `Not scheduled: ${outcome.refused} - ${JSON.stringify(request.prompt)}\nThe owner's request was recognized but no routine was created.`,
		details: {
			routineIntakeKey: request.key,
			sourceId: request.sourceId,
			...("created" in outcome ? { routineId: outcome.created } : { refused: outcome.refused }),
		},
	};
	return {
		deliveryId: `${ROUTINE_INTAKE_NOTICE_TYPE}:${createHash("sha256").update(request.key).digest("hex")}`,
		payloadDigest: createHash("sha256").update(JSON.stringify(message)).digest("hex"),
		message,
		origin,
		mode: "next-owner-turn",
	};
}

/** Whether a canonical parent input is a quiet result of this routine, still carried for the owner's next turn. */
export function isQuietRoutineCompletion(entry: SessionEntry | undefined, routineId: string): boolean {
	if (entry?.type !== "custom_message" || entry.customType !== ROUTINE_COMPLETION_TYPE) return false;
	const details = parentInputOriginalDetails(entry);
	return (
		typeof details === "object" &&
		details !== null &&
		"routineId" in details &&
		details.routineId === routineId &&
		"ownerUpdate" in details &&
		details.ownerUpdate === "none"
	);
}
