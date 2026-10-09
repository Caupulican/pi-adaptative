/**
 * Memory controller: the session's plug-and-play memory subsystem — the read-only OKF retrieval
 * provider, the bounded prompt-evidence surfacing pilot, cross-session recall effectiveness, and the
 * live {@link MemoryManager} (bundled file-store + transcript-recall providers plus any extension
 * contributions).
 *
 * Extracted verbatim from agent-session.ts (god-file decomposition). Owns the lazily-built OKF
 * provider, the latest retrieval/prompt-inclusion reports, the recreated-on-reload MemoryManager, the
 * recall {@link EffectivenessTracker}, and the extension-contributed pending providers. Everything
 * else it needs — settings, the current turn index, agent/workspace dirs, the session id, the
 * child-session flag, and the tool-registry refresh — is reached through narrow deps accessors rather
 * than the whole AgentSession.
 *
 * Context-transform boundary (deliberate): {@link runMemoryRetrieval} and
 * {@link maybeAppendMemoryEvidenceBlock} are invoked from the session's context transform as one-line
 * delegations. This controller deliberately imports no compaction/context-pipeline internals — it only
 * ever reads settings and builds the retrieval report + the bounded evidence block, so the transform
 * stays the single owner of the pass ordering.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { type AgentMessage, createCustomMessage, HOST_TRANSIENT_CLEARED_DETAILS } from "../kernel/index.ts";
import type { SessionEntriesPersistedEvent } from "../kernel/session/session-manager.ts";
import { configFile, okfMemoryDir, projectMemoryDir } from "./agent-paths.ts";
import { collectCurrentWorkMemory } from "./context/current-work-memory.ts";
import { createFileStoreMemoryProvider } from "./context/file-store-memory-provider.ts";
import { createLocalGraphMemoryProvider } from "./context/local-graph-memory-provider.ts";
import { shouldQueryLongTermMemory } from "./context/long-term-memory-trigger.ts";
import {
	defaultMemoryPromptInclusionReport,
	type MemoryPromptInclusionReport,
	type MemoryRetrievalDiagnostics,
	sanitizeMemoryRetrievalReportForDiagnostics,
} from "./context/memory-diagnostics.ts";
import { type MemoryPromptBudget, resolveMemoryPromptBudget } from "./context/memory-prompt-budget.ts";
import {
	type MemoryProvider as ContextMemoryProvider,
	DEFAULT_EXTERNAL_MEMORY_EGRESS_POLICY,
	DEFAULT_LOCAL_MEMORY_EGRESS_POLICY,
} from "./context/memory-provider-contract.ts";
import { type MemoryRetrievalReport, retrieveMemoryForContext } from "./context/memory-retrieval.ts";
import { composeTieredMemoryPromptBlock, type MemoryTierCandidate } from "./context/memory-tier-composer.ts";
import { createOkfMemoryProvider, loadOkfMemoryBundle } from "./context/okf-memory-provider.ts";
import type { MemoryProvider } from "./extensions/types.ts";
import type { GoalState } from "./goals/goal-state.ts";
import { EffectivenessTracker } from "./memory/effectiveness-tracker.ts";
import { MemoryManager } from "./memory/memory-manager.ts";
import {
	FILE_STORE_MEMORY_SYSTEM_NOTE,
	FileStoreProvider,
	type ManagedMemoryDriftEntry,
	type ManagedMemoryTarget,
	type StructuredReflectionApplyResult,
	type StructuredReflectionRollback,
	type StructuredReflectionWrite,
	USER_PERSONA_CUSTOM_TYPE,
} from "./memory/providers/file-store.ts";
import { IcmProvider } from "./memory/providers/icm.ts";
import { TranscriptRecallProvider } from "./memory/providers/transcript-recall.ts";
import {
	formatTranscriptSourceHandle,
	parseTranscriptSourceHandle,
	type TranscriptSourceReader,
} from "./memory/transcript-memory-contracts.ts";
import { extractTranscriptSourceHandles, openTranscriptSource } from "./memory/transcript-source-tools.ts";
import type {
	UserPreferenceAdmissionRequest,
	UserPreferenceAdmissionResult,
} from "./memory/user-preference-metadata.ts";
import type { WorkerMemoryBroker } from "./memory/worker-memory-tools.ts";
import { wrapUntrustedText } from "./security/untrusted-boundary.ts";
import { getDirectoryResourceProfileInfo, isValidMemorySystem } from "./settings/settings-rules.ts";
import type { MemorySystem, SettingsError, SettingsScope } from "./settings/settings-schema.ts";

/** The settings this module reads, declared by the module itself; the composition root passes the SettingsManager. */
export interface MemoryControllerSettingsSource {
	drainErrors(): SettingsError[];
	flush(): Promise<void>;
	getMemoryRetrievalSettings(): {
		enabled: boolean;
		maxResults: number;
		includeInPrompt: boolean;
		allowExternalEgress: boolean;
	};
	getMemorySystem(): MemorySystem;
	setMemorySystem(system: MemorySystem, scope?: SettingsScope): void;
}

/**
 * Text of the most recent user message, or "" if there is none (e.g. goal-continuation
 * turns with no new user input). An empty query is still valid: standing user preferences may
 * surface from the file-store retrieval fallback when the static memory prompt cannot fit,
 * while long-term providers remain gated by shouldQueryLongTermMemory().
 */
function lastMessageIsUserTurn(messages: AgentMessage[]): boolean {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === "custom") continue;
		return message.role === "user";
	}
	return false;
}

function latestUserMessageText(messages: AgentMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		const parts: string[] = [];
		for (const part of message.content) {
			if (part.type === "text") parts.push(part.text);
		}
		return parts.join("\n");
	}
	return "";
}

function emptyMemoryRetrievalReport(maxResults: number): MemoryRetrievalReport {
	return { request: { query: "", maxResults }, providerReports: [], results: [], contextItems: [] };
}

const ENABLED_EXTERNAL_MEMORY_EGRESS_POLICY = {
	...DEFAULT_EXTERNAL_MEMORY_EGRESS_POLICY,
	enabled: true,
	allowedScopes: DEFAULT_LOCAL_MEMORY_EGRESS_POLICY.allowedScopes,
	allowExternalEgress: true,
} as const;

const MAX_PRE_COMPRESS_MEMORY_CHARS = 4_000;
/** Transcript sources one delegated lane may hold open at a time; the oldest admission is dropped first. */
const MAX_ADMITTED_LANE_SOURCES = 512;

/** History reads under disabled memory retrieval: a typed policy refusal, never an empty success. */
const POLICY_BLOCKED_HISTORY_READER: TranscriptSourceReader = {
	search: async () => ({ status: "forbidden", reason: "Memory retrieval is disabled by policy." }),
	readSource: async () => ({ status: "forbidden", reason: "Memory retrieval is disabled by policy." }),
	coverage: () => undefined,
};

function boundPreCompressMemory(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length <= MAX_PRE_COMPRESS_MEMORY_CHARS) return trimmed;
	const suffix = "\n...[memory handoff truncated]";
	return `${trimmed.slice(0, MAX_PRE_COMPRESS_MEMORY_CHARS - suffix.length).trimEnd()}${suffix}`;
}

export interface MemoryControllerDeps {
	/** Memory-retrieval + prompt-inclusion settings (default-on gates for retrieval and surfacing). */
	getSettingsManager(): MemoryControllerSettingsSource;
	/** Current turn index, stamped into a retrieval request's `createdAtTurn`. */
	getTurnIndex(): number;
	/** Agent root — the durable OKF memory docs live under `<agentDir>/okf-memory`. */
	getAgentDir(): string;
	/** Workspace root, passed to provider initialization. */
	getCwd(): string;
	/** This session's id, passed to provider initialization. */
	getSessionId(): string;
	/** Child sessions gate durable memory writes; passed to provider initialization. */
	isChildSession(): boolean;
	/** Re-derive the tool registry after (re)init so the newly-surfaced memory tools take effect. */
	refreshToolRegistry(): void;
	/** Acquire the existing foreground submission lease only when all session work is idle. */
	acquireSystemSwitchLease?(): (() => void) | undefined;
	/** Active model context window, used to cap prompt-visible memory. */
	getContextWindow(): number | undefined;
	/** Latest active goal state, used for short-term current-work memory. */
	getGoalState(): GoalState | undefined;
	/** The session's operator-facing warning path; managed-memory notices are reported through it. */
	emitWarning(message: string): void;
	/**
	 * Admission owner for USER.md preference writes (the reflection controller: owner evidence,
	 * gate, audit). Absent only in narrow hosts; the file-store then labels writes unverified.
	 */
	admitUserPreference?(request: UserPreferenceAdmissionRequest): Promise<UserPreferenceAdmissionResult>;
	/**
	 * Durable-publication events of this session's entries, for incremental history ingestion. The
	 * returned function unsubscribes. Absent in narrow hosts: recall then covers only what it indexed
	 * at initialization.
	 */
	subscribeEntriesPersisted?(listener: (event: SessionEntriesPersistedEvent) => void): () => void;
}

/** Extension-contributed memory state staged across an atomic runtime reload. */
export interface MemoryControllerReloadSnapshot {
	pendingMemoryProviders: MemoryProvider[];
	pendingContextMemoryProviders: ContextMemoryProvider[];
	memoryOkfProvider: ContextMemoryProvider | undefined;
	fileStoreMemoryProvider: ContextMemoryProvider | undefined;
}

/** One immutable, source-versioned delegated-memory view shared by concurrent equivalent reads. */
export interface LaneMemoryReadSnapshot {
	readonly snapshotId: string;
	readonly sourceGeneration: number;
	readonly sourceRevision: number;
	readonly content: string;
}

/** A memory mutation or lifecycle transition invalidated a delegated read before it could be used. */
export class LaneMemorySnapshotStaleError extends Error {
	constructor() {
		super("memory_snapshot_stale: memory changed while the delegated read was in flight; retry the read.");
		this.name = "LaneMemorySnapshotStaleError";
	}
}

export class MemoryController {
	private _memoryOkfProvider: ContextMemoryProvider | undefined = undefined;
	private _fileStoreMemoryProvider: ContextMemoryProvider | undefined = undefined;
	private _localGraphProvider: ContextMemoryProvider | undefined = undefined;
	private _localGraphResolved = false;
	private _latestMemoryRetrievalReport: MemoryRetrievalReport | undefined = undefined;
	private _latestMemoryPromptInclusionReport: MemoryPromptInclusionReport | undefined = undefined;
	/** True only when this pass actually admitted long-term providers. */
	private _lastLongTermQueryAttempted = false;
	/** Plug-and-play memory subsystem. Recreated on each (re)initialize so reload is safe. */
	private _memoryManager: MemoryManager = new MemoryManager();
	/** Active generation's single durable file/OKF writer, also used by parent-owned reflection. */
	private _fileStoreWriter: FileStoreProvider | undefined;
	/** Active generation's transcript recall provider: the one backend for history search and source reads. */
	private _transcriptRecall: TranscriptRecallProvider | undefined;
	private _unsubscribeEntriesPersisted: (() => void) | undefined;
	/** R4: tracks whether injected recall is actually used, to adapt the recall gate. */
	private readonly _effectivenessTracker = new EffectivenessTracker();
	/** Memory providers registered by extensions via pi.registerMemoryProvider, applied on (re)init. */
	private _pendingMemoryProviders: MemoryProvider[] = [];
	/** Context-memory providers registered by extensions via pi.registerContextMemoryProvider. */
	private _pendingContextMemoryProviders: ContextMemoryProvider[] = [];
	/** Serializes provider write hooks without delaying the foreground turn. */
	private _lifecycleTail: Promise<void> = Promise.resolve();
	/** The on-disk revision last reported per managed target and notice kind (bounded: one entry per key). */
	private readonly _reportedManagedNotices = new Map<string, string>();
	private _shutdownPromise: Promise<void> | undefined;
	private _activeMemorySystem: MemorySystem | undefined;
	private _memoryGeneration = 0;
	/** Monotone process-local revision advanced by the durable writer's authoritative change callback. */
	private _memoryContentRevision = 0;
	/** Active equivalent reads only. Completed snapshots are not cached across possible external file changes. */
	private readonly _laneMemoryReads = new Map<string, Promise<LaneMemoryReadSnapshot>>();
	private _transitioning = false;
	private _initializationFailed = false;

	private readonly deps: MemoryControllerDeps;

	constructor(deps: MemoryControllerDeps) {
		this.deps = deps;
	}

	getActiveMemorySystem(): MemorySystem | undefined {
		return this._activeMemorySystem;
	}

	/** Operator switch: activation and persistence must both succeed under the session's lease. */
	async setMemorySystem(system: MemorySystem): Promise<{ ok: boolean; message: string }> {
		if (!isValidMemorySystem(system)) return { ok: false, message: "Memory system must be okf or icm." };
		const release = this.deps.acquireSystemSwitchLease?.();
		if (!release) return { ok: false, message: "Memory system can only change while the session is fully idle." };
		const settings = this.deps.getSettingsManager();
		const previous = settings.getMemorySystem();
		const activate = async (selected: MemorySystem) => {
			settings.setMemorySystem(selected, "directoryProfile");
			await this.initialize();
			await settings.flush();
			const errors = settings.drainErrors();
			if (errors.length) throw new Error(errors.map(({ error }) => error.message).join("; "));
			if (this._activeMemorySystem !== selected) throw new Error(`${selected} memory did not activate`);
		};
		try {
			if (previous === system && this._activeMemorySystem === system) {
				return { ok: true, message: `Memory system already active: ${system}.` };
			}
			try {
				await activate(system);
				return {
					ok: true,
					message: `Memory system switched to ${system} for this directory profile. Existing memory files and transcript preserved.`,
				};
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				try {
					await activate(previous);
					return { ok: false, message: `Memory switch failed: ${reason}. Restored ${previous}.` };
				} catch (rollbackError) {
					return {
						ok: false,
						message: `Memory switch failed: ${reason}. Rollback could not be verified: ${String(rollbackError)}.`,
					};
				}
			}
		} finally {
			release();
		}
	}

	/** Bind extension projection to one memory generation; never mutate durable history. */
	createContextProjection(getRunner: () => import("./extensions/index.ts").ExtensionRunner) {
		return async (messages: AgentMessage[]) => {
			const runner = getRunner();
			const generation = this._memoryGeneration;
			const filtered = this.filterProviderContext(messages);
			const projection = runner.hasHandlers("context")
				? await runner.emitContext(filtered)
				: { messages: filtered, transientMessages: [] };
			return {
				messages: this.filterProviderContext(projection.messages),
				transientMessages: this.filterProviderContext(projection.transientMessages),
				isCurrent: () => getRunner() === runner && this._memoryGeneration === generation,
			};
		};
	}

	/** Omit inactive generated context from provider requests, never from durable history. */
	filterProviderContext(messages: AgentMessage[]): AgentMessage[] {
		const icm = this.deps.getSettingsManager().getMemorySystem?.() === "icm";
		return messages.filter((message) => {
			if (message.role !== "custom") return true;
			if (message.customType === "pipeline_context") {
				const mode = (message.details as { contextMode?: string } | undefined)?.contextMode ?? "inline";
				return mode === (icm ? "on-demand" : "inline");
			}
			return (
				!icm ||
				![
					"memory_context",
					"memory_evidence",
					"user_persona",
					"reflection_cue",
					"reflection_turn_trigger",
				].includes(message.customType)
			);
		});
	}

	private _legacyMemoryEnabled(): boolean {
		return (
			!this._transitioning &&
			!this._initializationFailed &&
			this._activeMemorySystem !== "icm" &&
			this.deps.getSettingsManager().getMemorySystem?.() !== "icm"
		);
	}

	/** The live memory manager. Callers reach prefetch / tool-definitions / markers / shutdown through it. */
	getMemoryManager(): MemoryManager {
		return this._memoryManager;
	}

	/** The bundled file-store writer, for operator recovery commands; undefined in child sessions or before init. */
	getFileStoreWriter(): FileStoreProvider | undefined {
		return !this._legacyMemoryEnabled() || this.deps.isChildSession() ? undefined : this._fileStoreWriter;
	}

	/** Queue one completed turn for provider-owned durable synchronization. Raw tool output is excluded by the caller. */
	scheduleTurnSync(userText: string, assistantText: string): void {
		if (!this._legacyMemoryEnabled() || (!userText.trim() && !assistantText.trim())) return;
		const manager = this._memoryManager;
		// Admit the revision before queuing the write: an older read must fail even while this hook waits
		// behind prior lifecycle work, and a newer read will wait for the exact captured tail below.
		if (manager.hasActiveTurnSyncProvider()) this._memoryContentRevision++;
		this._lifecycleTail = this._lifecycleTail
			.then(() => manager.syncTurn(userText, assistantText))
			.catch((error) => {
				console.error(
					"Memory turn synchronization failed:",
					error instanceof Error ? error.message : String(error),
				);
			});
	}

	/** Wait for prior turn writes, then collect one bounded provider handoff for the whole compaction run. */
	async onPreCompress(): Promise<string> {
		if (!this._legacyMemoryEnabled()) return "";
		const generation = this._memoryGeneration;
		await this._lifecycleTail;
		if (!this._legacyMemoryEnabled() || generation !== this._memoryGeneration) return "";
		const result = await this._memoryManager.onPreCompress();
		return this._legacyMemoryEnabled() && generation === this._memoryGeneration ? boundPreCompressMemory(result) : "";
	}

	/** Flush write-side lifecycle hooks before releasing provider resources. Idempotent per session. */
	shutdown(): Promise<void> {
		this._shutdownPromise ??= (async () => {
			const legacy = this._legacyMemoryEnabled();
			this._memoryGeneration++;
			this._fileStoreWriter = undefined;
			this._releaseTranscriptRecall();
			this._activeMemorySystem = undefined;
			this._transitioning = true;
			await this._lifecycleTail;
			if (legacy) await this._memoryManager.onSessionEnd();
			await this._memoryManager.shutdownAll();
		})();
		return this._shutdownPromise;
	}

	/**
	 * Fixed path for this slice's local Pi OKF memory documents, shared across sessions
	 * under this agentDir (not session-scoped, unlike tool-artifacts/context-gc, since OKF
	 * memory represents durable cross-session knowledge, not a per-session capture). Not
	 * yet user-configurable -- see the memory-retrieval settings doc comment.
	 */
	private _memoryOkfDir(): string {
		return okfMemoryDir(this.deps.getAgentDir());
	}

	/**
	 * Session-scoped, read-only local OKF memory provider. Lazily created ONLY when memory
	 * retrieval is enabled (see `runMemoryRetrieval`) -- never force-created, so a session
	 * with the setting off never touches `_memoryOkfDir()` at all (no directory access, no
	 * creation; `createOkfMemoryProvider` itself never writes/mkdirs either way).
	 */
	private _getMemoryOkfProvider(): ContextMemoryProvider {
		const project = getDirectoryResourceProfileInfo(this.deps.getCwd(), this.deps.getAgentDir());
		this._memoryOkfProvider ??= createOkfMemoryProvider({
			rootDir: this._memoryOkfDir(),
			projectId: project.hash,
			projectRoot: project.root,
		});
		return this._memoryOkfProvider;
	}

	private _getFileStoreMemoryProvider(budget: MemoryPromptBudget): ContextMemoryProvider {
		const project = getDirectoryResourceProfileInfo(this.deps.getCwd(), this.deps.getAgentDir());
		const frozenLines = this._fileStoreWriter?.getFrozenPromptLines();
		this._fileStoreMemoryProvider = createFileStoreMemoryProvider({
			memoryFilePath: configFile(this.deps.getAgentDir(), "MEMORY.md"),
			userFilePath: configFile(this.deps.getAgentDir(), "USER.md"),
			projectMemoryFilePath: join(projectMemoryDir(this.deps.getAgentDir(), project.hash), "MEMORY.md"),
			frozenPromptLines: frozenLines,
			compact: budget.compact,
		});
		return this._fileStoreMemoryProvider;
	}

	private _getLocalGraphProvider(): ContextMemoryProvider | undefined {
		if (!this._localGraphResolved) {
			this._localGraphProvider = createLocalGraphMemoryProvider({
				cwd: this.deps.getCwd(),
				agentDir: this.deps.getAgentDir(),
			});
			this._localGraphResolved = true;
		}
		return this._localGraphProvider;
	}

	private _memoryBudget(configuredMaxResults: number) {
		return resolveMemoryPromptBudget({
			contextWindow: this.deps.getContextWindow(),
			configuredMaxResults,
		});
	}

	private _shouldQueryFileStoreFallback(budget: MemoryPromptBudget): boolean {
		if (!budget.enabled) return false;
		// Compact windows: only query if the frozen static block is empty (omitted).
		if (budget.compact) {
			const frozenLines = this._fileStoreWriter?.getFrozenPromptLines();
			return frozenLines === undefined || frozenLines.size === 0;
		}
		// Normal windows: the static block is installed but may omit lines beyond the
		// budget. Query the file-store for omitted general/project facts only.
		return true;
	}

	/**
	 * Observe-only local memory retrieval (see context/memory-retrieval.ts and
	 * context/okf-memory-provider.ts): default-on, but settings-gated. When disabled,
	 * never constructs built-in context-memory providers (no directory access under
	 * `_memoryOkfDir()` at all) and returns an empty report -- fully fail-closed. When enabled,
	 * queries local, read-only providers with the latest user message text (empty if there is
	 * none, e.g. a goal-continuation turn) under `DEFAULT_LOCAL_MEMORY_EGRESS_POLICY`.
	 * Retrieved items are only ever stored in the report; nothing here touches `messages`,
	 * the transcript, or the provider-visible prompt. Never throws into a live turn: any
	 * failure (including a provider search error) degrades to an empty report.
	 */
	async runMemoryRetrieval(messages: AgentMessage[]): Promise<MemoryRetrievalReport> {
		if (!this._legacyMemoryEnabled()) return emptyMemoryRetrievalReport(0);
		const generation = this._memoryGeneration;
		let queriedLongTerm = false;
		try {
			const settings = this.deps.getSettingsManager().getMemoryRetrievalSettings();
			if (!settings.enabled) {
				this._lastLongTermQueryAttempted = false;
				const report = emptyMemoryRetrievalReport(settings.maxResults);
				this._latestMemoryRetrievalReport = report;
				return report;
			}
			const query = latestUserMessageText(messages);
			const budget = this._memoryBudget(settings.maxResults);
			const currentWork = collectCurrentWorkMemory({ goalState: this.deps.getGoalState() });
			const longTermDecision = shouldQueryLongTermMemory({
				latestUserText: query,
				goalState: this.deps.getGoalState(),
				budget,
				currentWorkCandidateCount: currentWork.length,
			});
			queriedLongTerm = longTermDecision.shouldQuery && lastMessageIsUserTurn(messages);
			this._lastLongTermQueryAttempted = queriedLongTerm;
			const queryFileStore = this._shouldQueryFileStoreFallback(budget);
			const providers = queryFileStore ? [this._getFileStoreMemoryProvider(budget)] : [];
			if (queriedLongTerm) {
				providers.push(
					this._getMemoryOkfProvider(),
					...this._pendingContextMemoryProviders.filter((provider) => provider.capabilities.localOnly),
				);
				if (longTermDecision.shouldQueryExternal !== false) {
					providers.push(
						...this._pendingContextMemoryProviders.filter((provider) => !provider.capabilities.localOnly),
					);
				}
				const graph = this._getLocalGraphProvider();
				if (graph) providers.push(graph);
			}
			const maxResults = budget.enabled ? Math.min(settings.maxResults, budget.maxResults) : settings.maxResults;
			const report = await retrieveMemoryForContext(
				providers,
				{ query, maxResults },
				{
					createdAtTurn: this.deps.getTurnIndex(),
					maxResults,
					defaultLocalPolicy: DEFAULT_LOCAL_MEMORY_EGRESS_POLICY,
					defaultExternalPolicy: settings.allowExternalEgress
						? ENABLED_EXTERNAL_MEMORY_EGRESS_POLICY
						: DEFAULT_EXTERNAL_MEMORY_EGRESS_POLICY,
				},
			);
			if (!this._legacyMemoryEnabled() || generation !== this._memoryGeneration)
				return emptyMemoryRetrievalReport(0);
			if (
				queriedLongTerm ||
				this._latestMemoryRetrievalReport === undefined ||
				(queryFileStore && report.contextItems.length > 0)
			) {
				this._latestMemoryRetrievalReport = report;
			}
			return report;
		} catch {
			if (!this._legacyMemoryEnabled() || generation !== this._memoryGeneration)
				return emptyMemoryRetrievalReport(0);
			this._lastLongTermQueryAttempted = queriedLongTerm;
			const report = emptyMemoryRetrievalReport(0);
			if (queriedLongTerm || this._latestMemoryRetrievalReport === undefined) {
				this._latestMemoryRetrievalReport = report;
			}
			return report;
		}
	}

	/** Read-only inspection of the latest memory-retrieval report, for tests/debugging. */
	getMemoryRetrievalReport(): MemoryRetrievalReport {
		return this._latestMemoryRetrievalReport ?? emptyMemoryRetrievalReport(0);
	}

	private _candidateForContextItem(
		item: MemoryRetrievalReport["contextItems"][number],
	): MemoryTierCandidate | undefined {
		const summary = item.summary?.trim();
		if (!summary) return undefined;
		const ref = item.primaryRef?.type === "memory" ? item.primaryRef.ref : undefined;
		const sourceLabel =
			ref?.providerId === "pi-file-store" && ref.kind === "user_preference"
				? "rule:user"
				: `memory:${ref?.providerId ?? item.source}`;
		const tier = ref?.kind === "user_preference" ? "standing" : "long_term";
		return {
			id: item.id,
			tier,
			sourceLabel,
			summary,
			score: item.retrievalScore ?? 0.5,
			...(item.stale !== undefined ? { stale: item.stale } : {}),
			...(item.conflict !== undefined ? { conflict: item.conflict } : {}),
			evidenceRefs: item.evidenceRefs,
		};
	}

	private _memoryCandidates(report: MemoryRetrievalReport): MemoryTierCandidate[] {
		return [
			...collectCurrentWorkMemory({ goalState: this.deps.getGoalState() }),
			...report.contextItems.flatMap((item) => {
				const candidate = this._candidateForContextItem(item);
				return candidate === undefined ? [] : [candidate];
			}),
		];
	}

	/**
	 * Bounded prompt-surfacing for local memory evidence (see context/memory-tier-composer.ts):
	 * default-on, but gated on TWO settings (`enabled` AND `includeInPrompt`) plus at least one
	 * current-work, standing, or retrieved memory candidate -- the first
	 * two are belt-and-suspenders on top of the fact that `runMemoryRetrieval` already
	 * leaves `contextItems` empty whenever `enabled` is false, regardless of
	 * `includeInPrompt`. Reuses the `report` this pass's `runMemoryRetrieval` call already
	 * computed -- never re-queries the provider here.
	 *
	 * Appends exactly one `custom`/"memory_evidence" message wrapped by `wrapUntrustedText`
	 * (the same fenced boundary + always-on system-prompt rule used for other untrusted content)
	 * to the END of `messages`. It is a host transient in the transient-record sense
	 * (agent-core transient-records.ts): string content keyed by its customType, so the request
	 * planner records it durably once and again only when the recall changes, never displayed,
	 * and its boundary id derives from the block's content so identical recall is byte-identical.
	 * Superseded records are packed by context GC. Before this, the message carried its text as a
	 * content array with a fresh random id per request: never a record, rebuilt at the tail of
	 * every request, so the previous request's last message changed on every request and the
	 * provider's prompt cache was re-prefilled from that point every time.
	 *
	 * Also records a `MemoryPromptInclusionReport` (context/memory-diagnostics.ts) at each
	 * branch below, for context_audit's diagnostic surface only -- this is pure bookkeeping
	 * alongside the existing branches, not a new branch/condition: the messages returned
	 * are unchanged by this recording.
	 */
	maybeAppendMemoryEvidenceBlock(messages: AgentMessage[], report: MemoryRetrievalReport): AgentMessage[] {
		if (!this._legacyMemoryEnabled()) return messages;
		try {
			const settings = this.deps.getSettingsManager().getMemoryRetrievalSettings();
			const candidates = this._memoryCandidates(report);
			const base = {
				enabled: settings.enabled,
				includeInPrompt: settings.includeInPrompt,
				selectedItemCount: candidates.length,
			};
			if (!settings.enabled) {
				this._latestMemoryPromptInclusionReport = {
					...base,
					status: "disabled",
					includedCount: 0,
					omittedCount: 0,
					blockChars: 0,
				};
				return messages;
			}
			if (!settings.includeInPrompt) {
				this._latestMemoryPromptInclusionReport = {
					...base,
					status: "include_disabled",
					includedCount: 0,
					omittedCount: 0,
					blockChars: 0,
				};
				return messages;
			}
			if (candidates.length === 0) {
				if (!this._lastLongTermQueryAttempted && this._latestMemoryPromptInclusionReport) {
					return messages;
				}
				this._latestMemoryPromptInclusionReport = {
					...base,
					status: "no_results",
					includedCount: 0,
					omittedCount: 0,
					blockChars: 0,
				};
				return messages;
			}

			const budget = this._memoryBudget(settings.maxResults);
			const block = composeTieredMemoryPromptBlock(candidates, budget);
			if (!block.text) {
				this._latestMemoryPromptInclusionReport = {
					...base,
					status: "empty_block",
					includedCount: block.includedCount,
					omittedCount: block.omittedCount,
					blockChars: 0,
				};
				return messages;
			}

			// The boundary id is a function of the content: unpredictable to whoever authored the
			// content (it would have to contain its own digest), and identical for identical recall.
			const boundaryId = createHash("sha256").update(block.text).digest("hex").slice(0, 32);
			const wrapped = wrapUntrustedText(block.text, "memory:tiered", { nonce: boundaryId });
			const evidenceMessage = createCustomMessage(
				"memory_evidence",
				wrapped,
				false,
				undefined,
				new Date().toISOString(),
			);
			this._latestMemoryPromptInclusionReport = {
				...base,
				status: "included",
				includedCount: block.includedCount,
				omittedCount: block.omittedCount,
				blockChars: wrapped.length,
				sourceLabel: "memory:tiered",
			};
			return [...messages, evidenceMessage];
		} catch {
			// `base` may not exist yet if the throw happened before it was computed (e.g.
			// settings access or `report.contextItems` itself threw), so this branch cannot
			// rely on it -- fall back to safe, fixed defaults rather than risk referencing
			// a partially-evaluated value.
			this._latestMemoryPromptInclusionReport = {
				enabled: false,
				includeInPrompt: false,
				selectedItemCount: 0,
				status: "failed",
				includedCount: 0,
				omittedCount: 0,
				blockChars: 0,
			};
			return messages;
		}
	}

	/** Read-only inspection of the latest memory-prompt-inclusion decision, for tests/debugging and context_audit. */
	getMemoryPromptInclusionReport(): MemoryPromptInclusionReport {
		return this._latestMemoryPromptInclusionReport ?? defaultMemoryPromptInclusionReport();
	}

	/** The plan's memory transients in pass order: the evidence block, then the persona record. */
	appendPromptMemory(messages: AgentMessage[], report: MemoryRetrievalReport): AgentMessage[] {
		return this.maybeAppendUserPersonaRecord(this.maybeAppendMemoryEvidenceBlock(messages, report));
	}

	/** Managed memory files against their managed revisions (operator recovery view). */
	async memoryDriftReport(): Promise<ManagedMemoryDriftEntry[]> {
		return (await this.getFileStoreWriter()?.driftReport()) ?? [];
	}

	/** Operator authority: adopt the on-disk memory file as the managed revision. */
	async memoryAcceptDrift(target: ManagedMemoryTarget): Promise<{ ok: boolean; message: string }> {
		const writer = this.getFileStoreWriter();
		if (!writer) return { ok: false, message: "Managed memory is not available in this session." };
		return writer.acceptDrift(target);
	}

	/** Operator authority: restore the last managed content of a memory file. */
	async memoryRestoreManaged(target: ManagedMemoryTarget): Promise<{ ok: boolean; message: string }> {
		const writer = this.getFileStoreWriter();
		if (!writer) return { ok: false, message: "Managed memory is not available in this session." };
		return writer.restoreManaged(target);
	}

	/**
	 * Fresh USER.md guidance for the NEXT provider request, as one `custom`/"user_persona" host
	 * transient. The static memory block is frozen for the whole session (prompt-cache stability),
	 * so a preference the owner adds, replaces or removes mid-session used to reach the model only
	 * at the next session. The file-store provider measures its current committed USER.md against
	 * what the installed block renders: when they differ, the record carries the current lines
	 * bounded to the memory prompt budget (or says the file is empty, so a removed preference cannot
	 * be resurrected by the static block). When they agree again, or memory is disabled or excluded
	 * from the prompt, the message is a cleared marker (`HOST_TRANSIENT_CLEARED_DETAILS`): the
	 * planner records its text once, only over an earlier persona record, through the same
	 * append-on-change index as the kernel's own kinds; nothing here scans history or reads disk.
	 * Content is deterministic per revision, so an unchanged snapshot is never re-sent. Child
	 * sessions, whose static block is empty as well, contribute nothing.
	 */
	maybeAppendUserPersonaRecord(messages: AgentMessage[]): AgentMessage[] {
		try {
			const writer = this.getFileStoreWriter();
			if (writer === undefined) return messages;
			const settings = this.deps.getSettingsManager().getMemoryRetrievalSettings();
			if (!settings.enabled || !settings.includeInPrompt) {
				return [
					...messages,
					this._personaMessage(
						"USER PERSONA: memory is disabled or excluded from the prompt in this session; earlier persona records are stale.",
						true,
					),
				];
			}
			const budget = this._memoryBudget(settings.maxResults);
			const projection = writer.userPersonaProjection(
				budget.enabled || budget.reason !== "missing_context_window" ? budget : undefined,
			);
			if (projection === undefined) return messages;
			if (!projection.changed) {
				return projection.content === undefined
					? messages
					: [...messages, this._personaMessage(projection.content, true)];
			}
			if (projection.content !== undefined) return [...messages, this._personaMessage(projection.content, false)];
			const overBudget = `USER PERSONA: USER.md changed (revision ${projection.revision}) beyond this model's memory budget; earlier persona records are stale. Read USER.md when preferences matter.`;
			return [...messages, this._personaMessage(overBudget, true)];
		} catch {
			return messages;
		}
	}

	/** A persona record (content) or cleared marker, with a content-derived timestamp so retries are byte-identical. */
	private _personaMessage(text: string, cleared: boolean): AgentMessage {
		const digest = createHash("sha256").update(text).digest();
		return createCustomMessage(
			USER_PERSONA_CUSTOM_TYPE,
			text,
			false,
			cleared ? HOST_TRANSIENT_CLEARED_DETAILS : undefined,
			new Date(digest.readUIntBE(0, 6)).toISOString(),
		);
	}

	/**
	 * Combines the already-stored, no-arg latest reports (never re-queries the provider or
	 * touches the OKF directory) into the safe, allow-list-projected shape context_audit
	 * exposes. See context/memory-diagnostics.ts for why this projection is allow-list
	 * based rather than a spread-then-delete of the raw report.
	 */
	getMemoryAuditDiagnostics(): {
		retrieval: MemoryRetrievalDiagnostics;
		promptInclusion: MemoryPromptInclusionReport;
	} {
		const settings = this.deps.getSettingsManager().getMemoryRetrievalSettings();
		return {
			retrieval: sanitizeMemoryRetrievalReportForDiagnostics(this.getMemoryRetrievalReport(), settings),
			promptInclusion: this.getMemoryPromptInclusionReport(),
		};
	}

	/**
	 * Zero-I/O gate for cross-session recall (R3): skip trivial turns (short acks, slash commands) so
	 * recall only runs when it could plausibly help. The provider's similarity cutoff is the real
	 * filter — this just avoids the index query on turns that obviously don't warrant it.
	 */
	shouldAttemptRecall(text: string): boolean {
		if (!this._legacyMemoryEnabled() || !this.deps.getSettingsManager().getMemoryRetrievalSettings().enabled)
			return false;
		const t = text.trim();
		if (t.length < 12 || t.startsWith("/")) return false;
		const words = t.split(/\s+/).filter((w) => w.length >= 3);
		// R4 adaptive gate: if recall has rarely been used lately (enough samples to trust the signal),
		// raise the bar so we only recall on clearly substantial turns — and relax it again once recall
		// starts paying off. Never fully disabled, so the loop can recover.
		const recallRarelyUseful =
			this._effectivenessTracker.sampleCount >= 5 && this._effectivenessTracker.usefulLately() < 0.15;
		return words.length >= (recallRarelyUseful ? 6 : 3);
	}

	/** Legacy recall prefetch with the same hard-off and explicit external-egress policy as context retrieval. */
	async prefetchRecall(query: string): Promise<string> {
		if (!this._legacyMemoryEnabled()) return "";
		const generation = this._memoryGeneration;
		const settings = this.deps.getSettingsManager().getMemoryRetrievalSettings();
		if (!settings.enabled) return "";
		const result = await this._memoryManager.prefetch(query, {
			externalEgressPolicy: settings.allowExternalEgress
				? ENABLED_EXTERNAL_MEMORY_EGRESS_POLICY
				: DEFAULT_EXTERNAL_MEMORY_EGRESS_POLICY,
		});
		return this._legacyMemoryEnabled() && generation === this._memoryGeneration ? result : "";
	}

	/** Fresh bounded OKF snapshot for reflection's confront-before-write pass. */
	getFreshOkfMemoryForReflection(): string {
		if (!this._legacyMemoryEnabled()) return "";
		try {
			const project = getDirectoryResourceProfileInfo(this.deps.getCwd(), this.deps.getAgentDir());
			const entries = loadOkfMemoryBundle({
				rootDir: this._memoryOkfDir(),
				projectId: project.hash,
				projectRoot: project.root,
				maxDocuments: 64,
			}).entries;
			const snapshot = entries
				.map(({ path, parsed }) => {
					const item = parsed.item;
					return item === undefined
						? ""
						: `[OKF ${path}] ${item.title ?? "Untitled"}: ${item.summary}\n${item.content ?? ""}`;
				})
				.filter((entry) => entry.length > 0)
				.join("\n\n")
				.slice(0, 12_000);
			return snapshot.length > 0 ? wrapUntrustedText(snapshot, "memory:reflection-okf") : "";
		} catch {
			return "";
		}
	}

	/**
	 * Applicable owner working preferences for a handoff (in-process worker or external team),
	 * headed by the persona projection rule; undefined when memory is off or excluded from the
	 * prompt, in a child session, or when nothing applies here. Behavioral guidance only: never a
	 * grant, never MEMORY.md, OKF or recall.
	 */
	getHandoffPersonaGuidance(): string | undefined {
		const settings = this.deps.getSettingsManager().getMemoryRetrievalSettings();
		if (!settings.enabled || !settings.includeInPrompt) return undefined;
		return this.getFileStoreWriter()?.getHandoffPersonaGuidance();
	}

	/**
	 * One immutable delegated-memory snapshot. Equivalent concurrent reads share the exact promise and
	 * object while completed reads are discarded, so a later call observes fresh external state.
	 */
	readMemorySnapshotForLane(query: string): Promise<LaneMemoryReadSnapshot> {
		const generation = this._memoryGeneration;
		const revision = this._memoryContentRevision;
		if (!this._legacyMemoryEnabled()) {
			return Promise.resolve(
				this._laneMemorySnapshot(
					generation,
					revision,
					"ICM: legacy memory is offline; use scoped native file reads.",
				),
			);
		}
		const settings = this.deps.getSettingsManager().getMemoryRetrievalSettings();
		if (!settings.enabled) {
			return Promise.resolve(
				this._laneMemorySnapshot(generation, revision, "Memory retrieval is disabled by policy."),
			);
		}
		const normalizedQuery = query.trim();
		const budget = this._memoryBudget(settings.maxResults);
		const maxResults = Math.min(3, settings.maxResults);
		const turnIndex = this.deps.getTurnIndex();
		const key = JSON.stringify([generation, revision, turnIndex, normalizedQuery, maxResults, budget]);
		const active = this._laneMemoryReads.get(key);
		if (active) return active;
		const loading = this._loadLaneMemorySnapshot({
			generation,
			revision,
			query: normalizedQuery,
			maxResults,
			turnIndex,
			budget,
			lifecycleTail: this._lifecycleTail,
		});
		this._laneMemoryReads.set(key, loading);
		void loading
			.finally(() => {
				if (this._laneMemoryReads.get(key) === loading) this._laneMemoryReads.delete(key);
			})
			.catch(() => {});
		return loading;
	}

	/**
	 * One delegated lane's read-only memory port. Its snapshot reads record which transcript sources the
	 * lane was actually shown (admission is per broker, so another lane's handles never carry over), and
	 * `readSource` opens only those, inside the memory generation that issued them.
	 */
	createLaneMemoryBroker(): WorkerMemoryBroker {
		const admitted = new Map<string, number>();
		const admit = (handle: string, generation: number): void => {
			admitted.delete(handle);
			admitted.set(handle, generation);
			if (admitted.size <= MAX_ADMITTED_LANE_SOURCES) return;
			const oldest = admitted.keys().next().value;
			if (oldest !== undefined) admitted.delete(oldest);
		};
		return {
			read: async (query) => {
				const snapshot = await this.readMemorySnapshotForLane(query);
				for (const handle of extractTranscriptSourceHandles(snapshot.content, this._projectId())) {
					admit(handle, snapshot.sourceGeneration);
				}
				return snapshot.content;
			},
			readSource: async (ref, cursor) => {
				const projectId = this._projectId();
				const parsed = parseTranscriptSourceHandle(ref, projectId);
				if (parsed === undefined) {
					throw new Error(
						"memory_source_invalid: ref is not a valid transcript source handle (expected tx:<session>:<entry>:<part>:<digest>).",
					);
				}
				const handle = formatTranscriptSourceHandle(parsed);
				const generation = admitted.get(handle);
				if (generation === undefined) {
					throw new Error(
						"memory_source_forbidden: this source was not cited to this worker by a memory_read result; run memory_read with a query that surfaces it.",
					);
				}
				if (generation !== this._memoryGeneration || !this._legacyMemoryEnabled()) {
					throw new LaneMemorySnapshotStaleError();
				}
				const outcome = await openTranscriptSource(this._currentTranscriptReader(generation), projectId, {
					ref: handle,
					cursor,
				});
				if (generation !== this._memoryGeneration) throw new LaneMemorySnapshotStaleError();
				if (!outcome.ok) throw new Error(`memory_source_${outcome.status}: ${outcome.reason}`);
				// A continuation of an admitted source is part of what the lane was shown.
				const nextPartHandle = outcome.details.nextPartHandle;
				if (typeof nextPartHandle === "string") admit(nextPartHandle, generation);
				return outcome.text;
			},
		};
	}

	/** The project identity transcript handles are scoped to; the same key the project memory files use. */
	private _projectId(): string {
		return getDirectoryResourceProfileInfo(this.deps.getCwd(), this.deps.getAgentDir()).hash;
	}

	/**
	 * The history reader for one memory generation. A replaced generation, offline legacy memory or an
	 * ICM session has none; disabled retrieval answers with a typed policy refusal instead of silence.
	 */
	private _currentTranscriptReader(generation: number): TranscriptSourceReader | undefined {
		if (generation !== this._memoryGeneration || !this._legacyMemoryEnabled()) return undefined;
		if (!this.deps.getSettingsManager().getMemoryRetrievalSettings().enabled) return POLICY_BLOCKED_HISTORY_READER;
		return this._transcriptRecall;
	}

	/** Drop the active generation's recall backend and its persistence subscription. */
	private _releaseTranscriptRecall(): void {
		this._unsubscribeEntriesPersisted?.();
		this._unsubscribeEntriesPersisted = undefined;
		this._transcriptRecall = undefined;
	}

	private async _loadLaneMemorySnapshot(input: {
		generation: number;
		revision: number;
		query: string;
		maxResults: number;
		turnIndex: number;
		budget: MemoryPromptBudget;
		lifecycleTail: Promise<void>;
	}): Promise<LaneMemoryReadSnapshot> {
		await input.lifecycleTail;
		if (
			!this._legacyMemoryEnabled() ||
			input.generation !== this._memoryGeneration ||
			input.revision !== this._memoryContentRevision
		) {
			throw new LaneMemorySnapshotStaleError();
		}
		const staticBlock = this._memoryManager
			.buildSystemPromptBlockFresh(input.budget)
			.replace(FILE_STORE_MEMORY_SYSTEM_NOTE, "[Read-only snapshot for a delegated worker.]");
		const [recalled, okfReport] = await Promise.all([
			this.prefetchRecall(input.query),
			retrieveMemoryForContext(
				[this._getMemoryOkfProvider()],
				{ query: input.query, maxResults: input.maxResults },
				{
					createdAtTurn: input.turnIndex,
					maxResults: input.maxResults,
					defaultLocalPolicy: DEFAULT_LOCAL_MEMORY_EGRESS_POLICY,
				},
			),
		]);
		if (
			!this._legacyMemoryEnabled() ||
			input.generation !== this._memoryGeneration ||
			input.revision !== this._memoryContentRevision
		) {
			throw new LaneMemorySnapshotStaleError();
		}
		const okf = okfReport.results
			.map(({ item }) => `[OKF ${item.title ?? item.id}] ${item.summary}\n${item.content ?? ""}`)
			.join("\n\n");
		const combined = [staticBlock, okf, recalled]
			.filter((part) => part.trim().length > 0)
			.join("\n\n")
			.slice(0, 8000);
		const content =
			combined.length > 0 ? wrapUntrustedText(combined, "worker-memory") : "No relevant standing memory was found.";
		return this._laneMemorySnapshot(input.generation, input.revision, content);
	}

	private _laneMemorySnapshot(
		sourceGeneration: number,
		sourceRevision: number,
		content: string,
	): LaneMemoryReadSnapshot {
		const snapshotId = createHash("sha256")
			.update(JSON.stringify([sourceGeneration, sourceRevision, content]))
			.digest("hex")
			.slice(0, 32);
		return Object.freeze({ snapshotId, sourceGeneration, sourceRevision, content });
	}

	/** Parent reflection's only structured-memory mutation port. Workers never receive this capability. */
	async applyStructuredReflectionWrite(
		write: StructuredReflectionWrite,
		signal?: AbortSignal,
	): Promise<StructuredReflectionApplyResult> {
		if (!this._legacyMemoryEnabled() || this.deps.isChildSession() || this._fileStoreWriter === undefined) {
			return { applied: false, created: false, error: "Structured memory writes are unavailable." };
		}
		return this._fileStoreWriter.applyStructuredReflectionWrite(write, signal);
	}

	/** Parent-owned inverse for an audited structured reflection write. */
	async rollbackStructuredReflectionWrite(
		rollback: StructuredReflectionRollback,
		signal?: AbortSignal,
	): Promise<boolean> {
		if (!this._legacyMemoryEnabled() || this.deps.isChildSession() || this._fileStoreWriter === undefined)
			return false;
		return this._fileStoreWriter.rollbackStructuredReflectionWrite(rollback, signal);
	}

	/** R4: score whether the agent actually used an injected recall page, so the recall gate can adapt. */
	recordRecallOutcome(recallText: string, queryText: string, responseText: string): void {
		this._effectivenessTracker.recordRecallOutcome(recallText, queryText, responseText);
	}

	/**
	 * (Re)build the memory subsystem: a fresh MemoryManager (reload-safe), register the bundled
	 * file-store + any extension-contributed providers, initialize, then surface the memory tools and
	 * the frozen system-prompt block. Best-effort: never throws into the session lifecycle.
	 */
	initialize(): Promise<void> {
		const generation = ++this._memoryGeneration;
		const system = this.deps.getSettingsManager().getMemorySystem?.() ?? "okf";
		const previousSystem = this._activeMemorySystem;
		const previous = this._memoryManager;
		const manager = new MemoryManager();
		this._memoryManager = manager;
		this._activeMemorySystem = undefined;
		this._fileStoreWriter = undefined;
		this._releaseTranscriptRecall();
		this._transitioning = true;
		this._initializationFailed = false;
		this._shutdownPromise = undefined;
		this._memoryOkfProvider = undefined;
		this._fileStoreMemoryProvider = undefined;
		this._localGraphProvider = undefined;
		this._localGraphResolved = false;
		this._latestMemoryRetrievalReport = undefined;
		this._latestMemoryPromptInclusionReport = undefined;
		this._lastLongTermQueryAttempted = false;
		// Managed notices are deduped per target and kind by the on-disk revision they describe and must
		// SURVIVE a reload: re-initializing the same memory system re-reads the same files, so clearing
		// here re-announced a drift the operator had already been told about (see _reportManagedNotices).
		// Only a real storage switch starts a new reporting history, because the previous system's
		// revisions say nothing about the files the new one manages.
		if (previousSystem !== undefined && previousSystem !== system) this._reportedManagedNotices.clear();
		// Reuse the write-side lifecycle queue: a switch drains prior writes before releasing providers.
		this._lifecycleTail = this._lifecycleTail
			.then(async () => {
				try {
					await previous.shutdownAll();
					if (generation !== this._memoryGeneration) return;
					let writer: FileStoreProvider | undefined;
					let transcriptRecall: TranscriptRecallProvider | undefined;
					if (system === "icm") {
						manager.registerProvider(new IcmProvider());
					} else {
						const admitUserPreference = this.deps.admitUserPreference;
						writer = new FileStoreProvider({
							onDurableMemoryChanged: () => {
								this._memoryContentRevision++;
								this._memoryOkfProvider = undefined;
							},
							...(admitUserPreference ? { admitUserPreference: (request) => admitUserPreference(request) } : {}),
							transcriptReader: () => this._currentTranscriptReader(generation),
							projectId: () => this._projectId(),
						});
						manager.registerProvider(writer);
						const recall = new TranscriptRecallProvider();
						transcriptRecall = recall;
						manager.registerProvider(recall);
						// Subscribed before initialization so no committed batch falls between the provider's
						// initial scan and the first event; a stale generation's batches never reach it.
						this._unsubscribeEntriesPersisted = this.deps.subscribeEntriesPersisted?.((event) => {
							if (generation === this._memoryGeneration) recall.notifyEntriesPersisted(event);
						});
						for (const provider of this._pendingMemoryProviders) {
							try {
								manager.registerProvider(provider);
							} catch {
								/* Keep valid providers on duplicate registrations. */
							}
						}
					}
					await manager.initializeAll(this.deps.getSessionId(), {
						agentDir: this.deps.getAgentDir(),
						cwd: this.deps.getCwd(),
						isChildSession: this.deps.isChildSession(),
					});
					const required = system === "icm" ? "icm" : "file-store";
					if (!manager.isProviderActive(required)) {
						const diagnostic = manager.getLifecycleDiagnostics().find((entry) => entry.provider === required);
						throw new Error(diagnostic?.message ?? `${required} provider did not activate`);
					}
					if (generation !== this._memoryGeneration) {
						await manager.shutdownAll();
						return;
					}
					this._activeMemorySystem = system;
					this._fileStoreWriter = writer;
					this._transcriptRecall = transcriptRecall;
					if (writer) this._reportManagedNotices(writer);
				} catch (error) {
					await manager.shutdownAll().catch(() => {});
					if (generation === this._memoryGeneration) {
						this._memoryManager = new MemoryManager();
						this._activeMemorySystem = undefined;
						this._fileStoreWriter = undefined;
						this._releaseTranscriptRecall();
						this._initializationFailed = true;
					}
					console.error("Memory subsystem init failed:", error instanceof Error ? error.message : String(error));
				} finally {
					if (generation === this._memoryGeneration) {
						this._transitioning = false;
						this.deps.refreshToolRegistry();
					}
				}
			})
			.catch((error) => {
				if (generation === this._memoryGeneration) {
					this._activeMemorySystem = undefined;
					this._initializationFailed = true;
				}
				console.error("Memory registry refresh failed:", error instanceof Error ? error.message : String(error));
			});
		return this._lifecycleTail;
	}

	/**
	 * Managed-file notices (a healed empty file, a drifted file whose writes are now refused) go to
	 * the operator through the session warning path once per active revision: a reload re-initializes
	 * the provider and would otherwise repeat the same fact, while a different on-disk revision of the
	 * same file is a new fact, including a return to an earlier revision (A, B, A reports A twice:
	 * the file changed again). The map holds one entry per target and kind, never a history. Child
	 * sessions render no memory and report nothing.
	 */
	private _reportManagedNotices(writer: FileStoreProvider): void {
		const notices = writer.drainManagedNotices();
		if (this.deps.isChildSession()) return;
		for (const notice of notices) {
			const key = `${notice.target}:${notice.kind}`;
			if (this._reportedManagedNotices.get(key) === notice.revision) continue;
			this._reportedManagedNotices.set(key, notice.revision);
			this.deps.emitWarning(notice.message);
		}
	}

	/** Register a memory provider contributed by an extension; applied on the next memory (re)init. */
	registerMemoryProvider(provider: MemoryProvider): void {
		if (!this._pendingMemoryProviders.some((p) => p.name === provider.name)) {
			this._pendingMemoryProviders.push(provider);
		}
	}

	/** Register a retrieval-style context memory provider contributed by an extension. */
	registerContextMemoryProvider(provider: ContextMemoryProvider): void {
		if (!this._pendingContextMemoryProviders.some((p) => p.id === provider.id)) {
			this._pendingContextMemoryProviders.push(provider);
		}
	}

	createReloadSnapshot(): MemoryControllerReloadSnapshot {
		return {
			pendingMemoryProviders: [...this._pendingMemoryProviders],
			pendingContextMemoryProviders: [...this._pendingContextMemoryProviders],
			memoryOkfProvider: this._memoryOkfProvider,
			fileStoreMemoryProvider: this._fileStoreMemoryProvider,
		};
	}

	restoreReloadSnapshot(snapshot: MemoryControllerReloadSnapshot): void {
		this._pendingMemoryProviders = [...snapshot.pendingMemoryProviders];
		this._pendingContextMemoryProviders = [...snapshot.pendingContextMemoryProviders];
		this._memoryOkfProvider = snapshot.memoryOkfProvider;
		this._fileStoreMemoryProvider = snapshot.fileStoreMemoryProvider;
	}

	/** Reload starts memory providers fresh; loaded extensions re-register before the next `initialize()`. */
	clearPendingProviders(): void {
		this._pendingMemoryProviders = [];
		this._pendingContextMemoryProviders = [];
		this._memoryOkfProvider = undefined;
		this._fileStoreMemoryProvider = undefined;
	}
}
