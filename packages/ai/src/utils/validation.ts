import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import type { Tool, ToolCall } from "../types.ts";
import { analyzeToolArgumentErrors } from "./tool-repair/analyzer.ts";
import {
	formatToolRepairNote,
	type ToolRepairFailureModeName,
	type ToolRepairModeName,
} from "./tool-repair/registry.ts";
import { repairToolArguments } from "./tool-repair/repairer.ts";
import { formatValidationPath } from "./validation-path.ts";

const validatorCache = new WeakMap<object, ReturnType<typeof Compile>>();
const EXPECTED_FRAGMENT_MAX_LENGTH = 320;
const RECEIVED_VALUE_MAX_LENGTH = 200;
const MINIMAL_EXAMPLE_MAX_STRING_LENGTH = 64;
const MINIMAL_EXAMPLE_MAX_ARRAY_ITEMS = 8;
const MISSING_VALUE = Symbol("missing");

export type ToolArgumentValidationOutcome = "clean" | "repaired" | "bounced";
export type ToolArgumentTeachState = "none" | "note" | "rule";
export type ToolArgumentExecutionOutcome = "not_run" | "succeeded" | "failed";

export interface ToolArgumentFailureShapeEntry {
	path: string;
	expectedType: string;
	receivedType: string;
	keyword?: string;
}

export interface ToolArgumentValidationTelemetryEvent {
	outcome: ToolArgumentValidationOutcome;
	provider?: string;
	model?: string;
	tool: string;
	source?: ToolCall["source"];
	failureModes: ToolRepairFailureModeName[];
	repairsApplied: ToolRepairModeName[];
	failureShape?: ToolArgumentFailureShapeEntry[];
	errorKeywords?: string[];
	taught: ToolArgumentTeachState;
	executionOutcome: ToolArgumentExecutionOutcome;
}

export interface ToolArgumentValidationOptions {
	model?: string;
	provider?: string;
	telemetry?: (event: ToolArgumentValidationTelemetryEvent) => void;
	/** Internal emergency diagnostic kill; user settings do not disable deterministic repair. */
	repairEnabled?: boolean;
}

export class ToolArgumentValidationError extends Error {
	public readonly toolName: string;
	public readonly signature: string;
	public readonly enrichment: string;

	constructor(message: string, options: { toolName: string; signature: string; enrichment: string }) {
		super(message);
		this.name = "ToolArgumentValidationError";
		this.toolName = options.toolName;
		this.signature = options.signature;
		this.enrichment = options.enrichment;
	}
}

function emitToolArgumentValidationTelemetry(
	options: ToolArgumentValidationOptions | undefined,
	event: Omit<ToolArgumentValidationTelemetryEvent, "model" | "provider" | "taught" | "executionOutcome">,
): void {
	try {
		options?.telemetry?.({
			...event,
			model: options.model,
			provider: options.provider,
			taught: "none",
			executionOutcome: "not_run",
		});
	} catch {
		// Telemetry is observe-only; never fail validation because a sink failed.
	}
}

function uniqueRepairModes(modes: Iterable<ToolRepairModeName>): ToolRepairModeName[] {
	return [...new Set(modes)];
}

function uniqueFailureModes(modes: Iterable<ToolRepairModeName>): ToolRepairFailureModeName[] {
	const uniqueModes = uniqueRepairModes(modes);
	return uniqueModes.length > 0 ? uniqueModes : ["other"];
}

/**
 * Compiles (and caches) the TypeBox validator for a tool's parameter schema.
 *
 * This is the ONE validator compile-cache for the repair layer (decision D3, tool-call-repair
 * doctrine): `repairer.ts` imports this instead of keeping a second cache over the same schema
 * objects, so a schema is compiled once and both the validate and repair paths share the result.
 */
export function getValidator(schema: Tool["parameters"]): ReturnType<typeof Compile> {
	const key = schema as object;
	const cached = validatorCache.get(key);
	if (cached) {
		return cached;
	}
	const validator = Compile(schema);
	validatorCache.set(key, validator);
	return validator;
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

function schemaAtValidationError(schema: unknown, error: TLocalizedValidationError): unknown {
	const pointer = error.schemaPath;
	if (!pointer.startsWith("#/")) return schemaAtPath(schema, validationPathSegments(error));
	let current: unknown = schema;
	for (const encodedSegment of pointer.slice(2).split("/")) {
		const segment = encodedSegment.replace(/~1/g, "/").replace(/~0/g, "~");
		if (Array.isArray(current)) {
			const index = Number(segment);
			if (!Number.isInteger(index) || index < 0 || index >= current.length) {
				return schemaAtPath(schema, validationPathSegments(error));
			}
			current = current[index];
			continue;
		}
		const record = asRecord(current);
		if (!record || !(segment in record)) return schemaAtPath(schema, validationPathSegments(error));
		current = record[segment];
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

function receivedTypeOf(value: unknown): string {
	if (value === MISSING_VALUE) return "missing";
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function expectedTypeOf(schema: unknown): string {
	const record = asRecord(schema);
	if (!record) return "unknown";
	const values = literalValues(record);
	if (values?.length) {
		const allowed = values.map((value) => formatCompactJson(value, RECEIVED_VALUE_MAX_LENGTH)).join(", ");
		return values.length === 1 ? `literal ${allowed}` : `one of ${allowed}`;
	}
	if (Array.isArray(record.type)) return record.type.filter((type) => typeof type === "string").join("|") || "unknown";
	if (typeof record.type === "string") return record.type;
	if (record.properties !== undefined) return "object";
	if (record.items !== undefined) return "array";
	const alternatives = schemaAlternatives(record);
	if (alternatives.length > 0) {
		const types = [...new Set(alternatives.map(expectedTypeOf).filter((type) => type !== "unknown"))];
		if (types.length === 1) return types[0];
	}
	return "unknown";
}

function formatFailureShape(
	errors: readonly TLocalizedValidationError[],
	args: unknown,
	schema: unknown,
): ToolArgumentFailureShapeEntry[] {
	const seen = new Set<string>();
	const shape: ToolArgumentFailureShapeEntry[] = [];
	for (const error of errors) {
		const path = formatValidationPath(error);
		const pathSegments = path === "root" ? [] : path.split(".");
		const expectedSchema = schemaAtValidationError(schema, error);
		const value = receivedValueAtPath(args, pathSegments);
		const entry = {
			path,
			expectedType:
				error.keyword === "additionalProperties" ? "forbidden" : expectedFailureType(error, expectedSchema),
			receivedType: receivedTypeOf(value),
			keyword: error.keyword,
		};
		const key = `${entry.path}\0${entry.expectedType}\0${entry.receivedType}\0${entry.keyword}`;
		if (seen.has(key)) continue;
		seen.add(key);
		shape.push(entry);
	}
	return shape;
}

function errorKeywords(errors: readonly TLocalizedValidationError[]): string[] {
	return [...new Set(errors.map((error) => error.keyword))].sort();
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

/**
 * The union alternative whose literal discriminator matches the supplied arguments, when every
 * alternative is an object schema declaring a literal for one shared property and exactly one of
 * them matches. Returns undefined for anything else, so non-discriminated unions keep the
 * whole-schema behaviour.
 */
export function selectUnionBranch(schema: unknown, args: unknown): Record<string, unknown> | undefined {
	const root = asRecord(schema);
	const record = asRecord(args);
	if (!root || !record) return undefined;
	const alternatives = schemaAlternatives(root).map(asRecord);
	if (alternatives.length < 2 || alternatives.some((alternative) => !alternative)) return undefined;
	const literalKeys = alternatives.map((alternative) => {
		const properties = asRecord(alternative?.properties);
		if (!properties) return new Map<string, unknown>();
		const keys = new Map<string, unknown>();
		for (const [key, property] of Object.entries(properties)) {
			const values = literalValues(property);
			if (values && values.length === 1) keys.set(key, values[0]);
		}
		return keys;
	});
	const shared = [...(literalKeys[0]?.keys() ?? [])].filter((key) => literalKeys.every((keys) => keys.has(key)));
	for (const key of shared) {
		const matches = alternatives.filter((alternative, index) => {
			void alternative;
			return literalKeys[index]?.get(key) === record[key];
		});
		if (matches.length === 1) return matches[0] ?? undefined;
	}
	return undefined;
}

function schemaAlternatives(schema: Record<string, unknown>): unknown[] {
	const alternatives = Array.isArray(schema.anyOf)
		? schema.anyOf
		: Array.isArray(schema.oneOf)
			? schema.oneOf
			: undefined;
	return alternatives ?? [];
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
	const alternatives = schemaAlternatives(record);
	if (alternatives.length > 0) {
		// A union's first branch is both deterministic and the branch used for our minimal valid
		// example. Presenting it is more useful than an opaque anyOf/oneOf shell.
		return compactSchemaFragment(alternatives[0]);
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
	const alternatives = schemaAlternatives(record);
	if (alternatives.length > 0) {
		return minimalExample(alternatives[0]);
	}

	const type = Array.isArray(record.type) ? record.type[0] : record.type;
	switch (type) {
		case "string": {
			const minimumLength = typeof record.minLength === "number" && record.minLength > 0 ? record.minLength : 0;
			return minimumLength <= MINIMAL_EXAMPLE_MAX_STRING_LENGTH ? "x".repeat(minimumLength) : undefined;
		}
		case "number":
			return typeof record.minimum === "number" ? record.minimum : 0;
		case "integer":
			return typeof record.minimum === "number" ? Math.ceil(record.minimum) : 0;
		case "boolean":
			return true;
		case "array": {
			const minimumItems = typeof record.minItems === "number" && record.minItems > 0 ? record.minItems : 0;
			if (minimumItems > MINIMAL_EXAMPLE_MAX_ARRAY_ITEMS) return undefined;
			if (minimumItems === 0) return [];
			const item = minimalExample(record.items);
			return item === undefined ? undefined : Array.from({ length: minimumItems }, () => item);
		}
		case "object": {
			const properties = asRecord(record.properties) ?? {};
			const required = Array.isArray(record.required)
				? record.required.filter((key) => typeof key === "string")
				: [];
			const example: Record<string, unknown> = {};
			for (const key of required) {
				const value = minimalExample(properties[key]);
				if (value === undefined) return undefined;
				example[key] = value;
			}
			return example;
		}
		case "null":
			return null;
		default:
			return undefined;
	}
}

function valuesFromValidationError(error: TLocalizedValidationError, schema: unknown): unknown[] | undefined {
	const params = asRecord(error.params);
	if (params?.allowedValue !== undefined) return [params.allowedValue];
	if (Array.isArray(params?.allowedValues)) return params.allowedValues;
	return literalValues(schema);
}

function expectedFailureType(error: TLocalizedValidationError, schema: unknown): string {
	const values = valuesFromValidationError(error, schema);
	if (values?.length) {
		const allowed = values.map((value) => formatCompactJson(value, RECEIVED_VALUE_MAX_LENGTH)).join(", ");
		return values.length === 1 ? `literal ${allowed}` : `one of ${allowed}`;
	}
	return expectedTypeOf(schema);
}

function validationGuidance(error: TLocalizedValidationError, schema: unknown): string {
	const values = valuesFromValidationError(error, schema);
	if (values?.length) {
		const allowed = values.map((value) => formatCompactJson(value, RECEIVED_VALUE_MAX_LENGTH)).join(", ");
		return `${values.length === 1 ? `must equal ${allowed}` : `must be one of ${allowed}`}; Allowed values: ${allowed}`;
	}
	const expectedType = expectedTypeOf(schema);
	if (
		expectedType !== "unknown" &&
		(error.keyword === "type" || error.keyword === "anyOf" || error.keyword === "oneOf")
	) {
		return `expected ${expectedType}`;
	}
	return error.message;
}

function formatValidationErrors(errors: readonly TLocalizedValidationError[], args: unknown, schema: unknown): string {
	return (
		errors
			.map((error) => {
				const path = formatValidationPath(error);
				const pathSegments = validationPathSegments(error);
				const expectedSchema = schemaAtValidationError(schema, error);
				const expectedFragment = formatCompactJson(
					compactSchemaFragment(expectedSchema),
					EXPECTED_FRAGMENT_MAX_LENGTH,
				);
				const example = minimalExample(expectedSchema);
				const received = formatCompactJson(receivedValueAtPath(args, pathSegments), RECEIVED_VALUE_MAX_LENGTH);
				const exampleText =
					example === undefined ? "" : `; Example: ${formatCompactJson(example, RECEIVED_VALUE_MAX_LENGTH)}`;
				return `  - ${path}: ${validationGuidance(error, expectedSchema)}; Expected schema: ${expectedFragment}${exampleText}; Received: ${received}`;
			})
			.join("\n") || "Unknown validation error"
	);
}

function validationFailureSignature(errors: readonly TLocalizedValidationError[]): string {
	return JSON.stringify(
		errors.map((error) => ({
			path: formatValidationPath(error),
			keyword: error.keyword,
			message: error.message,
		})),
	);
}

/**
 * Authoritative, bounded schema guidance for a provider- or validator-rejected tool call.
 * Kept here so every recovery path teaches the same schema and validator-safe minimal example.
 */
export function formatToolValidationEnrichment(tool: Tool): string {
	const example = minimalExample(tool.parameters);
	const exampleText = example === undefined ? "" : `\nValid example:\n${formatCompactJson(example, 2000)}`;
	return `Full tool schema:\n${formatCompactJson(tool.parameters, 4000)}${exampleText}`;
}

/**
 * Finds a tool by name and validates the tool call arguments against its TypeBox schema
 * @param tools Array of tool definitions
 * @param toolCall The tool call from the LLM
 * @returns The validated arguments
 * @throws Error if tool is not found or validation fails
 */
export function validateToolCall(
	tools: Tool[],
	toolCall: ToolCall,
	options?: ToolArgumentValidationOptions,
): Record<string, unknown> {
	const tool = tools.find((t) => t.name === toolCall.name);
	if (!tool) {
		throw new Error(`Tool "${toolCall.name}" not found`);
	}
	return validateToolArguments(tool, toolCall, options);
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
export function validateToolArguments(
	tool: Tool,
	toolCall: ToolCall,
	options?: ToolArgumentValidationOptions,
): Record<string, unknown> {
	const args = toolCall.arguments;
	const validator = getValidator(tool.parameters);

	if (validator.Check(args)) {
		return args;
	}

	// A union of action shapes is validated against the branch the supplied discriminator names,
	// so the errors, the repairs and the repair text all speak about that branch (measured live:
	// a `list` call was told to fix the `set` branch's fields and its "true" was never coerced).
	const branch = selectUnionBranch(tool.parameters, args);
	const schema = branch ?? tool.parameters;
	const branchValidator = branch ? getValidator(branch) : validator;
	const validationErrors = [...branchValidator.Errors(args)] as TLocalizedValidationError[];
	const repairIssues = analyzeToolArgumentErrors(toolCall.name, schema, args, validationErrors);
	const failureModes = uniqueFailureModes(repairIssues.flatMap((issue) => issue.modes));
	const repaired =
		options?.repairEnabled === false
			? undefined
			: repairToolArguments(toolCall.name, schema, args, validationErrors, (candidate) =>
					validator.Check(candidate),
				);
	if (repaired) {
		const repairsApplied = uniqueRepairModes(repaired.repairsApplied);
		toolCall.repairNotes = repaired.repairs.map(
			(repair) =>
				`[harness] ${repair.name}: ${formatToolRepairNote(repair.name, repair.path)}; executed with repaired arguments.`,
		);
		emitToolArgumentValidationTelemetry(options, {
			outcome: "repaired",
			tool: toolCall.name,
			source: toolCall.source,
			failureModes,
			repairsApplied,
		});
		return repaired.args;
	}

	emitToolArgumentValidationTelemetry(options, {
		outcome: "bounced",
		tool: toolCall.name,
		source: toolCall.source,
		failureModes,
		repairsApplied: [],
		failureShape: formatFailureShape(validationErrors, toolCall.arguments, schema),
		errorKeywords: errorKeywords(validationErrors),
	});

	const errorMessage = `Validation failed for tool "${toolCall.name}":\n${formatValidationErrors(
		validationErrors,
		toolCall.arguments,
		schema,
	)}\n\nReceived arguments:\n${truncateText(JSON.stringify(toolCall.arguments, null, 2), 2000)}`;

	throw new ToolArgumentValidationError(errorMessage, {
		toolName: toolCall.name,
		signature: validationFailureSignature(validationErrors),
		enrichment: formatToolValidationEnrichment(tool),
	});
}
