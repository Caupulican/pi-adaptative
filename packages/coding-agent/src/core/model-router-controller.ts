/**
 * Model-router turn routing: the session's per-turn model-selection subsystem — the regex/executor
 * route resolver, the optional bounded routing judge, the executor lane (Level-0 toolkit direct hit
 * + speculative brain-refined retry), the per-tier thinking/tool-surface swap around a routed turn,
 * the cheap-research-turn session buffer with mutating-tool escalation to an expensive retry, and
 * the router status/diagnostics report.
 *
 * Extracted verbatim from agent-session.ts (god-file decomposition). Owns the transient per-turn
 * route state — the active intent/route, the cheap-turn session buffer, the escalation-requested and
 * retry-in-flight flags — and the sticky last-decision/last-skip-reason/last-intent used by the
 * status report. Everything else it needs — the live agent + its state, the current model, the
 * session/settings managers, the model registry, the agent dir, the session-disposal abort signal for
 * isolated judge completions, the base system prompt, the isolated-completion primitive, spawned-usage
 * accounting, the event/telemetry
 * emitters, and the recently-extracted BackgroundLaneController (resolveLaneModel) / ContextPipeline
 * (resolveCurationModelIfFit) collaborators — is reached through narrow deps accessors rather than the
 * whole AgentSession.
 *
 * Drive-path boundary (deliberate): the actual agent.prompt()/continue() loop belongs to the
 * session-owned ForegroundRecoveryController; this controller's parallel routed drive path
 * ({@link runRoutedTurn}) owns only route decision/escalation/tier bookkeeping and delegates every
 * agent turn through {@link ModelRouterControllerDeps.runAgentPrompt}, so the drive loop is never duplicated. The
 * host keeps a one-line delegation at each call-in: the routing prep + routed-turn entry in
 * _promptUnserialized, the beforeToolCall MUTATION escalation branch ({@link
 * maybeEscalateToolCall}), the tool-name-agnostic VALIDATION-FAILURE escalation branch for cloud
 * models ({@link requestValidationFailureEscalation} — de-conflated from the mutation gate; see the
 * capability-gate spine doctrine, which routes local/managed models to an evidence-gated
 * native→phone auto-probe on AgentSession instead), the message_end cheap-turn buffering ({@link
 * captureSessionMessage}), the retry-event suppression ({@link isRetryInFlight}), the public
 * getModelRouterStatus / autonomy-telemetry reads, and the tier resolution's consultation of the
 * persisted `/toolprobe` verdict for local/managed tier models ({@link
 * ModelRouterControllerDeps.getToolProbeVerdict}).
 */

import type { Agent, AgentMessage, ThinkingLevel } from "@caupulican/pi-agent-core";
import type { SessionManager, SessionMessageBatchEntry } from "@caupulican/pi-agent-core/node";
import type { Api, Message, Model, Usage } from "@caupulican/pi-ai";
import { clampThinkingLevel, modelsAreEqual } from "@caupulican/pi-ai/models";
import type {
	AgentSessionEvent,
	IsolatedCompletionOptions,
	IsolatedCompletionResult,
} from "./agent-session-contracts.ts";
import type { RouteDecision } from "./autonomy/contracts.ts";
import { AUTONOMY_TELEMETRY_EVENT_TYPES, type AutonomyTelemetryEvent } from "./autonomy/telemetry-events.ts";
import { latestUserPromptText } from "./context/message-text.ts";
import { runIsolatedTextCompletion } from "./isolated-text-completion.ts";
import { deriveModelCapabilityProfile, filterToolNamesForCapability } from "./model-capability.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { resolveCliModel } from "./model-resolver.ts";
import { collectModelRouterConfigDiagnostics } from "./model-router/config-diagnostics.ts";
import { classifyExecutorTurn } from "./model-router/executor-route.ts";
import {
	evaluateSurfaceFitness,
	type FitnessGatedSurface,
	type FitnessGateVerdict,
} from "./model-router/fitness-gate.ts";
import { classifyModelRouterRoute, type ModelRouterIntent } from "./model-router/intent-classifier.ts";
import { ROUTE_JUDGE_MAX_OUTPUT_TOKENS, runRouteJudge } from "./model-router/route-judge.ts";
import {
	bufferModelRouterSessionCustomMessage,
	bufferModelRouterSessionMessage,
	createModelRouterSessionBuffer,
	flushModelRouterSessionBuffer,
	flushModelRouterSessionBufferPrefix,
	type ModelRouterSessionBuffer,
} from "./model-router/session-buffer.ts";
import {
	formatModelRouterStatus,
	getRecentModelRouterDecisions,
	MODEL_ROUTER_DECISION_CUSTOM_TYPE,
	type ModelRouterDecisionStatus,
	type ModelRouterFailoverStatus,
	type ModelRouterFitnessStatuses,
} from "./model-router/status.ts";
import { isLocalOrManagedRouterModel, shouldEscalateModelRouterTool } from "./model-router/tool-escalation.ts";
import type { ModelToolProbeVerdict } from "./models/adaptation-store.ts";
import { FitnessStore } from "./models/fitness-store.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { reportSpawnedUsage } from "./spawned-usage.ts";
import { runReflexInterpreterCompletion } from "./toolkit/reflex-interpreter.ts";

/** Canonical `provider/id` label for a routed/resolved model, as it appears in decisions and status. */
export function formatModelRouterModel(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

const ROUTE_JUDGE_STATIC_FAST_PATH_REASON_CODES = new Set([
	"empty_prompt",
	"read_only_question",
	"release_or_publish",
	"security_or_auth",
	"destructive_or_git_history",
	"settings_or_self_modification",
	"architecture_or_ambiguous",
]);

function shouldSkipRouteJudgeForStaticDecision(decision: RouteDecision): boolean {
	return ROUTE_JUDGE_STATIC_FAST_PATH_REASON_CODES.has(decision.reasonCode);
}

function withJudgeUnavailableFallback(decision: RouteDecision, reason: string): RouteDecision {
	return {
		...decision,
		reasonCode: "judge_unavailable_fallback",
		reasons: [...decision.reasons, reason],
	};
}

function persistModelRouterDecision(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	decision: ModelRouterDecisionStatus,
): void {
	sessionManager.appendCustomEntry(MODEL_ROUTER_DECISION_CUSTOM_TYPE, decision);
}

export interface ModelRouterControllerDeps {
	/** Live agent — the controller reads/writes agent.state.{model,thinkingLevel,tools,systemPrompt,messages}
	 * for the per-turn tier swap and aborts it on a mutating-tool escalation. */
	getAgent(): Agent;
	/** Current session model, used to decide whether a routed turn actually swaps the model. */
	getModel(): Model<Api> | undefined;
	/** Router/executor/judge/thinking settings + capability mode (all opt-in gates). */
	getSettingsManager(): SettingsManager;
	/** Session log: routed-turn message buffering/persistence, decision persistence, recent-decision status. */
	getSessionManager(): SessionManager;
	/** Canonical host-owned mixed message batch persistence; one validated publication for lifecycle linking. */
	appendSessionMessageBatch(batch: readonly SessionMessageBatchEntry[]): string[];
	/** Resolves configured route/judge/executor model patterns against configured auth. */
	getModelRegistry(): ModelRegistry;
	/** Session-scoped provider/model quota exhaustion guard. */
	isModelExhausted(model: Model<Api>): boolean;
	/** Status snapshot for exhausted models and the last failover notice. */
	getFailoverStatus(): ModelRouterFailoverStatus;
	/** Root dir the host-keyed {@link FitnessStore} lives under (executor tool-call fitness gate). */
	getAgentDir(): string;
	/** Aborts the judge's bounded completion when the session is disposed. */
	getReflectionSignal(): AbortSignal;
	/** Base (extension-free) system prompt — the tier swap only sheds tools when the turn is on it. */
	getBaseSystemPrompt(): string;
	/** The session-owned foreground drive loop; the routed path delegates every turn here. The
	 * submission's cancellation signal rides along so the drive loop can read it before the run. */
	runAgentPrompt(messages: AgentMessage | AgentMessage[], signal?: AbortSignal): Promise<void>;
	/** Continue from canonical history after a committed cheap-route escalation. */
	runAgentContinuation(signal?: AbortSignal): Promise<void>;
	/** Rebuilds the system prompt for a filtered tool surface (routed-model capability shedding). */
	buildSystemPromptForToolNames(toolNames: string[]): string;
	/** Re-resolves the restored model against the registry after a routed turn (provider override safety). */
	refreshCurrentModelFromRegistry(): void;
	/** One-shot, tool-less LLM call — the routing judge and the executor reflex-brain warmup ride this. */
	runIsolatedCompletion(opts: IsolatedCompletionOptions): Promise<IsolatedCompletionResult>;
	/** Rolls judge/brain spend into spawned-usage accounting. `reportId` is REQUIRED: every
	 * caller derives a stable id from the work unit's identity so a retry cannot double-count. */
	addSpawnedUsage(
		usage: Usage,
		opts: { label?: string; sourceSessionId?: string; reportId: string },
	): string | undefined;
	/** Session event stream (executor-miss warning). */
	emit(event: AgentSessionEvent): void;
	/** Autonomy telemetry stream (one route-decision event per user-facing routed turn). */
	emitAutonomyTelemetry(event: AutonomyTelemetryEvent): void;
	/** Resolves the judge model pattern via {@link BackgroundLaneController}. */
	resolveLaneModel(pattern: string): Model<Api> | undefined;
	/** Fitness-gated reflex-brain model via {@link ContextPipeline} (executor speculative refinement). */
	resolveCurationModelIfFit(): Model<Api> | undefined;
	/** Persisted `/toolprobe` verdict for this model (native / text-protocol / none), or undefined
	 * when never probed. Tier-resolution's consultation reads this ONLY for local/managed models
	 * ({@link isLocalOrManagedRouterModel}); cloud models never call it. */
	getToolProbeVerdict(model: Model<Api>): ModelToolProbeVerdict | undefined;
}

/**
 * Owns the model-router turn routing extracted from {@link AgentSession}. See the module header for the
 * drive-path boundary that keeps the agent.prompt()/continue() loop in its foreground lifecycle owner.
 */
export class ModelRouterController {
	/** Active model-router intent for the current transient routed turn, if any. */
	private _activeModelRouterIntent?: ModelRouterIntent;
	private _activeModelRouterRoute?: RouteDecision;
	private _modelRouterSessionBuffer?: ModelRouterSessionBuffer;
	private _modelRouterEscalationRequested = false;
	private _isModelRouterRetry = false;
	private _lastModelRouterDecision?: ModelRouterDecisionStatus;
	private _lastModelRouterSkipReason?: string;
	private _lastModelRouterIntent?: ModelRouterIntent;

	private readonly deps: ModelRouterControllerDeps;

	constructor(deps: ModelRouterControllerDeps) {
		this.deps = deps;
	}

	/** True while the escalation retry turn is running, so the host can suppress its duplicate prompt events. */
	isRetryInFlight(): boolean {
		return this._isModelRouterRetry;
	}

	/** Latest completed route decision (sticky), for the autonomy telemetry snapshot. */
	getLastDecision(): ModelRouterDecisionStatus | undefined {
		return this._lastModelRouterDecision;
	}

	/**
	 * beforeToolCall escalation gate: a cheap research turn that reaches for a mutating tool aborts the
	 * turn and requests a retry on the expensive model. Returns the block result the host hook forwards,
	 * or undefined when no escalation is required.
	 */
	maybeEscalateToolCall(toolName: string, args: unknown): { block: true; reason: string } | undefined {
		if (
			this._activeModelRouterRoute &&
			shouldEscalateModelRouterTool({
				tier: this._activeModelRouterRoute.tier,
				toolName,
				args,
				reasonCode: this._activeModelRouterRoute.reasonCode,
			})
		) {
			this._modelRouterEscalationRequested = true;
			this.deps.getAgent().abort();
			return {
				block: true,
				reason:
					"Model router escalation required: a cheap research turn attempted a mutating tool. Retry the turn on the configured expensive model.",
			};
		}
		return undefined;
	}

	/**
	 * Tool-name-agnostic validation-failure escalation gate, called from
	 * AgentSession's onToolValidationEscalation handler for a CLOUD model only — see the
	 * capability-gate-spine doctrine (local/managed models never reach this method; they trigger
	 * the evidence-gated native→phone auto-probe instead). Unlike {@link maybeEscalateToolCall} (the
	 * beforeToolCall MUTATION gate, still governed by `shouldEscalateModelRouterTool`/
	 * READ_ONLY_TOOL_NAMES — a legitimate, unrelated mutation-blast-radius policy), "the model
	 * repeatedly cannot construct valid arguments for this tool" is evidence about the MODEL's
	 * capability, not about the tool's mutation status, so a read-only tool's repeated validation
	 * failure now escalates a cheap routed turn exactly like a mutating tool's would — takes no
	 * tool-name/args input at all (unlike maybeEscalateToolCall), because every repeated validation
	 * failure escalates regardless of which tool or model triggered it. No-op outside an active
	 * cheap-tier routed turn, same scoping as maybeEscalateToolCall.
	 */
	requestValidationFailureEscalation(): void {
		if (this._activeModelRouterRoute?.tier !== "cheap") return;
		this._modelRouterEscalationRequested = true;
		this.deps.getAgent().abort();
	}

	/**
	 * message_end hook: while a cheap routed turn is buffering, capture its messages into the session
	 * buffer instead of persisting them (they are flushed on success or discarded on escalation).
	 * Returns true when the message was buffered, so the host skips its own persistence.
	 */
	captureSessionMessage(message: AgentMessage): boolean {
		const modelRouterBuffer = this._modelRouterSessionBuffer;
		if (!modelRouterBuffer || modelRouterBuffer.committed) return false;
		if (message.role === "custom") {
			bufferModelRouterSessionCustomMessage(modelRouterBuffer, message);
			return true;
		}
		if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
			bufferModelRouterSessionMessage(modelRouterBuffer, message as Message);
			return true;
		}
		return false;
	}

	/**
	 * Commit a cheap routed turn's buffered messages in their original source order.
	 *
	 * The lifecycle adapter uses this at the tool reservation boundary: once the assistant
	 * message is durable, later tool-result messages must go through the normal message-end
	 * path and an escalation may continue from canonical history instead of splicing it away.
	 * The buffer is marked committed only after every append succeeds; a failed append therefore
	 * rejects the reservation and the tool body is never entered.
	 */
	commitSessionBuffer(): Map<AgentMessage, string> {
		const modelRouterBuffer = this._modelRouterSessionBuffer;
		if (!modelRouterBuffer) return new Map();
		return flushModelRouterSessionBuffer(modelRouterBuffer, (batch) => this.deps.appendSessionMessageBatch(batch));
	}

	/** Commit only the prompt prefix before a provider request; keep the assistant/tool suffix buffered. */
	commitSessionBufferPrefix(): Map<AgentMessage, string> {
		const modelRouterBuffer = this._modelRouterSessionBuffer;
		if (!modelRouterBuffer) return new Map();
		return flushModelRouterSessionBufferPrefix(modelRouterBuffer, (batch) =>
			this.deps.appendSessionMessageBatch(batch),
		);
	}

	/** Whether a cheap routed turn has crossed its durable tool-boundary commit. */
	isSessionBufferCommitted(): boolean {
		return this._modelRouterSessionBuffer?.committed === true;
	}

	private _isModelAvailableAndAuthed(pattern: string): boolean {
		const resolved = resolveCliModel({ cliModel: pattern, modelRegistry: this.deps.getModelRegistry() });
		if (!resolved.model) return false;
		return this.deps.getModelRegistry().hasConfiguredAuth(resolved.model);
	}

	private _evaluateModelFitness(surface: FitnessGatedSurface, model: Model<Api>): FitnessGateVerdict {
		const fitness = FitnessStore.forAgentDir(this.deps.getAgentDir())
			.getForHost()
			.find((entry) => entry.model === formatModelRouterModel(model));
		return evaluateSurfaceFitness(surface, fitness?.report);
	}

	private _formatFitnessFailure(verdict: Exclude<FitnessGateVerdict, { fit: true }>): string {
		return verdict.reason === "unprobed" ? "unprobed" : `${verdict.lane} ${verdict.succeeded}/${verdict.total}`;
	}

	private _routerSurfaceForTier(tier: "cheap" | "medium" | "expensive"): FitnessGatedSurface {
		return tier === "cheap" ? "router_cheap" : tier === "medium" ? "router_medium" : "router_expensive";
	}

	private _getRouterTierFitnessStatuses(): ModelRouterFitnessStatuses {
		const settings = this.deps.getSettingsManager().getModelRouterSettings();
		const statuses: ModelRouterFitnessStatuses = {};
		for (const tier of ["cheap", "medium", "expensive"] as const) {
			const pattern =
				tier === "cheap" ? settings.cheapModel : tier === "medium" ? settings.mediumModel : settings.expensiveModel;
			if (!pattern) continue;
			const resolved = resolveCliModel({ cliModel: pattern, modelRegistry: this.deps.getModelRegistry() });
			if (!resolved.model || !this.deps.getModelRegistry().hasConfiguredAuth(resolved.model)) continue;
			const verdict = this._evaluateModelFitness(this._routerSurfaceForTier(tier), resolved.model);
			statuses[tier] = verdict.fit
				? { status: verdict.probed ? "fit" : "unprobed" }
				: verdict.reason === "unprobed"
					? { status: "unprobed" }
					: { status: "unfit", lane: verdict.lane, succeeded: verdict.succeeded, total: verdict.total };
		}
		return statuses;
	}

	private _resolveExpensiveFallbackRoute(
		decision: RouteDecision,
		reasonCode: string,
		reason: string,
	): { decision: RouteDecision; model: Model<Api> } | undefined {
		const settings = this.deps.getSettingsManager().getModelRouterSettings();
		const expensivePattern = settings.expensiveModel;
		if (!expensivePattern || !this._isModelAvailableAndAuthed(expensivePattern)) return undefined;
		const resolvedExpensive = resolveCliModel({
			cliModel: expensivePattern,
			modelRegistry: this.deps.getModelRegistry(),
		});
		if (!resolvedExpensive.model) return undefined;
		if (this.deps.isModelExhausted(resolvedExpensive.model)) {
			this._lastModelRouterSkipReason = "expensive model exhausted: quota";
			return undefined;
		}
		if (settings.fitnessGate) {
			const verdict = this._evaluateModelFitness("router_expensive", resolvedExpensive.model);
			if (!verdict.fit) {
				this._lastModelRouterSkipReason = `expensive model unfit: ${this._formatFitnessFailure(verdict)} (fitness gate)`;
				return undefined;
			}
		}
		decision.fallbackFrom = "medium";
		decision.tier = "expensive";
		decision.reasonCode = reasonCode;
		decision.reasons = [...decision.reasons, reason];
		decision.model = formatModelRouterModel(resolvedExpensive.model);
		this._lastModelRouterSkipReason = undefined;
		return { decision, model: resolvedExpensive.model };
	}

	private _resolveExecutorRoute(
		prompt: string,
		executorPattern: string | undefined,
	): { decision: RouteDecision; model: Model<Api> } | undefined {
		if (!executorPattern) return undefined;
		try {
			const verdict = classifyExecutorTurn(prompt, this.deps.getSettingsManager().getToolkitScripts());
			if (!verdict.execute) return undefined;
			const resolved = resolveCliModel({ cliModel: executorPattern, modelRegistry: this.deps.getModelRegistry() });
			if (!resolved.model || !this.deps.getModelRegistry().hasConfiguredAuth(resolved.model)) return undefined;
			// Fitness gate: the executor must have PROVEN tool-calling on this host (same
			// canonical-ref discipline as the curation gate).
			if (!this._evaluateModelFitness("executor", resolved.model).fit) return undefined;
			this._lastModelRouterIntent = "research";
			return {
				decision: {
					tier: "cheap",
					risk: "scoped-write",
					confidence: 1,
					reasonCode: "executor_direct",
					reasons: [`Executor lane: Level-0 direct hit on toolkit script "${verdict.scriptName}"`],
				},
				model: resolved.model,
			};
		} catch {
			return undefined;
		}
	}

	/** True if a run_toolkit_script tool result since `fromIndex` actually EXECUTED (not error/ambiguous). */
	private _executorTurnExecutedScript(fromIndex: number): boolean {
		for (const message of this.deps.getAgent().state.messages.slice(fromIndex)) {
			if ((message as { role?: string }).role !== "toolResult") continue;
			if ((message as { toolName?: string }).toolName !== "run_toolkit_script") continue;
			if ((message as { isError?: boolean }).isError === true) continue;
			const outcome = (message as { details?: { outcome?: unknown } }).details?.outcome;
			if (outcome === "executed") return true;
		}
		return false;
	}

	/** Ask the reflex brain to refine the last user request into an explicit toolkit instruction. */
	private async _buildExecutorRefinedPrompt(messages: AgentMessage | AgentMessage[]): Promise<string | undefined> {
		try {
			const model = this.deps.resolveCurationModelIfFit();
			if (!model) return undefined;
			const list = Array.isArray(messages) ? messages : [messages];
			const request = latestUserPromptText(list);
			if (!request) return undefined;
			const scripts = this.deps.getSettingsManager().getToolkitScripts();
			const plan = await runReflexInterpreterCompletion({
				request,
				scripts,
				model,
				laneKind: "executor",
				usageKind: "executor-brain",
				usageLabel: "executor-brain-warmup",
				sessionId: this.deps.getSessionManager().getSessionId(),
				completionRunner: this.deps,
				usageReporter: this.deps,
			});
			if (!plan || plan.script === "none") return undefined;
			const argHint = plan.args.length > 0 ? ` with args ${JSON.stringify(plan.args)}` : "";
			return `Run the toolkit script "${plan.script}"${argHint} using run_toolkit_script, then report its result exactly.`;
		} catch {
			return undefined;
		}
	}

	private _resolveModelRouterTurnRoute(prompt: string): { decision: RouteDecision; model: Model<Api> } | undefined {
		const settings = this.deps.getSettingsManager().getModelRouterSettings();
		if (!settings.enabled) {
			this._lastModelRouterSkipReason = "disabled";
			return undefined;
		}

		// Executor lane: a Level-0 DIRECT toolkit hit on a command-shaped prompt routes the
		// whole turn to the configured local executor (tool-call-fitness-gated) instead of
		// spending the frontier model on a one-tool reflex. Ambiguity never routes here — it
		// stays with the big model and the reflex brain. Deterministic, so the judge is skipped.
		const executorRoute = this._resolveExecutorRoute(prompt, settings.executorModel);
		if (executorRoute) return executorRoute;

		const decision = classifyModelRouterRoute(prompt);
		this._lastModelRouterIntent = decision.tier === "cheap" ? "research" : "modify";

		// Learning tier must not be selected for normal user prompts
		if (decision.tier === "learning") {
			this._lastModelRouterSkipReason = "learning tier not supported for user prompts";
			return undefined;
		}

		const modelPattern =
			settings[
				decision.tier === "cheap" ? "cheapModel" : decision.tier === "medium" ? "mediumModel" : "expensiveModel"
			];
		const label =
			decision.tier === "cheap" ? "cheap model" : decision.tier === "medium" ? "medium model" : "expensive model";

		if (decision.tier === "medium" && (!modelPattern || !this._isModelAvailableAndAuthed(modelPattern))) {
			const fallback = this._resolveExpensiveFallbackRoute(
				decision,
				"medium_unavailable_fallback_expensive",
				"Medium model is unavailable, falling back to expensive model",
			);
			if (fallback) return fallback;
			this._lastModelRouterSkipReason ??= "medium model and expensive fallback are unavailable";
			return undefined;
		}

		if (!modelPattern) {
			this._lastModelRouterSkipReason = `${label} unset`;
			return undefined;
		}

		const resolved = resolveCliModel({ cliModel: modelPattern, modelRegistry: this.deps.getModelRegistry() });
		if (!resolved.model) {
			this._lastModelRouterSkipReason = `${label} unresolved: ${modelPattern}`;
			return undefined;
		}

		const resolvedName = formatModelRouterModel(resolved.model);
		if (!this.deps.getModelRegistry().hasConfiguredAuth(resolved.model)) {
			this._lastModelRouterSkipReason = `${label} missing auth: ${resolvedName}`;
			return undefined;
		}

		if (this.deps.isModelExhausted(resolved.model)) {
			if (decision.tier === "medium") {
				const fallback = this._resolveExpensiveFallbackRoute(
					decision,
					"medium_exhausted_fallback_expensive",
					"Medium model exhausted: quota; falling back to expensive model",
				);
				if (fallback) return fallback;
			}
			this._lastModelRouterSkipReason = `${decision.tier} model exhausted: quota`;
			return undefined;
		}

		// For a LOCAL/MANAGED tier model (never cloud — isLocalOrManagedRouterModel), honor a
		// persisted "no working tool-call path" probe verdict. This is an ALWAYS-ON doctrine gate,
		// deliberately not behind the opt-in `fitnessGate` setting below (cloud fitness gating stays
		// opt-in; this local/managed check is unconditional, matching the auto-probe that writes
		// the verdict). "native"/"text-protocol"/unprobed all fall through unchanged: native wins
		// when it works, the shared model-tool-protocol resolver engages the calibrated text dialect,
		// and an unprobed model routes native-first (the evidence loop, not a speculative pre-block).
		if (isLocalOrManagedRouterModel(resolved.model) && this.deps.getToolProbeVerdict(resolved.model) === "none") {
			if (decision.tier === "medium") {
				const fallback = this._resolveExpensiveFallbackRoute(
					decision,
					"medium_no_tool_path_fallback_expensive",
					"Medium model has no working tool-call path (native and text-protocol probe both failed); falling back to expensive model",
				);
				if (fallback) return fallback;
			}
			this._lastModelRouterSkipReason = `${decision.tier} model has no working tool-call path (native and text-protocol probe both failed)`;
			return undefined;
		}

		if (settings.fitnessGate) {
			const verdict = this._evaluateModelFitness(this._routerSurfaceForTier(decision.tier), resolved.model);
			if (!verdict.fit) {
				if (decision.tier === "medium") {
					const failure = this._formatFitnessFailure(verdict);
					const fallback = this._resolveExpensiveFallbackRoute(
						decision,
						"medium_unfit_fallback_expensive",
						`Medium model is unfit (${failure}); falling back to expensive model`,
					);
					if (fallback) return fallback;
				}
				this._lastModelRouterSkipReason = `${decision.tier} model unfit: ${this._formatFitnessFailure(verdict)} (fitness gate)`;
				return undefined;
			}
		}

		this._lastModelRouterSkipReason = undefined;
		decision.model = resolvedName;
		return { decision, model: resolved.model };
	}

	private _resolveModelRouterModelForIntent(intent: ModelRouterIntent): Model<Api> | undefined {
		const settings = this.deps.getSettingsManager().getModelRouterSettings();
		const modelPattern = intent === "research" ? settings.cheapModel : settings.expensiveModel;
		if (!modelPattern) return undefined;
		const resolved = resolveCliModel({ cliModel: modelPattern, modelRegistry: this.deps.getModelRegistry() });
		if (!resolved.model) return undefined;
		if (!this.deps.getModelRegistry().hasConfiguredAuth(resolved.model)) return undefined;
		return this.deps.isModelExhausted(resolved.model) ? undefined : resolved.model;
	}

	resolveConfiguredTierModel(tier: "cheap" | "medium" | "expensive"): Model<Api> | undefined {
		const settings = this.deps.getSettingsManager().getModelRouterSettings();
		const pattern =
			tier === "cheap" ? settings.cheapModel : tier === "medium" ? settings.mediumModel : settings.expensiveModel;
		if (!pattern) return undefined;
		const resolved = resolveCliModel({ cliModel: pattern, modelRegistry: this.deps.getModelRegistry() });
		if (!resolved.model) return undefined;
		if (!this.deps.getModelRegistry().hasConfiguredAuth(resolved.model)) return undefined;
		if (this.deps.isModelExhausted(resolved.model)) return undefined;
		// (Same doctrine as _resolveModelRouterTurnRoute above): never resolve a local/managed
		// model the probe has already graded as having no working tool-call path.
		if (isLocalOrManagedRouterModel(resolved.model) && this.deps.getToolProbeVerdict(resolved.model) === "none") {
			return undefined;
		}
		return resolved.model;
	}

	/**
	 * Router resolution with the routing judge (auto-on with the router): the regex classifier's
	 * decision is the baseline; when a judge model resolves (judgeModel, else mediumModel), one
	 * bounded, tool-less completion may move the tier between cheap/medium/expensive — never to
	 * learning. Core rule encoded in the judge prompt: planning is never cheap unless genuinely
	 * trivial. Every fallback stays visible in the decision reasons, and judge spend reports
	 * through spawned-usage accounting.
	 */
	async resolveTurnRouteJudged(
		prompt: string,
		options?: { skipJudge?: boolean },
	): Promise<{ decision: RouteDecision; model: Model<Api> } | undefined> {
		const baseline = this._resolveModelRouterTurnRoute(prompt);
		if (!baseline) return undefined;
		if (options?.skipJudge) return baseline;
		// Deterministic executor routes need no judge (Level-0 already decided).
		if (baseline.decision.reasonCode === "executor_direct") return baseline;

		const settings = this.deps.getSettingsManager().getModelRouterSettings();
		if (!settings.judgeEnabled) return baseline;
		if (shouldSkipRouteJudgeForStaticDecision(baseline.decision)) return baseline;
		const judgePattern = settings.judgeModel ?? settings.mediumModel;
		if (!judgePattern) return baseline;
		const judgeModel = this.deps.resolveLaneModel(judgePattern);
		if (!judgeModel) {
			return {
				decision: withJudgeUnavailableFallback(
					baseline.decision,
					`routing judge unavailable: ${judgePattern} did not resolve; baseline kept`,
				),
				model: baseline.model,
			};
		}
		if (settings.fitnessGate) {
			const verdict = this._evaluateModelFitness("router_judge", judgeModel);
			if (!verdict.fit) {
				return {
					decision: {
						...baseline.decision,
						reasons: [
							...baseline.decision.reasons,
							`routing judge skipped: ${formatModelRouterModel(judgeModel)} unfit (${this._formatFitnessFailure(verdict)})`,
						],
					},
					model: baseline.model,
				};
			}
		}

		let spentUsage: Usage | undefined;
		const judged = await runRouteJudge({
			prompt,
			baseline: baseline.decision,
			signal: this.deps.getReflectionSignal(),
			complete: async ({ systemPrompt, userPrompt, signal }) => {
				const completion = await runIsolatedTextCompletion(this.deps, {
					systemPrompt,
					userPrompt,
					model: judgeModel,
					// Per-tier thinking: judgeThinking overrides the judge's own completion; unset
					// keeps today's "off" (the judge is a cheap classification call by default).
					thinkingLevel: settings.judgeThinking ?? "off",
					maxTokens: ROUTE_JUDGE_MAX_OUTPUT_TOKENS,
					signal,
					// The judge system prompt is static — the provider can cache the prefix.
					cacheRetention: "short",
					// Stable per-lane synthetic affinity key so repeat judge calls hit the same
					// cache-warm backend.
					laneKind: "route-judge",
				});
				spentUsage = completion.usage;
				return completion;
			},
		});
		if (spentUsage) {
			reportSpawnedUsage(this.deps, spentUsage, {
				kind: "route-judge",
				label: "router-judge",
				sessionId: this.deps.getSessionManager().getSessionId(),
				identity: prompt,
			});
		}

		if (!judged.verdict || judged.decision.tier === baseline.decision.tier) {
			// Same tier (or judge fell back): keep the baseline model, carry the annotated decision.
			return { decision: judged.decision, model: baseline.model };
		}

		const judgedTier = judged.decision.tier;
		if (judgedTier !== "cheap" && judgedTier !== "medium" && judgedTier !== "expensive") {
			return { decision: baseline.decision, model: baseline.model };
		}
		const judgedModel = this.resolveConfiguredTierModel(judgedTier);
		if (!judgedModel) {
			return {
				decision: {
					...baseline.decision,
					reasons: [
						...baseline.decision.reasons,
						`Route judge chose ${judgedTier} but no model resolves for that tier; baseline kept`,
					],
				},
				model: baseline.model,
			};
		}
		return { decision: { ...judged.decision, model: formatModelRouterModel(judgedModel) }, model: judgedModel };
	}

	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: test seam
	private _resolveModelRouterTurnModel(prompt: string): Model<Api> | undefined {
		const resolved = this._resolveModelRouterTurnRoute(prompt);
		return resolved?.model;
	}

	getStatus(formatLabel?: (label: string) => string): string {
		const recentDecisions = getRecentModelRouterDecisions(this.deps.getSessionManager().getEntries());
		const lastDecision = this._lastModelRouterDecision ?? recentDecisions.at(-1);
		const historicalDecisions = this._lastModelRouterDecision ? recentDecisions : recentDecisions.slice(0, -1);
		const settings = this.deps.getSettingsManager().getModelRouterSettings();
		const lines = [
			formatModelRouterStatus(
				settings,
				lastDecision,
				formatLabel,
				historicalDecisions,
				this._lastModelRouterSkipReason,
				this._lastModelRouterIntent ?? lastDecision?.intent,
				settings.fitnessGate ? this._getRouterTierFitnessStatuses() : undefined,
				this.deps.getFailoverStatus(),
			),
		];
		const diagnostics = collectModelRouterConfigDiagnostics(
			settings,
			this.deps.getModelRegistry(),
			this.deps.getAgentDir(),
		);
		if (diagnostics.length > 0) {
			lines.push(formatLabel ? formatLabel("Config diagnostics:") : "Config diagnostics:");
			for (const diagnostic of diagnostics) {
				lines.push(`- ${diagnostic}`);
			}
		}
		return lines.join("\n");
	}

	async runRoutedTurn(
		messages: AgentMessage | AgentMessage[],
		routedModel: Model<Api> | undefined,
		routeDecision: RouteDecision | undefined,
		persistDecision = true,
		continueFromCanonicalHistory = false,
		signal?: AbortSignal,
	): Promise<void> {
		if (!routedModel) {
			if (continueFromCanonicalHistory) await this.deps.runAgentContinuation(signal);
			else await this.deps.runAgentPrompt(messages, signal);
			return;
		}

		const agent = this.deps.getAgent();
		const previousModel = agent.state.model;
		const previousThinkingLevel = agent.state.thinkingLevel;
		const previousTurnTools = agent.state.tools;
		const previousSystemPrompt = agent.state.systemPrompt;
		// Swap bookkeeping: the exact references the swap below assigns, so the finally can
		// restore ONLY what IT put there — never assigned when no tool restriction applies.
		let swappedTools: typeof previousTurnTools | undefined;
		let swappedSystemPrompt: typeof previousSystemPrompt | undefined;
		const previousActiveModelRouterIntent = this._activeModelRouterIntent;
		const previousActiveModelRouterRoute = this._activeModelRouterRoute;
		const previousModelRouterSessionBuffer = this._modelRouterSessionBuffer;
		const previousModelRouterEscalationRequested = this._modelRouterEscalationRequested;
		const bufferRoutedTurn = routeDecision?.tier === "cheap";
		const originalHistoryLength = agent.state.messages.length;
		let retryModel: Model<Api> | undefined;
		let retryFromCanonicalHistory = false;
		let completedDecision: ModelRouterDecisionStatus | undefined = routeDecision
			? {
					route: routeDecision,
					routedModel: formatModelRouterModel(routedModel),
					outcome: "routed",
					intent: routeDecision.tier === "cheap" ? "research" : "modify",
				}
			: undefined;
		let thrownError: unknown;
		if (routeDecision) {
			this._lastModelRouterDecision = completedDecision;
		}
		this._activeModelRouterIntent = routeDecision
			? routeDecision.tier === "cheap"
				? "research"
				: "modify"
			: undefined;
		this._activeModelRouterRoute = routeDecision;
		if (bufferRoutedTurn) {
			this._modelRouterSessionBuffer = createModelRouterSessionBuffer();
			this._modelRouterEscalationRequested = false;
		}
		const routerThinkingSettings = this.deps.getSettingsManager().getModelRouterSettings();
		const configuredThinking = !routeDecision
			? undefined
			: routeDecision.reasonCode === "executor_direct"
				? routerThinkingSettings.executorThinking
				: routeDecision.tier === "cheap"
					? routerThinkingSettings.cheapThinking
					: routeDecision.tier === "medium"
						? routerThinkingSettings.mediumThinking
						: routeDecision.tier === "expensive"
							? routerThinkingSettings.expensiveThinking
							: undefined;
		const routedThinkingLevel = clampThinkingLevel(
			routedModel,
			configuredThinking ?? previousThinkingLevel,
		) as ThinkingLevel;
		const modelChanged = !modelsAreEqual(this.deps.getModel(), routedModel);
		const thinkingChanged = routedThinkingLevel !== previousThinkingLevel;
		if (modelChanged || thinkingChanged) {
			agent.state.model = routedModel;
			// Per-tier thinking: a configured tier/executor thinking level overrides the inherited
			// session thinking for THIS routed turn only; unset falls back to exactly today's
			// inherit-and-clamp behavior. Executor routes carry tier "cheap" too, so reasonCode is
			// checked first — otherwise an executor turn would silently pick up cheapThinking instead.
			// The judge's own completion has a separate knob (judgeThinking) applied at its call site.
			agent.state.thinkingLevel = routedThinkingLevel;
			// Capability tool-filtering follows the ROUTED model for the turn. Without this a
			// cheap/local routed model inherits the session model's full tool surface — schemas it
			// pays for on every request and may not be able to drive at all.
			if (modelChanged) {
				const routedProfile = deriveModelCapabilityProfile({
					contextWindow: routedModel.contextWindow,
					mode: this.deps.getSettingsManager().getModelCapabilitySettings().mode,
				});
				const allowed = new Set(
					filterToolNamesForCapability(
						previousTurnTools.map((tool) => tool.name),
						routedProfile,
						routedModel,
					),
				);
				if (allowed.size !== previousTurnTools.length) {
					agent.state.tools = previousTurnTools.filter((tool) => allowed.has(tool.name));
					// Agent owns a defensive copy on assignment. Fence against the installed array,
					// not our input array, so restoration works without overwriting live tool changes.
					swappedTools = agent.state.tools;
				}
			}
			// The routed prompt follows the routed tool surface and keeps provider-neutral delegation
			// guidance whenever delegate remains active, including same-model thinking overrides.
			// Per-turn only; a live extension override is preserved rather than silently replaced.
			if (agent.state.systemPrompt === this.deps.getBaseSystemPrompt()) {
				swappedSystemPrompt = this.deps.buildSystemPromptForToolNames(agent.state.tools.map((tool) => tool.name));
				agent.state.systemPrompt = swappedSystemPrompt;
			}
		}
		try {
			if (continueFromCanonicalHistory) await this.deps.runAgentContinuation(signal);
			else await this.deps.runAgentPrompt(messages, signal);
			// Speculative muscle-retry: an executor-routed turn is a bet that the
			// small model can run the toolkit command directly. If it ends WITHOUT a successful
			// run_toolkit_script execution, retry ONCE on the same executor with the brain's
			// refined instruction injected — the brain warms while the muscle tries, so the retry
			// pays only when the muscle actually missed.
			// Not on a cancelled submission: the miss is then the cancellation's doing, and the refine
			// step is itself a provider call the submission's owner has already declined to pay for.
			if (
				routeDecision?.reasonCode === "executor_direct" &&
				!this._isModelRouterRetry &&
				!signal?.aborted &&
				!this._executorTurnExecutedScript(originalHistoryLength)
			) {
				const refined = await this._buildExecutorRefinedPrompt(messages);
				if (refined) {
					// A prepared executor tool may already have crossed the lifecycle commit boundary.
					// In that case the canonical tool/result history must remain visible to the retry;
					// only an uncommitted speculative route may discard its live suffix and replace its
					// buffer.
					if (this._modelRouterSessionBuffer?.committed !== true) {
						const prefixCommitted = this._modelRouterSessionBuffer?.prefixCommitted === true;
						const prefixMessageCount = this._modelRouterSessionBuffer?.prefixMessageCount ?? 0;
						agent.state.messages.splice(
							prefixCommitted ? originalHistoryLength + prefixMessageCount : originalHistoryLength,
						);
						if (bufferRoutedTurn) {
							this._modelRouterSessionBuffer = createModelRouterSessionBuffer();
							if (prefixCommitted) {
								this._modelRouterSessionBuffer.prefixCommitted = true;
								this._modelRouterSessionBuffer.prefixMessageCount = prefixMessageCount;
							}
						}
					}
					await this.deps.runAgentPrompt(
						[{ role: "user", content: [{ type: "text", text: refined }], timestamp: Date.now() }],
						signal,
					);
					completedDecision = {
						route: {
							...routeDecision,
							reasonCode: "executor_speculative_retry",
							reasons: [
								...routeDecision.reasons,
								"Executor missed on first try; retried with brain-refined instruction",
							],
						},
						routedModel: formatModelRouterModel(routedModel),
						outcome: "routed",
						intent: "research",
					};
					this._lastModelRouterDecision = completedDecision;
				} else {
					// The muscle missed AND the reflex brain could not refine the request into a toolkit
					// instruction (no fit brain model, or no confident plan). There is deliberately NO
					// frontier fallback here, so surface the miss instead of letting it stand silently —
					// otherwise the routed turn just ends with an unrun command and no explanation.
					this.deps.emit({
						type: "warning",
						message:
							"Executor lane: the toolkit command did not run and the reflex brain could not refine it into an explicit instruction; leaving the turn as-is (no automatic escalation).",
					});
				}
			}
			if (bufferRoutedTurn && this._modelRouterEscalationRequested) {
				const bufferCommitted = this._modelRouterSessionBuffer?.committed === true;
				const prefixCommitted = this._modelRouterSessionBuffer?.prefixCommitted === true;
				retryFromCanonicalHistory = bufferCommitted || prefixCommitted;
				if (prefixCommitted && !bufferCommitted) {
					const prefixMessageCount = this._modelRouterSessionBuffer?.prefixMessageCount ?? 0;
					agent.state.messages.splice(originalHistoryLength + prefixMessageCount);
				} else if (!bufferCommitted) {
					agent.state.messages.splice(originalHistoryLength);
				}
				retryModel = this._resolveModelRouterModelForIntent("modify") ?? previousModel;
				completedDecision = {
					route: routeDecision!,
					routedModel: formatModelRouterModel(routedModel),
					outcome: "escalated",
					retryModel: formatModelRouterModel(retryModel),
					intent: routeDecision!.tier === "cheap" ? "research" : "modify",
				};
				this._lastModelRouterDecision = completedDecision;
			} else if (bufferRoutedTurn && this._modelRouterSessionBuffer) {
				flushModelRouterSessionBuffer(this._modelRouterSessionBuffer, (batch) =>
					this.deps.appendSessionMessageBatch(batch),
				);
			}
		} catch (error) {
			thrownError = error;
			// Mirror the escalation splice above (~:812): a buffered cheap-tier turn never flushes its
			// live messages to the session on a genuine throw, so agent.state.messages must be rolled
			// back to the pre-turn length here too — otherwise the never-persisted buffered messages
			// permanently diverge from the persisted session (same shape as the W1.3 ghost-turn bug,
			// but on the error path instead of the success/escalation paths).
			if (bufferRoutedTurn && this._modelRouterSessionBuffer?.committed !== true) {
				const prefixCommitted = this._modelRouterSessionBuffer?.prefixCommitted === true;
				const prefixMessageCount = this._modelRouterSessionBuffer?.prefixMessageCount ?? 0;
				agent.state.messages.splice(
					prefixCommitted ? originalHistoryLength + prefixMessageCount : originalHistoryLength,
				);
			}
			if (completedDecision) {
				completedDecision = { ...completedDecision, outcome: "failed" };
				this._lastModelRouterDecision = completedDecision;
			}
		} finally {
			// Restore the pre-route model ONLY if the routed model is still in place: a command
			// handler may have legitimately changed the session model mid-turn (setModel or a
			// provider re-registration), and clobbering that would silently undo the change.
			if (modelsAreEqual(agent.state.model, routedModel)) {
				agent.state.model = previousModel;
				agent.state.thinkingLevel = previousThinkingLevel;
				// Symmetric restore: undo tools/systemPrompt only if each is STILL the exact
				// reference/string installed by the swap (absent when no restriction applied). An extension calling
				// setActiveToolsByName mid-turn reassigns both to its own values without touching the
				// model — the model guard above still passes, but that live change is legitimate and must
				// survive rather than being silently reverted to the stale pre-turn snapshot.
				if (swappedTools !== undefined && agent.state.tools === swappedTools) {
					agent.state.tools = previousTurnTools;
				}
				if (swappedSystemPrompt !== undefined && agent.state.systemPrompt === swappedSystemPrompt) {
					agent.state.systemPrompt = previousSystemPrompt;
				}
				// The registry may have changed mid-turn (command-time registerProvider): re-resolve
				// the restored model so a provider override is not dropped with the routed model.
				this.deps.refreshCurrentModelFromRegistry();
			}
			this._activeModelRouterIntent = previousActiveModelRouterIntent;
			this._activeModelRouterRoute = previousActiveModelRouterRoute;
			this._modelRouterSessionBuffer = previousModelRouterSessionBuffer;
			this._modelRouterEscalationRequested = previousModelRouterEscalationRequested;
		}

		// The escalation retry is more provider work, which a cancelled submission does not get.
		if (retryModel && !thrownError && !signal?.aborted) {
			const previousIsModelRouterRetry = this._isModelRouterRetry;
			try {
				this._isModelRouterRetry = true;
				const retryDecision: RouteDecision = {
					tier: "expensive",
					risk: "high-impact",
					confidence: 1.0,
					reasonCode: "cheap_mutating_tool_escalation",
					reasons: ["Cheap research turn attempted a mutating tool and escalated"],
					fallbackFrom: "cheap",
					model: formatModelRouterModel(retryModel),
				};
				await this.runRoutedTurn(messages, retryModel, retryDecision, false, retryFromCanonicalHistory, signal);
				this._lastModelRouterDecision = completedDecision;
			} catch (error) {
				thrownError = error;
				if (completedDecision) {
					completedDecision = { ...completedDecision, outcome: "failed" };
					this._lastModelRouterDecision = completedDecision;
				}
			} finally {
				this._isModelRouterRetry = previousIsModelRouterRetry;
			}
		}

		if (persistDecision && completedDecision) {
			persistModelRouterDecision(this.deps.getSessionManager(), completedDecision);
			// One route event per user-facing routed turn (the escalation retry runs with
			// persistDecision=false, so it does not double-emit). Codes/numbers only — no prompt text.
			this.deps.emitAutonomyTelemetry({
				type: AUTONOMY_TELEMETRY_EVENT_TYPES.routeDecision,
				timestamp: new Date().toISOString(),
				payload: {
					tier: completedDecision.route.tier,
					risk: completedDecision.route.risk,
					reasonCode: completedDecision.route.reasonCode,
					confidence: completedDecision.route.confidence,
					outcome: completedDecision.outcome,
				},
			});
		}

		if (thrownError) {
			throw thrownError;
		}
	}
}
