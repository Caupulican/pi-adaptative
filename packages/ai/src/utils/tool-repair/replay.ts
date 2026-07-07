import { Compile } from "typebox/compile";
import type { Tool } from "../../types.ts";
import { analyzeToolArgumentErrors, type ValidationErrorLike } from "./analyzer.ts";
import { TOOL_REPAIR_MODE_NAMES, type ToolRepairFailureModeName, type ToolRepairModeName } from "./registry.ts";
import { repairToolArguments } from "./repairer.ts";

interface ReplayJsonSchemaObject {
	type?: string | string[];
	properties?: Record<string, ReplayJsonSchemaObject>;
	required?: string[];
	items?: ReplayJsonSchemaObject;
	enum?: unknown[];
	additionalProperties?: boolean;
}

export interface ToolRepairCorpusShapeEntry {
	path: string;
	expectedType?: string;
	receivedType: string;
	keyword?: string;
}

export interface ToolRepairCorpusRecord {
	kind: "tool_validation";
	provider?: string;
	modelId?: string;
	tool: string;
	failureModes?: readonly string[];
	shape: readonly ToolRepairCorpusShapeEntry[];
	errorKeywords?: readonly string[];
}

export interface ToolRepairReplayFixture {
	tool: string;
	parameters: Tool["parameters"];
	arguments: Record<string, unknown>;
}

export interface ToolRepairReplayResult {
	record: number;
	provider?: string;
	modelId?: string;
	tool: string;
	classifiedModes: ToolRepairFailureModeName[];
	outcome: "would-repair" | "would-bounce";
	repairsApplied: ToolRepairModeName[];
	fixture: ToolRepairReplayFixture;
}

function splitReplayPath(path: string): string[] {
	return path === "root" ? [] : path.split(".").filter((segment) => segment.length > 0);
}

function schemaForExpectedType(expectedType: string | undefined): ReplayJsonSchemaObject {
	if (!expectedType || expectedType === "unknown") return { type: "null" };
	if (expectedType === "enum") return { enum: ["expected"] };
	const types = expectedType.split("|").filter((type) => type.length > 0);
	return { type: types.length <= 1 ? (types[0] ?? "null") : types };
}

function isNumericSegment(segment: string): boolean {
	return /^\d+$/.test(segment);
}

function ensureObjectProperty(schema: ReplayJsonSchemaObject, key: string): ReplayJsonSchemaObject {
	schema.type = "object";
	schema.properties ??= {};
	schema.required ??= [];
	if (!schema.required.includes(key)) schema.required.push(key);
	schema.properties[key] ??= { type: "object", properties: {}, required: [] };
	return schema.properties[key];
}

function ensureArrayItems(schema: ReplayJsonSchemaObject): ReplayJsonSchemaObject {
	schema.type = "array";
	schema.items ??= { type: "object", properties: {}, required: [] };
	return schema.items;
}

function setSchemaAtPath(root: ReplayJsonSchemaObject, path: readonly string[], leaf: ReplayJsonSchemaObject): void {
	if (path.length === 0) {
		Object.assign(root, leaf);
		return;
	}

	let cursor = root;
	for (let index = 0; index < path.length; index++) {
		const segment = path[index]!;
		const isLast = index === path.length - 1;
		if (isNumericSegment(segment)) {
			cursor = isLast ? Object.assign(ensureArrayItems(cursor), leaf) : ensureArrayItems(cursor);
			continue;
		}
		if (isLast) {
			cursor.type = "object";
			cursor.properties ??= {};
			cursor.required ??= [];
			if (!cursor.required.includes(segment)) cursor.required.push(segment);
			cursor.properties[segment] = leaf;
			continue;
		}
		const next = path[index + 1]!;
		cursor = isNumericSegment(next)
			? ensureArrayItems(ensureObjectProperty(cursor, segment))
			: ensureObjectProperty(cursor, segment);
	}
}

function sampleValue(receivedType: string, expectedType: string | undefined): unknown {
	if (receivedType === "missing") return undefined;
	if (receivedType === "null") return null;
	if (receivedType === "array") return [];
	if (receivedType === "object") return {};
	if (receivedType === "boolean") return true;
	if (receivedType === "number" || receivedType === "integer") return 1;
	if (receivedType === "string") {
		if (expectedType?.includes("number") || expectedType?.includes("integer")) return "not-a-number";
		if (expectedType?.includes("boolean")) return "not-a-boolean";
		if (expectedType?.includes("array") || expectedType?.includes("object")) return "not-json";
		return "not-a-valid-replay-value";
	}
	return {};
}

function ensureArgsObject(target: Record<string, unknown>, key: string): Record<string, unknown> {
	const current = target[key];
	if (typeof current === "object" && current !== null && !Array.isArray(current))
		return current as Record<string, unknown>;
	const next: Record<string, unknown> = {};
	target[key] = next;
	return next;
}

function ensureArgsArray(target: Record<string, unknown>, key: string): unknown[] {
	const current = target[key];
	if (Array.isArray(current)) return current;
	const next: unknown[] = [];
	target[key] = next;
	return next;
}

function setArgumentAtPath(root: Record<string, unknown>, path: readonly string[], value: unknown): void {
	if (value === undefined) return;
	if (path.length === 0) return;
	let objectCursor = root;
	let arrayCursor: unknown[] | undefined;
	for (let index = 0; index < path.length; index++) {
		const segment = path[index]!;
		const isLast = index === path.length - 1;
		if (arrayCursor) {
			const arrayIndex = Number(segment);
			if (!Number.isInteger(arrayIndex)) return;
			if (isLast) {
				arrayCursor[arrayIndex] = value;
				return;
			}
			const next = path[index + 1]!;
			if (isNumericSegment(next)) {
				const existing = arrayCursor[arrayIndex];
				const nextArray = Array.isArray(existing) ? existing : [];
				arrayCursor[arrayIndex] = nextArray;
				arrayCursor = nextArray;
				continue;
			}
			const existing = arrayCursor[arrayIndex];
			const nextObject =
				typeof existing === "object" && existing !== null && !Array.isArray(existing)
					? (existing as Record<string, unknown>)
					: {};
			arrayCursor[arrayIndex] = nextObject;
			objectCursor = nextObject;
			arrayCursor = undefined;
			continue;
		}
		if (isLast) {
			objectCursor[segment] = value;
			return;
		}
		const next = path[index + 1]!;
		if (isNumericSegment(next)) {
			arrayCursor = ensureArgsArray(objectCursor, segment);
		} else {
			objectCursor = ensureArgsObject(objectCursor, segment);
		}
	}
}

function buildFixture(record: ToolRepairCorpusRecord): ToolRepairReplayFixture {
	const parameters: ReplayJsonSchemaObject = { type: "object", properties: {}, required: [] };
	const args: Record<string, unknown> = {};
	for (const shape of record.shape) {
		const path = splitReplayPath(shape.path);
		setSchemaAtPath(parameters, path, schemaForExpectedType(shape.expectedType));
		setArgumentAtPath(args, path, sampleValue(shape.receivedType, shape.expectedType));
	}
	return { tool: record.tool, parameters: parameters as Tool["parameters"], arguments: args };
}

function validationErrorsForFixture(fixture: ToolRepairReplayFixture): ValidationErrorLike[] {
	const validator = Compile(fixture.parameters);
	return [...validator.Errors(fixture.arguments)].map((error) => ({
		instancePath: error.instancePath,
		keyword: error.keyword,
		message: error.message,
	}));
}

const KNOWN_FAILURE_MODES = new Set<string>([...TOOL_REPAIR_MODE_NAMES, "other"]);

function normalizedFailureModes(modes: readonly string[] | undefined): ToolRepairFailureModeName[] {
	const unique = [...new Set(modes ?? [])]
		.map((mode) => (KNOWN_FAILURE_MODES.has(mode) ? mode : "other"))
		.sort() as ToolRepairFailureModeName[];
	return unique.length > 0 ? unique : ["other"];
}

export function isToolRepairCorpusRecord(value: unknown): value is ToolRepairCorpusRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as { kind?: unknown; tool?: unknown; shape?: unknown };
	return record.kind === "tool_validation" && typeof record.tool === "string" && Array.isArray(record.shape);
}

export function replayToolRepairCorpus(records: readonly ToolRepairCorpusRecord[]): ToolRepairReplayResult[] {
	return records.map((record, index) => {
		const fixture = buildFixture(record);
		const errors = validationErrorsForFixture(fixture);
		const analyzerModes = analyzeToolArgumentErrors(
			fixture.tool,
			fixture.parameters,
			fixture.arguments,
			errors,
		).flatMap((issue) => issue.modes);
		const classifiedModes =
			analyzerModes.length > 0 ? normalizedFailureModes(analyzerModes) : normalizedFailureModes(record.failureModes);
		const validator = Compile(fixture.parameters);
		const repaired = repairToolArguments(fixture.tool, fixture.parameters, fixture.arguments, errors, (candidate) =>
			validator.Check(candidate),
		);
		return {
			record: index + 1,
			provider: record.provider,
			modelId: record.modelId,
			tool: record.tool,
			classifiedModes,
			outcome: repaired ? "would-repair" : "would-bounce",
			repairsApplied: repaired?.repairsApplied ?? [],
			fixture,
		};
	});
}
