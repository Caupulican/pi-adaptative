import type { Message } from "@caupulican/pi-ai";
import { measureJsonStringUtf8Bytes } from "../../kernel/provider-request-estimator.ts";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import { parseWorkerControlRecord } from "../../kernel/worker-control-stamp.ts";
import { INLINE_WORKER_MESSAGE_CHARS } from "./worker-agent-message-options.ts";

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

/** Preserve the bounded terminal recovery window when a host-stamped user entry carries a long task or follow-up. */
export function workerRecoveryEntryCharge(
	entry: Readonly<SessionEntry>,
	persistedBytes: number | undefined,
	remainingBytes: number,
	remainingBodyChars: number,
): { bytes: number; bodyChars: number } {
	const control =
		entry.type === "message" && entry.message.role === "user"
			? parseWorkerControlRecord(entry.workerControl)
			: undefined;
	const body = control?.k === "host_event" ? undefined : control?.body;
	const chars = body === undefined ? 0 : body.to - body.from;
	const eligible = chars > INLINE_WORKER_MESSAGE_CHARS && chars <= remainingBodyChars;
	const limit = remainingBytes + (eligible ? 6 * chars : 0);
	const size = persistedBytes ?? boundedTranscriptJsonBytes(entry, limit);
	if (size > limit || !eligible || !body || entry.type !== "message" || entry.message.role !== "user")
		return { bytes: size, bodyChars: 0 };
	const content = entry.message.content;
	if (typeof content !== "string" || body.to > content.length) return { bytes: size, bodyChars: 0 };
	// The range excludes both the prompt framing and file grants that follow the request.
	const encodedBodyBytes = measureJsonStringUtf8Bytes(content.slice(body.from, body.to)) - 2;
	return { bytes: size - encodedBodyBytes, bodyChars: chars };
}
