/**
 * The live branch of a session as the history frontier needs to see it: where the leaf is, which
 * compaction is the latest one on the active ancestry, and whether one entry lies above another.
 *
 * Every answer comes from walking parent links through the session tree owner; nothing hydrates a
 * branch's messages. The walks are incremental: while the leaf only advances by appends, a sync walks
 * just the appended entries, and an ancestry answer, which can never change (entries are immutable),
 * is remembered. A leaf that is not a descendant of the previous one is a branch switch and bumps the
 * epoch, so a plan captured before the switch can tell it is no longer current.
 */

import type { SessionEntry } from "../../kernel/session/session-entries.ts";

export interface ActiveBranchSource {
	getLeafId(): string | null;
	getEntry(id: string): SessionEntry | undefined;
	getEntryCount(): number;
}

export interface ActiveBranchCompaction {
	/** The compaction entry on the active ancestry. */
	entryId: string;
	/** First entry the live context keeps; everything above it on the ancestry was compacted away. */
	firstKeptEntryId: string;
}

export interface ActiveBranchSnapshot {
	leafId: string | null;
	/** Increments whenever the leaf moves to something other than a descendant of the previous leaf. */
	epoch: number;
	/** The nearest compaction on the active ancestry, if any. */
	compaction: ActiveBranchCompaction | undefined;
}

/** The narrow view the memory controller reads. */
export interface ActiveBranchView {
	snapshot(): ActiveBranchSnapshot;
	/** Whether `ancestorId` is a strict ancestor of `entryId`. */
	isStrictAncestor(ancestorId: string, entryId: string): boolean;
	/** Whether `ancestorId` is `entryId` or one of its ancestors. */
	isAncestorOrSelf(ancestorId: string, entryId: string): boolean;
}

const MAX_REMEMBERED_ANCESTRY_ANSWERS = 512;

export class ActiveBranchProbe implements ActiveBranchView {
	private readonly source: ActiveBranchSource;
	private leafId: string | null | undefined;
	private epoch = 0;
	private compaction: ActiveBranchCompaction | undefined;
	private readonly answers = new Map<string, boolean>();

	constructor(source: ActiveBranchSource) {
		this.source = source;
	}

	snapshot(): ActiveBranchSnapshot {
		this.sync();
		return { leafId: this.leafId ?? null, epoch: this.epoch, compaction: this.compaction };
	}

	isStrictAncestor(ancestorId: string, entryId: string): boolean {
		if (ancestorId === entryId) return false;
		const key = `${ancestorId}>${entryId}`;
		const known = this.answers.get(key);
		if (known !== undefined) return known;
		let found = false;
		this.walk(this.source.getEntry(entryId)?.parentId ?? null, (id) => {
			if (id !== ancestorId) return true;
			found = true;
			return false;
		});
		this.remember(key, found);
		return found;
	}

	isAncestorOrSelf(ancestorId: string, entryId: string): boolean {
		return ancestorId === entryId || this.isStrictAncestor(ancestorId, entryId);
	}

	private remember(key: string, answer: boolean): void {
		this.answers.set(key, answer);
		if (this.answers.size > MAX_REMEMBERED_ANCESTRY_ANSWERS) {
			const oldest = this.answers.keys().next().value;
			if (oldest !== undefined) this.answers.delete(oldest);
		}
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
				nearest = { entryId: entry.id, firstKeptEntryId: entry.firstKeptEntryId };
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
