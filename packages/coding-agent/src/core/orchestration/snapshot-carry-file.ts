/**
 * What an orchestration projection snapshot cannot hold, carried verbatim beside it for a build that reads it whole (a plan
 * from a newer build: `plan/plan-carry.ts`). Each carried key (a plan id) is a chain under `carried/<chain>/`: an
 * optional base (`base.json`, an entry a replaced snapshot held, so within the snapshot bound) and numbered chunks
 * (`<16-digit sequence>.json`) of the key's journal events, each chunk naming the digest of the one before it. A chunk holds
 * events up to the journal's own per-event bound, so any journal event fits one chunk and no amount of carried history can
 * make a compaction fail: a compaction appends the folded tail's events as new chunks and never rewrites or re-reads the
 * chain. The manifest `snapshots/<16-digit ordinal>.carried.json` names, per key, its chain, base digest, chunk count and
 * last chunk digest; it is bound to the snapshot of that ordinal by the snapshot's digest, written before the baseline
 * that publishes the snapshot, and replaced with it. A chain the new manifest no longer names, and chunks past a kept
 * chain's count (left by a compaction that crashed before its baseline), are removed after the baseline is published.
 * Older readers: the manifest misses the snapshot pattern (`^\d{16}\.json$`) and the accounting sources'
 * (`^\d+\.json$`, `worker-usage-history.ts`), and no build up to 0.104.65 lists the store's root or `carried/`, so such
 * a build reads the snapshot alone and its compaction leaves the manifest and the chains behind, unbound; this build
 * ignores an unbound manifest and removes it and its chains at its next compaction.
 */

import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "../autonomy/contracts.ts";
import { atomicTemporaryTarget, writeFileAtomicSync } from "../util/atomic-file.ts";
import { readOptionalBoundedTextFileSync } from "../util/bounded-file.ts";
import type { FaultableFs } from "../util/faultable-fs.ts";
import {
	isOrchestrationEvent,
	MAX_ORCHESTRATION_PROJECTION_SNAPSHOT_BYTES,
	type OrchestrationEvent,
	toJsonObject,
} from "./contracts.ts";
import { OrchestrationEventStoreError } from "./event-store-errors.ts";
import {
	forEachDirectoryEntrySync,
	hasExactFields,
	MAX_CONFIGURED_TAIL_BYTES,
	serializeCompactBounded,
} from "./event-store-files.ts";

const MANIFEST_FILE_PATTERN = /^\d{16}\.carried\.json$/;
const CHAIN_NAME_PATTERN = /^\d{16}-[0-9a-f]{24}$/;
const CHUNK_FILE_PATTERN = /^(\d{16})\.json$/;
const BASE_FILE = "base.json";
const MANIFEST_FIELDS = ["version", "throughOrdinal", "snapshotDigest", "chains", "digest"] as const;
const CHAIN_FIELDS = ["chain", "base", "chunks", "head"] as const;
const BASE_FIELDS = ["version", "base", "digest"] as const;
const CHUNK_FIELDS = ["version", "previous", "events", "digest"] as const;
/** Room in a file for its own fields beside the base or the events it holds. */
const FILE_OVERHEAD_BYTES = 64 * 1024;
/** A chunk's events: one journal event is at most the configured tail bound, so it always fits one chunk. */
const CHUNK_EVENT_BYTES = MAX_CONFIGURED_TAIL_BYTES;
const MANIFEST_LABEL = "Orchestration carried snapshot manifest";

/** One key's chain as a manifest names it. */
interface CarriedChain {
	readonly chain: string;
	readonly base: string | null;
	readonly chunks: number;
	readonly head: string | null;
}

/** A published manifest: the chains bound to one snapshot. */
export interface CarriedManifest {
	readonly chains: Readonly<Record<string, CarriedChain>>;
}

/** One carried key, read on demand: its base, and its events in journal order, verified chunk by chunk. */
export interface CarriedEntry {
	base(): JsonObject | undefined;
	events(): Generator<OrchestrationEvent>;
}

/** What a compaction replaces: the published snapshot, the keys its manifest carries, and the tail events it folds. */
export interface CompactionBasis {
	readonly prior: { readonly projection: JsonObject; readonly carried: ReadonlySet<string> } | undefined;
	readonly tail: readonly OrchestrationEvent[];
}

/**
 * What one key carries on: a key the replaced manifest carries is extended by `events` (its base stays); any other key
 * starts a chain from `base` and `events`.
 */
export interface CarriedWrite {
	readonly base?: JsonObject;
	readonly events: readonly OrchestrationEvent[];
}

/** What a compaction publishes: the projection snapshot, and what that projection cannot hold, carried beside it. */
export interface CompactionFold {
	readonly projection: JsonObject;
	readonly carried?: Readonly<Record<string, CarriedWrite>>;
}

export function carriedFileName(throughOrdinal: number): string {
	return `${String(throughOrdinal).padStart(16, "0")}.carried.json`;
}

export function isCarriedFileName(name: string): boolean {
	return MANIFEST_FILE_PATTERN.test(name);
}

function digestOf(content: unknown): string {
	return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isDigest(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function chunkFileName(sequence: number): string {
	return `${String(sequence).padStart(16, "0")}.json`;
}

/** Reads and parses one carried file, undefined when it is missing; anything unreadable throws. */
function readCarriedJson(path: string, maxBytes: number, label: string): Record<string, unknown> | undefined {
	let parsed: unknown;
	try {
		const text = readOptionalBoundedTextFileSync(path, maxBytes, label);
		if (text === undefined) return undefined;
		parsed = JSON.parse(text);
	} catch (error) {
		throw new OrchestrationEventStoreError(
			`Failed to parse ${label}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!isRecord(parsed)) throw new OrchestrationEventStoreError(`Invalid ${label}.`);
	return parsed;
}

function invalid(label: string): never {
	throw new OrchestrationEventStoreError(`Invalid ${label}.`);
}

function chainOf(value: unknown, label: string): CarriedChain {
	if (
		!isRecord(value) ||
		!hasExactFields(value, CHAIN_FIELDS) ||
		typeof value.chain !== "string" ||
		!CHAIN_NAME_PATTERN.test(value.chain) ||
		(value.base !== null && !isDigest(value.base)) ||
		!Number.isSafeInteger(value.chunks) ||
		Number(value.chunks) < 0 ||
		(value.chunks === 0 ? value.head !== null : !isDigest(value.head))
	)
		return invalid(label);
	return { chain: value.chain, base: value.base, chunks: Number(value.chunks), head: value.head as string | null };
}

/**
 * The manifest bound to the snapshot of `throughOrdinal` and `snapshotDigest`, undefined when none is: no file of that
 * ordinal, or one written for a snapshot of the same ordinal that never became this one (a compaction that crashed before
 * its baseline, after which an older build compacted at that ordinal). A file that cannot be read or does not match its own
 * digest throws, as a snapshot does.
 */
export function readCarriedManifest(
	snapshotsDir: string,
	throughOrdinal: number,
	snapshotDigest: string,
): CarriedManifest | undefined {
	const file = readCarriedJson(
		join(snapshotsDir, carriedFileName(throughOrdinal)),
		MAX_ORCHESTRATION_PROJECTION_SNAPSHOT_BYTES,
		MANIFEST_LABEL,
	);
	if (!file) return undefined;
	if (
		!hasExactFields(file, MANIFEST_FIELDS) ||
		file.version !== 1 ||
		file.throughOrdinal !== throughOrdinal ||
		typeof file.snapshotDigest !== "string" ||
		!isRecord(file.chains)
	)
		return invalid(MANIFEST_LABEL);
	const { version, chains } = file;
	if (digestOf({ version, throughOrdinal, snapshotDigest: file.snapshotDigest, chains }) !== file.digest)
		throw new OrchestrationEventStoreError(`${MANIFEST_LABEL} digest mismatch.`);
	if (file.snapshotDigest !== snapshotDigest) return undefined;
	const decoded: Record<string, CarriedChain> = {};
	for (const [key, chain] of Object.entries(chains)) decoded[key] = chainOf(chain, `${MANIFEST_LABEL} chain '${key}'`);
	return { chains: decoded };
}

/** Each key of `manifest`, read on demand from `carriedDir`. */
export function carriedEntries(carriedDir: string, manifest: CarriedManifest): ReadonlyMap<string, CarriedEntry> {
	return new Map(
		Object.entries(manifest.chains).map(([key, chain]) => [key, carriedEntry(join(carriedDir, chain.chain), chain)]),
	);
}

function carriedEntry(dir: string, chain: CarriedChain): CarriedEntry {
	return {
		base: () => (chain.base === null ? undefined : readBase(dir, chain.base)),
		events: () => readChunks(dir, chain),
	};
}

function readBase(dir: string, expected: string): JsonObject {
	const label = "Orchestration carried base";
	const file = readCarriedJson(
		join(dir, BASE_FILE),
		MAX_ORCHESTRATION_PROJECTION_SNAPSHOT_BYTES + FILE_OVERHEAD_BYTES,
		label,
	);
	if (!file || !hasExactFields(file, BASE_FIELDS) || file.version !== 1 || !isRecord(file.base)) return invalid(label);
	const base = toJsonObject(file.base);
	if (file.digest !== expected || digestOf({ version: 1, base }) !== expected)
		throw new OrchestrationEventStoreError(`${label} digest mismatch.`);
	return base;
}

function* readChunks(dir: string, chain: CarriedChain): Generator<OrchestrationEvent> {
	let previous: string | null = null;
	for (let sequence = 1; sequence <= chain.chunks; sequence++) {
		const label = `Orchestration carried chunk ${sequence}`;
		const file = readCarriedJson(join(dir, chunkFileName(sequence)), CHUNK_EVENT_BYTES + FILE_OVERHEAD_BYTES, label);
		if (!file || !hasExactFields(file, CHUNK_FIELDS) || file.version !== 1 || !Array.isArray(file.events))
			return invalid(label);
		if (file.previous !== previous || digestOf({ version: 1, previous, events: file.events }) !== file.digest)
			throw new OrchestrationEventStoreError(`${label} does not follow its chain.`);
		for (const event of file.events) {
			if (!isOrchestrationEvent(event)) return invalid(`${label} event`);
			yield event;
		}
		previous = file.digest as string;
	}
	if (previous !== chain.head)
		throw new OrchestrationEventStoreError("Orchestration carried chain does not end at its head.");
}

/** `events` in chunks whose events together stay within the per-event bound, in order. */
function chunksOf(events: readonly OrchestrationEvent[]): OrchestrationEvent[][] {
	const chunks: OrchestrationEvent[][] = [];
	let current: OrchestrationEvent[] = [];
	let bytes = 0;
	for (const event of events) {
		const size = Buffer.byteLength(JSON.stringify(event)) + 1;
		if (current.length > 0 && bytes + size > CHUNK_EVENT_BYTES) {
			chunks.push(current);
			current = [];
			bytes = 0;
		}
		current.push(event);
		bytes += size;
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

/**
 * Writes what `carried` adds under `carriedDir` (new chains' bases, every new chunk) and the manifest of the snapshot of
 * `throughOrdinal` and `snapshotDigest` naming every carried key; returns the manifest's file name and what it names.
 * Called before the baseline that publishes the snapshot: nothing the published manifest names is rewritten.
 */
export function writeCarried(
	paths: { readonly snapshotsDir: string; readonly carriedDir: string },
	throughOrdinal: number,
	snapshotDigest: string,
	prior: CarriedManifest | undefined,
	carried: Readonly<Record<string, CarriedWrite>>,
	fs: FaultableFs,
): { readonly file: string; readonly manifest: CarriedManifest } {
	const chains: Record<string, CarriedChain> = {};
	for (const [key, write] of Object.entries(carried)) {
		const kept = prior?.chains[key];
		const chain = kept?.chain ?? `${String(throughOrdinal).padStart(16, "0")}-${digestOf(key).slice(0, 24)}`;
		const dir = join(paths.carriedDir, chain);
		let base = kept ? kept.base : null;
		if (!kept && write.base) {
			const content = { version: 1, base: write.base };
			base = digestOf(content);
			const serialized = serializeCompactBounded(
				{ ...content, digest: base },
				MAX_ORCHESTRATION_PROJECTION_SNAPSHOT_BYTES + FILE_OVERHEAD_BYTES,
				"Orchestration carried base",
			);
			writeFileAtomicSync(join(dir, BASE_FILE), serialized, { fs });
		}
		let chunks = kept?.chunks ?? 0;
		let head = kept?.head ?? null;
		for (const events of chunksOf(write.events)) {
			const content = { version: 1, previous: head, events };
			const digest = digestOf(content);
			const serialized = serializeCompactBounded(
				{ ...content, digest },
				CHUNK_EVENT_BYTES + FILE_OVERHEAD_BYTES,
				"Orchestration carried chunk",
			);
			chunks += 1;
			writeFileAtomicSync(join(dir, chunkFileName(chunks)), serialized, { fs });
			head = digest;
		}
		chains[key] = { chain, base, chunks, head };
	}
	const file = carriedFileName(throughOrdinal);
	const version = 1;
	const digest = digestOf({ version, throughOrdinal, snapshotDigest, chains });
	const serialized = serializeCompactBounded(
		{ version, throughOrdinal, snapshotDigest, chains, digest },
		MAX_ORCHESTRATION_PROJECTION_SNAPSHOT_BYTES,
		MANIFEST_LABEL,
	);
	writeFileAtomicSync(join(paths.snapshotsDir, file), serialized, { fs });
	return { file, manifest: { chains } };
}

/**
 * After a baseline is published: removes every chain `manifest` does not name and, in each named chain, chunks past its
 * count and temporaries of crashed writes (left by a compaction that crashed before its baseline; compactions hold the
 * store lock, so none is in flight). Directories are read one entry at a time; a name that is not the store's is left alone.
 */
export function pruneCarried(carriedDir: string, manifest: CarriedManifest | undefined, fs: FaultableFs): void {
	const named = new Map(Object.values(manifest?.chains ?? {}).map((chain) => [chain.chain, chain]));
	forEachDirectoryEntrySync(carriedDir, (name) => {
		if (CHAIN_NAME_PATTERN.test(name) && !named.has(name))
			rmSync(join(carriedDir, name), { recursive: true, force: true });
	});
	for (const chain of named.values()) {
		const dir = join(carriedDir, chain.chain);
		forEachDirectoryEntrySync(dir, (name) => {
			const staged = atomicTemporaryTarget(name);
			const sequence = CHUNK_FILE_PATTERN.exec(name)?.[1];
			const stale =
				staged !== undefined
					? staged === BASE_FILE || CHUNK_FILE_PATTERN.test(staged)
					: sequence !== undefined && Number(sequence) > chain.chunks;
			if (!stale) return;
			try {
				fs.unlinkSync(join(dir, name));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		});
	}
}
