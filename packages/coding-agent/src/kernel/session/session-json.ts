/** Stack-safe JSON encoding for durable session rows, with the property semantics of JSON.stringify. */
import { types } from "node:util";
import { visitJsonTokens } from "../utils/json-traversal.ts";

const bigintValueOf = BigInt.prototype.valueOf;
const booleanValueOf = Boolean.prototype.valueOf;
function unboxSessionJsonValue(value: object): unknown {
	if (!types.isBoxedPrimitive(value)) return value;
	if (types.isNumberObject(value)) return +value;
	if (types.isStringObject(value)) return String(value);
	if (types.isBooleanObject(value)) return Reflect.apply(booleanValueOf, value, []);
	if (types.isBigIntObject(value)) return Reflect.apply(bigintValueOf, value, []);
	return value;
}

/** Encode in one pass so getters and toJSON run in order and once per occurrence. */
export function stringifySessionJson(input: unknown): string | undefined {
	let output = "";
	const written = visitJsonTokens(
		input,
		unboxSessionJsonValue,
		(token) => {
			output += token;
		},
		(value) => {
			output += JSON.stringify(value);
		},
	);
	return written ? output : undefined;
}
