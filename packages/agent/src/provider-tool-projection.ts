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

function compactDiscriminatedUnion(projected: Record<string, unknown>): Record<string, unknown> {
	const branches = projected.anyOf;
	if (!Array.isArray(branches) || branches.length < 2 || !branches.every(isRecord)) return projected;
	const firstProperties = branches[0].properties;
	if (!isRecord(firstProperties)) return projected;
	for (const discriminator of Object.keys(firstProperties)) {
		const groups = new Map<string, { branch: Record<string, unknown>; values: unknown[] }>();
		let eligible = true;
		for (const branch of branches) {
			const properties = branch.properties;
			const literal = isRecord(properties) ? properties[discriminator] : undefined;
			if (
				!isRecord(properties) ||
				!isRecord(literal) ||
				!Object.hasOwn(literal, "const") ||
				!isJsonPrimitive(literal.const) ||
				Object.keys(literal).some((key) => key !== "const" && key !== "type")
			) {
				eligible = false;
				break;
			}
			const { const: value, ...constraints } = literal;
			// Compare every other constraint exactly. Only anyOf permits folding overlapping
			// branches; oneOf's exclusive-match semantics must remain untouched.
			const shape = { ...branch, properties: { ...properties, [discriminator]: constraints } };
			const key = JSON.stringify(shape);
			const group = groups.get(key);
			if (group) group.values.push(value);
			else groups.set(key, { branch, values: [value] });
		}
		if (!eligible || groups.size === branches.length) continue;
		return {
			...projected,
			anyOf: [...groups.values()].map(({ branch, values }) => {
				if (values.length === 1) return branch;
				const properties = branch.properties as Record<string, Record<string, unknown>>;
				const { const: _value, ...constraints } = properties[discriminator];
				return {
					...branch,
					properties: { ...properties, [discriminator]: { ...constraints, enum: [...new Set(values)] } },
				};
			}),
		};
	}
	return projected;
}

function compactRedundantEnumConstraints(projected: Record<string, unknown>): Record<string, unknown> {
	const values = projected.enum;
	if (!Array.isArray(values) || values.length === 0 || !values.every(isJsonPrimitive)) return projected;
	// `type` is never dropped here even though every enum value satisfies it: providers whose
	// function-declaration schema requires `type` per property (e.g. Google's OpenAPI subset)
	// reject the entire tool list with a 400 if it is missing. minLength/maxLength stay safe to
	// drop because they constrain the value's shape, not its provider-required schema kind.
	if (values.every((value): value is string => typeof value === "string")) {
		const minLength = projected.minLength;
		if (typeof minLength === "number" && values.every((value) => value.length >= minLength)) {
			delete projected.minLength;
		}
		const maxLength = projected.maxLength;
		if (typeof maxLength === "number" && values.every((value) => value.length <= maxLength)) {
			delete projected.maxLength;
		}
	}
	return projected;
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
	// Some providers require an explicit object kind even when every union branch already
	// guarantees it. Retain the alternatives verbatim; never narrow mixed or untyped branches.
	if (
		projected.type === undefined &&
		Array.isArray(projected.anyOf) &&
		projected.anyOf.length > 0 &&
		projected.anyOf.every((branch) => isRecord(branch) && branch.type === "object")
	) {
		projected.type = "object";
	}
	return compactRedundantEnumConstraints(compactDiscriminatedUnion(compactLiteralUnion(projected)));
}

interface UnionBranch {
	/** Discriminator literals for this branch; empty when the union has no literal discriminator. */
	values: string[];
	properties: Record<string, unknown>;
	required: string[];
}

function branchDiscriminatorValues(branch: Record<string, unknown>, key: string): string[] | undefined {
	const properties = branch.properties;
	const literal = isRecord(properties) ? properties[key] : undefined;
	if (!isRecord(literal) || literal.type !== "string") return undefined;
	if (typeof literal.const === "string") return [literal.const];
	if (Array.isArray(literal.enum) && literal.enum.every((value) => typeof value === "string")) {
		return literal.enum as string[];
	}
	return undefined;
}

function branchRequired(branch: Record<string, unknown>): string[] {
	return Array.isArray(branch.required)
		? branch.required.filter((name): name is string => typeof name === "string")
		: [];
}

/** Every branch an object with properties; a shared string-literal key, when one exists, is the discriminator. */
function readObjectUnion(
	branches: readonly Record<string, unknown>[],
): { discriminator?: string; branches: UnionBranch[] } | undefined {
	if (!branches.every((branch) => branch.type === "object" && isRecord(branch.properties))) return undefined;
	const firstProperties = branches[0]?.properties;
	if (isRecord(firstProperties)) {
		for (const discriminator of Object.keys(firstProperties)) {
			const read: UnionBranch[] = [];
			for (const branch of branches) {
				const values = branchDiscriminatorValues(branch, discriminator);
				if (!values) break;
				read.push({
					values,
					properties: branch.properties as Record<string, unknown>,
					required: branchRequired(branch),
				});
			}
			if (read.length === branches.length) return { discriminator, branches: read };
		}
	}
	return {
		branches: branches.map((branch) => ({
			values: [],
			properties: branch.properties as Record<string, unknown>,
			required: branchRequired(branch),
		})),
	};
}

/**
 * Providers that speak the OpenAI function-calling dialect expect one flat object schema per
 * function. A root-level `anyOf` of object branches is read by some models as separate functions
 * (`task_steps` × `set`) or answered with empty arguments (`write`), which surfaces as invented
 * tool names and repeated validation bounces. The wire schema therefore becomes one object: a
 * literal discriminator carries every action as an enum, every branch property is merged
 * (differing shapes become a property-level anyOf), and only properties required by every branch
 * stay required. Per-branch requirements travel in the description; validation keeps the union.
 */
function flattenRootObjectUnion(projected: Record<string, unknown>): {
	schema: Record<string, unknown>;
	guidance?: string;
} {
	const branches = projected.anyOf;
	if (!Array.isArray(branches) || branches.length < 2 || !branches.every(isRecord)) return { schema: projected };
	const read = readObjectUnion(branches);
	if (!read) return { schema: projected };
	const { discriminator } = read;
	const values: string[] = [];
	const shapes = new Map<string, { schemas: unknown[]; identities: Set<string> }>();
	let sharedRequired: Set<string> | undefined;
	const guidance: string[] = [];
	for (const branch of read.branches) {
		for (const value of branch.values) if (!values.includes(value)) values.push(value);
		for (const key of Object.keys(branch.properties)) {
			if (key === discriminator) continue;
			const shape = shapes.get(key) ?? { schemas: [], identities: new Set<string>() };
			const identity = JSON.stringify(branch.properties[key]);
			if (!shape.identities.has(identity)) {
				shape.identities.add(identity);
				shape.schemas.push(branch.properties[key]);
			}
			shapes.set(key, shape);
		}
		const required = branch.required.filter((name) => name !== discriminator);
		sharedRequired = sharedRequired
			? new Set(required.filter((name) => sharedRequired?.has(name)))
			: new Set(required);
		const optional = Object.keys(branch.properties).filter((key) => key !== discriminator && !required.includes(key));
		if (discriminator) {
			const label = branch.values.map((value) => JSON.stringify(value)).join(" | ");
			const parts = [
				...(required.length > 0 ? [`requires ${required.join(", ")}`] : []),
				...(optional.length > 0 ? [`accepts ${optional.join(", ")}`] : []),
			];
			guidance.push(`${label} ${parts.length > 0 ? parts.join(", ") : "takes no other arguments"}`);
		} else {
			const head = required.length > 0 ? required.join(", ") : "no required arguments";
			guidance.push(optional.length > 0 ? `${head} (accepts ${optional.join(", ")})` : head);
		}
	}
	const properties = createProviderRecord();
	if (discriminator) properties[discriminator] = { type: "string", enum: values };
	for (const [key, shape] of shapes) {
		properties[key] = shape.schemas.length === 1 ? shape.schemas[0] : { anyOf: shape.schemas };
	}
	const schema = createProviderRecord();
	for (const key of Object.keys(projected)) {
		if (key !== "anyOf" && key !== "type" && key !== "properties" && key !== "required") schema[key] = projected[key];
	}
	schema.type = "object";
	schema.properties = properties;
	const required = [...(discriminator ? [discriminator] : []), ...(sharedRequired ?? [])];
	if (required.length > 0) schema.required = required;
	return {
		schema,
		guidance: discriminator
			? `Arguments by ${discriminator}: ${guidance.join("; ")}.`
			: `Accepted argument sets: ${guidance.join("; ")}.`,
	};
}

export function normalizeProviderToolDescription(description: string): string {
	return description.replace(/\s+/g, " ").trim();
}

export function projectToolSchemaForProvider(schema: unknown): unknown {
	const projected = projectSchemaNode(schema);
	return isRecord(projected) ? flattenRootObjectUnion(projected).schema : projected;
}

/**
 * Projections by source tool identity. A tool definition is projected on every provider request,
 * and a tool surface of a few dozen schemas is tens of kilobytes of schema walking per request for
 * the same answer. Memoizing by the source object also makes the projected object itself stable
 * across requests, which is what lets everything downstream that keys on it -- the request
 * estimator, the request fingerprint -- memoize per tool instead of re-measuring the surface.
 * Tool definitions are treated as immutable once registered, as they are everywhere else.
 */
const projectedTools = new WeakMap<Tool, Tool>();

function projectToolForProvider(tool: Tool): Tool {
	const cached = projectedTools.get(tool);
	if (cached) return cached;
	const projectedSchema = projectSchemaNode(tool.parameters);
	const root: { schema: unknown; guidance?: string } = isRecord(projectedSchema)
		? flattenRootObjectUnion(projectedSchema)
		: { schema: projectedSchema };
	const description = normalizeProviderToolDescription(
		"providerDescription" in tool && typeof tool.providerDescription === "string"
			? tool.providerDescription
			: tool.description,
	);
	const projected: Tool = {
		name: tool.name,
		description: root.guidance ? `${description} ${root.guidance}` : description,
		parameters: root.schema as TSchema,
	};
	projectedTools.set(tool, projected);
	return projected;
}

export function projectToolsForProvider(tools: undefined): undefined;
export function projectToolsForProvider(tools: readonly Tool[]): Tool[];
export function projectToolsForProvider(tools: readonly Tool[] | undefined): Tool[] | undefined;
export function projectToolsForProvider(tools: readonly Tool[] | undefined): Tool[] | undefined {
	if (!tools) return undefined;
	return tools.map(projectToolForProvider);
}
