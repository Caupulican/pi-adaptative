/**
 * The record a routine leaves when it is retired (its one run done, its end time reached, its stated end met, or the
 * owner's delete), so a session that armed it can still read what it was and how it ended instead of finding it absent.
 * The record is bounded, keeps the first words of the last result only, and never moves any routine's revision.
 */
import { hasOnlyKeys, isPlainRecord } from "../util/value-guards.ts";
import {
	isRoutineId,
	MAX_ROUTINE_INSTANT_MS,
	parseRoutineSchedule,
	ROUTINE_LAST_STATUSES,
	type RoutineDefinitionView,
	type RoutineSchedule,
} from "./routine-contract.ts";
import { MAX_RESULT_PREVIEW_CHARS, resultPreview } from "./routine-parent-input.ts";

/** Retired records one store keeps, shared by every session of the agent directory; the oldest leaves first. */
export const MAX_RETIRED_ROUTINES = 64;
/** Longest saved prompt a retired record keeps: its purpose, not the whole instruction. */
export const MAX_RETIRED_PROMPT_CHARS = 500;
const MAX_RETIRED_ID_CHARS = 200;

export const ROUTINE_RETIRED_REASONS = ["spent", "condition", "expired", "deleted"] as const;
export type RoutineRetiredReason = (typeof ROUTINE_RETIRED_REASONS)[number];

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
