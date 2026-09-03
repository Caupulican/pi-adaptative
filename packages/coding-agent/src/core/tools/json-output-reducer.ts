/**
 * JSON reducer for command and script output that is one JSON document (`gh api`, `curl`, `aws`,
 * `kubectl -o json`, a python `json.dumps`). Measured on live sessions such results are lists of
 * near-identical records where the model reads the shape and a few samples, then filters. The
 * reduction keeps the shape and the anomalies:
 *
 * - arrays longer than the sample window keep their first items and last item, every item that
 *   carries an error or a non-ok status, and one marker string `[… N more items]` where the cut is;
 * - long strings are clipped with their length (`… [+N chars]`);
 * - objects, numbers, booleans and short strings are untouched, so keys and values stay searchable.
 *
 * Indentation follows the original (pretty stays pretty, compact stays compact). The raw document is
 * persisted by the caller, so an omitted item is one read away.
 */
import type { CommandFamilyClassification } from "./command-family.ts";
import type { OutputReducer, OutputReductionLevel, OutputReductionRequest } from "./output-reduction.ts";

/** Below this size a document is cheaper to send than to describe. */
const MIN_JSON_BYTES = 2 * 1024;
const ARRAY_HEAD: Record<OutputReductionLevel, number> = { standard: 3, compact: 2 };
const ARRAY_WINDOW: Record<OutputReductionLevel, number> = { standard: 6, compact: 4 };
const MAX_ANOMALIES_PER_ARRAY = 20;
const MAX_STRING_CHARS: Record<OutputReductionLevel, number> = { standard: 240, compact: 120 };
const CLIPPED_STRING_HEAD = 120;

const ANOMALY_KEY_RE = /^(?:error|errors|err|exception|exceptions|failure|failures|failed|warning|warnings|stderr)$/iu;
const STATUS_KEY_RE = /^(?:status|state|result|conclusion|outcome|level|severity)$/iu;
const OK_STATUS = new Set([
	"ok",
	"success",
	"succeeded",
	"successful",
	"passed",
	"pass",
	"completed",
	"complete",
	"done",
	"active",
	"running",
	"open",
	"closed",
	"merged",
	"info",
	"debug",
	"200",
	"201",
	"204",
]);

/** An item the model must not lose: it carries an error, or a status that is not a plain success. */
export function isAnomalousItem(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (ANOMALY_KEY_RE.test(key)) {
			if (entry === null || entry === undefined || entry === false || entry === 0 || entry === "") continue;
			if (Array.isArray(entry) && entry.length === 0) continue;
			return true;
		}
		if (STATUS_KEY_RE.test(key)) {
			if (typeof entry === "boolean") {
				if (!entry) return true;
				continue;
			}
			if (typeof entry === "number") {
				if (key.toLowerCase() === "status" && (entry < 200 || entry >= 400)) return true;
				continue;
			}
			if (typeof entry === "string" && !OK_STATUS.has(entry.toLowerCase())) return true;
		}
	}
	return false;
}

interface Walk {
	omittedItems: number;
	clippedStrings: number;
}

function reduceValue(value: unknown, level: OutputReductionLevel, walk: Walk): unknown {
	if (typeof value === "string") {
		if (value.length <= MAX_STRING_CHARS[level]) return value;
		walk.clippedStrings++;
		return `${value.slice(0, CLIPPED_STRING_HEAD)}… [+${value.length - CLIPPED_STRING_HEAD} chars]`;
	}
	if (Array.isArray(value)) {
		if (value.length <= ARRAY_WINDOW[level]) return value.map((item) => reduceValue(item, level, walk));
		const head = ARRAY_HEAD[level];
		const kept: unknown[] = [];
		for (let index = 0; index < head; index++) kept.push(reduceValue(value[index], level, walk));
		let anomalies = 0;
		let omitted = 0;
		let markerAt = kept.length;
		for (let index = head; index < value.length - 1; index++) {
			const item = value[index];
			if (anomalies < MAX_ANOMALIES_PER_ARRAY && isAnomalousItem(item)) {
				kept.push(reduceValue(item, level, walk));
				anomalies++;
				continue;
			}
			omitted++;
		}
		// The marker sits where the first omitted item was; kept anomalies follow it in order.
		kept.splice(markerAt, 0, `[… ${omitted} more items]`);
		markerAt = -1;
		kept.push(reduceValue(value[value.length - 1], level, walk));
		walk.omittedItems += omitted;
		return kept;
	}
	if (typeof value === "object" && value !== null) {
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
			out[key] = reduceValue(entry, level, walk);
		}
		return out;
	}
	return value;
}

export interface JsonReduction {
	text: string;
	omittedLines: number;
	omittedItems: number;
	clippedStrings: number;
}

/** Parse the text as one JSON document and reduce it; undefined when it is not JSON or too small. */
export function reduceJsonOutput(text: string, level: OutputReductionLevel = "standard"): JsonReduction | undefined {
	const trimmed = text.trim();
	if (trimmed.length < MIN_JSON_BYTES) return undefined;
	const first = trimmed[0];
	if (first !== "{" && first !== "[") return undefined;
	let document: unknown;
	try {
		document = JSON.parse(trimmed);
	} catch {
		return undefined;
	}
	const walk: Walk = { omittedItems: 0, clippedStrings: 0 };
	const reduced = reduceValue(document, level, walk);
	if (walk.omittedItems === 0 && walk.clippedStrings === 0) return undefined;
	const pretty = trimmed.includes("\n");
	const rendered = pretty ? JSON.stringify(reduced, null, 2) : JSON.stringify(reduced);
	const out = text.endsWith("\n") ? `${rendered}\n` : rendered;
	const inputLines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
	const outputLines = out.split("\n").length - (out.endsWith("\n") ? 1 : 0);
	return {
		text: out,
		omittedLines: Math.max(0, inputLines - outputLines),
		omittedItems: walk.omittedItems,
		clippedStrings: walk.clippedStrings,
	};
}

export const jsonOutputReducer: OutputReducer = {
	name: "json",
	applies(_classification: CommandFamilyClassification, request: OutputReductionRequest): boolean {
		const trimmed = request.text.trimStart();
		return trimmed.startsWith("{") || trimmed.startsWith("[");
	},
	reduce(_classification: CommandFamilyClassification, request: OutputReductionRequest) {
		const reduced = reduceJsonOutput(request.text, request.level);
		return reduced ? { text: reduced.text, omittedLines: reduced.omittedLines } : undefined;
	},
};
