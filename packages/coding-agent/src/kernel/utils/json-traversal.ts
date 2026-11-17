/** Iterative JSON serialization order shared by encoding and allocation-free length measurement. */
const isRawJson = (JSON as typeof JSON & { isRawJSON?: (value: unknown) => boolean }).isRawJSON;

interface ContainerFrame {
	value: object;
	/** Object keys are snapshotted once. Arrays visit indices lazily, including holes. */
	keys?: string[];
	length: number;
	index: number;
	wroteChild: boolean;
}

function prepareValue(value: unknown, key: string, unboxValue: (value: object) => unknown): unknown {
	if ((typeof value === "object" && value !== null) || typeof value === "function" || typeof value === "bigint") {
		const toJSON = (value as { toJSON?: unknown }).toJSON;
		if (typeof toJSON === "function") value = Reflect.apply(toJSON, value, [key]);
	}
	return value !== null && typeof value === "object" ? unboxValue(value) : value;
}

function createFrame(value: object): ContainerFrame {
	if (Array.isArray(value)) {
		// A proxy can supply a nonstandard length. JSON.stringify coerces it with ToLength.
		const length = +value.length;
		const normalizedLength = length > 0 ? Math.min(Math.floor(length), Number.MAX_SAFE_INTEGER) : 0;
		return { value, length: normalizedLength, index: 0, wroteChild: false };
	}
	const keys = Object.keys(value);
	return { value, keys, length: keys.length, index: 0, wroteChild: false };
}

/** Visit JSON in depth-first serialization order. Return false for an omitted root. */
export function visitJsonTokens(
	input: unknown,
	unboxValue: (value: object) => unknown,
	writeLiteral: (literal: string) => void,
	writeString: (unquoted: string) => void,
): boolean {
	const stack: ContainerFrame[] = [];
	const active = new Set<object>();
	let parent: ContainerFrame | undefined;
	let key = "";
	let value = prepareValue(input, key, unboxValue);
	while (true) {
		if (typeof value === "bigint") throw new TypeError("Do not know how to serialize a BigInt");
		const omitted = value === undefined || typeof value === "function" || typeof value === "symbol";
		if (omitted && !parent) return false;
		if (!omitted || !parent?.keys) {
			if (parent) {
				if (parent.wroteChild) writeLiteral(",");
				parent.wroteChild = true;
				if (parent.keys) {
					writeString(key);
					writeLiteral(":");
				}
			}
			if (value !== null && typeof value === "object") {
				if (isRawJson?.(value)) {
					writeLiteral((value as { rawJSON: string }).rawJSON);
				} else {
					if (active.has(value)) throw new TypeError("Converting circular structure to JSON");
					const frame = createFrame(value);
					active.add(value);
					stack.push(frame);
					writeLiteral(frame.keys ? "{" : "[");
				}
			} else if (typeof value === "string") {
				writeString(value);
			} else {
				writeLiteral(omitted ? "null" : JSON.stringify(value));
			}
		}
		parent = stack.at(-1);
		while (parent && parent.index === parent.length) {
			writeLiteral(parent.keys ? "}" : "]");
			active.delete(parent.value);
			stack.pop();
			parent = stack.at(-1);
		}
		if (!parent) return true;
		key = parent.keys ? parent.keys[parent.index]! : String(parent.index);
		parent.index++;
		value = prepareValue((parent.value as Record<string, unknown>)[key], key, unboxValue);
	}
}
