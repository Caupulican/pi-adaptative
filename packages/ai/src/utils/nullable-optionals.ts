/**
 * Optional tool parameters for an upstream that takes only strict function schemas, where every declared property
 * is required and "not set" has no spelling. `withNullableOptionals` gives it one (`null`); `dropNullOptionals`
 * takes it out of the arguments again, so the caller sees the arguments its own schema describes.
 */

import { isRecord } from "./value-guards.ts";

type JsonSchema = Record<string, unknown>;

const UNION_KEYS = ["anyOf", "oneOf", "allOf"] as const;
const NULL_SCHEMA: JsonSchema = { type: "null" };

function members(schema: JsonSchema, key: (typeof UNION_KEYS)[number]): JsonSchema[] {
	const list = schema[key];
	return Array.isArray(list) ? list.filter(isRecord) : [];
}

function requiredNames(schema: JsonSchema): Set<string> {
	return new Set(Array.isArray(schema.required) ? schema.required.filter((name) => typeof name === "string") : []);
}

/** Whether `null` is a valid value of the schema as written. */
function acceptsNull(schema: JsonSchema): boolean {
	if (schema.type === "null" || (Array.isArray(schema.type) && schema.type.includes("null"))) return true;
	if (schema.const === null) return true;
	if (Array.isArray(schema.enum) && schema.enum.includes(null)) return true;
	if (members(schema, "anyOf").some(acceptsNull) || members(schema, "oneOf").some(acceptsNull)) return true;
	const all = members(schema, "allOf");
	return all.length > 0 && all.every(acceptsNull);
}

/** The schema, widened so it also accepts `null`. */
function acceptingNull(schema: JsonSchema): JsonSchema {
	if (acceptsNull(schema)) return schema;
	if (Array.isArray(schema.enum)) {
		const type = typeof schema.type === "string" ? { type: [schema.type, "null"] } : {};
		return { ...schema, ...type, enum: [...schema.enum, null] };
	}
	if (typeof schema.type === "string" && schema.const === undefined) return { ...schema, type: [schema.type, "null"] };
	if (Array.isArray(schema.type) && schema.const === undefined) return { ...schema, type: [...schema.type, "null"] };
	for (const key of ["anyOf", "oneOf"] as const) {
		if (Array.isArray(schema[key])) return { ...schema, [key]: [...(schema[key] as unknown[]), NULL_SCHEMA] };
	}
	return { anyOf: [schema, NULL_SCHEMA] };
}

function nullableSchema(schema: JsonSchema): JsonSchema {
	const copy: JsonSchema = { ...schema };
	for (const key of UNION_KEYS) {
		if (Array.isArray(copy[key]))
			copy[key] = (copy[key] as unknown[]).map((m) => (isRecord(m) ? nullableSchema(m) : m));
	}
	if (isRecord(copy.items)) copy.items = nullableSchema(copy.items);
	else if (Array.isArray(copy.items)) copy.items = copy.items.map((m) => (isRecord(m) ? nullableSchema(m) : m));
	if (!isRecord(copy.properties)) return copy;

	const required = requiredNames(schema);
	const properties: JsonSchema = {};
	for (const [name, property] of Object.entries(copy.properties)) {
		if (!isRecord(property)) {
			properties[name] = property;
			continue;
		}
		const inner = nullableSchema(property);
		properties[name] = required.has(name) ? inner : acceptingNull(inner);
	}
	copy.properties = properties;
	copy.required = [...new Set([...requiredNames(schema), ...Object.keys(properties)])];
	return copy;
}

/**
 * A copy of a JSON Schema in which every optional property of every object schema also accepts `null` and is
 * listed in `required`. A property that already accepts `null` keeps its schema. The input is not changed.
 */
export function withNullableOptionals<T extends object>(schema: T): T {
	return nullableSchema(schema as JsonSchema) as T;
}

/** A schema and, through `anyOf`, `oneOf` and `allOf`, every schema nested in it: all that may describe one value. */
function describing(schema: JsonSchema): JsonSchema[] {
	return [schema, ...UNION_KEYS.flatMap((key) => members(schema, key).flatMap(describing))];
}

/**
 * Drops from `value` each `null` that no schema in `schemas` (the set that may describe it) objects to. A property's
 * `null` goes only if some schema of the set declares the property and every one that does makes it optional and
 * does not accept `null` for it; otherwise it stays for the caller's own validation.
 */
function dropFrom(value: unknown, schemas: readonly JsonSchema[]): unknown {
	if (Array.isArray(value)) {
		return value.map((item, index) =>
			dropFrom(
				item,
				schemas.flatMap((schema) => {
					const { items } = schema;
					const itemSchema = Array.isArray(items) ? items[index] : items;
					return isRecord(itemSchema) ? describing(itemSchema) : [];
				}),
			),
		);
	}
	if (!isRecord(value)) return value;

	const kept: Record<string, unknown> = {};
	for (const [name, entry] of Object.entries(value)) {
		const declared = schemas.flatMap((schema) => {
			const property = isRecord(schema.properties) ? schema.properties[name] : undefined;
			return isRecord(property) ? [{ property, optional: !requiredNames(schema).has(name) }] : [];
		});
		const removable = declared.length > 0 && declared.every((d) => d.optional && !acceptsNull(d.property));
		if (entry === null && removable) continue;
		kept[name] = dropFrom(
			entry,
			declared.flatMap((d) => describing(d.property)),
		);
	}
	return kept;
}

/**
 * The arguments without the `null` values of properties the original schema makes optional, through objects and
 * array items. A `null` under a required property, or under one the original schema accepts `null` for, stays.
 * The input is not changed.
 */
export function dropNullOptionals(args: Record<string, unknown>, schema: object): Record<string, unknown> {
	const result = dropFrom(args, describing(schema as JsonSchema));
	return isRecord(result) ? result : args;
}
