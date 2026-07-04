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

import { join } from "node:path";
import type { AgentMessage, CustomMessage } from "@caupulican/pi-agent-core";
import {
	defaultMemoryPromptInclusionReport,
	type MemoryPromptInclusionReport,
	type MemoryRetrievalDiagnostics,
	sanitizeMemoryRetrievalReportForDiagnostics,
} from "./context/memory-diagnostics.ts";
import { buildMemoryPromptBlock } from "./context/memory-prompt-block.ts";
import {
	type MemoryProvider as ContextMemoryProvider,
	DEFAULT_LOCAL_MEMORY_EGRESS_POLICY,
} from "./context/memory-provider-contract.ts";
import { type MemoryRetrievalReport, retrieveMemoryForContext } from "./context/memory-retrieval.ts";
import { createOkfMemoryProvider } from "./context/okf-memory-provider.ts";
import { EffectivenessTracker } from "./memory/effectiveness-tracker.ts";
import { MemoryManager } from "./memory/memory-manager.ts";
import type { MemoryProvider } from "./memory/memory-provider.ts";
import { FileStoreProvider } from "./memory/providers/file-store.ts";
import { TranscriptRecallProvider } from "./memory/providers/transcript-recall.ts";
import { wrapUntrustedText } from "./security/untrusted-boundary.ts";
import type { SettingsManager } from "./settings-manager.ts";

/**
 * Text of the most recent user message, or "" if there is none (e.g. goal-continuation
 * turns with no new user input). An empty query degrades to zero memory-retrieval results
 * by construction (see memory-provider-contract.ts's score-on-empty-query-tokens rule) --
 * no special-casing needed here beyond returning "".
 */
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

export interface MemoryControllerDeps {
	/** Memory-retrieval + prompt-inclusion settings (the opt-in gates for retrieval and surfacing). */
	getSettingsManager(): SettingsManager;
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
}

export class MemoryController {
	private _memoryOkfProvider: ContextMemoryProvider | undefined = undefined;
	private _latestMemoryRetrievalReport: MemoryRetrievalReport | undefined = undefined;
	private _latestMemoryPromptInclusionReport: MemoryPromptInclusionReport | undefined = undefined;
	/** Plug-and-play memory subsystem. Recreated on each (re)initialize so reload is safe. */
	private _memoryManager: MemoryManager = new MemoryManager();
	/** R4: tracks whether injected recall is actually used, to adapt the recall gate. */
	private readonly _effectivenessTracker = new EffectivenessTracker();
	/** Memory providers registered by extensions via pi.registerMemoryProvider, applied on (re)init. */
	private _pendingMemoryProviders: MemoryProvider[] = [];

	private readonly deps: MemoryControllerDeps;

	constructor(deps: MemoryControllerDeps) {
		this.deps = deps;
	}

	/** The live memory manager. Callers reach prefetch / tool-definitions / markers / shutdown through it. */
	getMemoryManager(): MemoryManager {
		return this._memoryManager;
	}

	/**
	 * Fixed path for this slice's local Pi OKF memory documents, shared across sessions
	 * under this agentDir (not session-scoped, unlike tool-artifacts/context-gc, since OKF
	 * memory represents durable cross-session knowledge, not a per-session capture). Not
	 * yet user-configurable -- see the memory-retrieval settings doc comment.
	 */
	private _memoryOkfDir(): string {
		return join(this.deps.getAgentDir(), "okf-memory");
	}

	/**
	 * Session-scoped, read-only local OKF memory provider. Lazily created ONLY when memory
	 * retrieval is enabled (see `runMemoryRetrieval`) -- never force-created, so a session
	 * with the setting off never touches `_memoryOkfDir()` at all (no directory access, no
	 * creation; `createOkfMemoryProvider` itself never writes/mkdirs either way).
	 */
	private _getMemoryOkfProvider(): ContextMemoryProvider {
		this._memoryOkfProvider ??= createOkfMemoryProvider({ rootDir: this._memoryOkfDir() });
		return this._memoryOkfProvider;
	}

	/**
	 * Observe-only local memory retrieval (see context/memory-retrieval.ts and
	 * context/okf-memory-provider.ts): default disabled, opt-in setting. When disabled,
	 * never constructs the OKF provider (no directory access under `_memoryOkfDir()` at
	 * all) and returns an empty report -- fully fail-closed. When enabled, queries the
	 * local, read-only OKF provider with the latest user message text (empty if there is
	 * none, e.g. a goal-continuation turn -- degrades to zero results by construction, see
	 * `latestUserMessageText`'s doc comment) under `DEFAULT_LOCAL_MEMORY_EGRESS_POLICY`.
	 * Retrieved items are only ever stored in the report; nothing here touches `messages`,
	 * the transcript, or the provider-visible prompt. Never throws into a live turn: any
	 * failure (including a provider search error) degrades to an empty report.
	 */
	async runMemoryRetrieval(messages: AgentMessage[]): Promise<MemoryRetrievalReport> {
		try {
			const settings = this.deps.getSettingsManager().getMemoryRetrievalSettings();
			if (!settings.enabled) {
				const report = emptyMemoryRetrievalReport(settings.maxResults);
				this._latestMemoryRetrievalReport = report;
				return report;
			}
			const report = await retrieveMemoryForContext(
				[this._getMemoryOkfProvider()],
				{ query: latestUserMessageText(messages), maxResults: settings.maxResults },
				{
					createdAtTurn: this.deps.getTurnIndex(),
					maxResults: settings.maxResults,
					defaultLocalPolicy: DEFAULT_LOCAL_MEMORY_EGRESS_POLICY,
				},
			);
			this._latestMemoryRetrievalReport = report;
			return report;
		} catch {
			const report = emptyMemoryRetrievalReport(0);
			this._latestMemoryRetrievalReport = report;
			return report;
		}
	}

	/** Read-only inspection of the latest memory-retrieval report, for tests/debugging. */
	getMemoryRetrievalReport(): MemoryRetrievalReport {
		return this._latestMemoryRetrievalReport ?? emptyMemoryRetrievalReport(0);
	}

	/**
	 * Bounded prompt-surfacing pilot for local memory evidence (see
	 * context/memory-prompt-block.ts): opt-in, default disabled, and gated on TWO settings
	 * (`enabled` AND `includeInPrompt`) plus a non-empty `report.contextItems` -- the first
	 * two are belt-and-suspenders on top of the fact that `runMemoryRetrieval` already
	 * leaves `contextItems` empty whenever `enabled` is false, regardless of
	 * `includeInPrompt`. Reuses the `report` this pass's `runMemoryRetrieval` call already
	 * computed -- never re-queries the provider here.
	 *
	 * Appends exactly one ephemeral `custom`/"memory_evidence" message wrapped by
	 * `wrapUntrustedText` (the same nonce-fenced boundary + always-on system-prompt rule
	 * used for other untrusted content) to the END of `messages`. This is purely additive
	 * (never mutates an existing message) and purely transient: `messages` here is the
	 * array about to be sent to the provider, not `this.agent.state.messages` or anything
	 * persisted via `sessionManager` -- so the injected message can never reach the
	 * transcript, regardless of how many times this pass runs.
	 *
	 * Also records a `MemoryPromptInclusionReport` (context/memory-diagnostics.ts) at each
	 * branch below, for context_audit's diagnostic surface only -- this is pure bookkeeping
	 * alongside the existing branches, not a new branch/condition: the messages returned
	 * are unchanged by this recording.
	 */
	maybeAppendMemoryEvidenceBlock(messages: AgentMessage[], report: MemoryRetrievalReport): AgentMessage[] {
		try {
			const settings = this.deps.getSettingsManager().getMemoryRetrievalSettings();
			const base = {
				enabled: settings.enabled,
				includeInPrompt: settings.includeInPrompt,
				selectedItemCount: report.contextItems.length,
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
			if (report.contextItems.length === 0) {
				this._latestMemoryPromptInclusionReport = {
					...base,
					status: "no_results",
					includedCount: 0,
					omittedCount: 0,
					blockChars: 0,
				};
				return messages;
			}

			const block = buildMemoryPromptBlock(report.contextItems);
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

			const wrapped = wrapUntrustedText(block.text, "memory:pi-okf");
			const evidenceMessage: CustomMessage = {
				role: "custom",
				customType: "memory_evidence",
				content: [{ type: "text", text: wrapped }],
				display: false,
				timestamp: Date.now(),
			};
			this._latestMemoryPromptInclusionReport = {
				...base,
				status: "included",
				includedCount: block.includedCount,
				omittedCount: block.omittedCount,
				blockChars: wrapped.length,
				sourceLabel: "memory:pi-okf",
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

	/** R4: score whether the agent actually used an injected recall page, so the recall gate can adapt. */
	recordRecallOutcome(recallText: string, queryText: string, responseText: string): void {
		this._effectivenessTracker.recordRecallOutcome(recallText, queryText, responseText);
	}

	/**
	 * (Re)build the memory subsystem: a fresh MemoryManager (reload-safe), register the bundled
	 * file-store + any extension-contributed providers, initialize, then surface the memory tools and
	 * the frozen system-prompt block. Best-effort: never throws into the session lifecycle.
	 */
	async initialize(): Promise<void> {
		try {
			// Release the previous generation's providers (locks/handles) before recreating, so a
			// reload does not orphan the old MemoryManager. No-op on first init / for file-store.
			await this._memoryManager.shutdownAll().catch(() => {});
			const manager = new MemoryManager();
			manager.registerProvider(new FileStoreProvider());
			// Bundled read-only cross-session recall (R3): indexes past-session transcripts and answers
			// prefetch() with a <memory_context> page. Never writes.
			manager.registerProvider(new TranscriptRecallProvider());
			for (const provider of this._pendingMemoryProviders) {
				try {
					manager.registerProvider(provider);
				} catch {
					// Duplicate name or reserved-tool collision — skip this provider, keep the rest.
				}
			}
			this._memoryManager = manager;
			await manager.initializeAll(this.deps.getSessionId(), {
				agentDir: this.deps.getAgentDir(),
				cwd: this.deps.getCwd(),
				isChildSession: this.deps.isChildSession(),
			});
			// Surface memory tools + the frozen memory block now that providers are initialized.
			// refreshToolRegistry() ends in setActiveToolsByName(), which rebuilds AND assigns the
			// system prompt (including the memory block), so no explicit _rebuildSystemPrompt is needed.
			this.deps.refreshToolRegistry();
		} catch (error) {
			console.error("Memory subsystem init failed:", error instanceof Error ? error.message : String(error));
		}
	}

	/** Register a memory provider contributed by an extension; applied on the next memory (re)init. */
	registerMemoryProvider(provider: MemoryProvider): void {
		if (!this._pendingMemoryProviders.some((p) => p.name === provider.name)) {
			this._pendingMemoryProviders.push(provider);
		}
	}

	/** Reload starts memory providers fresh; loaded extensions re-register before the next `initialize()`. */
	clearPendingProviders(): void {
		this._pendingMemoryProviders = [];
	}
}
