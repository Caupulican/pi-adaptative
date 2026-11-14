/**
 * The record a routine leaves when it is retired (its one run done, its end time reached, its stated end met, the
 * owner's delete, or the point of its session it was saved at lost for good), so a session that armed it can still read
 * what it was and how it ended instead of finding it absent. The record is bounded, keeps the first words of the last
 * result only, and never moves any routine's revision. The retire request a session hands the store is defined here too.
 */
import type { WorkerSavedIntent } from "../delegation/worker-saved-intent.ts";
import { hasOnlyKeys, isPlainRecord } from "../util/value-guards.ts";
import {
	isRoutineId,
	MAX_ROUTINE_INSTANT_MS,
	parseRoutineSchedule,
	ROUTINE_LAST_STATUSES,
	type RoutineDefinitionView,
	type RoutineSchedule,
} from "./routine-contract.ts";
import type { RoutineOriginLoss } from "./routine-origin-reach.ts";
import { MAX_RESULT_PREVIEW_CHARS, resultPreview } from "./routine-parent-input.ts";

/** Retired records one store keeps, shared by every session of the agent directory; the oldest leaves first. */
export const MAX_RETIRED_ROUTINES = 64;
/** Longest saved prompt a retired record keeps: its purpose, not the whole instruction. */
export const MAX_RETIRED_PROMPT_CHARS = 500;
const MAX_RETIRED_ID_CHARS = 200;

/**
 * `origin-lost`: the routine's saved origin can never pass in its session (`routine-origin-reach.ts`), so it could run and
 * report nothing there again.
 */
export const ROUTINE_RETIRED_REASONS = ["spent", "condition", "expired", "deleted", "origin-lost"] as const;
export type RoutineRetiredReason = (typeof ROUTINE_RETIRED_REASONS)[number];

/** What one session asks the store to retire; the store rechecks each routine under its lock. */
export interface RoutineRetireInput {
	readonly nowMs: number;
	readonly owner: string;
	readonly leaseMs: number;
	readonly parentSessionId: string;
	/** The parent anchor a bot or team routine's expiry notice is delivered at; session routines use their own. */
	readonly receiptOrigin: WorkerSavedIntent["receiptOrigin"];
	/** Ended routines, removed once their runs are delivered. */
	readonly routineIds: readonly string[];
	/**
	 * Session routines whose saved origin the session found lost, with why: their undispatched runs are settled with the
	 * loss as their delivery marker, and each is removed with no end notice once its dispatched runs are settled.
	 */
	readonly lostOrigins?: readonly { readonly routineId: string; readonly loss: RoutineOriginLoss }[];
}

export interface RetiredRoutineRecord {
	readonly routineId: string;
	/** The incarnation retired: the record's identity, since an id can be saved again after it. */
	readonly incarnationId: string;
	/** The session that armed it. */
	readonly parentSessionId: string;
	readonly prompt: string;
	readonly schedule: RoutineSchedule;
	readonly lastStatus?: (typeof ROUTINE_LAST_STATUSES)[number];
	readonly lastRunAt?: number;
	/** The first words of the last result, one line; third-party words are possible, so readers fence it. */
	readonly lastSummary?: string;
	readonly reason: RoutineRetiredReason;
	readonly retiredAt: number;
}

function boundedPrompt(prompt: string): string {
	return prompt.length > MAX_RETIRED_PROMPT_CHARS ? `${prompt.slice(0, MAX_RETIRED_PROMPT_CHARS - 1)}…` : prompt;
}

/** The record of a session routine at the moment the store removes it. */
export function retiredRoutineRecord(
	routine: RoutineDefinitionView,
	parentSessionId: string,
	reason: RoutineRetiredReason,
	retiredAt: number,
): RetiredRoutineRecord {
	const lastSummary = routine.lastSummary === undefined ? undefined : resultPreview(routine.lastSummary);
	return {
		routineId: routine.routineId,
		incarnationId: routine.incarnationId,
		parentSessionId,
		prompt: boundedPrompt(routine.prompt),
		schedule: routine.schedule,
		...(routine.lastStatus === undefined ? {} : { lastStatus: routine.lastStatus }),
		...(routine.lastRunAt === undefined ? {} : { lastRunAt: routine.lastRunAt }),
		...(lastSummary === undefined ? {} : { lastSummary }),
		reason,
		retiredAt,
	};
}

function validInstant(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_ROUTINE_INSTANT_MS;
}

function boundedText(value: unknown, maximum: number): string {
	if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\0"))
		throw new TypeError("Retired routine text is invalid.");
	return value;
}

/** The persisted retired records, oldest first; one invalid or repeated entry rejects the whole list. */
export function parseRetiredRoutines(value: unknown): RetiredRoutineRecord[] {
	if (!Array.isArray(value) || value.length > MAX_RETIRED_ROUTINES)
		throw new TypeError("Retired routine records have an invalid size.");
	const incarnations = new Set<string>();
	return value.map((entry: unknown) => {
		if (
			!isPlainRecord(entry) ||
			!hasOnlyKeys(entry, [
				"routineId",
				"incarnationId",
				"parentSessionId",
				"prompt",
				"schedule",
				"lastStatus",
				"lastRunAt",
				"lastSummary",
				"reason",
				"retiredAt",
			]) ||
			typeof entry.routineId !== "string" ||
			!isRoutineId(entry.routineId) ||
			!validInstant(entry.retiredAt) ||
			(entry.lastRunAt !== undefined && !validInstant(entry.lastRunAt)) ||
			(entry.lastStatus !== undefined &&
				!(ROUTINE_LAST_STATUSES as readonly unknown[]).includes(entry.lastStatus)) ||
			!(ROUTINE_RETIRED_REASONS as readonly unknown[]).includes(entry.reason)
		)
			throw new TypeError("Retired routine record is invalid.");
		const incarnationId = boundedText(entry.incarnationId, MAX_RETIRED_ID_CHARS);
		if (incarnations.has(incarnationId)) throw new TypeError("Retired routine records repeat an incarnation.");
		incarnations.add(incarnationId);
		return {
			routineId: entry.routineId,
			incarnationId,
			parentSessionId: boundedText(entry.parentSessionId, MAX_RETIRED_ID_CHARS),
			prompt: boundedText(entry.prompt, MAX_RETIRED_PROMPT_CHARS),
			schedule: parseRoutineSchedule(entry.schedule),
			...(entry.lastStatus === undefined
				? {}
				: { lastStatus: entry.lastStatus as RetiredRoutineRecord["lastStatus"] }),
			...(entry.lastRunAt === undefined ? {} : { lastRunAt: entry.lastRunAt }),
			...(entry.lastSummary === undefined
				? {}
				: { lastSummary: boundedText(entry.lastSummary, MAX_RESULT_PREVIEW_CHARS) }),
			reason: entry.reason as RoutineRetiredReason,
			retiredAt: entry.retiredAt,
		};
	});
}
