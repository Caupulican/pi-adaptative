function jsonStringLength(value: string): number {
	let length = 2;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (
			code === 0x22 ||
			code === 0x5c ||
			code === 0x08 ||
			code === 0x09 ||
			code === 0x0a ||
			code === 0x0c ||
			code === 0x0d
		) {
			length += 2;
		} else if (code < 0x20) {
			length += 6;
		} else if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				length += 2;
				index++;
			} else {
				length += 6;
			}
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			length += 6;
		} else {
			length++;
		}
	}
	return length;
}

function measuredJsonValue(value: unknown, key: string, active: Set<object>): number | undefined {
	if (typeof value === "object" && value !== null) {
		const toJSON = Reflect.get(value, "toJSON");
		if (typeof toJSON === "function") value = Reflect.apply(toJSON, value, [key]) as unknown;
	}

	switch (typeof value) {
		case "string":
			return jsonStringLength(value);
		case "number":
			return Number.isFinite(value) ? (Object.is(value, -0) ? 1 : String(value).length) : 4;
		case "boolean":
			return value ? 4 : 5;
		case "bigint":
			throw new TypeError("Do not know how to serialize a BigInt");
		case "undefined":
		case "function":
		case "symbol":
			return undefined;
		case "object":
			break;
	}

	if (value === null) return 4;
	if (value instanceof String || value instanceof Number || value instanceof Boolean) {
		return measuredJsonValue(value.valueOf(), key, active);
	}
	if (active.has(value)) throw new TypeError("Converting circular structure to JSON");
	active.add(value);
	try {
		if (Array.isArray(value)) {
			let length = 2 + Math.max(0, value.length - 1);
			for (let index = 0; index < value.length; index++) {
				length += measuredJsonValue(value[index], String(index), active) ?? 4;
			}
			return length;
		}

		let length = 2;
		let fields = 0;
		for (const field of Object.keys(value)) {
			const fieldLength = measuredJsonValue(Reflect.get(value, field), field, active);
			if (fieldLength === undefined) continue;
			if (fields > 0) length++;
			length += jsonStringLength(field) + 1 + fieldLength;
			fields++;
		}
		return length;
	} finally {
		active.delete(value);
	}
}

/** Exact UTF-16 length of standard JSON-compatible data without constructing the serialized payload. */
export function measureJsonLength(value: unknown): number | undefined {
	return measuredJsonValue(value, "", new Set());
}
