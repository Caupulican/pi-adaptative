/**
 * The archive of released orchestration records: one canonical file per prune under the session's bundle
 * (`archive/<archiveId>.json`), written before the `retention.pruned` event deletes the records, so a released record
 * stays readable. The module owns the archive's path, its content and digest, the commit test (an archive is committed
 * exactly when the projection names its id), the orphan sweep with its grace period, and the verified reader the historical
 * accounting folds in. Verified archives are cached per process, keyed by path and validated by mtime and size.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JsonObject } from "../../kernel/utils/json-types.ts";
import { canonicalDigest, canonicalJson } from "../steering/canonical.ts";
import { isMissingFileError, writeFileAtomicSync } from "../util/atomic-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import { toJsonObject } from "./contracts.ts";
import type { RetentionDependents, RetentionSelection } from "./retention-eligibility.ts";
import { retentionArchiveId } from "./retention-event.ts";

/**
 * An archive no committed prune names is an orphan only once its file is this old. A pass writes the archive and then
 * commits it, so a younger unnamed archive may belong to a commit still in flight.
 */
export const ARCHIVE_ORPHAN_GRACE_MS = 3_600_000;

/** `<session bundle>/archive`: where a session's released records are archived. The store's root is `<bundle>/events`. */
export function retentionArchiveDir(eventStoreRootDir: string): string {
	return join(dirname(eventStoreRootDir), "archive");
}

export interface RetentionArchiveContent {
	readonly version: 1;
	readonly sessionId: string;
	readonly cutoff: string;
	readonly objectiveIds: readonly string[];
	readonly taskIds: readonly string[];
	readonly attemptIds: readonly string[];
	readonly planIds: readonly string[];
	readonly dependents: RetentionDependents;
	/** Raw projection JSON, exactly as the snapshot holds it, keyed by the ids the selection names. */
	readonly records: {
		readonly objectives: JsonObject;
		readonly tasks: JsonObject;
		readonly attempts: JsonObject;
		readonly checkpoints: JsonObject;
		readonly notifications: JsonObject;
		readonly approvals: JsonObject;
		readonly plans: JsonObject;
		readonly threadSubscriptions: JsonObject;
	};
	/** The agent carry the prune writes, for audit. */
	readonly agentCarry: JsonObject;
}

export interface RetentionArchiveFile extends RetentionArchiveContent {
	/** sha256 of the canonical content (every field above, without `digest`). */
	readonly digest: string;
}

/** The raw slice of one projection map: the listed ids that are present, copied as plain JSON. */
function sliceRecords(source: unknown, ids: readonly string[]): JsonObject {
	if (!isPlainRecord(source)) throw new Error("Retention archive source is not a projection map.");
	const slice: Record<string, unknown> = {};
	for (const id of ids) if (Object.hasOwn(source, id)) slice[id] = source[id];
	return toJsonObject(slice);
}

/**
 * The archive content one selection releases. `projection` is the snapshot as plain JSON (`toJsonObject(state)`), so the
 * slices are the exact records the snapshot holds. The digest is over the canonical content, and the id is derived from it.
 */
export function buildRetentionArchive(args: {
	readonly sessionId: string;
	readonly cutoff: string;
	readonly selection: RetentionSelection;
	readonly projection: JsonObject;
}): RetentionArchiveFile {
	const { selection, projection } = args;
	const content: RetentionArchiveContent = {
		version: 1,
		sessionId: args.sessionId,
		cutoff: args.cutoff,
		objectiveIds: selection.objectiveIds,
		taskIds: selection.taskIds,
		attemptIds: selection.attemptIds,
		planIds: selection.planIds,
		dependents: selection.dependents,
		records: {
			objectives: sliceRecords(projection.objectives, selection.objectiveIds),
			tasks: sliceRecords(projection.tasks, selection.taskIds),
			attempts: sliceRecords(projection.attempts, selection.attemptIds),
			checkpoints: sliceRecords(projection.checkpoints, selection.dependents.checkpointIds),
			notifications: sliceRecords(projection.notifications, selection.dependents.notificationIds),
			approvals: sliceRecords(projection.approvals, selection.dependents.approvalIds),
			plans: sliceRecords(projection.plans, selection.planIds),
			threadSubscriptions: sliceRecords(projection.threadSubscriptions, selection.dependents.subscriptionIds),
		},
		agentCarry: toJsonObject(Object.fromEntries(selection.carry)),
	};
	return { ...content, digest: canonicalDigest(content) };
}

function archiveNames(dir: string): string[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch (error) {
		if (isMissingFileError(error)) return [];
		throw error;
	}
	return names.filter((name) => name.endsWith(".json")).sort();
}

function readTextIfPresent(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if (isMissingFileError(error)) return undefined;
		throw error;
	}
}

function statIfPresent(path: string) {
	try {
		return statSync(path);
	} catch (error) {
		if (isMissingFileError(error)) return undefined;
		throw error;
	}
}

/**
 * Writes one archive under the bundle admission the caller holds. A file already at this id must hold the same bytes,
 * which a repeated prune of the same selection does; different bytes are refused, never overwritten.
 */
export function writeRetentionArchive(dir: string, file: RetentionArchiveFile): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${retentionArchiveId(file.digest)}.json`);
	const bytes = canonicalJson(file);
	const existing = readTextIfPresent(path);
	if (existing === undefined) writeFileAtomicSync(path, bytes);
	else if (existing !== bytes) {
		throw new Error(`Retention archive ${path} exists with different content; the prune is not committed.`);
	}
	return path;
}

/** The archive the text holds, or undefined when it is not JSON or its digest does not cover its content. */
function verifyRetentionArchive(text: string): RetentionArchiveFile | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isPlainRecord(parsed) || parsed.version !== 1 || typeof parsed.digest !== "string") return undefined;
	const { digest, ...content } = parsed;
	// A matching digest proves the file holds the content the prune wrote; the decoders that read its records check their shape.
	return canonicalDigest(content) === digest ? (parsed as unknown as RetentionArchiveFile) : undefined;
}

export interface RetentionArchiveRead {
	readonly archives: readonly RetentionArchiveFile[];
	/** Files that do not verify; they are left in place. */
	readonly corrupt: readonly string[];
}

/** A verified (or failed) archive remembered for this process, valid while its file keeps the mtime and size it had. */
interface CachedArchive {
	readonly mtimeMs: number;
	readonly size: number;
	readonly archive: RetentionArchiveFile | undefined;
}

const archiveCache = new Map<string, CachedArchive>();

interface VisitedArchive {
	readonly path: string;
	readonly mtimeMs: number;
	/** The verified archive; undefined when the file does not verify. */
	readonly archive: RetentionArchiveFile | undefined;
}

/**
 * Visits every archive file of the directory. A file whose mtime and size match its cache entry is neither re-read nor
 * re-hashed, so an idle pass costs one stat per archive. Failed verifications are cached too, or a corrupt file would be
 * re-hashed on every pass.
 */
function visitArchives(dir: string, visit: (entry: VisitedArchive) => void): void {
	const present = new Set<string>();
	for (const name of archiveNames(dir)) {
		const path = join(dir, name);
		const stat = statIfPresent(path);
		if (stat === undefined) continue;
		present.add(path);
		let cached = archiveCache.get(path);
		if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
			const text = readTextIfPresent(path);
			if (text === undefined) continue;
			cached = { mtimeMs: stat.mtimeMs, size: stat.size, archive: verifyRetentionArchive(text) };
			archiveCache.set(path, cached);
		}
		visit({ path, mtimeMs: stat.mtimeMs, archive: cached.archive });
	}
	for (const path of archiveCache.keys()) {
		if (dirname(path) === dir && !present.has(path)) archiveCache.delete(path);
	}
}

/** Every archive in the directory that verifies. A missing directory holds none. */
export function readRetentionArchives(dir: string): RetentionArchiveRead {
	const archives: RetentionArchiveFile[] = [];
	const corrupt: string[] = [];
	visitArchives(dir, ({ path, archive }) => {
		if (archive === undefined) corrupt.push(path);
		else archives.push(archive);
	});
	return { archives, corrupt };
}

/**
 * True exactly when a committed prune named this archive: its id, derived from the digest, is in the projection's list of
 * committed archive ids. The list is the durable form of each `retention.pruned` event's `archiveId`, so the test does not
 * depend on the records the prune released (a released id can be created again later).
 */
export function archiveIsCommitted(archive: RetentionArchiveFile, committed: ReadonlySet<string>): boolean {
	return committed.has(retentionArchiveId(archive.digest));
}

export interface RetentionSweep {
	/** The session the sweep serves. An archive of another session is not this session's to delete. */
	readonly sessionId: string;
	/** The archive ids the projection names as committed. */
	readonly committed: ReadonlySet<string>;
	/**
	 * The orchestration clock in epoch milliseconds. The grace compares it with each file's mtime, which is wall time, so the
	 * clock must be wall time too (it is, in production).
	 */
	readonly nowMs: number;
}

/**
 * Deletes each orphan archive and returns the files kept for inspection: those that do not verify and those of another
 * session, which are never deleted. A verified archive of this session is an orphan only when no committed prune names it
 * and its file is older than `ARCHIVE_ORPHAN_GRACE_MS`. Runs under the bundle admission, before the pass plans.
 */
export function sweepRetentionArchives(dir: string, sweep: RetentionSweep): readonly string[] {
	const kept: string[] = [];
	visitArchives(dir, ({ path, mtimeMs, archive }) => {
		if (archive === undefined || archive.sessionId !== sweep.sessionId) {
			kept.push(path);
			return;
		}
		if (archiveIsCommitted(archive, sweep.committed) || mtimeMs > sweep.nowMs - ARCHIVE_ORPHAN_GRACE_MS) return;
		rmSync(path, { force: true });
		archiveCache.delete(path);
	});
	return kept;
}
