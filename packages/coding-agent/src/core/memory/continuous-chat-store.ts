/** Durable, append-only storage adapter for the project-wide ICM conversation. */

import { createHash } from "node:crypto";
import { open, readdir, readFile, stat, truncate, unlink } from "node:fs/promises";
import { join } from "node:path";
import { safeErrorMessage } from "../../kernel/types.ts";
import { stateFile } from "../agent-paths.ts";
import { isMissingFileError, withFileLock } from "../util/atomic-file.ts";
import { boundedLine } from "../util/bounded-line.ts";
import { AsyncRetainedReleases, type ReleaseOutcome, releaseFailureCause } from "../util/resource-release.ts";
import type { TimerPort } from "../util/timer-port.ts";
import { isNonNegativeSafeInteger } from "../util/value-guards.ts";
import {
	CONTINUOUS_CHAT_SCHEMA_VERSION,
	type ContinuousChatAppendInput,
	type ContinuousChatAppendResult,
	type ContinuousChatAppendUnit,
	type ContinuousChatImageInput,
	type ContinuousChatImageRef,
	type ContinuousChatRecord,
	type ContinuousChatRoot,
	continuousChatDay,
	continuousChatImageDigest,
	normalizeContinuousChatAppend,
	parseContinuousChatRecord,
	parseContinuousChatRoot,
} from "./continuous-chat-contracts.ts";
import {
	appendDurably,
	buildKeysImage,
	CONTINUOUS_CHAT_MAX_MESSAGES,
	CONTINUOUS_CHAT_MESSAGE_INDEX_ENTRY_BYTES,
	CONTINUOUS_CHAT_NODE_INDEX_ENTRY_BYTES,
	ContinuousChatCorruptError,
	type ContinuousChatKeyEntry,
	type ContinuousChatMessageLocation,
	type ContinuousChatSegmentLocation,
	continuousChatDayName,
	continuousChatDayNumber,
	continuousChatSourceKeyDigest,
	decodeMessageIndexEntry,
	decodeNodeIndexEntry,
	encodeMessageIndexEntry,
	encodeNodeIndexEntry,
	ensureDurableDirectory,
	findKeysIds,
	insertKeysEntries,
	keysHasRoom,
	readJsonFile,
	readKeysEntries,
	readKeysHeader,
	readRecordAt,
	writeDurableAtomic,
	writeNodeIndexAtomic,
	writeRecordAt,
} from "./continuous-chat-index.ts";
import {
	ContinuousChatLeaseHeldError,
	ContinuousChatLeaseLostError,
	type ContinuousChatLeaseRecord,
	createContinuousChatLeaseRecord,
	isContinuousChatLeaseOwnerProvenDead,
	readContinuousChatLease,
	releaseContinuousChatLeaseSync,
} from "./continuous-chat-lease.ts";
import type {
	ContinuousChatClaim,
	ContinuousChatScheduler,
	ContinuousChatSchedulerSnapshot,
} from "./continuous-chat-scheduler.ts";
import { openContinuousChatScheduler } from "./continuous-chat-scheduler-store.ts";
import {
	type ContinuousChatNodeCoordinate,
	type ContinuousChatTreeNode,
	continuousChatNodeFirstMessage,
	continuousChatNodeKey,
	continuousChatNodeMessageCount,
	parseContinuousChatTreeNode,
	renderContinuousChatViewLine,
} from "./continuous-chat-tree.ts";
import {
	advanceContinuousChatView,
	applyContinuousChatViewMerges,
	type ContinuousChatViewAdvance,
	type ContinuousChatViewEntry,
	type ContinuousChatViewKind,
	type ContinuousChatViewState,
	continuousChatViewBytes,
	createContinuousChatView,
	parseContinuousChatView,
	refreshContinuousChatView,
	renderContinuousChatTurnView,
	renderContinuousChatView,
} from "./continuous-chat-view.ts";
import {
	CONTINUOUS_CHAT_TOP_LEVEL,
	type ContinuousChatWorkAbandonment,
	type ContinuousChatWorkItem,
} from "./continuous-chat-work-queue.ts";

const PROJECT_KEY_PATTERN = /^[a-f0-9]{16}$/i;
const SEGMENT_PATTERN = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const SEGMENT_SUFFIX = ".jsonl";
const ROOT_FILE = "root.json";
const QUEUE_FILE = "queue.json";
const LOCK_FILE = "writer";
const TURN_VIEW_FILE = "view.json";
const CAUSAL_VIEW_FILE = "compaction-view.json";
const MESSAGE_INDEX_FILE = "messages.idx";
const KEYS_INDEX_FILE = "keys.idx";
const NODE_INDEX_DIR = "nodes";
const RUNTIME_LEASE_FILE = "runtime.lease.json";
const LINE_FEED = 0x0a;

/** Most messages one bulk append may carry. Inputs may carry images, so the bound keeps one publication small. */
export const CONTINUOUS_CHAT_MAX_BULK_INPUTS = 256;
/** Tree nodes kept in memory. A node never changes once written, so a cached entry stays valid across processes. */
export const CONTINUOUS_CHAT_NODE_CACHE_ENTRIES = 8192;

/** `fresh` is a queue created with the chat; `legacy-replay-v1` is a queue rebuilt once from an existing tree. */
export type ContinuousChatQueueOrigin = "fresh" | "legacy-replay-v1";

/** A consistent read for a turn boundary: the queue that proves the prefix, and the rendered turn view it covers. */
export interface ContinuousChatTurnSnapshot {
	queue: ContinuousChatSchedulerSnapshot;
	totalMessages: number;
	viewRevision: number;
	view: string;
}

/** The built part of the causal view: `<chat>` text covering messages [0, viewedMessages). */
export interface ContinuousChatCausalPrefix {
	text: string;
	viewedMessages: number;
}

/** Reconciliation may prove publication even when the original append reported an error. */
export type ContinuousChatWorkSettlement = "published" | "abandoned";

export interface ContinuousChatStoreOptions {
	agentDir: string;
	projectKey: string;
	/** The retained runtime-lease release's backoff timers; absent means the global, unreferenced timers. */
	timers?: TimerPort;
	/** Reports a retained runtime-lease release that failed again on its backoff alarm. */
	warn?: (message: string) => void;
}

export interface ContinuousChatRuntimeLeaseOptions {
	/** Names the owning session in the lease, so a refused session can see who holds the chat. */
	label?: string;
	/** Called once, when this store finds its lease taken or removed. Nothing is written after it. */
	onLost: () => void;
}

/** The key of the store's one retained runtime-lease release. */
const RUNTIME_LEASE_RELEASE_KEY = "runtime-lease";

/** The lease this store holds. `releaseAtExit` is the registered best-effort release for process exit. */
interface HeldRuntimeLease {
	token: string;
	onLost: () => void;
	releaseAtExit: () => void;
}

interface LogLine {
	text: string;
	offset: number;
	length: number;
}

interface LogLines {
	lines: LogLine[];
	/** Bytes consumed through the last complete line. An unterminated tail is not consumed. */
	bytes: number;
	/** Size of the file when it was read. A larger size than `bytes` is an unterminated tail. */
	size: number;
}

/** Turn view, then causal view. */
type ViewPair = [ContinuousChatViewState, ContinuousChatViewState];

/** Views caught up to the root revision they were settled against. */
interface SettledViews {
	revision: number;
	views: ViewPair;
}

interface LockedState {
	root: ContinuousChatRoot;
	views: ViewPair;
	queue: ContinuousChatSchedulerSnapshot;
	origin: ContinuousChatQueueOrigin;
}

/** Exact uncertain command; acknowledgement does not consume the caller's disposition receipt. */
interface PendingWorkAbandonment {
	claim: ContinuousChatClaim;
	abandonment: ContinuousChatWorkAbandonment;
	acknowledged: boolean;
}

/** The end of the last segment that holds published or indexed lines: its day, and the bytes consumed in it. */
interface SegmentEnd {
	day: string;
	bytes: number;
}

/** Log lines past the indexed prefix, in id order, with the end of the segment they finish in. */
interface UnindexedLog {
	locations: ContinuousChatMessageLocation[];
	nextId: number;
	newest: SegmentEnd | undefined;
}

function readLineAt(filePath: string, offset: number, length: number): Promise<LogLine> {
	return readRecordAt(filePath, offset, length).then((buffer) => {
		if (buffer === undefined) {
			throw new ContinuousChatCorruptError(filePath, `Continuous-chat line at byte ${offset} is truncated`);
		}
		return { text: buffer.toString("utf8"), offset, length };
	});
}

/**
 * Complete lines appended after `fromBytes`. Bytes after the last newline are not a line yet and stay unconsumed. Only
 * a segment that grew is opened, so an unchanged segment costs one stat.
 */
async function readLogLines(filePath: string, fromBytes: number): Promise<LogLines> {
	let size: number;
	try {
		size = (await stat(filePath)).size;
	} catch (error) {
		if (!isMissingFileError(error)) throw error;
		if (fromBytes > 0) throw new ContinuousChatCorruptError(filePath, "Continuous-chat segment disappeared");
		return { lines: [], bytes: 0, size: 0 };
	}
	if (size < fromBytes) {
		throw new ContinuousChatCorruptError(filePath, "Continuous-chat segment is shorter than its indexed bytes");
	}
	if (size === fromBytes) return { lines: [], bytes: fromBytes, size };
	const handle = await open(filePath, "r");
	try {
		const buffer = Buffer.alloc(size - fromBytes);
		let filled = 0;
		while (filled < buffer.length) {
			const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, fromBytes + filled);
			if (bytesRead === 0) {
				throw new ContinuousChatCorruptError(filePath, "Continuous-chat segment changed while read");
			}
			filled += bytesRead;
		}
		const complete = buffer.lastIndexOf(LINE_FEED) + 1;
		const lines: LogLine[] = [];
		let start = 0;
		while (start < complete) {
			const end = buffer.indexOf(LINE_FEED, start);
			if (end > start) {
				lines.push({ text: buffer.toString("utf8", start, end), offset: fromBytes + start, length: end - start });
			}
			start = end + 1;
		}
		return { lines, bytes: fromBytes + complete, size };
	} finally {
		await handle.close();
	}
}

function decodeLine<T>(filePath: string, line: LogLine, label: string, parse: (value: unknown) => T | undefined): T {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line.text);
	} catch {
		throw new ContinuousChatCorruptError(filePath, `Malformed ${label} JSONL at byte ${line.offset}`);
	}
	const item = parse(parsed);
	if (item === undefined) {
		throw new ContinuousChatCorruptError(filePath, `Invalid ${label} record at byte ${line.offset}`);
	}
	return item;
}

/** Day segments of a directory in date order. A missing directory holds none. */
async function listSegments(dir: string): Promise<string[]> {
	try {
		return (await readdir(dir)).filter((file) => SEGMENT_PATTERN.test(file)).sort();
	} catch (error) {
		if (isMissingFileError(error)) return [];
		throw error;
	}
}

function dayOfSegment(file: string): string {
	return file.slice(0, -SEGMENT_SUFFIX.length);
}

function segmentPath(dir: string, dayNo: number): string {
	return join(dir, `${continuousChatDayName(dayNo)}${SEGMENT_SUFFIX}`);
}

async function fileSize(filePath: string): Promise<number> {
	try {
		return (await stat(filePath)).size;
	} catch (error) {
		if (isMissingFileError(error)) return 0;
		throw error;
	}
}

async function loadRoot(filePath: string): Promise<ContinuousChatRoot> {
	const parsed = await readJsonFile(filePath, "continuous-chat root");
	if (parsed === undefined) {
		return {
			schemaVersion: CONTINUOUS_CHAT_SCHEMA_VERSION,
			revision: 0,
			nextId: 0,
			lastSegmentBytes: 0,
		};
	}
	const root = parseContinuousChatRoot(parsed);
	if (root === undefined) throw new ContinuousChatCorruptError(filePath, "Invalid continuous-chat root");
	return root;
}

function serializeRoot(root: ContinuousChatRoot): string {
	return `${JSON.stringify(root)}\n`;
}

function recordLine(record: ContinuousChatRecord): string {
	return `${JSON.stringify(record)}\n`;
}

function treeNodeLine(node: ContinuousChatTreeNode): string {
	return `${JSON.stringify(node)}\n`;
}

function viewFileName(kind: ContinuousChatViewKind): string {
	return kind === "turn" ? TURN_VIEW_FILE : CAUSAL_VIEW_FILE;
}

/** The persisted view, or undefined when it was never written. Malformed content is corruption. */
async function readViewFile(
	rootDir: string,
	kind: ContinuousChatViewKind,
): Promise<ContinuousChatViewState | undefined> {
	const filePath = join(rootDir, viewFileName(kind));
	const parsed = await readJsonFile(filePath, "persisted view");
	if (parsed === undefined) return undefined;
	const view = parseContinuousChatView(parsed, kind);
	if (view === undefined) throw new ContinuousChatCorruptError(filePath, "Invalid persisted view");
	return view;
}

async function persistView(rootDir: string, view: ContinuousChatViewState): Promise<void> {
	await writeDurableAtomic(join(rootDir, viewFileName(view.kind)), `${JSON.stringify(view)}\n`);
}

/** Advances a view one leaf at a time to `expectedMessages`, then refreshes its lines against the current tree. */
function catchUpView(
	view: ContinuousChatViewState,
	expectedMessages: number,
	nodes: ReadonlyMap<string, ContinuousChatTreeNode>,
): ContinuousChatViewAdvance {
	let next = view;
	const mergedParents: ContinuousChatNodeCoordinate[] = [];
	while (next.totalMessages < expectedMessages) {
		const advanced = advanceContinuousChatView(next, next.totalMessages, nodes);
		next = advanced.state;
		mergedParents.push(...advanced.mergedParents);
	}
	const refreshed = refreshContinuousChatView(next, nodes);
	return { state: refreshed.state, mergedParents: [...mergedParents, ...refreshed.mergedParents] };
}

/** Whether two views have the same partition and the same lines. Revisions are ignored, since a refresh bumps them. */
function sameLayout(a: ContinuousChatViewState, b: ContinuousChatViewState): boolean {
	return (
		a.totalMessages === b.totalMessages &&
		a.batchPending === b.batchPending &&
		a.entries.length === b.entries.length &&
		a.entries.every((entry, index) => {
			const other = b.entries[index];
			return (
				other !== undefined &&
				entry.level === other.level &&
				entry.ordinal === other.ordinal &&
				entry.size === other.size
			);
		})
	);
}

/** Coordinates of the message leaves [from, to). */
function leafCoordinates(from: number, to: number): ContinuousChatNodeCoordinate[] {
	return Array.from({ length: Math.max(0, to - from) }, (_, offset) => ({ level: 0, ordinal: from + offset }));
}

/**
 * Consecutive records grouped by storage day. Occurrence timestamps are immutable and may go backwards when older
 * sessions are imported; segment names remain monotone independently so journal replay preserves permanent-id order.
 */
function groupByStorageDay(
	records: readonly ContinuousChatRecord[],
	startingDay: string | undefined,
): Array<{ day: string; records: ContinuousChatRecord[] }> {
	const groups: Array<{ day: string; records: ContinuousChatRecord[] }> = [];
	let storageDay = startingDay;
	for (const record of records) {
		const occurrenceDay = continuousChatDay(record.date);
		if (storageDay === undefined || occurrenceDay > storageDay) storageDay = occurrenceDay;
		const day = storageDay;
		const last = groups.at(-1);
		if (last !== undefined && last.day === day) {
			last.records.push(record);
		} else {
			groups.push({ day, records: [record] });
		}
	}
	return groups;
}

async function persistImages(imagesDir: string, images: ContinuousChatImageInput[]): Promise<ContinuousChatImageRef[]> {
	const references: ContinuousChatImageRef[] = [];
	for (const image of images) {
		const data = Buffer.from(image.data, "base64");
		const digest = continuousChatImageDigest(data);
		const path = join(imagesDir, digest);
		try {
			const existing = await stat(path);
			if (existing.size !== data.byteLength) {
				throw new ContinuousChatCorruptError(path, "Image digest has wrong size");
			}
		} catch (error) {
			if (!isMissingFileError(error)) throw error;
			await writeDurableAtomic(path, data);
		}
		references.push({ digest, mimeType: image.mimeType, bytes: data.byteLength });
	}
	return references;
}

/**
 * One project-scoped writer and reader. Daily segments are authoritative. The message index, the key index and the
 * node index are derived from them, and `root.json` publishes the message range. `queue.sqlite` owns deferred work;
 * `queue.json` marks the indexed scheduler as authoritative.
 *
 * Every mutation runs under the writer lock. Each locked operation first fences itself: it re-reads the runtime lease
 * and fails, once and permanently for this store, when the lease on disk is no longer its own. Then it starts with
 * `reconcileLocked()`, which repairs any interrupted publication, so a crash at any boundary is repaired before the
 * next write. A locked step that throws drops the caches, so the next step reconciles from disk. Locked bodies call
 * only private helpers, never another locked method.
 *
 * Memory: no per-message or per-node state is resident. The working set is the settled views (bounded by their byte
 * high-water marks), the node cache (`CONTINUOUS_CHAT_NODE_CACHE_ENTRIES`), and the rendered turn view. Reads go to the
 * index files by position or hash probe. Steady-state operations touch the root, the queue, the two views when the
 * root moved, and the newest segment; they never list or stat older segments or tree files.
 */
export class ContinuousChatStore {
	readonly rootDir: string;
	readonly mainDir: string;
	readonly treeDir: string;
	readonly imagesDir: string;
	readonly rootFile: string;
	readonly queueFile: string;
	readonly lockFile: string;
	readonly messageIndexFile: string;
	readonly keysIndexFile: string;
	readonly nodeIndexDir: string;
	readonly leaseFile: string;
	private readonly nodeCache = new Map<string, ContinuousChatTreeNode>();
	private scheduler: ContinuousChatScheduler | undefined;
	/** No new claim reuses a coordinate until its prior disposition has been acknowledged by its caller. */
	private readonly pendingAbandonments = new Map<string, PendingWorkAbandonment>();
	/** The runtime lease this store holds. Undefined before acquisition, after release, and after a loss. */
	private lease: HeldRuntimeLease | undefined;
	/**
	 * A released lease whose file could not be removed yet. Nothing writes under it (the fence finds no lease), but its
	 * file still names this process, so its exit hook stays registered and the removal is retried on a backoff.
	 */
	private readonly leaseRelease: AsyncRetainedReleases<HeldRuntimeLease>;
	/** Root revision the index files were last reconciled against. Undefined after a failed locked step. */
	private indexedRevision: number | undefined;
	/** Views caught up to the root revision they name. Undefined after a failed locked step. */
	private settled: SettledViews | undefined;
	/** The rendered turn view for one root revision. */
	private rendered: { revision: number; text: string } | undefined;

	constructor(options: ContinuousChatStoreOptions) {
		if (!PROJECT_KEY_PATTERN.test(options.projectKey)) {
			throw new TypeError("Continuous-chat projectKey must be a 16-character hexadecimal digest.");
		}
		this.rootDir = stateFile(options.agentDir, "continuous-chat", options.projectKey.toLowerCase());
		this.mainDir = join(this.rootDir, "main");
		this.treeDir = join(this.rootDir, "tree");
		this.imagesDir = join(this.rootDir, "images");
		this.rootFile = join(this.rootDir, ROOT_FILE);
		this.queueFile = join(this.rootDir, QUEUE_FILE);
		this.lockFile = join(this.rootDir, LOCK_FILE);
		this.messageIndexFile = join(this.rootDir, MESSAGE_INDEX_FILE);
		this.keysIndexFile = join(this.rootDir, KEYS_INDEX_FILE);
		this.nodeIndexDir = join(this.rootDir, NODE_INDEX_DIR);
		this.leaseFile = join(this.rootDir, RUNTIME_LEASE_FILE);
		const warn = options.warn;
		this.leaseRelease = new AsyncRetainedReleases<HeldRuntimeLease>({
			retryOwner: "continuous-chat store",
			...(options.timers !== undefined ? { timers: options.timers } : {}),
			release: (lease) => this.removeLeaseFile(lease),
			...(warn !== undefined
				? {
						reportFailure: (_entry, error) =>
							warn(`Continuous-chat lease release failed again: ${releaseFailureCause(error)}`),
					}
				: {}),
		});
	}

	/**
	 * Takes the project's runtime lease for this store's lifetime. A lease whose owner is live, on another host, or not
	 * provably dead raises `ContinuousChatLeaseHeldError` once and is never taken over. A lease whose owner is proven
	 * dead on this host is replaced. Every later locked operation fences on the token (see `withWriterLock`).
	 */
	async acquireRuntimeLease(options: ContinuousChatRuntimeLeaseOptions): Promise<void> {
		if (this.lease !== undefined || this.leaseRelease.size > 0)
			throw new Error("Continuous-chat runtime lease is held or still releasing.");
		const record = createContinuousChatLeaseRecord({ label: options.label, now: new Date() });
		const token = record.token;
		const releaseAtExit = (): void => releaseContinuousChatLeaseSync(this.leaseFile, token);
		const candidate: HeldRuntimeLease = { token, onLost: options.onLost, releaseAtExit };
		try {
			await this.withProjectLock(async () => {
				// Another acquisition may have passed the first check while this one waited for the lock.
				if (this.lease !== undefined || this.leaseRelease.size > 0)
					throw new Error("Continuous-chat runtime lease is held or still releasing.");
				const existing = await readContinuousChatLease(this.leaseFile);
				if (existing !== undefined && !isContinuousChatLeaseOwnerProvenDead(existing)) {
					throw new ContinuousChatLeaseHeldError(existing);
				}
				// Rename can succeed before directory flush fails. Own cleanup before any publication.
				process.on("exit", releaseAtExit);
				this.lease = candidate;
				await writeDurableAtomic(this.leaseFile, `${JSON.stringify(record)}\n`);
			});
		} catch (error) {
			if (this.lease === candidate) {
				// Release outside the project lock; its existing owner retains uncertain cleanup for retry.
				const released = await this.releaseRuntimeLease();
				if (released.kind === "retained") {
					throw new AggregateError(
						[error, new Error(`${released.retryOwner} retained lease cleanup: ${released.cause}`)],
						`Continuous-chat lease acquisition failed: ${boundedLine(safeErrorMessage(error, "unknown error"), 512)}; ${released.retryOwner} retained cleanup: ${boundedLine(released.cause, 512)}`,
					);
				}
			}
			throw error;
		}
		// Caches built before this lease may describe another owner's later writes; the next locked step reloads them.
		this.indexedRevision = undefined;
		this.settled = undefined;
		this.rendered = undefined;
	}

	/**
	 * Gives the lease up. Nothing is written under it from the first call on. Releasing a lease that was never taken,
	 * or was lost, removes nothing. A lease file that cannot be removed is retained: its exit hook stays, its removal
	 * is retried on a backoff, and a later call retries it at once. Never rejects; the outcome says which happened.
	 */
	async releaseRuntimeLease(): Promise<ReleaseOutcome> {
		const lease = this.lease;
		if (lease === undefined) {
			if (this.leaseRelease.size === 0) return { kind: "released" };
			await this.leaseRelease.retry({ report: false });
			const retained = this.leaseRelease.get(RUNTIME_LEASE_RELEASE_KEY);
			return retained === undefined
				? { kind: "released" }
				: { kind: "retained", cause: retained.cause, retryOwner: this.leaseRelease.retryOwner };
		}
		this.lease = undefined;
		this.pendingAbandonments.clear();
		try {
			const result = await this.removeLeaseFile(lease);
			return result === "released" ? { kind: "released" } : { kind: "superseded", detail: result.superseded };
		} catch (error) {
			return this.leaseRelease.retain(RUNTIME_LEASE_RELEASE_KEY, lease, error);
		}
	}

	/** Removes the lease file when it still names `lease`; the exit hook goes only once the file is not this lease's. */
	private async removeLeaseFile(lease: HeldRuntimeLease): Promise<"released" | { superseded: string }> {
		const removed = await this.withProjectLock(async () => {
			this.closeScheduler();
			const current = await readContinuousChatLease(this.leaseFile);
			if (current?.token !== lease.token) return false;
			await unlink(this.leaseFile);
			return true;
		});
		process.off("exit", lease.releaseAtExit);
		return removed ? "released" : { superseded: "the lease file no longer names this store's token" };
	}

	private closeScheduler(): void {
		this.scheduler?.close();
		this.scheduler = undefined;
	}

	/** Startup recovery under the writer lock: reconciles everything, then requeues work claimed by a dead process. */
	async recover(): Promise<void> {
		await this.withWriterLock(async () => {
			await this.reconcileLocked();
			this.requireScheduler().recover();
		});
	}

	/** Host metadata shares the project lease and writer exclusion through the complete read/write transaction. */
	mutateMetadata<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		return this.withWriterLock(() => {
			signal?.throwIfAborted();
			return operation();
		});
	}

	/**
	 * Appends up to `CONTINUOUS_CHAT_MAX_BULK_INPUTS` messages, each split into units, in one locked publication: one
	 * write per day touched, one index write, one root publication, one view and queue persist. Units already logged
	 * under their sourceKey are returned rather than appended again, so a retry after a partial write completes it. A
	 * new record may not fall on an earlier day. The runtime's `append` is the one single-message path.
	 */
	async appendMany(inputs: readonly ContinuousChatAppendInput[]): Promise<ContinuousChatAppendResult[]> {
		if (inputs.length > CONTINUOUS_CHAT_MAX_BULK_INPUTS) {
			throw new RangeError(`Continuous-chat bulk append takes at most ${CONTINUOUS_CHAT_MAX_BULK_INPUTS} inputs.`);
		}
		if (inputs.length === 0) return [];
		const units = inputs.map((input) => normalizeContinuousChatAppend(input));
		return this.withWriterLock(() => this.appendLocked(units));
	}

	async appendNode(node: ContinuousChatTreeNode): Promise<boolean> {
		return this.withWriterLock(() => this.appendNodeLocked(node));
	}

	/** The next background work item, or undefined when nothing is ready or the running limit is reached. */
	async claimWork(): Promise<ContinuousChatClaim | undefined> {
		return this.withWriterLock(async () => {
			if (this.pendingAbandonments.size > 0) return undefined;
			await this.reconcileLocked();
			for (;;) {
				const claim = this.requireScheduler().claim();
				if (!claim || (await this.nodeAt(claim)) === undefined) return claim;
				await this.completePublishedWorkLocked(claim);
			}
		});
	}

	/** A claimed item failed. Its reason remains available for diagnostics after a restart. */
	async failWork(item: ContinuousChatClaim, reason: string): Promise<ContinuousChatWorkSettlement> {
		return this.settleUnacknowledgedWork(item, { kind: "fail", reason });
	}

	async releaseWork(item: ContinuousChatClaim): Promise<ContinuousChatWorkSettlement> {
		return this.settleUnacknowledgedWork(item, { kind: "release" });
	}

	/** Publication is authoritative; only a still-running, unpublished claim may be abandoned. */
	private settleUnacknowledgedWork(
		item: ContinuousChatClaim,
		abandonment: ContinuousChatWorkAbandonment,
	): Promise<ContinuousChatWorkSettlement> {
		return this.withWriterLock(async () => {
			await this.reconcileLocked();
			const published = (await this.nodeAt(item)) !== undefined;
			const key = continuousChatNodeKey(item);
			const pending = this.pendingAbandonments.get(key);
			if (pending) {
				if (
					pending.claim.claimId !== item.claimId ||
					pending.abandonment.kind !== abandonment.kind ||
					(pending.abandonment.kind === "fail" &&
						abandonment.kind === "fail" &&
						pending.abandonment.reason !== abandonment.reason)
				)
					throw new Error("Continuous-chat pending work disposition does not match its retry.");
				this.pendingAbandonments.delete(key);
				return published ? "published" : "abandoned";
			}
			if (published) return "published";
			// Both transitions require running ownership. Missing work without a published node
			// remains an error, not a successful release or evidence that compaction completed.
			this.pendingAbandonments.set(key, {
				claim: { ...item },
				abandonment: { ...abandonment },
				acknowledged: false,
			});
			await this.confirmPendingAbandonmentsLocked();
			this.pendingAbandonments.delete(key);
			return "abandoned";
		});
	}

	/** Replay before any later mutation, never after a newer queue revision has been admitted. */
	private async confirmPendingAbandonmentsLocked(): Promise<void> {
		for (const pending of this.pendingAbandonments.values()) {
			if (pending.acknowledged) continue;
			if ((await this.nodeAt(pending.claim)) === undefined)
				this.requireScheduler().abandon(pending.claim, pending.abandonment);
			else await this.completePublishedWorkLocked(pending.claim);
			pending.acknowledged = true;
		}
	}

	/** Completes an item whose node is already published. Idempotent. */
	async completeWork(item: ContinuousChatWorkItem): Promise<void> {
		await this.withWriterLock(async () => {
			await this.reconcileLocked();
			if ((await this.nodeAt(item)) === undefined) {
				throw new RangeError("Continuous-chat work item has no published node to complete it with.");
			}
			await this.completePublishedWorkLocked(item);
		});
	}

	/**
	 * An arrival that is not a permanent message: a user turn began, or the summary model recovered. Failed work
	 * becomes retry-eligible in the background.
	 */
	async noteArrival(): Promise<void> {
		await this.withWriterLock(async () => {
			await this.reconcileLocked();
			this.requireScheduler().arrival();
		});
	}

	/** The turn view and the queue that proves its prefix, read in one locked step. */
	async snapshotTurn(): Promise<ContinuousChatTurnSnapshot> {
		return this.withWriterLock(async () => {
			const state = await this.reconcileLocked();
			const [turn] = state.views;
			return {
				queue: state.queue,
				totalMessages: state.root.nextId,
				viewRevision: turn.revision,
				view: await this.renderTurnLocked(state.root.revision, turn),
			};
		});
	}

	async readQueue(): Promise<ContinuousChatSchedulerSnapshot> {
		return this.withWriterLock(async () => (await this.reconcileLocked()).queue);
	}

	/** Published messages. */
	async totalMessages(): Promise<number> {
		return (await loadRoot(this.rootFile)).nextId;
	}

	/** The root revision. It moves with every publication, so a read tagged with it names the state it saw. */
	async rootRevision(): Promise<number> {
		return (await loadRoot(this.rootFile)).revision;
	}

	/** The published record stored under `sourceKey`. Global across days. */
	async findBySourceKey(sourceKey: string): Promise<ContinuousChatRecord | undefined> {
		return this.findPublished(sourceKey, (await loadRoot(this.rootFile)).nextId);
	}

	async readNode(coordinate: ContinuousChatNodeCoordinate): Promise<ContinuousChatTreeNode | undefined> {
		return this.nodeAt(coordinate);
	}

	/**
	 * The causal view for a compaction ending before `endMessage`, stopping at the first unbuilt message. The queue is
	 * read first and the nodes second, because a leaf's node is published before its queue item completes.
	 */
	async readCausalPrefix(endMessage: number): Promise<ContinuousChatCausalPrefix> {
		if (!Number.isSafeInteger(endMessage) || endMessage < 0) {
			throw new TypeError("Continuous-chat prefix end must be a non-negative integer.");
		}
		const built = (await this.readQueue()).builtLeafPrefix;
		const viewed = Math.min(endMessage, built);
		if (viewed === 0) {
			const empty = new Map<string, ContinuousChatTreeNode>();
			return { text: renderContinuousChatView(createContinuousChatView("causal"), empty), viewedMessages: 0 };
		}
		const filePath = join(this.rootDir, CAUSAL_VIEW_FILE);
		const view = await readViewFile(this.rootDir, "causal");
		if (view === undefined) throw new ContinuousChatCorruptError(filePath, "Persisted view is missing");
		if (view.totalMessages < viewed) {
			throw new ContinuousChatCorruptError(filePath, "Persisted causal view does not cover the built prefix");
		}
		const entries = await this.causalCut(view.entries, viewed, filePath);
		const causal = { ...view, totalMessages: viewed, batchPending: false, entries };
		const nodes = await this.presentNodes(entries, false);
		return { text: renderContinuousChatView(causal, nodes), viewedMessages: viewed };
	}

	async readView(kind: ContinuousChatViewKind): Promise<ContinuousChatViewState> {
		const root = await loadRoot(this.rootFile);
		const view = await readViewFile(this.rootDir, kind);
		if (view === undefined) {
			if (root.nextId === 0) return createContinuousChatView(kind);
			throw new ContinuousChatCorruptError(join(this.rootDir, viewFileName(kind)), "Persisted view is missing");
		}
		if (view.totalMessages > root.nextId) {
			throw new ContinuousChatCorruptError(join(this.rootDir, viewFileName(kind)), "Invalid persisted view");
		}
		return view;
	}

	async readMessageById(id: number): Promise<ContinuousChatRecord | undefined> {
		if (!isNonNegativeSafeInteger(id)) throw new TypeError("Continuous-chat id must be a non-negative integer.");
		const published = (await loadRoot(this.rootFile)).nextId;
		if (id >= published) return undefined;
		return this.recordAt(id);
	}

	async readMessageDate(id: number): Promise<string | undefined> {
		return (await this.readMessageById(id))?.date;
	}

	async readDate(date: string): Promise<ContinuousChatRecord[]> {
		if (!SEGMENT_PATTERN.test(`${date}${SEGMENT_SUFFIX}`)) {
			throw new TypeError(`Invalid continuous-chat date: ${date}`);
		}
		const count = await this.totalMessages();
		const records: ContinuousChatRecord[] = [];
		for (let id = 0; id < count; id++) {
			const record = await this.recordAt(id);
			if (continuousChatDay(record.date) === date) records.push(record);
		}
		return records;
	}

	/** One message of the given day, by its positioned read. Undefined when the message is not on that day. */
	async readMessage(date: string, id: number): Promise<ContinuousChatRecord | undefined> {
		if (!SEGMENT_PATTERN.test(`${date}${SEGMENT_SUFFIX}`)) {
			throw new TypeError(`Invalid continuous-chat date: ${date}`);
		}
		const record = await this.readMessageById(id);
		return record !== undefined && continuousChatDay(record.date) === date ? record : undefined;
	}

	async readImage(ref: ContinuousChatImageRef): Promise<Buffer> {
		const filePath = join(this.imagesDir, ref.digest);
		const data = await readFile(filePath);
		if (data.byteLength !== ref.bytes || continuousChatImageDigest(data) !== ref.digest) {
			throw new ContinuousChatCorruptError(filePath, "Continuous-chat image failed integrity validation");
		}
		return data;
	}

	/**
	 * Every mutation enters here. The lease is re-read under the writer lock before the step runs, so a store whose
	 * lease was taken or removed writes nothing further. A failed step may leave index files ahead of the root, so the
	 * caches are dropped and the next step rebuilds.
	 */
	private withWriterLock<T>(run: () => Promise<T>): Promise<T> {
		return this.withProjectLock(async () => {
			try {
				await this.assertLeaseLocked();
				await this.confirmPendingAbandonmentsLocked();
				return await run();
			} catch (error) {
				this.indexedRevision = undefined;
				this.settled = undefined;
				this.rendered = undefined;
				throw error;
			}
		});
	}

	/** The writer lock without the lease fence, for lease acquisition and release around the lease's lifetime. */
	private withProjectLock<T>(run: () => Promise<T>): Promise<T> {
		return withFileLock(this.lockFile, run, { realpath: false });
	}

	/**
	 * The fence. A lease that is missing, unreadable, or names another token is lost: this store forgets it, calls
	 * `onLost` once, and throws. Liveness is never probed here; the token on disk is the whole proof of ownership.
	 */
	private async assertLeaseLocked(): Promise<void> {
		const lease = this.lease;
		if (lease === undefined) {
			throw new ContinuousChatLeaseLostError(this.leaseFile, "it was never acquired or was already released");
		}
		let owner: ContinuousChatLeaseRecord | undefined;
		let reason = "the lease file was removed";
		try {
			owner = await readContinuousChatLease(this.leaseFile);
		} catch (error) {
			reason = `the lease file cannot be read (${safeErrorMessage(error, "unknown error")})`;
		}
		if (owner?.token === lease.token) return;
		if (owner !== undefined) reason = "another session took it";
		this.lease = undefined;
		this.pendingAbandonments.clear();
		process.off("exit", lease.releaseAtExit);
		try {
			this.closeScheduler();
		} catch (error) {
			this.leaseRelease.retain(RUNTIME_LEASE_RELEASE_KEY, lease, error);
			reason += `; scheduler close failed (${releaseFailureCause(error)})`;
		}
		lease.onLost();
		throw new ContinuousChatLeaseLostError(this.leaseFile, reason);
	}

	/**
	 * Brings the caches to the disk: reconciles the indexes and settles the views when the root moved, then reads the
	 * queue. Steady-state work is one root read, plus index and view work only when the root revision changed.
	 */
	private async reconcileLocked(): Promise<LockedState> {
		let root = await loadRoot(this.rootFile);
		if (this.indexedRevision !== root.revision) {
			root = await this.indexLocked(root);
			await this.reconcileNodeIndexesLocked(root.nextId);
			this.indexedRevision = root.revision;
		}
		let settled = this.settled;
		if (settled === undefined || settled.revision !== root.revision) {
			settled = { revision: root.revision, views: await this.loadViewsLocked(root.nextId) };
			this.settled = settled;
		}
		const queue = await this.reconcileQueueLocked(root);
		return { root, views: settled.views, queue, origin: queue.origin };
	}

	/**
	 * Repairs the message index against the segments and publishes any indexed suffix a crash left unpublished. A torn
	 * index entry or an unterminated log tail is cut off; its line is still in the log and is indexed again. Runs only
	 * when the root moved without this process (a crash, or another process), never on an ordinary operation.
	 */
	private async indexLocked(root: ContinuousChatRoot): Promise<ContinuousChatRoot> {
		const size = await fileSize(this.messageIndexFile);
		const indexed = Math.floor(size / CONTINUOUS_CHAT_MESSAGE_INDEX_ENTRY_BYTES);
		if (size !== indexed * CONTINUOUS_CHAT_MESSAGE_INDEX_ENTRY_BYTES) {
			await truncate(this.messageIndexFile, indexed * CONTINUOUS_CHAT_MESSAGE_INDEX_ENTRY_BYTES);
		}
		if (indexed < root.nextId) {
			throw new ContinuousChatCorruptError(
				this.messageIndexFile,
				"Message index does not cover the published range",
			);
		}
		await this.reconcileKeysLocked(indexed);
		const last = indexed === 0 ? undefined : await this.readMessageLocation(indexed - 1);
		const unindexed = await this.scanLogLocked(indexed, last);
		if (unindexed.locations.length > 0) {
			const entries = unindexed.locations.map((location, offset) => ({
				digest: location.digest,
				id: indexed + offset,
			}));
			await appendDurably(this.messageIndexFile, Buffer.concat(unindexed.locations.map(encodeMessageIndexEntry)));
			await this.insertKeysLocked(entries);
		}
		if (unindexed.nextId === root.nextId) return root;
		const newest: SegmentEnd | undefined =
			unindexed.newest ??
			(last === undefined
				? undefined
				: { day: continuousChatDayName(last.dayNo), bytes: last.offset + last.length + 1 });
		return this.writeRootLocked({
			schemaVersion: CONTINUOUS_CHAT_SCHEMA_VERSION,
			revision: root.revision + 1,
			nextId: unindexed.nextId,
			lastSegment: newest?.day,
			lastSegmentBytes: newest?.bytes ?? 0,
		});
	}

	/** The key index is derived from the message index. A missing or mismatched table is rebuilt from it. */
	private async reconcileKeysLocked(indexed: number): Promise<void> {
		const header = await readKeysHeader(this.keysIndexFile);
		if (header !== undefined && header.count === indexed) return;
		const entries: ContinuousChatKeyEntry[] = [];
		if (indexed > 0) {
			const index = await readFile(this.messageIndexFile);
			for (let id = 0; id < indexed; id++) {
				const start = id * CONTINUOUS_CHAT_MESSAGE_INDEX_ENTRY_BYTES;
				const end = start + CONTINUOUS_CHAT_MESSAGE_INDEX_ENTRY_BYTES;
				const location = decodeMessageIndexEntry(index.subarray(start, end));
				entries.push({ digest: location.digest, id });
			}
		}
		await writeDurableAtomic(this.keysIndexFile, buildKeysImage(entries));
	}

	/** Log lines after the indexed prefix, in id order. A torn segment tail is cut off: it was never published. */
	private async scanLogLocked(
		indexed: number,
		last: ContinuousChatMessageLocation | undefined,
	): Promise<UnindexedLog> {
		const lastDay = last === undefined ? undefined : continuousChatDayName(last.dayNo);
		const locations: ContinuousChatMessageLocation[] = [];
		let nextId = indexed;
		let newest: SegmentEnd | undefined;
		for (const file of await listSegments(this.mainDir)) {
			const day = dayOfSegment(file);
			if (lastDay !== undefined && day < lastDay) continue;
			const filePath = join(this.mainDir, file);
			const from = last !== undefined && day === lastDay ? last.offset + last.length + 1 : 0;
			const read = await readLogLines(filePath, from);
			if (read.size > read.bytes) await truncate(filePath, read.bytes);
			for (const line of read.lines) {
				const record = decodeLine(filePath, line, "continuous-chat", parseContinuousChatRecord);
				if (record.id !== nextId) throw new ContinuousChatCorruptError(filePath, `Expected message id ${nextId}`);
				locations.push({
					dayNo: continuousChatDayNumber(day),
					offset: line.offset,
					length: line.length,
					digest: continuousChatSourceKeyDigest(record.sourceKey),
				});
				nextId++;
			}
			if (read.lines.length > 0) newest = { day, bytes: read.bytes };
		}
		return { locations, nextId, newest };
	}

	/**
	 * Rebuilds every fixed-width node index from the authoritative tree journals. A crash may leave a durable JSONL node
	 * without its slot, or a torn slot; neither is trusted. Exact duplicate journal lines are inert, while a conflicting
	 * coordinate is corruption. This runs only on startup or after a failed/external publication.
	 */
	private async reconcileNodeIndexesLocked(published: number): Promise<void> {
		const byLevel = new Map<
			number,
			{
				highest: number;
				entries: Map<
					number,
					{
						location: ContinuousChatSegmentLocation;
						digest: string;
						children?: readonly ContinuousChatNodeCoordinate[];
					}
				>;
			}
		>();
		for (const file of await listSegments(this.treeDir)) {
			const day = dayOfSegment(file);
			const filePath = join(this.treeDir, file);
			const read = await readLogLines(filePath, 0);
			if (read.size > read.bytes) await truncate(filePath, read.bytes);
			for (const line of read.lines) {
				const node = decodeLine(filePath, line, "continuous-chat tree", parseContinuousChatTreeNode);
				const coveredUntil = continuousChatNodeFirstMessage(node) + continuousChatNodeMessageCount(node.level);
				if (!Number.isSafeInteger(coveredUntil) || coveredUntil > published) {
					throw new ContinuousChatCorruptError(
						filePath,
						`Tree node ${continuousChatNodeKey(node)} exceeds the published log`,
					);
				}
				let level = byLevel.get(node.level);
				if (level === undefined) {
					level = { highest: -1, entries: new Map() };
					byLevel.set(node.level, level);
				}
				const digest = createHash("sha256").update(JSON.stringify(node)).digest("hex");
				const existing = level.entries.get(node.ordinal);
				if (existing !== undefined && existing.digest !== digest) {
					throw new ContinuousChatCorruptError(filePath, `Conflicting tree node ${continuousChatNodeKey(node)}`);
				}
				if (existing === undefined) {
					level.highest = Math.max(level.highest, node.ordinal);
					level.entries.set(node.ordinal, {
						location: {
							dayNo: continuousChatDayNumber(day),
							offset: line.offset,
							length: line.length,
						},
						digest,
						children: node.children,
					});
				}
			}
		}
		for (const [level, levelData] of byLevel) {
			for (const [ordinal, entry] of levelData.entries) {
				for (const child of entry.children ?? []) {
					if (byLevel.get(child.level)?.entries.has(child.ordinal) !== true) {
						throw new ContinuousChatCorruptError(
							this.treeDir,
							`Tree node ${continuousChatNodeKey({ level, ordinal })} is missing a child`,
						);
					}
				}
			}
		}
		await ensureDurableDirectory(this.nodeIndexDir);
		const written = new Set<string>();
		for (const [level, levelData] of byLevel) {
			const name = `${level}.idx`;
			written.add(name);
			await writeNodeIndexAtomic(join(this.nodeIndexDir, name), levelData.highest, levelData.entries);
			byLevel.delete(level);
		}
		for (const name of await readdir(this.nodeIndexDir)) {
			if (!/^\d+\.idx$/.test(name) || written.has(name)) continue;
			await unlink(join(this.nodeIndexDir, name));
		}
		this.nodeCache.clear();
	}

	/** Places keys in the table, growing it (by rebuilding from its own entries) when it would pass half full. */
	private async insertKeysLocked(entries: ContinuousChatKeyEntry[]): Promise<void> {
		const header = await readKeysHeader(this.keysIndexFile);
		if (header === undefined) {
			throw new ContinuousChatCorruptError(this.keysIndexFile, "Continuous-chat key index is missing");
		}
		if (keysHasRoom(header, entries.length)) {
			await insertKeysEntries(this.keysIndexFile, header, entries);
			return;
		}
		const existing = await readKeysEntries(this.keysIndexFile);
		await writeDurableAtomic(this.keysIndexFile, buildKeysImage([...existing, ...entries]));
	}

	/**
	 * The persisted views caught up to `expected`. A view never stored is created here, valid only while nothing is
	 * logged: the empty view is persisted before the first log or root write.
	 */
	private async loadViewsLocked(expected: number): Promise<ViewPair> {
		const views: ViewPair = [createContinuousChatView("turn"), createContinuousChatView("causal")];
		const persisted: [boolean, boolean] = [true, true];
		for (const index of [0, 1] as const) {
			const kind: ContinuousChatViewKind = index === 0 ? "turn" : "causal";
			const filePath = join(this.rootDir, viewFileName(kind));
			const stored = await readViewFile(this.rootDir, kind);
			if (stored === undefined) {
				if (expected > 0) throw new ContinuousChatCorruptError(filePath, "Persisted view is missing");
				persisted[index] = false;
				continue;
			}
			if (stored.totalMessages > expected) throw new ContinuousChatCorruptError(filePath, "Invalid persisted view");
			views[index] = stored;
		}
		return this.settleViewsLocked(views, persisted, expected);
	}

	/** Catches both views up to `expected`, and persists each one that was never stored or whose layout changed. */
	private async settleViewsLocked(
		views: ViewPair,
		persisted: [boolean, boolean],
		expected: number,
	): Promise<ViewPair> {
		const coordinates = [
			...views[0].entries,
			...views[1].entries,
			...leafCoordinates(Math.min(views[0].totalMessages, views[1].totalMessages), expected),
		];
		const nodes = await this.presentNodes(coordinates, true);
		const turnAdvance = catchUpView(views[0], expected, nodes);
		const causalAdvance = catchUpView(views[1], expected, nodes);
		const causal = applyContinuousChatViewMerges(causalAdvance.state, turnAdvance.mergedParents, nodes);
		const settled: ViewPair = [turnAdvance.state, causal];
		for (const index of [0, 1] as const) {
			if (!persisted[index] || !sameLayout(views[index], settled[index])) {
				await persistView(this.rootDir, settled[index]);
			}
		}
		return settled;
	}

	/**
	 * The queue for the published range. A missing queue file for a non-empty chat predates the queue, and is rebuilt
	 * once from the tree and marked `legacy-replay-v1`. Built items are completed, so the queue agrees with the tree.
	 */
	private async reconcileQueueLocked(root: ContinuousChatRoot): Promise<ContinuousChatSchedulerSnapshot> {
		this.scheduler ??= await openContinuousChatScheduler(
			this.queueFile,
			root.nextId,
			async (item) => (await this.nodeAt(item)) !== undefined,
		);
		let state = this.scheduler.snapshot();
		if (state.totalMessages > root.nextId) {
			throw new ContinuousChatCorruptError(this.queueFile, "Work queue is ahead of the published log");
		}
		if (state.totalMessages < root.nextId) this.scheduler.arrival(root.nextId);
		for (const claim of state.running)
			if ((await this.nodeAt(claim)) !== undefined) await this.completePublishedWorkLocked(claim);
		state = this.scheduler.snapshot();
		return state;
	}

	private requireScheduler(): ContinuousChatScheduler {
		if (!this.scheduler) throw new Error("ICM scheduler has not been opened under its writer lease");
		return this.scheduler;
	}

	private async completePublishedWorkLocked(item: ContinuousChatWorkItem): Promise<void> {
		let parent: ContinuousChatWorkItem | undefined;
		if (item.level < CONTINUOUS_CHAT_TOP_LEVEL) {
			const sibling = { level: item.level, ordinal: item.ordinal % 2 === 0 ? item.ordinal + 1 : item.ordinal - 1 };
			const candidate = { level: item.level + 1, ordinal: Math.floor(item.ordinal / 2) };
			if ((await this.nodeAt(sibling)) !== undefined && (await this.nodeAt(candidate)) === undefined)
				parent = candidate;
		}
		this.requireScheduler().complete(item, parent);
	}

	/** Writes the root. Its index files are durable first, so the root never names an entry that is not on disk. */
	private async writeRootLocked(root: ContinuousChatRoot): Promise<ContinuousChatRoot> {
		await writeDurableAtomic(this.rootFile, serializeRoot(root));
		this.indexedRevision = root.revision;
		return root;
	}

	private async appendLocked(inputs: ContinuousChatAppendUnit[][]): Promise<ContinuousChatAppendResult[]> {
		const state = await this.reconcileLocked();
		const published = state.root.nextId;
		const planned = new Map<string, ContinuousChatRecord>();
		const created: ContinuousChatRecord[] = [];
		const outcomes: Array<{ records: ContinuousChatRecord[]; deduplicated: boolean }> = [];
		for (const units of inputs) {
			const records: ContinuousChatRecord[] = [];
			let fresh = 0;
			for (const unit of units) {
				const existing = planned.get(unit.sourceKey) ?? (await this.findPublished(unit.sourceKey, published));
				if (existing !== undefined) {
					records.push(existing);
					continue;
				}
				const id = published + created.length;
				if (id >= CONTINUOUS_CHAT_MAX_MESSAGES) throw new RangeError("Continuous-chat log is full.");
				const record: ContinuousChatRecord = {
					schemaVersion: CONTINUOUS_CHAT_SCHEMA_VERSION,
					id,
					kind: unit.kind,
					date: unit.date,
					text: unit.text,
					textBytes: unit.textBytes,
					sourceKey: unit.sourceKey,
				};
				if (unit.source !== undefined) record.source = unit.source;
				if (unit.toolClipping !== undefined) record.toolClipping = unit.toolClipping;
				if (unit.images !== undefined) record.images = await persistImages(this.imagesDir, unit.images);
				planned.set(unit.sourceKey, record);
				created.push(record);
				records.push(record);
				fresh++;
			}
			outcomes.push({ records, deduplicated: fresh === 0 });
		}
		if (created.length === 0) {
			return outcomes.map((outcome) => ({ revision: state.root.revision, ...outcome }));
		}
		const root = await this.commitRecordsLocked(created, state.root);
		const views = await this.settleViewsLocked(state.views, [true, true], root.nextId);
		this.settled = { revision: root.revision, views };
		this.requireScheduler().arrival(root.nextId);
		return outcomes.map((outcome) => ({ revision: root.revision, ...outcome }));
	}

	/**
	 * Writes new records to their segments, then their message and key index entries, then publishes the root. A crash
	 * before the root leaves indexed records above the published count, which the next reconcile publishes.
	 */
	private async commitRecordsLocked(
		created: ContinuousChatRecord[],
		root: ContinuousChatRoot,
	): Promise<ContinuousChatRoot> {
		if ((await fileSize(this.messageIndexFile)) !== root.nextId * CONTINUOUS_CHAT_MESSAGE_INDEX_ENTRY_BYTES) {
			throw new ContinuousChatCorruptError(
				this.messageIndexFile,
				"Message index does not match the published count",
			);
		}
		const locations: ContinuousChatMessageLocation[] = [];
		let newest: SegmentEnd | undefined;
		for (const group of groupByStorageDay(created, root.lastSegment)) {
			const lines = group.records.map((record) => recordLine(record));
			const base = await appendDurably(join(this.mainDir, `${group.day}${SEGMENT_SUFFIX}`), lines.join(""));
			let offset = base;
			for (const [index, record] of group.records.entries()) {
				const length = Buffer.byteLength(lines[index], "utf8") - 1;
				locations.push({
					dayNo: continuousChatDayNumber(group.day),
					offset,
					length,
					digest: continuousChatSourceKeyDigest(record.sourceKey),
				});
				offset += length + 1;
			}
			newest = { day: group.day, bytes: offset };
		}
		await appendDurably(this.messageIndexFile, Buffer.concat(locations.map(encodeMessageIndexEntry)));
		await this.insertKeysLocked(
			locations.map((location, offset) => ({ digest: location.digest, id: root.nextId + offset })),
		);
		return this.writeRootLocked({
			schemaVersion: CONTINUOUS_CHAT_SCHEMA_VERSION,
			revision: root.revision + 1,
			nextId: root.nextId + created.length,
			lastSegment: newest?.day,
			lastSegmentBytes: newest?.bytes ?? 0,
		});
	}

	private async appendNodeLocked(node: ContinuousChatTreeNode): Promise<boolean> {
		const validated = parseContinuousChatTreeNode(node);
		if (validated === undefined) throw new TypeError("Invalid continuous-chat tree node.");
		const state = await this.reconcileLocked();
		const key = continuousChatNodeKey(validated);
		const existing = await this.nodeAt(validated);
		if (existing !== undefined) {
			if (JSON.stringify(existing) !== JSON.stringify(validated)) {
				throw new ContinuousChatCorruptError(this.treeDir, `Conflicting tree node ${key}`);
			}
		} else {
			await this.assertNodeCanPublish(validated, state.root.nextId);
			const day = continuousChatDay(validated.date);
			const line = treeNodeLine(validated);
			const offset = await appendDurably(join(this.treeDir, `${day}${SEGMENT_SUFFIX}`), line);
			await this.writeNodeLocation(validated, {
				dayNo: continuousChatDayNumber(day),
				offset,
				length: Buffer.byteLength(line, "utf8") - 1,
			});
			this.rememberNode(key, validated);
			// A node changes the tree, so the revision moves too: readers that cache by revision re-read the views.
			const root = await this.writeRootLocked({ ...state.root, revision: state.root.revision + 1 });
			const views = await this.settleViewsLocked(state.views, [true, true], root.nextId);
			this.settled = { revision: root.revision, views };
		}
		await this.completePublishedWorkLocked(validated);
		return existing === undefined;
	}

	/** A node covers only published messages, and both its children must already be in the tree. */
	private async assertNodeCanPublish(node: ContinuousChatTreeNode, published: number): Promise<void> {
		const coveredUntil = continuousChatNodeFirstMessage(node) + continuousChatNodeMessageCount(node.level);
		if (!Number.isSafeInteger(coveredUntil) || coveredUntil > published) {
			throw new TypeError("Continuous-chat tree node covers messages that are not logged.");
		}
		for (const child of node.children ?? []) {
			if ((await this.nodeAt(child)) === undefined) {
				throw new TypeError("Continuous-chat parent cannot publish before both children.");
			}
		}
	}

	/** One tree node by coordinate, through the bounded node cache. Undefined when the node was never written. */
	private async nodeAt(coordinate: ContinuousChatNodeCoordinate): Promise<ContinuousChatTreeNode | undefined> {
		const key = continuousChatNodeKey(coordinate);
		const cached = this.nodeCache.get(key);
		if (cached !== undefined) {
			this.nodeCache.delete(key);
			this.nodeCache.set(key, cached);
			return cached;
		}
		const node = await this.readNodeFromDisk(coordinate);
		if (node !== undefined) this.rememberNode(key, node);
		return node;
	}

	private async readNodeFromDisk(
		coordinate: ContinuousChatNodeCoordinate,
	): Promise<ContinuousChatTreeNode | undefined> {
		const slot = await readRecordAt(
			this.nodeIndexFile(coordinate.level),
			coordinate.ordinal * CONTINUOUS_CHAT_NODE_INDEX_ENTRY_BYTES,
			CONTINUOUS_CHAT_NODE_INDEX_ENTRY_BYTES,
		);
		if (slot === undefined) return undefined;
		const location = decodeNodeIndexEntry(slot);
		if (location === undefined) return undefined;
		const filePath = segmentPath(this.treeDir, location.dayNo);
		const line = await readLineAt(filePath, location.offset, location.length);
		const node = decodeLine(filePath, line, "continuous-chat tree", parseContinuousChatTreeNode);
		if (node.level !== coordinate.level || node.ordinal !== coordinate.ordinal) {
			throw new ContinuousChatCorruptError(
				filePath,
				`Tree index ${continuousChatNodeKey(coordinate)} holds node ${continuousChatNodeKey(node)}`,
			);
		}
		return node;
	}

	private writeNodeLocation(
		node: ContinuousChatNodeCoordinate,
		location: ContinuousChatSegmentLocation,
	): Promise<void> {
		return writeRecordAt(
			this.nodeIndexFile(node.level),
			node.ordinal * CONTINUOUS_CHAT_NODE_INDEX_ENTRY_BYTES,
			encodeNodeIndexEntry(location),
		);
	}

	private nodeIndexFile(level: number): string {
		return join(this.nodeIndexDir, `${level}.idx`);
	}

	private rememberNode(key: string, node: ContinuousChatTreeNode): void {
		this.nodeCache.set(key, node);
		if (this.nodeCache.size <= CONTINUOUS_CHAT_NODE_CACHE_ENTRIES) return;
		const oldest = this.nodeCache.keys().next();
		if (!oldest.done) this.nodeCache.delete(oldest.value);
	}

	/**
	 * Present nodes for `coordinates`. With `ancestors`, every present ancestor is included too. A node is present only
	 * after both its children, so the climb stops at the first missing ancestor: nothing above it can be present.
	 */
	private async presentNodes(
		coordinates: Iterable<ContinuousChatNodeCoordinate>,
		ancestors: boolean,
	): Promise<Map<string, ContinuousChatTreeNode>> {
		const nodes = new Map<string, ContinuousChatTreeNode>();
		const visited = new Set<string>();
		const pending = [...coordinates];
		for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
			const key = continuousChatNodeKey(next);
			if (visited.has(key)) continue;
			visited.add(key);
			const node = await this.nodeAt(next);
			if (node === undefined) continue;
			nodes.set(key, node);
			if (ancestors && next.level < CONTINUOUS_CHAT_TOP_LEVEL) {
				pending.push({ level: next.level + 1, ordinal: Math.floor(next.ordinal / 2) });
			}
		}
		return nodes;
	}

	/** The built part of a causal view. A straddling entry is split into its children until each piece ends by `end`. */
	private async causalCut(
		entries: readonly ContinuousChatViewEntry[],
		end: number,
		filePath: string,
	): Promise<ContinuousChatViewEntry[]> {
		const cut: ContinuousChatViewEntry[] = [];
		const visit = async (coordinate: ContinuousChatNodeCoordinate): Promise<void> => {
			const first = continuousChatNodeFirstMessage(coordinate);
			if (first >= end) return;
			const node = await this.nodeAt(coordinate);
			if (node !== undefined && first + continuousChatNodeMessageCount(coordinate.level) <= end) {
				const size = Buffer.byteLength(`${renderContinuousChatViewLine(node)}\n`, "utf8");
				cut.push({ level: coordinate.level, ordinal: coordinate.ordinal, size });
				return;
			}
			if (coordinate.level === 0) {
				throw new ContinuousChatCorruptError(filePath, `Causal prefix reaches unbuilt message ${first}`);
			}
			await visit({ level: coordinate.level - 1, ordinal: coordinate.ordinal * 2 });
			await visit({ level: coordinate.level - 1, ordinal: coordinate.ordinal * 2 + 1 });
		};
		for (const entry of entries) await visit(entry);
		return cut;
	}

	/** The turn view's text, rendered once per root revision. */
	private async renderTurnLocked(revision: number, turn: ContinuousChatViewState): Promise<string> {
		const rendered = this.rendered;
		if (rendered !== undefined && rendered.revision === revision) return rendered.text;
		// Past high water a collapsed line may name a parent node, so the entries' ancestors are read too.
		const nodes = await this.presentNodes(turn.entries, continuousChatViewBytes(turn) > turn.highBytes);
		const text = renderContinuousChatTurnView(turn, nodes);
		this.rendered = { revision, text };
		return text;
	}

	/** The location of one indexed message. A missing entry for an id below the published count is corruption. */
	private async readMessageLocation(id: number): Promise<ContinuousChatMessageLocation> {
		const entry = await readRecordAt(
			this.messageIndexFile,
			id * CONTINUOUS_CHAT_MESSAGE_INDEX_ENTRY_BYTES,
			CONTINUOUS_CHAT_MESSAGE_INDEX_ENTRY_BYTES,
		);
		if (entry === undefined) {
			throw new ContinuousChatCorruptError(this.messageIndexFile, `Message ${id} is missing from the message index`);
		}
		return decodeMessageIndexEntry(entry);
	}

	/** One indexed message, read by positioned reads. The caller guarantees `id` is below the published count. */
	private async recordAt(id: number): Promise<ContinuousChatRecord> {
		const location = await this.readMessageLocation(id);
		const filePath = segmentPath(this.mainDir, location.dayNo);
		const line = await readLineAt(filePath, location.offset, location.length);
		const record = decodeLine(filePath, line, "continuous-chat", parseContinuousChatRecord);
		if (record.id !== id) {
			throw new ContinuousChatCorruptError(filePath, `Indexed message ${id} holds record ${record.id}`);
		}
		return record;
	}

	/**
	 * The published record stored under `sourceKey`. Digest hits are verified against the record's own sourceKey, and an
	 * id at or above `published` is not yet visible to readers.
	 */
	private async findPublished(sourceKey: string, published: number): Promise<ContinuousChatRecord | undefined> {
		const header = await readKeysHeader(this.keysIndexFile);
		if (header === undefined) return undefined;
		const ids = await findKeysIds(this.keysIndexFile, header, continuousChatSourceKeyDigest(sourceKey));
		for (const id of ids) {
			if (id >= published) continue;
			const record = await this.recordAt(id);
			if (record.sourceKey === sourceKey) return record;
		}
		return undefined;
	}
}
