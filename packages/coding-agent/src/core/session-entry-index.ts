import type { CompactionEntry, SessionEntry, SessionManager } from "@caupulican/pi-agent-core/node";

export interface SessionEntryIndex {
	leafId: string | null;
	getEntry(id: string): SessionEntry | undefined;
}

/** Resolve the optional indexed branch adapter used by narrow SessionManager test and embedding seams. */
export function resolveSessionEntryIndex(sessionManager: SessionManager): SessionEntryIndex | undefined {
	const candidate = sessionManager as unknown as {
		getLeafId?: () => string | null | undefined;
		getEntry?: (id: string) => SessionEntry | undefined;
	};
	const getLeafId = candidate.getLeafId;
	const getEntry = candidate.getEntry;
	if (!getLeafId || !getEntry) return undefined;
	const leafId = getLeafId.call(sessionManager);
	if (leafId === undefined) return undefined;
	return {
		leafId,
		getEntry: (id) => getEntry.call(sessionManager, id),
	};
}

/**
 * The latest compaction entry on the current branch, remembered per leaf. Entries append at the
 * leaf, so the next lookup walks only what was appended since the remembered leaf; reaching the
 * root without meeting that leaf means a different branch, and the full walk was the answer.
 * Walking from the leaf on every request grew with the branch: with no compaction yet, it was the
 * whole session, twice per request.
 */
export class LatestCompactionEntryScan {
	private remembered: { leafId: string; entry: CompactionEntry | null } | undefined;

	reset(): void {
		this.remembered = undefined;
	}

	find(index: SessionEntryIndex): CompactionEntry | null {
		const leafId = index.leafId;
		if (leafId === null) {
			this.remembered = undefined;
			return null;
		}
		const remembered = this.remembered;
		let entry = index.getEntry(leafId);
		let found: CompactionEntry | null = null;
		let reachedRemembered = false;
		while (entry) {
			if (remembered && entry.id === remembered.leafId) {
				reachedRemembered = true;
				break;
			}
			if (entry.type === "compaction") {
				found = entry;
				break;
			}
			entry = entry.parentId === null ? undefined : index.getEntry(entry.parentId);
		}
		if (remembered && reachedRemembered) found = remembered.entry;
		this.remembered = { leafId, entry: found };
		return found;
	}
}
