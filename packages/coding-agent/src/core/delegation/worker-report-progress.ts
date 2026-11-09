/**
 * The `progress` section of a worker report: a routine run's own account of where its task stands, so the routine's
 * next run starts there. One owner of its shape and bounds for every boundary it crosses: the `submit_report` schema,
 * the bounding of submitted arguments, the claim codec and the durable result codec. Only the routine progress record
 * (`core/routines/routine-progress.ts`) reads it, as untrusted data.
 */

import { Type } from "typebox";
import type { WorkerReportProgress } from "../autonomy/contracts.ts";
import { cleanRedactBound } from "../security/secret-text.ts";
import { isPlainRecord } from "../util/value-guards.ts";

/** One plain-words line: where the task stands, or what comes next. */
export const MAX_PROGRESS_LINE_CHARS = 240;
/** One finished item, or one snag's description or remedy. */
export const MAX_PROGRESS_ITEM_CHARS = 160;
/** Finished items one report may name. */
export const MAX_PROGRESS_DONE_ITEMS = 6;
/** A snag reference: the leading hex characters of the snag's signature, as the run's brief showed them. */
export const PROGRESS_SNAG_REF_PATTERN = /^[a-f0-9]{8}$/u;

/** The `submit_report.progress` schema: closed, small; only a routine's run is offered it (`reportsProgress` on its compiled profile). */
export const workerReportProgressSchema = Type.Object(
	{
		position: Type.Optional(Type.String({ description: "Where the task stands now, in one line." })),
		done: Type.Optional(Type.Array(Type.String(), { description: "Items this run finished." })),
		next: Type.Optional(Type.String({ description: "What the next run should do first." })),
		snag: Type.Optional(
			Type.Object(
				{
					what: Type.String({ description: "Where this run stumbled." }),
					remedy: Type.Optional(Type.String({ description: "What got past it, if anything." })),
					ref: Type.Optional(
						Type.String({ description: "The snag reference from your brief, when it is one listed there." }),
					),
				},
				{ additionalProperties: false },
			),
		),
	},
	{
		additionalProperties: false,
		description:
			"Routine runs only: where the task stands, so the next run of the routine starts there instead of from scratch. Omit otherwise.",
	},
);

/** One submitted field as one line, cleaned, redacted and bounded before anything is cut (`cleanRedactBound`). */
function oneLine(value: string | undefined, maxChars: number): string | undefined {
	const line = value === undefined ? "" : cleanRedactBound(value, maxChars);
	return line || undefined;
}

/** Cleans, redacts and bounds what a worker submitted: each field becomes one line, nothing is rejected for length. */
export function boundWorkerReportProgress(value: {
	readonly position?: string;
	readonly done?: readonly string[];
	readonly next?: string;
	readonly snag?: { readonly what: string; readonly remedy?: string; readonly ref?: string };
}): WorkerReportProgress | undefined {
	const position = oneLine(value.position, MAX_PROGRESS_LINE_CHARS);
	const next = oneLine(value.next, MAX_PROGRESS_LINE_CHARS);
	const done: string[] = [];
	for (const item of value.done ?? []) {
		const line = oneLine(item, MAX_PROGRESS_ITEM_CHARS);
		if (line && !done.includes(line)) done.push(line);
	}
	const what = oneLine(value.snag?.what, MAX_PROGRESS_ITEM_CHARS);
	const remedy = oneLine(value.snag?.remedy, MAX_PROGRESS_ITEM_CHARS);
	const ref = value.snag?.ref?.trim().toLowerCase();
	const snag = what
		? { what, ...(remedy ? { remedy } : {}), ...(ref && PROGRESS_SNAG_REF_PATTERN.test(ref) ? { ref } : {}) }
		: undefined;
	const kept = done.slice(-MAX_PROGRESS_DONE_ITEMS);
	if (!position && !next && kept.length === 0 && !snag) return undefined;
	return {
		...(position ? { position } : {}),
		...(kept.length > 0 ? { done: kept } : {}),
		...(next ? { next } : {}),
		...(snag ? { snag } : {}),
	};
}

function hasOnly(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}

function boundedString(value: unknown, maxChars: number, label: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > maxChars)
		throw new TypeError(`${label} must be a non-empty string of at most ${maxChars} characters.`);
	return value;
}

/**
 * The closed codec of a stored or claimed progress section: unknown keys, wrong types and values past their bounds are
 * refused (`TypeError`, labelled), never trimmed, because every writer bounds first.
 */
export function parseWorkerReportProgress(value: unknown, label: string): WorkerReportProgress {
	if (!isPlainRecord(value) || !hasOnly(value, ["position", "done", "next", "snag"]))
		throw new TypeError(`${label} must be a closed object.`);
	let done: string[] | undefined;
	if (value.done !== undefined) {
		if (!Array.isArray(value.done) || value.done.length === 0 || value.done.length > MAX_PROGRESS_DONE_ITEMS)
			throw new TypeError(`${label}.done must hold 1 to ${MAX_PROGRESS_DONE_ITEMS} items.`);
		done = value.done.map((item, index) => boundedString(item, MAX_PROGRESS_ITEM_CHARS, `${label}.done[${index}]`));
	}
	let snag: WorkerReportProgress["snag"];
	if (value.snag !== undefined) {
		const raw = value.snag;
		if (!isPlainRecord(raw) || !hasOnly(raw, ["what", "remedy", "ref"]))
			throw new TypeError(`${label}.snag must be a closed object.`);
		if (raw.ref !== undefined && (typeof raw.ref !== "string" || !PROGRESS_SNAG_REF_PATTERN.test(raw.ref)))
			throw new TypeError(`${label}.snag.ref is invalid.`);
		snag = {
			what: boundedString(raw.what, MAX_PROGRESS_ITEM_CHARS, `${label}.snag.what`),
			...(raw.remedy === undefined
				? {}
				: { remedy: boundedString(raw.remedy, MAX_PROGRESS_ITEM_CHARS, `${label}.snag.remedy`) }),
			...(raw.ref === undefined ? {} : { ref: raw.ref as string }),
		};
	}
	const position =
		value.position === undefined
			? undefined
			: boundedString(value.position, MAX_PROGRESS_LINE_CHARS, `${label}.position`);
	const next =
		value.next === undefined ? undefined : boundedString(value.next, MAX_PROGRESS_LINE_CHARS, `${label}.next`);
	if (position === undefined && next === undefined && done === undefined && snag === undefined)
		throw new TypeError(`${label} is empty.`);
	return {
		...(position === undefined ? {} : { position }),
		...(done === undefined ? {} : { done }),
		...(next === undefined ? {} : { next }),
		...(snag === undefined ? {} : { snag }),
	};
}
