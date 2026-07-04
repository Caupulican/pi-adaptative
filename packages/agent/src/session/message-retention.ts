/**
 * Retention budget for tool result details kept in long-lived process memory.
 *
 * Tool result details are UI/log metadata, not provider-visible content. Large
 * graph/search payloads can otherwise accumulate (live appends, session resume,
 * scrollback components) until the interactive Node process hits the V8 heap limit.
 */
export const MAX_RETAINED_TOOL_RESULT_DETAILS_BYTES = 32 * 1024;

function estimateJsonLikeBytes(value: unknown, maxBytes: number): { bytes: number; exceeded: boolean } {
	const seen = new WeakSet<object>();
	let bytes = 0;
	const add = (amount: number): boolean => {
		bytes += amount;
		return bytes <= maxBytes;
	};
	const visit = (current: unknown): boolean => {
		if (bytes > maxBytes) return false;
		if (current === null) return add(4);
		if (current === undefined) return add(9);
		if (typeof current === "string") return add(current.length * 4 + 2);
		if (typeof current === "number") return add(24);
		if (typeof current === "boolean") return add(current ? 4 : 5);
		if (typeof current === "bigint") return add(current.toString().length + 2);
		if (typeof current === "symbol" || typeof current === "function") return add(12);
		if (typeof current !== "object") return add(8);

		const objectValue = current as Record<string, unknown>;
		if (seen.has(objectValue)) return add(20);
		seen.add(objectValue);
		if (Array.isArray(objectValue)) {
			if (!add(2)) return false;
			for (let index = 0; index < objectValue.length; index++) {
				if (!add(index === 0 ? 0 : 1)) return false;
				if (!visit(objectValue[index])) return false;
			}
			return bytes <= maxBytes;
		}

		if (!add(2)) return false;
		let first = true;
		for (const key in objectValue) {
			if (!Object.hasOwn(objectValue, key)) continue;
			if (!add((first ? 0 : 1) + key.length * 4 + 3)) return false;
			first = false;
			if (!visit(objectValue[key])) return false;
		}
		return bytes <= maxBytes;
	};
	visit(value);
	return { bytes, exceeded: bytes > maxBytes };
}

/**
 * Retention budget for tool result details kept by live TUI scrollback components.
 *
 * Larger than the session budget so deliberately bounded display payloads (e.g. the
 * bash tool's 50KB/2000-line output window) keep their designed expanded view, while
 * pathological multi-megabyte payloads still get stubbed.
 */
export const MAX_TUI_RETAINED_DETAILS_BYTES = 512 * 1024;

/** Replace oversized details on any retained holder with a small truncation stub. */
export function compactRetainedDetails(
	holder: { details?: unknown },
	maxBytes = MAX_RETAINED_TOOL_RESULT_DETAILS_BYTES,
): void {
	if (holder.details === undefined) return;
	const estimate = estimateJsonLikeBytes(holder.details, maxBytes);
	if (!estimate.exceeded) return;
	holder.details = {
		piToolResultDetailsTruncated: true,
		reason: "Tool result details exceeded retention budget; model-visible content was retained.",
		minimumBytes: estimate.bytes,
		maxRetainedBytes: maxBytes,
	};
}

/** Replace oversized tool result details with a small truncation stub. No-op for other roles. */
export function compactToolResultDetailsForRetention(message: { role: string; details?: unknown }): void {
	if (message.role !== "toolResult") return;
	compactRetainedDetails(message);
}
