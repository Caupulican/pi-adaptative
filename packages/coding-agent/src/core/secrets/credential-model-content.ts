export type CredentialContentProjectionFailure = "accessor" | "cycle" | "collision";

export class CredentialContentProjectionError extends Error {
	readonly failure: CredentialContentProjectionFailure;

	constructor(failure: CredentialContentProjectionFailure) {
		super(`credential content projection failed: ${failure}`);
		this.failure = failure;
		this.name = "CredentialContentProjectionError";
	}
}

class CredentialContentNormalizationRequired extends Error {}

export type ContentPath = readonly (string | number)[];

/** Projects decoded provider content without serializing secrets into quoted or escaped text. */
export function redactCredentialContent<T>(
	value: T,
	redact: (text: string) => string,
	preserveKey?: (path: ContentPath, key: string) => boolean,
	preserveValue?: (path: ContentPath, value: object) => boolean,
): T {
	const path: (string | number)[] = [];
	const active = new WeakSet<object>();
	type Change = { readonly nextKey: PropertyKey; readonly nextValue: unknown };
	type Frame = {
		readonly value: object;
		readonly prototype: object | null;
		readonly ownKeys: readonly PropertyKey[];
		index: number;
		changes?: Map<PropertyKey, Change>;
		pending?: { readonly key: PropertyKey; readonly nextKey: PropertyKey; readonly original: unknown };
	};
	const stack: Frame[] = [];
	const enter = (current: object): Frame | undefined => {
		if (active.has(current)) throw new CredentialContentProjectionError("cycle");
		// An opaque value the caller keeps as is (an image, a transport signal) is decided before anything
		// else: a non-plain prototype would otherwise force the whole value through a JSON round trip,
		// which turns such an object into a plain one.
		if (preserveValue?.(path, current)) return undefined;
		const prototype = Object.getPrototypeOf(current);
		const array = Array.isArray(current);
		const typedArray = ArrayBuffer.isView(current);
		const date = prototype === Date.prototype;
		let toJSONOwner: object | null = current;
		while (toJSONOwner) {
			const descriptor = Object.getOwnPropertyDescriptor(toJSONOwner, "toJSON");
			if (descriptor) {
				if (!("value" in descriptor)) throw new CredentialContentProjectionError("accessor");
				if (typeof descriptor.value === "function") throw new CredentialContentNormalizationRequired();
				break;
			}
			toJSONOwner = Object.getPrototypeOf(toJSONOwner);
		}
		if (array && prototype !== Array.prototype) throw new CredentialContentNormalizationRequired();
		if (!typedArray && !array && !date && prototype !== Object.prototype && prototype !== null) {
			throw new CredentialContentNormalizationRequired();
		}
		const ownKeys = Reflect.ownKeys(current);
		for (const key of ownKeys) {
			const descriptor = Object.getOwnPropertyDescriptor(current, key);
			if (descriptor?.enumerable && !("value" in descriptor)) throw new CredentialContentNormalizationRequired();
			if (typedArray && descriptor?.enumerable && (typeof key !== "string" || !/^(0|[1-9]\d*)$/u.test(key))) {
				throw new CredentialContentNormalizationRequired();
			}
		}
		if (typedArray) return undefined;
		active.add(current);
		return { value: current, prototype, ownKeys, index: 0 };
	};
	try {
		let result: unknown = value;
		if (typeof result === "string") result = redact(result);
		else if (result && typeof result === "object") {
			const rootFrame = enter(result);
			if (rootFrame) stack.push(rootFrame);
		}
		while (stack.length > 0) {
			const frame = stack[stack.length - 1]!;
			let descended = false;
			while (frame.index < frame.ownKeys.length) {
				const key = frame.ownKeys[frame.index++]!;
				const descriptor = Object.getOwnPropertyDescriptor(frame.value, key);
				if (!descriptor?.enumerable) continue;
				const pathKey =
					Array.isArray(frame.value) && typeof key === "string" && /^(0|[1-9]\d*)$/u.test(key)
						? Number(key)
						: String(key);
				const keepKey =
					typeof key !== "string" ||
					(Array.isArray(frame.value) && typeof key === "string" && /^(0|[1-9]\d*)$/u.test(key)) ||
					preserveKey?.(path, key) === true;
				const nextKey = typeof key === "string" && !keepKey ? redact(key) : key;
				path.push(pathKey);
				const child = descriptor.value;
				if (typeof child === "string") {
					const nextValue = redact(child);
					if (nextKey !== key || nextValue !== child) {
						frame.changes ??= new Map();
						frame.changes.set(key, { nextKey, nextValue });
					}
					path.pop();
					continue;
				}
				if (!child || typeof child !== "object") {
					if (nextKey !== key) {
						frame.changes ??= new Map();
						frame.changes.set(key, { nextKey, nextValue: child });
					}
					path.pop();
					continue;
				}
				const childFrame = enter(child);
				if (childFrame) {
					frame.pending = { key, nextKey, original: child };
					stack.push(childFrame);
					descended = true;
					break;
				}
				if (nextKey !== key) {
					frame.changes ??= new Map();
					frame.changes.set(key, { nextKey, nextValue: child });
				}
				path.pop();
			}
			if (descended) continue;
			let projected: object = frame.value;
			if (frame.changes) {
				const resultingKeys = new Set<PropertyKey>();
				for (const key of frame.ownKeys) {
					const change = frame.changes.get(key);
					const nextKey = change?.nextKey ?? key;
					if (resultingKeys.has(nextKey)) throw new CredentialContentProjectionError("collision");
					resultingKeys.add(nextKey);
				}
				projected = Array.isArray(frame.value) ? [] : Object.create(frame.prototype);
				for (const key of frame.ownKeys) {
					const descriptor = Object.getOwnPropertyDescriptor(frame.value, key);
					if (!descriptor) continue;
					const change = frame.changes.get(key);
					Object.defineProperty(
						projected,
						change?.nextKey ?? key,
						change ? { ...descriptor, value: change.nextValue } : descriptor,
					);
				}
			}
			active.delete(frame.value);
			stack.pop();
			if (stack.length === 0) {
				result = projected;
				break;
			}
			const parent = stack[stack.length - 1]!;
			const pending = parent.pending!;
			parent.pending = undefined;
			if (pending.nextKey !== pending.key || projected !== pending.original) {
				parent.changes ??= new Map();
				parent.changes.set(pending.key, { nextKey: pending.nextKey, nextValue: projected });
			}
			path.pop();
		}
		return result as T;
	} catch (error) {
		if (!(error instanceof CredentialContentNormalizationRequired)) throw error;
		const normalized = JSON.stringify(value);
		if (normalized === undefined) return undefined as T;
		return redactCredentialContent(JSON.parse(normalized), redact, preserveKey, preserveValue);
	}
}
