import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { type Static, Type } from "typebox";
import type { WorkerSavedIntent } from "../delegation/worker-saved-intent.ts";
import { parseWorkerSavedIntent } from "../delegation/worker-saved-intent.ts";
import { workerReceiptOriginFromValue } from "../orchestration/worker-receipt-origin.ts";
import { hasOnlyKeys, isPlainRecord } from "../util/value-guards.ts";

export const MIN_ROUTINE_INTERVAL_MS = 10_000;
export const MAX_ROUTINE_ID_CHARS = 128;
export const MAX_ROUTINE_COMMAND_ID_CHARS = 64;
export const MAX_ROUTINE_PROMPT_CHARS = 8_000;
export const MAX_ROUTINE_OCCURRENCES = 256;
export const MAX_ROUTINE_MANUAL_TOMBSTONES = 2_048;
export const MAX_ROUTINE_SUMMARY_CHARS = 1_000;
export const MAX_ROUTINE_INSTANT_MS = 8_640_000_000_000_000;
export const MAX_ROUTINE_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$";

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
	},
	{ additionalProperties: false },
);

/** Only schedules the host can execute are accepted. Cron is intentionally absent until a validating calendar adapter exists. */
export const routineScheduleInputSchema = Type.Union([intervalSchema, onceSchema]);

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
	| { readonly kind: "once"; readonly consumed: boolean };

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

/** Explicit elapsed-time schedule. The cursor is mutable independently of immutable routine revision. */
export type RoutineSchedule =
	| { readonly kind: "interval"; readonly intervalMs: number; readonly anchorAt: number }
	| { readonly kind: "once"; readonly at: number };

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
		hasOnlyKeys(value, ["kind", "at"]) &&
		Number.isSafeInteger(value.at) &&
		(value.at as number) >= 0 &&
		(value.at as number) <= MAX_ROUTINE_INSTANT_MS
	)
		return { kind: "once", at: value.at as number };
	throw new TypeError("Routine schedule must be an executable interval or one-time UTC instant.");
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
	const authored = parseRoutineScheduleInput(
		value.kind === "interval" ? { kind: "interval", intervalMs: value.intervalMs } : value,
	);
	if (authored.kind === "once") return authored;
	if (
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
	throw new TypeError("Routine cursor is invalid.");
}

export function nextRoutineAt(schedule: RoutineSchedule, cursor: RoutineCursor): number | undefined {
	if (schedule.kind === "once") {
		if (cursor.kind !== "once") throw new TypeError("Routine cursor does not match its schedule.");
		return cursor.consumed ? undefined : schedule.at;
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
