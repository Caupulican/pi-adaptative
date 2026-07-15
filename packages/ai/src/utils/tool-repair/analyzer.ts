import type { Tool } from "../../types.ts";
import type { ToolRepairModeName } from "./registry.ts";

export interface JsonSchemaObject {
	type?: string | string[];
	properties?: Record<string, JsonSchemaObject>;
	items?: JsonSchemaObject | JsonSchemaObject[];
	required?: string[];
	additionalProperties?: boolean | JsonSchemaObject;
	allOf?: JsonSchemaObject[];
	anyOf?: JsonSchemaObject[];
	oneOf?: JsonSchemaObject[];
	enum?: unknown[];
	const?: unknown;
	default?: unknown;
}

export interface ValidationErrorLike {
	instancePath: string;
	keyword: string;
	message: string;
}

export interface ToolRepairIssue {
	path: string[];
	pathText: string;
	value: unknown;
	schema: JsonSchemaObject;
	parentSchema?: JsonSchemaObject;
	parentValue?: unknown;
	propertyKey?: string;
	required: boolean;
	modes: ToolRepairModeName[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
	return isRecord(value);
}

export function parseInstancePath(instancePath: string): string[] {
	if (!instancePath) return [];
	return instancePath
		.replace(/^\//, "")
		.split("/")
		.filter((segment) => segment.length > 0)
		.map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

export function formatRepairPath(path: readonly string[]): string {
	return path.length === 0 ? "root" : path.join(".");
}

export function getValueAtPath(value: unknown, path: readonly string[]): unknown {
	let cursor = value;
	for (const segment of path) {
		if (Array.isArray(cursor)) {
			const index = Number(segment);
			if (!Number.isInteger(index)) return undefined;
			cursor = cursor[index];
		} else if (isRecord(cursor)) {
			cursor = cursor[segment];
		} else {
			return undefined;
		}
	}
	return cursor;
}

export function getSchemaTypes(schema: JsonSchemaObject): string[] {
	const types = new Set<string>();
	const addTypes = (candidate: JsonSchemaObject): void => {
		if (typeof candidate.type === "string") {
			types.add(candidate.type);
		} else if (Array.isArray(candidate.type)) {
			for (const type of candidate.type) {
				if (typeof type === "string") types.add(type);
			}
		}
		if (candidate.enum?.every((value) => typeof value === "string")) {
			types.add("string");
		}
		if (typeof candidate.const === "string") {
			types.add("string");
		}
	};

	addTypes(schema);
	for (const nested of [...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])]) {
		addTypes(nested);
	}
	return [...types];
}

export function getEnumValues(schema: JsonSchemaObject): string[] {
	const values: string[] = [];
	const addValues = (candidate: JsonSchemaObject): void => {
		if (Array.isArray(candidate.enum)) {
			for (const value of candidate.enum) {
				if (typeof value === "string") values.push(value);
			}
		}
		if (typeof candidate.const === "string") {
			values.push(candidate.const);
		}
	};

	addValues(schema);
	for (const nested of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) {
		addValues(nested);
	}
	return values;
}

export function resolveSchemaAtPath(
	schema: JsonSchemaObject,
	path: readonly string[],
): {
	schema?: JsonSchemaObject;
	parentSchema?: JsonSchemaObject;
	propertyKey?: string;
} {
	let cursor: JsonSchemaObject | undefined = schema;
	let parentSchema: JsonSchemaObject | undefined;
	let propertyKey: string | undefined;

	for (const segment of path) {
		if (!cursor) return { schema: undefined, parentSchema, propertyKey };
		parentSchema = cursor;
		propertyKey = segment;
		if (cursor.properties?.[segment]) {
			cursor = cursor.properties[segment];
			continue;
		}
		if (Array.isArray(cursor.items)) {
			const index = Number(segment);
			cursor = Number.isInteger(index) ? cursor.items[index] : undefined;
			continue;
		}
		if (isJsonSchemaObject(cursor.items)) {
			cursor = cursor.items;
			continue;
		}
		if (isJsonSchemaObject(cursor.additionalProperties)) {
			cursor = cursor.additionalProperties;
			continue;
		}
		return { schema: undefined, parentSchema, propertyKey };
	}

	return { schema: cursor, parentSchema, propertyKey };
}

function isRequired(parentSchema: JsonSchemaObject | undefined, propertyKey: string | undefined): boolean {
	return Boolean(propertyKey && parentSchema?.required?.includes(propertyKey));
}

function isScalarSchema(schema: JsonSchemaObject): boolean {
	return getSchemaTypes(schema).some((type) => ["string", "number", "integer", "boolean"].includes(type));
}

function isArraySchema(schema: JsonSchemaObject): boolean {
	return getSchemaTypes(schema).includes("array");
}

function isObjectSchema(schema: JsonSchemaObject): boolean {
	return getSchemaTypes(schema).includes("object");
}

function normalizeEnumValue(value: string): string {
	return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function enumNormalizeHasMatch(schema: JsonSchemaObject, value: string): boolean {
	const normalized = normalizeEnumValue(value);
	return getEnumValues(schema).filter((candidate) => normalizeEnumValue(candidate) === normalized).length === 1;
}

function isEmptyObject(value: unknown): boolean {
	return isRecord(value) && Object.keys(value).length === 0;
}

function isScalarValue(value: unknown): boolean {
	return ["string", "number", "boolean"].includes(typeof value);
}

function getParentPath(path: readonly string[]): string[] {
	return path.slice(0, -1);
}

function isNumericArrayParentIssue(
	args: Record<string, unknown>,
	rootSchema: JsonSchemaObject,
	path: readonly string[],
): ToolRepairIssue | undefined {
	if (path.length === 0) return undefined;
	const parentPath = getParentPath(path);
	const parentLookup = resolveSchemaAtPath(rootSchema, parentPath);
	const parentSchema = parentLookup.schema;
	if (!parentSchema || !isArraySchema(parentSchema) || Array.isArray(parentSchema.items)) return undefined;
	if (!isJsonSchemaObject(parentSchema.items)) return undefined;
	const itemTypes = getSchemaTypes(parentSchema.items);
	if (!itemTypes.some((type) => type === "number" || type === "integer")) return undefined;
	const parentValue = getValueAtPath(args, parentPath);
	if (!Array.isArray(parentValue) || !parentValue.every((item) => typeof item === "string")) return undefined;
	return {
		path: parentPath,
		pathText: formatRepairPath(parentPath),
		value: parentValue,
		schema: parentSchema,
		parentSchema: parentLookup.parentSchema,
		parentValue: getValueAtPath(args, getParentPath(parentPath)),
		propertyKey: parentLookup.propertyKey,
		required: isRequired(parentLookup.parentSchema, parentLookup.propertyKey),
		modes: ["stringifiedNumberInArray"],
	};
}

function classifyModes(toolName: string, issue: Omit<ToolRepairIssue, "modes">): ToolRepairModeName[] {
	const modes: ToolRepairModeName[] = [];
	const expectedTypes = getSchemaTypes(issue.schema);

	if ((toolName === "bash" || toolName === "powershell") && issue.pathText === "command") {
		if (Array.isArray(issue.value) && issue.value.every((item) => typeof item === "string")) {
			modes.push("bashCommandArgvJoin");
		}
		if (isRecord(issue.value)) {
			modes.push("bashCommandUnwrap");
		}
	}

	if (typeof issue.value === "string" && (isArraySchema(issue.schema) || isObjectSchema(issue.schema))) {
		modes.push("jsonStringParse");
		if (isObjectSchema(issue.schema)) modes.push("jsonObjectPropertySalvage");
	}
	if (isArraySchema(issue.schema) && isRecord(issue.value)) {
		modes.push("singleObjectWrap", "emptyObjectPlaceholder");
	}
	if (isArraySchema(issue.schema) && isScalarValue(issue.value)) {
		modes.push("bareScalarWrap");
	}
	if (typeof issue.value === "string" && expectedTypes.some((type) => type === "number" || type === "integer")) {
		modes.push("numberFromString");
	}
	if (typeof issue.value === "string" && expectedTypes.includes("boolean")) {
		modes.push("boolFromString");
	}
	if (typeof issue.value === "string" && enumNormalizeHasMatch(issue.schema, issue.value)) {
		modes.push("enumCaseNormalize");
	}
	if (Array.isArray(issue.value) && issue.value.length === 1 && isScalarSchema(issue.schema)) {
		modes.push("singleElementUnwrap");
	}
	if (!issue.required && isEmptyObject(issue.value) && isScalarSchema(issue.schema)) {
		modes.push("emptyObjectPlaceholder");
	}
	if (issue.value === null) {
		modes.push(issue.required ? "nullRequiredBounce" : "nullOptionalDrop");
	}

	return modes;
}

function comparePaths(a: readonly string[], b: readonly string[]): number {
	const length = Math.min(a.length, b.length);
	for (let index = 0; index < length; index++) {
		const left = a[index];
		const right = b[index];
		const leftNumber = Number(left);
		const rightNumber = Number(right);
		if (Number.isInteger(leftNumber) && Number.isInteger(rightNumber) && leftNumber !== rightNumber) {
			return leftNumber - rightNumber;
		}
		if (left !== right) return left < right ? -1 : 1;
	}
	return a.length - b.length;
}

export function analyzeToolArgumentErrors(
	toolName: string,
	schema: Tool["parameters"],
	args: Record<string, unknown>,
	errors: readonly ValidationErrorLike[],
): ToolRepairIssue[] {
	const rootSchema = schema as JsonSchemaObject;
	const issues = new Map<string, ToolRepairIssue>();

	for (const error of errors) {
		if (error.keyword === "required") continue;
		const path = parseInstancePath(error.instancePath);
		const numericArrayIssue = isNumericArrayParentIssue(args, rootSchema, path);
		if (numericArrayIssue) {
			issues.set(numericArrayIssue.pathText, numericArrayIssue);
			continue;
		}

		const lookup = resolveSchemaAtPath(rootSchema, path);
		if (!lookup.schema) continue;
		const value = getValueAtPath(args, path);
		const issueBase = {
			path,
			pathText: formatRepairPath(path),
			value,
			schema: lookup.schema,
			parentSchema: lookup.parentSchema,
			parentValue: getValueAtPath(args, getParentPath(path)),
			propertyKey: lookup.propertyKey,
			required: isRequired(lookup.parentSchema, lookup.propertyKey),
		};
		const modes = classifyModes(toolName, issueBase);
		if (modes.length > 0) {
			issues.set(issueBase.pathText, { ...issueBase, modes });
		}
	}

	return [...issues.values()].sort((left, right) => comparePaths(left.path, right.path));
}
