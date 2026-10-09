/**
 * The live branch of a session as the history frontier needs to see it: where the leaf is, which
 * compaction is the latest one on the active ancestry, and, per source entry, whether the live context
 * still shows it.
 *
 * The leaf and compaction come from walking parent links through the session tree owner; nothing hydrates a
 * branch's messages. The walks are incremental: while the leaf only advances by appends, a sync walks just
 * the appended entries. A leaf that is not a descendant of the previous one is a branch switch and bumps the
 * epoch, so a plan captured before the switch can tell it is no longer current.
 *
 * What the live context still shows after a compaction is not a cutoff: `original-user` retention keeps the
 * original user message and restored gap entries, and carried-forward records stay. That membership comes
 * from the kernel's one retention owner (`retainedEntryIdsBeforeCompaction`); this module only indexes it,
 * once per branch epoch and compaction, never restating a retention rule.
 */

import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import { retainedEntryIdsBeforeCompaction } from "../../kernel/session/session-manager.ts";

export interface ActiveBranchSource {
	getLeafId(): string | null;
	getEntry(id: string): SessionEntry | undefined;
	getEntryCount(): number;
	/** The active branch's entries, root first. */
	getBranch(): SessionEntry[];
}

export interface ActiveBranchCompaction {
	/** The compaction entry on the active ancestry. */
	entryId: string;
}

export interface ActiveBranchSnapshot {
	leafId: string | null;
	/** Increments whenever the leaf moves to something other than a descendant of the previous leaf. */
	epoch: number;
	/** The nearest compaction on the active ancestry, if any. */
	compaction: ActiveBranchCompaction | undefined;
	/**
	 * Identity of what the live context retains from before the latest compaction: it changes with a branch
	 * switch or a new compaction, never with appended entries. A view prepared under another revision is stale.
	 */
	retentionRevision: string;
}

/**
 * Whether the live context still shows one source entry after the latest compaction.
 * `compacted`: the entry is on the branch before the compaction and only its summary remains.
 * `visible`: the entry is verbatim in the live context (retained across the compaction, or after it).
 * `off_branch`: the entry is not on the active ancestry.
 */
export type ActiveBranchEntryStanding = "compacted" | "visible" | "off_branch";

/** The branch as of its latest compaction, answering the standing of any source entry. */
export interface ActiveBranchRetention {
	revision: string;
	standing(entryId: string): ActiveBranchEntryStanding;
}

/** The narrow view the memory controller reads. */
export interface ActiveBranchView {
	snapshot(): ActiveBranchSnapshot;
	/** The retention view of the latest compaction on the active branch; undefined while it has none. */
	retention(): ActiveBranchRetention | undefined;
}

interface RetentionIndex {
	revision: string;
	compactionEntryId: string;
	/** Ids positioned before the compaction entry on the branch. */
	before: ReadonlySet<string>;
	/** The subset of `before` the live context still emits. */
	retained: ReadonlySet<string>;
	/** Ids after the compaction entry, to the leaf the index last followed. */
	after: Set<string>;
	afterLeafId: string | null;
}

export class ActiveBranchProbe implements ActiveBranchView {
	private readonly source: ActiveBranchSource;
	private leafId: string | null | undefined;
	private epoch = 0;
	private compaction: ActiveBranchCompaction | undefined;
	private index: RetentionIndex | undefined;

	constructor(source: ActiveBranchSource) {
		this.source = source;
	}

	snapshot(): ActiveBranchSnapshot {
		this.sync();
		return {
			leafId: this.leafId ?? null,
			epoch: this.epoch,
			compaction: this.compaction,
			retentionRevision: this.revision(),
		};
	}

	retention(): ActiveBranchRetention | undefined {
		this.sync();
		const compaction = this.compaction;
		if (compaction === undefined) return undefined;
		const index = this.indexFor(compaction);
		this.followLeaf(index);
		return {
			revision: index.revision,
			standing: (entryId) => {
				if (index.before.has(entryId)) return index.retained.has(entryId) ? "visible" : "compacted";
				// The compaction entry itself and everything after it on this branch are in the live context.
				return entryId === index.compactionEntryId || index.after.has(entryId) ? "visible" : "off_branch";
			},
		};
	}

	private revision(): string {
		return `${this.epoch}:${this.compaction?.entryId ?? "none"}`;
	}

	private indexFor(compaction: ActiveBranchCompaction): RetentionIndex {
		const revision = this.revision();
		if (this.index?.revision === revision) return this.index;
		const path = this.source.getBranch();
		const position = path.findIndex((entry) => entry.id === compaction.entryId);
		const before = new Set<string>();
		for (let i = 0; i < position; i++) before.add((path[i] as SessionEntry).id);
		const after = new Set<string>();
		for (let i = position + 1; i < path.length; i++) after.add((path[i] as SessionEntry).id);
		this.index = {
			revision,
			compactionEntryId: compaction.entryId,
			before,
			retained: retainedEntryIdsBeforeCompaction(path),
			after,
			afterLeafId: this.leafId ?? null,
		};
		return this.index;
	}

	/** Entries appended since the index last followed the leaf join the live tail; nothing is rebuilt. */
	private followLeaf(index: RetentionIndex): void {
		const leaf = this.leafId ?? null;
		if (index.afterLeafId === leaf) return;
		this.walk(leaf, (id) => {
			if (id === index.afterLeafId || id === index.compactionEntryId) return false;
			index.after.add(id);
			return true;
		});
		index.afterLeafId = leaf;
	}

	/** Visit ancestors from `startId` upward (inclusive) while `visit` returns true; bounded by the entry count. */
	private walk(startId: string | null, visit: (id: string, entry: SessionEntry) => boolean): void {
		let remaining = this.source.getEntryCount() + 1;
		let id = startId;
		while (id !== null) {
			if (remaining-- === 0) throw new Error(`Invalid session entry graph: parent cycle detected at entry "${id}".`);
			const entry = this.source.getEntry(id);
			if (!entry) return;
			if (!visit(id, entry)) return;
			id = entry.parentId;
		}
	}

	private sync(): void {
		const leaf = this.source.getLeafId();
		if (leaf === this.leafId) return;
		const previous = this.leafId;
		let reachedPrevious = false;
		let nearest: ActiveBranchCompaction | undefined;
		this.walk(leaf, (id, entry) => {
			if (previous !== undefined && previous !== null && id === previous) {
				reachedPrevious = true;
				// Everything at and above the previous leaf is already summarized by the remembered compaction.
				return false;
			}
			if (nearest === undefined && entry.type === "compaction") {
				nearest = { entryId: entry.id };
			}
			return true;
		});
		if (reachedPrevious) {
			// An append: the nearest compaction is the newly appended one, else the one already known.
			this.compaction = nearest ?? this.compaction;
		} else {
			if (previous !== undefined) this.epoch += 1;
			this.compaction = nearest;
		}
		this.leafId = leaf;
	}
}
