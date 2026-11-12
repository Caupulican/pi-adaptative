import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	type Stats,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { ImageContent, Message, TextContent, Usage } from "@caupulican/pi-ai/types";
import {
	type BashExecutionMessage,
	type CustomMessage,
	createBranchSummaryMessage,
	createCustomMessage,
} from "../messages.ts";
import { ownerInputIdOf } from "../owner-input-stamp.ts";
import { sameFileVersion } from "../storage/bounded-file.ts";
import type { AgentMessage, AgentMessageOrigin } from "../types.ts";
import { createEmptyUsage, validateUsageComponents } from "../usage.ts";
import type { UsageComponent } from "../usage-components.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import {
	encodeSessionEntry,
	type ForegroundToolStartInput,
	indexSessionLifecycle,
	inspectSessionLifecycle,
	isSessionLifecycleEntry,
	planSessionLifecycleRepair,
	type SessionLifecycleIndex,
	type SessionLifecycleInspection,
	type SessionLifecycleRepairPlan,
	type SessionRequestSnapshotInput,
	sessionLifecycleToolIdentityKey,
	validateLoadedLifecycleEntries,
	validateSessionLifecycleEntry,
} from "./lifecycle-ledger.ts";
import { compactToolResultDetailsForRetention } from "./message-retention.ts";
import {
	assertParentInputVisible,
	isParentNoteOwnerId,
	MAX_PARENT_WAKE_CHARS,
	MAX_PARENT_WAKE_INPUTS,
	MAX_PENDING_PARENT_INPUTS,
	PARENT_INPUT_CONSUMED_CUSTOM_TYPE,
	PARENT_INPUT_SETTLED_CUSTOM_TYPE,
	PARENT_INPUT_SKIPPED_CUSTOM_TYPE,
	PARENT_INPUT_WAKE_CUSTOM_TYPE,
	PARENT_INPUT_WAKE_REQUEST_CUSTOM_TYPE,
	PARENT_NOTE_REQUEST_CUSTOM_TYPE,
	type ParentInputAppendReceipt,
	type ParentInputConsumptionSource,
	ParentInputIndex,
	type ParentInputMode,
	type ParentInputOrigin,
	type ParentInputWake,
	type ParentNoteSelection,
	type PersistedParentInput,
	parentInputMetadataOfMessage,
	parentInputOf,
	parentNoteMarker,
	parentWakeContent,
	parentWakeMarker,
} from "./parent-input-ledger.ts";
import {
	captureSessionAppendIdentity,
	captureSessionAppendWriteIdentity,
	expectedSessionAppendDurability,
	SessionAppendCommittedError,
	type SessionAppendIdentity,
	type SessionAppendReceipt,
	SessionAppendUncertainError,
} from "./session-append-receipt.ts";
import { sessionChannelHost } from "./session-bundle-lifecycle.ts";
import {
	buildSessionContext,
	cloneSessionContext,
	customMessageEntries,
	deliveredOwnerInput,
	deliveredTurnOrigin,
	deliveredWorkerControl,
	retainSynthesizedSessionContextMessage,
} from "./session-context-builder.ts";
import type {
	BranchSummaryEntry,
	CompactionEndEntry,
	CompactionEntry,
	CompactionRetention,
	CompactionStartEntry,
	CustomEntry,
	CustomMessageEntry,
	ForegroundToolStartEntry,
	ForegroundToolTerminalEntry,
	LabelEntry,
	ModelChangeEntry,
	ProviderRequestTerminalEntry,
	RequestSnapshotEntry,
	SessionEntry,
	SessionInfoEntry,
	SessionMessageEntry,
	ThinkingLevelChangeEntry,
} from "./session-entries.ts";
import { SessionEntryEvidenceIndex } from "./session-entry-evidence-index.ts";
import { MAX_SESSION_ENTRY_VISIT_COUNT } from "./session-entry-limits.ts";
import { publishSessionFileExclusive, withSessionFileMutation } from "./session-file-admission.ts";
import {
	assertAdoptableSessionHeader,
	COMPACTED_PAYLOAD_RELEASE_MIN_CHARS,
	collectParentSessionIds,
	ENTRY_ID_PREFIX_BYTES,
	indexSessionEntryFileLocations,
	loadEntriesFromFile,
	loadEntriesFromFileInternal,
	parseSessionEntryLine,
	readSessionHeader,
	retainedStringChars,
	type SessionEntryFileLocation,
	sessionCwdMatches,
} from "./session-file-reading.ts";
import { appendToExistingSessionFile, withSessionFileLock, writeSessionFile } from "./session-file-writing.ts";
import type { SessionHeader } from "./session-header.ts";
import { assistantToolIdentityKey, createSessionId, generateId, pendingIdSpace } from "./session-id-generation.ts";
import { assertValidSessionId } from "./session-identity.ts";
import {
	buildSessionInfosWithConcurrency,
	countSessionFiles,
	findMostRecentSessionInDirs,
	listSessionsFromDir,
	requiresSessionFile,
	type SessionListProgress,
} from "./session-listing.ts";
import type {
	FileEntry,
	NewSessionOptions,
	SessionContext,
	SessionEntriesPersistedEvent,
	SessionEntriesPersistedListener,
	SessionInfo,
	SessionMessageBatchEntry,
	SessionObserverErrorListener,
	SessionTreeNode,
} from "./session-manager-types.ts";
import { invalidSessionParentCycle, visitSessionAncestry } from "./session-tree.ts";
import {
	CURRENT_SESSION_VERSION,
	FIRST_SESSION_VERSION_WITH_ENTRY_IDS,
	migrateToCurrentVersion,
} from "./session-version-migration.ts";
import { WORKER_PROJECT_ENROLLMENT_CUSTOM_TYPE } from "./worker-project-enrollment.ts";

export * from "./lifecycle-ledger.ts";
export {
	buildSessionContext,
	getLatestCompactionEntry,
	isWholePathCompaction,
	retainedEntryIdsBeforeCompaction,
	type SessionContextItem,
	sessionContextItems,
	summarizedGapEntryIds,
} from "./session-context-builder.ts";
export { MAX_SESSION_ENTRY_VISIT_COUNT } from "./session-entry-limits.ts";
export { loadEntriesFromFile, parseSessionEntries, visitSessionEntriesAsync } from "./session-file-reading.ts";
export { readSessionHeaderResult, type SessionHeader, type SessionHeaderReadResult } from "./session-header.ts";
export { isAutoLearnSessionId } from "./session-id-generation.ts";
export {
	assertValidSessionId,
	isSessionIdentity,
	isValidSessionId,
	MAX_SESSION_HEADER_BYTES,
} from "./session-identity.ts";
export { findMostRecentSession, type SessionListProgress } from "./session-listing.ts";
export type {
	FileEntry,
	NewSessionOptions,
	SessionContext,
	SessionEntriesPersistedEvent,
	SessionEntriesPersistedListener,
	SessionInfo,
	SessionMessageBatchEntry,
	SessionObserverErrorListener,
	SessionTreeNode,
} from "./session-manager-types.ts";
export {
	CURRENT_SESSION_VERSION,
	FIRST_SESSION_VERSION_WITH_ENTRY_IDS,
	migrateSessionEntries,
} from "./session-version-migration.ts";

/** Maximum normal message/custom-message records in one atomic append batch. */
export const MAX_SESSION_MESSAGE_BATCH_ENTRIES = 256;

interface SessionContextCache {
	leafId: string | null;
	context: SessionContext;
}

/**
 * Per-custom-type memo of the last `getLatestCustomEntryOnBranch` answer for the current leaf. A
 * miss is remembered too: without it every request that asks for an absent record type (task
 * automation, task directory) walked the whole branch again. Keyed by the `byId` index it was
 * computed against, so any index replacement (reload, fork, branch rebuild, new session) drops it
 * whole; bounded to a few live types, never one slot per historical entry.
 */
interface LatestCustomEntryCache {
	readonly byId: Map<string, SessionEntry>;
	readonly perType: Map<string, { leafId: string | null; match: CustomEntry | undefined }>;
}

const MAX_LATEST_CUSTOM_ENTRY_CACHE_TYPES = 32;

interface BranchCustomEntriesCache {
	readonly byId: Map<string, SessionEntry>;
	readonly perKey: Map<string, { leafId: string | null; entries: readonly CustomEntry[] }>;
}

interface LifecycleActiveCache {
	leafId: string | null;
	currentRequestId?: string;
	positions: Map<string, number>;
	entryTypes: Map<string, string>;
	requestIds: Set<string>;
	requestSnapshotsById: Map<string, RequestSnapshotEntry>;
	providerTerminalsByRequest: Set<string>;
	providerResponsesByRequest: Map<string, ProviderResponseReference | "duplicate">;
	startsByIdentity: Set<string>;
	terminalsByIdentity: Set<string>;
	compactionStarts: Map<string, CompactionStartEntry>;
	compactionEnds: Set<string>;
	assistantToolsByIdentity: Map<string, AssistantToolReference | "duplicate">;
}

interface ProviderResponseReference {
	assistantMessageEntryId: string;
	outcome: Exclude<ProviderRequestTerminalEntry["outcome"], "interrupted">;
}

interface AssistantToolReference {
	requestId?: string;
	toolName: string;
}

interface SessionPersistenceResult {
	readonly event: SessionEntriesPersistedEvent;
	/** The write was confirmed by readback; its original I/O error must still reach the caller after publication. */
	readonly recoveredFailure?: { readonly error: unknown };
}

export type ReadonlySessionManager = Pick<
	SessionManager,
	| "getCwd"
	| "getSessionDir"
	| "getSessionId"
	| "getSessionLineageIds"
	| "getSessionFile"
	| "getLeafId"
	| "getLeafEntry"
	| "getEntry"
	| "getLabel"
	| "getBranch"
	| "getLatestCustomEntryOnBranch"
	| "getCustomEntriesOnBranch"
	| "getHeader"
	| "getEntries"
	| "getEntryCount"
	| "buildSessionContext"
	| "visitEntries"
	| "readEntryJsonPrefix"
	| "onEntriesPersisted"
	| "getTree"
	| "getSessionName"
	| "getSessionLifecycleIndex"
	| "inspectSessionLifecycle"
	| "planSessionLifecycleRepair"
>;

/**
 * Compute the default session directory for a cwd without creating it.
 * Encodes cwd into a safe directory name under ~/.pi/agent/sessions/; persistence creates the
 * parent only when the first durable entry is written.
 */
function getEncodedSessionDirName(cwd: string): string {
	return `--${encodeURIComponent(resolvePath(cwd))}--`;
}

function getLegacySessionDirPath(cwd: string, agentDir: string): string {
	const resolvedCwd = resolvePath(cwd);
	const resolvedAgentDir = resolvePath(agentDir);
	const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(resolvedAgentDir, "sessions", safePath);
}

function getDefaultSessionDirPath(cwd: string, agentDir: string): string {
	const resolvedAgentDir = resolvePath(agentDir);
	return join(resolvedAgentDir, "sessions", getEncodedSessionDirName(cwd));
}

/** Current default session directory first, then the legacy-encoded one when it differs. */
export function getDefaultSessionDirCandidates(cwd: string, agentDir: string): string[] {
	const current = getDefaultSessionDirPath(cwd, agentDir);
	const legacy = getLegacySessionDirPath(cwd, agentDir);
	return current === legacy ? [current] : [current, legacy];
}

export function getDefaultSessionDir(cwd: string, agentDir: string): string {
	return getDefaultSessionDirPath(cwd, agentDir);
}

/**
 * Manages conversation sessions as append-only trees stored in JSONL files.
 *
 * Each session entry has an id and parentId forming a tree structure. The "leaf"
 * pointer tracks the current position. Appending creates a child of the current leaf.
 * Branching moves the leaf to an earlier entry, allowing new branches without
 * modifying history.
 *
 * Use buildSessionContext() to get the resolved message list for the LLM, which
 * handles compaction summaries and follows the path from root to current leaf.
 */
export class SessionManager {
	private sessionId: string = "";
	private sessionFile: string | undefined;
	private sessionDir: string;
	private cwd: string;
	/**
	 * Agent config dir (e.g. ~/.pi/agent) used to compute the default session-dir candidates for
	 * usesDefaultSessionDir(). Injected explicitly by the caller — SessionManager never resolves it
	 * from app config. Empty string for in-memory sessions (no default dir applies).
	 */
	private agentDir: string;
	private persist: boolean;
	private readonly readOnly: boolean;
	private readonly canonicalOnly: boolean;
	private payloadsHaveStoredIds = true;
	private storageRevision: Stats | undefined;
	private flushed: boolean = false;
	private fileEntries: FileEntry[] = [];
	private entries: SessionEntry[] = [];
	private byId: Map<string, SessionEntry> = new Map();
	/**
	 * Persisted message object -> entry id, so "is this exact message object persisted, and where"
	 * is O(1) instead of a walk over the branch. Built lazily from `byId` and kept in step with
	 * appends; rebuilt whenever `byId` is replaced (a reload or branch rebuild), which the identity
	 * guard detects. Weak, so a message that leaves memory leaves the index.
	 */
	private messageEntryIndex:
		| { readonly byId: Map<string, SessionEntry>; readonly ids: WeakMap<object, string> }
		| undefined;
	private labelsById: Map<string, string> = new Map();
	private labelTimestampsById: Map<string, string> = new Map();
	private leafId: string | null = null;
	private entryFileLocations = new Map<string, SessionEntryFileLocation>();
	private coldPayloadEntryIds = new Set<string>();
	private indexedSessionFileBytes = 0;
	private sessionContextCache: SessionContextCache | undefined;
	private lifecycleActiveCache: LifecycleActiveCache | undefined;
	private latestCustomEntryCache: LatestCustomEntryCache | undefined;
	private branchCustomEntriesCache: BranchCustomEntriesCache | undefined;
	private persistenceStateUncertain = false;
	/** The fence value the listeners last saw, so a value that is set and cleared inside one operation announces nothing. */
	private persistenceFenceAnnounced = false;
	private readonly persistenceFenceListeners = new Set<() => void>();
	private navigationRevision = 0;
	private inheritedSessionIds = new Set<string>();
	private readonly entriesPersistedListeners = new Set<SessionEntriesPersistedListener>();
	private readonly observerErrorListeners = new Set<SessionObserverErrorListener>();
	private parentInputCache:
		| { byId: Map<string, SessionEntry>; leafId: string | null; index: ParentInputIndex }
		| undefined;
	private parentInputReceipts:
		| { byId: Map<string, SessionEntry>; count: number; deliveries: Map<string, PersistedParentInput> }
		| undefined;
	private activeParentWake: { wakeId: string; assertCurrent: () => void } | undefined;
	private parentNoteAdmission:
		| {
				epoch: number;
				assertCurrent: () => void;
				owners: Map<string, { selection?: ParentNoteSelection; ownerEntryId?: string; used: boolean }>;
		  }
		| undefined;
	private plannedParentNotes: ParentNoteSelection | undefined;
	private parentEvidenceCache:
		| { byId: Map<string, SessionEntry>; count: number; index: SessionEntryEvidenceIndex }
		| undefined;

	private constructor(
		cwd: string,
		sessionDir: string,
		sessionFile: string | undefined,
		persist: boolean,
		agentDir: string,
		newSessionOptions?: NewSessionOptions,
		readOnly = false,
		canonicalOnly = false,
	) {
		this.cwd = resolvePath(cwd);
		this.sessionDir = normalizePath(sessionDir);
		this.agentDir = agentDir;
		this.persist = persist;
		this.readOnly = readOnly;
		this.canonicalOnly = canonicalOnly;

		if (sessionFile) {
			if (readOnly) {
				assertAdoptableSessionHeader(resolvePath(sessionFile));
				this._setSessionFile(sessionFile);
			} else {
				this.setSessionFile(sessionFile);
			}
		} else {
			this.newSession(newSessionOptions);
		}
	}

	/** Switch to a different session file (used for resume and branching) */
	setSessionFile(sessionFile: string): void {
		this._assertWritable();
		// Judged before this manager changes any state: a rejected file leaves the manager and the file as they were.
		assertAdoptableSessionHeader(resolvePath(sessionFile));
		const previousNavigationRevision = this.navigationRevision;
		this.navigationRevision++;
		const recoveringUncertainWrite = this.persistenceStateUncertain;
		this.persistenceStateUncertain = true;
		let receipt: SessionEntriesPersistedEvent | undefined;
		try {
			receipt = this._setSessionFile(sessionFile, recoveringUncertainWrite);
			this.persistenceStateUncertain = false;
		} catch (error) {
			if (recoveringUncertainWrite || this.canonicalOnly) {
				this.navigationRevision = previousNavigationRevision;
				this.persistenceStateUncertain = recoveringUncertainWrite;
			} else this.persistenceStateUncertain = true;
			this._announcePersistenceFence();
			throw error;
		}
		this._announcePersistenceFence();
		if (receipt) this._emitEntriesPersisted(receipt);
	}

	private _setSessionFile(sessionFile: string, requireComplete = false): SessionEntriesPersistedEvent | undefined {
		const mustReadComplete = requireComplete || this.canonicalOnly;
		if (!mustReadComplete) return this._loadSessionFile(sessionFile, false);
		// Strict loads never repair or migrate storage. Their in-memory adoption is therefore
		// transactional too: a failed parse/index/read leaves the original live view intact.
		const previous = {
			sessionId: this.sessionId,
			sessionFile: this.sessionFile,
			fileEntries: this.fileEntries,
			entries: this.entries,
			byId: this.byId,
			messageEntryIndex: this.messageEntryIndex,
			labelsById: this.labelsById,
			labelTimestampsById: this.labelTimestampsById,
			leafId: this.leafId,
			entryFileLocations: this.entryFileLocations,
			coldPayloadEntryIds: this.coldPayloadEntryIds,
			indexedSessionFileBytes: this.indexedSessionFileBytes,
			sessionContextCache: this.sessionContextCache,
			lifecycleActiveCache: this.lifecycleActiveCache,
			latestCustomEntryCache: this.latestCustomEntryCache,
			branchCustomEntriesCache: this.branchCustomEntriesCache,
			payloadsHaveStoredIds: this.payloadsHaveStoredIds,
			storageRevision: this.storageRevision,
			flushed: this.flushed,
			inheritedSessionIds: this.inheritedSessionIds,
		};
		// Parsing releases payloads into these two indexes; never clear or populate the old view's maps.
		this.entryFileLocations = new Map();
		this.coldPayloadEntryIds = new Set();
		try {
			return this._loadSessionFile(sessionFile, true);
		} catch (error) {
			Object.assign(this, previous);
			throw error;
		}
	}

	private _loadSessionFile(sessionFile: string, mustReadComplete: boolean): SessionEntriesPersistedEvent | undefined {
		this._invalidateSessionContextCache();
		this._resetEntryFileIndex(true);
		this.sessionFile = resolvePath(sessionFile);
		if (existsSync(this.sessionFile)) {
			let payloadsHaveStoredIds = false;
			// The session file is the cold payload arena. Release each large payload as
			// soon as its JSONL record is parsed so GC can reclaim it during this pass;
			// waiting until the complete history is loaded makes peak heap proportional
			// to file size and can OOM before post-load compaction cleanup runs.
			const loaded = loadEntriesFromFileInternal(
				this.sessionFile,
				{ requireComplete: mustReadComplete },
				(entry, offset, length) => {
					if (entry.type === "session") {
						payloadsHaveStoredIds = (entry.version ?? 1) >= FIRST_SESSION_VERSION_WITH_ENTRY_IDS;
						return;
					}
					// Legacy migration mints entry IDs. Its payloads cannot refer back to the
					// original file until a writable open has published those IDs there.
					if (entry.type !== "message" || !payloadsHaveStoredIds) return;
					this._releaseMessageProperty(entry, "content");
					this._releaseMessageProperty(entry, "output");
					if (offset !== undefined && length !== undefined && this.coldPayloadEntryIds.has(entry.id)) {
						this.entryFileLocations.set(entry.id, { offset, length });
					}
				},
			);
			if (
				mustReadComplete &&
				(loaded.unterminatedTail ||
					loaded.entries[0]?.type !== "session" ||
					loaded.entries[0].version !== CURRENT_SESSION_VERSION)
			) {
				throw new Error("Canonical history must already have a current header and complete records.");
			}
			this.fileEntries = loaded.entries;
			this.payloadsHaveStoredIds = payloadsHaveStoredIds;
			let sourceRevision = loaded.revision;
			if (!sourceRevision) throw new Error("Session file disappeared while opening it.");
			this.storageRevision = sourceRevision;
			let indexedEveryColdPayload = true;
			for (const id of this.coldPayloadEntryIds) {
				if (this.entryFileLocations.has(id)) continue;
				indexedEveryColdPayload = false;
				break;
			}
			if (indexedEveryColdPayload) this.indexedSessionFileBytes = loaded.indexedBytes;

			// Only a genuinely empty file may be initialized in place. Any non-empty file
			// without a valid header is preserved for explicit recovery rather than destroyed.
			if (this.fileEntries.length === 0) {
				if (this.readOnly) throw new Error("Cannot inspect an empty or invalid session file.");
				if (loaded.indexedBytes > 0) {
					throw new Error(`Session file does not begin with a valid session header: ${this.sessionFile}`);
				}
				const explicitPath = this.sessionFile;
				this._resetEntryFileIndex(true);
				this.newSession();
				this.sessionFile = explicitPath;
				const receipt = this._rewriteFile(this.sessionFile, sourceRevision);
				this.flushed = true;
				return receipt;
			}

			const loadedHeader = this.fileEntries[0];
			if (loadedHeader.type !== "session") throw new Error("Session header is missing.");
			this.sessionId = loadedHeader.id;

			this.inheritedSessionIds = collectParentSessionIds(loadedHeader.parentSession, dirname(this.sessionFile));
			this._ensureEntryFileLocations(this.coldPayloadEntryIds);

			const migrated = migrateToCurrentVersion(this.fileEntries);
			validateLoadedLifecycleEntries(this.fileEntries);
			// Validate and index the complete parent graph before a migration rewrite can
			// mutate the source file. Malformed cycles must fail synchronously on cold open.
			this._buildIndex();
			if (loaded.unterminatedTail && !this.readOnly) {
				sourceRevision = withSessionFileMutation(
					this.agentDir,
					this.sessionFile,
					this.sessionId,
					"append",
					() => appendToExistingSessionFile(this.sessionFile!, "\n", sourceRevision),
					{ session: this, revision: this.storageRevision },
				);
				this.storageRevision = sourceRevision;
				if (this.indexedSessionFileBytes > 0) this.indexedSessionFileBytes += 1;
			}
			const receipt = migrated && !this.readOnly ? this._rewriteFile(this.sessionFile, sourceRevision) : undefined;
			if (migrated && !this.readOnly) this.payloadsHaveStoredIds = true;

			// Bound in-memory retention: oversized tool result details from disk would
			// otherwise be pinned in fileEntries for the whole process lifetime.
			for (const entry of this.fileEntries) {
				if (entry.type === "message") compactToolResultDetailsForRetention(entry.message);
			}

			this.flushed = true;
			if (payloadsHaveStoredIds || !this.readOnly) this._releaseExistingCompactedMessagePayloads();
			return receipt;
		} else {
			if (this.readOnly || mustReadComplete) throw new Error("Cannot open a missing existing session file.");
			const explicitPath = this.sessionFile;
			this.newSession();
			this.sessionFile = explicitPath; // preserve explicit path from --session flag
		}
	}

	newSession(options?: NewSessionOptions): string | undefined {
		this._assertWritable();
		this.navigationRevision++;
		this.payloadsHaveStoredIds = true;
		this.storageRevision = undefined;
		if (options?.id !== undefined) {
			assertValidSessionId(options.id);
		}
		this.sessionId = options?.id ?? createSessionId();
		this.inheritedSessionIds = collectParentSessionIds(options?.parentSession, this.sessionDir || this.cwd);
		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionId,
			timestamp,
			cwd: this.cwd,
			parentSession: options?.parentSession,
		};
		this.fileEntries = [header];
		this.entries = [];
		this.byId.clear();
		this.messageEntryIndex = undefined;
		this.labelsById.clear();
		this.labelTimestampsById.clear();
		this.leafId = null;
		this.lifecycleActiveCache = undefined;
		this.latestCustomEntryCache = undefined;
		this.branchCustomEntriesCache = undefined;
		this.flushed = false;
		this.persistenceStateUncertain = false;
		this._announcePersistenceFence();
		this._invalidateSessionContextCache();
		this._resetEntryFileIndex(true);

		if (this.persist) {
			const fileTimestamp = timestamp.replace(/[:.]/g, "-");
			this.sessionFile = join(this.getSessionDir(), `${fileTimestamp}_${this.sessionId}.jsonl`);
		}
		return this.sessionFile;
	}

	private _resetEntryFileIndex(clearColdPayloads = false): void {
		this.entryFileLocations.clear();
		this.indexedSessionFileBytes = 0;
		if (clearColdPayloads) this.coldPayloadEntryIds.clear();
	}

	private _buildIndex(): void {
		this._invalidateSessionContextCache();
		const entries: SessionEntry[] = [];
		const byId = new Map<string, SessionEntry>();
		const labelsById = new Map<string, string>();
		const labelTimestampsById = new Map<string, string>();
		let leafId: string | null = null;
		for (const entry of this.fileEntries) {
			if (entry.type === "session") continue;
			if (typeof entry.id !== "string" || entry.id.length === 0) {
				throw new Error("Invalid session entry graph: every entry requires a non-empty string id.");
			}
			if (byId.has(entry.id)) {
				throw new Error(`Invalid session entry graph: duplicate entry id "${entry.id}".`);
			}
			if (entry.parentId !== null && typeof entry.parentId !== "string") {
				throw new Error(`Invalid session entry graph: entry "${entry.id}" has a malformed parent id.`);
			}
			entries.push(entry);
			byId.set(entry.id, entry);
			leafId = entry.id;
			if (entry.type === "label") {
				if (entry.label) {
					labelsById.set(entry.targetId, entry.label);
					labelTimestampsById.set(entry.targetId, entry.timestamp);
				} else {
					labelsById.delete(entry.targetId);
					labelTimestampsById.delete(entry.targetId);
				}
			}
		}

		const settledEntryIds = new Set<string>();
		for (const entry of entries) {
			if (settledEntryIds.has(entry.id)) continue;
			const activeEntryIds = new Set<string>();
			const traversedEntryIds: string[] = [];
			visitSessionAncestry(entry, byId, (current) => {
				if (settledEntryIds.has(current.id)) return false;
				if (activeEntryIds.has(current.id)) {
					throw invalidSessionParentCycle(current.id);
				}
				activeEntryIds.add(current.id);
				traversedEntryIds.push(current.id);
			});
			for (const entryId of traversedEntryIds) settledEntryIds.add(entryId);
		}

		this.entries = entries;
		this.byId = byId;
		this.labelsById = labelsById;
		this.labelTimestampsById = labelTimestampsById;
		this.leafId = leafId;
		this.lifecycleActiveCache = undefined;
		this.latestCustomEntryCache = undefined;
		this.branchCustomEntriesCache = undefined;
		for (const id of this.coldPayloadEntryIds) {
			if (!byId.has(id)) this.coldPayloadEntryIds.delete(id);
		}
	}

	private _ensureSessionFileParent(targetFile: string): void {
		const parentDir = dirname(targetFile);
		if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
	}

	private _rewriteFile(targetFile = this.sessionFile, expected?: Stats): SessionEntriesPersistedEvent | undefined {
		this._assertWritable();
		if (!this.persist || !targetFile) return;
		return withSessionFileMutation(
			this.agentDir,
			targetFile,
			this.sessionId,
			expected ? (expected.size === 0 ? "initialize" : "rewrite") : "create",
			() => {
				const assertCurrent = this._capturePersistenceContext();
				this._ensureSessionFileParent(targetFile);
				// Write-then-rename keeps the session file valid at every instant: truncating
				// in place leaves a torn-file window for crashes or a concurrent process
				// appending to the same session.
				const tempFile = `${targetFile}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
				try {
					const fd = openSync(tempFile, "wx");
					try {
						for (const entry of this.fileEntries) {
							writeFileSync(
								fd,
								`${entry.type === "session" ? JSON.stringify(entry) : encodeSessionEntry(entry)}\n`,
							);
						}
					} finally {
						closeSync(fd);
					}
					withSessionFileLock(targetFile, () => {
						assertCurrent();
						if (expected) {
							if (!sameFileVersion(expected, statSync(targetFile)))
								throw new Error("Session file changed before its rewrite; reopen it before retrying.");
							renameSync(tempFile, targetFile);
						} else {
							// New branch publication must not replace a file created while serialization ran.
							publishSessionFileExclusive(tempFile, targetFile);
						}
					});
				} finally {
					try {
						unlinkSync(tempFile);
					} catch {
						/* Link/rename publication stands even if temporary cleanup fails. */
					}
				}
				if (targetFile === this.sessionFile) {
					try {
						this.storageRevision = statSync(targetFile);
					} catch {
						this.storageRevision = undefined;
					}
					this._resetEntryFileIndex();
					return Object.freeze({
						sessionId: this.sessionId,
						sessionFile: targetFile,
						entryIds: Object.freeze(
							this.fileEntries.flatMap((entry) => (entry.type === "session" ? [] : [entry.id])),
						),
						rewritten: true,
					});
				}
			},
			{ session: this, revision: expected ?? this.storageRevision },
		);
	}

	isPersisted(): boolean {
		return this.persist;
	}

	/** A configured path alone does not mean the first buffered entries have reached disk. */
	hasDurableSessionFile(): boolean {
		return this.persist && this.flushed && this.sessionFile !== undefined;
	}

	/** Whether the entry is already written to the session file. Entries buffered before the first flush are not. */
	isEntryPersisted(entryId: string): boolean {
		return this.persist && this._getEntryFileLocation(entryId) !== undefined;
	}

	isEntryDurableForSession(entryId: string): boolean {
		return this.persist ? this.isEntryPersisted(entryId) : !this.persistenceStateUncertain && this.byId.has(entryId);
	}

	/** Whether a failed write left the file's state unknown: appends are refused until the file is reopened. */
	isPersistenceStateUncertain(): boolean {
		return this.persistenceStateUncertain;
	}

	/**
	 * Calls the listener when the fence above is set or lifted, after the operation settled (a value set and cleared inside
	 * one operation announces nothing). Called synchronously inside the write or reopen: it reads
	 * `isPersistenceStateUncertain()` and must not write to the session. Returns the unsubscribe.
	 */
	onPersistenceFenceChange(listener: () => void): () => void {
		this.persistenceFenceListeners.add(listener);
		return () => {
			this.persistenceFenceListeners.delete(listener);
		};
	}

	private _announcePersistenceFence(): void {
		if (this.persistenceStateUncertain === this.persistenceFenceAnnounced) return;
		this.persistenceFenceAnnounced = this.persistenceStateUncertain;
		for (const listener of [...this.persistenceFenceListeners]) {
			try {
				listener();
			} catch {
				// An indicator never fails the write or reopen it observes.
			}
		}
	}

	/** Fence work across navigation while allowing ordinary appends on its original branch. */
	captureBranchContext(): () => void {
		const { sessionId, sessionFile, navigationRevision } = this;
		return () => {
			if (
				this.sessionId !== sessionId ||
				this.sessionFile !== sessionFile ||
				this.navigationRevision !== navigationRevision
			)
				throw new Error("Session branch changed before work was admitted.");
		};
	}

	/** Persist the buffered prefix when another durable owner is about to reference it. Nothing buffered is not a write. */
	flushBufferedEntries(): void {
		if (!this.persist || this.flushed) return;
		this._assertWritable();
		const identity = captureSessionAppendIdentity(this.sessionId, this.sessionFile, []);
		const result = this._persistEntries([], [], undefined, this._capturePersistenceContext(), {
			flushBuffered: true,
			identity,
			canonicalPublication: true,
		});
		if (result) this._emitEntriesPersisted(result.event);
		if (result?.recoveredFailure)
			throw new SessionAppendCommittedError({ ...identity, durability: "persisted" }, result.recoveredFailure.error);
	}

	getCwd(): string {
		return this.cwd;
	}

	getSessionDir(): string {
		return this.sessionDir;
	}

	usesDefaultSessionDir(): boolean {
		return getDefaultSessionDirCandidates(this.cwd, this.agentDir).includes(this.sessionDir);
	}

	getSessionId(): string {
		return this.sessionId;
	}

	/** Current session id followed by the bounded, de-duplicated ids of sessions it was forked from. */
	getSessionLineageIds(): string[] {
		return [this.sessionId, ...[...this.inheritedSessionIds].filter((id) => id !== this.sessionId)];
	}

	getSessionFile(): string | undefined {
		return this.sessionFile;
	}

	private _ensureEntryFileLocations(retainedIds: ReadonlySet<string>): void {
		if (!this.payloadsHaveStoredIds) return;
		if (retainedIds.size === 0 || !this.sessionFile || !existsSync(this.sessionFile)) return;
		const fileBytes = statSync(this.sessionFile).size;
		if (fileBytes < this.indexedSessionFileBytes) this._resetEntryFileIndex();
		const allLocated = (): boolean => {
			for (const id of retainedIds) {
				if (!this.entryFileLocations.has(id)) return false;
			}
			return true;
		};
		if (allLocated()) return;
		const scanStart = this.indexedSessionFileBytes;
		if (fileBytes > scanStart) {
			this.indexedSessionFileBytes = indexSessionEntryFileLocations(
				this.sessionFile,
				scanStart,
				this.entryFileLocations,
				retainedIds,
			);
			if (allLocated()) return;
		}
		// The missing target may precede the incremental cursor. Rebuild only for the bounded
		// requested set; forward sequential pages continue from the exact prior line boundary.
		if (scanStart === 0) return;
		this._resetEntryFileIndex();
		this.indexedSessionFileBytes = indexSessionEntryFileLocations(
			this.sessionFile,
			0,
			this.entryFileLocations,
			retainedIds,
		);
	}

	private _getEntryFileLocation(entryId: string): SessionEntryFileLocation | undefined {
		if (!this.payloadsHaveStoredIds) return undefined;
		let location = this.entryFileLocations.get(entryId);
		if (location) return location;
		this._ensureEntryFileLocations(new Set([entryId]));
		location = this.entryFileLocations.get(entryId);
		return location;
	}

	private _readCompactedMessageProperty(entryId: string, property: "content" | "output"): unknown {
		if (!this.sessionFile) throw new Error(`Compacted session payload ${entryId} is unavailable`);
		const location = this._getEntryFileLocation(entryId);
		if (!location) throw new Error(`Compacted session payload ${entryId} is unavailable`);
		const fd = openSync(this.sessionFile, "r");
		const buffer = Buffer.allocUnsafe(location.length);
		let bytesRead = 0;
		try {
			while (bytesRead < buffer.length) {
				const count = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, location.offset + bytesRead);
				if (count === 0) break;
				bytesRead += count;
			}
		} finally {
			closeSync(fd);
		}
		const entry = parseSessionEntryLine(buffer.subarray(0, bytesRead).toString("utf8"));
		if (entry?.type !== "message" || entry.id !== entryId) {
			throw new Error(`Compacted session payload ${entryId} could not be restored`);
		}
		return (entry.message as unknown as Record<string, unknown>)[property];
	}

	private _releaseMessageProperty(entry: SessionMessageEntry, property: "content" | "output"): void {
		const message = entry.message as unknown as Record<string, unknown>;
		const descriptor = Object.getOwnPropertyDescriptor(message, property);
		if (!descriptor || descriptor.get || !("value" in descriptor)) return;
		if (
			retainedStringChars(descriptor.value, COMPACTED_PAYLOAD_RELEASE_MIN_CHARS) <
			COMPACTED_PAYLOAD_RELEASE_MIN_CHARS
		) {
			return;
		}
		const entryId = entry.id;
		const enumerable = descriptor.enumerable;
		this.coldPayloadEntryIds.add(entryId);
		Object.defineProperty(message, property, {
			configurable: true,
			enumerable,
			get: () => this._readCompactedMessageProperty(entryId, property),
			set: (value: unknown) => {
				Object.defineProperty(message, property, {
					configurable: true,
					enumerable,
					writable: true,
					value,
				});
			},
		});
	}

	private _releasableMessageProperties(entry: SessionMessageEntry): Array<"content" | "output"> {
		const message = entry.message as unknown as Record<string, unknown>;
		const properties: Array<"content" | "output"> = [];
		for (const property of ["content", "output"] as const) {
			const descriptor = Object.getOwnPropertyDescriptor(message, property);
			if (
				descriptor &&
				!descriptor.get &&
				"value" in descriptor &&
				retainedStringChars(descriptor.value, COMPACTED_PAYLOAD_RELEASE_MIN_CHARS) >=
					COMPACTED_PAYLOAD_RELEASE_MIN_CHARS
			) {
				properties.push(property);
			}
		}
		return properties;
	}

	private _releaseExistingCompactedMessagePayloads(): void {
		const leaf = this.leafId ? this.byId.get(this.leafId) : undefined;
		visitSessionAncestry(leaf, this.byId, (current) => {
			if (current.type === "compaction") {
				this._releaseCompactedMessagePayloads(
					current.firstKeptEntryId,
					current.parentId,
					current.retention,
					current.id,
				);
				return false;
			}
		});
	}

	private _releaseCompactedMessagePayloads(
		firstKeptEntryId: string,
		compactionParentId: string | null,
		retention?: CompactionRetention,
		compactionEntryId?: string,
	): void {
		if (!this.persist || !this.flushed || !this.sessionFile) return;
		const keptEntryIds = new Set<string>();
		let foundFirstKept = false;
		const compactionParent = compactionParentId ? this.byId.get(compactionParentId) : undefined;
		if (retention?.mode === "original-user") {
			// A checkpoint that keeps nothing before its summary has no anchor to find: every message before it is replaced.
			const userEntryId = retention.userEntryId;
			if (userEntryId === undefined) foundFirstKept = true;
			else {
				visitSessionAncestry(compactionParent, this.byId, (current) => {
					if (current.id === userEntryId) {
						keptEntryIds.add(current.id);
						foundFirstKept = true;
						return false;
					}
				});
			}
			const leaf = this.leafId ? this.byId.get(this.leafId) : undefined;
			visitSessionAncestry(leaf, this.byId, (current) => {
				if (current.id === compactionEntryId) return false;
				if (current.type === "message") keptEntryIds.add(current.id);
			});
		} else {
			visitSessionAncestry(compactionParent, this.byId, (current) => {
				keptEntryIds.add(current.id);
				if (current.id === firstKeptEntryId) {
					foundFirstKept = true;
					return false;
				}
			});
		}
		if (!foundFirstKept) return;
		const retainedIds = new Set<string>();
		const releases: Array<{ entry: SessionMessageEntry; properties: Array<"content" | "output"> }> = [];
		for (const entry of this.entries) {
			if (entry.type !== "message") continue;
			const properties = this._releasableMessageProperties(entry);
			if (properties.length === 0) continue;
			retainedIds.add(entry.id);
			if (!keptEntryIds.has(entry.id)) releases.push({ entry, properties });
		}
		this._ensureEntryFileLocations(retainedIds);
		for (const release of releases) {
			if (!this.entryFileLocations.has(release.entry.id)) continue;
			for (const property of release.properties) this._releaseMessageProperty(release.entry, property);
		}
	}

	private _persistEntries(
		entries: readonly SessionEntry[],
		encodedEntries: readonly string[],
		signal?: AbortSignal,
		assertCurrent: () => void = this._capturePersistenceContext(),
		options: {
			flushBuffered?: boolean;
			identity?: SessionAppendIdentity;
			/** Only a caller owning canonical publication may promote a confirmed physical write. */
			canonicalPublication?: true;
		} = {},
	): SessionPersistenceResult | undefined {
		this._assertWritable();
		signal?.throwIfAborted();
		assertCurrent();
		if (!this.persist || !this.sessionFile) return;
		const sessionFile = this.sessionFile;
		const sessionId = this.sessionId;
		const fileEntries = this.fileEntries;
		const identity = options.identity ?? captureSessionAppendIdentity(sessionId, sessionFile, entries);
		if (entries.length !== encodedEntries.length) {
			throw new Error("Session persistence encoding count does not match the entry batch.");
		}
		if (this.persistenceStateUncertain) {
			throw new Error(
				"Session persistence state is uncertain after a failed write; reopen the session file or start a new session before appending.",
			);
		}

		const shouldFlush =
			options.flushBuffered || this.fileEntries.some(requiresSessionFile) || entries.some(requiresSessionFile);
		// Encoding can invoke extension-owned getters. Prepare the entire initial prefix
		// before opening the file, then check cancellation at the last pre-write boundary.
		// Preparation failure is not an uncertain physical write and must remain recoverable.
		const encodedPayload =
			!this.flushed && shouldFlush
				? `${this.fileEntries
						.map((candidate) =>
							candidate.type === "session" ? JSON.stringify(candidate) : encodeSessionEntry(candidate),
						)
						.concat(encodedEntries)
						.join("\n")}\n`
				: `${encodedEntries.join("\n")}\n`;
		signal?.throwIfAborted();
		assertCurrent();
		if (!this.flushed && !shouldFlush) return;

		const initialFlush = !this.flushed;
		let writeStarted = false;
		let recoveredFailure: { readonly error: unknown } | undefined;
		const noteRecoveredWrite = (error: unknown): void => {
			recoveredFailure = { error };
		};
		const confirmWrite = options.canonicalPublication ? noteRecoveredWrite : undefined;
		try {
			if (!this.flushed) {
				withSessionFileMutation(this.agentDir, sessionFile, sessionId, "create", () => {
					assertCurrent();
					writeStarted = true;
					this.storageRevision = writeSessionFile(sessionFile, "wx", encodedPayload, undefined, confirmWrite);
				});
				this.flushed = true;
			} else if (encodedEntries.length > 0) {
				withSessionFileMutation(
					this.agentDir,
					sessionFile,
					sessionId,
					entries.length === 1 &&
						entries[0]?.type === "custom" &&
						entries[0].customType === WORKER_PROJECT_ENROLLMENT_CUSTOM_TYPE
						? { enrollmentKey: (entries[0].data as { specializationKey: string }).specializationKey }
						: "append",
					() => {
						assertCurrent();
						writeStarted = true;
						this.storageRevision = appendToExistingSessionFile(
							sessionFile,
							encodedPayload,
							undefined,
							confirmWrite,
						);
					},
					{ session: this, revision: this.storageRevision },
				);
			}
		} catch (error) {
			// append/write/close failures may leave a partial JSONL suffix. Do not publish the
			// entries in memory, and fence every later append until an explicit reload owns the
			// surviving canonical prefix.
			if (
				writeStarted &&
				this.sessionId === sessionId &&
				this.sessionFile === sessionFile &&
				this.fileEntries === fileEntries
			)
				this.persistenceStateUncertain = true;
			this._announcePersistenceFence();
			if (writeStarted)
				throw new SessionAppendUncertainError(
					captureSessionAppendWriteIdentity(identity, encodedEntries),
					recoveredFailure
						? new AggregateError(
								[recoveredFailure.error, error],
								"Session write readback succeeded, but admission failed.",
							)
						: error,
				);
			throw error;
		}
		const tail = fileEntries.at(-1);
		let parentId: string | null = tail === undefined || tail.type === "session" ? null : tail.id;
		const leafAppend =
			!initialFlush &&
			entries.every((entry) => {
				const extendsLeaf = entry.parentId === parentId;
				parentId = entry.id;
				return extendsLeaf;
			});
		return {
			event: Object.freeze({
				sessionId,
				sessionFile,
				entryIds: Object.freeze(
					initialFlush
						? [...fileEntries, ...entries].flatMap((entry) => (entry.type === "session" ? [] : [entry.id]))
						: entries.map((entry) => entry.id),
				),
				rewritten: false,
				...(leafAppend
					? { leafAppend: Object.freeze({ types: Object.freeze(entries.map((entry) => entry.type)) }) }
					: {}),
			}),
			...(recoveredFailure ? { recoveredFailure } : {}),
		};
	}

	private _assertWritable(): void {
		if (this.readOnly) throw new Error("Read-only session inspection cannot mutate history.");
	}

	/** Serialization can call getters; a prepared row must retain the session and branch it was built against. */
	private _capturePersistenceContext(): () => void {
		const { sessionId, sessionFile, leafId, byId, fileEntries } = this;
		const entryCount = fileEntries.length;
		const indexedCount = byId.size;
		return () => {
			if (
				this.sessionId !== sessionId ||
				this.sessionFile !== sessionFile ||
				this.leafId !== leafId ||
				this.byId !== byId ||
				this.fileEntries !== fileEntries ||
				fileEntries.length !== entryCount ||
				byId.size !== indexedCount
			)
				throw new Error("Session context changed while preparing persistence.");
		};
	}

	/**
	 * Subscribe to durable persistence of committed entries. In-memory appends that have not reached
	 * the session file are never announced; a failed or uncertain write announces nothing.
	 */
	onEntriesPersisted(listener: SessionEntriesPersistedListener): () => void {
		this.entriesPersistedListeners.add(listener);
		return () => {
			this.entriesPersistedListeners.delete(listener);
		};
	}

	/**
	 * Subscribe to persistence observers that threw. Called synchronously inside the write that announced the entries
	 * (possibly inside a caller's transaction), so a listener only records the failure and reports it later.
	 */
	onObserverError(listener: SessionObserverErrorListener): () => void {
		this.observerErrorListeners.add(listener);
		return () => {
			this.observerErrorListeners.delete(listener);
		};
	}

	private _emitEntriesPersisted(event: SessionEntriesPersistedEvent): void {
		for (const listener of [...this.entriesPersistedListeners]) {
			try {
				listener(event);
			} catch (error) {
				// A derived-index observer never fails the canonical write it observes; its failure is reported instead.
				for (const onError of [...this.observerErrorListeners]) {
					try {
						onError(listener, error);
					} catch {
						// A failure report never fails the write either.
					}
				}
			}
		}
	}

	_persist(entry: SessionEntry): void {
		const assertCurrent = this._capturePersistenceContext();
		const identity = captureSessionAppendIdentity(this.sessionId, this.sessionFile, [entry]);
		const encodedEntry = encodeSessionEntry(entry);
		const result = this._persistEntries([entry], [encodedEntry], undefined, assertCurrent, { identity });
		if (result) this._emitEntriesPersisted(result.event);
	}

	private _appendEntries(
		entries: readonly SessionEntry[],
		preencodedEntries?: readonly string[],
		signal?: AbortSignal,
		publication?: {
			assertCurrent?: () => void;
			identity?: SessionAppendIdentity;
			beforeNotify?: () => void;
			onCommitted?: (receipt: SessionAppendReceipt) => void;
		},
	): void {
		this._assertWritable();
		signal?.throwIfAborted();
		const assertCurrent = publication?.assertCurrent ?? this._capturePersistenceContext();
		const identity = publication?.identity ?? captureSessionAppendIdentity(this.sessionId, this.sessionFile, entries);
		let receipt: SessionEntriesPersistedEvent | undefined;
		let recoveredFailure: { readonly error: unknown } | undefined;
		const encodedEntries =
			preencodedEntries ??
			(this.persist && this.sessionFile
				? entries.map((entry) => {
						if (isSessionLifecycleEntry(entry)) validateSessionLifecycleEntry(entry);
						return encodeSessionEntry(entry);
					})
				: []);
		if (preencodedEntries && preencodedEntries.length !== entries.length) {
			throw new Error("Session append encoding count does not match the entry batch.");
		}
		if (encodedEntries.length > 0) {
			const result = this._persistEntries(entries, encodedEntries, signal, assertCurrent, {
				identity,
				canonicalPublication: true,
			});
			receipt = result?.event;
			recoveredFailure = result?.recoveredFailure;
		} else {
			for (const entry of entries) {
				if (isSessionLifecycleEntry(entry)) encodeSessionEntry(entry);
			}
			signal?.throwIfAborted();
		}
		assertCurrent();
		for (const entry of entries) {
			this.fileEntries.push(entry);
			this.entries.push(entry);
			this.byId.set(entry.id, entry);
			this.leafId = entry.id;
		}
		const assertPublishedContext = this._capturePersistenceContext();
		const publishedFileEntries = this.fileEntries;
		const publishedById = this.byId;
		const committed: SessionAppendReceipt = Object.freeze({
			...identity,
			durability: receipt ? "persisted" : this.persist ? "buffered" : "memory",
		});
		try {
			publication?.beforeNotify?.();
			assertPublishedContext();
			publication?.onCommitted?.(committed);
			assertPublishedContext();
			for (const entry of entries) {
				if (entry.type === "message" && this.messageEntryIndex?.byId === this.byId) {
					this.messageEntryIndex.ids.set(entry.message, entry.id);
				}
				const parentCache = this.parentInputCache;
				if (parentCache && parentCache.byId === this.byId && parentCache.leafId === entry.parentId) {
					parentCache.index.apply(entry, (id) => this.byId.get(id));
					parentCache.leafId = entry.id;
				} else this.parentInputCache = undefined;
				this._advanceLifecycleActiveCache(entry);
				assertPublishedContext();
				this._advanceSessionContextCache(entry);
				assertPublishedContext();
			}
		} catch (error) {
			// A failed projection must not leave partially advanced caches or hide the
			// already committed rows. Never invalidate a replacement session's caches.
			if (this.fileEntries === publishedFileEntries && this.byId === publishedById) {
				this.messageEntryIndex = undefined;
				this.lifecycleActiveCache = undefined;
				this._invalidateSessionContextCache();
			}
			throw new SessionAppendCommittedError(
				committed,
				recoveredFailure
					? new AggregateError([recoveredFailure.error, error], "Session write recovered, but publication failed.")
					: error,
			);
		} finally {
			if (receipt) this._emitEntriesPersisted(receipt);
		}
		if (recoveredFailure) throw new SessionAppendCommittedError(committed, recoveredFailure.error);
	}

	/**
	 * Entry id of the persisted entry holding exactly this message object, if any. A custom message is found by the
	 * custom_message entry it was appended as (when the appender passed its object) or materialized from by a session
	 * context rebuild; an id this session does not hold as a custom_message entry is never returned.
	 */
	getMessageEntryId(message: object): string | undefined {
		if (this.messageEntryIndex?.byId !== this.byId) {
			const ids = new WeakMap<object, string>();
			for (const entry of this.byId.values()) {
				if (entry.type === "message") ids.set(entry.message, entry.id);
			}
			this.messageEntryIndex = { byId: this.byId, ids };
		}
		const messageEntryId = this.messageEntryIndex.ids.get(message);
		if (messageEntryId !== undefined) {
			const entry = this.byId.get(messageEntryId);
			if (entry?.type === "message" && entry.message === message) return messageEntryId;
			this.messageEntryIndex.ids.delete(message);
		}
		const customEntry = customMessageEntries.get(message);
		return customEntry !== undefined && this.byId.get(customEntry.id) === customEntry ? customEntry.id : undefined;
	}

	private _appendEntry(entry: SessionEntry, beforeNotify?: () => void): void {
		this._appendEntries([entry], undefined, undefined, { beforeNotify });
	}

	private _getLifecycleActiveCache(): LifecycleActiveCache {
		if (this.lifecycleActiveCache?.leafId === this.leafId) return this.lifecycleActiveCache;
		const branch: SessionEntry[] = [];
		const leaf = this.leafId === null ? undefined : this.byId.get(this.leafId);
		visitSessionAncestry(leaf, this.byId, (entry) => {
			branch.push(entry);
		});
		branch.reverse();
		const cache: LifecycleActiveCache = {
			leafId: this.leafId,
			positions: new Map(),
			entryTypes: new Map(),
			requestIds: new Set(),
			requestSnapshotsById: new Map(),
			providerTerminalsByRequest: new Set(),
			providerResponsesByRequest: new Map(),
			startsByIdentity: new Set(),
			terminalsByIdentity: new Set(),
			compactionStarts: new Map(),
			compactionEnds: new Set(),
			assistantToolsByIdentity: new Map(),
		};
		for (let position = 0; position < branch.length; position += 1) {
			this._applyLifecycleCacheEntry(cache, branch[position]!, position);
		}
		this.lifecycleActiveCache = cache;
		return cache;
	}

	/** Apply one canonical branch entry to both rebuilt and incrementally advanced lifecycle caches. */
	private _applyLifecycleCacheEntry(cache: LifecycleActiveCache, entry: SessionEntry, position: number): void {
		cache.positions.set(entry.id, position);
		cache.entryTypes.set(entry.id, entry.type);
		if (entry.type === "request_snapshot") {
			cache.currentRequestId = entry.requestId;
			cache.requestIds.add(entry.requestId);
			cache.requestSnapshotsById.set(entry.requestId, entry);
		} else if (entry.type === "provider_request_terminal") {
			cache.providerTerminalsByRequest.add(entry.requestId);
		} else if (entry.type === "foreground_tool_start") {
			cache.startsByIdentity.add(
				sessionLifecycleToolIdentityKey(entry.requestId, entry.assistantMessageEntryId, entry.callId),
			);
		} else if (entry.type === "foreground_tool_terminal") {
			cache.terminalsByIdentity.add(
				sessionLifecycleToolIdentityKey(entry.requestId, entry.assistantMessageEntryId, entry.callId),
			);
		} else if (entry.type === "compaction_start" && !cache.compactionStarts.has(entry.compactionId)) {
			cache.compactionStarts.set(entry.compactionId, entry);
		} else if (entry.type === "compaction_end") {
			cache.compactionEnds.add(entry.compactionId);
		} else if (entry.type === "message" && entry.message.role === "assistant" && entry.origin !== "local") {
			if (cache.currentRequestId) {
				const response: ProviderResponseReference = {
					assistantMessageEntryId: entry.id,
					outcome:
						entry.message.stopReason === "aborted"
							? "aborted"
							: entry.message.stopReason === "error"
								? "error"
								: "completed",
				};
				cache.providerResponsesByRequest.set(
					cache.currentRequestId,
					cache.providerResponsesByRequest.has(cache.currentRequestId) ? "duplicate" : response,
				);
			}
			for (const block of entry.message.content) {
				if (block.type !== "toolCall") continue;
				const key = assistantToolIdentityKey(entry.id, block.id);
				if (cache.assistantToolsByIdentity.has(key)) {
					cache.assistantToolsByIdentity.set(key, "duplicate");
				} else {
					cache.assistantToolsByIdentity.set(key, {
						requestId: cache.currentRequestId,
						toolName: block.name,
					});
				}
			}
		}
		cache.leafId = entry.id;
	}

	private _advanceLifecycleActiveCache(entry: SessionEntry): void {
		const cache = this.lifecycleActiveCache;
		if (!cache || cache.leafId !== entry.parentId) {
			this.lifecycleActiveCache = undefined;
			return;
		}
		this._applyLifecycleCacheEntry(cache, entry, cache.positions.size);
	}

	private _invalidateSessionContextCache(): void {
		this.sessionContextCache = undefined;
	}

	/** Advance a materialized linear projection without walking its immutable ancestry again. */
	private _advanceSessionContextCache(entry: SessionEntry): void {
		const cached = this.sessionContextCache;
		if (!cached || cached.leafId !== entry.parentId || entry.type === "compaction") {
			this._invalidateSessionContextCache();
			return;
		}

		switch (entry.type) {
			case "message":
				cached.context.messages.push(entry.message);
				break;
			case "custom_message":
				cached.context.messages.push(
					retainSynthesizedSessionContextMessage(
						createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp),
						entry,
					),
				);
				break;
			case "branch_summary":
				if (entry.summary) {
					cached.context.messages.push(
						retainSynthesizedSessionContextMessage(
							createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp),
						),
					);
				}
				break;
			case "thinking_level_change":
				cached.context.thinkingLevel = entry.thinkingLevel;
				break;
			case "model_change":
				cached.context.model = { provider: entry.provider, modelId: entry.modelId };
				break;
		}
		cached.leafId = entry.id;
	}

	/** Append a message as child of current leaf, then advance leaf. Returns entry id.
	 * Does not allow writing CompactionSummaryMessage and BranchSummaryMessage directly.
	 * Reason: we want these to be top-level entries in the session, not message session entries,
	 * so it is easier to find them.
	 * These need to be appended via appendCompaction() and appendBranchSummary() methods.
	 */
	appendMessage(message: Message | CustomMessage | BashExecutionMessage, origin?: AgentMessageOrigin): string {
		const entry: SessionMessageEntry = {
			type: "message",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			...deliveredWorkerControl(message),
			message,
			...(origin === undefined ? {} : { origin }),
			...deliveredOwnerInput(message),
			...deliveredTurnOrigin(message),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/**
	 * Append a bounded mixed message/custom-message batch as one durable publication.
	 * Every item is encoded before the session tree or persistence state is mutated.
	 */
	appendMessageBatch(
		batch: readonly SessionMessageBatchEntry[],
		onCommitted?: (receipt: SessionAppendReceipt) => void,
		attempt?: symbol,
	): string[] {
		if (batch.length === 0) return [];
		if (batch.length > MAX_SESSION_MESSAGE_BATCH_ENTRIES) {
			throw new RangeError(
				`Session message batch cannot contain more than ${MAX_SESSION_MESSAGE_BATCH_ENTRIES} entries.`,
			);
		}
		const assertCurrent = this._capturePersistenceContext();
		const entries: SessionEntry[] = [];
		const sourceMessages: object[] = [];
		const customBindings: Array<{ message: object; entry: CustomMessageEntry }> = [];
		const ids = pendingIdSpace(this.byId);
		let parentId = this.leafId;
		for (const item of batch) {
			if (!item || typeof item !== "object") {
				throw new TypeError("Session message batch items must be objects.");
			}
			const id = generateId(ids);
			let entry: SessionEntry;
			if (item.kind === "message") {
				const message = item.message;
				if (!message || typeof message !== "object") {
					throw new TypeError("Session message batch message items require a message object.");
				}
				entry = {
					type: "message",
					id,
					parentId,
					timestamp: new Date().toISOString(),
					...deliveredWorkerControl(message),
					message,
					...(item.origin === undefined ? {} : { origin: item.origin }),
					...deliveredOwnerInput(message),
					...deliveredTurnOrigin(message),
				};
				sourceMessages.push(message);
			} else if (item.kind === "custom") {
				const message = item.message;
				if (!message || typeof message !== "object") {
					throw new TypeError("Session message batch custom items require a message object.");
				}
				entry = {
					type: "custom_message",
					customType: message.customType,
					content: message.content,
					display: message.display,
					details: message.details,
					id,
					parentId,
					timestamp: new Date().toISOString(),
				};
				customBindings.push({ message, entry });
				sourceMessages.push(message);
			} else {
				throw new TypeError("Session message batch items must use kind message or custom.");
			}
			entries.push(entry);
			ids.add(id);
			parentId = id;
		}
		const identity = captureSessionAppendIdentity(this.sessionId, this.sessionFile, entries, sourceMessages, attempt);
		const encodedEntries = entries.map((entry) => encodeSessionEntry(entry));
		this._appendEntries(entries, encodedEntries, undefined, {
			assertCurrent,
			identity,
			onCommitted,
			beforeNotify: () => {
				for (const { message, entry } of customBindings) customMessageEntries.set(message, entry);
			},
		});
		return entries.map((entry) => entry.id);
	}

	/** Append a thinking level change as child of current leaf, then advance leaf. Returns entry id. */
	appendThinkingLevelChange(thinkingLevel: string): string {
		const entry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			thinkingLevel,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a model change as child of current leaf, then advance leaf. Returns entry id. */
	appendModelChange(provider: string, modelId: string): string {
		const entry: ModelChangeEntry = {
			type: "model_change",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			provider,
			modelId,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a compaction summary as child of current leaf, then advance leaf. Returns entry id. */
	appendCompaction<T = unknown>(
		summary: string,
		firstKeptEntryId: string,
		tokensBefore: number,
		details?: T,
		fromHook?: boolean,
		usage?: Usage,
		retention?: CompactionRetention,
		coveredThroughEntryId?: string,
		summarizedGapEntryIds?: readonly string[],
		scopeStartEntryId?: string,
		usageComponents?: readonly UsageComponent[],
		usageReceiptOwned?: true,
	): string {
		if (usageComponents) validateUsageComponents(usage ?? createEmptyUsage(), usageComponents);
		const compactionParentId = this.leafId;
		const leaf = compactionParentId ? this.byId.get(compactionParentId) : undefined;
		for (const [field, id] of [
			["coveredThroughEntryId", coveredThroughEntryId],
			["scopeStartEntryId", scopeStartEntryId],
		] as const) {
			if (id === undefined) continue;
			let onBranch = false;
			visitSessionAncestry(leaf, this.byId, (current) => {
				if (current.id === id) {
					onBranch = true;
					return false;
				}
			});
			if (!onBranch) throw new Error(`Compaction ${field} is not on the active branch: ${id}.`);
		}
		const entry: CompactionEntry<T> = {
			...(usageReceiptOwned ? { usageReceiptOwned } : {}),
			type: "compaction",
			id: generateId(this.byId),
			parentId: compactionParentId,
			timestamp: new Date().toISOString(),
			summary,
			firstKeptEntryId,
			tokensBefore,
			retention,
			...(coveredThroughEntryId !== undefined ? { coveredThroughEntryId } : {}),
			...(summarizedGapEntryIds !== undefined ? { summarizedGapEntryIds: [...summarizedGapEntryIds] } : {}),
			...(scopeStartEntryId !== undefined ? { scopeStartEntryId } : {}),
			details,
			usage,
			...(usageComponents ? { usageComponents: structuredClone(usageComponents) } : {}),
			fromHook,
		};
		this._appendEntry(entry, () =>
			this._releaseCompactedMessagePayloads(firstKeptEntryId, compactionParentId, retention, entry.id),
		);
		return entry.id;
	}

	private _findAssistantToolCall(assistantMessageEntryId: string, callId: string): AssistantToolReference {
		const cache = this._getLifecycleActiveCache();
		if (!cache.positions.has(assistantMessageEntryId)) {
			throw new Error(`Assistant message is outside the active branch: ${assistantMessageEntryId}.`);
		}
		const assistant = this.byId.get(assistantMessageEntryId);
		if (assistant?.type !== "message") {
			throw new Error(
				`Foreground tool lifecycle identity requires an assistant message: ${assistantMessageEntryId}.`,
			);
		}
		const reference = cache.assistantToolsByIdentity.get(assistantToolIdentityKey(assistantMessageEntryId, callId));
		if (reference === "duplicate") {
			throw new Error(
				`Foreground tool lifecycle identity must resolve to exactly one assistant tool call: ${assistantMessageEntryId}/${callId}.`,
			);
		}
		if (!reference) {
			throw new Error(
				`Foreground tool lifecycle identity must resolve to exactly one assistant tool call: ${assistantMessageEntryId}/${callId}.`,
			);
		}
		return reference;
	}

	private _validateRequestSnapshot(entry: RequestSnapshotEntry): void {
		const cache = this._getLifecycleActiveCache();
		if (cache.requestIds.has(entry.requestId)) {
			throw new Error(`Duplicate request snapshot identity: ${entry.requestId}.`);
		}
		for (const messageEntryId of entry.messageEntryIds) {
			const messageEntry = this.byId.get(messageEntryId);
			if (messageEntry?.type !== "message") {
				throw new Error(`Request snapshot references a non-message entry: ${messageEntryId}.`);
			}
			if (!cache.positions.has(messageEntryId)) {
				throw new Error(`Request snapshot message is outside the active branch: ${messageEntryId}.`);
			}
		}
	}

	private _validateForegroundToolStartBatch(entries: readonly ForegroundToolStartEntry[]): void {
		const cache = this._getLifecycleActiveCache();
		const seen = new Set<string>();
		for (const entry of entries) {
			validateSessionLifecycleEntry(entry);
			const call = this._findAssistantToolCall(entry.assistantMessageEntryId, entry.callId);
			if (call.requestId !== undefined && call.requestId !== entry.requestId) {
				throw new Error(`Foreground tool start request does not match its assistant request: ${entry.id}.`);
			}
			const key = sessionLifecycleToolIdentityKey(entry.requestId, entry.assistantMessageEntryId, entry.callId);
			if (seen.has(key) || cache.startsByIdentity.has(key)) {
				throw new Error(
					`Duplicate foreground tool start identity: ${entry.requestId}/${entry.assistantMessageEntryId}/${entry.callId}.`,
				);
			}
			seen.add(key);
			if (call.toolName !== entry.toolName) {
				throw new Error(`Foreground tool start name does not match its assistant call: ${entry.id}.`);
			}
		}
	}

	private _validateProviderRequestTerminal(entry: ProviderRequestTerminalEntry): void {
		validateSessionLifecycleEntry(entry);
		const cache = this._getLifecycleActiveCache();
		if (!cache.requestSnapshotsById.has(entry.requestId)) {
			throw new Error(`Provider request terminal has no matching snapshot: ${entry.requestId}.`);
		}
		if (cache.providerTerminalsByRequest.has(entry.requestId)) {
			throw new Error(`Duplicate provider request terminal identity: ${entry.requestId}.`);
		}
		const response = cache.providerResponsesByRequest.get(entry.requestId);
		if (response === "duplicate") {
			throw new Error(`Provider request terminal has multiple assistant responses: ${entry.requestId}.`);
		}
		if (entry.outcome === "interrupted") {
			if (response)
				throw new Error(`Interrupted provider request already has an assistant response: ${entry.requestId}.`);
			return;
		}
		if (
			!response ||
			entry.assistantMessageEntryId !== response.assistantMessageEntryId ||
			entry.outcome !== response.outcome
		) {
			throw new Error(`Provider request terminal contradicts its canonical assistant response: ${entry.requestId}.`);
		}
	}

	private _validateForegroundToolTerminal(entry: ForegroundToolTerminalEntry): void {
		validateSessionLifecycleEntry(entry);
		const call = this._findAssistantToolCall(entry.assistantMessageEntryId, entry.callId);
		if (call.requestId !== undefined && call.requestId !== entry.requestId) {
			throw new Error(`Foreground tool terminal request does not match its assistant request: ${entry.id}.`);
		}
		if (call.toolName !== entry.toolName) {
			throw new Error(`Foreground tool terminal name does not match its assistant call: ${entry.id}.`);
		}
		const cache = this._getLifecycleActiveCache();
		const identityKey = sessionLifecycleToolIdentityKey(entry.requestId, entry.assistantMessageEntryId, entry.callId);
		if (cache.terminalsByIdentity.has(identityKey)) {
			throw new Error(`Duplicate foreground tool terminal identity: ${entry.id}.`);
		}
		if (!cache.startsByIdentity.has(identityKey)) {
			throw new Error(`Foreground tool terminal has no matching durable start: ${entry.id}.`);
		}
		const resultEntry = this.byId.get(entry.resultMessageEntryId);
		if (
			!resultEntry ||
			!cache.positions.has(entry.resultMessageEntryId) ||
			resultEntry.type !== "message" ||
			resultEntry.message.role !== "toolResult"
		) {
			throw new Error(`Foreground tool terminal references a non-result entry: ${entry.resultMessageEntryId}.`);
		}
		const resultErrorKind = resultEntry.message.isError
			? (resultEntry.message.errorKind ?? "tool_failure")
			: undefined;
		if (
			resultEntry.message.toolCallId !== entry.callId ||
			resultEntry.message.toolName !== entry.toolName ||
			entry.outcome !== (resultEntry.message.isError ? "error" : "success") ||
			(resultEntry.message.errorKind !== undefined && !resultEntry.message.isError) ||
			entry.errorKind !== resultErrorKind
		) {
			throw new Error(`Foreground tool terminal metadata contradicts its canonical result: ${entry.id}.`);
		}
	}

	private _validateCompactionStart(entry: CompactionStartEntry): void {
		validateSessionLifecycleEntry(entry);
		const cache = this._getLifecycleActiveCache();
		if (cache.compactionStarts.has(entry.compactionId)) {
			throw new Error(`Duplicate compaction start identity: ${entry.compactionId}.`);
		}
		const firstKeptPosition = cache.positions.get(entry.firstKeptEntryId);
		const leafPosition = this.leafId === null ? undefined : cache.positions.get(this.leafId);
		if (firstKeptPosition === undefined || leafPosition === undefined || firstKeptPosition > leafPosition) {
			throw new Error(
				`Compaction start firstKeptEntryId is not an earlier active-branch entry: ${entry.firstKeptEntryId}.`,
			);
		}
	}

	private _validateCompactionEnd(entry: CompactionEndEntry): void {
		validateSessionLifecycleEntry(entry);
		const cache = this._getLifecycleActiveCache();
		const start = cache.compactionStarts.get(entry.compactionId);
		if (!start) throw new Error(`Compaction end has no matching start: ${entry.compactionId}.`);
		if (cache.compactionEnds.has(entry.compactionId)) {
			throw new Error(`Duplicate compaction end identity: ${entry.compactionId}.`);
		}
		if (entry.outcome !== "success") return;
		const compactionPosition = entry.compactionEntryId ? cache.positions.get(entry.compactionEntryId) : undefined;
		const compactionEntry = entry.compactionEntryId ? this.byId.get(entry.compactionEntryId) : undefined;
		const finalFirstKeptPosition =
			compactionEntry?.type === "compaction" ? cache.positions.get(compactionEntry.firstKeptEntryId) : undefined;
		if (
			!entry.compactionEntryId ||
			cache.entryTypes.get(entry.compactionEntryId) !== "compaction" ||
			compactionPosition === undefined ||
			compactionPosition <= (cache.positions.get(start.id) ?? -1) ||
			compactionEntry?.type !== "compaction" ||
			finalFirstKeptPosition === undefined ||
			finalFirstKeptPosition >= compactionPosition
		) {
			throw new Error(
				`Compaction end references an invalid summary entry: ${entry.compactionEntryId ?? "missing"}.`,
			);
		}
	}

	/** Append a bounded provider request snapshot before its transport starts. */
	appendRequestSnapshot(snapshot: SessionRequestSnapshotInput): string {
		const entry: RequestSnapshotEntry = {
			type: "request_snapshot",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			...snapshot,
			messageEntryIds: [...snapshot.messageEntryIds],
		};
		validateSessionLifecycleEntry(entry);
		this._validateRequestSnapshot(entry);
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append the bounded terminal outcome for one provider request. */
	appendProviderRequestTerminal(
		requestId: string,
		outcome: ProviderRequestTerminalEntry["outcome"],
		assistantMessageEntryId?: string,
	): string {
		const entry: ProviderRequestTerminalEntry = {
			type: "provider_request_terminal",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			requestId,
			outcome,
			...(assistantMessageEntryId === undefined ? {} : { assistantMessageEntryId }),
		};
		this._validateProviderRequestTerminal(entry);
		const consumption = this._parentInputIndex().consumption(entry, (id) => this.byId.get(id), "next-owner-turn");
		if (consumption?.mode === "next-owner-turn") {
			const ids = pendingIdSpace(this.byId);
			ids.add(entry.id);
			const report: CustomEntry = {
				type: "custom",
				id: generateId(ids),
				parentId: entry.id,
				timestamp: entry.timestamp,
				customType: PARENT_INPUT_CONSUMED_CUSTOM_TYPE,
				data: consumption,
			};
			this._appendEntries([entry, report]);
		} else this._appendEntry(entry);
		return entry.id;
	}

	/** Append a bounded batch of foreground tool execution start markers in one durable publication. */
	appendForegroundToolStarts(starts: readonly ForegroundToolStartInput[]): string[] {
		if (starts.length === 0) return [];
		const entries: ForegroundToolStartEntry[] = [];
		let parentId = this.leafId;
		const ids = pendingIdSpace(this.byId);
		for (const start of starts) {
			const entry: ForegroundToolStartEntry = {
				type: "foreground_tool_start",
				id: generateId(ids),
				parentId,
				timestamp: new Date().toISOString(),
				...start,
			};
			entries.push(entry);
			ids.add(entry.id);
			parentId = entry.id;
		}
		this._validateForegroundToolStartBatch(entries);
		this._appendEntries(entries);
		return entries.map((entry) => entry.id);
	}

	/** Append one bounded foreground tool execution start marker. */
	appendForegroundToolStart(
		requestId: string,
		assistantMessageEntryId: string,
		callId: string,
		toolName: string,
	): string {
		return this.appendForegroundToolStarts([{ requestId, assistantMessageEntryId, callId, toolName }])[0]!;
	}

	/** Append a bounded foreground tool terminal marker. */
	appendForegroundToolTerminal(
		requestId: string,
		assistantMessageEntryId: string,
		callId: string,
		toolName: string,
		outcome: ForegroundToolTerminalEntry["outcome"],
		metadata: Pick<ForegroundToolTerminalEntry, "resultMessageEntryId" | "errorKind">,
	): string {
		const entry: ForegroundToolTerminalEntry = {
			type: "foreground_tool_terminal",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			requestId,
			assistantMessageEntryId,
			callId,
			toolName,
			outcome,
			...metadata,
		};
		this._validateForegroundToolTerminal(entry);
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a bounded compaction transaction start marker. */
	appendCompactionStart(
		compactionId: string,
		firstKeptEntryId: string,
		tokensBefore: number,
		summarizerInputTokens?: number,
	): string {
		const entry: CompactionStartEntry = {
			type: "compaction_start",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			compactionId,
			firstKeptEntryId,
			tokensBefore,
			...(summarizerInputTokens !== undefined ? { summarizerInputTokens } : {}),
		};
		this._validateCompactionStart(entry);
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a bounded compaction transaction end marker. */
	appendCompactionEnd(
		compactionId: string,
		outcome: CompactionEndEntry["outcome"],
		metadata: Pick<CompactionEndEntry, "compactionEntryId" | "error"> = {},
	): string {
		const entry: CompactionEndEntry = {
			type: "compaction_end",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			compactionId,
			outcome,
			...metadata,
		};
		this._validateCompactionEnd(entry);
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a custom entry (for extensions) as child of current leaf, then advance leaf. */
	appendCustomEntry(customType: string, data?: unknown): string {
		const entry: CustomEntry = {
			type: "custom",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			customType,
			data,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a session info entry (e.g., display name). Returns entry id. */
	appendSessionInfo(name: string): string {
		const entry: SessionInfoEntry = {
			type: "session_info",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			name: name.trim(),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Get the current session name from the latest session_info entry, if any. */
	getSessionName(): string | undefined {
		// Walk entries in reverse to find the latest session_info entry.
		// Empty names explicitly clear the session title.
		const entries = this.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "session_info") {
				return entry.name?.trim() || undefined;
			}
		}
		return undefined;
	}

	/** Return lifecycle records on one branch without exposing lifecycle data to model context. */
	getSessionLifecycleIndex(fromId?: string | null): SessionLifecycleIndex {
		return indexSessionLifecycle(this.entries, fromId === undefined ? this.leafId : fromId);
	}

	/** Inspect lifecycle balance on one branch without mutating or appending repair records. */
	inspectSessionLifecycle(fromId?: string | null): SessionLifecycleInspection {
		return inspectSessionLifecycle(this.entries, fromId === undefined ? this.leafId : fromId);
	}

	/** Plan deterministic lifecycle repair for one branch without mutating the session. */
	planSessionLifecycleRepair(fromId?: string | null): SessionLifecycleRepairPlan {
		return planSessionLifecycleRepair(this.entries, fromId === undefined ? this.leafId : fromId);
	}

	private _parentInputIndex(): ParentInputIndex {
		if (this.parentInputCache?.byId === this.byId && this.parentInputCache.leafId === this.leafId)
			return this.parentInputCache.index;
		const index = new ParentInputIndex();
		for (const entry of this.getBranch()) index.apply(entry, (id) => this.byId.get(id));
		this.parentInputCache = { byId: this.byId, leafId: this.leafId, index };
		return index;
	}

	getPendingParentInputs(mode?: ParentInputMode): readonly PersistedParentInput[] {
		return this._parentInputIndex().pendingInputs(mode);
	}

	/**
	 * The saved input of a delivery on any branch, pending or consumed. A replayed delivery must repeat its saved
	 * metadata exactly (`appendParentInput`), so a caller that chooses a mode reads the saved one first.
	 */
	getParentInput(deliveryId: string): PersistedParentInput | undefined {
		return this._parentInputReceipt(deliveryId);
	}

	/** Held inputs their producer skipped on this branch; their saved bodies never reach the model. */
	getSkippedParentInputIds(): ReadonlySet<string> {
		return this._parentInputIndex().skippedInputs();
	}

	/**
	 * Records that a held next-owner-turn input became stale before the owner saw it. An input an owner turn already
	 * selected, or a provider request carries, is going to the owner and stays: the result is `false`, as for an input
	 * that is not pending on this branch.
	 */
	skipPendingParentInput(deliveryId: string, reason: string): boolean {
		const held = () =>
			this._parentInputIndex()
				.pendingInputs("next-owner-turn")
				.find((input) => input.metadata.deliveryId === deliveryId);
		const selected = () =>
			[
				this.plannedParentNotes,
				...[...(this.parentNoteAdmission?.owners.values() ?? [])].map((owner) => owner.selection),
			].some((selection) => selection?.inputs.some((input) => input.deliveryId === deliveryId)) ||
			this._parentInputIndex().bound(deliveryId);
		const input = held();
		if (!input || selected()) return false;
		return this._withParentInputMutation(input.metadata.origin, () => {
			const current = held();
			if (!current || selected()) return false;
			const id = this.appendCustomEntry(PARENT_INPUT_SKIPPED_CUSTOM_TYPE, {
				version: 1,
				deliveryId,
				entryId: current.entryId,
				payloadDigest: current.metadata.payloadDigest,
				reason,
			});
			if (!this.isEntryDurableForSession(id)) throw new Error("Parent input skip was not physically persisted.");
			return true;
		});
	}

	/** Indexed canonical source for both live ingestion and the same proof used by historical imports. */
	getParentInputConsumptionSource(): ParentInputConsumptionSource {
		let cache = this.parentEvidenceCache;
		if (!cache || cache.byId !== this.byId || cache.count > this.entries.length) {
			cache = { byId: this.byId, count: 0, index: new SessionEntryEvidenceIndex() };
			this.parentEvidenceCache = cache;
		}
		for (; cache.count < this.entries.length; cache.count++) cache.index.add(this.entries[cache.count]!);
		const byId = this.byId;
		const sessionId = this.sessionId;
		const index = cache.index;
		const assertCurrent = (signal?: AbortSignal): void => {
			signal?.throwIfAborted();
			if (this.byId !== byId || this.sessionId !== sessionId)
				throw new Error("Parent input source changed during ingestion.");
		};
		return {
			sessionId,
			readEntries: async (ids, signal) => {
				assertCurrent(signal);
				if (ids.length > 64) throw new Error("Parent input lookup exceeds its entry bound.");
				return new Map(
					ids.map((id) => {
						const entry = byId.get(id);
						if (!entry || entry.id !== id || !this.isEntryDurableForSession(id))
							throw new Error("Parent input source entry is not durable.");
						return [id, entry] as const;
					}),
				);
			},
			isAncestor: async (ancestor, descendant, signal) => {
				assertCurrent(signal);
				return index.isAncestor(ancestor, descendant);
			},
			findAncestors: async (descendant, query, signal) => {
				assertCurrent(signal);
				return index.findAncestors(descendant, query);
			},
		};
	}

	private _pendingParentBatch(mode: ParentInputMode): readonly PersistedParentInput[] {
		const selected: PersistedParentInput[] = [];
		let chars = 0;
		for (const input of this.getPendingParentInputs(mode)) {
			const entry = this.getEntry(input.entryId);
			if (entry?.type !== "custom_message" || typeof entry.content !== "string")
				throw new Error("Parent input requires canonical text.");
			if (selected.length >= MAX_PARENT_WAKE_INPUTS || chars + entry.content.length > MAX_PARENT_WAKE_CHARS) break;
			chars += entry.content.length;
			selected.push(input);
		}
		return selected;
	}

	/** Only authenticated owner submission/handoff owners call this with their actual foreground epoch. */
	authorizeParentNoteOwner(inputId: string, epoch: number): void {
		if (!isParentNoteOwnerId(inputId) || !Number.isSafeInteger(epoch) || epoch < 1)
			throw new Error("Parent notes require an authenticated owner input and foreground epoch.");
		if (this.parentNoteAdmission?.epoch !== epoch)
			this.parentNoteAdmission = { epoch, assertCurrent: this.captureBranchContext(), owners: new Map() };
		const owners = this.parentNoteAdmission.owners;
		if (owners.has(inputId)) return;
		if (owners.size >= MAX_PENDING_PARENT_INPUTS) throw new Error("Parent note owner capacity exceeded.");
		owners.set(inputId, { used: false });
	}

	/** A request projection borrows canonical note bodies; it never appends them a second time. */
	captureParentNotes(messages: readonly AgentMessage[], epoch: number | undefined): ParentNoteSelection | undefined {
		this.plannedParentNotes = undefined;
		const admission = this.parentNoteAdmission;
		if (!admission || admission.epoch !== epoch) {
			this.parentNoteAdmission = undefined;
			return undefined;
		}
		admission.assertCurrent();
		for (const owner of admission.owners.values()) {
			if (owner.ownerEntryId && owner.selection?.isCurrent()) {
				this.plannedParentNotes = owner.selection;
				return owner.selection;
			}
		}
		for (const message of messages) {
			const id = this._parentNoteOwnerId(message);
			const owner = id && admission.owners.get(id);
			if (!id || !owner) continue;
			if (owner.selection) {
				if (owner.selection.isCurrent()) {
					this.plannedParentNotes = owner.selection;
					return owner.selection;
				}
				continue;
			}
			if (owner.used) continue;
			// Owner inputs coalesced in this request share one bounded batch, not one batch apiece.
			for (const candidate of messages) {
				const candidateId = this._parentNoteOwnerId(candidate);
				const candidateOwner = candidateId && admission.owners.get(candidateId);
				if (candidateOwner) candidateOwner.used = true;
			}
			const inputs: ParentNoteSelection["inputs"][number][] = [];
			const notes: CustomMessage<unknown>[] = [];
			for (const input of this._pendingParentBatch("next-owner-turn")) {
				const entry = this.getEntry(input.entryId);
				if (entry?.type !== "custom_message" || typeof entry.content !== "string")
					throw new Error("Parent note requires canonical text.");
				inputs.push({
					entryId: input.entryId,
					deliveryId: input.metadata.deliveryId,
					payloadDigest: input.metadata.payloadDigest,
				});
				notes.push(
					createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp),
				);
			}
			if (!inputs.length) return undefined;
			const selectionId = createHash("sha256")
				.update(JSON.stringify({ ownerInputId: id, inputs }))
				.digest("hex");
			const selection: ParentNoteSelection = {
				ownerInputId: id,
				inputs,
				messages: notes,
				selectionId,
				isCurrent: () => {
					admission.assertCurrent();
					const pending = new Set(this.getPendingParentInputs("next-owner-turn").map((input) => input.entryId));
					return this.parentNoteAdmission === admission && inputs.every((input) => pending.has(input.entryId));
				},
			};
			owner.selection = selection;
			this.plannedParentNotes = selection;
			return selection;
		}
		return undefined;
	}

	private _parentNoteOwnerId(message: AgentMessage): string | undefined {
		if (message.role !== "user") return undefined;
		const stamped = ownerInputIdOf(message);
		if (stamped) return stamped;
		const id = this.getMessageEntryId(message);
		const entry = id ? this.getEntry(id) : undefined;
		return entry?.type === "message" ? entry.ownerInputId : undefined;
	}

	/** Exact owner and selected content proof, after canonical owner persistence and before transport. */
	recordParentNoteRequest(
		requestId: string,
		source: readonly AgentMessage[],
		messages: readonly { content: unknown }[],
	): readonly string[] {
		const selection = this.plannedParentNotes;
		if (!selection) return [];
		if (!selection.isCurrent()) throw new Error("Parent note selection changed before transport.");
		const owner = this.parentNoteAdmission?.owners.get(selection.ownerInputId);
		const ownerMessage = source.find((message) => this._parentNoteOwnerId(message) === selection.ownerInputId);
		const ownerEntryId = (ownerMessage && this.getMessageEntryId(ownerMessage)) ?? owner?.ownerEntryId;
		const ownerEntry = ownerEntryId && this.getEntry(ownerEntryId);
		if (
			!ownerEntryId ||
			!ownerEntry ||
			ownerEntry.type !== "message" ||
			ownerEntry.ownerInputId !== selection.ownerInputId
		)
			throw new Error("Parent note owner input was not canonically persisted.");
		assertParentInputVisible(
			messages,
			parentNoteMarker(selection.selectionId),
			selection.messages.map((message) => {
				if (typeof message.content !== "string") throw new Error("Parent note requires text.");
				return message.content;
			}),
		);
		const origin = this._parentInputIndex().find(selection.inputs[0]!.deliveryId)!.metadata.origin;
		this._withParentInputMutation(origin, () => {
			const entryId = this.appendCustomEntry(PARENT_NOTE_REQUEST_CUSTOM_TYPE, {
				version: 1,
				requestId,
				ownerInputId: selection.ownerInputId,
				ownerEntryId,
				inputs: selection.inputs,
			});
			if (!this.isEntryDurableForSession(entryId))
				throw new Error("Parent note binding was not physically persisted.");
			if (owner) owner.ownerEntryId = ownerEntryId;
		});
		return selection.inputs.map((input) => input.deliveryId);
	}
	getParentInputWake(): ParentInputWake | undefined {
		return this._parentInputIndex().openWake();
	}

	/** Only the exact currently admitted detached manifest may expose its pending inputs. */
	getActiveParentInputIds(): ReadonlySet<string> {
		const active = this.activeParentWake;
		if (!active) return new Set();
		active.assertCurrent();
		const wake = this._parentInputIndex().openWake();
		if (wake?.wakeId !== active.wakeId) throw new Error("Active parent wake no longer matches its manifest.");
		return new Set(wake.inputs.map((input) => input.deliveryId));
	}

	private _appendParentMessage(message: CustomMessage<unknown>): SessionAppendReceipt {
		let receipt: SessionAppendReceipt | undefined;
		try {
			this.appendMessageBatch([{ kind: "custom", message }], (committed) => {
				receipt = committed;
			});
		} catch (error) {
			if (!(error instanceof SessionAppendCommittedError)) throw error;
			receipt = error.receipt;
		}
		if (
			receipt?.durability !== expectedSessionAppendDurability(this.persist) ||
			!receipt.entries.every((entry) => this.isEntryDurableForSession(entry.id))
		)
			throw new Error("Parent input did not reach physical session storage.");
		return receipt;
	}

	private _parentInputReceipt(deliveryId: string): PersistedParentInput | undefined {
		let cache = this.parentInputReceipts;
		if (!cache || cache.byId !== this.byId || cache.count > this.entries.length) {
			cache = { byId: this.byId, count: 0, deliveries: new Map() };
			this.parentInputReceipts = cache;
		}
		for (; cache.count < this.entries.length; cache.count++) {
			const input = parentInputOf(this.entries[cache.count]!);
			if (!input) continue;
			if (cache.deliveries.has(input.metadata.deliveryId))
				throw new Error("Duplicate parent input delivery requires inspection.");
			cache.deliveries.set(input.metadata.deliveryId, input);
		}
		return cache.deliveries.get(deliveryId);
	}

	/** The physical parent-input boundary; lookup and append share the canonical transcript lock. */
	appendParentInput(
		message: CustomMessage<unknown>,
		withAppend?: (append: () => ParentInputAppendReceipt) => ParentInputAppendReceipt,
	): ParentInputAppendReceipt {
		const metadata = parentInputMetadataOfMessage(message);
		if (!metadata) throw new Error("Parent input metadata is required.");
		return this._withParentInputMutation(metadata.origin, () => {
			const index = this._parentInputIndex();
			const existing = this._parentInputReceipt(metadata.deliveryId);
			if (existing) {
				if (JSON.stringify(existing.metadata) !== JSON.stringify(metadata))
					throw new Error("Parent input delivery ID conflicts with its saved payload.");
				if (index.find(metadata.deliveryId)?.entryId !== existing.entryId)
					throw new Error("Parent input belongs to another branch.");
				const entry = this.byId.get(existing.entryId)!;
				return {
					...captureSessionAppendIdentity(this.sessionId, this.sessionFile, [entry]),
					durability: expectedSessionAppendDurability(this.persist),
					created: false,
				};
			}
			if (index.pendingInputs().length >= MAX_PENDING_PARENT_INPUTS)
				throw new Error("Pending parent input capacity exceeded.");
			let admissionOpen = true;
			const append = (): ParentInputAppendReceipt => {
				if (!admissionOpen) throw new Error("Parent input append admission has ended.");
				admissionOpen = false;
				return { ...this._appendParentMessage(message), created: true };
			};
			try {
				return withAppend ? withAppend(append) : append();
			} finally {
				admissionOpen = false;
			}
		});
	}

	/** One durable detached batch, reused after restart until its exact provider answer settles it. */
	beginParentInputWake(): ParentInputWake | undefined {
		const existing = this._parentInputIndex().openWake();
		if (existing) return existing;
		const pending = this._pendingParentBatch("turn");
		if (!pending.length) return undefined;
		return this._withParentInputMutation(pending[0]!.metadata.origin, () => {
			const inputs = pending.map((input) => ({
				entryId: input.entryId,
				deliveryId: input.metadata.deliveryId,
				payloadDigest: input.metadata.payloadDigest,
			}));
			const wakeId = createHash("sha256").update(JSON.stringify(inputs)).digest("hex");
			const details = { version: 1, wakeId, inputs, detached: true };
			const now = new Date().toISOString();
			this._appendParentMessage(
				createCustomMessage(PARENT_INPUT_WAKE_CUSTOM_TYPE, parentWakeContent(wakeId, inputs), false, details, now),
			);
			return this._parentInputIndex().openWake()!;
		});
	}

	activateParentInputWake(wakeId: string): () => void {
		if (this.activeParentWake || this._parentInputIndex().openWake()?.wakeId !== wakeId)
			throw new Error("Parent wake is not available for execution.");
		const active = { wakeId, assertCurrent: this.captureBranchContext() };
		this.activeParentWake = active;
		return () => {
			if (this.activeParentWake === active) this.activeParentWake = undefined;
		};
	}

	/** Called at the actual provider boundary, after request_snapshot and before transport. */
	recordParentInputWakeRequest(requestId: string, messages: readonly { content: unknown }[]): void {
		const active = this.activeParentWake;
		if (!active) return;
		active.assertCurrent();
		const wake = this._parentInputIndex().openWake();
		if (wake?.wakeId !== active.wakeId)
			throw new Error("Parent wake manifest is absent from the actual provider request.");
		const contents = wake.inputs.map((input) => {
			const entry = this.getEntry(input.entryId);
			if (entry?.type !== "custom_message" || typeof entry.content !== "string")
				throw new Error("An exact selected parent input is absent from the actual provider request.");
			return entry.content;
		});
		assertParentInputVisible(messages, parentWakeMarker(active.wakeId), contents);
		const data = { version: 1, wakeId: active.wakeId, requestId };
		const id = this.appendCustomEntry(PARENT_INPUT_WAKE_REQUEST_CUSTOM_TYPE, data);
		if (!this.isEntryDurableForSession(id)) throw new Error("Parent wake request binding was not persisted.");
	}

	settleParentInputWake(wakeId: string): void {
		const index = this._parentInputIndex();
		const wake = index.openWake();
		if (wake?.wakeId !== wakeId || !wake.completed)
			throw new Error("Parent wake has no matching terminal provider answer.");
		const origin = index.find(wake.inputs[0]!.deliveryId)!.metadata.origin;
		this._withParentInputMutation(origin, () => {
			const current = this._parentInputIndex().openWake();
			if (current?.wakeId !== wakeId || !current.completed)
				throw new Error("Parent wake changed before settlement.");
			const consumption = this._parentInputIndex().wakeConsumption(wakeId);
			if (!consumption) throw new Error("Parent wake consumption proof is missing.");
			const ids = pendingIdSpace(this.byId);
			const id = generateId(ids);
			ids.add(id);
			const timestamp = new Date().toISOString();
			const makeCustom = (
				entryId: string,
				parentId: string | null,
				customType: string,
				data: unknown,
			): CustomEntry => ({
				type: "custom",
				id: entryId,
				parentId,
				timestamp,
				customType,
				data,
			});
			const settlement = makeCustom(id, this.leafId, PARENT_INPUT_SETTLED_CUSTOM_TYPE, {
				version: 1,
				wakeId,
				...current.completed,
			});
			const report = makeCustom(generateId(ids), id, PARENT_INPUT_CONSUMED_CUSTOM_TYPE, consumption);
			this._appendEntries([settlement, report]);
			if (!this.isEntryDurableForSession(report.id)) throw new Error("Parent wake settlement was not persisted.");
		});
	}

	private _withParentInputMutation<T>(origin: ParentInputOrigin, operation: () => T): T {
		const assertOrigin = (): void => {
			const badFile = origin.sessionFile !== undefined && (!this.persist || origin.sessionFile !== this.sessionFile);
			if (origin.sessionId !== this.sessionId || badFile) throw new Error("Parent input session identity changed.");
			if (!this.getBranch().some((e) => e.id === origin.leafId) || !this.isEntryDurableForSession(origin.leafId))
				throw new Error("Parent input origin is not on the current durable branch.");
		};
		if (!this.persist) {
			if (this.persistenceStateUncertain) throw new Error("Parent input session persistence is uncertain.");
			assertOrigin();
			return operation();
		}
		if (!this.hasDurableSessionFile() || !this.sessionFile || this.persistenceStateUncertain)
			throw new Error("Parent input requires a healthy durable session file.");
		return withSessionFileMutation(
			this.agentDir,
			this.sessionFile,
			this.sessionId,
			"append",
			() => {
				if (!this.storageRevision || !sameFileVersion(this.storageRevision, statSync(this.sessionFile!)))
					throw new Error("Parent session changed on disk; reopen it before delivering input.");
				assertOrigin();
				return operation();
			},
			{ session: this, revision: this.storageRevision },
		);
	}

	/**
	 * Append a custom message entry (for extensions) that participates in LLM context.
	 * @param customType Extension identifier for filtering on reload
	 * @param content Message content (string or TextContent/ImageContent array)
	 * @param display Whether to show in TUI (true = styled display, false = hidden)
	 * @param details Optional extension-specific metadata (not sent to LLM)
	 * @param source The live custom message object this entry persists, so {@link getMessageEntryId} finds the entry by it
	 * @returns Entry id
	 */
	appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
		source?: object,
	): string {
		const entry: CustomMessageEntry<T> = {
			type: "custom_message",
			customType,
			content,
			display,
			details,
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		};
		this._appendEntry(entry, () => {
			if (source !== undefined) customMessageEntries.set(source, entry);
		});
		return entry.id;
	}

	// =========================================================================
	// Tree Traversal
	// =========================================================================

	getLeafId(): string | null {
		return this.leafId;
	}

	getLeafEntry(): SessionEntry | undefined {
		return this.leafId ? this.byId.get(this.leafId) : undefined;
	}

	getEntry(id: string): SessionEntry | undefined {
		return this.byId.get(id);
	}

	/**
	 * Get all direct children of an entry.
	 */
	getChildren(parentId: string): SessionEntry[] {
		const children: SessionEntry[] = [];
		for (const entry of this.byId.values()) {
			if (entry.parentId === parentId) {
				children.push(entry);
			}
		}
		return children;
	}

	/**
	 * Get the label for an entry, if any.
	 */
	getLabel(id: string): string | undefined {
		return this.labelsById.get(id);
	}

	/**
	 * Set or clear a label on an entry.
	 * Labels are user-defined markers for bookmarking/navigation.
	 * Pass undefined or empty string to clear the label.
	 */
	appendLabelChange(targetId: string, label: string | undefined): string {
		if (!this.byId.has(targetId)) {
			throw new Error(`Entry ${targetId} not found`);
		}
		const entry: LabelEntry = {
			type: "label",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			targetId,
			label,
		};
		this._appendEntry(entry, () => {
			if (label) {
				this.labelsById.set(targetId, label);
				this.labelTimestampsById.set(targetId, entry.timestamp);
			} else {
				this.labelsById.delete(targetId);
				this.labelTimestampsById.delete(targetId);
			}
		});
		return entry.id;
	}

	/**
	 * Walk from entry to root, returning all entries in path order.
	 * Includes all entry types (messages, compaction, model changes, etc.).
	 * Use buildSessionContext() to get the resolved messages for the LLM.
	 */
	getBranch(fromId?: string): SessionEntry[] {
		const path: SessionEntry[] = [];
		const startId = fromId ?? this.leafId;
		const start = startId ? this.byId.get(startId) : undefined;
		visitSessionAncestry(start, this.byId, (entry) => {
			path.push(entry);
		});
		path.reverse();
		return path;
	}

	/**
	 * Retrieve the complete history chain of events with full un-truncated message payload data.
	 * Hydrates cold/disk-backed payload records eagerly and operates efficiently across Windows and Linux.
	 */
	getFullHistoryChainWithPayloads(fromId?: string): SessionEntry[] {
		const branch = this.getBranch(fromId);
		const coldIds = new Set<string>();
		for (let i = 0; i < branch.length; i++) {
			const entry = branch[i];
			if (entry.type === "message" && this.coldPayloadEntryIds.has(entry.id)) {
				coldIds.add(entry.id);
			}
		}

		if (coldIds.size > 0 && this.sessionFile) {
			this._ensureEntryFileLocations(coldIds);
		}

		const hydratedBranch: SessionEntry[] = [];
		for (let i = 0; i < branch.length; i++) {
			const entry = branch[i];
			if (entry.type === "message") {
				const msg = entry.message;
				const fullContent = "content" in msg ? msg.content : undefined;
				const fullOutput = "output" in msg ? msg.output : undefined;
				hydratedBranch.push({
					...entry,
					message: {
						...msg,
						...(fullContent !== undefined ? { content: fullContent } : {}),
						...(fullOutput !== undefined ? { output: fullOutput } : {}),
					} as typeof msg,
				});
			} else {
				hydratedBranch.push(entry);
			}
		}

		return hydratedBranch;
	}

	/**
	 * Most recent custom entry of `customType` on the active branch, walking leaf→root
	 * ancestry (same traversal direction as getBranch(), but stops at the first match instead
	 * of building the full path). `fromId` starts the walk at that entry instead of the current
	 * leaf — callers use this to resume the search past an entry they've already rejected.
	 * Payload-agnostic: returns the raw entry, callers own decoding/validating `data`.
	 */
	getLatestCustomEntryOnBranch(customType: string, fromId?: string): CustomEntry | undefined {
		if (fromId !== undefined) {
			// Explicit resume points (a caller rejecting an invalid payload and walking past it) stay
			// on the plain ancestry walk; only the current-leaf query is memoized.
			return this._findLatestCustomEntry(customType, this.byId.get(fromId), undefined);
		}
		const cache = this._latestCustomEntryCacheForIndex();
		const cached = cache.perType.get(customType);
		if (cached && cached.leafId === this.leafId) return cached.match;
		const leaf = this.leafId ? this.byId.get(this.leafId) : undefined;
		const match = this._findLatestCustomEntry(customType, leaf, cached);
		// Re-insert so the map's insertion order doubles as a least-recently-refreshed order.
		cache.perType.delete(customType);
		cache.perType.set(customType, { leafId: this.leafId, match });
		if (cache.perType.size > MAX_LATEST_CUSTOM_ENTRY_CACHE_TYPES) {
			const oldest = cache.perType.keys().next().value;
			if (oldest !== undefined) cache.perType.delete(oldest);
		}
		return match;
	}

	/**
	 * Every custom entry of the given types on the active branch, in branch order. A caller that reads
	 * them on every request (edge grants and revokes) pays for the entries appended since its last read,
	 * not for the whole branch: when the leaf descends from the leaf of the last read, only the entries
	 * after it are walked; a branch switch or a rebuilt index walks the branch once. Payload-agnostic.
	 */
	getCustomEntriesOnBranch(customTypes: readonly string[]): readonly CustomEntry[] {
		if (this.branchCustomEntriesCache?.byId !== this.byId) {
			this.branchCustomEntriesCache = { byId: this.byId, perKey: new Map() };
		}
		const key = customTypes.join("\u0000");
		const types = new Set(customTypes);
		const cached = this.branchCustomEntriesCache.perKey.get(key);
		if (cached && cached.leafId === this.leafId) return cached.entries;
		const appended: CustomEntry[] = [];
		let resumed = false;
		for (
			let entry = this.leafId ? this.byId.get(this.leafId) : undefined;
			entry;
			entry = entry.parentId ? this.byId.get(entry.parentId) : undefined
		) {
			if (cached && cached.leafId !== null && entry.id === cached.leafId) {
				resumed = true;
				break;
			}
			if (entry.type === "custom" && types.has(entry.customType)) appended.push(entry);
		}
		appended.reverse();
		const entries = resumed && cached ? [...cached.entries, ...appended] : appended;
		this.branchCustomEntriesCache.perKey.set(key, { leafId: this.leafId, entries });
		return entries;
	}

	private _latestCustomEntryCacheForIndex(): LatestCustomEntryCache {
		if (this.latestCustomEntryCache?.byId !== this.byId) {
			this.latestCustomEntryCache = { byId: this.byId, perType: new Map() };
		}
		return this.latestCustomEntryCache;
	}

	/**
	 * Walk the ancestry from `start` for the newest `customType` entry. When `cached` names a leaf
	 * that turns out to be an ancestor of `start` (the ordinary append-only case), the walk stops
	 * there and reuses the cached answer for everything below it; a leaf that is not encountered
	 * (a branch switch) means the answer is recomputed from the full ancestry.
	 */
	private _findLatestCustomEntry(
		customType: string,
		start: SessionEntry | undefined,
		cached: { leafId: string | null; match: CustomEntry | undefined } | undefined,
	): CustomEntry | undefined {
		let match: CustomEntry | undefined;
		let reachedCachedLeaf = false;
		visitSessionAncestry(start, this.byId, (entry) => {
			if (cached !== undefined && entry.id === cached.leafId) {
				reachedCachedLeaf = true;
				return false;
			}
			if (entry.type !== "custom" || entry.customType !== customType) return;
			match = entry;
			return false;
		});
		return reachedCachedLeaf ? cached!.match : match;
	}

	/**
	 * Build the session context (what gets sent to the LLM).
	 * Uses tree traversal from current leaf.
	 */
	buildSessionContext(): SessionContext {
		let cached = this.sessionContextCache;
		if (!cached || cached.leafId !== this.leafId) {
			cached = {
				leafId: this.leafId,
				context: buildSessionContext(this.entries, this.leafId, this.byId),
			};
			this.sessionContextCache = cached;
		}
		return cloneSessionContext(cached.context);
	}

	/**
	 * Get session header.
	 */
	getHeader(): SessionHeader | null {
		const h = this.fileEntries.find((e) => e.type === "session");
		return h ? (h as SessionHeader) : null;
	}

	/**
	 * Get all session entries (excludes header). Returns a shallow copy.
	 * The session is append-only: use appendXXX() to add entries, branch() to
	 * change the leaf pointer. Entries cannot be modified or deleted.
	 */
	getEntries(): SessionEntry[] {
		return this.entries.slice();
	}

	/** Entries appended at or after `startIndex`, returned as a defensive shallow slice. */
	getEntriesSince(startIndex: number): SessionEntry[] {
		const normalizedStart = Number.isFinite(startIndex) ? Math.max(0, Math.floor(startIndex)) : 0;
		return this.entries.slice(normalizedStart);
	}

	/** Return current session entry count without allocating a defensive entries array. */
	getEntryCount(): number {
		return this.entries.length;
	}

	/** User and assistant turns on the session: what a hidden-history placeholder can stand for. */
	getConversationEntryCount(): number {
		let count = 0;
		for (const entry of this.entries) {
			if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")) count++;
		}
		return count;
	}

	/**
	 * Release large own payload properties from one already-persisted message without reopening the
	 * session. Calling this immediately after append advances the bounded file-location cursor only
	 * across the new suffix; cold getters restore the exact property from that canonical JSONL line.
	 */
	releasePersistedMessagePayload(entryId: string): void {
		const entry = this.byId.get(entryId);
		if (entry?.type !== "message") {
			throw new TypeError(`Session entry ${entryId} is not a persisted message.`);
		}
		if (!this.persist || !this.flushed || !this.sessionFile) {
			throw new Error(`Session message ${entryId} is not durably persisted.`);
		}
		if (this.persistenceStateUncertain) {
			throw new Error(
				"Session persistence state is uncertain after a failed write; reopen the session file before releasing payloads.",
			);
		}
		const properties = this._releasableMessageProperties(entry);
		if (properties.length === 0) return;
		const location = this._getEntryFileLocation(entryId);
		if (!location) throw new Error(`Persisted session message ${entryId} has no canonical file location.`);
		for (const property of properties) this._releaseMessageProperty(entry, property);
	}

	/**
	 * Visit one bounded entry range without allocating an entries slice or cloning payloads.
	 * Entries are borrowed read-only for the callback duration. `persistedBytes` is a conservative
	 * serialized-size signal for disk-backed cold payloads; infinity means the payload cannot be
	 * restored through the bounded index and consumers must skip it.
	 */
	visitEntries(
		startIndex: number,
		maxEntries: number,
		visitor: (entry: Readonly<SessionEntry>, index: number, persistedBytes?: number) => void,
	): number {
		if (!Number.isSafeInteger(startIndex) || startIndex < 0 || startIndex > this.entries.length) {
			throw new TypeError("Session entry visit start index is invalid.");
		}
		if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_SESSION_ENTRY_VISIT_COUNT) {
			throw new TypeError(`Session entry visit count must be from 1 through ${MAX_SESSION_ENTRY_VISIT_COUNT}.`);
		}
		const endIndex = Math.min(this.entries.length, startIndex + maxEntries);
		const visitedColdPayloadEntryIds = new Set<string>();
		for (let index = startIndex; index < endIndex; index += 1) {
			const entryId = this.entries[index]!.id;
			if (this.coldPayloadEntryIds.has(entryId)) visitedColdPayloadEntryIds.add(entryId);
		}
		if (visitedColdPayloadEntryIds.size > 0) this._ensureEntryFileLocations(visitedColdPayloadEntryIds);
		for (let index = startIndex; index < endIndex; index += 1) {
			const entry = this.entries[index]!;
			const coldPayload = this.coldPayloadEntryIds.has(entry.id);
			const persistedBytes = coldPayload
				? (this.entryFileLocations.get(entry.id)?.length ?? Number.POSITIVE_INFINITY)
				: undefined;
			visitor(entry, index, persistedBytes);
		}
		return endIndex;
	}

	/**
	 * The byte offsets of the given entries' canonical JSONL lines, for the lines the file holds at or past `fromOffset` (a line
	 * boundary). One sequential scan from `fromOffset` to the end of the file, stopping early once every id is found; an id absent
	 * from that range, including a buffered entry not yet written, is not in the result. The entry index is neither read nor
	 * changed. Undefined when more than `maxBytes` lie past `fromOffset` (the scan is not run), or when the file grew past that budget
	 * while ids were still unfound (the scan stops at the budget). The bytes read never exceed `maxBytes`. A failed read throws.
	 */
	entryFileOffsetsFrom(
		entryIds: ReadonlySet<string>,
		fromOffset: number,
		maxBytes: number,
	): ReadonlyMap<string, number> | undefined {
		if (this.sessionFile === undefined || !existsSync(this.sessionFile)) return new Map();
		if (statSync(this.sessionFile).size - fromOffset > maxBytes) return undefined;
		const locations = new Map<string, SessionEntryFileLocation>();
		// The read budget is enforced by the scan itself, so a file that grows after the size check above cannot extend the work
		// past `maxBytes`: when the budget ends the scan with ids still unfound and bytes left unread, the answer is unknown.
		const limitOffset = fromOffset + maxBytes;
		const scannedTo = indexSessionEntryFileLocations(this.sessionFile, fromOffset, locations, entryIds, limitOffset);
		if (locations.size < entryIds.size && scannedTo >= limitOffset && statSync(this.sessionFile).size > scannedTo) {
			return undefined;
		}
		return new Map([...locations].map(([id, location]) => [id, location.offset]));
	}

	/**
	 * Read only a bounded UTF-8 prefix of one persisted entry's canonical JSONL record.
	 * This lets owners classify cold payloads without invoking a disk-backed message getter or
	 * allocating the complete retained line. Returns undefined for in-memory or unknown entries.
	 */
	readEntryJsonPrefix(entryId: string, maxBytes: number): string | undefined {
		if (!this.sessionFile || !this.byId.has(entryId)) return undefined;
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > ENTRY_ID_PREFIX_BYTES) {
			throw new TypeError(`Session entry JSON prefix bytes must be from 1 through ${ENTRY_ID_PREFIX_BYTES}.`);
		}
		const location = this._getEntryFileLocation(entryId);
		if (!location) return undefined;
		const bytesToRead = Math.min(maxBytes, location.length);
		const buffer = Buffer.allocUnsafe(bytesToRead);
		const fd = openSync(this.sessionFile, "r");
		let bytesRead = 0;
		try {
			while (bytesRead < bytesToRead) {
				const count = readSync(fd, buffer, bytesRead, bytesToRead - bytesRead, location.offset + bytesRead);
				if (count === 0) break;
				bytesRead += count;
			}
		} finally {
			closeSync(fd);
		}
		return buffer.subarray(0, bytesRead).toString("utf8");
	}

	/**
	 * Return recent user-entered prompt text for input recall, oldest entry first, each with the entry that holds it.
	 * This walks only the active branch and does not build/render full session context.
	 */
	getRecentUserInputHistory(limit = 100): Array<{ entryId: string; text: string }> {
		const maxEntries = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 100;
		if (maxEntries === 0) return [];
		const history: Array<{ entryId: string; text: string }> = [];
		const leaf = this.leafId ? this.byId.get(this.leafId) : undefined;
		visitSessionAncestry(leaf, this.byId, (entry) => {
			if (entry.type === "message" && entry.message.role === "user") {
				const text = this.getUserInputText(entry.message);
				if (text) history.push({ entryId: entry.id, text });
			}
			if (history.length >= maxEntries) return false;
		});
		return history.reverse();
	}

	private getUserInputText(message: AgentMessage): string | undefined {
		if (message.role !== "user") return undefined;
		const content = message.content;
		if (typeof content === "string") {
			const text = content.trim();
			return text.length > 0 ? text : undefined;
		}
		const text = content
			.filter((part): part is TextContent => part.type === "text")
			.map((part) => part.text)
			.join("")
			.trim();
		return text.length > 0 ? text : undefined;
	}

	/**
	 * Get the session as a tree structure. Returns a shallow defensive copy of all entries.
	 * A well-formed session has exactly one root (first entry with parentId === null).
	 * Orphaned entries (broken parent chain) are also returned as roots.
	 */
	getTree(): SessionTreeNode[] {
		const entries = this.getEntries();
		const nodeMap = new Map<string, SessionTreeNode>();
		const roots: SessionTreeNode[] = [];

		// Create nodes with resolved labels
		for (const entry of entries) {
			const label = this.labelsById.get(entry.id);
			const labelTimestamp = this.labelTimestampsById.get(entry.id);
			nodeMap.set(entry.id, { entry, children: [], label, labelTimestamp });
		}

		// Build tree
		for (const entry of entries) {
			const node = nodeMap.get(entry.id)!;
			if (entry.parentId === null || entry.parentId === entry.id) {
				roots.push(node);
			} else {
				const parent = nodeMap.get(entry.parentId);
				if (parent) {
					parent.children.push(node);
				} else {
					// Orphan - treat as root
					roots.push(node);
				}
			}
		}

		// Sort children by timestamp (oldest first, newest at bottom)
		// Use iterative approach to avoid stack overflow on deep trees
		const stack: SessionTreeNode[] = [...roots];
		while (stack.length > 0) {
			const node = stack.pop()!;
			node.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime());
			stack.push(...node.children);
		}

		return roots;
	}

	// =========================================================================
	// Branching
	// =========================================================================

	/**
	 * Start a new branch from an earlier entry.
	 * Moves the leaf pointer to the specified entry. The next appendXXX() call
	 * will create a child of that entry, forming a new branch. Existing entries
	 * are not modified or deleted.
	 */
	branch(branchFromId: string): void {
		this._assertWritable();
		if (!this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		this.navigationRevision++;
		this._invalidateSessionContextCache();
		this.leafId = branchFromId;
		this.lifecycleActiveCache = undefined;
	}

	/**
	 * Reset the leaf pointer to null (before any entries).
	 * The next appendXXX() call will create a new root entry (parentId = null).
	 * Use this when navigating to re-edit the first user message.
	 */
	resetLeaf(): void {
		this._assertWritable();
		this.navigationRevision++;
		this._invalidateSessionContextCache();
		this.leafId = null;
		this.lifecycleActiveCache = undefined;
	}

	/**
	 * Start a new branch with a summary of the abandoned path.
	 * Same as branch(), but also appends a branch_summary entry that captures
	 * context from the abandoned conversation path.
	 */
	branchWithSummary(
		branchFromId: string | null,
		summary: string,
		details?: unknown,
		fromHook?: boolean,
		usage?: Usage,
		signal?: AbortSignal,
		usageComponents?: readonly UsageComponent[],
		usageReceiptOwned?: true,
	): string {
		if (usageComponents) validateUsageComponents(usage ?? createEmptyUsage(), usageComponents);
		if (branchFromId !== null && !this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		this.navigationRevision++;
		// The canonical append publishes the new leaf and advances/invalidates its caches
		// after persistence. Moving the leaf first strands navigation on a failed write.
		const entry: BranchSummaryEntry = {
			...(usageReceiptOwned ? { usageReceiptOwned } : {}),
			type: "branch_summary",
			id: generateId(this.byId),
			parentId: branchFromId,
			timestamp: new Date().toISOString(),
			fromId: branchFromId ?? "root",
			...(usageComponents ? { usageComponents: structuredClone(usageComponents) } : {}),
			summary,
			details,
			usage,
			fromHook,
		};
		this._appendEntries([entry], undefined, signal);
		return entry.id;
	}

	/**
	 * Create an independent session manager containing only the path from root to the specified
	 * leaf. The source manager is not mutated, so callers can prepare a replacement runtime before
	 * retiring the current one.
	 */
	createBranchedSessionManager(leafId: string): SessionManager {
		this._assertWritable();
		const previousSessionFile = this.sessionFile;
		const path = this.getBranch(leafId);
		if (path.length === 0) {
			throw new Error(`Entry ${leafId} not found`);
		}

		// Filter out LabelEntry from path - we'll recreate them from the resolved map
		const pathWithoutLabels = path.filter((e) => e.type !== "label");

		const newSessionId = createSessionId();
		const timestamp = new Date().toISOString();
		const fileTimestamp = timestamp.replace(/[:.]/g, "-");
		const newSessionFile = join(this.getSessionDir(), `${fileTimestamp}_${newSessionId}.jsonl`);

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: this.cwd,
			parentSession: this.persist ? previousSessionFile : undefined,
		};

		// Collect labels for entries in the path
		const pathEntryIds = new Set(pathWithoutLabels.map((e) => e.id));
		const labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }> = [];
		for (const [targetId, label] of this.labelsById) {
			if (pathEntryIds.has(targetId)) {
				labelsToWrite.push({ targetId, label, timestamp: this.labelTimestampsById.get(targetId)! });
			}
		}

		// Label entries belong to the copied branch, not the source manager.
		const labelEntries: LabelEntry[] = [];
		let parentId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
		for (const { targetId, label, timestamp: labelTimestamp } of labelsToWrite) {
			const labelEntry: LabelEntry = {
				type: "label",
				id: generateId(new Set([...pathEntryIds, ...labelEntries.map((e) => e.id)])),
				parentId,
				timestamp: labelTimestamp,
				targetId,
				label,
			};
			labelEntries.push(labelEntry);
			parentId = labelEntry.id;
		}

		const branched = new SessionManager(this.cwd, this.sessionDir, undefined, this.persist, this.agentDir);
		branched.fileEntries = [header, ...pathWithoutLabels, ...labelEntries];
		branched.sessionId = newSessionId;
		branched.inheritedSessionIds = new Set(this.getSessionLineageIds());
		branched.sessionFile = this.persist ? newSessionFile : undefined;
		branched.coldPayloadEntryIds.clear();
		for (const id of this.coldPayloadEntryIds) {
			if (pathEntryIds.has(id)) branched.coldPayloadEntryIds.add(id);
		}
		branched._buildIndex();

		// Copied owner input and lifecycle evidence retain the same durability rule as an ordinary append.
		// Empty/non-durable prefixes still defer to _persist(), without a duplicate-header write.
		if (this.persist && branched.fileEntries.some(requiresSessionFile)) {
			// Keep the source manager active while cold compacted getters serialize into the copy.
			branched._rewriteFile();
			// Reload through the branch owner so every disk-backed getter closes over the new
			// canonical file instead of retaining the source manager's payload arena.
			branched.setSessionFile(newSessionFile);
		} else {
			branched.flushed = false;
		}
		return branched;
	}

	/**
	 * Create a branch and make it current on this manager.
	 *
	 * Prefer createBranchedSessionManager() when a caller is replacing a live runtime and needs to
	 * keep this manager intact until the replacement has been constructed successfully.
	 */
	createBranchedSession(leafId: string): string | undefined {
		this._assertWritable();
		const branched = this.createBranchedSessionManager(leafId);
		this.navigationRevision++;
		this._invalidateSessionContextCache();
		this.sessionId = branched.sessionId;
		this.sessionFile = branched.sessionFile;
		this.flushed = branched.flushed;
		this.fileEntries = branched.fileEntries;
		this.entries = branched.entries;
		this.byId = branched.byId;
		this.labelsById = branched.labelsById;
		this.labelTimestampsById = branched.labelTimestampsById;
		this.leafId = branched.leafId;
		this.lifecycleActiveCache = undefined;
		this.latestCustomEntryCache = undefined;
		this.branchCustomEntriesCache = undefined;
		this.persistenceStateUncertain = branched.persistenceStateUncertain;
		this._announcePersistenceFence();
		this.inheritedSessionIds = new Set(branched.inheritedSessionIds);
		this.coldPayloadEntryIds.clear();
		for (const id of branched.coldPayloadEntryIds) this.coldPayloadEntryIds.add(id);
		this._resetEntryFileIndex();
		return this.sessionFile;
	}

	/**
	 * Create a new session.
	 * @param cwd Working directory (stored in session header)
	 * @param agentDir Agent config dir used to compute the default session dir and default-dir candidates.
	 * @param sessionDir Optional session directory. If omitted, uses default (<agentDir>/sessions/<encoded-cwd>/).
	 */
	static create(cwd: string, agentDir: string, sessionDir?: string, options?: NewSessionOptions): SessionManager {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd, agentDir);
		return new SessionManager(cwd, dir, undefined, true, agentDir, options);
	}

	/** Materialize only a known never-persisted empty session; callers must validate its independent identity evidence. */
	static materializeMissingEmptySession(args: {
		cwd: string;
		agentDir: string;
		sessionFile: string;
		id: string;
		timestamp: string;
		version: number;
	}): SessionManager {
		assertValidSessionId(args.id);
		if (
			args.version !== CURRENT_SESSION_VERSION ||
			!Number.isFinite(Date.parse(args.timestamp)) ||
			new Date(args.timestamp).toISOString() !== args.timestamp
		)
			throw new Error("Invalid original empty-session header");
		const sessionFile = resolvePath(args.sessionFile);
		const expectedName = `${args.timestamp.replace(/[:.]/g, "-")}_${args.id}.jsonl`;
		if (basename(sessionFile) !== expectedName || existsSync(sessionFile))
			throw new Error("Original session path is invalid or already exists");
		const manager = new SessionManager(args.cwd, dirname(sessionFile), undefined, true, args.agentDir, {
			id: args.id,
		});
		manager.sessionFile = sessionFile;
		manager.fileEntries = [
			{ type: "session", version: args.version, id: args.id, timestamp: args.timestamp, cwd: manager.cwd },
		];
		manager.flushBufferedEntries();
		return manager;
	}

	/**
	 * Open a specific session file.
	 * @param path Path to session file
	 * @param agentDir Agent config dir used to compute default-dir candidates for usesDefaultSessionDir().
	 * @param sessionDir Optional session directory for /new or /branch. If omitted, derives from file's parent.
	 * @param cwdOverride Optional cwd override instead of the session header cwd.
	 */
	static open(path: string, agentDir: string, sessionDir?: string, cwdOverride?: string): SessionManager {
		return SessionManager._open(path, agentDir, sessionDir, cwdOverride, false, false);
	}

	/** Inspect existing history without repairing, migrating or creating any file on disk. */
	static openReadOnly(path: string, agentDir: string): ReadonlySessionManager {
		return SessionManager._open(path, agentDir, undefined, undefined, true, false);
	}

	/** Existing worker histories are canonical; opening them never repairs storage. */
	static openCanonical(path: string, agentDir: string, sessionDir?: string): SessionManager {
		return SessionManager._open(path, agentDir, sessionDir, undefined, false, true);
	}

	private static _open(
		path: string,
		agentDir: string,
		sessionDir: string | undefined,
		cwdOverride: string | undefined,
		readOnly: boolean,
		canonicalOnly: boolean,
	): SessionManager {
		const resolvedPath = resolvePath(path);
		// Read only the header here; the constructor performs the one full session load.
		const header = readSessionHeader(resolvedPath);
		const cwd = cwdOverride ?? header?.cwd ?? process.cwd();
		// If no sessionDir provided, derive from file's parent directory
		const dir = sessionDir ? normalizePath(sessionDir) : resolve(resolvedPath, "..");
		return new SessionManager(cwd, dir, resolvedPath, true, agentDir, undefined, readOnly, canonicalOnly);
	}

	/**
	 * Continue the most recent session, or create new if none.
	 * @param cwd Working directory
	 * @param agentDir Agent config dir used to compute the default session dir and default-dir candidates.
	 * @param sessionDir Optional session directory. If omitted, uses default (<agentDir>/sessions/<encoded-cwd>/).
	 */
	static continueRecent(cwd: string, agentDir: string, sessionDir?: string): SessionManager {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd, agentDir);
		const defaultDirs = getDefaultSessionDirCandidates(cwd, agentDir);
		const filterCwd = sessionDir !== undefined && !defaultDirs.includes(dir);
		const searchDirs = sessionDir ? [dir] : defaultDirs;
		// The phone session the bot daemon hosts is skipped: opening it here is refused while the daemon holds it.
		const hosted = (id: string): boolean => {
			try {
				return sessionChannelHost(agentDir, id) !== undefined;
			} catch {
				return false; // An unreadable registry is reported by the open's own lease acquisition.
			}
		};
		const mostRecent = findMostRecentSessionInDirs(searchDirs, filterCwd ? cwd : undefined, hosted);
		if (mostRecent) {
			return new SessionManager(cwd, resolve(mostRecent, ".."), mostRecent, true, agentDir);
		}
		return new SessionManager(cwd, dir, undefined, true, agentDir);
	}

	/** Create an in-memory session (no file persistence). No agent dir applies (usesDefaultSessionDir is false). */
	static inMemory(cwd: string = process.cwd()): SessionManager {
		return new SessionManager(cwd, "", undefined, false, "");
	}

	/**
	 * Fork a session from another project directory into the current project.
	 * Creates a new session in the target cwd with the full history from the source session.
	 * @param sourcePath Path to the source session file
	 * @param targetCwd Target working directory (where the new session will be stored)
	 * @param agentDir Agent config dir used to compute the default session dir for targetCwd.
	 * @param sessionDir Optional session directory. If omitted, uses default for targetCwd.
	 */
	static forkFrom(
		sourcePath: string,
		targetCwd: string,
		agentDir: string,
		sessionDir?: string,
		options?: NewSessionOptions,
	): SessionManager {
		const resolvedSourcePath = resolvePath(sourcePath);
		const resolvedTargetCwd = resolvePath(targetCwd);
		const sourceEntries = loadEntriesFromFile(resolvedSourcePath);
		if (sourceEntries.length === 0) {
			throw new Error(`Cannot fork: source session file is empty or invalid: ${resolvedSourcePath}`);
		}

		const sourceHeader = sourceEntries.find((e) => e.type === "session") as SessionHeader | undefined;
		if (!sourceHeader) {
			throw new Error(`Cannot fork: source session has no header: ${resolvedSourcePath}`);
		}

		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(resolvedTargetCwd, agentDir);
		// Create new session file with new ID but forked content
		if (options?.id !== undefined) {
			assertValidSessionId(options.id);
		}
		const newSessionId = options?.id ?? createSessionId();
		const timestamp = new Date().toISOString();
		const fileTimestamp = timestamp.replace(/[:.]/g, "-");
		const newSessionFile = join(dir, `${fileTimestamp}_${newSessionId}.jsonl`);

		// Write new header pointing to source as parent, with updated cwd
		const newHeader: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: resolvedTargetCwd,
			parentSession: resolvedSourcePath,
		};
		withSessionFileMutation(agentDir, newSessionFile, newSessionId, "create", () => {
			const fd = openSync(newSessionFile, "wx");
			try {
				writeFileSync(fd, `${JSON.stringify(newHeader)}\n`);
				for (const entry of sourceEntries) {
					if (entry.type !== "session") writeFileSync(fd, `${JSON.stringify(entry)}\n`);
				}
			} finally {
				closeSync(fd);
			}
		});

		return new SessionManager(resolvedTargetCwd, dir, newSessionFile, true, agentDir);
	}

	/**
	 * List all sessions for a directory.
	 * @param cwd Working directory (used to compute default session directory)
	 * @param agentDir Agent config dir used to compute the default session dir and default-dir candidates.
	 * @param sessionDir Optional session directory. If omitted, uses default (<agentDir>/sessions/<encoded-cwd>/).
	 * @param onProgress Optional callback for progress updates (loaded, total)
	 */
	static async list(
		cwd: string,
		agentDir: string,
		sessionDir?: string,
		onProgress?: SessionListProgress,
	): Promise<SessionInfo[]> {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd, agentDir);
		const defaultDirs = getDefaultSessionDirCandidates(cwd, agentDir);
		const filterCwd = sessionDir !== undefined && !defaultDirs.includes(dir);
		const resolvedCwd = resolvePath(cwd);
		const dirs = sessionDir ? [dir] : defaultDirs;
		const progressCounts = await Promise.all(dirs.map((candidateDir) => countSessionFiles(candidateDir)));
		const progressTotal = progressCounts.reduce((sum, count) => sum + count, 0);
		const allSessions: SessionInfo[] = [];
		let progressOffset = 0;
		for (let i = 0; i < dirs.length; i++) {
			const candidateDir = dirs[i];
			const sessions = (await listSessionsFromDir(candidateDir, onProgress, progressOffset, progressTotal)).filter(
				(session) => !filterCwd || sessionCwdMatches(session.cwd, resolvedCwd),
			);
			progressOffset += progressCounts[i];
			allSessions.push(...sessions);
		}
		allSessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
		return allSessions;
	}

	/**
	 * List all sessions across all project directories under the sessions root.
	 * @param sessionsDir Sessions root dir to scan for per-project subdirectories (e.g. <agentDir>/sessions).
	 * @param customSessionDir Optional single directory to list flat instead of scanning the root.
	 * @param onProgress Optional callback for progress updates (loaded, total)
	 */
	static async listAll(sessionsDir: string, onProgress?: SessionListProgress): Promise<SessionInfo[]>;
	static async listAll(
		sessionsDir: string,
		customSessionDir?: string,
		onProgress?: SessionListProgress,
	): Promise<SessionInfo[]>;
	static async listAll(
		sessionsDir: string,
		customSessionDirOrOnProgress?: string | SessionListProgress,
		onProgress?: SessionListProgress,
	): Promise<SessionInfo[]> {
		const customSessionDir =
			typeof customSessionDirOrOnProgress === "string" ? normalizePath(customSessionDirOrOnProgress) : undefined;
		const progress = typeof customSessionDirOrOnProgress === "function" ? customSessionDirOrOnProgress : onProgress;
		if (customSessionDir) {
			const sessions = await listSessionsFromDir(customSessionDir, progress);
			sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
			return sessions;
		}

		const resolvedSessionsDir = normalizePath(sessionsDir);

		try {
			if (!existsSync(resolvedSessionsDir)) {
				return [];
			}
			const entries = await readdir(resolvedSessionsDir, { withFileTypes: true });
			const dirs = entries.filter((e) => e.isDirectory()).map((e) => join(resolvedSessionsDir, e.name));

			// Count total files first for accurate progress
			let totalFiles = 0;
			const dirFiles: string[][] = [];
			for (const dir of dirs) {
				try {
					const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
					dirFiles.push(files.map((f) => join(dir, f)));
					totalFiles += files.length;
				} catch {
					dirFiles.push([]);
				}
			}

			// Process all files with progress tracking
			let loaded = 0;
			const sessions: SessionInfo[] = [];
			const allFiles = dirFiles.flat();

			const results = await buildSessionInfosWithConcurrency(allFiles, () => {
				loaded++;
				progress?.(loaded, totalFiles);
			});

			for (const info of results) {
				if (info) {
					sessions.push(info);
				}
			}

			sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
			return sessions;
		} catch {
			return [];
		}
	}
}
