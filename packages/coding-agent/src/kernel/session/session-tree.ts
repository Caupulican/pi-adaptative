/**
 * Walks session entry ancestry from a leaf to the root with parent-cycle detection and collects the active branch ending at a leaf.
 */
import type { SessionEntry } from "./session-entries.ts";
import type { FileEntry } from "./session-manager-types.ts";

export interface SessionTreeEntryLike {
	id: string;
	parentId: string | null;
}

export function invalidSessionParentCycle(entryId: string): Error {
	return new Error(`Invalid session entry graph: parent cycle detected at entry "${entryId}".`);
}

/** Visit one bounded leaf-to-root ancestry through the session tree owner. */
export function visitSessionAncestry<T extends SessionTreeEntryLike>(
	start: T | undefined,
	byId: Pick<ReadonlyMap<string, T>, "size" | "get">,
	visitor: (entry: T) => false | undefined,
): void {
	let current = start;
	let remainingEntries = byId.size + 1;
	while (current) {
		if (remainingEntries-- === 0) throw invalidSessionParentCycle(current.id);
		if (visitor(current) === false) return;
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
}

/** Return the active branch ending at a selected leaf, preserving ancestry order. */
export function collectSessionBranch<T extends SessionTreeEntryLike>(
	entries: readonly T[],
	leafId?: string | null,
	checkpoint?: () => void,
): T[] {
	if (entries.length === 0 || leafId === null) return [];
	const byId = new Map<string, T>();
	for (const entry of entries) {
		checkpoint?.();
		byId.set(entry.id, entry);
	}
	const leaf = leafId === undefined ? entries[entries.length - 1] : byId.get(leafId);
	if (!leaf) return [];
	const branch: T[] = [];
	visitSessionAncestry(leaf, byId, (entry) => {
		checkpoint?.();
		branch.push(entry);
	});
	branch.reverse();
	return branch;
}

/** Build the branch indexes of a cold file and reject ambiguous or cyclic entry identities. */
export function indexSessionTree(fileEntries: readonly FileEntry[]) {
	const entries: SessionEntry[] = [];
	const byId = new Map<string, SessionEntry>();
	const labelsById = new Map<string, string>();
	const labelTimestampsById = new Map<string, string>();
	let leafId: string | null = null;
	for (const entry of fileEntries) {
		if (entry.type === "session") continue;
		if (typeof entry.id !== "string" || entry.id.length === 0) {
			throw new Error("Invalid session entry graph: every entry requires a non-empty string id.");
		}
		if (byId.has(entry.id)) {
			throw new Error(`Invalid session entry graph: duplicate entry id "${entry.id}".`);
		}
		if (entry.parentId !== null && typeof entry.parentId !== "string") {
			throw new Error(`Invalid session entry graph: entry "${entry.id}" has a malformed parent id.`);
		}
		entries.push(entry);
		byId.set(entry.id, entry);
		leafId = entry.id;
		if (entry.type === "label") {
			if (entry.label) {
				labelsById.set(entry.targetId, entry.label);
				labelTimestampsById.set(entry.targetId, entry.timestamp);
			} else {
				labelsById.delete(entry.targetId);
				labelTimestampsById.delete(entry.targetId);
			}
		}
	}

	const settledEntryIds = new Set<string>();
	for (const entry of entries) {
		if (settledEntryIds.has(entry.id)) continue;
		const activeEntryIds = new Set<string>();
		const traversedEntryIds: string[] = [];
		visitSessionAncestry(entry, byId, (current) => {
			if (settledEntryIds.has(current.id)) return false;
			if (activeEntryIds.has(current.id)) {
				throw invalidSessionParentCycle(current.id);
			}
			activeEntryIds.add(current.id);
			traversedEntryIds.push(current.id);
		});
		for (const entryId of traversedEntryIds) settledEntryIds.add(entryId);
	}

	return { entries, byId, labelsById, labelTimestampsById, leafId };
}
