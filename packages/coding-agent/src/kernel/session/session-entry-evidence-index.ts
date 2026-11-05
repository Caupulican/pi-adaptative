import { type ParentInputEvidenceQuery, parentInputEvidenceMetadata } from "./parent-input-ledger.ts";
import type { SessionEntry } from "./session-entries.ts";

export const MAX_SESSION_EVIDENCE_ENTRIES = 1_000_000;
const MAX_EVIDENCE_RESULTS = 64;
const MAX_INDEXED_EVIDENCE_KEYS = 2_000_000;
export const MAX_SESSION_EVIDENCE_ID_CHARS = 512;

/** Invalid legacy links remain readable as history, but cannot establish a valid lineage. */
export function sessionEvidenceParentId(entry: SessionEntry): string | null | undefined {
	if (entry.parentId === null) return null;
	return typeof entry.parentId === "string" &&
		entry.parentId.length > 0 &&
		entry.parentId.length <= MAX_SESSION_EVIDENCE_ID_CHARS
		? entry.parentId
		: undefined;
}

interface EvidenceLink {
	readonly id: string;
	readonly next?: EvidenceLink;
}

interface EvidenceTree {
	readonly key: string;
	readonly value: EvidenceLink;
	readonly left?: EvidenceTree;
	readonly right?: EvidenceTree;
	readonly height: number;
}

interface IndexedEntry {
	readonly id: string;
	readonly parentId: string | null | undefined;
	readonly keys: readonly string[];
	lineage?: {
		readonly root: string;
		readonly depth: number;
		readonly ancestors: readonly IndexedEntry[];
		readonly evidence?: EvidenceTree;
	};
}

function treeNode(key: string, value: EvidenceLink, left?: EvidenceTree, right?: EvidenceTree): EvidenceTree {
	return { key, value, left, right, height: 1 + Math.max(left?.height ?? 0, right?.height ?? 0) };
}

function rotateLeft(node: EvidenceTree): EvidenceTree {
	const right = node.right!;
	return treeNode(right.key, right.value, treeNode(node.key, node.value, node.left, right.left), right.right);
}

function rotateRight(node: EvidenceTree): EvidenceTree {
	const left = node.left!;
	return treeNode(left.key, left.value, left.left, treeNode(node.key, node.value, left.right, node.right));
}

/** Path copying retains each branch's own nearest evidence without a full map copy on append. */
function setEvidence(tree: EvidenceTree | undefined, key: string, value: EvidenceLink): EvidenceTree {
	if (!tree) return treeNode(key, value);
	if (key === tree.key) return treeNode(key, value, tree.left, tree.right);
	let next =
		key < tree.key
			? treeNode(tree.key, tree.value, setEvidence(tree.left, key, value), tree.right)
			: treeNode(tree.key, tree.value, tree.left, setEvidence(tree.right, key, value));
	const balance = (next.left?.height ?? 0) - (next.right?.height ?? 0);
	if (balance > 1) {
		if (key > next.left!.key) next = treeNode(next.key, next.value, rotateLeft(next.left!), next.right);
		return rotateRight(next);
	}
	if (balance < -1) {
		if (key < next.right!.key) next = treeNode(next.key, next.value, next.left, rotateRight(next.right!));
		return rotateLeft(next);
	}
	return next;
}

function getEvidence(tree: EvidenceTree | undefined, key: string): EvidenceLink | undefined {
	let current = tree;
	while (current) {
		if (current.key === key) return current.value;
		current = key < current.key ? current.left : current.right;
	}
	return undefined;
}

function evidenceKey(query: ParentInputEvidenceQuery): string {
	return JSON.stringify([
		query.type,
		query.customType ?? null,
		query.requestId ?? null,
		query.wakeId ?? null,
		query.deliveryId ?? null,
	]);
}

/** Index the bounded field subsets once, so every supported partial query is a direct map lookup. */
function evidenceKeys(entry: SessionEntry): readonly string[] {
	const keys = new Set<string>();
	for (const metadata of parentInputEvidenceMetadata(entry)) {
		const optional = ["customType", "requestId", "wakeId", "deliveryId"] as const;
		const fields = optional.filter((field) => metadata[field] !== undefined);
		for (let mask = 0; mask < 2 ** fields.length; mask++) {
			const query: { -readonly [Key in keyof ParentInputEvidenceQuery]: ParentInputEvidenceQuery[Key] } = {
				type: metadata.type,
			};
			for (let bit = 0; bit < fields.length; bit++) {
				const field = fields[bit]!;
				if ((mask & (1 << bit)) !== 0) query[field] = metadata[field];
			}
			keys.add(evidenceKey(query));
		}
	}
	return [...keys];
}

/**
 * Append-only metadata index shared by live and pinned session readers. No message bodies are retained.
 * Binary ancestors give logarithmic ancestry; a persistent AVL map gives nearest evidence on each branch.
 * A rewrite requires a fresh index. Missing or cyclic parent chains never acquire a usable lineage.
 */
export class SessionEntryEvidenceIndex {
	private readonly entries = new Map<string, IndexedEntry>();
	private readonly waiting = new Map<string, IndexedEntry[]>();
	private keyCount = 0;

	add(entry: SessionEntry): void {
		if (typeof entry.id !== "string" || !entry.id || entry.id.length > MAX_SESSION_EVIDENCE_ID_CHARS)
			throw new Error("Session evidence entry id is invalid.");
		if (this.entries.has(entry.id)) throw new Error("Session evidence contains a duplicate entry id.");
		if (this.entries.size >= MAX_SESSION_EVIDENCE_ENTRIES)
			throw new Error("Session evidence index exceeds its entry limit.");
		const parentId = sessionEvidenceParentId(entry);
		const indexed: IndexedEntry = { id: entry.id, parentId, keys: evidenceKeys(entry) };
		if (this.keyCount + indexed.keys.length > MAX_INDEXED_EVIDENCE_KEYS)
			throw new Error("Session evidence index exceeds its metadata limit.");
		this.keyCount += indexed.keys.length;
		this.entries.set(entry.id, indexed);
		if (parentId === undefined) return;
		const parent = parentId === null ? undefined : this.entries.get(parentId);
		if (parentId !== null && !parent?.lineage) {
			const children = this.waiting.get(parentId) ?? [];
			children.push(indexed);
			this.waiting.set(parentId, children);
			return;
		}
		const pending = [indexed];
		while (pending.length > 0) {
			const current = pending.pop()!;
			const predecessor = current.parentId === null ? undefined : this.entries.get(current.parentId!);
			this.attach(current, predecessor);
			const children = this.waiting.get(current.id);
			if (children) {
				this.waiting.delete(current.id);
				for (const child of children) pending.push(child);
			}
		}
	}

	private attach(entry: IndexedEntry, parent?: IndexedEntry): void {
		const ancestors: IndexedEntry[] = parent ? [parent] : [];
		for (let level = 0; ancestors[level]; level++) {
			const next = ancestors[level]!.lineage?.ancestors[level];
			if (!next) break;
			ancestors.push(next);
		}
		let evidence = parent?.lineage?.evidence;
		for (const key of entry.keys)
			evidence = setEvidence(evidence, key, { id: entry.id, next: getEvidence(evidence, key) });
		entry.lineage = {
			root: parent?.lineage?.root ?? entry.id,
			depth: (parent?.lineage?.depth ?? -1) + 1,
			ancestors,
			evidence,
		};
	}

	isAncestor(ancestorId: string, descendantId: string): boolean {
		const ancestor = this.requireEntry(ancestorId);
		let descendant = this.requireEntry(descendantId);
		if (ancestor.lineage!.root !== descendant.lineage!.root || ancestor.lineage!.depth > descendant.lineage!.depth)
			return false;
		let difference = descendant.lineage!.depth - ancestor.lineage!.depth;
		let level = 0;
		while (difference > 0) {
			if (difference % 2 === 1) descendant = descendant.lineage!.ancestors[level]!;
			difference = Math.floor(difference / 2);
			level++;
		}
		return ancestor.id === descendant.id;
	}

	findAncestors(descendantId: string, query: ParentInputEvidenceQuery): readonly string[] {
		const limit = query.limit ?? MAX_EVIDENCE_RESULTS;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVIDENCE_RESULTS)
			throw new Error("Session evidence query limit must be from 1 through 64.");
		const entry = this.requireEntry(descendantId);
		let found = getEvidence(entry.lineage!.evidence, evidenceKey(query));
		const ids: string[] = [];
		while (found && ids.length < limit) {
			ids.push(found.id);
			found = found.next;
		}
		return ids;
	}

	private requireEntry(id: string): IndexedEntry {
		const entry = this.entries.get(id);
		if (!entry?.lineage) throw new Error("Session evidence ancestry has a missing entry, malformed link or cycle.");
		return entry;
	}
}
