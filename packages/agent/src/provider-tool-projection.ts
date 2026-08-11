import type { Tool } from "@caupulican/pi-ai";
import type { TSchema } from "typebox";

/**
 * Provider-only tool projection.
 *
 * Execution and validation retain the authoritative AgentTool and full TypeBox schema. Providers
 * receive the same names, required fields, alternatives, defaults, and validation constraints, but
 * not recursive schema annotations already available through deterministic validation teaching.
 * This is one request-boundary path for native and text tool protocols.
 */

const OMITTED_SCHEMA_ANNOTATIONS = new Set([
	"$comment",
	"deprecated",
	"description",
	"examples",
	"readOnly",
	"title",
	"writeOnly",
]);
const SCHEMA_MAP_KEYS = new Set(["$defs", "definitions", "dependentSchemas", "patternProperties", "properties"]);
const SCHEMA_ARRAY_KEYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SCHEMA_SINGLE_KEYS = new Set([
	"additionalProperties",
	"contains",
	"else",
	"if",
	"items",
	"not",
	"propertyNames",
	"then",
	"unevaluatedItems",
	"unevaluatedProperties",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createProviderRecord(): Record<string, unknown> {
	// Null prototype preserves a legitimate schema property named "__proto__". Object.keys below
	// matches the JSON wire surface and never promotes TypeBox's non-enumerable ~kind/~optional data.
	return Object.create(null) as Record<string, unknown>;
}

function projectSchemaMap(value: unknown): unknown {
	if (!isRecord(value)) return value;
	const projected = createProviderRecord();
	for (const key of Object.keys(value)) {
		projected[key] = projectSchemaNode(value[key]);
	}
	return projected;
}

function isJsonPrimitive(value: unknown): value is string | number | boolean | null {
	return (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	);
}

function compactLiteralUnion(projected: Record<string, unknown>): Record<string, unknown> {
	const branches = projected.anyOf;
	if (!Array.isArray(branches) || branches.length < 2) return projected;
	const values: Array<string | number | boolean | null> = [];
	const types: string[] = [];
	const identities = new Set<string>();
	for (const branch of branches) {
		if (!isRecord(branch) || !Object.hasOwn(branch, "const") || !isJsonPrimitive(branch.const)) return projected;
		if (Object.keys(branch).some((key) => key !== "const" && key !== "type")) return projected;
		if (typeof branch.type !== "string") return projected;
		const identity = `${typeof branch.const}:${JSON.stringify(branch.const)}`;
		if (identities.has(identity)) return projected;
		identities.add(identity);
		values.push(branch.const);
		types.push(branch.type);
	}
	// Keep mixed-type or branch-constrained unions intact. A same-type primitive literal union is
	// validation-equivalent to type+enum and is supported by every provider already accepting enums.
	if (!types.every((type) => type === types[0])) return projected;

	const compacted = createProviderRecord();
	for (const key of Object.keys(projected)) {
		if (key !== "anyOf") compacted[key] = projected[key];
	}
	if (compacted.type === undefined) compacted.type = types[0];
	compacted.enum = values;
	return compacted;
}

function projectSchemaNode(value: unknown): unknown {
	if (!isRecord(value)) return value;
	const projected = createProviderRecord();
	for (const key of Object.keys(value)) {
		if (OMITTED_SCHEMA_ANNOTATIONS.has(key)) continue;
		const child = value[key];
		if (SCHEMA_MAP_KEYS.has(key)) {
			projected[key] = projectSchemaMap(child);
			continue;
		}
		if (SCHEMA_ARRAY_KEYS.has(key)) {
			projected[key] = Array.isArray(child) ? child.map(projectSchemaNode) : child;
			continue;
		}
		if (key === "dependencies" && isRecord(child)) {
			const dependencies = createProviderRecord();
			for (const dependencyKey of Object.keys(child)) {
				const dependency = child[dependencyKey];
				dependencies[dependencyKey] = Array.isArray(dependency) ? dependency : projectSchemaNode(dependency);
			}
			projected[key] = dependencies;
			continue;
		}
		if (SCHEMA_SINGLE_KEYS.has(key)) {
			projected[key] = Array.isArray(child) ? child.map(projectSchemaNode) : projectSchemaNode(child);
			continue;
		}
		projected[key] = child;
	}
	return compactLiteralUnion(projected);
}

export function normalizeProviderToolDescription(description: string): string {
	return description.replace(/\s+/g, " ").trim();
}

export function projectToolSchemaForProvider(schema: unknown): unknown {
	return projectSchemaNode(schema);
}

export function projectToolsForProvider(tools: undefined): undefined;
export function projectToolsForProvider(tools: readonly Tool[]): Tool[];
export function projectToolsForProvider(tools: readonly Tool[] | undefined): Tool[] | undefined;
export function projectToolsForProvider(tools: readonly Tool[] | undefined): Tool[] | undefined {
	if (!tools) return undefined;
	return tools.map((tool) => ({
		name: tool.name,
		description: normalizeProviderToolDescription(
			"providerDescription" in tool && typeof tool.providerDescription === "string"
				? tool.providerDescription
				: tool.description,
		),
		parameters: projectSchemaNode(tool.parameters) as TSchema,
	}));
}
