/**
 * Derived persistence for the transcript summary hierarchy: immutable node files, one authoritative
 * manifest, and the bounded job list. Source bodies stay in canonical sessions; everything here can be
 * rebuilt from them, and nothing here is a second conversation log.
 *
 * Layout under `<agentDir>/state/transcript-memory/<projectId>/`:
 *   nodes/<id>.json   immutable node content, written BEFORE anything references it
 *   manifest.json     schema, writer fence, revision, session cursors, accepted nodes, frontiers, tombstones
 *   jobs.json         bounded scheduler state
 *   writer.lock       advisory lock guarding the manifest transaction
 *
 * Writer model: one lease with a durable fencing token. `acquireWriter` increments `writerFence` under the
 * lock; every transaction re-reads the manifest under the same lock and refuses to publish when the fence
 * is no longer the caller's or the expected revision moved. A newer lease therefore supersedes an older
 * one without any shared in-memory state. Node acceptance, the session cursor and frontier references are
 * one manifest write, so a published frontier can never name a node that was not accepted and present.
 *
 * Durability, stated plainly: `writeFileAtomic` (core/util/atomic-file.ts) writes a uniquely named temporary
 * file and renames it over the destination. It never calls `fsync` on the file or on the directory. That
 * gives atomic visibility: a reader, or a process restart after a process crash, sees the old file or the
 * new one, never a torn one. It does NOT give power-loss or kernel-crash durability: after one, a node
 * file or manifest can be missing or empty even though a rename returned. This store therefore treats
 * every file as untrusted on load (schema, identity and cross-references are verified) and reports damage
 * as an explicit recovery state; derived content is rebuilt from canonical sessions, never trusted blindly.
 * A crash between writing node files and the manifest leaves only unreferenced node files, swept by age.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { stateFile } from "../agent-paths.ts";
import { isMissingFileError, withFileLock, writeFileAtomic } from "../util/atomic-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import type { TranscriptFrontierSelection } from "./transcript-frontier.ts";
import {
	formatTranscriptSourceHandle,
	isTerminalSummaryJobState,
	TRANSCRIPT_SUMMARY_SCHEMA_VERSION,
} from "./transcript-memory-contracts.ts";
import {
	isNonNegativeInteger,
	parseSummaryNode,
	type TranscriptSummaryNode,
	validateParentChildren,
} from "./transcript-summary-node.ts";
import { parseSummaryJob, type TranscriptSummaryJob } from "./transcript-summary-scheduler.ts";

export const TRANSCRIPT_SUMMARY_MAX_PERSISTED_JOBS = 2_000;
export const TRANSCRIPT_SUMMARY_MAX_TOMBSTONES = 10_000;
/** Terminal handoff records kept (newest last). */
export const TRANSCRIPT_SUMMARY_MAX_TERMINALS = 50;
/** Unreferenced node and temporary files younger than this are never swept: their writer may still publish. */
export const TRANSCRIPT_SUMMARY_ORPHAN_MIN_AGE_MS = 10 * 60 * 1000;

const NODE_ID_PATTERN = /^[a-f0-9]{64}$/;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// ---------------------------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------------------------

export interface TranscriptSummarySessionCursor {
	lineageDigest: string;
	/** Leading selected-lineage spans covered by leaves; the next leaf starts here. */
	coveredSpanCount: number;
	/** Ordinal the leaf starting at `coveredSpanCount` will have (leaves are aligned by ordinal). */
	nextOrdinal: number;
}

/** What the manifest knows about an accepted node: enough to revoke dependents without reading node files. */
export interface TranscriptSummaryAcceptedNode {
	level: number;
	ordinal: number;
	sessionId: string;
	fromIndex: number;
	toIndexExclusive: number;
	children?: [string, string];
	/** Handles of the context sources the node consulted (coverage is derivable from the range). */
	contextRefs: string[];
	/** Oldest timestamp among coverage and context dependencies; retention expires the node past its cutoff. */
	oldestDependencyAt?: string;
}

/** A published frontier selection for one lineage; its meaning belongs to transcript-frontier.ts, its integrity to the store. */
export type TranscriptSummaryFrontierRecord = TranscriptFrontierSelection;

export type TranscriptSummaryRevocationReason = "retention" | "invalidated" | "recovery";

export interface TranscriptSummaryTombstone {
	revokedAt: string;
	reason: TranscriptSummaryRevocationReason;
}

export interface TranscriptSummaryManifest {
	schemaVersion: number;
	writerFence: number;
	revision: number;
	sessions: Record<string, TranscriptSummarySessionCursor>;
	acceptedNodes: Record<string, TranscriptSummaryAcceptedNode>;
	frontiers: Record<string, TranscriptSummaryFrontierRecord>;
	/** Retention revocations only: a late result for a forgotten node must not be able to republish it. */
	tombstones: Record<string, TranscriptSummaryTombstone>;
}

function emptyManifest(writerFence: number): TranscriptSummaryManifest {
	return {
		schemaVersion: TRANSCRIPT_SUMMARY_SCHEMA_VERSION,
		writerFence,
		revision: 0,
		sessions: {},
		acceptedNodes: {},
		frontiers: {},
		tombstones: {},
	};
}

type ManifestParse = { ok: true; manifest: TranscriptSummaryManifest } | { ok: false; reason: string };

function parseManifest(raw: string): ManifestParse {
	const fail = (reason: string): ManifestParse => ({ ok: false, reason });
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		return fail(`manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isPlainRecord(value)) return fail("manifest is not an object");
	if (value.schemaVersion !== TRANSCRIPT_SUMMARY_SCHEMA_VERSION) return fail("unsupported manifest schema version");
	if (!isNonNegativeInteger(value.writerFence) || !isNonNegativeInteger(value.revision)) {
		return fail("writerFence or revision is invalid");
	}
	const manifest = emptyManifest(value.writerFence);
	manifest.revision = value.revision;
	if (
		!isPlainRecord(value.sessions) ||
		!isPlainRecord(value.acceptedNodes) ||
		!isPlainRecord(value.frontiers) ||
		!isPlainRecord(value.tombstones)
	) {
		return fail("manifest sections are missing");
	}
	for (const [sessionId, raw] of Object.entries(value.sessions)) {
		if (
			!isPlainRecord(raw) ||
			typeof raw.lineageDigest !== "string" ||
			!isNonNegativeInteger(raw.coveredSpanCount) ||
			!isNonNegativeInteger(raw.nextOrdinal)
		) {
			return fail(`session cursor ${sessionId} is invalid`);
		}
		manifest.sessions[sessionId] = {
			lineageDigest: raw.lineageDigest,
			coveredSpanCount: raw.coveredSpanCount,
			nextOrdinal: raw.nextOrdinal,
		};
	}
	for (const [id, raw] of Object.entries(value.acceptedNodes)) {
		if (!NODE_ID_PATTERN.test(id)) return fail(`accepted node id ${id} is invalid`);
		if (
			!isPlainRecord(raw) ||
			!isNonNegativeInteger(raw.level) ||
			!isNonNegativeInteger(raw.ordinal) ||
			typeof raw.sessionId !== "string" ||
			!isNonNegativeInteger(raw.fromIndex) ||
			!isNonNegativeInteger(raw.toIndexExclusive) ||
			!Array.isArray(raw.contextRefs) ||
			raw.contextRefs.some((entry) => typeof entry !== "string")
		) {
			return fail(`accepted node ${id} is invalid`);
		}
		let children: [string, string] | undefined;
		if (raw.children !== undefined) {
			if (
				!Array.isArray(raw.children) ||
				raw.children.length !== 2 ||
				!NODE_ID_PATTERN.test(String(raw.children[0])) ||
				!NODE_ID_PATTERN.test(String(raw.children[1]))
			) {
				return fail(`accepted node ${id} has invalid children`);
			}
			children = [String(raw.children[0]), String(raw.children[1])];
		}
		manifest.acceptedNodes[id] = {
			level: raw.level,
			ordinal: raw.ordinal,
			sessionId: raw.sessionId,
			fromIndex: raw.fromIndex,
			toIndexExclusive: raw.toIndexExclusive,
			...(children ? { children } : {}),
			contextRefs: raw.contextRefs as string[],
			...(typeof raw.oldestDependencyAt === "string" ? { oldestDependencyAt: raw.oldestDependencyAt } : {}),
		};
	}
	for (const [key, raw] of Object.entries(value.frontiers)) {
		if (
			!isPlainRecord(raw) ||
			!isNonNegativeInteger(raw.coveredThroughIndex) ||
			!isNonNegativeInteger(raw.omittedBeforeIndex) ||
			!isNonNegativeInteger(raw.revision) ||
			!isNonNegativeInteger(raw.allowanceBytes) ||
			!isNonNegativeInteger(raw.recipeVersion) ||
			!Array.isArray(raw.nodeIds) ||
			raw.nodeIds.some((entry) => typeof entry !== "string" || !NODE_ID_PATTERN.test(entry))
		) {
			return fail(`frontier ${key} is invalid`);
		}
		manifest.frontiers[key] = {
			nodeIds: raw.nodeIds as string[],
			omittedBeforeIndex: raw.omittedBeforeIndex,
			coveredThroughIndex: raw.coveredThroughIndex,
			revision: raw.revision,
			allowanceBytes: raw.allowanceBytes,
			recipeVersion: raw.recipeVersion,
		};
	}
	for (const [id, raw] of Object.entries(value.tombstones)) {
		if (
			!isPlainRecord(raw) ||
			typeof raw.revokedAt !== "string" ||
			(raw.reason !== "retention" && raw.reason !== "invalidated" && raw.reason !== "recovery")
		) {
			return fail(`tombstone ${id} is invalid`);
		}
		manifest.tombstones[id] = { revokedAt: raw.revokedAt, reason: raw.reason };
	}
	return { ok: true, manifest };
}

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------

export interface TranscriptSummaryPublishTransaction {
	/** When set, publication is refused unless the manifest is still at exactly this revision. */
	expectedRevision?: number;
	/** Nodes to accept. Their files are written first; parents need their children accepted (here or earlier). */
	nodes?: readonly TranscriptSummaryNode[];
	/** Source cursors to advance in the same write. */
	sessions?: Record<string, TranscriptSummarySessionCursor>;
	/** Frontier records to set; every referenced node must be accepted and present. */
	frontiers?: Record<string, TranscriptSummaryFrontierRecord>;
	removeFrontiers?: readonly string[];
}

export type TranscriptSummaryPublishResult =
	| { status: "published"; revision: number; accepted: string[] }
	| { status: "fenced"; currentFence: number }
	| { status: "stale_revision"; currentRevision: number }
	| { status: "revoked"; nodeIds: string[] }
	| { status: "invalid"; reason: string }
	| { status: "manifest_corrupt"; detail: string };

export type TranscriptSummaryRevokeResult =
	| {
			status: "published";
			revision: number;
			/** Every node removed from the accepted set: the matches and all of their transitive dependents. */
			revoked: string[];
			removedFrontiers: string[];
			/** Node files that could not be deleted; the nodes are revoked either way and the files are unreferenced. */
			unlinkFailures: { id: string; error: string }[];
	  }
	| { status: "fenced"; currentFence: number }
	| { status: "manifest_corrupt"; detail: string };

export type TranscriptSummaryJobsSaveResult =
	| { status: "saved"; pruned: string[] }
	| { status: "jobs_overflow"; active: number }
	| { status: "fenced"; currentFence: number }
	| { status: "manifest_corrupt"; detail: string };

export type TranscriptSummaryNodeRead =
	| { status: "ok"; node: TranscriptSummaryNode }
	| { status: "missing" }
	| { status: "corrupt"; reason: string };

export type TranscriptSummaryRecoveryIssue =
	| { kind: "manifest_corrupt"; detail: string }
	| { kind: "node_missing"; nodeId: string }
	| { kind: "node_corrupt"; nodeId: string; detail: string }
	| { kind: "node_mismatch"; nodeId: string; detail: string }
	| { kind: "child_missing"; nodeId: string; childId: string }
	| { kind: "frontier_dangling"; frontier: string; nodeId: string }
	| { kind: "jobs_corrupt"; detail: string }
	| { kind: "terminals_corrupt"; detail: string };

export interface TranscriptSummaryTerminalCause {
	jobId: string;
	level: number;
	sessionId: string;
	reason: string;
	message: string;
}

/**
 * The bounded terminal handoff of one finished batch of summary work. The owner decides whether and how
 * to surface it; a successful batch is a diagnostic record and must never inject a chat turn.
 */
export interface TranscriptSummaryTerminalRecord {
	batchId: number;
	/** `completed`: every job reached a terminal state. `stopped`: the coordinator stopped with work left. */
	outcome: "completed" | "stopped";
	succeeded: number;
	failed: number;
	cancelled: number;
	stale: number;
	/** Jobs put back on the queue by a stop; they resume on the next start. */
	interrupted: number;
	startedAt: number;
	endedAt: number;
	causes: TranscriptSummaryTerminalCause[];
	/** Set when the coordinator stopped itself because of an unrecoverable condition (superseded writer, corrupt store). */
	stopReason?: string;
}

export interface TranscriptSummaryStoreState {
	/** Undefined when no manifest exists yet, or when it is corrupt (an issue says which). */
	manifest: TranscriptSummaryManifest | undefined;
	/** Every accepted node that loaded and validated. */
	nodes: Map<string, TranscriptSummaryNode>;
	jobs: TranscriptSummaryJob[];
	/** The persisted terminal handoff records, oldest first. */
	terminals: TranscriptSummaryTerminalRecord[];
	issues: TranscriptSummaryRecoveryIssue[];
}

export type TranscriptSummaryWriterAcquisition =
	| { status: "acquired"; writer: TranscriptSummaryWriter }
	| { status: "manifest_corrupt"; detail: string };

export interface TranscriptSummaryRecoveryReport {
	revoked: string[];
	removedFrontiers: string[];
	jobsRewritten: boolean;
}

export interface TranscriptSummaryStoreOptions {
	agentDir: string;
	projectId: string;
	/** Clock for tombstone timestamps; injectable. */
	now?: () => number;
}

// ---------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------

type ManifestRead =
	| { status: "missing" }
	| { status: "ok"; manifest: TranscriptSummaryManifest }
	| { status: "corrupt"; detail: string; raw: string };

function sessionOfHandle(handle: string): string | undefined {
	return handle.split(":")[1];
}

function isTerminalRecord(value: unknown): value is TranscriptSummaryTerminalRecord {
	if (!isPlainRecord(value)) return false;
	return (
		isNonNegativeInteger(value.batchId) &&
		(value.outcome === "completed" || value.outcome === "stopped") &&
		isNonNegativeInteger(value.succeeded) &&
		isNonNegativeInteger(value.failed) &&
		isNonNegativeInteger(value.cancelled) &&
		isNonNegativeInteger(value.stale) &&
		isNonNegativeInteger(value.interrupted) &&
		typeof value.startedAt === "number" &&
		typeof value.endedAt === "number" &&
		Array.isArray(value.causes)
	);
}

export class TranscriptSummaryStore {
	readonly root: string;
	private readonly nodesDir: string;
	private readonly manifestPath: string;
	private readonly jobsPath: string;
	private readonly terminalsPath: string;
	private readonly lockPath: string;
	private readonly now: () => number;

	constructor(options: TranscriptSummaryStoreOptions) {
		if (!PROJECT_ID_PATTERN.test(options.projectId)) {
			throw new RangeError("Transcript memory project id must be a safe path segment.");
		}
		this.root = stateFile(options.agentDir, "transcript-memory", options.projectId);
		this.nodesDir = join(this.root, "nodes");
		this.manifestPath = join(this.root, "manifest.json");
		this.jobsPath = join(this.root, "jobs.json");
		this.terminalsPath = join(this.root, "terminals.json");
		this.lockPath = join(this.root, "writer.lock");
		this.now = options.now ?? Date.now;
	}

	/**
	 * Read and verify everything: the manifest schema, every accepted node file (parse, identity, agreement
	 * with its manifest entry), parent/child links, frontier references and the job list. Damage is returned
	 * as `issues`; nothing is repaired or dropped silently.
	 */
	async load(): Promise<TranscriptSummaryStoreState> {
		return this.locked(async () => {
			const issues: TranscriptSummaryRecoveryIssue[] = [];
			const nodes = new Map<string, TranscriptSummaryNode>();
			const read = await this.readManifest();
			let manifest: TranscriptSummaryManifest | undefined;
			if (read.status === "corrupt") issues.push({ kind: "manifest_corrupt", detail: read.detail });
			if (read.status === "ok") manifest = read.manifest;
			if (manifest) {
				for (const [id, entry] of Object.entries(manifest.acceptedNodes)) {
					const result = await this.readNode(id);
					if (result.status === "missing") {
						issues.push({ kind: "node_missing", nodeId: id });
						continue;
					}
					if (result.status === "corrupt") {
						issues.push({ kind: "node_corrupt", nodeId: id, detail: result.reason });
						continue;
					}
					const node = result.node;
					if (
						node.level !== entry.level ||
						node.ordinal !== entry.ordinal ||
						node.sessionId !== entry.sessionId ||
						node.spanRange.fromIndex !== entry.fromIndex ||
						node.spanRange.toIndexExclusive !== entry.toIndexExclusive
					) {
						issues.push({
							kind: "node_mismatch",
							nodeId: id,
							detail: "node file disagrees with its manifest entry",
						});
						continue;
					}
					nodes.set(id, node);
				}
				for (const [id, node] of nodes) {
					if (!node.children) continue;
					const [leftId, rightId] = node.children;
					const left = nodes.get(leftId);
					const right = nodes.get(rightId);
					if (!left || !right) {
						issues.push({ kind: "child_missing", nodeId: id, childId: left ? rightId : leftId });
						continue;
					}
					const check = validateParentChildren(node, left, right);
					if (!check.ok) issues.push({ kind: "node_mismatch", nodeId: id, detail: check.reason });
				}
				for (const [name, frontier] of Object.entries(manifest.frontiers)) {
					for (const nodeId of frontier.nodeIds) {
						if (!manifest.acceptedNodes[nodeId] || !nodes.has(nodeId)) {
							issues.push({ kind: "frontier_dangling", frontier: name, nodeId });
							break;
						}
					}
				}
			}
			const jobs = await this.readJobs(issues);
			const terminals = await this.readTerminals(issues);
			return { manifest, nodes, jobs, terminals, issues };
		});
	}

	/** The current manifest, or undefined when none exists or it is corrupt (`load()` reports which). */
	async manifest(): Promise<TranscriptSummaryManifest | undefined> {
		return this.locked(async () => {
			const read = await this.readManifest();
			return read.status === "ok" ? read.manifest : undefined;
		});
	}

	/** Read one node file, fully validated. */
	async readNode(id: string): Promise<TranscriptSummaryNodeRead> {
		if (!NODE_ID_PATTERN.test(id)) return { status: "corrupt", reason: "node id is not a SHA-256 hex digest" };
		let raw: string;
		try {
			raw = await fs.readFile(join(this.nodesDir, `${id}.json`), "utf8");
		} catch (error) {
			if (isMissingFileError(error)) return { status: "missing" };
			throw error;
		}
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch (error) {
			return {
				status: "corrupt",
				reason: `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		const parsed = parseSummaryNode(value);
		if (!parsed.ok) return { status: "corrupt", reason: parsed.reason };
		if (parsed.node.id !== id) return { status: "corrupt", reason: "file name does not match the node id" };
		return { status: "ok", node: parsed.node };
	}

	/**
	 * Take the writer lease. The fence is incremented under the lock, so any earlier writer's next
	 * transaction fails as `fenced`. A corrupt manifest is refused unless `recoverCorrupt` is set, in which
	 * case the damaged bytes are kept beside it and an empty manifest starts at a fence no earlier writer
	 * could have held (the clock, in milliseconds); derived state is then rebuilt from canonical sessions.
	 */
	async acquireWriter(options: { recoverCorrupt?: boolean } = {}): Promise<TranscriptSummaryWriterAcquisition> {
		return this.locked(async () => {
			const read = await this.readManifest();
			let manifest: TranscriptSummaryManifest;
			if (read.status === "missing") {
				manifest = emptyManifest(1);
			} else if (read.status === "ok") {
				manifest = { ...read.manifest, writerFence: read.manifest.writerFence + 1 };
			} else if (options.recoverCorrupt === true) {
				await writeFileAtomic(`${this.manifestPath}.corrupt.${this.now()}`, read.raw, { mode: 0o600 });
				manifest = emptyManifest(Math.max(1, this.now()));
			} else {
				return { status: "manifest_corrupt" as const, detail: read.detail };
			}
			await this.writeManifest(manifest);
			return { status: "acquired" as const, writer: new TranscriptSummaryWriter(this, manifest.writerFence) };
		});
	}

	// ---- internals shared with the writer ------------------------------------------------------

	/** @internal */
	locked<T>(fn: () => Promise<T>): Promise<T> {
		return withFileLock(this.lockPath, fn);
	}

	/** @internal Caller holds the lock. */
	async readManifest(): Promise<ManifestRead> {
		let raw: string;
		try {
			raw = await fs.readFile(this.manifestPath, "utf8");
		} catch (error) {
			if (isMissingFileError(error)) return { status: "missing" };
			throw error;
		}
		const parsed = parseManifest(raw);
		return parsed.ok
			? { status: "ok", manifest: parsed.manifest }
			: { status: "corrupt", detail: parsed.reason, raw };
	}

	/** @internal Caller holds the lock. */
	async writeManifest(manifest: TranscriptSummaryManifest): Promise<void> {
		await writeFileAtomic(this.manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
	}

	/** @internal Caller holds the lock. */
	async writeNodeFile(node: TranscriptSummaryNode): Promise<void> {
		await writeFileAtomic(join(this.nodesDir, `${node.id}.json`), `${JSON.stringify(node)}\n`, { mode: 0o600 });
	}

	/** @internal Caller holds the lock. Missing files are not failures: the node is gone either way. */
	async unlinkNodeFile(id: string): Promise<void> {
		try {
			await fs.unlink(join(this.nodesDir, `${id}.json`));
		} catch (error) {
			if (!isMissingFileError(error)) throw error;
		}
	}

	/** @internal Caller holds the lock. */
	async writeJobs(jobs: readonly TranscriptSummaryJob[]): Promise<void> {
		await writeFileAtomic(
			this.jobsPath,
			`${JSON.stringify({ schemaVersion: TRANSCRIPT_SUMMARY_SCHEMA_VERSION, jobs })}\n`,
			{
				mode: 0o600,
			},
		);
	}

	/** @internal Caller holds the lock. */
	async readJobs(issues: TranscriptSummaryRecoveryIssue[]): Promise<TranscriptSummaryJob[]> {
		let raw: string;
		try {
			raw = await fs.readFile(this.jobsPath, "utf8");
		} catch (error) {
			if (isMissingFileError(error)) return [];
			throw error;
		}
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch (error) {
			issues.push({
				kind: "jobs_corrupt",
				detail: `jobs.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
			});
			return [];
		}
		if (
			!isPlainRecord(value) ||
			value.schemaVersion !== TRANSCRIPT_SUMMARY_SCHEMA_VERSION ||
			!Array.isArray(value.jobs)
		) {
			issues.push({ kind: "jobs_corrupt", detail: "jobs.json has an unsupported shape" });
			return [];
		}
		const jobs: TranscriptSummaryJob[] = [];
		const seen = new Set<string>();
		for (const entry of value.jobs) {
			const parsed = parseSummaryJob(entry);
			if (!parsed.ok) {
				issues.push({ kind: "jobs_corrupt", detail: parsed.reason });
				continue;
			}
			if (seen.has(parsed.job.id)) {
				issues.push({ kind: "jobs_corrupt", detail: `duplicate job ${parsed.job.id}` });
				continue;
			}
			seen.add(parsed.job.id);
			jobs.push(parsed.job);
		}
		return jobs;
	}

	/** @internal Caller holds the lock. */
	async readTerminals(issues: TranscriptSummaryRecoveryIssue[]): Promise<TranscriptSummaryTerminalRecord[]> {
		let raw: string;
		try {
			raw = await fs.readFile(this.terminalsPath, "utf8");
		} catch (error) {
			if (isMissingFileError(error)) return [];
			throw error;
		}
		try {
			const value: unknown = JSON.parse(raw);
			if (
				!isPlainRecord(value) ||
				value.schemaVersion !== TRANSCRIPT_SUMMARY_SCHEMA_VERSION ||
				!Array.isArray(value.events)
			) {
				throw new Error("unsupported shape");
			}
			return value.events.filter(isTerminalRecord);
		} catch (error) {
			issues.push({
				kind: "terminals_corrupt",
				detail: `terminals.json is unreadable: ${error instanceof Error ? error.message : String(error)}`,
			});
			return [];
		}
	}

	/** @internal Caller holds the lock. */
	async writeTerminals(events: readonly TranscriptSummaryTerminalRecord[]): Promise<void> {
		await writeFileAtomic(
			this.terminalsPath,
			`${JSON.stringify({ schemaVersion: TRANSCRIPT_SUMMARY_SCHEMA_VERSION, events })}\n`,
			{ mode: 0o600 },
		);
	}

	/** @internal Caller holds the lock. */
	async readNodeFileRaw(id: string): Promise<string | undefined> {
		try {
			return await fs.readFile(join(this.nodesDir, `${id}.json`), "utf8");
		} catch (error) {
			if (isMissingFileError(error)) return undefined;
			throw error;
		}
	}

	/** @internal Caller holds the lock. */
	async backupCorruptJobs(): Promise<void> {
		let raw: string;
		try {
			raw = await fs.readFile(this.jobsPath, "utf8");
		} catch (error) {
			if (isMissingFileError(error)) return;
			throw error;
		}
		await writeFileAtomic(`${this.jobsPath}.corrupt.${this.now()}`, raw, { mode: 0o600 });
	}

	/** @internal Caller holds the lock. */
	async sweep(accepted: ReadonlySet<string>, minAgeMs: number): Promise<string[]> {
		let names: string[];
		try {
			names = await fs.readdir(this.nodesDir);
		} catch (error) {
			if (isMissingFileError(error)) return [];
			throw error;
		}
		const removed: string[] = [];
		const cutoff = this.now() - minAgeMs;
		for (const name of names) {
			const id = name.endsWith(".json") ? name.slice(0, -".json".length) : undefined;
			if (id !== undefined && accepted.has(id)) continue;
			const path = join(this.nodesDir, name);
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
				removed.push(name);
			} catch (error) {
				if (!isMissingFileError(error)) throw error;
			}
		}
		return removed;
	}

	/** @internal */
	clock(): number {
		return this.now();
	}
}

// ---------------------------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------------------------

/** One lease holder. Every method re-checks the fence under the lock; a superseded writer only ever gets `fenced`. */
export class TranscriptSummaryWriter {
	readonly fence: number;
	private readonly store: TranscriptSummaryStore;

	constructor(store: TranscriptSummaryStore, fence: number) {
		this.store = store;
		this.fence = fence;
	}

	/**
	 * Run `body` under the store lock with the manifest this writer's fence still owns. The one owner of the
	 * fence check: a missing or corrupt manifest and a superseded fence come back as typed refusals before
	 * the body runs.
	 */
	private fenced<T>(
		body: (manifest: TranscriptSummaryManifest) => Promise<T>,
	): Promise<T | { status: "manifest_corrupt"; detail: string } | { status: "fenced"; currentFence: number }> {
		return this.store.locked(async () => {
			const read = await this.store.readManifest();
			if (read.status !== "ok") {
				return read.status === "corrupt"
					? { status: "manifest_corrupt" as const, detail: read.detail }
					: { status: "fenced" as const, currentFence: 0 };
			}
			if (read.manifest.writerFence !== this.fence) {
				return { status: "fenced" as const, currentFence: read.manifest.writerFence };
			}
			return body(read.manifest);
		});
	}

	/** Accept nodes, advance cursors and set frontiers in one manifest write. */
	async publish(transaction: TranscriptSummaryPublishTransaction): Promise<TranscriptSummaryPublishResult> {
		return this.fenced(async (manifest) => {
			if (transaction.expectedRevision !== undefined && transaction.expectedRevision !== manifest.revision) {
				return { status: "stale_revision" as const, currentRevision: manifest.revision };
			}
			const incoming = [...(transaction.nodes ?? [])].sort((a, b) => a.level - b.level);
			const revoked = incoming
				.filter((node) => manifest.tombstones[node.id]?.reason === "retention")
				.map((node) => node.id);
			if (revoked.length > 0) return { status: "revoked" as const, nodeIds: revoked };

			// Validate in level order so a parent can see children accepted earlier in the same transaction.
			const known = new Map<string, TranscriptSummaryNode>();
			const lookup = async (id: string): Promise<TranscriptSummaryNode | undefined> => {
				const inTransaction = known.get(id);
				if (inTransaction) return inTransaction;
				if (!manifest.acceptedNodes[id]) return undefined;
				const result = await this.store.readNode(id);
				return result.status === "ok" ? result.node : undefined;
			};
			for (const node of incoming) {
				const parsed = parseSummaryNode(JSON.parse(JSON.stringify(node)));
				if (!parsed.ok) return { status: "invalid" as const, reason: `node ${node.id}: ${parsed.reason}` };
				if (node.children) {
					const left = await lookup(node.children[0]);
					const right = await lookup(node.children[1]);
					if (!left || !right) {
						return {
							status: "invalid" as const,
							reason: `node ${node.id}: a child is not accepted or not readable`,
						};
					}
					const check = validateParentChildren(node, left, right);
					if (!check.ok) return { status: "invalid" as const, reason: `node ${node.id}: ${check.reason}` };
				}
				known.set(node.id, node);
			}

			// Node content first. An accepted id is immutable: different content under it is a conflict.
			for (const node of incoming) {
				if (manifest.acceptedNodes[node.id]) {
					const existing = await this.store.readNode(node.id);
					if (existing.status === "ok" && existing.node.text !== node.text) {
						return {
							status: "invalid" as const,
							reason: `node ${node.id} is already accepted with different content`,
						};
					}
					if (existing.status === "ok") continue;
				}
				await this.store.writeNodeFile(node);
			}

			// Every referenced node must be accepted and readable before any reference is published.
			const accepted = new Set([...Object.keys(manifest.acceptedNodes), ...incoming.map((node) => node.id)]);
			const referenced = new Set<string>(incoming.map((node) => node.id));
			for (const frontier of Object.values(transaction.frontiers ?? {})) {
				for (const nodeId of frontier.nodeIds) {
					if (!accepted.has(nodeId)) {
						return { status: "invalid" as const, reason: `frontier references unaccepted node ${nodeId}` };
					}
					referenced.add(nodeId);
				}
			}
			for (const id of referenced) {
				const result = await this.store.readNode(id);
				if (result.status !== "ok") {
					return {
						status: "invalid" as const,
						reason: `node ${id} is ${result.status === "missing" ? "missing" : `corrupt (${result.reason})`}`,
					};
				}
			}

			const next: TranscriptSummaryManifest = {
				...manifest,
				revision: manifest.revision + 1,
				sessions: { ...manifest.sessions, ...(transaction.sessions ?? {}) },
				acceptedNodes: { ...manifest.acceptedNodes },
				frontiers: { ...manifest.frontiers, ...(transaction.frontiers ?? {}) },
			};
			for (const name of transaction.removeFrontiers ?? []) delete next.frontiers[name];
			for (const node of incoming) {
				next.acceptedNodes[node.id] = {
					level: node.level,
					ordinal: node.ordinal,
					sessionId: node.sessionId,
					fromIndex: node.spanRange.fromIndex,
					toIndexExclusive: node.spanRange.toIndexExclusive,
					...(node.children ? { children: node.children } : {}),
					contextRefs: node.contextRefs.map(formatTranscriptSourceHandle),
					...(node.oldestDependencyAt !== undefined ? { oldestDependencyAt: node.oldestDependencyAt } : {}),
				};
			}
			await this.store.writeManifest(next);
			return { status: "published" as const, revision: next.revision, accepted: incoming.map((node) => node.id) };
		});
	}

	/**
	 * Revoke every accepted node the predicate matches and, transitively, every node that has a revoked
	 * node as a child. Frontiers naming a revoked node are removed, session cursors are pulled back to the
	 * earliest revoked position, and the node files are deleted after the manifest no longer references
	 * them. `retention` additionally tombstones the ids so a late result cannot republish forgotten content.
	 */
	async revokeNodes(
		predicate: (id: string, entry: TranscriptSummaryAcceptedNode) => boolean,
		reason: TranscriptSummaryRevocationReason,
		options: { dropSessionCursor?: string; tombstoneSession?: string } = {},
	): Promise<TranscriptSummaryRevokeResult> {
		return this.fenced(async (manifest) => {
			return this.applyRevocation(
				manifest,
				predicate,
				reason,
				options.dropSessionCursor,
				[],
				options.tombstoneSession,
			);
		});
	}

	/**
	 * Drop everything derived from one session: its nodes, the nodes in other sessions that consulted it as
	 * context, all of their ancestors, and its source cursor, in a single publish.
	 */
	async invalidateSession(sessionId: string): Promise<TranscriptSummaryRevokeResult> {
		return this.revokeNodes(
			(_id, entry) =>
				entry.sessionId === sessionId || entry.contextRefs.some((handle) => sessionOfHandle(handle) === sessionId),
			"invalidated",
			{ dropSessionCursor: sessionId },
		);
	}

	/** Replace the persisted job list. Terminal jobs are pruned oldest-first; live work is never pruned. */
	async saveJobs(jobs: readonly TranscriptSummaryJob[]): Promise<TranscriptSummaryJobsSaveResult> {
		return this.fenced(async () => {
			const live = jobs.filter((job) => !isTerminalSummaryJobState(job.state));
			if (live.length > TRANSCRIPT_SUMMARY_MAX_PERSISTED_JOBS) {
				return { status: "jobs_overflow" as const, active: live.length };
			}
			const terminal = jobs
				.filter((job) => isTerminalSummaryJobState(job.state))
				.sort((a, b) => (b.terminalAt ?? b.updatedAt) - (a.terminalAt ?? a.updatedAt));
			const keepTerminal = terminal.slice(0, TRANSCRIPT_SUMMARY_MAX_PERSISTED_JOBS - live.length);
			const pruned = terminal.slice(keepTerminal.length).map((job) => job.id);
			const kept = new Set([...live, ...keepTerminal].map((job) => job.id));
			await this.store.writeJobs(jobs.filter((job) => kept.has(job.id)));
			return { status: "saved" as const, pruned };
		});
	}

	/**
	 * Apply the repair for the issues `load()` reported: revoke damaged nodes and their ancestors, drop
	 * dangling frontiers, and rewrite a corrupt job list from its valid entries (the damaged bytes are kept).
	 * A corrupt manifest is not repaired here; it is replaced through `acquireWriter({ recoverCorrupt })`.
	 */
	async applyRecovery(issues: readonly TranscriptSummaryRecoveryIssue[]): Promise<TranscriptSummaryRecoveryReport> {
		const damaged = new Set<string>();
		const frontiers = new Set<string>();
		let jobsCorrupt = false;
		for (const issue of issues) {
			if (
				issue.kind === "node_missing" ||
				issue.kind === "node_corrupt" ||
				issue.kind === "node_mismatch" ||
				issue.kind === "child_missing"
			) {
				damaged.add(issue.nodeId);
			} else if (issue.kind === "frontier_dangling") {
				frontiers.add(issue.frontier);
			} else if (issue.kind === "jobs_corrupt") {
				jobsCorrupt = true;
			}
		}
		const report: TranscriptSummaryRecoveryReport = { revoked: [], removedFrontiers: [], jobsRewritten: false };
		if (damaged.size > 0 || frontiers.size > 0) {
			const result = await this.store.locked(async () => {
				const read = await this.store.readManifest();
				if (read.status !== "ok") throw new Error("Recovery needs a readable manifest.");
				if (read.manifest.writerFence !== this.fence) throw new Error("Recovery writer was superseded.");
				const manifest = read.manifest;
				for (const name of frontiers) delete manifest.frontiers[name];
				return this.applyRevocation(manifest, (id) => damaged.has(id), "recovery", undefined, [...frontiers]);
			});
			if (result.status !== "published") throw new Error(`Recovery was not published: ${result.status}.`);
			report.revoked = result.revoked;
			report.removedFrontiers = result.removedFrontiers;
		}
		if (jobsCorrupt) {
			await this.store.locked(async () => {
				const read = await this.store.readManifest();
				if (read.status !== "ok" || read.manifest.writerFence !== this.fence) {
					throw new Error("Recovery writer was superseded.");
				}
				const validJobs = await this.store.readJobs([]);
				await this.store.backupCorruptJobs();
				await this.store.writeJobs(validJobs);
			});
			report.jobsRewritten = true;
		}
		return report;
	}

	/**
	 * Append one terminal handoff record, keeping the newest {@link TRANSCRIPT_SUMMARY_MAX_TERMINALS}.
	 * Returns false when this writer was superseded (the record is then not persisted).
	 */
	async recordTerminal(record: TranscriptSummaryTerminalRecord): Promise<boolean> {
		return this.store.locked(async () => {
			const read = await this.store.readManifest();
			if (read.status !== "ok" || read.manifest.writerFence !== this.fence) return false;
			const events = await this.store.readTerminals([]);
			events.push(record);
			await this.store.writeTerminals(events.slice(-TRANSCRIPT_SUMMARY_MAX_TERMINALS));
			return true;
		});
	}

	/** Delete node files no manifest entry references and that are old enough that no writer can still publish them. */
	async sweepOrphans(minAgeMs = TRANSCRIPT_SUMMARY_ORPHAN_MIN_AGE_MS): Promise<string[]> {
		return this.store.locked(async () => {
			const read = await this.store.readManifest();
			if (read.status !== "ok" || read.manifest.writerFence !== this.fence) return [];
			return this.store.sweep(new Set(Object.keys(read.manifest.acceptedNodes)), minAgeMs);
		});
	}

	/** Caller holds the lock and has verified the fence. */
	private async applyRevocation(
		manifest: TranscriptSummaryManifest,
		predicate: (id: string, entry: TranscriptSummaryAcceptedNode) => boolean,
		reason: TranscriptSummaryRevocationReason,
		dropSessionCursor: string | undefined,
		alsoRemoveFrontiers: readonly string[] = [],
		tombstoneSession?: string,
	): Promise<TranscriptSummaryRevokeResult> {
		const revoked = new Set<string>();
		for (const [id, entry] of Object.entries(manifest.acceptedNodes)) {
			if (predicate(id, entry)) revoked.add(id);
		}
		// Ancestors depend on their children; close over the parent edges.
		const parentsOf = new Map<string, string[]>();
		for (const [id, entry] of Object.entries(manifest.acceptedNodes)) {
			for (const child of entry.children ?? []) {
				const parents = parentsOf.get(child);
				if (parents) parents.push(id);
				else parentsOf.set(child, [id]);
			}
		}
		const pending = [...revoked];
		for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
			for (const parent of parentsOf.get(id) ?? []) {
				if (!revoked.has(parent)) {
					revoked.add(parent);
					pending.push(parent);
				}
			}
		}

		const next: TranscriptSummaryManifest = {
			...manifest,
			revision: manifest.revision + 1,
			sessions: { ...manifest.sessions },
			acceptedNodes: { ...manifest.acceptedNodes },
			frontiers: { ...manifest.frontiers },
			tombstones: { ...manifest.tombstones },
		};
		// Only a revoked LEAF moves a session cursor back: leaves are what the cursor counts. A revoked parent
		// leaves its children in place, so the span range it covered is still covered.
		const earliestLeafBySession = new Map<string, { fromIndex: number; ordinal: number }>();
		for (const id of revoked) {
			const entry = manifest.acceptedNodes[id];
			if (!entry) continue;
			const earliest = earliestLeafBySession.get(entry.sessionId);
			if (entry.level === 0 && (earliest === undefined || entry.fromIndex < earliest.fromIndex)) {
				earliestLeafBySession.set(entry.sessionId, { fromIndex: entry.fromIndex, ordinal: entry.ordinal });
			}
			delete next.acceptedNodes[id];
			if (reason === "retention") {
				next.tombstones[id] = { revokedAt: new Date(this.store.clock()).toISOString(), reason };
			}
		}
		for (const [sessionId, earliest] of earliestLeafBySession) {
			const cursor = next.sessions[sessionId];
			if (cursor && cursor.coveredSpanCount > earliest.fromIndex) {
				next.sessions[sessionId] = {
					...cursor,
					coveredSpanCount: earliest.fromIndex,
					nextOrdinal: earliest.ordinal,
				};
			}
		}
		if (tombstoneSession !== undefined) {
			next.tombstones[`session:${tombstoneSession}`] = {
				revokedAt: new Date(this.store.clock()).toISOString(),
				reason: "retention",
			};
		}
		if (dropSessionCursor !== undefined) delete next.sessions[dropSessionCursor];
		const removedFrontiers: string[] = [...alsoRemoveFrontiers];
		for (const [name, frontier] of Object.entries(next.frontiers)) {
			if (frontier.nodeIds.some((nodeId) => revoked.has(nodeId))) {
				delete next.frontiers[name];
				removedFrontiers.push(name);
			}
		}
		const tombstoneIds = Object.keys(next.tombstones);
		if (tombstoneIds.length > TRANSCRIPT_SUMMARY_MAX_TOMBSTONES) {
			tombstoneIds
				.sort((a, b) => (next.tombstones[a]?.revokedAt ?? "").localeCompare(next.tombstones[b]?.revokedAt ?? ""))
				.slice(0, tombstoneIds.length - TRANSCRIPT_SUMMARY_MAX_TOMBSTONES)
				.forEach((id) => {
					delete next.tombstones[id];
				});
		}
		await this.store.writeManifest(next);

		// The manifest no longer references the nodes; only now remove their content.
		const unlinkFailures: { id: string; error: string }[] = [];
		for (const id of revoked) {
			try {
				await this.store.unlinkNodeFile(id);
			} catch (error) {
				unlinkFailures.push({ id, error: error instanceof Error ? error.message : String(error) });
			}
		}
		return { status: "published", revision: next.revision, revoked: [...revoked], removedFrontiers, unlinkFailures };
	}
}
