import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import type { Tool, ToolCall } from "../types.ts";
import { repairToolArguments } from "./tool-repair/repairer.ts";

const validatorCache = new WeakMap<object, ReturnType<typeof Compile>>();
const EXPECTED_FRAGMENT_MAX_LENGTH = 320;
const RECEIVED_VALUE_MAX_LENGTH = 200;
const MISSING_VALUE = Symbol("missing");

function getValidator(schema: Tool["parameters"]): ReturnType<typeof Compile> {
	const key = schema as object;
	const cached = validatorCache.get(key);
	if (cached) {
		return cached;
	}
	const validator = Compile(schema);
	validatorCache.set(key, validator);
	return validator;
}

function formatValidationPath(error: TLocalizedValidationError): string {
	if (error.keyword === "required") {
		const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
		const requiredProperty = requiredProperties?.[0];
		if (requiredProperty) {
			const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
			return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
		}
	}
	const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
	return path || "root";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function truncateText(text: string, maxLength: number): string {
	if (text.length <= maxLength) {
		return text;
	}
	return `${text.slice(0, maxLength)}...[truncated]`;
}

function formatCompactJson(value: unknown, maxLength: number): string {
	if (value === MISSING_VALUE) {
		return "<missing>";
	}
	if (value === undefined) {
		return "undefined";
	}
	return truncateText(JSON.stringify(value), maxLength);
}

function validationPathSegments(error: TLocalizedValidationError): string[] {
	const path = formatValidationPath(error);
	return path === "root" ? [] : path.split(".");
}

function schemaAtPath(schema: unknown, pathSegments: readonly string[]): unknown {
	let current: unknown = schema;
	for (const segment of pathSegments) {
		const record = asRecord(current);
		if (!record) {
			return current;
		}

		const properties = asRecord(record.properties);
		if (properties && segment in properties) {
			current = properties[segment];
			continue;
		}

		if (record.items !== undefined) {
			current = record.items;
			continue;
		}

		return current;
	}
	return current;
}

function receivedValueAtPath(args: unknown, pathSegments: readonly string[]): unknown {
	let current: unknown = args;
	for (const segment of pathSegments) {
		const record = asRecord(current);
		if (record) {
			if (!(segment in record)) {
				return MISSING_VALUE;
			}
			current = record[segment];
			continue;
		}

		if (Array.isArray(current)) {
			const index = Number(segment);
			if (!Number.isInteger(index) || index < 0 || index >= current.length) {
				return MISSING_VALUE;
			}
			current = current[index];
			continue;
		}

		return MISSING_VALUE;
	}
	return current;
}

function literalValues(schema: unknown): unknown[] | undefined {
	const record = asRecord(schema);
	if (!record) {
		return undefined;
	}
	if (Array.isArray(record.enum)) {
		return record.enum;
	}
	if (record.const !== undefined) {
		return [record.const];
	}
	const anyOf = Array.isArray(record.anyOf) ? record.anyOf : Array.isArray(record.oneOf) ? record.oneOf : undefined;
	if (anyOf) {
		const values: unknown[] = [];
		for (const option of anyOf) {
			const optionRecord = asRecord(option);
			if (!optionRecord || optionRecord.const === undefined) {
				return undefined;
			}
			values.push(optionRecord.const);
		}
		return values;
	}
	return undefined;
}

function compactSchemaFragment(schema: unknown): Record<string, unknown> {
	const record = asRecord(schema);
	if (!record) {
		return {};
	}

	const fragment: Record<string, unknown> = {};
	const values = literalValues(record);
	if (values) {
		fragment.enum = values;
		return fragment;
	}

	for (const key of ["type", "required", "minimum", "maximum", "minLength", "maxLength", "format"] as const) {
		if (record[key] !== undefined) {
			fragment[key] = record[key];
		}
	}

	const properties = asRecord(record.properties);
	if (properties) {
		fragment.properties = Object.keys(properties);
	}
	if (record.items !== undefined) {
		fragment.items = compactSchemaFragment(record.items);
	}
	return fragment;
}

function minimalExample(schema: unknown): unknown {
	const record = asRecord(schema);
	if (!record) {
		return undefined;
	}
	if (record.default !== undefined) {
		return record.default;
	}
	const values = literalValues(record);
	if (values?.length) {
		return values[0];
	}

	const type = Array.isArray(record.type) ? record.type[0] : record.type;
	switch (type) {
		case "string":
			return "";
		case "number":
			return typeof record.minimum === "number" ? record.minimum : 0;
		case "integer":
			return typeof record.minimum === "number" ? Math.ceil(record.minimum) : 0;
		case "boolean":
			return true;
		case "array":
			return [];
		case "object": {
			const properties = asRecord(record.properties) ?? {};
			const required = Array.isArray(record.required)
				? record.required.filter((key) => typeof key === "string")
				: [];
			return Object.fromEntries(required.map((key) => [key, minimalExample(properties[key]) ?? null]));
		}
		case "null":
			return null;
		default:
			return undefined;
	}
}

function formatValidationErrors(errors: readonly TLocalizedValidationError[], args: unknown, schema: unknown): string {
	return (
		errors
			.map((error) => {
				const path = formatValidationPath(error);
				const pathSegments = validationPathSegments(error);
				const expectedSchema = schemaAtPath(schema, pathSegments);
				const expectedFragment = formatCompactJson(
					compactSchemaFragment(expectedSchema),
					EXPECTED_FRAGMENT_MAX_LENGTH,
				);
				const example = minimalExample(expectedSchema);
				const received = formatCompactJson(receivedValueAtPath(args, pathSegments), RECEIVED_VALUE_MAX_LENGTH);
				const exampleText =
					example === undefined ? "" : `; Example: ${formatCompactJson(example, RECEIVED_VALUE_MAX_LENGTH)}`;
				return `  - ${path}: ${error.message}; Expected schema: ${expectedFragment}${exampleText}; Received: ${received}`;
			})
			.join("\n") || "Unknown validation error"
	);
}

/**
 * Finds a tool by name and validates the tool call arguments against its TypeBox schema
 * @param tools Array of tool definitions
 * @param toolCall The tool call from the LLM
 * @returns The validated arguments
 * @throws Error if tool is not found or validation fails
 */
export function validateToolCall(tools: Tool[], toolCall: ToolCall): Record<string, unknown> {
	const tool = tools.find((t) => t.name === toolCall.name);
	if (!tool) {
		throw new Error(`Tool "${toolCall.name}" not found`);
	}
	return validateToolArguments(tool, toolCall);
}

/**
 * Validates tool call arguments against the tool's TypeBox schema.
 *
 * The hot path is validate-first and allocation-free: valid arguments return the exact
 * argument object emitted by the model. Only invalid calls enter the deterministic
 * repair layer, which applies named, guard-checked shape repairs on a clone.
 *
 * @param tool The tool definition with TypeBox schema
 * @param toolCall The tool call from the LLM
 * @returns The validated (and potentially repaired) arguments
 * @throws Error with formatted message if validation fails
 */
export function validateToolArguments(tool: Tool, toolCall: ToolCall): Record<string, unknown> {
	const args = toolCall.arguments;
	const validator = getValidator(tool.parameters);

	if (validator.Check(args)) {
		return args;
	}

	const validationErrors = [...validator.Errors(args)] as TLocalizedValidationError[];
	const repaired = repairToolArguments(toolCall.name, tool.parameters, args, validationErrors, (candidate) =>
		validator.Check(candidate),
	);
	if (repaired) {
		return repaired.args;
	}

	const errorMessage = `Validation failed for tool "${toolCall.name}":\n${formatValidationErrors(
		validationErrors,
		toolCall.arguments,
		tool.parameters,
	)}\n\nReceived arguments:\n${truncateText(JSON.stringify(toolCall.arguments, null, 2), 2000)}`;

	throw new Error(errorMessage);
}
