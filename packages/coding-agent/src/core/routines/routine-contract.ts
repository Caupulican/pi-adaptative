import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { type Static, Type } from "typebox";
import type { WorkerSavedIntent } from "../delegation/worker-saved-intent.ts";
import { parseWorkerSavedIntent } from "../delegation/worker-saved-intent.ts";
import { workerReceiptOriginFromValue } from "../orchestration/worker-receipt-origin.ts";
import { hasOnlyKeys, isPlainRecord } from "../util/value-guards.ts";
import {
	canonicalCalendarCron,
	canonicalCalendarTimeZone,
	isCalendarTimeZone,
	MAX_CALENDAR_CRON_CHARS,
	MAX_CALENDAR_MISSED_COUNT,
	MAX_CALENDAR_TIME_ZONE_CHARS,
	nextCalendarSlotAfter,
} from "./calendar-schedule.ts";

export const MIN_ROUTINE_INTERVAL_MS = 10_000;
export const MAX_ROUTINE_ID_CHARS = 128;
export const MAX_ROUTINE_COMMAND_ID_CHARS = 64;
export const MAX_ROUTINE_PROMPT_CHARS = 8_000;
export const MAX_ROUTINE_OCCURRENCES = 256;
export const MAX_ROUTINE_MANUAL_TOMBSTONES = 2_048;
export const MAX_ROUTINE_SUMMARY_CHARS = 1_000;
export const MAX_ROUTINE_INSTANT_MS = 8_640_000_000_000_000;
export const MAX_ROUTINE_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$";
/** Shortest start window: timer and claim latency must never close a window by themselves. */
export const MIN_ROUTINE_START_WINDOW_MS = 60_000;
export const MAX_ROUTINE_LATENESS_MS = 366 * 86_400_000;

const intervalSchema = Type.Object(
	{
		kind: Type.Literal("interval"),
		intervalMs: Type.Integer({ minimum: MIN_ROUTINE_INTERVAL_MS, maximum: MAX_ROUTINE_INSTANT_MS }),
	},
	{ additionalProperties: false },
);
const onceSchema = Type.Object(
	{
		kind: Type.Literal("once"),
		/** Absolute UTC instant in epoch milliseconds. */
		at: Type.Integer({ minimum: 0, maximum: MAX_ROUTINE_INSTANT_MS }),
		notAfter: Type.Optional(
			Type.Integer({
				minimum: 0,
				maximum: MAX_ROUTINE_INSTANT_MS,
				description:
					"Optional UTC epoch-ms start deadline, at least one minute after at. If the routine has not started by then it is cancelled and reported instead of run late.",
			}),
		),
	},
	{ additionalProperties: false },
);

const calendarSchema = Type.Object(
	{
		kind: Type.Literal("calendar"),
		cron: Type.String({
			minLength: 9,
			maxLength: MAX_CALENDAR_CRON_CHARS,
			description:
				"Five fields: minute hour day-of-month month day-of-week (0 or 7 is Sunday). Numbers, *, ranges a-b, steps /n and comma lists only. When both day fields are restricted, either may match.",
		}),
		timeZone: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: MAX_CALENDAR_TIME_ZONE_CHARS,
				description: "IANA time zone such as Europe/Lisbon. Omit to use this host's zone.",
			}),
		),
		maxLatenessMs: Type.Optional(
			Type.Integer({
				minimum: MIN_ROUTINE_START_WINDOW_MS,
				maximum: MAX_ROUTINE_LATENESS_MS,
				description:
					"Optional bound on how late a slot may start. A slot that cannot start within it is skipped and counted as missed by the next run.",
			}),
		),
	},
	{ additionalProperties: false },
);

/** Only schedules the host can execute are accepted; calendar rules are validated by the calendar owner. */
export const routineScheduleInputSchema = Type.Union([intervalSchema, onceSchema, calendarSchema]);

/** Model-facing authoring input. Recipient and compiled authority are host-owned and absent from this schema. */
export const routineAuthoringSchema = Type.Object(
	{
		routineId: Type.String({ minLength: 1, maxLength: MAX_ROUTINE_ID_CHARS, pattern: MAX_ROUTINE_ID_PATTERN }),
		prompt: Type.String({ minLength: 1, maxLength: MAX_ROUTINE_PROMPT_CHARS }),
		schedule: routineScheduleInputSchema,
	},
	{ additionalProperties: false },
);

export type RoutineScheduleInput = Static<typeof routineScheduleInputSchema>;
export type RoutineAuthoringInput = Static<typeof routineAuthoringSchema>;
export type RoutineCursor =
	| { readonly kind: "interval"; readonly nextIndex: number }
	| { readonly kind: "once"; readonly consumed: boolean }
	/**
	 * Next slot computed when the previous one was claimed; null once no slot is representable.
	 * `skipped` counts slots passed over for lateness since the last run, carried into its missed count.
	 */
	| { readonly kind: "calendar"; readonly nextAt: number | null; readonly skipped?: number };

export type PersistentRoutineTarget =
	| { readonly kind: "bot"; readonly agentId: string }
	| { readonly kind: "team"; readonly teamId: string }
	| { readonly kind: "session"; readonly parentSessionId: string };

/** Session-only execution snapshot created by the host after authority and knowledge admission. */
export interface RoutineExecutionSnapshot {
	readonly parentSessionId: string;
	/** Opaque, bounded parent-branch anchor captured with the routine; never refreshed from a later branch. */
	readonly parentBranchAnchor: string;
	readonly profileId?: string;
	readonly savedIntent: WorkerSavedIntent;
}

/** Explicit schedule. The cursor is mutable independently of immutable routine revision. */
export type RoutineSchedule =
	| { readonly kind: "interval"; readonly intervalMs: number; readonly anchorAt: number }
	| { readonly kind: "once"; readonly at: number; readonly notAfter?: number }
	/** Slots strictly after anchorAt (the authoring instant) in the stored zone. */
	| {
			readonly kind: "calendar";
			readonly cron: string;
			readonly timeZone: string;
			readonly anchorAt: number;
			readonly maxLatenessMs?: number;
	  };

export interface PersistentRoutineDefinition {
	readonly routineId: string;
	readonly incarnationId: string;
	readonly revision: number;
	readonly target: PersistentRoutineTarget;
	readonly prompt: string;
	readonly schedule: RoutineSchedule;
	readonly enabled: boolean;
	readonly executionSnapshot?: RoutineExecutionSnapshot;
	readonly createdAt: string;
	readonly updatedAt: string;
}

/** Store input is host-authored. Tool callers provide RoutineAuthoringInput, never a target or snapshot. */
export interface UpsertPersistentRoutineInput {
	readonly routineId: string;
	readonly target: PersistentRoutineTarget;
	readonly prompt: string;
	readonly schedule: RoutineScheduleInput;
	readonly enabled?: boolean;
	readonly executionSnapshot?: RoutineExecutionSnapshot;
	readonly expectedRevision?: number;
	readonly createOnly?: boolean;
	readonly nowMs?: number;
}

export type RoutineOccurrencePhase = "pending" | "claimed" | "dispatching" | "running" | "uncertain" | "terminal";
export type RoutineOccurrenceTrigger =
	| { readonly kind: "schedule"; readonly scheduledAt: number; readonly missedCount: number }
	| { readonly kind: "manual"; readonly commandId: string; readonly requestedAt: number };
export type RoutineTerminalOutcome = "succeeded" | "failed" | "cancelled" | "uncertain";

export interface RoutineResult {
	readonly outcome: RoutineTerminalOutcome;
	readonly summary: string;
	readonly digest: string;
	readonly delivery: "pending" | "acknowledged";
	readonly recipient: string;
	readonly deliveryMarker?: string;
}

export interface RoutineOccurrence {
	readonly occurrenceId: string;
	readonly routineId: string;
	readonly routineRevision: number;
	readonly definition: PersistentRoutineDefinition;
	readonly parentOrigin: WorkerSavedIntent["receiptOrigin"];
	readonly target: PersistentRoutineTarget;
	readonly trigger: RoutineOccurrenceTrigger;
	readonly phase: RoutineOccurrencePhase;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly claim?: { readonly token: string; readonly owner: string; readonly leaseUntil: number };
	/** Native idempotency key; persisted before handing off to an executor. */
	readonly dispatchKey?: string;
	/** Exact native execution identity; needed to reconcile a terminal without polling output. */
	readonly executionRef?: { readonly taskId: string; readonly attemptId: string };
	readonly result?: RoutineResult;
	/** Preserve the original uncertain result and its independent delivery receipt after exact resolution. */
	readonly priorUncertaintyResult?: RoutineResult;
	readonly uncertainty?: string;
}

export interface RoutineDelivery {
	readonly occurrence: RoutineOccurrence;
	readonly result: RoutineResult;
}

export interface RoutineDefinitionView extends PersistentRoutineDefinition {
	readonly cursor: RoutineCursor;
	readonly nextRunAt: number;
	readonly lastRunAt?: number;
	readonly lastStatus?: "queued" | "running" | "succeeded" | "failed" | "uncertain";
	readonly lastSummary?: string;
}

export interface RoutineOccurrenceClaimInput {
	readonly nowMs: number;
	readonly owner: string;
	readonly leaseMs: number;
	readonly limit: number;
	readonly parentSessionId?: string;
	readonly receiptOrigin?: WorkerSavedIntent["receiptOrigin"];
	readonly eligibleRoutineIds?: readonly string[];
	readonly eligibleOccurrenceIds?: readonly string[];
	readonly routineId?: string;
}

export interface RoutineOccurrenceListFilter {
	readonly parentSessionId?: string;
	readonly routineId?: string;
	readonly phases?: readonly RoutineOccurrencePhase[];
	readonly limit?: number;
}

export function parseRoutineAuthoringInput(value: unknown): RoutineAuthoringInput {
	if (!isPlainRecord(value) || !hasOnlyKeys(value, ["routineId", "prompt", "schedule"]))
		throw new TypeError("Routine authoring input is invalid.");
	if (typeof value.routineId !== "string" || !isRoutineId(value.routineId))
		throw new TypeError("Routine id is invalid.");
	if (
		typeof value.prompt !== "string" ||
		value.prompt.trim().length === 0 ||
		value.prompt.length > MAX_ROUTINE_PROMPT_CHARS
	)
		throw new TypeError("Routine prompt is invalid.");
	const schedule = parseRoutineScheduleInput(value.schedule);
	return { routineId: value.routineId, prompt: value.prompt.trim(), schedule };
}

export function parseRoutineScheduleInput(value: unknown): RoutineScheduleInput {
	if (!isPlainRecord(value)) throw new TypeError("Routine schedule is invalid.");
	if (
		value.kind === "interval" &&
		hasOnlyKeys(value, ["kind", "intervalMs"]) &&
		Number.isSafeInteger(value.intervalMs) &&
		(value.intervalMs as number) >= MIN_ROUTINE_INTERVAL_MS &&
		(value.intervalMs as number) <= MAX_ROUTINE_INSTANT_MS
	)
		return { kind: "interval", intervalMs: value.intervalMs as number };
	if (
		value.kind === "once" &&
		hasOnlyKeys(value, ["kind", "at", "notAfter"]) &&
		validInstant(value.at) &&
		(value.notAfter === undefined ||
			(validInstant(value.notAfter) && value.notAfter >= value.at + MIN_ROUTINE_START_WINDOW_MS))
	)
		return { kind: "once", at: value.at, ...(value.notAfter === undefined ? {} : { notAfter: value.notAfter }) };
	if (value.kind === "calendar" && hasOnlyKeys(value, ["kind", "cron", "timeZone", "maxLatenessMs"])) {
		const cron = canonicalCalendarCron(value.cron);
		if (
			value.maxLatenessMs !== undefined &&
			(!Number.isSafeInteger(value.maxLatenessMs) ||
				(value.maxLatenessMs as number) < MIN_ROUTINE_START_WINDOW_MS ||
				(value.maxLatenessMs as number) > MAX_ROUTINE_LATENESS_MS)
		)
			throw new TypeError("Calendar lateness bound must be between one minute and 366 days.");
		return {
			kind: "calendar",
			cron,
			...(value.timeZone === undefined ? {} : { timeZone: canonicalCalendarTimeZone(value.timeZone) }),
			...(value.maxLatenessMs === undefined ? {} : { maxLatenessMs: value.maxLatenessMs as number }),
		};
	}
	throw new TypeError("Routine schedule must be an executable interval, one-time UTC instant or calendar rule.");
}

/** Authored form of a stored schedule, without host-owned anchors. */
export function routineScheduleInputOf(schedule: RoutineSchedule): RoutineScheduleInput {
	switch (schedule.kind) {
		case "interval":
			return { kind: "interval", intervalMs: schedule.intervalMs };
		case "once":
			return {
				kind: "once",
				at: schedule.at,
				...(schedule.notAfter === undefined ? {} : { notAfter: schedule.notAfter }),
			};
		case "calendar":
			return {
				kind: "calendar",
				cron: schedule.cron,
				timeZone: schedule.timeZone,
				...(schedule.maxLatenessMs === undefined ? {} : { maxLatenessMs: schedule.maxLatenessMs }),
			};
	}
}

/** Fields that place slots. Start windows are excluded: changing one must neither replay nor move a slot. */
export function routineSlotRule(schedule: RoutineScheduleInput): RoutineScheduleInput {
	switch (schedule.kind) {
		case "interval":
			return { kind: "interval", intervalMs: schedule.intervalMs };
		case "once":
			return { kind: "once", at: schedule.at };
		case "calendar":
			return {
				kind: "calendar",
				cron: schedule.cron,
				...(schedule.timeZone === undefined ? {} : { timeZone: schedule.timeZone }),
			};
	}
}

/** Latest instant a scheduled occurrence may start; undefined when its schedule sets no window. */
export function routineStartDeadline(schedule: RoutineSchedule, scheduledAt: number): number | undefined {
	if (schedule.kind === "once") return schedule.notAfter;
	if (schedule.kind === "calendar" && schedule.maxLatenessMs !== undefined)
		return scheduledAt + schedule.maxLatenessMs;
	return undefined;
}

/** Cursor of a newly authored or changed schedule; a calendar rule with no slot in the search horizon gets null. */
export function initialRoutineCursor(schedule: RoutineSchedule): RoutineCursor {
	switch (schedule.kind) {
		case "interval":
			return { kind: "interval", nextIndex: 1 };
		case "once":
			return { kind: "once", consumed: false };
		case "calendar":
			return { kind: "calendar", nextAt: nextCalendarSlotAfter(schedule, schedule.anchorAt) ?? null };
	}
}

export function parseRoutineExecutionSnapshot(value: unknown): RoutineExecutionSnapshot {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, ["parentSessionId", "parentBranchAnchor", "profileId", "savedIntent"])
	)
		throw new TypeError("Routine execution snapshot is invalid.");
	const parentSessionId = boundedString(value.parentSessionId, 200, "parent session id");
	const parentBranchAnchor = boundedString(value.parentBranchAnchor, 512, "parent branch anchor");
	const profileId = value.profileId === undefined ? undefined : boundedString(value.profileId, 256, "profile id");
	const savedIntent = parseWorkerSavedIntent(value.savedIntent);
	if (
		savedIntent.receiptOrigin.sessionId !== parentSessionId ||
		savedIntent.receiptOrigin.leafId !== parentBranchAnchor
	)
		throw new TypeError("Routine execution snapshot does not match its parent session.");
	return { parentSessionId, parentBranchAnchor, ...(profileId ? { profileId } : {}), savedIntent };
}

export function parseRoutineDefinition(value: unknown): PersistentRoutineDefinition | undefined {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, [
			"routineId",
			"incarnationId",
			"revision",
			"target",
			"prompt",
			"schedule",
			"enabled",
			"executionSnapshot",
			"createdAt",
			"updatedAt",
		])
	)
		return undefined;
	try {
		if (
			typeof value.routineId !== "string" ||
			!isRoutineId(value.routineId) ||
			typeof value.incarnationId !== "string" ||
			!/^[A-Za-z0-9_-]{16,128}$/u.test(value.incarnationId) ||
			typeof value.revision !== "number" ||
			!Number.isSafeInteger(value.revision) ||
			value.revision < 1 ||
			typeof value.prompt !== "string" ||
			!value.prompt.trim() ||
			value.prompt.length > MAX_ROUTINE_PROMPT_CHARS ||
			value.prompt !== value.prompt.trim() ||
			typeof value.enabled !== "boolean" ||
			!validIsoInstant(value.createdAt) ||
			!validIsoInstant(value.updatedAt) ||
			Date.parse(value.updatedAt) < Date.parse(value.createdAt)
		)
			return undefined;
		const target = parseRoutineTarget(value.target);
		const schedule = parseRoutineSchedule(value.schedule);
		const executionSnapshot =
			value.executionSnapshot === undefined ? undefined : parseRoutineExecutionSnapshot(value.executionSnapshot);
		if ((target.kind === "session") !== (executionSnapshot !== undefined)) return undefined;
		if (target.kind === "session" && executionSnapshot?.parentSessionId !== target.parentSessionId) return undefined;
		return {
			routineId: value.routineId,
			incarnationId: value.incarnationId,
			revision: value.revision,
			target,
			prompt: value.prompt,
			schedule,
			enabled: value.enabled,
			...(executionSnapshot ? { executionSnapshot } : {}),
			createdAt: value.createdAt,
			updatedAt: value.updatedAt,
		};
	} catch {
		return undefined;
	}
}

export function parseRoutineDefinitionView(value: unknown): RoutineDefinitionView | undefined {
	if (!isPlainRecord(value)) return undefined;
	const { cursor: rawCursor, nextRunAt: rawNextRunAt, lastRunAt, lastStatus, lastSummary, ...rawDefinition } = value;
	const definition = parseRoutineDefinition(rawDefinition);
	if (!definition) return undefined;
	try {
		const cursor = parseRoutineCursor(rawCursor);
		if (definition.schedule.kind === "interval" && cursor.kind === "interval") {
			const lastIndex = Math.floor(
				(MAX_ROUTINE_INSTANT_MS - definition.schedule.anchorAt) / definition.schedule.intervalMs,
			);
			if (cursor.nextIndex > lastIndex + 1) return undefined;
		}
		// Calendar slots are never re-derived here: zone rules may change after a slot was computed.
		if (
			definition.schedule.kind === "calendar" &&
			cursor.kind === "calendar" &&
			cursor.nextAt !== null &&
			cursor.nextAt <= definition.schedule.anchorAt
		)
			return undefined;
		const nextRunAt = nextRoutineAt(definition.schedule, cursor) ?? Number.MAX_SAFE_INTEGER;
		if (
			rawNextRunAt !== nextRunAt ||
			(lastRunAt !== undefined && !validInstant(lastRunAt)) ||
			(lastStatus !== undefined &&
				(typeof lastStatus !== "string" ||
					!["queued", "running", "succeeded", "failed", "uncertain"].includes(lastStatus))) ||
			(lastSummary !== undefined &&
				(typeof lastSummary !== "string" || lastSummary.length > MAX_ROUTINE_SUMMARY_CHARS))
		)
			return undefined;
		return {
			...definition,
			cursor,
			nextRunAt,
			...(lastRunAt === undefined ? {} : { lastRunAt }),
			...(lastStatus === undefined ? {} : { lastStatus: lastStatus as RoutineDefinitionView["lastStatus"] }),
			...(lastSummary === undefined ? {} : { lastSummary }),
		};
	} catch {
		return undefined;
	}
}

export function parseRoutineOccurrence(value: unknown): RoutineOccurrence | undefined {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, [
			"occurrenceId",
			"routineId",
			"routineRevision",
			"definition",
			"parentOrigin",
			"target",
			"trigger",
			"phase",
			"createdAt",
			"updatedAt",
			"claim",
			"dispatchKey",
			"executionRef",
			"result",
			"priorUncertaintyResult",
			"uncertainty",
		])
	)
		return undefined;
	try {
		if (
			typeof value.occurrenceId !== "string" ||
			!value.occurrenceId ||
			value.occurrenceId.length > 256 ||
			typeof value.routineId !== "string" ||
			!isRoutineId(value.routineId) ||
			!Number.isSafeInteger(value.routineRevision) ||
			(value.routineRevision as number) < 1 ||
			!validInstant(value.createdAt) ||
			!validInstant(value.updatedAt) ||
			value.updatedAt < value.createdAt
		)
			return undefined;
		const definition = parseRoutineDefinition(value.definition);
		const target = parseRoutineTarget(value.target);
		if (
			!definition ||
			definition.routineId !== value.routineId ||
			definition.revision !== value.routineRevision ||
			!isDeepStrictEqual(definition.target, target) ||
			value.createdAt < Date.parse(definition.updatedAt)
		)
			return undefined;
		const phases: readonly RoutineOccurrencePhase[] = [
			"pending",
			"claimed",
			"dispatching",
			"running",
			"uncertain",
			"terminal",
		];
		if (typeof value.phase !== "string" || !phases.includes(value.phase as RoutineOccurrencePhase)) return undefined;
		let trigger: RoutineOccurrenceTrigger;
		if (
			isPlainRecord(value.trigger) &&
			value.trigger.kind === "schedule" &&
			hasOnlyKeys(value.trigger, ["kind", "scheduledAt", "missedCount"]) &&
			validInstant(value.trigger.scheduledAt) &&
			value.trigger.scheduledAt <= value.createdAt &&
			Number.isSafeInteger(value.trigger.missedCount) &&
			(value.trigger.missedCount as number) >= 0
		) {
			trigger = {
				kind: "schedule",
				scheduledAt: value.trigger.scheduledAt,
				missedCount: value.trigger.missedCount as number,
			};
			if (definition.schedule.kind === "once") {
				if (trigger.scheduledAt !== definition.schedule.at || trigger.missedCount !== 0) return undefined;
			} else if (definition.schedule.kind === "calendar") {
				if (trigger.scheduledAt <= definition.schedule.anchorAt || trigger.missedCount > MAX_CALENDAR_MISSED_COUNT)
					return undefined;
			} else {
				const index = (trigger.scheduledAt - definition.schedule.anchorAt) / definition.schedule.intervalMs;
				if (!Number.isSafeInteger(index) || index < 1 || trigger.missedCount >= index) return undefined;
			}
		} else if (
			isPlainRecord(value.trigger) &&
			value.trigger.kind === "manual" &&
			hasOnlyKeys(value.trigger, ["kind", "commandId", "requestedAt"]) &&
			validInstant(value.trigger.requestedAt) &&
			value.trigger.requestedAt === value.createdAt
		) {
			trigger = {
				kind: "manual",
				commandId: boundedString(value.trigger.commandId, MAX_ROUTINE_COMMAND_ID_CHARS, "command id"),
				requestedAt: value.trigger.requestedAt,
			};
		} else return undefined;
		if (value.occurrenceId !== routineOccurrenceId(definition, trigger)) return undefined;
		const parentOrigin = workerReceiptOriginFromValue(value.parentOrigin);
		if (
			target.kind === "session" &&
			(target.parentSessionId !== parentOrigin.sessionId ||
				!isDeepStrictEqual(definition.executionSnapshot?.savedIntent.receiptOrigin, parentOrigin))
		)
			return undefined;
		let claim: RoutineOccurrence["claim"];
		if (value.claim !== undefined) {
			if (
				!isPlainRecord(value.claim) ||
				!hasOnlyKeys(value.claim, ["token", "owner", "leaseUntil"]) ||
				!validInstant(value.claim.leaseUntil) ||
				value.claim.leaseUntil <= value.createdAt
			)
				return undefined;
			claim = {
				token: boundedString(value.claim.token, 128, "claim token"),
				owner: boundedString(value.claim.owner, 256, "claim owner"),
				leaseUntil: value.claim.leaseUntil,
			};
		}
		const dispatchKey =
			value.dispatchKey === undefined ? undefined : boundedString(value.dispatchKey, 512, "dispatch key");
		if (dispatchKey !== undefined && dispatchKey !== `routine:${value.occurrenceId}`) return undefined;
		let executionRef: RoutineOccurrence["executionRef"];
		if (value.executionRef !== undefined) {
			if (!isPlainRecord(value.executionRef) || !hasOnlyKeys(value.executionRef, ["taskId", "attemptId"]))
				return undefined;
			executionRef = {
				taskId: boundedString(value.executionRef.taskId, 200, "task id"),
				attemptId: boundedString(value.executionRef.attemptId, 200, "attempt id"),
			};
		}
		const result = value.result === undefined ? undefined : parseRoutineResult(value.result, parentOrigin.sessionId);
		const priorUncertaintyResult =
			value.priorUncertaintyResult === undefined
				? undefined
				: parseRoutineResult(value.priorUncertaintyResult, parentOrigin.sessionId);
		const uncertainty =
			value.uncertainty === undefined
				? undefined
				: boundedString(value.uncertainty, MAX_ROUTINE_SUMMARY_CHARS, "uncertainty");
		const beforeDispatch = value.phase === "pending" || value.phase === "claimed";
		const afterDispatch = value.phase === "dispatching" || value.phase === "running" || value.phase === "uncertain";
		if (
			beforeDispatch &&
			(dispatchKey !== undefined || executionRef !== undefined || result !== undefined || uncertainty !== undefined)
		)
			return undefined;
		if (value.phase === "pending" && claim !== undefined) return undefined;
		if ((value.phase === "claimed" || afterDispatch || dispatchKey !== undefined) && !claim) return undefined;
		if (value.phase === "claimed" && claim!.leaseUntil <= value.updatedAt) return undefined;
		if (afterDispatch && dispatchKey === undefined) return undefined;
		if (executionRef && (target.kind !== "session" || value.phase === "dispatching")) return undefined;
		if (value.phase === "running" && target.kind === "session" && !executionRef) return undefined;
		if ((value.phase === "terminal" || value.phase === "uncertain") !== (result !== undefined)) return undefined;
		if (result && (value.phase === "uncertain") !== (result.outcome === "uncertain")) return undefined;
		if ((value.phase === "uncertain") !== (uncertainty !== undefined)) return undefined;
		if (result && !dispatchKey && (result.outcome !== "cancelled" || executionRef)) return undefined;
		if (
			priorUncertaintyResult &&
			(value.phase !== "terminal" ||
				target.kind !== "session" ||
				!executionRef ||
				!result ||
				priorUncertaintyResult.outcome !== "uncertain" ||
				result.outcome === "uncertain" ||
				priorUncertaintyResult.digest === result.digest)
		)
			return undefined;
		return {
			occurrenceId: value.occurrenceId,
			routineId: value.routineId,
			routineRevision: value.routineRevision as number,
			definition,
			parentOrigin,
			target,
			trigger,
			phase: value.phase as RoutineOccurrencePhase,
			createdAt: value.createdAt,
			updatedAt: value.updatedAt,
			...(claim ? { claim } : {}),
			...(dispatchKey === undefined ? {} : { dispatchKey }),
			...(executionRef ? { executionRef } : {}),
			...(result ? { result } : {}),
			...(priorUncertaintyResult ? { priorUncertaintyResult } : {}),
			...(uncertainty === undefined ? {} : { uncertainty }),
		};
	} catch {
		return undefined;
	}
}

/** Both retained result versions obey the same payload identity and delivery contract. */
function parseRoutineResult(value: unknown, parentSessionId: string): RoutineResult {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, ["outcome", "summary", "digest", "delivery", "recipient", "deliveryMarker"]) ||
		typeof value.outcome !== "string" ||
		!["succeeded", "failed", "cancelled", "uncertain"].includes(value.outcome) ||
		typeof value.summary !== "string" ||
		!value.summary.trim() ||
		value.summary.length > MAX_ROUTINE_SUMMARY_CHARS ||
		typeof value.digest !== "string" ||
		!/^[a-f0-9]{64}$/u.test(value.digest) ||
		(value.delivery !== "pending" && value.delivery !== "acknowledged")
	)
		throw new TypeError("Routine result is invalid.");
	const recipient = boundedString(value.recipient, 200, "recipient");
	const outcome = value.outcome as RoutineTerminalOutcome;
	const deliveryMarker =
		value.deliveryMarker === undefined ? undefined : boundedString(value.deliveryMarker, 256, "delivery marker");
	if (
		(value.delivery === "acknowledged") !== (deliveryMarker !== undefined) ||
		recipient !== parentSessionId ||
		value.digest !== routineResultDigest(outcome, value.summary, recipient)
	)
		throw new TypeError("Routine result does not match its parent or delivery receipt.");
	return {
		outcome,
		summary: value.summary,
		digest: value.digest,
		delivery: value.delivery,
		recipient,
		...(deliveryMarker === undefined ? {} : { deliveryMarker }),
	};
}

/** Read migration for pre-contract bot/team interval records in `routineSchedules` or the old `routines` key. */
export function parseLegacyRoutineDefinition(value: unknown): PersistentRoutineDefinition | undefined {
	if (!isPlainRecord(value) || value.schedule !== undefined) return parseRoutineDefinition(value);
	if (
		typeof value.intervalMs !== "number" ||
		!Number.isSafeInteger(value.intervalMs) ||
		value.intervalMs < MIN_ROUTINE_INTERVAL_MS ||
		!validInstant(value.nextRunAt) ||
		!validIsoInstant(value.createdAt) ||
		!validIsoInstant(value.updatedAt)
	)
		return undefined;
	const anchorAt = value.nextRunAt - value.intervalMs;
	if (!validInstant(anchorAt)) return undefined;
	const target = value.target;
	if (!isPlainRecord(target) || (target.kind !== "bot" && target.kind !== "team")) return undefined;
	return parseRoutineDefinition({
		routineId: value.routineId,
		incarnationId: `legacy-${createHash("sha256")
			.update(JSON.stringify([value.routineId, value.createdAt]))
			.digest("hex")}`,
		revision: 1,
		target,
		prompt: typeof value.prompt === "string" ? value.prompt.trim() : value.prompt,
		schedule: { kind: "interval", intervalMs: value.intervalMs, anchorAt },
		enabled: value.enabled === undefined ? true : value.enabled,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	});
}

export function parseRoutineSchedule(value: unknown): RoutineSchedule {
	if (!isPlainRecord(value)) throw new TypeError("Routine schedule is invalid.");
	if (value.kind === "calendar") {
		// Stored zones are only checked for support: canonical spellings may differ across runtimes.
		if (
			hasOnlyKeys(value, ["kind", "cron", "timeZone", "anchorAt", "maxLatenessMs"]) &&
			typeof value.cron === "string" &&
			canonicalCalendarCron(value.cron) === value.cron &&
			isCalendarTimeZone(value.timeZone) &&
			validInstant(value.anchorAt) &&
			(value.maxLatenessMs === undefined ||
				(Number.isSafeInteger(value.maxLatenessMs) &&
					(value.maxLatenessMs as number) >= MIN_ROUTINE_START_WINDOW_MS &&
					(value.maxLatenessMs as number) <= MAX_ROUTINE_LATENESS_MS))
		)
			return {
				kind: "calendar",
				cron: value.cron,
				timeZone: value.timeZone,
				anchorAt: value.anchorAt,
				...(value.maxLatenessMs === undefined ? {} : { maxLatenessMs: value.maxLatenessMs as number }),
			};
		throw new TypeError("Persisted calendar schedule requires a canonical rule, a supported zone and an anchor.");
	}
	const authored = parseRoutineScheduleInput(
		value.kind === "interval" ? { kind: "interval", intervalMs: value.intervalMs } : value,
	);
	if (authored.kind === "once") return authored;
	if (
		authored.kind === "interval" &&
		hasOnlyKeys(value, ["kind", "intervalMs", "anchorAt"]) &&
		validInstant(value.anchorAt) &&
		validInstant(value.anchorAt + authored.intervalMs)
	)
		return { ...authored, anchorAt: value.anchorAt };
	throw new TypeError("Persisted interval schedule requires a valid anchor and first occurrence.");
}

export function parseRoutineTarget(value: unknown): PersistentRoutineTarget {
	if (!isPlainRecord(value)) throw new TypeError("Routine target is invalid.");
	if (value.kind === "bot" && hasOnlyKeys(value, ["kind", "agentId"]))
		return { kind: "bot", agentId: boundedString(value.agentId, 128, "bot id") };
	if (value.kind === "team" && hasOnlyKeys(value, ["kind", "teamId"]))
		return { kind: "team", teamId: boundedString(value.teamId, 128, "team id") };
	if (value.kind === "session" && hasOnlyKeys(value, ["kind", "parentSessionId"]))
		return { kind: "session", parentSessionId: boundedString(value.parentSessionId, 200, "parent session id") };
	throw new TypeError("Routine target kind is unsupported.");
}

export function isRoutineId(value: string): boolean {
	return value.length > 0 && value.length <= MAX_ROUTINE_ID_CHARS && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(value);
}

export function parseRoutineCursor(value: unknown): RoutineCursor {
	if (!isPlainRecord(value)) throw new TypeError("Routine cursor is invalid.");
	if (
		value.kind === "interval" &&
		hasOnlyKeys(value, ["kind", "nextIndex"]) &&
		Number.isSafeInteger(value.nextIndex) &&
		(value.nextIndex as number) >= 1
	)
		return { kind: "interval", nextIndex: value.nextIndex as number };
	if (value.kind === "once" && hasOnlyKeys(value, ["kind", "consumed"]) && typeof value.consumed === "boolean")
		return { kind: "once", consumed: value.consumed };
	if (
		value.kind === "calendar" &&
		hasOnlyKeys(value, ["kind", "nextAt", "skipped"]) &&
		(value.nextAt === null || validInstant(value.nextAt)) &&
		(value.skipped === undefined ||
			(Number.isSafeInteger(value.skipped) &&
				(value.skipped as number) >= 1 &&
				(value.skipped as number) <= MAX_CALENDAR_MISSED_COUNT))
	)
		return {
			kind: "calendar",
			nextAt: value.nextAt,
			...(value.skipped === undefined ? {} : { skipped: value.skipped as number }),
		};
	throw new TypeError("Routine cursor is invalid.");
}

export function nextRoutineAt(schedule: RoutineSchedule, cursor: RoutineCursor): number | undefined {
	if (schedule.kind === "once") {
		if (cursor.kind !== "once") throw new TypeError("Routine cursor does not match its schedule.");
		return cursor.consumed ? undefined : schedule.at;
	}
	if (schedule.kind === "calendar") {
		if (cursor.kind !== "calendar") throw new TypeError("Routine cursor does not match its schedule.");
		return cursor.nextAt ?? undefined;
	}
	if (cursor.kind !== "interval") throw new TypeError("Routine cursor does not match its schedule.");
	const nextAt = schedule.anchorAt + schedule.intervalMs * cursor.nextIndex;
	return Number.isSafeInteger(nextAt) && nextAt <= MAX_ROUTINE_INSTANT_MS ? nextAt : undefined;
}

function boundedString(value: unknown, maximum: number, label: string): string {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.length > maximum ||
		value.trim() !== value ||
		value.includes("\0")
	)
		throw new TypeError(`Routine ${label} is invalid.`);
	return value;
}

function validInstant(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_ROUTINE_INSTANT_MS;
}

function validIsoInstant(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const instant = Date.parse(value);
	return validInstant(instant) && new Date(instant).toISOString() === value;
}

export function routineResultDigest(outcome: RoutineTerminalOutcome, summary: string, recipient: string): string {
	return createHash("sha256").update(`${outcome}\0${summary}\0${recipient}`).digest("hex");
}

export function routineOccurrenceId(
	definition: Pick<PersistentRoutineDefinition, "incarnationId" | "revision">,
	trigger: RoutineOccurrenceTrigger,
): string {
	const suffix =
		trigger.kind === "schedule"
			? String(trigger.scheduledAt)
			: `manual:${createHash("sha256").update(trigger.commandId).digest("hex")}`;
	return `${definition.incarnationId}:${definition.revision}:${suffix}`;
}
