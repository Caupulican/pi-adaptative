import { Compile } from "typebox/compile";
import type { Tool } from "../types.ts";

const validatorCache = new WeakMap<object, ReturnType<typeof Compile>>();

/**
 * Compiles (and caches) the TypeBox validator for a tool's parameter schema.
 *
 * This is the ONE validator compile-cache for the repair layer (decision D3, tool-call-repair
 * doctrine): `validation.ts` and `repairer.ts` both import this instead of keeping a second cache over the same schema
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
