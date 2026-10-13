/**
 * Persistent metadata tables for transcript summaries.
 *
 * Every table is a deterministic immutable treap. One page holds one key/value entry plus two child
 * hashes, so page size is bounded by one domain value and a change path-copies only the expected
 * logarithmic search path. A small root names all table roots; replacing that root is the transaction's
 * sole visibility boundary. Unreferenced pages left by a failed transaction are safe to sweep later.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { isMissingFileError, writeFileAtomic } from "../util/atomic-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";

export const TRANSCRIPT_SUMMARY_METADATA_STORAGE_VERSION = 1;

const ROOT_KIND = "transcript_summary_metadata_root";
const PAGE_KIND = "transcript_summary_metadata_page";
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MAX_TREE_DEPTH = 512;
/** In-memory page cache bound in bytes of page text. Pages are immutable and content-addressed, so eviction only costs a re-read. */
const MAX_CACHED_PAGE_BYTES = 32 * 1024 * 1024;
/** A structural diff compares at most this many entries of a subtree whose roots differ before it gives up. */
const MAX_DIFF_SUBTREE_ENTRIES = 8192;

export const TRANSCRIPT_SUMMARY_METADATA_TABLES = [
	"sessions",
	"acceptedNodes",
	"frontiers",
	"tombstones",
	"dormant",
] as const;

export type TranscriptSummaryMetadataTable = (typeof TRANSCRIPT_SUMMARY_METADATA_TABLES)[number];

export type TranscriptSummaryMetadataRoots = Record<TranscriptSummaryMetadataTable, string | null>;

export interface TranscriptSummaryMetadataRoot {
	storageVersion: number;
	schemaVersion: number;
	kind: typeof ROOT_KIND;
	writerFence: number;
	revision: number;
	forgetRevisionApplied?: number;
	tables: TranscriptSummaryMetadataRoots;
	digest: string;
}

interface MetadataPage {
	storageVersion: number;
	kind: typeof PAGE_KIND;
	table: TranscriptSummaryMetadataTable;
	key: string;
	value: unknown;
	priority: string;
	left: string | null;
	right: string | null;
}

export interface TranscriptSummaryMetadataTablePatch {
	set?: Readonly<Record<string, unknown>>;
	delete?: readonly string[];
}

export type TranscriptSummaryMetadataRootParse =
	| { status: "not_root" }
	| { status: "ok"; root: TranscriptSummaryMetadataRoot }
	| { status: "corrupt"; reason: string };

/** A subtree holds more entries than the caller agreed to read. */
class TranscriptSummaryMetadataSubtreeTooLarge extends Error {}

/** A table's pages disagree with the tree they must form (ordering, shared pages, depth). Damage, never an I/O failure. */
export class TranscriptSummaryMetadataStructureError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TranscriptSummaryMetadataStructureError";
	}
}

/**
 * A referenced immutable page cannot be used. `missing` is not damage by itself: a concurrent writer's cleanup may
 * remove pages an older root named, so an unlocked reader re-reads the root before it believes the page is gone.
 * `raw` of a damaged page is retained by explicit recovery before its root is replaced.
 */
export class TranscriptSummaryMetadataPageError extends Error {
	readonly path: string;
	readonly raw: string | undefined;
	readonly missing: boolean;

	constructor(message: string, path: string, raw?: string) {
		super(message);
		this.name = "TranscriptSummaryMetadataPageError";
		this.path = path;
		this.raw = raw;
		this.missing = raw === undefined;
	}
}

function digest(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isTable(value: unknown): value is TranscriptSummaryMetadataTable {
	return TRANSCRIPT_SUMMARY_METADATA_TABLES.some((table) => table === value);
}

function emptyRoots(): TranscriptSummaryMetadataRoots {
	return {
		sessions: null,
		acceptedNodes: null,
		frontiers: null,
		tombstones: null,
		dormant: null,
	};
}

function rootBody(root: Omit<TranscriptSummaryMetadataRoot, "digest">): string {
	return JSON.stringify(root);
}

export function createTranscriptSummaryMetadataRoot(input: {
	schemaVersion: number;
	writerFence: number;
	revision: number;
	forgetRevisionApplied?: number;
	tables?: TranscriptSummaryMetadataRoots;
}): TranscriptSummaryMetadataRoot {
	const body: Omit<TranscriptSummaryMetadataRoot, "digest"> = {
		storageVersion: TRANSCRIPT_SUMMARY_METADATA_STORAGE_VERSION,
		schemaVersion: input.schemaVersion,
		kind: ROOT_KIND,
		writerFence: input.writerFence,
		revision: input.revision,
		...(input.forgetRevisionApplied !== undefined ? { forgetRevisionApplied: input.forgetRevisionApplied } : {}),
		tables: input.tables ?? emptyRoots(),
	};
	return { ...body, digest: digest(rootBody(body)) };
}

export function serializeTranscriptSummaryMetadataRoot(root: TranscriptSummaryMetadataRoot): string {
	return `${JSON.stringify(root)}\n`;
}

/** Recognize the paged root without stealing legacy-manifest parse errors from the legacy parser. */
export function parseTranscriptSummaryMetadataRoot(raw: string): TranscriptSummaryMetadataRootParse {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return { status: "not_root" };
	}
	if (!isPlainRecord(value) || value.kind !== ROOT_KIND) return { status: "not_root" };
	const allowed = new Set([
		"storageVersion",
		"schemaVersion",
		"kind",
		"writerFence",
		"revision",
		"forgetRevisionApplied",
		"tables",
		"digest",
	]);
	if (Object.keys(value).some((key) => !allowed.has(key)))
		return { status: "corrupt", reason: "metadata root has an unknown field" };
	if (
		value.storageVersion !== TRANSCRIPT_SUMMARY_METADATA_STORAGE_VERSION ||
		!isNonNegativeInteger(value.schemaVersion) ||
		!isNonNegativeInteger(value.writerFence) ||
		!isNonNegativeInteger(value.revision) ||
		(value.forgetRevisionApplied !== undefined && !isNonNegativeInteger(value.forgetRevisionApplied)) ||
		!isPlainRecord(value.tables) ||
		typeof value.digest !== "string" ||
		!DIGEST_PATTERN.test(value.digest)
	) {
		return { status: "corrupt", reason: "metadata root fields are invalid" };
	}
	if (Object.keys(value.tables).some((key) => !isTable(key))) {
		return { status: "corrupt", reason: "metadata root names an unknown table" };
	}
	const tables = emptyRoots();
	for (const table of TRANSCRIPT_SUMMARY_METADATA_TABLES) {
		const root = value.tables[table];
		if (root !== null && (typeof root !== "string" || !DIGEST_PATTERN.test(root))) {
			return { status: "corrupt", reason: `metadata table ${table} has an invalid root` };
		}
		tables[table] = root;
	}
	const root = createTranscriptSummaryMetadataRoot({
		schemaVersion: value.schemaVersion,
		writerFence: value.writerFence,
		revision: value.revision,
		...(value.forgetRevisionApplied !== undefined ? { forgetRevisionApplied: value.forgetRevisionApplied } : {}),
		tables,
	});
	if (root.digest !== value.digest) return { status: "corrupt", reason: "metadata root digest does not match" };
	return { status: "ok", root };
}

function pagePriority(table: TranscriptSummaryMetadataTable, key: string): string {
	return digest(`${table}\0${key}`);
}

function comparePriority(left: MetadataPage, right: MetadataPage): number {
	const byPriority = left.priority.localeCompare(right.priority);
	return byPriority !== 0 ? byPriority : left.key.localeCompare(right.key);
}

function isPage(value: unknown): value is MetadataPage {
	if (!isPlainRecord(value)) return false;
	const allowed = new Set(["storageVersion", "kind", "table", "key", "value", "priority", "left", "right"]);
	return (
		Object.keys(value).every((key) => allowed.has(key)) &&
		value.storageVersion === TRANSCRIPT_SUMMARY_METADATA_STORAGE_VERSION &&
		value.kind === PAGE_KIND &&
		isTable(value.table) &&
		typeof value.key === "string" &&
		typeof value.priority === "string" &&
		DIGEST_PATTERN.test(value.priority) &&
		(value.left === null || (typeof value.left === "string" && DIGEST_PATTERN.test(value.left))) &&
		(value.right === null || (typeof value.right === "string" && DIGEST_PATTERN.test(value.right))) &&
		value.priority === pagePriority(value.table, value.key)
	);
}

/** Filesystem owner for immutable table pages. Callers serialize root replacement under their writer lock. */
export class TranscriptSummaryMetadataPages {
	private readonly pagesDir: string;
	/** Insertion order is recency order; bounded by {@link MAX_CACHED_PAGE_BYTES} of page text. */
	private readonly cache = new Map<string, { page: MetadataPage; bytes: number }>();
	private cachedBytes = 0;
	/** Pages written since the last sweep, and the live page count that sweep traced (0 before the first). */
	private writtenSinceSweep = 0;
	private livePages = 0;

	constructor(root: string) {
		this.pagesDir = join(root, "metadata-pages");
	}

	private pagePath(id: string): string {
		return join(this.pagesDir, id.slice(0, 2), `${id}.json`);
	}

	private remember(id: string, page: MetadataPage, bytes: number): void {
		this.forget(id);
		this.cache.set(id, { page, bytes });
		this.cachedBytes += bytes;
		while (this.cachedBytes > MAX_CACHED_PAGE_BYTES && this.cache.size > 1) {
			const oldest = this.cache.keys().next();
			if (oldest.done) break;
			this.forget(oldest.value);
		}
	}

	private forget(id: string): void {
		const entry = this.cache.get(id);
		if (!entry) return;
		this.cache.delete(id);
		this.cachedBytes -= entry.bytes;
	}

	/** Pages written since the last sweep against the live pages that sweep traced: the amortization input for cleanup. */
	garbagePressure(): { written: number; live: number } {
		return { written: this.writtenSinceSweep, live: this.livePages };
	}

	private async readPage(id: string, table: TranscriptSummaryMetadataTable): Promise<MetadataPage> {
		const cached = this.cache.get(id);
		if (cached) {
			if (cached.page.table !== table) {
				throw new TranscriptSummaryMetadataStructureError(`metadata page ${id} belongs to another table`);
			}
			this.remember(id, cached.page, cached.bytes);
			return cached.page;
		}
		const path = this.pagePath(id);
		let raw: string;
		try {
			raw = await fs.readFile(path, "utf8");
		} catch (error) {
			if (isMissingFileError(error))
				throw new TranscriptSummaryMetadataPageError(`metadata page ${id} is missing`, path);
			throw error;
		}
		if (digest(raw) !== id) {
			throw new TranscriptSummaryMetadataPageError(`metadata page ${id} content digest does not match`, path, raw);
		}
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch (error) {
			throw new TranscriptSummaryMetadataPageError(
				`metadata page ${id} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
				path,
				raw,
			);
		}
		if (!isPage(value) || value.table !== table) {
			throw new TranscriptSummaryMetadataPageError(`metadata page ${id} has an invalid shape`, path, raw);
		}
		this.remember(id, value, Buffer.byteLength(raw));
		return value;
	}

	private async writePage(page: MetadataPage): Promise<string> {
		const raw = `${JSON.stringify(page)}\n`;
		const id = digest(raw);
		await writeFileAtomic(this.pagePath(id), raw, { mode: 0o600 });
		this.writtenSinceSweep += 1;
		// The cached page is what a read of the file would parse, never the caller's objects.
		this.remember(id, JSON.parse(raw) as MetadataPage, Buffer.byteLength(raw));
		return id;
	}

	private page(
		table: TranscriptSummaryMetadataTable,
		key: string,
		value: unknown,
		left: string | null,
		right: string | null,
	): MetadataPage {
		return {
			storageVersion: TRANSCRIPT_SUMMARY_METADATA_STORAGE_VERSION,
			kind: PAGE_KIND,
			table,
			key,
			value,
			priority: pagePriority(table, key),
			left,
			right,
		};
	}

	private async setAt(
		table: TranscriptSummaryMetadataTable,
		root: string | null,
		key: string,
		value: unknown,
		depth: number,
	): Promise<string> {
		if (depth > MAX_TREE_DEPTH)
			throw new TranscriptSummaryMetadataStructureError(`metadata table ${table} exceeds its depth bound`);
		if (root === null) return this.writePage(this.page(table, key, value, null, null));
		const current = await this.readPage(root, table);
		if (key === current.key) return this.writePage(this.page(table, key, value, current.left, current.right));
		if (key < current.key) {
			const left = await this.setAt(table, current.left, key, value, depth + 1);
			const child = await this.readPage(left, table);
			if (comparePriority(child, current) < 0) {
				const right = await this.writePage(
					this.page(table, current.key, current.value, child.right, current.right),
				);
				return this.writePage(this.page(table, child.key, child.value, child.left, right));
			}
			return this.writePage(this.page(table, current.key, current.value, left, current.right));
		}
		const right = await this.setAt(table, current.right, key, value, depth + 1);
		const child = await this.readPage(right, table);
		if (comparePriority(child, current) < 0) {
			const left = await this.writePage(this.page(table, current.key, current.value, current.left, child.left));
			return this.writePage(this.page(table, child.key, child.value, left, child.right));
		}
		return this.writePage(this.page(table, current.key, current.value, current.left, right));
	}

	private async merge(
		table: TranscriptSummaryMetadataTable,
		left: string | null,
		right: string | null,
		depth: number,
	): Promise<string | null> {
		if (depth > MAX_TREE_DEPTH)
			throw new TranscriptSummaryMetadataStructureError(`metadata table ${table} exceeds its depth bound`);
		if (left === null) return right;
		if (right === null) return left;
		const leftPage = await this.readPage(left, table);
		const rightPage = await this.readPage(right, table);
		if (comparePriority(leftPage, rightPage) < 0) {
			const merged = await this.merge(table, leftPage.right, right, depth + 1);
			return this.writePage(this.page(table, leftPage.key, leftPage.value, leftPage.left, merged));
		}
		const merged = await this.merge(table, left, rightPage.left, depth + 1);
		return this.writePage(this.page(table, rightPage.key, rightPage.value, merged, rightPage.right));
	}

	private async deleteAt(
		table: TranscriptSummaryMetadataTable,
		root: string | null,
		key: string,
		depth: number,
	): Promise<string | null> {
		if (root === null) return null;
		if (depth > MAX_TREE_DEPTH)
			throw new TranscriptSummaryMetadataStructureError(`metadata table ${table} exceeds its depth bound`);
		const current = await this.readPage(root, table);
		if (key === current.key) return this.merge(table, current.left, current.right, depth + 1);
		if (key < current.key) {
			const left = await this.deleteAt(table, current.left, key, depth + 1);
			if (left === current.left) return root;
			return this.writePage(this.page(table, current.key, current.value, left, current.right));
		}
		const right = await this.deleteAt(table, current.right, key, depth + 1);
		if (right === current.right) return root;
		return this.writePage(this.page(table, current.key, current.value, current.left, right));
	}

	async patch(
		table: TranscriptSummaryMetadataTable,
		root: string | null,
		patch: TranscriptSummaryMetadataTablePatch,
	): Promise<string | null> {
		let next = root;
		for (const key of patch.delete ?? []) next = await this.deleteAt(table, next, key, 0);
		for (const [key, value] of Object.entries(patch.set ?? {})) next = await this.setAt(table, next, key, value, 0);
		return next;
	}

	async build(
		table: TranscriptSummaryMetadataTable,
		entries: Readonly<Record<string, unknown>>,
	): Promise<string | null> {
		let root: string | null = null;
		for (const [key, value] of Object.entries(entries)) root = await this.setAt(table, root, key, value, 0);
		return root;
	}

	/** The entries of a subtree as a map, or undefined when it holds more than {@link MAX_DIFF_SUBTREE_ENTRIES}. */
	private async loadBounded(
		table: TranscriptSummaryMetadataTable,
		root: string | null,
	): Promise<Map<string, unknown> | undefined> {
		try {
			return new Map(Object.entries(await this.load(table, root, MAX_DIFF_SUBTREE_ENTRIES)));
		} catch (error) {
			if (error instanceof TranscriptSummaryMetadataSubtreeTooLarge) return undefined;
			throw error;
		}
	}

	async load(
		table: TranscriptSummaryMetadataTable,
		root: string | null,
		maxEntries = Number.POSITIVE_INFINITY,
	): Promise<Record<string, unknown>> {
		const result: Record<string, unknown> = {};
		const seen = new Set<string>();
		const walk = async (
			id: string | null,
			minimum: string | undefined,
			maximum: string | undefined,
			parent: MetadataPage | undefined,
			depth: number,
		): Promise<void> => {
			if (id === null) return;
			if (depth > MAX_TREE_DEPTH)
				throw new TranscriptSummaryMetadataStructureError(`metadata table ${table} exceeds its depth bound`);
			if (seen.has(id))
				throw new TranscriptSummaryMetadataStructureError(
					`metadata table ${table} contains a cycle or shared page`,
				);
			seen.add(id);
			const page = await this.readPage(id, table);
			if ((minimum !== undefined && page.key <= minimum) || (maximum !== undefined && page.key >= maximum)) {
				throw new TranscriptSummaryMetadataStructureError(`metadata table ${table} violates key ordering`);
			}
			if (parent && comparePriority(parent, page) > 0)
				throw new TranscriptSummaryMetadataStructureError(`metadata table ${table} violates priority ordering`);
			await walk(page.left, minimum, page.key, page, depth + 1);
			if (seen.size > maxEntries) throw new TranscriptSummaryMetadataSubtreeTooLarge();
			result[page.key] = page.value;
			await walk(page.right, page.key, maximum, page, depth + 1);
		};
		await walk(root, undefined, undefined, undefined, 0);
		return result;
	}

	/**
	 * The keys whose entries differ between two roots of one table: `before`/`after` hold the entry on each side
	 * (undefined: absent there). Equal page ids prune whole subtrees, and a treap with deterministic priorities has one
	 * shape per key set, so a few changed keys cost a few paths. `undefined` when more than `limit` keys differ (a full
	 * load is then the cheaper way to catch up); a page that cannot be read throws like any other read.
	 */
	async diff(
		table: TranscriptSummaryMetadataTable,
		before: string | null,
		after: string | null,
		limit: number,
	): Promise<Map<string, { before: unknown; after: unknown }> | undefined> {
		const changes = new Map<string, { before: unknown; after: unknown }>();
		const record = (key: string, left: unknown, right: unknown): boolean => {
			if (JSON.stringify(left) === JSON.stringify(right)) return true;
			changes.set(key, { before: left, after: right });
			return changes.size <= limit;
		};
		const walk = async (left: string | null, right: string | null, depth: number): Promise<boolean> => {
			if (left === right) return true;
			if (depth > MAX_TREE_DEPTH)
				throw new TranscriptSummaryMetadataStructureError(`metadata table ${table} exceeds its depth bound`);
			const leftPage = left === null ? undefined : await this.readPage(left, table);
			const rightPage = right === null ? undefined : await this.readPage(right, table);
			if (leftPage && rightPage && leftPage.key === rightPage.key) {
				// Equal roots split both key ranges at the same key: each side recurses on its own range.
				return (
					record(leftPage.key, leftPage.value, rightPage.value) &&
					(await walk(leftPage.left, rightPage.left, depth + 1)) &&
					(await walk(leftPage.right, rightPage.right, depth + 1))
				);
			}
			// A key of higher priority sits on one side only: compare the two subtrees entry by entry, unless they are so
			// large that a full load is the cheaper way to catch up.
			const leftEntries = await this.loadBounded(table, left);
			const rightEntries = leftEntries && (await this.loadBounded(table, right));
			if (!leftEntries || !rightEntries) return false;
			for (const [key, value] of leftEntries) if (!record(key, value, rightEntries.get(key))) return false;
			for (const [key, value] of rightEntries) {
				if (!leftEntries.has(key) && !record(key, undefined, value)) return false;
			}
			return true;
		};
		return (await walk(before, after, 0)) ? changes : undefined;
	}

	async reachable(roots: TranscriptSummaryMetadataRoots): Promise<Set<string>> {
		const reachable = new Set<string>();
		for (const table of TRANSCRIPT_SUMMARY_METADATA_TABLES) {
			const pending = roots[table] === null ? [] : [roots[table] as string];
			while (pending.length > 0) {
				const id = pending.pop() as string;
				if (reachable.has(id)) continue;
				reachable.add(id);
				const page = await this.readPage(id, table);
				if (page.left !== null) pending.push(page.left);
				if (page.right !== null) pending.push(page.right);
			}
		}
		return reachable;
	}

	async sweep(roots: TranscriptSummaryMetadataRoots, cutoff: number): Promise<string[]> {
		const reachable = await this.reachable(roots);
		this.livePages = reachable.size;
		this.writtenSinceSweep = 0;
		const removed: string[] = [];
		let prefixes: string[];
		try {
			prefixes = await fs.readdir(this.pagesDir);
		} catch (error) {
			if (isMissingFileError(error)) return removed;
			throw error;
		}
		for (const prefix of prefixes) {
			const directory = join(this.pagesDir, prefix);
			let names: string[];
			try {
				names = await fs.readdir(directory);
			} catch (error) {
				if (isMissingFileError(error)) continue;
				throw error;
			}
			for (const name of names) {
				if (name.includes(".corrupt.")) continue;
				const id = name.endsWith(".json") ? name.slice(0, -5) : undefined;
				if (id !== undefined && reachable.has(id)) continue;
				const path = join(directory, name);
				let mtimeMs: number;
				try {
					mtimeMs = (await fs.stat(path)).mtimeMs;
				} catch (error) {
					if (isMissingFileError(error)) continue;
					throw error;
				}
				if (mtimeMs > cutoff) continue;
				try {
					await fs.unlink(path);
					if (id !== undefined) this.forget(id);
					removed.push(`metadata-pages/${prefix}/${name}`);
				} catch (error) {
					if (!isMissingFileError(error)) throw error;
				}
			}
		}
		return removed;
	}
}
