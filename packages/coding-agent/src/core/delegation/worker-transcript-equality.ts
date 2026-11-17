/** Stack-safe equality for worker transcript data and callback evidence. */
import { isDeepStrictEqual } from "node:util";

function enumerableKeys(value: object): (string | symbol)[] {
	return [
		...Object.keys(value),
		...Object.getOwnPropertySymbols(value).filter((key) => Object.prototype.propertyIsEnumerable.call(value, key)),
	];
}

/** Compare transcript data by value, preserving array order while ignoring object key order and non-enumerable stamps. */
export function equalWorkerTranscriptValues(left: unknown, right: unknown): boolean {
	const pending: [unknown, unknown][] = [[left, right]];
	const compared = new WeakMap<object, WeakSet<object>>();
	while (pending.length > 0) {
		const [a, b] = pending.pop()!;
		if (Object.is(a, b)) continue;
		if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
		const prototype = Object.getPrototypeOf(a);
		if (prototype !== Object.getPrototypeOf(b)) return false;
		if (Array.isArray(a)) {
			if (!Array.isArray(b) || a.length !== b.length) return false;
		} else if (Array.isArray(b)) {
			return false;
		} else if (prototype !== Object.prototype && prototype !== null) {
			// Callback arguments can still hold a non-JSON leaf before persistence normalization.
			if (!isDeepStrictEqual(a, b)) return false;
			continue;
		}
		let peers = compared.get(a);
		if (peers?.has(b)) continue;
		if (peers === undefined) {
			peers = new WeakSet<object>();
			compared.set(a, peers);
		}
		peers.add(b);
		const keys = enumerableKeys(a);
		if (keys.length !== enumerableKeys(b).length) return false;
		for (const key of keys) {
			if (!Object.prototype.propertyIsEnumerable.call(b, key)) return false;
			pending.push([Reflect.get(a, key), Reflect.get(b, key)]);
		}
	}
	return true;
}
