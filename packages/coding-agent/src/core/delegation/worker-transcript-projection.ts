import type { Message } from "@caupulican/pi-ai";
import { measureJsonStringUtf8Bytes } from "../../kernel/provider-request-estimator.ts";

/** Inspection excludes provider replay signatures, never similarly named user/tool arguments. */
export function projectWorkerTranscriptForInspection(message: Message): Message {
	if (message.role !== "assistant") return message;
	return {
		...message,
		content: message.content.map((block) => {
			switch (block.type) {
				case "text": {
					const { textSignature: _signature, ...content } = block;
					return content;
				}
				case "thinking": {
					const { thinkingSignature: _signature, ...content } = block;
					return content;
				}
				case "toolCall": {
					const { thoughtSignature: _signature, ...content } = block;
					return content;
				}
				default:
					throw new TypeError("Unsupported worker transcript content.");
			}
		}),
	};
}

/** Conservative JSON byte measurement that stops before an oversized message is cloned. */
export function boundedTranscriptJsonBytes(value: unknown, limit: number): number {
	const pending: unknown[] = [value];
	const seen = new WeakSet<object>();
	let bytes = 0;
	const add = (count: number): boolean => {
		bytes += count;
		return bytes <= limit;
	};
	while (pending.length > 0) {
		const item = pending.pop();
		if (item === null) {
			if (!add(4)) return limit + 1;
			continue;
		}
		switch (typeof item) {
			case "string":
				if (!add(measureJsonStringUtf8Bytes(item, limit - bytes))) return limit + 1;
				continue;
			case "number":
				if (!add(Number.isFinite(item) ? String(item).length : 4)) return limit + 1;
				continue;
			case "boolean":
				if (!add(item ? 4 : 5)) return limit + 1;
				continue;
			case "undefined":
			case "function":
			case "symbol":
			case "bigint":
				if (!add(4)) return limit + 1;
				continue;
			case "object":
				break;
		}
		if (seen.has(item)) return limit + 1;
		seen.add(item);
		if (Array.isArray(item)) {
			if (!add(2 + Math.max(0, item.length - 1))) return limit + 1;
			for (let index = item.length - 1; index >= 0; index -= 1) pending.push(item[index]);
			continue;
		}
		const prototype = Object.getPrototypeOf(item);
		if (prototype !== Object.prototype && prototype !== null) return limit + 1;
		if (!add(2)) return limit + 1;
		let propertyCount = 0;
		for (const key in item) {
			if (!Object.hasOwn(item, key)) continue;
			const descriptor = Object.getOwnPropertyDescriptor(item, key);
			if (!descriptor || !("value" in descriptor)) return limit + 1;
			const propertyValue = descriptor.value;
			if (propertyValue === undefined || typeof propertyValue === "function" || typeof propertyValue === "symbol") {
				continue;
			}
			if (propertyCount > 0 && !add(1)) return limit + 1;
			propertyCount += 1;
			if (!add(measureJsonStringUtf8Bytes(key, limit - bytes) + 1)) return limit + 1;
			pending.push(propertyValue);
		}
	}
	return bytes;
}
