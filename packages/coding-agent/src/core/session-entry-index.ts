import type { SessionEntry, SessionManager } from "@caupulican/pi-agent-core/node";

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
