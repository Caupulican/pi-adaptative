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
import { formatValidationPath, instancePathBase } from "./validation-path.ts";

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
	/**
	 * For a constraint failure on a well-typed value (maxLength, minimum, pattern, maxItems, …): the
	 * validator's own sentence plus the received measure, e.g. `must not have more than 3500
	 * characters (received 3610 characters)`. Absent for type mismatches, where the expected and
	 * received types already say everything.
	 */
	constraint?: string;
}

/** Keywords whose failure the expected/received types describe completely. */
const TYPE_LEVEL_KEYWORDS: ReadonlySet<string> = new Set([
	"type",
	"anyOf",
	"oneOf",
	"required",
	"additionalProperties",
	"enum",
	"const",
]);

/**
 * A value of the right type that still fails a constraint needs the constraint spelled out:
 * "expected string, received string" told a model nothing about a 3,610-character brief that hit a
 * 3,500-character cap. Pair the validator's sentence with the measure the model can act on.
 */
function constraintDescription(error: TLocalizedValidationError, value: unknown): string | undefined {
	if (TYPE_LEVEL_KEYWORDS.has(error.keyword)) return undefined;
	const received =
		typeof value === "string"
			? `received ${value.length} characters`
			: Array.isArray(value)
				? `received ${value.length} items`
				: typeof value === "number"
					? `received ${value}`
					: undefined;
	const message = error.message.trim();
	if (!message) return received;
	return received ? `${message} (${received})` : message;
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

		// A union of object schemas has no `properties` of its own: the path continues through
		// every alternative that declares the segment, merged so literal aggregation sees them all.
		const alternatives = schemaAlternatives(record);
		if (alternatives.length > 0) {
			const resolved = dedupeSchemas(
				alternatives
					.filter((alternative) => asRecord(asRecord(alternative)?.properties)?.[segment] !== undefined)
					.map((alternative) => asRecord(asRecord(alternative)?.properties)?.[segment]),
			);
			if (resolved.length === 0) return current;
			current = resolved.length === 1 ? resolved[0] : { anyOf: resolved };
			continue;
		}

		return current;
	}
	return current;
}

const MISSING_POINTER_TARGET = Symbol("missing-pointer-target");

/** Walk a `#/…` JSON pointer through a schema; a segment that does not resolve yields the sentinel. */
function schemaAtPointer(schema: unknown, pointer: string): unknown {
	let current: unknown = schema;
	for (const encodedSegment of pointer.slice(2).split("/")) {
		const segment = encodedSegment.replace(/~1/g, "/").replace(/~0/g, "~");
		if (Array.isArray(current)) {
			const index = Number(segment);
			if (!Number.isInteger(index) || index < 0 || index >= current.length) return MISSING_POINTER_TARGET;
			current = current[index];
			continue;
		}
		const record = asRecord(current);
		if (!record || !(segment in record)) return MISSING_POINTER_TARGET;
		current = record[segment];
	}
	return current;
}

function schemaAtValidationError(schema: unknown, error: TLocalizedValidationError): unknown {
	const pointer = error.schemaPath;
	const target = pointer.startsWith("#/") ? schemaAtPointer(schema, pointer) : MISSING_POINTER_TARGET;
	// A pointer that resolves to the `anyOf` array itself (or any non-schema value) names no
	// schema; the instance path walk does, including through union alternatives.
	return target === MISSING_POINTER_TARGET || asRecord(target) === undefined
		? schemaAtPath(schema, validationPathSegments(error))
		: target;
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

/** Joins literal/enum values for display, without the "literal"/"one of" wrapper. */
function formatAllowedValueList(values: unknown[]): string {
	return values.map((value) => formatCompactJson(value, RECEIVED_VALUE_MAX_LENGTH)).join(", ");
}

/** The "expected type" label for a schema known to allow only specific literal values. */
function formatAllowedValuesTypeLabel(values: unknown[]): string {
	const allowed = formatAllowedValueList(values);
	return values.length === 1 ? `literal ${allowed}` : `one of ${allowed}`;
}

function expectedTypeOf(schema: unknown): string {
	const record = asRecord(schema);
	if (!record) return "unknown";
	const values = literalValues(record);
	if (values?.length) return formatAllowedValuesTypeLabel(values);
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

/** Same label as `expectedTypeOf`, but sourced directly from a schema fragment with no validator error. */
function expectedTypeFromSchema(schema: unknown): string {
	const values = literalValues(schema);
	return values?.length ? formatAllowedValuesTypeLabel(values) : expectedTypeOf(schema);
}

/**
 * The object/branch schema a `required` error was raised against, resolved by walking its
 * `schemaPath` JSON pointer only (never falling back to instance-path/property resolution like
 * `schemaAtValidationError` does). A `required` error's schemaPath always names the schema that
 * declares the `required` array - `#` for a single object schema, `#/anyOf/N` for one alternative
 * of a union - so this always lands on the object whose `properties` map holds the missing key,
 * regardless of whether the caller already narrowed to one branch (schemaPath "#") or is still
 * looking at the whole union (schemaPath "#/anyOf/N").
 */
function requiredObjectSchema(schema: unknown, error: TLocalizedValidationError): Record<string, unknown> | undefined {
	const pointer = error.schemaPath;
	if (pointer === "#" || !pointer.startsWith("#/")) return asRecord(schema);
	const target = schemaAtPointer(schema, pointer);
	return asRecord(target === MISSING_POINTER_TARGET ? schema : target);
}

/** The property names a `required` validation error is missing, in schema-declared order. */
function requiredMissingProperties(error: TLocalizedValidationError): string[] {
	if (error.keyword !== "required") return [];
	const requiredProperties = asRecord(error.params)?.requiredProperties;
	return Array.isArray(requiredProperties)
		? requiredProperties.filter((name): name is string => typeof name === "string")
		: [];
}

function dedupeSchemas(schemas: readonly unknown[]): unknown[] {
	const seen = new Set<string>();
	const result: unknown[] = [];
	for (const schema of schemas) {
		const key = JSON.stringify(schema);
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(schema);
	}
	return result;
}

/**
 * Expands `required` validator errors into one entry per missing property, resolved against that
 * property's OWN schema (never the parent branch/object schema a bare `required` error points at -
 * that produced "expected object" guidance for a missing discriminator instead of the property's
 * real expected type). When several anyOf/oneOf branches are each missing the same property at the
 * same instance path (e.g. every branch of a discriminated union requires the discriminator), their
 * property schemas are combined into one synthetic `anyOf` so the existing literal/type aggregation
 * (`expectedTypeFromSchema`) reports the union of allowed values once, deduplicated.
 */
function requiredFailureEntries(
	errors: readonly TLocalizedValidationError[],
	schema: unknown,
): Array<{ path: string; schema: unknown }> {
	const order: string[] = [];
	const schemasByPath = new Map<string, unknown[]>();
	for (const error of errors) {
		const missingProperties = requiredMissingProperties(error);
		if (missingProperties.length === 0) continue;
		const objectSchema = requiredObjectSchema(schema, error);
		const objectProperties = asRecord(objectSchema?.properties);
		const basePath = instancePathBase(error);
		for (const property of missingProperties) {
			const path = basePath ? `${basePath}.${property}` : property;
			let schemas = schemasByPath.get(path);
			if (!schemas) {
				schemas = [];
				schemasByPath.set(path, schemas);
				order.push(path);
			}
			const propertySchema = objectProperties?.[property];
			if (propertySchema !== undefined) schemas.push(propertySchema);
		}
	}
	return order.map((path) => {
		const schemas = schemasByPath.get(path) ?? [];
		return { path, schema: schemas.length <= 1 ? schemas[0] : { anyOf: dedupeSchemas(schemas) } };
	});
}

/** Human-readable guidance for a missing required property, resolved from its own schema. */
function requiredGuidance(schema: unknown): string {
	const values = literalValues(schema);
	if (values?.length) {
		const allowed = formatAllowedValueList(values);
		return values.length === 1 ? `required, must equal ${allowed}` : `required, one of ${allowed}`;
	}
	const expectedType = expectedTypeOf(schema);
	return expectedType === "unknown" ? "required" : `required, expected ${expectedType}`;
}

/** Appends `entry` unless an identical (path, expectedType, receivedType, keyword) tuple was already pushed. */
function pushUniqueFailureShapeEntry(
	shape: ToolArgumentFailureShapeEntry[],
	seen: Set<string>,
	entry: ToolArgumentFailureShapeEntry,
): void {
	const key = `${entry.path}\0${entry.expectedType}\0${entry.receivedType}\0${entry.keyword}`;
	if (seen.has(key)) return;
	seen.add(key);
	shape.push(entry);
}

function formatFailureShape(
	errors: readonly TLocalizedValidationError[],
	args: unknown,
	schema: unknown,
): ToolArgumentFailureShapeEntry[] {
	const seen = new Set<string>();
	const shape: ToolArgumentFailureShapeEntry[] = [];
	for (const { path, schema: propertySchema } of requiredFailureEntries(errors, schema)) {
		const pathSegments = path.split(".");
		pushUniqueFailureShapeEntry(shape, seen, {
			path,
			expectedType: expectedTypeFromSchema(propertySchema),
			receivedType: receivedTypeOf(receivedValueAtPath(args, pathSegments)),
			keyword: "required",
		});
	}
	for (const error of errors) {
		if (error.keyword === "required") continue;
		const path = formatValidationPath(error);
		const pathSegments = path === "root" ? [] : path.split(".");
		const expectedSchema = schemaAtValidationError(schema, error);
		const value = receivedValueAtPath(args, pathSegments);
		const constraint = constraintDescription(error, value);
		pushUniqueFailureShapeEntry(shape, seen, {
			path,
			expectedType:
				error.keyword === "additionalProperties" ? "forbidden" : expectedFailureType(error, expectedSchema),
			receivedType: receivedTypeOf(value),
			keyword: error.keyword,
			...(constraint ? { constraint } : {}),
		});
	}
	return shape;
}

function errorKeywords(errors: readonly TLocalizedValidationError[]): string[] {
	return [...new Set(errors.map((error) => error.keyword))].sort();
}

function normalizeValidationErrors(errors: TLocalizedValidationError[]): TLocalizedValidationError[] {
	// TypeBox reports a false-schema child and an additionalProperties parent for
	// the same rejection. Keep the actionable parent, without hiding independent
	// false schemas or errors from another schema branch at the same instance path.
	const coveredFalseSchemas = new Set<string>();
	for (const error of errors) {
		if (error.keyword !== "additionalProperties") continue;
		for (const property of error.params.additionalProperties) {
			coveredFalseSchemas.add(
				JSON.stringify([`${error.schemaPath}/additionalProperties`, `${error.instancePath}/${property}`]),
			);
		}
	}
	return errors.filter(
		(error) =>
			error.keyword !== "boolean" ||
			!coveredFalseSchemas.has(JSON.stringify([error.schemaPath, error.instancePath])),
	);
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
	const discriminators = unionDiscriminators(root);
	if (!discriminators) return undefined;
	for (const { key, alternatives } of discriminators) {
		const matches = alternatives.filter((alternative) => alternative.value === record[key]);
		if (matches.length === 1) return matches[0]?.schema;
	}
	return undefined;
}

interface UnionDiscriminator {
	key: string;
	/** Every alternative paired with the literal it declares for `key`, in schema order. */
	alternatives: Array<{ value: unknown; schema: Record<string, unknown> }>;
}

/**
 * The properties every alternative of an object union pins to a single literal - the keys a caller
 * chooses a branch with. Undefined unless the schema is a union of at least two object schemas.
 */
function unionDiscriminators(schema: Record<string, unknown>): UnionDiscriminator[] | undefined {
	const alternatives = schemaAlternatives(schema).map(asRecord);
	if (alternatives.length < 2 || alternatives.some((alternative) => !alternative)) return undefined;
	const literalKeys = alternatives.map((alternative) => {
		const properties = asRecord(alternative?.properties);
		const keys = new Map<string, unknown>();
		for (const [key, property] of Object.entries(properties ?? {})) {
			const values = literalValues(property);
			if (values && values.length === 1) keys.set(key, values[0]);
		}
		return keys;
	});
	const shared = [...(literalKeys[0]?.keys() ?? [])].filter((key) => literalKeys.every((keys) => keys.has(key)));
	return shared.map((key) => ({
		key,
		alternatives: alternatives.map((alternative, index) => ({
			value: literalKeys[index]?.get(key),
			schema: alternative as Record<string, unknown>,
		})),
	}));
}

/**
 * Reports a failed union through the decision that failed instead of the sum of every branch's
 * complaints. TypeBox emits one error per alternative plus the union's own "must match a schema
 * in anyOf"; read literally that told a model calling `task_steps {}` that `steps` AND `id` were
 * required, that `action` had to equal each literal in turn, and that `{}` was "not an object".
 * For each union error whose branches also reported:
 * - a non-object value keeps only the union line (its expected type is the union's), dropping the
 *   per-branch "must be object" repeats;
 * - an object missing the discriminator keeps only that property's `required` error (narrowed to
 *   the discriminator, aggregated across branches into "required, one of …");
 * - an object whose discriminator matches no branch keeps one `enum` error at the discriminator
 *   listing every branch literal;
 * - a union without a discriminator keeps the branch errors and drops the union shell, which
 *   carried no information of its own.
 * Nested unions are handled the same way at their own instance path.
 */
function consolidateUnionErrors(
	errors: readonly TLocalizedValidationError[],
	schema: unknown,
	args: unknown,
): TLocalizedValidationError[] {
	const unions = errors.filter((error) => error.keyword === "anyOf" || error.keyword === "oneOf");
	if (unions.length === 0) return [...errors];
	const rewrite = new Map<TLocalizedValidationError, TLocalizedValidationError[]>();
	for (const union of unions) {
		const branchPrefix = `${union.schemaPath}/${union.keyword}/`;
		const children = errors.filter((error) => error.schemaPath.startsWith(branchPrefix));
		if (children.length === 0) continue;
		const unionSchema = asRecord(union.schemaPath === "#" ? schema : schemaAtPointer(schema, union.schemaPath));
		const pathSegments = instancePathBase(union) ? instancePathBase(union).split(".") : [];
		const received = asRecord(receivedValueAtPath(args, pathSegments));
		if (!received) {
			for (const child of children) {
				if (child.instancePath === union.instancePath && child.keyword === "type") rewrite.set(child, []);
			}
			continue;
		}
		rewrite.set(union, []);
		const discriminator = unionSchema ? unionDiscriminators(unionSchema)?.[0] : undefined;
		if (!discriminator) continue;
		if (!(discriminator.key in received)) {
			for (const child of children) {
				const narrowed =
					child.keyword === "required" && requiredMissingProperties(child).includes(discriminator.key)
						? [{ ...child, params: { requiredProperties: [discriminator.key] } } as TLocalizedValidationError]
						: [];
				rewrite.set(child, narrowed);
			}
			continue;
		}
		const keyPath = `${union.instancePath}/${discriminator.key}`;
		const literalErrors = children.filter(
			(child) => child.instancePath === keyPath && (child.keyword === "const" || child.keyword === "enum"),
		);
		const first = literalErrors[0];
		if (!first) continue;
		const allowedValues = dedupeSchemas(discriminator.alternatives.map((alternative) => alternative.value));
		for (const child of children) rewrite.set(child, []);
		rewrite.set(first, [
			{
				...first,
				keyword: "enum",
				schemaPath: `${union.schemaPath}/${union.keyword}`,
				params: { allowedValues },
				message: `must be one of ${formatAllowedValueList(allowedValues)}`,
			} as TLocalizedValidationError,
		]);
	}
	return errors.flatMap((error) => rewrite.get(error) ?? [error]);
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
	return values?.length ? formatAllowedValuesTypeLabel(values) : expectedTypeOf(schema);
}

function validationGuidance(error: TLocalizedValidationError, schema: unknown): string {
	const values = valuesFromValidationError(error, schema);
	if (values?.length) {
		const allowed = formatAllowedValueList(values);
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

function formatFailureLine(
	path: string,
	pathSegments: readonly string[],
	guidance: string,
	args: unknown,
	expectedSchema: unknown,
): string {
	const expectedFragment = formatCompactJson(compactSchemaFragment(expectedSchema), EXPECTED_FRAGMENT_MAX_LENGTH);
	const example = minimalExample(expectedSchema);
	const received = formatCompactJson(receivedValueAtPath(args, pathSegments), RECEIVED_VALUE_MAX_LENGTH);
	const exampleText =
		example === undefined ? "" : `; Example: ${formatCompactJson(example, RECEIVED_VALUE_MAX_LENGTH)}`;
	return `  - ${path}: ${guidance}; Expected schema: ${expectedFragment}${exampleText}; Received: ${received}`;
}

function formatValidationErrors(errors: readonly TLocalizedValidationError[], args: unknown, schema: unknown): string {
	const lines: string[] = [];
	for (const { path, schema: propertySchema } of requiredFailureEntries(errors, schema)) {
		lines.push(formatFailureLine(path, path.split("."), requiredGuidance(propertySchema), args, propertySchema));
	}
	for (const error of errors) {
		if (error.keyword === "required") continue;
		const path = formatValidationPath(error);
		const pathSegments = validationPathSegments(error);
		const expectedSchema = schemaAtValidationError(schema, error);
		lines.push(
			formatFailureLine(path, pathSegments, validationGuidance(error, expectedSchema), args, expectedSchema),
		);
	}
	return lines.join("\n") || "Unknown validation error";
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
	const validationErrors = normalizeValidationErrors([...branchValidator.Errors(args)]);
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

	// Repairs walk the raw validator errors (a branch's `type` error is what a repair keys on);
	// everything the model or telemetry reads speaks about the union decision that failed.
	const reportedErrors = consolidateUnionErrors(validationErrors, schema, toolCall.arguments);
	emitToolArgumentValidationTelemetry(options, {
		outcome: "bounced",
		tool: toolCall.name,
		source: toolCall.source,
		failureModes,
		repairsApplied: [],
		failureShape: formatFailureShape(reportedErrors, toolCall.arguments, schema),
		errorKeywords: errorKeywords(reportedErrors),
	});

	const errorMessage = `Validation failed for tool "${toolCall.name}":\n${formatValidationErrors(
		reportedErrors,
		toolCall.arguments,
		schema,
	)}\n\nReceived arguments:\n${truncateText(JSON.stringify(toolCall.arguments, null, 2), 2000)}`;

	throw new ToolArgumentValidationError(errorMessage, {
		toolName: toolCall.name,
		signature: validationFailureSignature(reportedErrors),
		enrichment: formatToolValidationEnrichment(tool),
	});
}
