import type { ResourceProfileFilterSettings } from "./settings-manager.ts";

/**
 * Decode a stored allow/block filter into the set of enabled resource ids,
 * given the full universe of ids for that kind.
 *  - undefined / empty filter           -> all enabled
 *  - block contains "*"                  -> none enabled
 *  - allow non-empty                     -> exactly the allow entries that exist in allIds
 *  - block of specific ids (no "*")      -> all ids except blocked ones
 * (If both allow and block specific ids are present: start from allow-or-all, then remove blocked.)
 */
export function decodeResourceSelection(
	filter: ResourceProfileFilterSettings | undefined,
	allIds: string[],
): Set<string> {
	// Strict UAC: an unmentioned kind is DENIED — decoding it as "all enabled" would both
	// lie in the editor UI and, on save, convert silent denial into an explicit grant-all.
	if (!filter) {
		return new Set();
	}

	// If block contains "*", nothing is enabled
	if (filter.block?.includes("*")) {
		return new Set();
	}

	// Explicit grant-all: every id enabled except explicitly blocked ones.
	if (filter.allow?.includes("*")) {
		const blocked = new Set(filter.block ?? []);
		return new Set(allIds.filter((id) => !blocked.has(id)));
	}

	// If allow is specified, start with the allow list filtered to valid IDs
	if (filter.allow && filter.allow.length > 0) {
		const allIdsSet = new Set(allIds);
		const enabled = new Set<string>();
		for (const id of filter.allow) {
			if (allIdsSet.has(id)) {
				enabled.add(id);
			}
		}
		// If block is also specified, remove blocked ids
		if (filter.block && filter.block.length > 0) {
			const blockSet = new Set(filter.block);
			for (const id of Array.from(enabled)) {
				if (blockSet.has(id)) {
					enabled.delete(id);
				}
			}
		}
		return enabled;
	}

	// No allow specified, start with all ids
	const enabled = new Set(allIds);
	// Remove any blocked ids
	if (filter.block && filter.block.length > 0) {
		const blockSet = new Set(filter.block);
		for (const id of allIds) {
			if (blockSet.has(id)) {
				enabled.delete(id);
			}
		}
	}
	return enabled;
}

/**
 * Encode an enabled set back into a filter.
 *  - all enabled            -> undefined (caller omits the kind)
 *  - some but not all       -> { allow: [...enabled, in allIds order] }
 *  - none enabled           -> { block: ["*"] }
 */
export function encodeResourceSelection(
	enabled: Set<string>,
	allIds: string[],
): ResourceProfileFilterSettings | undefined {
	const allIdsSet = new Set(allIds);

	// Count how many enabled ids are actually in allIds
	let validEnabledCount = 0;
	for (const id of enabled) {
		if (allIdsSet.has(id)) {
			validEnabledCount++;
		}
	}

	// All enabled: grant-all must be said OUT LOUD under strict UAC — omitting the kind
	// (returning undefined) would mean deny-all, silently corrupting a fully-granted kind.
	if (allIds.length > 0 && validEnabledCount === allIds.length) {
		return { allow: ["*"] };
	}
	if (allIds.length === 0) {
		return undefined;
	}

	// None enabled: return { block: ["*"] }
	if (validEnabledCount === 0) {
		return { block: ["*"] };
	}

	// Some but not all: return { allow: [...enabled, in allIds order] }
	const allow: string[] = [];
	for (const id of allIds) {
		if (enabled.has(id)) {
			allow.push(id);
		}
	}
	return { allow };
}

export type ResourceFraming = "allow" | "block";

/**
 * Detect the framing of a given resource profile filter settings.
 */
export function detectResourceFraming(filter: ResourceProfileFilterSettings | undefined): ResourceFraming {
	if (!filter) {
		return "block";
	}
	if (filter.allow && filter.allow.length > 0) {
		return "allow";
	}
	if (filter.block && filter.block.length > 0) {
		if (filter.block.includes("*")) {
			return "allow";
		}
		return "block";
	}
	return "block";
}

/**
 * Encode an enabled set back into a filter, respecting the specified framing.
 */
export function encodeResourceSelectionWithFraming(
	enabled: Set<string>,
	allIds: string[],
	framing: ResourceFraming,
): ResourceProfileFilterSettings | undefined {
	if (framing === "allow") {
		return encodeResourceSelection(enabled, allIds);
	}

	const allIdsSet = new Set(allIds);
	let validEnabledCount = 0;
	for (const id of enabled) {
		if (allIdsSet.has(id)) {
			validEnabledCount++;
		}
	}

	// All enabled: explicit grant-all (see encodeResourceSelection — undefined means DENIED).
	if (allIds.length > 0 && validEnabledCount === allIds.length) {
		return { allow: ["*"] };
	}
	if (allIds.length === 0) {
		return undefined;
	}

	// None enabled: return { block: ["*"] }
	if (validEnabledCount === 0) {
		return { block: ["*"] };
	}

	// Block framing with subset disabled: list disabled ids in block
	const block: string[] = [];
	for (const id of allIds) {
		if (!enabled.has(id)) {
			block.push(id);
		}
	}
	return { block };
}
