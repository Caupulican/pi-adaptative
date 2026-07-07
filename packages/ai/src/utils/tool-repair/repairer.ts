import { Compile } from "typebox/compile";
import type { Tool } from "../../types.ts";
import {
	analyzeToolArgumentErrors,
	formatRepairPath,
	getEnumValues,
	getSchemaTypes,
	getValueAtPath,
	isJsonSchemaObject,
	isRecord,
	type JsonSchemaObject,
	type ToolRepairIssue,
	type ValidationErrorLike,
} from "./analyzer.ts";
import type { ToolRepairModeName } from "./registry.ts";

export interface AppliedToolRepair {
	name: ToolRepairModeName;
	path: string;
}

const schemaValidatorCache = new WeakMap<object, ReturnType<typeof Compile>>();
const bashCommandWrapperKeys = new Set(["cmd", "command", "script"]);

export interface ToolRepairResult {
	args: Record<string, unknown>;
	repairsApplied: ToolRepairModeName[];
	repairs: AppliedToolRepair[];
}

function getSchemaValidator(schema: JsonSchemaObject): ReturnType<typeof Compile> | undefined {
	try {
		const key = schema as object;
		const cached = schemaValidatorCache.get(key);
		if (cached) return cached;
		const validator = Compile(schema as Tool["parameters"]);
		schemaValidatorCache.set(key, validator);
		return validator;
	} catch {
		return undefined;
	}
}

function schemaChecks(schema: JsonSchemaObject, value: unknown): boolean {
	return getSchemaValidator(schema)?.Check(value) === true;
}

function setValueAtPath(target: Record<string, unknown>, path: readonly string[], value: unknown): boolean {
	if (path.length === 0) return false;
	let cursor: unknown = target;
	for (let index = 0; index < path.length - 1; index++) {
		const segment = path[index];
		if (Array.isArray(cursor)) {
			const arrayIndex = Number(segment);
			if (!Number.isInteger(arrayIndex)) return false;
			cursor = cursor[arrayIndex];
		} else if (isRecord(cursor)) {
			cursor = cursor[segment];
		} else {
			return false;
		}
	}

	const finalSegment = path[path.length - 1];
	if (Array.isArray(cursor)) {
		const arrayIndex = Number(finalSegment);
		if (!Number.isInteger(arrayIndex)) return false;
		cursor[arrayIndex] = value;
		return true;
	}
	if (isRecord(cursor)) {
		cursor[finalSegment] = value;
		return true;
	}
	return false;
}

function deleteValueAtPath(target: Record<string, unknown>, path: readonly string[]): boolean {
	if (path.length === 0) return false;
	let cursor: unknown = target;
	for (let index = 0; index < path.length - 1; index++) {
		const segment = path[index];
		if (Array.isArray(cursor)) {
			const arrayIndex = Number(segment);
			if (!Number.isInteger(arrayIndex)) return false;
			cursor = cursor[arrayIndex];
		} else if (isRecord(cursor)) {
			cursor = cursor[segment];
		} else {
			return false;
		}
	}

	const finalSegment = path[path.length - 1];
	if (Array.isArray(cursor)) {
		const arrayIndex = Number(finalSegment);
		if (!Number.isInteger(arrayIndex)) return false;
		cursor.splice(arrayIndex, 1);
		return true;
	}
	if (isRecord(cursor)) {
		delete cursor[finalSegment];
		return true;
	}
	return false;
}

function normalizeEnumValue(value: string): string {
	return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function findNormalizedEnumValue(schema: JsonSchemaObject, value: string): string | undefined {
	const normalized = normalizeEnumValue(value);
	const matches = getEnumValues(schema).filter((candidate) => normalizeEnumValue(candidate) === normalized);
	return matches.length === 1 ? matches[0] : undefined;
}

function parseJsonContainer(value: string, schema: JsonSchemaObject): unknown | undefined {
	const trimmed = value.trim();
	if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return undefined;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		const expectedTypes = getSchemaTypes(schema);
		if (expectedTypes.includes("array") && !Array.isArray(parsed)) return undefined;
		if (expectedTypes.includes("object") && (!isRecord(parsed) || Array.isArray(parsed))) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

function parseNumber(value: string, schema: JsonSchemaObject): number | undefined {
	if (value.trim() === "") return undefined;
	const numberValue = Number(value);
	if (!Number.isFinite(numberValue)) return undefined;
	return getSchemaTypes(schema).includes("integer") && !Number.isInteger(numberValue) ? undefined : numberValue;
}

function coerceStringifiedNumberArray(value: unknown, schema: JsonSchemaObject): unknown[] | undefined {
	if (!Array.isArray(value) || !isJsonSchemaObject(schema.items)) return undefined;
	const itemTypes = getSchemaTypes(schema.items);
	if (!itemTypes.some((type) => type === "number" || type === "integer")) return undefined;
	const numbers: number[] = [];
	for (const item of value) {
		if (typeof item !== "string") return undefined;
		const parsed = parseNumber(item, schema.items);
		if (parsed === undefined) return undefined;
		numbers.push(parsed);
	}
	return numbers;
}

function unwrapBashCommand(value: unknown): string | undefined {
	if (!isRecord(value) || Object.keys(value).length !== 1) return undefined;
	const [key] = Object.keys(value);
	if (!bashCommandWrapperKeys.has(key)) return undefined;
	const command = value[key];
	return typeof command === "string" ? command : undefined;
}

function transformValue(
	issue: ToolRepairIssue,
	mode: ToolRepairModeName,
): { type: "set"; value: unknown } | { type: "delete" } | undefined {
	switch (mode) {
		case "jsonStringParse": {
			return typeof issue.value === "string"
				? { type: "set", value: parseJsonContainer(issue.value, issue.schema) }
				: undefined;
		}
		case "singleObjectWrap":
			return isRecord(issue.value) ? { type: "set", value: [issue.value] } : undefined;
		case "bareScalarWrap":
			return ["string", "number", "boolean"].includes(typeof issue.value)
				? { type: "set", value: [issue.value] }
				: undefined;
		case "emptyObjectPlaceholder":
			return !issue.required && isRecord(issue.value) && Object.keys(issue.value).length === 0
				? { type: "delete" }
				: undefined;
		case "numberFromString": {
			const parsed = typeof issue.value === "string" ? parseNumber(issue.value, issue.schema) : undefined;
			return parsed === undefined ? undefined : { type: "set", value: parsed };
		}
		case "boolFromString":
			if (issue.value === "true") return { type: "set", value: true };
			if (issue.value === "false") return { type: "set", value: false };
			return undefined;
		case "enumCaseNormalize": {
			const enumValue =
				typeof issue.value === "string" ? findNormalizedEnumValue(issue.schema, issue.value) : undefined;
			return enumValue === undefined ? undefined : { type: "set", value: enumValue };
		}
		case "singleElementUnwrap":
			return Array.isArray(issue.value) && issue.value.length === 1
				? { type: "set", value: issue.value[0] }
				: undefined;
		case "stringifiedNumberInArray": {
			const coerced = coerceStringifiedNumberArray(issue.value, issue.schema);
			return coerced === undefined ? undefined : { type: "set", value: coerced };
		}
		case "nullOptionalDrop":
			return !issue.required && issue.value === null ? { type: "delete" } : undefined;
		case "nullRequiredBounce":
			return undefined;
		case "bashCommandArgvJoin":
			return Array.isArray(issue.value) && issue.value.every((item) => typeof item === "string")
				? { type: "set", value: issue.value.join(" ") }
				: undefined;
		case "bashCommandUnwrap": {
			const command = unwrapBashCommand(issue.value);
			return command === undefined ? undefined : { type: "set", value: command };
		}
	}
}

function applyTransform(candidate: Record<string, unknown>, issue: ToolRepairIssue, mode: ToolRepairModeName): boolean {
	const transform = transformValue(issue, mode);
	if (!transform) return false;
	if (transform.type === "delete") {
		return deleteValueAtPath(candidate, issue.path);
	}
	if (transform.value === undefined) return false;
	if (!schemaChecks(issue.schema, transform.value)) return false;
	return setValueAtPath(candidate, issue.path, transform.value);
}

function refreshIssueValue(candidate: Record<string, unknown>, issue: ToolRepairIssue): ToolRepairIssue {
	return { ...issue, value: getValueAtPath(candidate, issue.path) };
}

export function repairToolArguments(
	toolName: string,
	schema: Tool["parameters"],
	args: Record<string, unknown>,
	errors: readonly ValidationErrorLike[],
	checkWholeArgs: (candidate: Record<string, unknown>) => boolean,
): ToolRepairResult | undefined {
	const issues = analyzeToolArgumentErrors(toolName, schema, args, errors);
	if (issues.length === 0) return undefined;

	const candidate = structuredClone(args);
	const repairsApplied: ToolRepairModeName[] = [];
	const repairs: AppliedToolRepair[] = [];

	for (const issue of issues) {
		if (issue.modes.includes("nullRequiredBounce")) continue;
		const currentIssue = refreshIssueValue(candidate, issue);
		for (const mode of currentIssue.modes) {
			if (mode === "nullRequiredBounce") continue;
			if (applyTransform(candidate, currentIssue, mode)) {
				repairsApplied.push(mode);
				repairs.push({ name: mode, path: formatRepairPath(currentIssue.path) });
				break;
			}
		}
	}

	if (repairsApplied.length === 0) return undefined;
	if (!checkWholeArgs(candidate)) return undefined;
	return { args: candidate, repairsApplied, repairs };
}

export function formatRepairSummary(repairsApplied: readonly ToolRepairModeName[]): string {
	return repairsApplied.length === 0 ? "none" : repairsApplied.join(", ");
}

export function getRepairPathText(path: readonly string[]): string {
	return formatRepairPath(path);
}
