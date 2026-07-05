/**
 * Context pipeline: the session's per-turn context-shaping subsystem — the observe-only context
 * audit, the shadow prompt-policy plan and its correlation with legacy context-gc, the enforcement
 * pilot, the relevance-curation queue + the fitness-gated curation model resolver / brain-curation
 * drain + compaction pre-digest, the legacy context-gc pass and its packed-artifact reference
 * release, the tool-output artifact store, and the current-context token estimate.
 *
 * Extracted verbatim from agent-session.ts (god-file decomposition). Owns the latest
 * audit/policy/correlation/enforcement/gc reports, the {@link BrainCurator} sidecar and its last
 * skip reasons, and the lazily-built tool-artifact store. Everything else it needs — the turn
 * index, the session/settings managers, the model registry, agent/workspace dirs, the active tool
 * names, the disposed flag, the isolated-completion primitive, spawned-usage accounting, and the
 * live {@link MemoryManager} — is reached through narrow deps accessors rather than the whole
 * AgentSession.
 *
 * Context-transform boundary (deliberate): the per-turn stages ({@link estimateCurrentContextTokens},
 * {@link runContextAudit}, {@link runPromptPolicyPlanning}, {@link applyContextGc},
 * {@link correlatePromptPolicyWithContextGc}, {@link runPromptEnforcement},
 * {@link enqueueRelevanceCuration}, {@link maybeDrainBrainCuration}) are invoked from the session's
 * context transform as one-line delegations, so the transform stays the single owner of the pass
 * ordering. This controller reaches {@link MemoryController} functionality only through
 * {@link ContextPipelineDeps.getMemoryManager} (never imports it), and MemoryController never imports
 * the pipeline — keeping the transform the one place the two subsystems meet.
 */

import { join } from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core";
import {
	estimateContextTokens,
	getLatestCompactionEntry,
	type SessionManager,
	TokenBudget,
} from "@caupulican/pi-agent-core/node";
import type { Api, AssistantMessage, Model, Usage } from "@caupulican/pi-ai";
import type { IsolatedCompletionOptions, IsolatedCompletionResult } from "./agent-session.ts";
import { BrainCurator, type CurationTelemetrySnapshot, preDigestConversationText } from "./context/brain-curator.ts";
import { type ArtifactStore, createFileArtifactStore } from "./context/context-artifacts.ts";
import { type ContextAuditReport, runContextAudit } from "./context/context-audit.ts";
import { enforcePromptPolicy, type PromptEnforcementReport } from "./context/context-prompt-enforcement.ts";
import {
	correlateWithContextGc,
	type PromptPolicyGcCorrelationReport,
	type PromptPolicyShadowReport,
	planPromptPolicy,
} from "./context/context-prompt-policy.ts";
import { applyContextGc, type ContextGcReport } from "./context-gc.ts";
import type { MemoryManager } from "./memory/memory-manager.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { resolveCliModel } from "./model-resolver.ts";
import { evaluateSurfaceFitness } from "./model-router/fitness-gate.ts";
import { FitnessStore } from "./models/fitness-store.ts";
import type { SettingsManager } from "./settings-manager.ts";

/** Latest user prompt text in the provider-visible array (curation goal line; bounded by caller). */
export function latestUserPromptText(messages: AgentMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message || message.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		const text = message.content
			.filter((part): part is { type: "text"; text: string } => (part as { type?: string }).type === "text")
			.map((part) => part.text)
			.join("\n");
		if (text.length > 0) return text;
	}
	return "";
}

/** Read a packed grep/find tool result's `details.artifactId`, if present, without `any`. */
function extractArtifactId(message: AgentMessage | undefined): string | undefined {
	if (!message || message.role !== "toolResult") return undefined;
	const details = (message as { details?: unknown }).details;
	if (typeof details !== "object" || details === null) return undefined;
	const artifactId = (details as { artifactId?: unknown }).artifactId;
	return typeof artifactId === "string" ? artifactId : undefined;
}

export interface ContextPipelineDeps {
	/** Current turn index, stamped into audit/policy/enforcement reports. */
	getTurnIndex(): number;
	/** Session log: audit lookup, gc/artifact storage dirs, curation entries, token-estimate compaction anchor. */
	getSessionManager(): SessionManager;
	/** Context-gc / prompt-enforcement / curation settings (all opt-in gates). */
	getSettingsManager(): SettingsManager;
	/** Resolves a configured curation model pattern against configured auth. */
	getModelRegistry(): ModelRegistry;
	/** Root dir the host-keyed {@link FitnessStore} and per-session gc/artifact storage live under. */
	getAgentDir(): string;
	/** Workspace root, passed to the context-gc pass. */
	getCwd(): string;
	/** Currently-active tool names — enforcement checks whether artifact_retrieve is a live affordance. */
	getActiveToolNames(): string[];
	/** A disposed session must never persist a curation/pre-digest entry. */
	isDisposed(): boolean;
	/** The live memory manager — the active providers' page markers feed the semantic-gc scan. */
	getMemoryManager(): MemoryManager;
	/** Roll a curation drain's spawned usage into session accounting (idempotent per reportId). */
	addSpawnedUsage(
		usage: Usage,
		opts?: { label?: string; sourceSessionId?: string; reportId?: string },
	): string | undefined;
	/** One-shot LLM call fully isolated from the main session — the curation/pre-digest execution primitive. */
	runIsolatedCompletion(opts: IsolatedCompletionOptions): Promise<IsolatedCompletionResult>;
}

export class ContextPipeline {
	private _latestContextGcReport: ContextGcReport | undefined = undefined;
	/** Brain-curation sidecar (design: brain-context-curation-design.md). Inert unless the
	 * contextPolicy.curation setting is enabled AND the model passes the digest fitness gate. */
	private readonly _brainCurator = new BrainCurator();
	private _lastCurationSkipReason: string | undefined = undefined;
	private _lastPreDigestSkipReason: string | undefined = undefined;
	private _toolArtifactStore: ArtifactStore | undefined = undefined;
	private _latestContextAuditReport: ContextAuditReport | undefined = undefined;
	private _latestPromptPolicyReport: PromptPolicyShadowReport | undefined = undefined;
	private _latestPromptPolicyGcCorrelation: PromptPolicyGcCorrelationReport | undefined = undefined;
	private _latestPromptEnforcementReport: PromptEnforcementReport | undefined = undefined;
	private readonly _tokenBudget = new TokenBudget();

	private readonly deps: ContextPipelineDeps;

	constructor(deps: ContextPipelineDeps) {
		this.deps = deps;
	}

	private _contextGcStorageDir(): string {
		return join(this.deps.getAgentDir(), "context-gc", this.deps.getSessionManager().getSessionId());
	}

	private _toolArtifactsDir(): string {
		return join(this.deps.getAgentDir(), "context-artifacts", this.deps.getSessionManager().getSessionId());
	}

	/**
	 * Session-scoped, filesystem-backed artifact store for first-capture-then-bound tool
	 * output (grep/find only, for now -- see tool-output-artifacts.md). Lazily created and
	 * cached so every tool construction in this session shares one store instance.
	 *
	 * `packToolOutput()` registers a reference (the packing tool call's id) at pack time
	 * and fails closed, so packed artifacts are never prematurely collected.
	 * `_releaseGcPackedArtifactReferences()` (called from `applyContextGc()`) releases
	 * that reference once context-gc packs the result out of live context, and
	 * opportunistically reclaims now-unreferenced artifacts via `cleanup()`.
	 * Remaining carry-forward gap: cleanup() now also runs at dispose(), but only reclaims
	 * already-released (zero-reference) artifacts. A session that ends before context-gc
	 * ever evicts a result never releases that reference, so its artifact stays on disk by
	 * design (resolvable on resume). Reclaiming those requires an explicit cross-session
	 * expiry/liveness policy, not just a sweep.
	 */
	getToolArtifactStore(): ArtifactStore {
		this._toolArtifactStore ??= createFileArtifactStore({ baseDir: this._toolArtifactsDir() });
		return this._toolArtifactStore;
	}

	/**
	 * Best-effort final sweep of any already-released (zero-reference) tool-output artifact at
	 * session dispose. Reads the field (not the getter) so a session that never packed anything
	 * doesn't force-create a store/dir just to sweep it.
	 */
	cleanupToolArtifactStoreOnDispose(): void {
		this._toolArtifactStore?.cleanup();
	}

	/**
	 * One pass over the current branch, mapping each toolResult's toolCallId to its
	 * persisted session-entry id. Rebuilt every audit pass (O(branch) per turn), so this is
	 * O(n^2) over a long session. Fine at current scale; after the artifact-read fix this is
	 * the next per-turn audit cost to optimize if it ever matters (e.g. cache/incrementally
	 * update instead of a full rebuild).
	 */
	private _buildSessionEntryIdLookup(): (toolCallId: string) => string | undefined {
		const map = new Map<string, string>();
		for (const entry of this.deps.getSessionManager().getBranch()) {
			if (entry.type === "message" && entry.message.role === "toolResult") {
				map.set(entry.message.toolCallId, entry.id);
			}
		}
		return (toolCallId: string) => map.get(toolCallId);
	}

	/**
	 * Phase 1 observe-only audit pass (see context/context-audit.ts): converts live
	 * toolResult messages into ContextItems and runs the existing retention/hard-constraint
	 * evaluators over them, storing the latest deterministic report for tests/debugging.
	 * Read-only with respect to messages, the transcript, and artifact references -- uses
	 * `_toolArtifactStore` (the field), not `getToolArtifactStore()` (the getter), so a
	 * session that never packed anything doesn't force-create a store/dir just to audit.
	 * Never throws into a live turn: any failure degrades to an empty report.
	 */
	runContextAudit(messages: AgentMessage[]): ContextAuditReport {
		try {
			const report = runContextAudit(messages, {
				turnIndex: this.deps.getTurnIndex(),
				artifactStore: this._toolArtifactStore,
				sessionEntryIdForToolCallId: this._buildSessionEntryIdLookup(),
			});
			this._latestContextAuditReport = report;
			return report;
		} catch {
			const report: ContextAuditReport = { turnIndex: this.deps.getTurnIndex(), items: [] };
			this._latestContextAuditReport = report;
			return report;
		}
	}

	/**
	 * Read-only inspection of the context audit. With `messages`, recomputes fresh against
	 * the given array (still no mutation of messages/transcript/artifact refs); without,
	 * returns the last report computed during a real transform pass.
	 */
	getContextAuditReport(messages?: AgentMessage[]): ContextAuditReport {
		if (messages) return this.runContextAudit(messages);
		return this._latestContextAuditReport ?? { turnIndex: this.deps.getTurnIndex(), items: [] };
	}

	/**
	 * Observe-first shadow/planning pass (see context/context-prompt-policy.ts): re-shapes
	 * the audit report into a per-item policy plan whose `appliedAction` is always
	 * "keep_raw" -- this never enforces anything, it only records what the policy engine
	 * would say. Never throws into a live turn: any failure degrades to an empty report.
	 */
	runPromptPolicyPlanning(auditReport: ContextAuditReport): PromptPolicyShadowReport {
		try {
			const report = planPromptPolicy(auditReport);
			this._latestPromptPolicyReport = report;
			return report;
		} catch {
			const report: PromptPolicyShadowReport = { turnIndex: this.deps.getTurnIndex(), items: [] };
			this._latestPromptPolicyReport = report;
			return report;
		}
	}

	/**
	 * Read-only inspection of the shadow policy plan. With `messages`, recomputes fresh
	 * (audit + plan) against the given array; without, returns the last plan computed
	 * during a real transform pass. Never mutates messages/transcript/artifact refs.
	 */
	getPromptPolicyReport(messages?: AgentMessage[]): PromptPolicyShadowReport {
		if (messages) return this.runPromptPolicyPlanning(this.runContextAudit(messages));
		return this._latestPromptPolicyReport ?? { turnIndex: this.deps.getTurnIndex(), items: [] };
	}

	/**
	 * Report-only correlation between the shadow plan just computed this turn and what the
	 * legacy context-gc pass actually packed. Runs after `applyContextGc()` has already
	 * produced its report; never influences context-gc itself. Never throws into a live
	 * turn: any failure degrades to an empty correlation.
	 */
	correlatePromptPolicyWithContextGc(gcReport: ContextGcReport): void {
		const shadowReport = this._latestPromptPolicyReport ?? { turnIndex: this.deps.getTurnIndex(), items: [] };
		try {
			this._latestPromptPolicyGcCorrelation = correlateWithContextGc(shadowReport, gcReport);
		} catch {
			this._latestPromptPolicyGcCorrelation = { turnIndex: this.deps.getTurnIndex(), entries: [] };
		}
	}

	/** Read-only inspection of the latest shadow-plan/legacy-gc correlation, for tests/debugging. */
	getPromptPolicyGcCorrelation(): PromptPolicyGcCorrelationReport {
		return this._latestPromptPolicyGcCorrelation ?? { turnIndex: this.deps.getTurnIndex(), entries: [] };
	}

	/**
	 * First enforcement pilot (see context/context-prompt-enforcement.ts): opt-in,
	 * default-disabled stub-in-place of stale artifact-backed tool_output results in the
	 * provider-visible message array only. Runs on `messages` AFTER context-gc has already
	 * produced its own result, so legacy context-gc's own packing/reporting is completely
	 * unaffected by this pass -- it only ever acts on messages gc left untouched this turn.
	 * Never throws into a live turn: any failure degrades to returning `messages` unchanged.
	 */
	runPromptEnforcement(
		messages: AgentMessage[],
		shadowReport: PromptPolicyShadowReport,
	): { messages: AgentMessage[]; report: PromptEnforcementReport } {
		try {
			const persistedSettings = this.deps.getSettingsManager().getContextPromptEnforcementSettings();
			const curationEnabled = this.deps.getSettingsManager().getContextCurationSettings().enabled;
			const settings = {
				...persistedSettings,
				// Runtime fact, never assumed: artifact_retrieve is a companion affordance
				// (auto-activated alongside grep/find), not a default/global tool, so active
				// tools can differ turn to turn -- see context-prompt-enforcement.ts's doc
				// comment on why this is checked separately from hasAvailableRetrievalPath.
				retrievalToolAvailable: this.deps.getActiveToolNames().includes("artifact_retrieve"),
				brainRelevance: curationEnabled ? (itemId: string) => this._brainCurator.getRelevance(itemId) : undefined,
			};
			const result = enforcePromptPolicy(messages, shadowReport, settings);
			this._latestPromptEnforcementReport = result.report;
			return result;
		} catch {
			const report: PromptEnforcementReport = { turnIndex: this.deps.getTurnIndex(), items: [] };
			this._latestPromptEnforcementReport = report;
			return { messages, report };
		}
	}

	/**
	 * Enqueue relevance-scoring jobs for stale, artifact-backed tool outputs the enforcement
	 * pilot could act on. Pure queueing — the verdicts only ever take effect through the
	 * asymmetric advisory lever inside enforcePromptPolicy. Never throws into a turn.
	 */
	enqueueRelevanceCuration(messages: AgentMessage[], shadowReport: PromptPolicyShadowReport): void {
		try {
			const settings = this.deps.getSettingsManager().getContextCurationSettings();
			if (!settings.enabled) return;
			const goal = latestUserPromptText(messages).slice(0, 400);
			for (const item of shadowReport.items) {
				if (!item.hasAvailableRetrievalPath) continue;
				const message = messages[item.messageIndex];
				if (!message || message.role !== "toolResult" || message.toolCallId !== item.toolCallId) continue;
				if (message.isError) continue;
				const details = message.details as
					| { contextGc?: { packed?: unknown }; promptPolicy?: { enforced?: unknown } }
					| undefined;
				if (details?.contextGc?.packed === true || details?.promptPolicy?.enforced === true) continue;
				const text = message.content
					.filter((part): part is { type: "text"; text: string } => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				if (text.length === 0) continue;
				this._brainCurator.enqueue({ kind: "relevance", key: item.itemId, content: text.slice(0, 4000), goal });
			}
		} catch {
			// curation is a sidecar; it must never disrupt a turn
		}
	}

	/**
	 * Drain gate: settings on, model configured+authed, and the model has PASSED the digest
	 * fitness probe on THIS host (design: unfit or unprobed models are refused with a visible
	 * reason, never silently degraded). Fire-and-forget; never throws into a turn.
	 */
	/**
	 * Resolve the curation model IFF every gate passes: setting enabled, model configured,
	 * resolvable+authed, and digest-fitness-proven on THIS host (canonical "provider/id" ref —
	 * runModelFitness stores reports under it, while settings.model may be a bare id or pattern).
	 * Sets _lastCurationSkipReason on refusal; never throws.
	 */
	resolveCurationModelIfFit(): Model<Api> | undefined {
		const settings = this.deps.getSettingsManager().getContextCurationSettings();
		if (!settings.enabled) {
			// Never surface a stale refusal reason for a feature the user has since disabled.
			this._lastCurationSkipReason = undefined;
			return undefined;
		}
		if (!settings.model) {
			this._lastCurationSkipReason = "curation_model_unset";
			return undefined;
		}
		const resolved = resolveCliModel({ cliModel: settings.model, modelRegistry: this.deps.getModelRegistry() });
		if (!resolved.model || !this.deps.getModelRegistry().hasConfiguredAuth(resolved.model)) {
			this._lastCurationSkipReason = "curation_model_unresolved";
			return undefined;
		}
		const canonicalRef = `${resolved.model.provider}/${resolved.model.id}`;
		const fitness = FitnessStore.forAgentDir(this.deps.getAgentDir())
			.getForHost()
			.find((entry) => entry.model === canonicalRef);
		const verdict = evaluateSurfaceFitness("curation", fitness?.report);
		if (!verdict.fit) {
			this._lastCurationSkipReason =
				verdict.reason === "unprobed" ? "curation_model_unprobed" : "curation_model_digest_unfit";
			return undefined;
		}
		this._lastCurationSkipReason = undefined;
		return resolved.model;
	}

	maybeDrainBrainCuration(): void {
		try {
			if (!this._brainCurator.hasWork() || this._brainCurator.isDraining) return;
			const model = this.resolveCurationModelIfFit();
			if (!model) return;
			const settings = this.deps.getSettingsManager().getContextCurationSettings();
			void this._drainBrainCuration(model, settings.maxJobsPerTurn);
		} catch {
			// curation is a sidecar; it must never disrupt a turn
		}
	}

	/**
	 * Compaction pre-digest gate (design surface 3): everything the drain gate requires PLUS a
	 * RUNTIME reliability proof — the curator must have run >=5 jobs on this session with a parse
	 * failure rate <=5% before it is trusted to pre-digest compaction input. Returns undefined
	 * (verbatim compaction, byte-for-byte today's behavior) whenever any gate refuses.
	 */
	buildCompactionPreDigest(): ((text: string, signal?: AbortSignal) => Promise<string>) | undefined {
		try {
			const model = this.resolveCurationModelIfFit();
			if (!model) return undefined;
			const telemetry = this._brainCurator.telemetry();
			if (telemetry.jobsRun < 5 || telemetry.parseFailures / telemetry.jobsRun > 0.05) {
				this._lastPreDigestSkipReason = "curation_predigest_reliability_unproven";
				return undefined;
			}
			this._lastPreDigestSkipReason = undefined;
			return async (text, signal) => {
				const result = await preDigestConversationText({
					text,
					signal,
					complete: async ({ systemPrompt, userPrompt, signal: chunkSignal }) => {
						const completion = await this.deps.runIsolatedCompletion({
							systemPrompt,
							messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
							model,
							thinkingLevel: "off",
							maxTokens: 512,
							signal: chunkSignal,
							cacheRetention: "short",
						});
						return {
							text: completion.text,
							costUsd: completion.usage.cost.total,
							stopReason: String(completion.stopReason),
						};
					},
				});
				if (!this.deps.isDisposed() && result.totalChunks > 0) {
					this.deps.getSessionManager().appendCustomEntry("brain-curation-predigest", {
						version: 1,
						totalChunks: result.totalChunks,
						digested: result.digested,
						failed: result.failed,
						charsBefore: text.length,
						charsAfter: result.text.length,
					});
				}
				return result.text;
			};
		} catch {
			return undefined;
		}
	}

	private async _drainBrainCuration(model: Model<Api>, maxJobs: number): Promise<void> {
		try {
			// ACCUMULATE across all drained jobs (the drain runs the completer once PER job) —
			// keeping only the last job's usage would under-report every multi-job drain.
			let spentUsage: AssistantMessage["usage"] | undefined;
			const results = await this._brainCurator.drain({
				maxJobs,
				complete: async ({ systemPrompt, userPrompt, signal }) => {
					const completion = await this.deps.runIsolatedCompletion({
						systemPrompt,
						messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
						model,
						thinkingLevel: "off",
						maxTokens: 256,
						signal,
						// Both curation system prompts are static — the provider can cache the prefix.
						cacheRetention: "short",
					});
					const usage = completion.usage;
					if (!spentUsage) {
						spentUsage = structuredClone(usage);
					} else {
						spentUsage.input += usage.input;
						spentUsage.output += usage.output;
						spentUsage.cacheRead += usage.cacheRead;
						spentUsage.cacheWrite += usage.cacheWrite;
						spentUsage.totalTokens += usage.totalTokens;
						spentUsage.cost.input += usage.cost.input;
						spentUsage.cost.output += usage.cost.output;
						spentUsage.cost.cacheRead += usage.cost.cacheRead;
						spentUsage.cost.cacheWrite += usage.cost.cacheWrite;
						spentUsage.cost.total += usage.cost.total;
					}
					return {
						text: completion.text,
						costUsd: completion.usage.cost.total,
						stopReason: String(completion.stopReason),
					};
				},
			});
			// Honest accounting even for free local models: token visibility is the contract.
			if (spentUsage && (spentUsage.cost.total > 0 || spentUsage.totalTokens > 0)) {
				this.deps.addSpawnedUsage(spentUsage, { label: "context-curator" });
			}
			if (this.deps.isDisposed() || results.length === 0) return;
			this.deps.getSessionManager().appendCustomEntry("brain-curation", {
				version: 1,
				results: results.map((result) => ({
					key: result.key,
					kind: result.kind,
					ok: result.ok,
					ms: result.ms,
					...(result.digest !== undefined ? { digest: result.digest } : {}),
					...(result.relevant !== undefined ? { relevant: result.relevant, confidence: result.confidence } : {}),
				})),
				telemetry: this._brainCurator.telemetry(),
			});
		} catch {
			// curation is a sidecar; it must never disrupt a turn
		}
	}

	/** Curation status for diagnostics/dashboard: settings, live telemetry, last refusal reason. */
	getContextCurationStatus(): {
		enabled: boolean;
		model?: string;
		telemetry: CurationTelemetrySnapshot;
		lastSkipReason?: string;
		lastPreDigestSkipReason?: string;
	} {
		const settings = this.deps.getSettingsManager().getContextCurationSettings();
		return {
			enabled: settings.enabled,
			model: settings.model,
			telemetry: this._brainCurator.telemetry(),
			lastSkipReason: this._lastCurationSkipReason,
			lastPreDigestSkipReason: this._lastPreDigestSkipReason,
		};
	}

	/** Read-only inspection of the latest prompt-enforcement report, for tests/debugging. */
	getPromptEnforcementReport(): PromptEnforcementReport {
		return this._latestPromptEnforcementReport ?? { turnIndex: this.deps.getTurnIndex(), items: [] };
	}

	applyContextGc(
		messages: AgentMessage[],
		writePayloads: boolean,
	): { messages: AgentMessage[]; report: ContextGcReport } {
		try {
			const settings = this.deps.getSettingsManager().getContextGcSettings();
			// Merge the ACTIVE memory providers' own page markers (e.g. transcript-recall's
			// "<memory_context") into the semantic-memory marker list. The settings default is
			// provider-agnostic and non-empty, so without this merge the recall pages the bundled
			// default provider actually emits are never recognized as semantic-memory pages and
			// accumulate raw for the life of the session — the exact growth Bug #7 GC exists to stop.
			const providerMarkers = this.deps.getMemoryManager().getContextMarkers();
			const curationSettings = this.deps.getSettingsManager().getContextCurationSettings();
			const result = applyContextGc(messages, {
				...settings,
				semanticMemory: {
					...settings.semanticMemory,
					markers: [...new Set([...settings.semanticMemory.markers, ...providerMarkers])],
				},
				cwd: this.deps.getCwd(),
				storageDir: this._contextGcStorageDir(),
				writePayloads,
				curation: curationSettings.enabled
					? {
							resolveDigest: (digestKey) => {
								const digest = this._brainCurator.getDigest(digestKey);
								// Count serves on the REAL per-turn pass only, never the report path.
								if (digest !== undefined && writePayloads) this._brainCurator.noteDigestServed();
								return digest;
							},
							// Only the real per-turn pass enqueues work; the read-only report path
							// (writePayloads=false) stays side-effect free.
							onPacked: writePayloads
								? (record, originalText) => {
										this._brainCurator.enqueue({
											kind: "stub_digest",
											key: record.key ?? record.toolCallId,
											content: originalText,
										});
									}
								: undefined,
						}
					: undefined,
			});
			this._latestContextGcReport = result.report;
			// Only release/reclaim on the real per-turn pass (writePayloads=true), never on
			// the read-only status-report path (getContextGcReport with writePayloads=false),
			// so merely inspecting the report can't have side effects.
			if (writePayloads && result.report.packedCount > 0) {
				this._releaseGcPackedArtifactReferences(messages, result.report);
			}
			return result;
		} catch {
			const report: ContextGcReport = {
				enabled: false,
				packedCount: 0,
				originalTokens: 0,
				packedTokens: 0,
				savedTokens: 0,
				records: [],
			};
			this._latestContextGcReport = report;
			return { messages, report };
		}
	}

	/**
	 * Reference-release + cleanup lifecycle: once context-gc has packed a grep/find tool
	 * result out of the live prompt (the message is no longer current/active working
	 * context -- see contracts-and-retention.md's "ephemeral"/"expired" retention
	 * classes), release the pack-time reference `packToolOutput()` registered for it, and
	 * opportunistically reclaim now-unreferenced artifacts. This is the other half of the
	 * D2b-1 gate: artifacts were being registered but never released, so they accumulated
	 * for the life of the session.
	 *
	 * `record.toolCallId` (from context-gc's packed record) is exactly the holder id
	 * `packToolOutput()` used when it called `addReference()` -- both trace back to the
	 * same tool call's id -- so no separate bookkeeping is needed to find it.
	 */
	private _releaseGcPackedArtifactReferences(messages: AgentMessage[], report: ContextGcReport): void {
		const store = this._toolArtifactStore;
		if (!store) return; // no store was ever constructed, so nothing could have been packed to one

		let releasedAny = false;
		for (const record of report.records) {
			if (record.toolName !== "grep" && record.toolName !== "find") continue;
			const artifactId = extractArtifactId(messages[record.messageIndex]);
			if (!artifactId) continue;
			if (store.removeReference(artifactId, record.toolCallId)) releasedAny = true;
		}
		// Cleanup only runs immediately after a release actually happened in this pass, so
		// a long session doesn't re-scan the artifact directory on every turn once nothing
		// new became eligible for release.
		if (releasedAny) store.cleanup();
	}

	getContextGcReport(messages?: AgentMessage[]): ContextGcReport {
		if (messages) return this.applyContextGc(messages, false).report;
		return (
			this._latestContextGcReport ?? {
				enabled: this.deps.getSettingsManager().getContextGcSettings().enabled,
				packedCount: 0,
				originalTokens: 0,
				packedTokens: 0,
				savedTokens: 0,
				records: [],
			}
		);
	}

	estimateCurrentContextTokens(messages: AgentMessage[]): number {
		const estimate = estimateContextTokens(messages);
		if (estimate.lastUsageIndex === null) {
			return this._tokenBudget.estimateDelta(estimateConversationChars(messages));
		}

		const usageMessage = messages[estimate.lastUsageIndex];
		const compactionEntry = getLatestCompactionEntry(this.deps.getSessionManager().getBranch());
		if (usageMessage?.role !== "assistant" || !compactionEntry) {
			return estimate.tokens;
		}
		const usageTimestamp = (usageMessage as AssistantMessage).timestamp;
		const compactionTimestamp = new Date(compactionEntry.timestamp).getTime();
		if (usageTimestamp <= compactionTimestamp) {
			return this._tokenBudget.estimateDelta(estimateConversationChars(messages));
		}

		const coveredChars = estimateConversationChars(messages, 0, estimate.lastUsageIndex + 1);
		const deltaChars = estimateConversationChars(messages, estimate.lastUsageIndex + 1, messages.length);
		this._tokenBudget.anchor(estimate.usageTokens, coveredChars);
		return this._tokenBudget.current(deltaChars, estimate.tokens);
	}
}

/**
 * Estimate covered characters from the provider-visible context messages.
 */
function estimateConversationChars(messages: AgentMessage[], start = 0, end = messages.length): number {
	let total = 0;
	for (let index = Math.max(0, start); index < Math.min(messages.length, end); index++) {
		const message = messages[index];
		if (!message) continue;
		const rawContent = (message as { content?: unknown }).content;
		if (typeof rawContent === "string") {
			total += rawContent.length;
			continue;
		}
		if (!Array.isArray(rawContent)) {
			continue;
		}
		for (const block of rawContent) {
			if (typeof block === "string") {
				total += block.length;
				continue;
			}
			if (!block || typeof block !== "object") {
				continue;
			}
			if (typeof (block as { text?: unknown }).text === "string") {
				total += (block as { text?: string }).text?.length ?? 0;
			}
			if (typeof (block as { thinking?: unknown }).thinking === "string") {
				total += (block as { thinking?: string }).thinking?.length ?? 0;
			}
		}
	}
	return total;
}
