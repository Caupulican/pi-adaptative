/**
 * JSON reducer for command and script output that is one JSON document (`gh api`, `curl`, `aws`,
 * `kubectl -o json`, a python `json.dumps`). Measured on live sessions such results are lists of
 * near-identical records where the model reads the shape and a few samples, then filters. The
 * reduction keeps anomalies and describes any change of shape:
 *
 * - same-column scalar objects can use one column list and positional JSON rows;
 * - arrays longer than the sample window keep their first items and last item, every item that
 *   carries an error or a non-ok status, and one marker string `[… N more items]` where the cut is;
 * - long strings are clipped with their length (`… [+N chars]`);
 * - objects, numbers, booleans and short strings are untouched, so keys and values stay searchable.
 *
 * Tables use compact JSON. Ordinary samples retain the original indentation style. The raw document is
 * persisted by the caller, so an omitted item is one read away.
 */

import { isRecordObject as isObjectRecord } from "../util/value-guards.ts";
import type { CommandFamilyClassification } from "./command-family.ts";
import { jsonOutputCanReserialize } from "./json-output-lexemes.ts";
import { MAX_BUFFERED_REDUCTION_BYTES, type OutputReducer, type OutputReductionRequest } from "./output-reduction.ts";
import type { OutputReductionLevel } from "./output-reduction-types.ts";

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
	usedTable: boolean;
	pretty: boolean;
}

type JsonScalar = string | number | boolean | null;

interface ColumnarTable {
	$format: "columnar-json";
	columns: string[];
	rows: JsonScalar[][];
	/** Zero-based positions in the original array, included only when rows were omitted. */
	sourceRowIndices?: number[];
	omittedRows?: number;
}

const MAX_TABLE_COLUMNS = 64;
const COLUMNAR_FORMAT = "columnar-json";

function scalar(value: unknown): value is JsonScalar {
	return value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number";
}

function columnsForRows(values: readonly unknown[]): string[] | undefined {
	if (values.length < 2 || !isObjectRecord(values[0])) return undefined;
	const columns = Object.keys(values[0]);
	if (columns.length === 0 || columns.length > MAX_TABLE_COLUMNS) return undefined;
	return values.every(
		(row) =>
			isObjectRecord(row) &&
			Object.keys(row).length === columns.length &&
			columns.every((key) => Object.hasOwn(row, key) && scalar(row[key])),
	)
		? columns
		: undefined;
}

/** Builds only rows that fit the already-selected sample's material budget. */
function tableWithinBudget(
	values: readonly unknown[],
	columns: string[],
	limit: number,
	sample?: { indices: number[]; omitted: number },
): ColumnarTable | undefined {
	const table: ColumnarTable = {
		$format: COLUMNAR_FORMAT,
		columns,
		rows: [],
		...(sample ? { sourceRowIndices: sample.indices, omittedRows: sample.omitted } : {}),
	};
	let remaining = limit - Buffer.byteLength(JSON.stringify(table));
	if (remaining < 0) return undefined;
	for (const value of values) {
		// Schema was checked once against the entire input array, including omitted rows.
		const row = columns.map((key) => (value as Record<string, JsonScalar>)[key]!);
		const minimumBytes = row.reduce<number>((sum, cell) => sum + (typeof cell === "string" ? cell.length + 2 : 1), 0);
		if (minimumBytes > remaining) return undefined;
		remaining -= Buffer.byteLength(JSON.stringify(row)) + (table.rows.length ? 1 : 0);
		if (remaining < 0) return undefined;
		table.rows.push(row);
	}
	return table;
}

function selectArrayIndices(values: readonly unknown[], level: OutputReductionLevel): number[] {
	if (values.length <= ARRAY_WINDOW[level]) return values.map((_item, index) => index);
	const head = ARRAY_HEAD[level];
	const indices = Array.from({ length: head }, (_, index) => index);
	let anomalies = 0;
	for (let index = head; index < values.length - 1 && anomalies < MAX_ANOMALIES_PER_ARRAY; index++) {
		if (isAnomalousItem(values[index])) {
			indices.push(index);
			anomalies++;
		}
	}
	indices.push(values.length - 1);
	return indices;
}

function reduceArray(values: readonly unknown[], level: OutputReductionLevel, walk: Walk): unknown {
	const indices = selectArrayIndices(values, level);
	const omitted = values.length - indices.length;
	const stringsBefore = walk.clippedStrings;
	const rows = indices.map((index) => reduceValue(values[index], level, walk));
	const sample = [...rows];
	if (omitted > 0) sample.splice(ARRAY_HEAD[level], 0, `[… ${omitted} more items]`);
	const columns = columnsForRows(values);
	if (columns) {
		const budget = Buffer.byteLength(JSON.stringify(sample, null, walk.pretty ? 2 : undefined));
		const full = tableWithinBudget(values, columns, budget);
		if (full) {
			walk.usedTable = true;
			walk.clippedStrings = stringsBefore;
			return full;
		}
		if (omitted > 0) {
			const compact = tableWithinBudget(rows, columns, budget - 1, { indices, omitted });
			if (compact) {
				walk.usedTable = true;
				walk.omittedItems += omitted;
				return compact;
			}
		}
	}
	walk.omittedItems += omitted;
	return sample;
}

function reduceValue(value: unknown, level: OutputReductionLevel, walk: Walk): unknown {
	if (typeof value === "string") {
		if (value.length <= MAX_STRING_CHARS[level]) return value;
		walk.clippedStrings++;
		return `${value.slice(0, CLIPPED_STRING_HEAD)}… [+${value.length - CLIPPED_STRING_HEAD} chars]`;
	}
	if (Array.isArray(value)) return reduceArray(value, level, walk);
	if (isObjectRecord(value)) {
		const out: Record<string, unknown> = Object.create(null);
		for (const [key, entry] of Object.entries(value)) out[key] = reduceValue(entry, level, walk);
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

function analyzeJsonOutput(
	text: string,
	level: OutputReductionLevel,
): { reduced: JsonReduction; document: unknown } | undefined {
	if (text.length > MAX_BUFFERED_REDUCTION_BYTES || Buffer.byteLength(text) > MAX_BUFFERED_REDUCTION_BYTES)
		return undefined;
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
	if (!jsonOutputCanReserialize(trimmed)) return undefined;
	const walk: Walk = { omittedItems: 0, clippedStrings: 0, usedTable: false, pretty: trimmed.includes("\n") };
	const reduced = reduceValue(document, level, walk);
	if (!walk.usedTable && walk.omittedItems === 0 && walk.clippedStrings === 0) return undefined;
	const rendered = JSON.stringify(reduced, null, walk.pretty && !walk.usedTable ? 2 : undefined);
	const out = text.endsWith("\n") ? `${rendered}\n` : rendered;
	const inputLines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
	const outputLines = out.split("\n").length - (out.endsWith("\n") ? 1 : 0);
	return {
		document,
		reduced: {
			text: out,
			omittedLines: walk.omittedItems > 0 || walk.clippedStrings > 0 ? Math.max(0, inputLines - outputLines) : 0,
			omittedItems: walk.omittedItems,
			clippedStrings: walk.clippedStrings,
		},
	};
}

/** Parse and reduce one JSON document. Declines unrepresentable or unaffected inputs. */
export function reduceJsonOutput(text: string, level: OutputReductionLevel = "standard"): JsonReduction | undefined {
	return analyzeJsonOutput(text, level)?.reduced;
}

const JQ_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const JQ_KEYWORDS = new Set([
	"and",
	"as",
	"break",
	"catch",
	"def",
	"elif",
	"else",
	"end",
	"false",
	"foreach",
	"if",
	"import",
	"include",
	"label",
	"module",
	"null",
	"or",
	"reduce",
	"then",
	"true",
	"try",
]);
const MAX_PROJECTED_KEYS = 4;

function jqIdentifier(key: string): boolean {
	return key.length <= 64 && JQ_IDENTIFIER.test(key) && !JQ_KEYWORDS.has(key);
}

function projectJqRows(list: readonly unknown[], iterator: string, sample: string): string {
	const first = list[0];
	if (!isObjectRecord(first)) return iterator;
	const keys = Object.keys(first).filter(jqIdentifier);
	const scalarKeys = keys.filter((key) => scalar(first[key]));
	const projected = (scalarKeys.length > 0 ? scalarKeys : keys).slice(0, MAX_PROJECTED_KEYS);
	return projected.length > 0 ? `${iterator} | {${projected.join(",")}}` : sample;
}

/** Use only safe jq identifiers in the quoted recovery command. Other keys use a fixed query. */
export function suggestJqProjection(document: unknown): string {
	if (Array.isArray(document)) return projectJqRows(document, ".[]", ".[:6][]");
	if (isObjectRecord(document)) {
		let unsafeList = false;
		for (const [key, list] of Object.entries(document)) {
			if (!Array.isArray(list) || list.length === 0) continue;
			if (jqIdentifier(key)) return projectJqRows(list, `.${key}[]`, `.${key}[:6][]`);
			unsafeList = true;
		}
		if (unsafeList) return 'first(to_entries[] | select(.value | type == "array")) | .value[:6][]';
		return "keys";
	}
	return ".";
}

export const jsonOutputReducer: OutputReducer = {
	name: "json",
	applies(_classification: CommandFamilyClassification, request: OutputReductionRequest): boolean {
		const trimmed = request.text.trimStart();
		return trimmed.startsWith("{") || trimmed.startsWith("[");
	},
	reduce(_classification: CommandFamilyClassification, request: OutputReductionRequest) {
		const analysis = analyzeJsonOutput(request.text, request.level);
		if (!analysis) return undefined;
		const { document, reduced } = analysis;
		return {
			...reduced,
			recoveryHint: `jq -c '${suggestJqProjection(document)}'`,
		};
	},
};
