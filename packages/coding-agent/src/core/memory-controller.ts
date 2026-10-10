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
 * Request-planning boundary (deliberate): {@link runMemoryRetrieval} and {@link appendPromptMemory} are
 * invoked by the provider-request context controller (`ProviderRequestContextController.plan`) as
 * one-line delegations through the session's deps. This controller deliberately imports no
 * compaction/context-pipeline internals — it only ever reads settings and builds the retrieval report
 * + the bounded evidence block, and the plan it returns publishes nothing until the request plan is
 * accepted, so the request controller stays the single owner of the pass ordering and of commit.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type AgentMessage, createCustomMessage, HOST_TRANSIENT_CLEARED_DETAILS } from "../kernel/index.ts";
import type { SessionEntriesPersistedEvent } from "../kernel/session/session-manager.ts";
import { configFile, okfMemoryDir, projectMemoryDir } from "./agent-paths.ts";
import { estimateLineCount, estimateTokensFromText } from "./context/context-item.ts";
import { collectCurrentWorkMemory } from "./context/current-work-memory.ts";
import { createFileStoreMemoryProvider } from "./context/file-store-memory-provider.ts";
import { createLocalGraphMemoryProvider } from "./context/local-graph-memory-provider.ts";
import { shouldQueryLongTermMemory } from "./context/long-term-memory-trigger.ts";
import {
	defaultMemoryPromptInclusionReport,
	type MemoryPromptInclusionReport,
	type MemoryRetrievalDiagnostics,
	sanitizeMemoryRetrievalReportForDiagnostics,
	sanitizeTranscriptHistoryForDiagnostics,
	type TranscriptHierarchyStatus,
	type TranscriptHistoryStatus,
	type TranscriptMemoryDiagnostics,
} from "./context/memory-diagnostics.ts";
import {
	LANE_READ_MAX_ESTIMATED_TOKENS,
	type MemoryPromptBudget,
	memoryShareAllowanceBytes,
	memoryTextFitsBudget,
	reserveMemoryPromptBudget,
	resolveMemoryPromptBudget,
	shareOfMemoryPromptBudget,
} from "./context/memory-prompt-budget.ts";
import type { MemoryPromptPlan } from "./context/memory-prompt-plan.ts";
import {
	type MemoryProvider as ContextMemoryProvider,
	DEFAULT_EXTERNAL_MEMORY_EGRESS_POLICY,
	DEFAULT_LOCAL_MEMORY_EGRESS_POLICY,
	type MemorySearchResult,
} from "./context/memory-provider-contract.ts";
import { type MemoryRetrievalReport, retrieveMemoryForContext } from "./context/memory-retrieval.ts";
import {
	composeCharBoundedMemoryRecords,
	composeTieredMemoryPromptBlock,
	type MemoryTierCandidate,
} from "./context/memory-tier-composer.ts";
import { createOkfMemoryProvider, loadOkfMemoryBundle } from "./context/okf-memory-provider.ts";
import type { PromptHeadroom } from "./context/prompt-headroom.ts";
import {
	createTranscriptMemoryProvider,
	TRANSCRIPT_MEMORY_PROVIDER_ID,
	transcriptSummaryBody,
} from "./context/transcript-memory-provider.ts";
import type { ExtensionRunner } from "./extensions/index.ts";
import type { MemoryProvider } from "./extensions/types.ts";
import type { GoalState } from "./goals/goal-state.ts";
import type { ActiveBranchView } from "./memory/active-branch-probe.ts";
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
import { TRANSCRIPT_RECALL_MAX_ERROR_CHARS } from "./memory/providers/transcript-recall-worker-protocol.ts";
import {
	type FrontierBranchFence,
	type TranscriptFrontierState,
	TranscriptHierarchyHost,
	type TranscriptHierarchyHostDeps,
	type TranscriptHistorySettings,
} from "./memory/transcript-hierarchy-host.ts";
import {
	formatTranscriptSourceHandle,
	MEMORY_RETRIEVAL_DISABLED_REASON,
	parseTranscriptNodeHandle,
	parseTranscriptSourceHandle,
	TRANSCRIPT_FOREGROUND_READ_MS,
	TRANSCRIPT_FRONTIER_CUSTOM_TYPE,
	type TranscriptSourceReader,
	utf8ByteLength,
} from "./memory/transcript-memory-contracts.ts";
import {
	describeSummaryReference,
	expandTranscriptNode,
	extractTranscriptNodeHandles,
	extractTranscriptSourceHandles,
	openTranscriptSource,
	reasonSentence,
	TRANSCRIPT_SOURCE_PAGE_BYTES,
	type TranscriptNodeExpander,
	type TranscriptSummaryLookup,
	type TranscriptSummaryReference,
} from "./memory/transcript-source-tools.ts";
import type {
	UserPreferenceAdmissionRequest,
	UserPreferenceAdmissionResult,
} from "./memory/user-preference-metadata.ts";
import type {
	LaneMemoryCapacity,
	LaneMemoryCapacitySource,
	WorkerMemoryBroker,
	WorkerMemorySourceAnswer,
} from "./memory/worker-memory-tools.ts";
import { wrapUntrustedText } from "./security/untrusted-boundary.ts";
import { getDirectoryResourceProfileInfo, isValidMemorySystem } from "./settings/settings-rules.ts";
import type { MemorySystem, SettingsError, SettingsScope } from "./settings/settings-schema.ts";
import { boundedTextPreview } from "./text-preview.ts";

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
	/** Opt-in summary hierarchy settings. Absent in narrow hosts: the hierarchy is then off. */
	getMemoryHistorySettings?(): TranscriptHistorySettings;
	/** Effective-settings change event; the hierarchy restarts when a setting that shapes it changed. */
	subscribeChanges?(listener: () => void): () => void;
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

const HISTORY_FRONTIER_CLEARED_TEXT =
	"HISTORY FRONTIER: none. Earlier history frontier records are stale (the summary hierarchy is off, has nothing for this session yet, does not fit this model's budget, or the conversation has not been compacted); search memory history when earlier conversation matters.";
const HISTORY_FRONTIER_WRAPPER_BYTES = utf8ByteLength(
	wrapUntrustedText("", "memory:history-frontier", { nonce: "0".repeat(32) }),
);
/** Lines the untrusted wrapper adds around a non-empty frontier text. */
const HISTORY_FRONTIER_WRAPPER_LINES =
	estimateLineCount(wrapUntrustedText("x", "memory:history-frontier", { nonce: "0".repeat(32) })) - 1;
/** Share of the one memory allowance the root frontier may take (bytes, tokens and lines). */
const HISTORY_FRONTIER_BUDGET_SHARE = 0.5;

/** Durable record kind carrying the tiered memory evidence block (and its cleared form). */
export const MEMORY_EVIDENCE_CUSTOM_TYPE = "memory_evidence";
const MEMORY_EVIDENCE_CLEARED_TEXT =
	"MEMORY EVIDENCE: none. Earlier memory evidence records are stale (no current evidence, or it is disabled or outside this model's budget); search memory again when evidence matters.";

/** What one composition of the memory evidence record produced, before anything is published. */
interface ComposedMemoryEvidence {
	/** The evidence record or its cleared form; empty when this pass has nothing to say. */
	records: AgentMessage[];
	/** The inclusion decision to publish; absent leaves the standing one. */
	inclusion?: MemoryPromptInclusionReport;
	/** Transcript items admitted into the block; present only for a pass that queried history. */
	transcriptAdmittedCount?: number;
	admittedRecall?: { text: string; query: string };
}

/** What the history frontier took out of the one memory allowance, so the evidence block fits the rest. */
interface FrontierReserve {
	bytes: number;
	estimatedTokens: number;
	lines: number;
}

const NO_FRONTIER_RESERVE: FrontierReserve = { bytes: 0, estimatedTokens: 0, lines: 0 };

/** Same host records: kind, content and cleared form, ignoring timestamps. */
function sameHostRecords(left: readonly AgentMessage[], right: readonly AgentMessage[]): boolean {
	if (left.length !== right.length) return false;
	return left.every((message, index) => {
		const other = right[index];
		return (
			message.role === "custom" &&
			other?.role === "custom" &&
			message.customType === other.customType &&
			isDeepStrictEqual(message.content, other.content) &&
			isDeepStrictEqual(message.details, other.details)
		);
	});
}

/** Identity of the user turn the latest user message opens; "" when the transcript has no user message. */
function latestUserTurnKey(messages: AgentMessage[], text: string): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "user") continue;
		return `${message.timestamp}:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
	}
	return "";
}

/** What the user-turn request retrieved, kept so later requests of the same turn present the same evidence. */
interface TurnRetrieval {
	turnKey: string;
	generation: number;
	/** Memory content revision the report was retrieved at. */
	revision: number;
	/** The retrieval policy (see `_retrievalPolicyKey`) the report was retrieved under. */
	policy: string;
	queriedLongTerm: boolean;
	queriedTranscript: boolean;
	report: MemoryRetrievalReport;
}

/** The tier-composer source label of a transcript candidate (`memory:<providerId>`). */
const TRANSCRIPT_SOURCE_LABEL = `memory:${TRANSCRIPT_MEMORY_PROVIDER_ID}`;

/**
 * Why a delegated lane's conversation history could not be searched, or "" when it could (including with no
 * hit). A failure is stated, never rendered as an empty page; hits themselves are admitted as whole records.
 */
function laneHistoryStatus(report: MemoryRetrievalReport): string {
	const providerReport = report.providerReports.find((entry) => entry.providerId === TRANSCRIPT_MEMORY_PROVIDER_ID);
	// The provider's own wording, bounded to the cap every other recall diagnostic reason carries.
	const bounded = (text: string) => boundedTextPreview(text, TRANSCRIPT_RECALL_MAX_ERROR_CHARS);
	if (providerReport?.status === "failed") {
		return `Conversation history was not searched (${bounded(providerReport.error ?? "unknown failure")}).`;
	}
	if (providerReport?.status === "blocked") {
		return `Conversation history was not searched (blocked: ${bounded(providerReport.rejectionReasons.join(", "))}).`;
	}
	return "";
}

/** The stated reason a delegated lane's memory read attached nothing, from the budget owner's own reason code. */
function laneConstraintText(reason: string | undefined, capacityKnown: boolean): string {
	const detail =
		!capacityKnown || reason === "missing_context_window"
			? "this worker's request capacity is unknown (it has sent no request yet, or its model declares no context window)"
			: reason === "no_token_allowance"
				? "this worker has no token allowance left"
				: reason === "no_context_headroom"
					? "this worker's request has no room left in its context window"
					: reason === "memory_block_cannot_fit_minimum_line"
						? "the room this worker has left cannot hold one memory line"
						: `the memory budget is disabled (${reason ?? "unspecified"})`;
	return `Memory is constrained: ${detail}, so no memory was attached. Read project files directly, or call memory_read again when the worker has more room.`;
}

/** What one whole record takes out of a lane's allowance: its text, the blank line that joins it, and its lines. */
function laneRecordReserve(text: string): { bytes: number; estimatedTokens: number; lines: number } {
	return {
		bytes: utf8ByteLength(text) + utf8ByteLength(LANE_RECORD_SEPARATOR),
		estimatedTokens: estimateTokensFromText(text),
		lines: estimateLineCount(text) + 1,
	};
}

function laneOmissionNote(parts: readonly string[]): string {
	return `[Not attached, over this worker's remaining context room: ${parts.join("; ")}. Call memory_read again with a narrower query.]`;
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
const MAX_REFLECTION_OKF_CHARS = 12_000;
/** Share of a delegated lane's memory allowance standing memory may take; the query-relevant records get the rest. */
const LANE_STANDING_BUDGET_SHARE = 0.5;
/** Share of what remains after standing memory that the history frontier may take. */
const LANE_FRONTIER_BUDGET_SHARE = 0.5;
const LANE_FRONTIER_HEADING =
	"History frontier (summaries of earlier conversation; pass a txn: handle as ref to expand one):";
const LANE_HANDLE_HINT =
	"Pass a bracketed handle back as ref: a tx: handle opens that source's exact text, a txn: handle expands that summary one level.";
const LANE_STANDING_NOTE = "[Read-only snapshot for a delegated worker.]";
const LANE_WRAPPER = wrapUntrustedText("", "worker-memory", { nonce: "0".repeat(32) });
const LANE_RECORD_SEPARATOR = "\n\n";
const LANE_NO_MEMORY_TEXT = "No relevant standing memory was found.";
const LANE_NO_HISTORY_TEXT = "No matching conversation history was found.";
const LANE_MEMORY_UNAVAILABLE_TEXT =
	"Memory is not available in this session (a child session, or memory failed to initialize or has shut down). Read project files directly.";
/**
 * A worker source read's refusal: the typed `memory_source_<status>` token unchanged, the reason rendered by the
 * one history refusal renderer, so a worker refusal reads like the root's.
 */
function laneSourceRefusal(status: string, reason: string): WorkerMemorySourceAnswer {
	return { ok: false, status, text: `memory_source_${status}: ${reasonSentence(reason)}` };
}

/** The tier-composer source label of an approved summary covering a lane's history hits. */
const LANE_SUMMARY_SOURCE_LABEL = "memory:history-summary";
/** Transcript sources one delegated lane may hold open at a time; the oldest admission is dropped first. */
const MAX_ADMITTED_LANE_SOURCES = 512;
/** The smallest source page worth delivering to a lane; below it the lane is told it has no room instead. */
const LANE_MIN_SOURCE_PAGE_BYTES = 256;
const LANE_SOURCE_OVER_ROOM_TEXT =
	"[Not attached: even a minimal page of this source does not fit this worker's remaining context room. Call memory_read with this ref again when the worker has more room.]";
const LANE_EXPANSION_OVER_ROOM_TEXT =
	"[Not attached: this summary's expansion does not fit this worker's remaining context room. Call memory_read with this ref again when the worker has more room.]";

/**
 * History reads, zooms and summary lookups under disabled memory retrieval: a typed policy refusal, never an
 * empty success, and the history backend is never touched (no demand start, no read, no egress).
 */
const POLICY_BLOCKED_HISTORY_READER: TranscriptSourceReader = {
	search: async () => ({ status: "forbidden", reason: MEMORY_RETRIEVAL_DISABLED_REASON }),
	readSource: async () => ({ status: "forbidden", reason: MEMORY_RETRIEVAL_DISABLED_REASON }),
	coverage: () => undefined,
};
const POLICY_BLOCKED_HISTORY_EXPANDER: TranscriptNodeExpander = {
	expand: async () => ({ status: "forbidden", reason: MEMORY_RETRIEVAL_DISABLED_REASON }),
};
const POLICY_BLOCKED_SUMMARY_LOOKUP: TranscriptSummaryLookup = {
	summariesFor: async () => ({ status: "forbidden", reason: MEMORY_RETRIEVAL_DISABLED_REASON }),
};

/**
 * One approved summary covering a lane's history hits, as a whole record: the full approved text, or, when that
 * cannot fit the lane's room, its handle and coverage alone (still expandable). Ranked with the best hit it covers.
 */
function laneSummaryCandidate(
	summary: TranscriptSummaryReference,
	hitScores: ReadonlyMap<string, number>,
): MemoryTierCandidate {
	// The root's own heading for the record, so a root read and a worker read report it the same way.
	const heading = describeSummaryReference(summary);
	return {
		id: summary.handle,
		tier: "evidence_pointer",
		sourceLabel: LANE_SUMMARY_SOURCE_LABEL,
		summary: `${heading}\n${summary.text}`,
		pointerSummary: `${heading} (summary text omitted: over this worker's remaining room; pass the handle as ref to expand it)`,
		score: Math.max(0, ...summary.covers.map((handle) => hitScores.get(handle) ?? 0)),
	};
}

/** The pre-compression handoff: each provider's insight is a whole record; one that does not fit is left out and counted. */
function boundPreCompressMemory(insights: readonly string[]): string {
	const candidates = insights.flatMap((insight, index): MemoryTierCandidate[] => {
		const text = insight.trim();
		if (text.length === 0) return [];
		const firstLine = text.split("\n", 1)[0] ?? text;
		return [
			{
				id: String(index).padStart(4, "0"),
				tier: "long_term",
				sourceLabel: "memory:pre-compress",
				summary: text,
				pointerSummary: `${firstLine} (rest omitted: over the handoff bound)`,
			},
		];
	});
	return composeCharBoundedMemoryRecords(candidates, MAX_PRE_COMPRESS_MEMORY_CHARS).text;
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
	/**
	 * This session's own transcript file, which may live outside the default session directories; the history
	 * index registers it so a first explicit read sees its committed history. Absent in narrow hosts.
	 */
	getSessionFile?(): string | undefined;
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
	/**
	 * Headroom of the request the memory block will join (prompt already carried, reply reserve) for these
	 * messages. Absent in narrow hosts: the budget is then bounded by the context window alone.
	 */
	getPromptHeadroom?(messages: readonly AgentMessage[]): PromptHeadroom | undefined;
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
	/**
	 * What the summary hierarchy needs from the session: the model registry, the isolated-completion
	 * boundary, the usage ledger and the foreground activity signal. Absent in narrow hosts: no hierarchy.
	 */
	hierarchy?: Pick<
		TranscriptHierarchyHostDeps,
		"summarizer" | "isForegroundBusy" | "subscribeForegroundActivity" | "getAdmissionEngine"
	> & {
		/** The live branch position, so the frontier only ever describes the active ancestry. */
		activeBranch: ActiveBranchView;
	};
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
		super(
			`memory_snapshot_stale: ${reasonSentence("memory changed while the delegated read was in flight; retry the read")}`,
		);
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
	/** True only when this pass actually admitted long-term providers or the transcript history provider. */
	private _lastLongTermQueryAttempted = false;
	/**
	 * Transcript evidence the latest prompt memory block actually admitted, for recall-effectiveness
	 * scoring. Written by the block composer, consumed (and cleared) once per submitted turn.
	 */
	private _admittedRecall: { text: string; query: string } | undefined;
	/** The latest user turn's retrieval, reused by the turn's later requests (see `runMemoryRetrieval`). */
	private _turnRetrieval: TurnRetrieval | undefined;
	/** The retrieval policy each report was produced under, so a plan built from it can tell it went stale. */
	private readonly _reportPolicy = new WeakMap<MemoryRetrievalReport, string>();
	/** Transcript items the latest query pass admitted into the prompt block (diagnostics). */
	private _latestTranscriptAdmittedCount = 0;
	/** Plug-and-play memory subsystem. Recreated on each (re)initialize so reload is safe. */
	private _memoryManager: MemoryManager = new MemoryManager();
	/** Active generation's single durable file/OKF writer, also used by parent-owned reflection. */
	private _fileStoreWriter: FileStoreProvider | undefined;
	/** Active generation's transcript recall provider: the one backend for history search and source reads. */
	private _transcriptRecall: TranscriptRecallProvider | undefined;
	private _unsubscribeEntriesPersisted: (() => void) | undefined;
	/** Summary hierarchy host, attached to the root history backend in either memory system; absent in narrow hosts. */
	private readonly _hierarchy: TranscriptHierarchyHost | undefined;
	private readonly _activeBranch: ActiveBranchView | undefined;
	private _unsubscribeSettingsChanges: (() => void) | undefined;
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
		const hierarchy = deps.hierarchy;
		this._activeBranch = hierarchy?.activeBranch;
		if (hierarchy) {
			const { activeBranch: _activeBranch, ...hostDeps } = hierarchy;
			this._hierarchy = new TranscriptHierarchyHost({
				...hostDeps,
				getAgentDir: () => deps.getAgentDir(),
				getSessionId: () => deps.getSessionId(),
				projectId: () => this._projectId(),
				isChildSession: () => deps.isChildSession(),
				getHistorySettings: () => this._historySettings(),
				isRetrievalEnabled: () => deps.getSettingsManager().getMemoryRetrievalSettings().enabled,
				emitWarning: (message) => deps.emitWarning(message),
			});
			// Settings that shape the coordinator are applied on the change event, never by polling.
			this._unsubscribeSettingsChanges = deps.getSettingsManager().subscribeChanges?.(() => {
				void this._hierarchy?.settingsChanged();
			});
		}
	}

	private _historySettings(): TranscriptHistorySettings {
		return (
			this.deps.getSettingsManager().getMemoryHistorySettings?.() ?? {
				hierarchy: false,
				summaryModel: undefined,
				allowExternalSummaryEgress: false,
				allowExternalAdmissionEgress: false,
				maxConcurrentSummaries: 1,
				frontierMaxBytes: 0,
				retentionDays: undefined,
			}
		);
	}

	/** Forget one session's derived history summaries; the canonical session is untouched. */
	async forgetHistorySession(sessionId: string): Promise<{ ok: boolean; message: string }> {
		if (!this._hierarchy) {
			return {
				ok: false,
				message: "The summary hierarchy is not available in this session; nothing was forgotten.",
			};
		}
		const outcome = await this._hierarchy.forgetSession(sessionId);
		return outcome.status === "forgotten"
			? {
					ok: true,
					message: `Forgot the derived history summaries of session ${sessionId}; its transcript is untouched and it will not be summarized again.`,
				}
			: // The refusal's own reason, unchanged: it may say nothing was forgotten, or that a later step was refused.
				{
					ok: false,
					message: `Forgetting session ${sessionId} did not complete: ${reasonSentence(outcome.reason)}`,
				};
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
	createContextProjection(getRunner: () => ExtensionRunner) {
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
		const icm = this.deps.getSettingsManager().getMemorySystem() === "icm";
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
					MEMORY_EVIDENCE_CUSTOM_TYPE,
					TRANSCRIPT_FRONTIER_CUSTOM_TYPE,
					"user_persona",
					"reflection_cue",
					"reflection_turn_trigger",
				].includes(message.customType)
			);
		});
	}

	/**
	 * OKF's own pathways: the file-store writer, reflection writes, persona, extension prefetch and pending
	 * providers, automatic retrieval, prompt projection (evidence, frontier, persona), pre-compress and turn sync.
	 * History reads are not among them (see {@link _historyAvailable}).
	 */
	private _legacyMemoryEnabled(): boolean {
		return (
			!this._transitioning &&
			!this._initializationFailed &&
			this._activeMemorySystem !== "icm" &&
			this.deps.getSettingsManager().getMemorySystem() !== "icm"
		);
	}

	/**
	 * Whether `generation` serves history reads, in either memory system: it is the current, settled generation
	 * of an active memory system in a root session. A child session keeps no history index; its workers read
	 * through the parent's broker. Retrieval policy is applied by each reader, zoom and lookup.
	 */
	private _historyAvailable(generation: number): boolean {
		return (
			generation === this._memoryGeneration &&
			!this._transitioning &&
			!this._initializationFailed &&
			this._activeMemorySystem !== undefined &&
			!this.deps.isChildSession()
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
			// The coordinator stops, and persists its terminal record, before the reader it uses is released.
			const hierarchyStopped = this._hierarchy?.detach();
			this._unsubscribeSettingsChanges?.();
			this._unsubscribeSettingsChanges = undefined;
			this._releaseTranscriptRecall();
			this._activeMemorySystem = undefined;
			this._transitioning = true;
			await hierarchyStopped;
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

	/** The history backend as a retrieval provider, bound to one memory generation. */
	private _getTranscriptMemoryProvider(
		generation: number,
		includeCurrentSession = false,
		deadlineAt?: number,
	): ContextMemoryProvider {
		return createTranscriptMemoryProvider(
			() => this._currentTranscriptReader(generation),
			() => this._projectId(),
			includeCurrentSession,
			deadlineAt,
		);
	}

	private _memoryBudget(configuredMaxResults: number, headroom?: PromptHeadroom) {
		return resolveMemoryPromptBudget({
			contextWindow: this.deps.getContextWindow(),
			configuredMaxResults,
			...(headroom ?? {}),
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
		let queriedTranscript = false;
		let policy: string | undefined;
		try {
			const settings = this.deps.getSettingsManager().getMemoryRetrievalSettings();
			policy = this._retrievalPolicyKey();
			if (!settings.enabled) {
				this._lastLongTermQueryAttempted = false;
				const report = emptyMemoryRetrievalReport(settings.maxResults);
				this._reportPolicy.set(report, policy);
				this._latestMemoryRetrievalReport = report;
				return report;
			}
			const query = latestUserMessageText(messages);
			const userTurn = lastMessageIsUserTurn(messages);
			const turnKey = latestUserTurnKey(messages, query);
			// Later requests of a turn (tool loops) are not user-turn requests, so they query no
			// long-term or history provider. They present the turn's own evidence instead: reused as is
			// while memory and the retrieval policy are unchanged, retrieved again with the turn's decisions
			// when either changed. A new user turn decides and queries afresh.
			const turn = this._turnRetrieval;
			const carried =
				!userTurn && turnKey !== "" && turn?.turnKey === turnKey && turn.generation === generation
					? turn
					: undefined;
			if (carried && carried.revision === this._memoryContentRevision && carried.policy === policy) {
				queriedLongTerm = carried.queriedLongTerm;
				queriedTranscript = carried.queriedTranscript;
				this._lastLongTermQueryAttempted = queriedLongTerm || queriedTranscript;
				return carried.report;
			}
			const revision = this._memoryContentRevision;
			const budget = this._memoryBudget(settings.maxResults, this.deps.getPromptHeadroom?.(messages));
			const currentWork = collectCurrentWorkMemory({ goalState: this.deps.getGoalState() });
			const longTermDecision = shouldQueryLongTermMemory({
				latestUserText: query,
				goalState: this.deps.getGoalState(),
				budget,
				currentWorkCandidateCount: currentWork.length,
			});
			queriedLongTerm = carried ? carried.queriedLongTerm : longTermDecision.shouldQuery && userTurn;
			// Past-session history keeps its own recall gate (substantial turn, adaptive to how useful
			// recall has been) alongside the long-term trigger: either one asks the history provider.
			queriedTranscript = carried
				? carried.queriedTranscript
				: userTurn && this._historyAvailable(generation) && (queriedLongTerm || this.shouldAttemptRecall(query));
			this._lastLongTermQueryAttempted = queriedLongTerm || queriedTranscript;
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
			if (queriedTranscript) providers.push(this._getTranscriptMemoryProvider(generation));
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
				queriedTranscript ||
				this._latestMemoryRetrievalReport === undefined ||
				(queryFileStore && report.contextItems.length > 0)
			) {
				this._latestMemoryRetrievalReport = report;
			}
			this._reportPolicy.set(report, policy);
			if (turnKey !== "" && (userTurn || carried)) {
				this._turnRetrieval = {
					turnKey,
					generation,
					revision,
					policy,
					queriedLongTerm,
					queriedTranscript,
					report,
				};
			}
			return report;
		} catch {
			if (!this._legacyMemoryEnabled() || generation !== this._memoryGeneration)
				return emptyMemoryRetrievalReport(0);
			this._lastLongTermQueryAttempted = queriedLongTerm || queriedTranscript;
			const report = emptyMemoryRetrievalReport(0);
			// A failed retrieval is still a report produced under the policy in force: a plan built on it goes stale with it.
			if (policy !== undefined) this._reportPolicy.set(report, policy);
			if (queriedLongTerm || queriedTranscript || this._latestMemoryRetrievalReport === undefined) {
				this._latestMemoryRetrievalReport = report;
			}
			return report;
		}
	}

	/** Read-only inspection of the latest memory-retrieval report, for tests/debugging. */
	getMemoryRetrievalReport(): MemoryRetrievalReport {
		return this._latestMemoryRetrievalReport ?? emptyMemoryRetrievalReport(0);
	}

	/**
	 * Everything besides the memory content revision that decides what a retrieval may return: the retrieval
	 * settings and the providers extensions contributed. A report or plan produced under another policy is
	 * not current, whatever the content revision says.
	 */
	private _retrievalPolicyKey(): string {
		const settings = this.deps.getSettingsManager().getMemoryRetrievalSettings();
		return JSON.stringify([
			settings.enabled,
			settings.maxResults,
			settings.includeInPrompt,
			settings.allowExternalEgress,
			this._pendingContextMemoryProviders.map((provider) => [provider.id, provider.capabilities.localOnly]),
		]);
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
		// Past conversations are untrusted episodic evidence: they take only the budget curated memory
		// leaves, whatever their word overlap with the query. Tradeoff, chosen deliberately: a block
		// already full of curated lines admits no history, so recall of old conversation yields to
		// current standing, work and long-term memory; `context_audit` shows when that happens (history
		// retrieved, none admitted into the prompt block).
		const tier =
			ref?.kind === "user_preference"
				? "standing"
				: ref?.providerId === TRANSCRIPT_MEMORY_PROVIDER_ID
					? "evidence_pointer"
					: "long_term";
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
	 * current-work, standing, or retrieved memory candidate. Reuses the `report` this pass's
	 * `runMemoryRetrieval` call already computed -- never re-queries a provider here.
	 *
	 * Composes exactly one `custom`/"memory_evidence" record wrapped by `wrapUntrustedText` (the same
	 * fenced boundary + always-on system-prompt rule used for other untrusted content). It is a host
	 * transient in the transient-record sense (kernel transient-records.ts): string content keyed by its
	 * customType, so the request planner records it durably once and again only when the recall changes,
	 * never displayed; its boundary id and timestamp derive from the block's content so identical recall
	 * is byte-identical. Superseded records are packed by context GC.
	 *
	 * When the block is disabled, excluded from the prompt, found nothing on a pass that queried, or fits
	 * no candidate into the budget, the record is the cleared form (`HOST_TRANSIENT_CLEARED_DETAILS`): the
	 * planner appends it once, only over an earlier evidence record, so a stale block is never left
	 * looking current. A pass that queried nothing and has no candidates says nothing: the earlier block
	 * remains the latest evidence there is.
	 *
	 * Composing is pure: it reads memory state and returns the records plus the diagnostics to publish.
	 * `appendPromptMemory` publishes them only when the surrounding provider plan commits.
	 *
	 * @param queryPass whether the pass that produced `report` queried long-term or history providers
	 * @param hasInclusionReport whether an earlier inclusion decision exists to leave standing
	 */
	private _composeMemoryEvidence(
		report: MemoryRetrievalReport,
		headroom: PromptHeadroom | undefined,
		queryPass: boolean,
		hasInclusionReport: boolean,
		reserved: FrontierReserve,
	): ComposedMemoryEvidence {
		try {
			const settings = this.deps.getSettingsManager().getMemoryRetrievalSettings();
			const candidates = this._memoryCandidates(report);
			const base = {
				enabled: settings.enabled,
				includeInPrompt: settings.includeInPrompt,
				selectedItemCount: candidates.length,
			};
			const cleared = (
				status: MemoryPromptInclusionReport["status"],
				counts: { includedCount: number; omittedCount: number } = { includedCount: 0, omittedCount: 0 },
			): ComposedMemoryEvidence => ({
				records: [this._hostTransient(MEMORY_EVIDENCE_CUSTOM_TYPE, MEMORY_EVIDENCE_CLEARED_TEXT, true)],
				inclusion: { ...base, status, ...counts, blockChars: 0 },
				...(queryPass ? { transcriptAdmittedCount: 0 } : {}),
			});
			if (!settings.enabled) return cleared("disabled");
			if (!settings.includeInPrompt) return cleared("include_disabled");
			if (candidates.length === 0) {
				if (!queryPass && hasInclusionReport) return { records: [] };
				return cleared("no_results");
			}

			const budget = reserveMemoryPromptBudget(this._memoryBudget(settings.maxResults, headroom), reserved);
			const block = composeTieredMemoryPromptBlock(candidates, budget);
			if (!block.text) {
				return cleared("empty_block", { includedCount: block.includedCount, omittedCount: block.omittedCount });
			}

			// The boundary id is a function of the content: unpredictable to whoever authored the
			// content (it would have to contain its own digest), and identical for identical recall.
			const boundaryId = createHash("sha256").update(block.text).digest("hex").slice(0, 32);
			const wrapped = wrapUntrustedText(block.text, "memory:tiered", { nonce: boundaryId });
			const admitted = this._admittedTranscript(candidates, block.includedIds, report.request.query);
			return {
				records: [this._hostTransient(MEMORY_EVIDENCE_CUSTOM_TYPE, wrapped, false)],
				inclusion: {
					...base,
					status: "included",
					includedCount: block.includedCount,
					omittedCount: block.omittedCount,
					blockChars: wrapped.length,
					sourceLabel: "memory:tiered",
				},
				...(queryPass ? { transcriptAdmittedCount: admitted.count } : {}),
				...(admitted.recall ? { admittedRecall: admitted.recall } : {}),
			};
		} catch {
			// Settings access or the report itself threw before the counts existed: safe fixed defaults,
			// and no record, so a failure never clears or replaces evidence already on record.
			return {
				records: [],
				inclusion: {
					enabled: false,
					includeInPrompt: false,
					selectedItemCount: 0,
					status: "failed",
					includedCount: 0,
					omittedCount: 0,
					blockChars: 0,
				},
			};
		}
	}

	/**
	 * Which transcript items a composed block admitted. Only a pass that queried history reports a
	 * count; the recall text is the snippet bodies, without their handles, for effectiveness scoring.
	 */
	private _admittedTranscript(
		candidates: readonly MemoryTierCandidate[],
		includedIds: readonly string[],
		query: string,
	): { count: number; recall?: { text: string; query: string } } {
		const included = new Set(includedIds);
		const bodies = candidates
			.filter((candidate) => included.has(candidate.id) && candidate.sourceLabel === TRANSCRIPT_SOURCE_LABEL)
			.map((candidate) => transcriptSummaryBody(candidate.summary));
		return bodies.length > 0 ? { count: bodies.length, recall: { text: bodies.join("\n"), query } } : { count: 0 };
	}

	/** Publish a committed plan's diagnostics and admitted-recall record. */
	private _publishMemoryEvidence(composed: ComposedMemoryEvidence): void {
		if (composed.inclusion) this._latestMemoryPromptInclusionReport = composed.inclusion;
		if (composed.transcriptAdmittedCount !== undefined) {
			this._latestTranscriptAdmittedCount = composed.transcriptAdmittedCount;
		}
		if (composed.admittedRecall) this._admittedRecall = composed.admittedRecall;
	}

	/** Forget any admitted-recall record; called when a turn starts so an aborted turn cannot leak into the next. */
	clearAdmittedRecall(): void {
		this._admittedRecall = undefined;
	}

	/** The transcript evidence the prompt block admitted for this turn, once; undefined when none was. */
	takeAdmittedRecall(): { text: string; query: string } | undefined {
		const admitted = this._admittedRecall;
		this._admittedRecall = undefined;
		return admitted;
	}

	/** Read-only inspection of the latest memory-prompt-inclusion decision, for tests/debugging and context_audit. */
	getMemoryPromptInclusionReport(): MemoryPromptInclusionReport {
		return this._latestMemoryPromptInclusionReport ?? defaultMemoryPromptInclusionReport();
	}

	/**
	 * The plan's memory records in pass order: the evidence block (or its cleared form), then the persona
	 * record. Nothing is published while planning. The returned plan is current only while the memory
	 * generation, the content revision and the records composed from the same report under the same
	 * headroom are unchanged, so a request planned against a different memory state is planned again;
	 * `commit` publishes the inclusion report and the admitted-recall record once the plan is accepted.
	 */
	appendPromptMemory(messages: AgentMessage[], report: MemoryRetrievalReport): MemoryPromptPlan {
		const generation = this._memoryGeneration;
		if (!this._legacyMemoryEnabled()) {
			return { messages, isCurrent: () => generation === this._memoryGeneration, commit: () => {} };
		}
		const revision = this._memoryContentRevision;
		const headroom = this.deps.getPromptHeadroom?.(messages);
		const queryPass = this._lastLongTermQueryAttempted;
		const hasInclusionReport = this._latestMemoryPromptInclusionReport !== undefined;
		const reportPolicy = this._reportPolicy.get(report);
		// The live branch's retention at preview: a plan captured before a branch switch or a new compaction is replanned.
		const branch = this._activeBranch?.snapshot();
		const compose = () => {
			// One allowance: the frontier takes its share first (it is the stable record), the evidence block
			// composes within the rest, so the two can never add up past the headroom-derived budget.
			const frontier = this._composeHistoryFrontier(headroom);
			return {
				frontier,
				evidence: this._composeMemoryEvidence(report, headroom, queryPass, hasInclusionReport, frontier.reserved),
				persona: this._userPersonaRecords(headroom),
			};
		};
		const composed = compose();
		const records = [...composed.frontier.records, ...composed.evidence.records, ...composed.persona];
		return {
			messages: [...messages, ...records],
			isCurrent: () => {
				if (!this._legacyMemoryEnabled() || generation !== this._memoryGeneration) return false;
				if (revision !== this._memoryContentRevision) return false;
				// A report retrieved under another policy (egress, result cap, contributed providers) is stale.
				if (reportPolicy !== undefined && reportPolicy !== this._retrievalPolicyKey()) return false;
				// A view prepared under another branch epoch or retention (a new compaction) is replanned.
				if (this._activeBranch?.snapshot().retentionRevision !== branch?.retentionRevision) return false;
				const current = compose();
				return sameHostRecords(
					[...current.frontier.records, ...current.evidence.records, ...current.persona],
					records,
				);
			},
			commit: () => {
				this._publishMemoryEvidence(composed.evidence);
				this._hierarchy?.noteFrontierState(composed.frontier.state);
			},
		};
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
	 * The live branch as a frontier fence: per source entry, whether the live context still shows it after the
	 * latest compaction on the ACTIVE ancestry (a kept tail, `original-user` retention and carried records all
	 * stay visible), or the reason there is no compaction. The frontier describes only history compacted away
	 * on this branch.
	 */
	private _frontierFence(): { fence: FrontierBranchFence } | { state: TranscriptFrontierState } {
		const retention = this._activeBranch?.retention();
		if (retention === undefined) return { state: "not_compacted" };
		return { fence: { standing: (entryId) => retention.standing(entryId) } };
	}

	/**
	 * The current session's history frontier as one `transcript_frontier` host record, drawn from the same
	 * headroom-derived allowance as the evidence block: at most half of it in bytes, in estimated tokens AND in
	 * lines (any one ceiling alone would let it spend the others and starve the evidence block), further capped by
	 * `frontierMaxBytes`, wrapper bytes charged. It describes only history compacted away on the live branch:
	 * what the live context still shows verbatim after the latest compaction (a kept tail, `original-user`
	 * retention, carried records) is not re-sent, and a mixed node keeps its compacted-away evidence reachable
	 * by pointer. A frontier whose entries are off the live branch (after a branch switch) is reported as
	 * `lineage_mismatch` and never shown. It never rewrites a sent record: the
	 * planner appends a new record only when the content changes and clears the old one in place. When
	 * there is nothing to show the record is the cleared form, which the planner appends only over an
	 * earlier frontier record. A frontier that changes after preview makes the plan not current, so the
	 * change enters the next plan only.
	 */
	private _composeHistoryFrontier(headroom: PromptHeadroom | undefined): {
		records: AgentMessage[];
		reserved: FrontierReserve;
		state: TranscriptFrontierState;
	} {
		const host = this._hierarchy;
		if (host === undefined) return { records: [], reserved: NO_FRONTIER_RESERVE, state: "not_running" };
		const cleared = (state: TranscriptFrontierState) => ({
			records: [this._hostTransient(TRANSCRIPT_FRONTIER_CUSTOM_TYPE, HISTORY_FRONTIER_CLEARED_TEXT, true)],
			reserved: NO_FRONTIER_RESERVE,
			state,
		});
		try {
			const settings = this.deps.getSettingsManager().getMemoryRetrievalSettings();
			if (!settings.enabled || !settings.includeInPrompt) return cleared("not_running");
			const fenced = this._frontierFence();
			if ("state" in fenced) return cleared(fenced.state);
			const budget = this._memoryBudget(settings.maxResults, headroom);
			if (!budget.enabled || budget.maxBytes === undefined) return cleared("no_room");
			const allowance =
				memoryShareAllowanceBytes(budget, HISTORY_FRONTIER_BUDGET_SHARE) - HISTORY_FRONTIER_WRAPPER_BYTES;
			const allowanceLines =
				shareOfMemoryPromptBudget(budget, HISTORY_FRONTIER_BUDGET_SHARE).maxLines - HISTORY_FRONTIER_WRAPPER_LINES;
			if (allowance <= 0 || allowanceLines <= 0) return cleared("no_room");
			const preview = host.previewFrontier(allowance, allowanceLines, fenced.fence);
			if (preview.state !== "shown") return cleared(preview.state);
			const boundaryId = createHash("sha256").update(preview.text).digest("hex").slice(0, 32);
			const wrapped = wrapUntrustedText(preview.text, "memory:history-frontier", { nonce: boundaryId });
			return {
				records: [this._hostTransient(TRANSCRIPT_FRONTIER_CUSTOM_TYPE, wrapped, false)],
				reserved: {
					bytes: utf8ByteLength(wrapped),
					estimatedTokens: estimateTokensFromText(wrapped),
					lines: estimateLineCount(wrapped),
				},
				state: "shown",
			};
		} catch {
			// A frontier failure never clears or replaces what is on record, and never fails the request.
			return { records: [], reserved: NO_FRONTIER_RESERVE, state: "not_running" };
		}
	}

	/** The summary-hierarchy zoom for one memory generation; disabled retrieval answers with a policy refusal. */
	private _currentHistoryExpander(generation: number): TranscriptNodeExpander | undefined {
		if (!this._historyAvailable(generation) || !this._hierarchy) return undefined;
		if (!this.deps.getSettingsManager().getMemoryRetrievalSettings().enabled) return POLICY_BLOCKED_HISTORY_EXPANDER;
		return this._hierarchy.expander();
	}

	/** Approved summaries covering history hits, for one memory generation; policy as for the zoom. */
	private _currentSummaryLookup(generation: number): TranscriptSummaryLookup | undefined {
		if (!this._historyAvailable(generation) || !this._hierarchy) return undefined;
		if (!this.deps.getSettingsManager().getMemoryRetrievalSettings().enabled) return POLICY_BLOCKED_SUMMARY_LOOKUP;
		return this._hierarchy.summaryLookup();
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
	private _userPersonaRecords(headroom: PromptHeadroom | undefined): AgentMessage[] {
		try {
			const writer = this.getFileStoreWriter();
			if (writer === undefined) return [];
			const settings = this.deps.getSettingsManager().getMemoryRetrievalSettings();
			if (!settings.enabled || !settings.includeInPrompt) {
				return [
					this._hostTransient(
						USER_PERSONA_CUSTOM_TYPE,
						"USER PERSONA: memory is disabled or excluded from the prompt in this session; earlier persona records are stale.",
						true,
					),
				];
			}
			const budget = this._memoryBudget(settings.maxResults, headroom);
			const projection = writer.userPersonaProjection(
				budget.enabled || budget.reason !== "missing_context_window" ? budget : undefined,
			);
			if (projection === undefined) return [];
			if (!projection.changed) {
				return projection.content === undefined
					? []
					: [this._hostTransient(USER_PERSONA_CUSTOM_TYPE, projection.content, true)];
			}
			if (projection.content !== undefined) {
				return [this._hostTransient(USER_PERSONA_CUSTOM_TYPE, projection.content, false)];
			}
			const overBudget = `USER PERSONA: USER.md changed (revision ${projection.revision}) beyond this model's memory budget; earlier persona records are stale. Read USER.md when preferences matter.`;
			return [this._hostTransient(USER_PERSONA_CUSTOM_TYPE, overBudget, true)];
		} catch {
			return [];
		}
	}

	/** A host transient (content) or its cleared marker, with a content-derived timestamp so retries are byte-identical. */
	private _hostTransient(customType: string, text: string, cleared: boolean): AgentMessage {
		const digest = createHash("sha256").update(text).digest();
		return createCustomMessage(
			customType,
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
		transcript: TranscriptMemoryDiagnostics;
	} {
		const settings = this.deps.getSettingsManager().getMemoryRetrievalSettings();
		return {
			retrieval: sanitizeMemoryRetrievalReportForDiagnostics(this.getMemoryRetrievalReport(), settings),
			promptInclusion: this.getMemoryPromptInclusionReport(),
			transcript: sanitizeTranscriptHistoryForDiagnostics(this.getTranscriptHistoryStatus()),
		};
	}

	/**
	 * Operator view of past-session history recall: index coverage, the transcript provider's slot in
	 * the latest retrieval pass (with its real failure text) and what the prompt block admitted. Reads
	 * stored state only; never queries.
	 */
	getTranscriptHistoryStatus(): TranscriptHistoryStatus {
		const enabled = this.deps.getSettingsManager().getMemoryRetrievalSettings().enabled;
		const hierarchy: TranscriptHierarchyStatus | undefined = this._hierarchy?.status();
		const recall = this._historyAvailable(this._memoryGeneration) ? this._transcriptRecall : undefined;
		const health = recall?.health();
		const availability: TranscriptHistoryStatus["availability"] = !enabled
			? "disabled"
			: health === undefined || health.state === "failed"
				? "unavailable"
				: health.state === "idle"
					? "on_demand"
					: health.state === "loading"
						? "loading"
						: "active";
		const coverage = availability === "active" ? recall?.coverage() : undefined;
		// No backend serves this generation: say why, so "unavailable" is never a bare word.
		const unavailableReason =
			health?.state === "failed"
				? health.reason
				: !enabled || health !== undefined
					? undefined
					: this.deps.isChildSession()
						? "this is a child session: it keeps no history index of its own; history is read through the parent session"
						: this._initializationFailed
							? "the memory system failed to initialize"
							: this._shutdownPromise !== undefined
								? "memory has shut down for this session"
								: "the memory system is starting or switching";
		const report = this._latestMemoryRetrievalReport;
		const providerReport = report?.providerReports.find(
			(entry) => entry.providerId === TRANSCRIPT_MEMORY_PROVIDER_ID,
		);
		return {
			availability,
			...(unavailableReason !== undefined ? { unavailableReason } : {}),
			...(coverage ? { coverage } : {}),
			...(health && (health.stoppedAt !== undefined || health.readTimeouts !== undefined)
				? {
						transport: {
							...(health.stoppedAt !== undefined ? { stoppedAt: health.stoppedAt } : {}),
							...(health.readTimeouts !== undefined ? { readTimeouts: health.readTimeouts } : {}),
						},
					}
				: {}),
			...(report && providerReport
				? {
						latestRetrieval: {
							status: providerReport.status,
							resultCount: providerReport.resultCount,
							sourceRefCount: report.results.filter(
								(result) => result.item.providerId === TRANSCRIPT_MEMORY_PROVIDER_ID,
							).length,
							...(providerReport.error !== undefined ? { error: providerReport.error } : {}),
						},
					}
				: {}),
			admittedInPromptCount: this._latestTranscriptAdmittedCount,
			...(hierarchy ? { hierarchy } : {}),
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
			const candidates = entries.flatMap(({ path, parsed }, index): MemoryTierCandidate[] => {
				const item = parsed.item;
				if (item === undefined) return [];
				const heading = `[OKF ${path}] ${item.title ?? "Untitled"}: ${item.summary}`;
				return [
					{
						id: String(index).padStart(4, "0"),
						tier: "long_term",
						sourceLabel: "memory:okf",
						summary: `${heading}\n${item.content ?? ""}`,
						pointerSummary: `${heading} (full document omitted: over the snapshot bound)`,
					},
				];
			});
			const snapshot = composeCharBoundedMemoryRecords(candidates, MAX_REFLECTION_OKF_CHARS).text;
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
	 * One immutable delegated-memory snapshot, sized against the RECEIVING lane (`capacity`): its own window, the
	 * request it already carries, the reply room it keeps and the tokens it may still spend, never the root
	 * model's. Equivalent concurrent reads (same memory state, retrieval policy, lane request and allowance) share
	 * the exact promise and object while completed reads are discarded, so a later call observes fresh external
	 * state. A lane whose capacity is unknown or exhausted gets a stated constraint, never an assumption of room.
	 * OKF lanes also get standing memory, extension recall and the frontier; an ICM lane gets the history query
	 * and the approved summaries covering its hits, nothing else. `deadlineAt` is the calling tool call's one
	 * deadline; an equivalent concurrent read shares the first caller's.
	 */
	readMemorySnapshotForLane(
		query: string,
		capacity: LaneMemoryCapacitySource,
		deadlineAt: number,
	): Promise<LaneMemoryReadSnapshot> {
		const generation = this._memoryGeneration;
		const revision = this._memoryContentRevision;
		if (!this._historyAvailable(generation)) {
			// A memory switch in progress is a read to retry once it settles, not an absence of memory.
			if (this._transitioning && this._shutdownPromise === undefined) {
				return Promise.reject(new LaneMemorySnapshotStaleError());
			}
			return Promise.resolve(this._laneMemorySnapshot(generation, revision, LANE_MEMORY_UNAVAILABLE_TEXT));
		}
		const settings = this.deps.getSettingsManager().getMemoryRetrievalSettings();
		if (!settings.enabled) {
			return Promise.resolve(this._laneMemorySnapshot(generation, revision, MEMORY_RETRIEVAL_DISABLED_REASON));
		}
		const legacy = this._legacyMemoryEnabled();
		const normalizedQuery = query.trim();
		const lane = capacity();
		const budget = this._laneMemoryBudget(settings.maxResults, lane);
		if (!budget.enabled) {
			return Promise.resolve(
				this._laneMemorySnapshot(generation, revision, laneConstraintText(budget.reason, lane !== undefined)),
			);
		}
		const maxResults = Math.min(3, budget.maxResults);
		const turnIndex = this.deps.getTurnIndex();
		const policy = this._retrievalPolicyKey();
		const key = JSON.stringify([
			generation,
			revision,
			policy,
			legacy,
			turnIndex,
			normalizedQuery,
			maxResults,
			budget,
			lane?.revision,
		]);
		const active = this._laneMemoryReads.get(key);
		if (active) return active;
		const loading = this._loadLaneMemorySnapshot({
			generation,
			revision,
			policy,
			legacy,
			query: normalizedQuery,
			maxResults,
			turnIndex,
			budget,
			capacity,
			lifecycleTail: this._lifecycleTail,
			deadlineAt,
		});
		this._laneMemoryReads.set(key, loading);
		void loading
			.finally(() => {
				if (this._laneMemoryReads.get(key) === loading) this._laneMemoryReads.delete(key);
			})
			.catch(() => {});
		return loading;
	}

	/** The allowance a delegated lane's read may fill, resolved by the one budget owner on the lane's own request. */
	private _laneMemoryBudget(configuredMaxResults: number, lane: LaneMemoryCapacity | undefined): MemoryPromptBudget {
		return resolveMemoryPromptBudget({
			contextWindow: lane?.contextWindow,
			configuredMaxResults,
			ceilingTokens: LANE_READ_MAX_ESTIMATED_TOKENS,
			...(lane
				? {
						currentPromptTokens: lane.currentPromptTokens,
						reservedTokens: lane.reservedTokens,
						...(lane.remainingTokenAllowance !== undefined
							? { remainingTokenAllowance: lane.remainingTokenAllowance }
							: {}),
					}
				: {}),
		});
	}

	/**
	 * One delegated lane's read-only memory port. Its snapshot reads record which transcript sources and
	 * summaries the lane was actually shown (admission is per broker, so another lane's handles never carry
	 * over), and `readSource` opens only those, inside the memory generation and retrieval policy that issued
	 * them; anything else that changed since is a stale read to repeat, never a delivery.
	 */
	createLaneMemoryBroker(capacity: LaneMemoryCapacitySource): WorkerMemoryBroker {
		interface Admission {
			generation: number;
			policy: string;
		}
		const admitted = new Map<string, Admission>();
		const admit = (handle: string, admission: Admission): void => {
			admitted.delete(handle);
			admitted.set(handle, admission);
			if (admitted.size <= MAX_ADMITTED_LANE_SOURCES) return;
			const oldest = admitted.keys().next().value;
			if (oldest !== undefined) admitted.delete(oldest);
		};
		const current = (admission: Admission): boolean =>
			this._historyAvailable(admission.generation) && admission.policy === this._retrievalPolicyKey();
		// A source page or an expansion is delivered only as a whole record inside the receiving lane's allowance,
		// resolved by the same budget owner as the snapshot; what cannot fit is a stated constraint, never cut text.
		const laneBudget = () =>
			this._laneMemoryBudget(this.deps.getSettingsManager().getMemoryRetrievalSettings().maxResults, capacity());
		return {
			read: async (query) => {
				const policy = this._retrievalPolicyKey();
				// One deadline for the whole tool call, set once here and passed unchanged to every summary read.
				const snapshot = await this.readMemorySnapshotForLane(
					query,
					capacity,
					Date.now() + TRANSCRIPT_FOREGROUND_READ_MS,
				);
				for (const handle of [
					...extractTranscriptSourceHandles(snapshot.content, this._projectId()),
					...extractTranscriptNodeHandles(snapshot.content),
				]) {
					admit(handle, { generation: snapshot.sourceGeneration, policy });
				}
				return snapshot.content;
			},
			readSource: async (ref, cursor) => {
				// One deadline for the whole tool call, set once here and passed unchanged to every summary read.
				const deadlineAt = Date.now() + TRANSCRIPT_FOREGROUND_READ_MS;
				const nodePrefix = parseTranscriptNodeHandle(ref);
				if (nodePrefix !== undefined) {
					const nodeHandle = `txn:${nodePrefix}`;
					const nodeAdmission = admitted.get(nodeHandle);
					if (nodeAdmission === undefined) {
						return laneSourceRefusal(
							"forbidden",
							"this summary was not cited to this worker by a memory_read result; run memory_read with a query that surfaces it",
						);
					}
					if (!current(nodeAdmission)) throw new LaneMemorySnapshotStaleError();
					const budget = laneBudget();
					if (!budget.enabled)
						return { ok: true, text: laneConstraintText(budget.reason, capacity() !== undefined) };
					const expanded = await expandTranscriptNode(
						this._currentHistoryExpander(nodeAdmission.generation),
						nodeHandle,
						{ deadlineAt },
					);
					if (!current(nodeAdmission)) throw new LaneMemorySnapshotStaleError();
					if (!expanded.ok) {
						// A summary that cannot be shown names its exact sources instead; the lane is shown those
						// pointers in this refusal, so it may open them, as it may any source a read of it named.
						for (const handle of extractTranscriptSourceHandles(expanded.reason, this._projectId())) {
							admit(handle, nodeAdmission);
						}
						return laneSourceRefusal(expanded.status, expanded.reason);
					}
					// Not shown, so nothing it names is admitted either.
					if (!memoryTextFitsBudget(expanded.text, budget))
						return { ok: true, text: LANE_EXPANSION_OVER_ROOM_TEXT };
					// What an admitted expansion returns is part of what the lane was shown.
					for (const key of ["children", "sources"] as const) {
						const handles = expanded.details[key];
						if (Array.isArray(handles)) {
							for (const handle of handles) if (typeof handle === "string") admit(handle, nodeAdmission);
						}
					}
					return { ok: true, text: expanded.text };
				}
				const projectId = this._projectId();
				const parsed = parseTranscriptSourceHandle(ref, projectId);
				if (parsed === undefined) {
					return laneSourceRefusal(
						"invalid",
						"ref is not a valid transcript handle (expected tx:<session>:<entry>:<part>:<digest> or txn:<16 hex>)",
					);
				}
				const handle = formatTranscriptSourceHandle(parsed);
				const admission = admitted.get(handle);
				if (admission === undefined) {
					return laneSourceRefusal(
						"forbidden",
						"this source was not cited to this worker by a memory_read result; run memory_read with a query that surfaces it",
					);
				}
				if (!current(admission)) throw new LaneMemorySnapshotStaleError();
				const budget = laneBudget();
				if (!budget.enabled) return { ok: true, text: laneConstraintText(budget.reason, capacity() !== undefined) };
				// The page shrinks until the whole rendered page (header, wrapper, continuation) fits; its continuation
				// metadata always names where the rest starts.
				for (
					let maxBytes = Math.min(TRANSCRIPT_SOURCE_PAGE_BYTES, memoryShareAllowanceBytes(budget, 1));
					maxBytes >= LANE_MIN_SOURCE_PAGE_BYTES;
					maxBytes = Math.floor(maxBytes / 2)
				) {
					const outcome = await openTranscriptSource(
						this._currentTranscriptReader(admission.generation),
						projectId,
						{ ref: handle, cursor, maxBytes, deadlineAt },
					);
					if (!current(admission)) throw new LaneMemorySnapshotStaleError();
					if (!outcome.ok) {
						// A stale source names, as a typed field, the current source at its position; the lane is shown it
						// in this refusal, so it may open it, as it may any source a read of it named.
						if (outcome.currentHandle !== undefined) admit(outcome.currentHandle, admission);
						return laneSourceRefusal(outcome.status, outcome.reason);
					}
					if (!memoryTextFitsBudget(outcome.text, budget)) continue;
					// A continuation of an admitted source is part of what the lane was shown.
					const nextPartHandle = outcome.details.nextPartHandle;
					if (typeof nextPartHandle === "string") admit(nextPartHandle, admission);
					return { ok: true, text: outcome.text };
				}
				return { ok: true, text: LANE_SOURCE_OVER_ROOM_TEXT };
			},
		};
	}

	/** The project identity transcript handles are scoped to; the same key the project memory files use. */
	private _projectId(): string {
		return getDirectoryResourceProfileInfo(this.deps.getCwd(), this.deps.getAgentDir()).hash;
	}

	/**
	 * The history reader for one memory generation, in either memory system. A replaced or unsettled generation
	 * and a child session have none; disabled retrieval answers with a typed policy refusal instead of silence.
	 */
	private _currentTranscriptReader(generation: number): TranscriptSourceReader | undefined {
		if (!this._historyAvailable(generation)) return undefined;
		if (!this.deps.getSettingsManager().getMemoryRetrievalSettings().enabled) return POLICY_BLOCKED_HISTORY_READER;
		return this._transcriptRecall;
	}

	/** Drop the active generation's recall backend and its persistence subscription. */
	private _releaseTranscriptRecall(): void {
		this._unsubscribeEntriesPersisted?.();
		this._unsubscribeEntriesPersisted = undefined;
		this._transcriptRecall = undefined;
	}

	/** Whether a delegated read planned against `input` still describes the memory, policy and lane it will serve. */
	private _laneReadCurrent(input: {
		generation: number;
		revision: number;
		policy: string;
		legacy: boolean;
		budget: MemoryPromptBudget;
		capacity: LaneMemoryCapacitySource;
	}): boolean {
		if (
			!this._historyAvailable(input.generation) ||
			input.legacy !== this._legacyMemoryEnabled() ||
			input.revision !== this._memoryContentRevision ||
			input.policy !== this._retrievalPolicyKey()
		) {
			return false;
		}
		const settings = this.deps.getSettingsManager().getMemoryRetrievalSettings();
		return isDeepStrictEqual(this._laneMemoryBudget(settings.maxResults, input.capacity()), input.budget);
	}

	/** A delegated lane's search hit as a composer candidate; OKF documents also carry a whole pointer form. */
	private _laneCandidate(result: MemorySearchResult, tier: MemoryTierCandidate["tier"]): MemoryTierCandidate {
		const { item } = result;
		const heading = `[OKF ${item.title ?? item.id}] ${item.summary}`;
		const okf = tier !== "evidence_pointer";
		return {
			id: item.id,
			tier,
			sourceLabel: `memory:${item.providerId}`,
			summary: okf ? `${heading}\n${item.content ?? ""}` : item.summary,
			...(okf ? { pointerSummary: `${heading} (full document omitted: over this worker's remaining room)` } : {}),
			score: result.score,
			...(item.stale !== undefined ? { stale: item.stale } : {}),
			...(item.conflict !== undefined ? { conflict: item.conflict } : {}),
		};
	}

	/**
	 * One delegated lane's snapshot, admitted as whole source-labelled records into the ONE allowance resolved
	 * on the receiving lane: the wrapper, the status and omission lines, standing memory (at most half), the
	 * history frontier (at most half of the rest) and then the query-relevant records, ranked and fitted by the
	 * tier composer. Nothing is cut: a record that does not fit is left out (an OKF document or a summary may
	 * appear as its whole pointer form) and the omission is stated, so a `tx:`/`txn:` handle is never split.
	 * Every block is charged against the allowance in bytes, tokens and lines, so the blocks together stay inside
	 * `maxLines` as well. Standing memory, extension recall, OKF documents and the frontier are OKF's
	 * (`legacy`); an ICM lane's records are its history hits (this session included, as the root's
	 * history_search) and the approved summaries that cover them.
	 */
	private async _loadLaneMemorySnapshot(input: {
		generation: number;
		revision: number;
		policy: string;
		legacy: boolean;
		query: string;
		maxResults: number;
		turnIndex: number;
		budget: MemoryPromptBudget;
		capacity: LaneMemoryCapacitySource;
		lifecycleTail: Promise<void>;
		deadlineAt: number;
	}): Promise<LaneMemoryReadSnapshot> {
		await input.lifecycleTail;
		if (!this._laneReadCurrent(input)) throw new LaneMemorySnapshotStaleError();
		const retrievalOptions = {
			createdAtTurn: input.turnIndex,
			maxResults: input.maxResults,
			defaultLocalPolicy: DEFAULT_LOCAL_MEMORY_EGRESS_POLICY,
		};
		const [lifecycleRecall, okfReport, historyReport] = await Promise.all([
			input.legacy ? this.prefetchRecall(input.query) : "",
			input.legacy
				? retrieveMemoryForContext(
						[this._getMemoryOkfProvider()],
						{ query: input.query, maxResults: input.maxResults },
						retrievalOptions,
					)
				: undefined,
			retrieveMemoryForContext(
				[this._getTranscriptMemoryProvider(input.generation, !input.legacy, input.deadlineAt)],
				{ query: input.query, maxResults: input.maxResults },
				retrievalOptions,
			),
		]);
		if (!this._laneReadCurrent(input)) throw new LaneMemorySnapshotStaleError();
		// An OKF lane is pointed at earlier summaries by the frontier below; an ICM lane by the hits' covering summaries.
		const summaries = input.legacy
			? { candidates: [], status: "" }
			: await this._laneSummaryReferences(input.generation, historyReport, input.maxResults, input.deadlineAt);
		if (!this._laneReadCurrent(input)) throw new LaneMemorySnapshotStaleError();

		const candidates: MemoryTierCandidate[] = [
			...(okfReport?.results ?? []).map((result) => this._laneCandidate(result, "long_term")),
			...historyReport.results.map((result) => this._laneCandidate(result, "evidence_pointer")),
			...summaries.candidates,
		];
		const lifecycleText = lifecycleRecall.trim();
		if (lifecycleText.length > 0) {
			candidates.push({
				id: "lifecycle-recall",
				tier: "long_term",
				sourceLabel: "memory:lifecycle",
				summary: lifecycleText,
				score: 0.5,
			});
		}
		const isHistoryRecord = (candidate: MemoryTierCandidate) =>
			candidate.sourceLabel === TRANSCRIPT_SOURCE_LABEL || candidate.sourceLabel === LANE_SUMMARY_SOURCE_LABEL;
		const status = laneHistoryStatus(historyReport);
		const hasHistoryCandidates = candidates.some(isHistoryRecord);
		const constrained = (reason: string | undefined) =>
			this._laneMemorySnapshot(input.generation, input.revision, laneConstraintText(reason, true));
		// Reserved before any record competes: the wrapper and the short lines that state what is missing.
		let remaining = reserveMemoryPromptBudget(input.budget, {
			bytes: utf8ByteLength(LANE_WRAPPER),
			estimatedTokens: estimateTokensFromText(LANE_WRAPPER),
			lines: 2,
		});
		const worstOmissionNote = laneOmissionNote([
			...(input.legacy ? ["standing memory"] : []),
			`${candidates.length} retrieved record(s)`,
		]);
		for (const text of [status, summaries.status, hasHistoryCandidates ? LANE_HANDLE_HINT : "", worstOmissionNote]) {
			if (text.length > 0) remaining = reserveMemoryPromptBudget(remaining, laneRecordReserve(text));
		}
		if (!remaining.enabled) return constrained(remaining.reason);

		const omitted: string[] = [];
		// Standing memory takes at most half of the allowance, and only as the whole block the provider fitted.
		const standingBudget = shareOfMemoryPromptBudget(remaining, LANE_STANDING_BUDGET_SHARE);
		const standingRaw = input.legacy
			? this._memoryManager
					.buildSystemPromptBlockFresh(standingBudget.enabled ? standingBudget : remaining)
					.replace(FILE_STORE_MEMORY_SYSTEM_NOTE, LANE_STANDING_NOTE)
					.trim()
			: "";
		const standingText =
			standingBudget.enabled && memoryTextFitsBudget(standingRaw, standingBudget) ? standingRaw : "";
		if (standingRaw.length > 0 && standingText.length === 0) omitted.push("standing memory");
		if (standingText.length > 0) remaining = reserveMemoryPromptBudget(remaining, laneRecordReserve(standingText));

		// The frontier takes at most half of what is left, in whole node records (bytes, tokens and lines, as at the root).
		let frontierText = "";
		const fenced = this._frontierFence();
		if (input.legacy && this._hierarchy && "fence" in fenced && remaining.enabled) {
			const allowance =
				memoryShareAllowanceBytes(remaining, LANE_FRONTIER_BUDGET_SHARE) -
				utf8ByteLength(LANE_FRONTIER_HEADING) -
				utf8ByteLength(LANE_RECORD_SEPARATOR) -
				1;
			// The heading line and the separator line `laneRecordReserve` charges come out of the line share.
			const allowanceLines = shareOfMemoryPromptBudget(remaining, LANE_FRONTIER_BUDGET_SHARE).maxLines - 2;
			if (allowance > 0 && allowanceLines > 0) {
				const preview = this._hierarchy.previewFrontier(allowance, allowanceLines, fenced.fence, "lane");
				if (preview.state === "shown") frontierText = [LANE_FRONTIER_HEADING, preview.text].join("\n");
			}
			if (frontierText.length > 0) {
				remaining = reserveMemoryPromptBudget(remaining, laneRecordReserve(frontierText));
			}
		}

		const block = composeTieredMemoryPromptBlock(candidates, remaining);
		const admitted = new Set(block.includedIds);
		const transcriptAdmitted = candidates.some(
			(candidate) => admitted.has(candidate.id) && isHistoryRecord(candidate),
		);
		// Stale, conflicting and secret-like records are policy exclusions; only records that did not fit are stated.
		const notFitting = remaining.enabled
			? block.diagnostics.filter(({ reason }) => reason === "budget_exhausted" || reason === "oversized_item").length
			: candidates.length;
		if (notFitting > 0) omitted.push(`${notFitting} retrieved record(s)`);
		const parts = [
			standingText,
			frontierText,
			block.text ?? "",
			status,
			summaries.status,
			transcriptAdmitted ? LANE_HANDLE_HINT : "",
			omitted.length > 0 ? laneOmissionNote(omitted) : "",
		].filter((part) => part.length > 0);
		if (parts.length === 0) {
			return this._laneMemorySnapshot(
				input.generation,
				input.revision,
				input.legacy ? LANE_NO_MEMORY_TEXT : LANE_NO_HISTORY_TEXT,
			);
		}
		const combined = parts.join(LANE_RECORD_SEPARATOR);
		// The boundary id is a function of the content, so an unchanged snapshot is byte-identical.
		const nonce = createHash("sha256").update(combined).digest("hex").slice(0, 32);
		return this._laneMemorySnapshot(
			input.generation,
			input.revision,
			wrapUntrustedText(combined, "worker-memory", { nonce }),
		);
	}

	/**
	 * The approved summaries covering a lane's history hits, through the same lookup the root's history_search
	 * uses, as whole-record candidates (at most `maxNodes`). A lookup that cannot answer is stated with its typed
	 * status beside the hits; it never hides them and never reads as "no summaries".
	 */
	private async _laneSummaryReferences(
		generation: number,
		report: MemoryRetrievalReport,
		maxNodes: number,
		deadlineAt: number,
	): Promise<{ candidates: MemoryTierCandidate[]; status: string }> {
		const projectId = this._projectId();
		const hits = report.results.flatMap((result) => {
			const ref = parseTranscriptSourceHandle(result.item.id, projectId);
			return ref === undefined ? [] : [{ ref, score: result.score }];
		});
		const lookup = this._currentSummaryLookup(generation);
		if (hits.length === 0 || lookup === undefined) return { candidates: [], status: "" };
		const found = await lookup.summariesFor(
			hits.map((hit) => hit.ref),
			{ maxNodes },
			{ deadlineAt },
		);
		if (found.status !== "ok") {
			return {
				candidates: [],
				status: `History summaries were not looked up (${found.status}: ${boundedTextPreview(found.reason, TRANSCRIPT_RECALL_MAX_ERROR_CHARS)}).`,
			};
		}
		const hitScores = new Map(hits.map((hit) => [formatTranscriptSourceHandle(hit.ref), hit.score]));
		return { candidates: found.summaries.map((summary) => laneSummaryCandidate(summary, hitScores)), status: "" };
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
		const system = this.deps.getSettingsManager().getMemorySystem();
		const previousSystem = this._activeMemorySystem;
		const previous = this._memoryManager;
		const manager = new MemoryManager();
		this._memoryManager = manager;
		this._activeMemorySystem = undefined;
		this._fileStoreWriter = undefined;
		// The previous generation's coordinator stops (and records its terminal handoff) before its reader goes.
		const hierarchyStopped = this._hierarchy?.detach();
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
		this._admittedRecall = undefined;
		this._turnRetrieval = undefined;
		this._latestTranscriptAdmittedCount = 0;
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
					await hierarchyStopped;
					await previous.shutdownAll();
					if (generation !== this._memoryGeneration) return;
					let writer: FileStoreProvider | undefined;
					// One history backend per generation in either system, for a root session only: OKF keeps its
					// eager start while retrieval is enabled; otherwise (ICM, or retrieval disabled) the backend is
					// bound and the first admitted history request starts it, so a disabled policy never scans.
					const eager = system !== "icm" && this.deps.getSettingsManager().getMemoryRetrievalSettings().enabled;
					const transcriptRecall = this.deps.isChildSession()
						? undefined
						: new TranscriptRecallProvider({
								...(eager ? { start: "eager" as const } : {}),
								activeSessionFile: () => this.deps.getSessionFile?.(),
							});
					const history = {
						transcriptReader: () => this._currentTranscriptReader(generation),
						projectId: () => this._projectId(),
						historyExpander: () => this._currentHistoryExpander(generation),
						summaryLookup: () => this._currentSummaryLookup(generation),
					};
					if (system === "icm") {
						manager.registerProvider(
							new IcmProvider(
								history,
								() => this.deps.getSettingsManager().getMemoryRetrievalSettings().enabled,
							),
						);
					} else {
						const admitUserPreference = this.deps.admitUserPreference;
						writer = new FileStoreProvider({
							onDurableMemoryChanged: () => {
								this._memoryContentRevision++;
								this._memoryOkfProvider = undefined;
							},
							...(admitUserPreference ? { admitUserPreference: (request) => admitUserPreference(request) } : {}),
							...history,
						});
						manager.registerProvider(writer);
					}
					if (transcriptRecall) {
						manager.registerProvider(transcriptRecall);
						// Subscribed before initialization so no committed batch falls between the provider's
						// start scan and the first event; a stale generation's batches never reach it.
						this._unsubscribeEntriesPersisted = this.deps.subscribeEntriesPersisted?.((event) => {
							if (generation === this._memoryGeneration) transcriptRecall.notifyEntriesPersisted(event);
						});
					}
					if (system !== "icm") {
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
					if (transcriptRecall) {
						// Started in the background: the store load must not hold up memory initialization. It is
						// current only while this generation serves history, whatever transitions happen later.
						void this._hierarchy?.attach(transcriptRecall, () => this._historyAvailable(generation));
					}
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
