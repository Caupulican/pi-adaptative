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
	byId: ReadonlyMap<string, T>,
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
): T[] {
	if (entries.length === 0 || leafId === null) return [];
	const byId = new Map<string, T>();
	for (const entry of entries) byId.set(entry.id, entry);
	const leaf = leafId === undefined ? entries[entries.length - 1] : byId.get(leafId);
	if (!leaf) return [];
	const branch: T[] = [];
	visitSessionAncestry(leaf, byId, (entry) => {
		branch.push(entry);
	});
	branch.reverse();
	return branch;
}
