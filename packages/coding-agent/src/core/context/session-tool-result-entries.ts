/** Branch-scoped tool-result provenance with immutable lookup snapshots for lazy context projections. */

import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import { resolveSessionEntryIndex, type SessionEntryIndex } from "../session-entry-index.ts";

type SessionToolResultEntrySource = Parameters<typeof resolveSessionEntryIndex>[0] & {
	getSessionId(): string;
	getBranch(): readonly SessionEntry[];
};

interface EntryVersion {
	readonly revision: number;
	readonly entryId: string;
}

interface BranchHistory {
	readonly versions: Map<string, EntryVersion[]>;
	revision: number;
}

/** Resolves exactly the tool results visible at the point in time this snapshot was captured. */
export class SessionToolResultEntrySnapshot {
	private readonly branch: BranchHistory;
	private readonly revision: number;

	constructor(branch: BranchHistory, revision: number) {
		this.branch = branch;
		this.revision = revision;
	}

	readonly resolve = (toolCallId: string): string | undefined => {
		const versions = this.branch.versions.get(toolCallId);
		if (!versions) return undefined;
		const latest = versions[versions.length - 1];
		if (latest.revision <= this.revision) return latest.entryId;

		let low = 0;
		let high = versions.length;
		while (low < high) {
			const mid = low + Math.floor((high - low) / 2);
			if (versions[mid].revision <= this.revision) low = mid + 1;
			else high = mid;
		}
		return versions[low - 1]?.entryId;
	};
}

interface BranchCursor {
	readonly source: SessionToolResultEntrySource;
	readonly sessionId: string;
	readonly leafId: string | null;
	readonly leaf: SessionEntry | undefined;
	readonly history: BranchHistory;
	readonly snapshot: SessionToolResultEntrySnapshot;
}

/** Tracks append deltas once per session branch, regardless of which transcript rows are currently visible. */
export class SessionToolResultEntries {
	private cursor: BranchCursor | undefined;

	reset(): void {
		this.cursor = undefined;
	}

	capture(source: SessionToolResultEntrySource): SessionToolResultEntrySnapshot {
		const index = resolveSessionEntryIndex(source);
		const sessionId = source.getSessionId();
		const previous = this.cursor;
		const leafId = index?.leafId;
		const leaf = index && leafId != null ? index.getEntry(leafId) : undefined;
		let traversedBranch: SessionEntry[] | undefined;
		if (index && previous?.source === source && previous.sessionId === sessionId) {
			if (previous.leafId === leafId && previous.leaf === leaf) return previous.snapshot;
			const previousLeaf = previous.leafId === null ? undefined : index.getEntry(previous.leafId);
			if (previousLeaf === previous.leaf) {
				const path = walkToPreviousLeaf(index, leaf, previous.leafId);
				if (path?.reachedPrevious) {
					const { history } = previous;
					const revision = history.revision;
					for (let i = path.entries.length - 1; i >= 0; i--) recordEntry(history, path.entries[i]);
					const snapshot =
						history.revision === revision
							? previous.snapshot
							: new SessionToolResultEntrySnapshot(history, history.revision);
					this.cursor = { source, sessionId, leafId: index.leafId, leaf, history, snapshot };
					return snapshot;
				}
				// On branch navigation the walk has already reached the root. Reuse it for the rebuild.
				traversedBranch = path?.entries.reverse();
			}
		}

		const history: BranchHistory = { versions: new Map(), revision: 0 };
		for (const entry of traversedBranch ?? source.getBranch()) recordEntry(history, entry);
		const snapshot = new SessionToolResultEntrySnapshot(history, history.revision);
		this.cursor =
			leafId === null || (leafId !== undefined && leaf)
				? { source, sessionId, leafId, leaf, history, snapshot }
				: undefined;
		return snapshot;
	}
}

function walkToPreviousLeaf(
	index: SessionEntryIndex,
	leaf: SessionEntry | undefined,
	previousLeafId: string | null,
): { entries: SessionEntry[]; reachedPrevious: boolean } | undefined {
	const entries: SessionEntry[] = [];
	const visited = new Set<string>();
	let id = index.leafId;
	let entry = leaf;
	while (id !== previousLeafId) {
		if (id === null) return { entries, reachedPrevious: false };
		if (!entry || entry.id !== id || visited.has(id)) return undefined;
		entries.push(entry);
		visited.add(id);
		id = entry.parentId;
		entry = id === previousLeafId || id === null ? undefined : index.getEntry(id);
	}
	return { entries, reachedPrevious: true };
}

function recordEntry(history: BranchHistory, entry: SessionEntry): void {
	if (entry.type !== "message" || entry.message.role !== "toolResult") return;
	const { toolCallId } = entry.message;
	let versions = history.versions.get(toolCallId);
	if (versions?.at(-1)?.entryId === entry.id) return;
	if (!versions) {
		versions = [];
		history.versions.set(toolCallId, versions);
	}
	history.revision++;
	versions.push({ revision: history.revision, entryId: entry.id });
}
