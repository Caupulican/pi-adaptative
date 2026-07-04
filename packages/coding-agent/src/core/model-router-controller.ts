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
 * session/settings managers, the model registry, the agent dir, the reflection abort signal, the
 * base system prompt, the isolated-completion primitive, spawned-usage accounting, the event/telemetry
 * emitters, and the recently-extracted BackgroundLaneController (resolveLaneModel) / ContextPipeline
 * (resolveCurationModelIfFit) collaborators — is reached through narrow deps accessors rather than the
 * whole AgentSession.
 *
 * Drive-path boundary (deliberate): the actual agent.prompt()/continue() loop stays host-side in
 * AgentSession._runAgentPrompt; this controller's parallel routed drive path ({@link runRoutedTurn})
 * owns only the route decision/escalation/tier bookkeeping and delegates every agent turn back through
 * {@link ModelRouterControllerDeps.runAgentPrompt}, so the drive-loop logic is never duplicated. The
 * host keeps a one-line delegation at each call-in: the routing prep + routed-turn entry in
 * _promptUnserialized, the beforeToolCall escalation branch ({@link maybeEscalateToolCall}), the
 * message_end cheap-turn buffering ({@link captureSessionMessage}), the retry-event suppression
 * ({@link isRetryInFlight}), and the public getModelRouterStatus / autonomy-telemetry reads.
 */

import type { Agent, AgentMessage, ThinkingLevel } from "@caupulican/pi-agent-core";
import type { SessionManager } from "@caupulican/pi-agent-core/node";
import type { Api, Message, Model, Usage } from "@caupulican/pi-ai";
import { clampThinkingLevel, modelsAreEqual } from "@caupulican/pi-ai";
import type { AgentSessionEvent, IsolatedCompletionOptions, IsolatedCompletionResult } from "./agent-session.ts";
import type { RouteDecision } from "./autonomy/contracts.ts";
import { AUTONOMY_TELEMETRY_EVENT_TYPES, type AutonomyTelemetryEvent } from "./autonomy/telemetry-events.ts";
import { latestUserPromptText } from "./context-pipeline.ts";
import { deriveModelCapabilityProfile, filterToolNamesForCapability } from "./model-capability.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { resolveCliModel } from "./model-resolver.ts";
import { collectModelRouterConfigDiagnostics } from "./model-router/config-diagnostics.ts";
import { classifyExecutorTurn } from "./model-router/executor-route.ts";
import { classifyModelRouterRoute, type ModelRouterIntent } from "./model-router/intent-classifier.ts";
import { ROUTE_JUDGE_MAX_OUTPUT_TOKENS, runRouteJudge } from "./model-router/route-judge.ts";
import {
	bufferModelRouterSessionCustomMessage,
	bufferModelRouterSessionMessage,
	createModelRouterSessionBuffer,
	flushModelRouterSessionBuffer,
	type ModelRouterSessionBuffer,
} from "./model-router/session-buffer.ts";
import {
	formatModelRouterStatus,
	getRecentModelRouterDecisions,
	MODEL_ROUTER_DECISION_CUSTOM_TYPE,
	type ModelRouterDecisionStatus,
} from "./model-router/status.ts";
import { shouldEscalateModelRouterTool } from "./model-router/tool-escalation.ts";
import { FitnessStore } from "./models/fitness-store.ts";
import type { SettingsManager } from "./settings-manager.ts";
import {
	buildReflexUserPrompt,
	parseReflexPlan,
	REFLEX_INTERPRETER_SYSTEM_PROMPT,
} from "./toolkit/reflex-interpreter.ts";

/** Canonical `provider/id` label for a routed/resolved model, as it appears in decisions and status. */
export function formatModelRouterModel(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
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
	/** Resolves configured route/judge/executor model patterns against configured auth. */
	getModelRegistry(): ModelRegistry;
	/** Root dir the host-keyed {@link FitnessStore} lives under (executor tool-call fitness gate). */
	getAgentDir(): string;
	/** Aborts the judge's bounded completion when the session is disposed. */
	getReflectionSignal(): AbortSignal;
	/** Base (extension-free) system prompt — the tier swap only sheds tools when the turn is on it. */
	getBaseSystemPrompt(): string;
	/** The host-side drive loop (agent.prompt()/continue()); the routed drive path delegates every turn here. */
	runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void>;
	/** Rebuilds the system prompt for a filtered tool surface (routed-model capability shedding). */
	buildSystemPromptForToolNames(toolNames: string[]): string;
	/** Re-resolves the restored model against the registry after a routed turn (provider override safety). */
	refreshCurrentModelFromRegistry(): void;
	/** One-shot, tool-less LLM call — the routing judge and the executor reflex-brain warmup ride this. */
	runIsolatedCompletion(opts: IsolatedCompletionOptions): Promise<IsolatedCompletionResult>;
	/** Rolls judge/brain spend into spawned-usage accounting. */
	addSpawnedUsage(
		usage: Usage,
		opts?: { label?: string; sourceSessionId?: string; reportId?: string },
	): string | undefined;
	/** Session event stream (executor-miss warning). */
	emit(event: AgentSessionEvent): void;
	/** Autonomy telemetry stream (one route-decision event per user-facing routed turn). */
	emitAutonomyTelemetry(event: AutonomyTelemetryEvent): void;
	/** Resolves the judge model pattern via {@link BackgroundLaneController}. */
	resolveLaneModel(pattern: string): Model<Api> | undefined;
	/** Fitness-gated reflex-brain model via {@link ContextPipeline} (executor speculative refinement). */
	resolveCurationModelIfFit(): Model<Api> | undefined;
}

/**
 * Owns the model-router turn routing extracted from {@link AgentSession}. See the module header for the
 * drive-path boundary that keeps the agent.prompt()/continue() loop host-side.
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
	 * message_end hook: while a cheap routed turn is buffering, capture its messages into the session
	 * buffer instead of persisting them (they are flushed on success or discarded on escalation).
	 * Returns true when the message was buffered, so the host skips its own persistence.
	 */
	captureSessionMessage(message: AgentMessage): boolean {
		const modelRouterBuffer = this._modelRouterSessionBuffer;
		if (!modelRouterBuffer) return false;
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

	private _isModelAvailableAndAuthed(pattern: string): boolean {
		const resolved = resolveCliModel({ cliModel: pattern, modelRegistry: this.deps.getModelRegistry() });
		if (!resolved.model) return false;
		return this.deps.getModelRegistry().hasConfiguredAuth(resolved.model);
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
			const canonicalRef = `${resolved.model.provider}/${resolved.model.id}`;
			const fitness = FitnessStore.forAgentDir(this.deps.getAgentDir())
				.getForHost()
				.find((entry) => entry.model === canonicalRef);
			const toolCall = fitness?.report.toolCall;
			if (!toolCall || toolCall.succeeded < Math.ceil(toolCall.total * (2 / 3))) return undefined;
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
			const request = latestUserPromptText(list.filter((m): m is AgentMessage => true));
			if (!request) return undefined;
			const scripts = this.deps.getSettingsManager().getToolkitScripts();
			const completion = await this.deps.runIsolatedCompletion({
				systemPrompt: REFLEX_INTERPRETER_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: buildReflexUserPrompt(request, scripts) }],
						timestamp: Date.now(),
					},
				],
				model,
				thinkingLevel: "off",
				maxTokens: 256,
				cacheRetention: "short",
			});
			if (completion.usage.cost.total > 0 || completion.usage.totalTokens > 0) {
				this.deps.addSpawnedUsage(completion.usage, { label: "executor-brain-warmup" });
			}
			const plan = parseReflexPlan(completion.text);
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

		// G16 executor lane: a Level-0 DIRECT toolkit hit on a command-shaped prompt routes the
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
			const expensivePattern = settings.expensiveModel;
			if (expensivePattern && this._isModelAvailableAndAuthed(expensivePattern)) {
				const resolvedExpensive = resolveCliModel({
					cliModel: expensivePattern,
					modelRegistry: this.deps.getModelRegistry(),
				});
				if (resolvedExpensive.model) {
					decision.fallbackFrom = "medium";
					decision.tier = "expensive";
					decision.reasonCode = "medium_unavailable_fallback_expensive";
					decision.reasons = [...decision.reasons, "Medium model is unavailable, falling back to expensive model"];
					decision.model = formatModelRouterModel(resolvedExpensive.model);
					this._lastModelRouterSkipReason = undefined;
					return { decision, model: resolvedExpensive.model };
				}
			}
			this._lastModelRouterSkipReason = "medium model and expensive fallback are unavailable";
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
		return resolved.model;
	}

	resolveConfiguredTierModel(tier: "cheap" | "medium" | "expensive"): Model<Api> | undefined {
		const settings = this.deps.getSettingsManager().getModelRouterSettings();
		const pattern =
			tier === "cheap" ? settings.cheapModel : tier === "medium" ? settings.mediumModel : settings.expensiveModel;
		if (!pattern) return undefined;
		const resolved = resolveCliModel({ cliModel: pattern, modelRegistry: this.deps.getModelRegistry() });
		if (!resolved.model) return undefined;
		if (!this.deps.getModelRegistry().hasConfiguredAuth(resolved.model)) return undefined;
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
		const judgePattern = settings.judgeModel ?? settings.mediumModel;
		if (!judgePattern) return baseline;
		const judgeModel = this.deps.resolveLaneModel(judgePattern);
		if (!judgeModel) return baseline;

		let spentUsage: Usage | undefined;
		const judged = await runRouteJudge({
			prompt,
			baseline: baseline.decision,
			signal: this.deps.getReflectionSignal(),
			complete: async ({ systemPrompt, userPrompt, signal }) => {
				const completion = await this.deps.runIsolatedCompletion({
					systemPrompt,
					messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
					model: judgeModel,
					// Per-tier thinking (R1): judgeThinking overrides the judge's own completion; unset
					// keeps today's "off" (the judge is a cheap classification call by default).
					thinkingLevel: settings.judgeThinking ?? "off",
					maxTokens: ROUTE_JUDGE_MAX_OUTPUT_TOKENS,
					signal,
					// The judge system prompt is static — the provider can cache the prefix.
					cacheRetention: "short",
				});
				spentUsage = completion.usage;
				return {
					text: completion.text,
					costUsd: completion.usage.cost.total,
					stopReason: String(completion.stopReason),
				};
			},
		});
		if (spentUsage && (spentUsage.cost.total > 0 || spentUsage.totalTokens > 0)) {
			this.deps.addSpawnedUsage(spentUsage, { label: "router-judge" });
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
			),
		];
		const diagnostics = collectModelRouterConfigDiagnostics(settings, this.deps.getModelRegistry());
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
	): Promise<void> {
		if (!routedModel) {
			await this.deps.runAgentPrompt(messages);
			return;
		}

		const agent = this.deps.getAgent();
		const previousModel = agent.state.model;
		const previousThinkingLevel = agent.state.thinkingLevel;
		const previousTurnTools = agent.state.tools;
		const previousSystemPrompt = agent.state.systemPrompt;
		// G4 swap bookkeeping (Bug G): the exact references the swap below assigns, so the finally can
		// restore ONLY what IT put there — never assigned when no swap happens (e.g. a full-class
		// routed profile).
		let swappedTools: typeof previousTurnTools | undefined;
		let swappedSystemPrompt: typeof previousSystemPrompt | undefined;
		const previousActiveModelRouterIntent = this._activeModelRouterIntent;
		const previousActiveModelRouterRoute = this._activeModelRouterRoute;
		const previousModelRouterSessionBuffer = this._modelRouterSessionBuffer;
		const previousModelRouterEscalationRequested = this._modelRouterEscalationRequested;
		const bufferRoutedTurn = routeDecision?.tier === "cheap";
		const originalHistoryLength = agent.state.messages.length;
		let retryModel: Model<Api> | undefined;
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
		if (!modelsAreEqual(this.deps.getModel(), routedModel)) {
			agent.state.model = routedModel;
			// Per-tier thinking (R1): a configured tier/executor thinking level overrides the inherited
			// session thinking for THIS routed turn only; unset falls back to exactly today's
			// inherit-and-clamp behavior. Executor routes carry tier "cheap" too, so reasonCode is
			// checked first — otherwise an executor turn would silently pick up cheapThinking instead.
			// The judge's own completion has a separate knob (judgeThinking) applied at its call site.
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
			agent.state.thinkingLevel = clampThinkingLevel(
				routedModel,
				configuredThinking ?? previousThinkingLevel,
			) as ThinkingLevel;
			// G4: capability tool-filtering follows the ROUTED model for the turn. Without this a
			// cheap/local routed model inherits the session model's full tool surface — schemas it
			// pays for on every request and may not be able to drive at all.
			const routedProfile = deriveModelCapabilityProfile({
				contextWindow: routedModel.contextWindow,
				mode: this.deps.getSettingsManager().getModelCapabilitySettings().mode,
			});
			if (routedProfile.class !== "full") {
				const allowed = new Set(
					filterToolNamesForCapability(
						previousTurnTools.map((tool) => tool.name),
						routedProfile,
					),
				);
				swappedTools = previousTurnTools.filter((tool) => allowed.has(tool.name));
				agent.state.tools = swappedTools;
				// G4: the system prompt follows the ROUTED model's filtered surface too — otherwise the
				// cheap/local model is billed for (and told about) tool guidelines/snippets it can't call.
				// Per-turn only; restored in the finally. A live extension override of the prompt is left
				// alone (only shed when we're on the base prompt).
				if (agent.state.systemPrompt === this.deps.getBaseSystemPrompt()) {
					swappedSystemPrompt = this.deps.buildSystemPromptForToolNames(
						agent.state.tools.map((tool) => tool.name),
					);
					agent.state.systemPrompt = swappedSystemPrompt;
				}
			}
		}
		try {
			await this.deps.runAgentPrompt(messages);
			// Speculative muscle-retry (G16 refinement): an executor-routed turn is a bet that the
			// small model can run the toolkit command directly. If it ends WITHOUT a successful
			// run_toolkit_script execution, retry ONCE on the same executor with the brain's
			// refined instruction injected — the brain warms while the muscle tries, so the retry
			// pays only when the muscle actually missed.
			if (
				routeDecision?.reasonCode === "executor_direct" &&
				!this._isModelRouterRetry &&
				!this._executorTurnExecutedScript(originalHistoryLength)
			) {
				const refined = await this._buildExecutorRefinedPrompt(messages);
				if (refined) {
					agent.state.messages.splice(originalHistoryLength);
					await this.deps.runAgentPrompt([
						{ role: "user", content: [{ type: "text", text: refined }], timestamp: Date.now() },
					]);
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
				agent.state.messages.splice(originalHistoryLength);
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
				flushModelRouterSessionBuffer(
					this._modelRouterSessionBuffer,
					(message) => {
						this.deps.getSessionManager().appendMessage(message);
					},
					(customType, content, display, details) => {
						this.deps.getSessionManager().appendCustomMessageEntry(customType, content, display, details);
					},
				);
			}
		} catch (error) {
			thrownError = error;
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
				// Symmetric restore (Bug G): undo tools/systemPrompt only if each is STILL the exact
				// reference/string the G4 swap above assigned (never assigned at all when the routed
				// profile was full-class — then there is nothing to restore either). An extension calling
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

		if (retryModel && !thrownError) {
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
				await this.runRoutedTurn(messages, retryModel, retryDecision, false);
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
			// G3: one route event per user-facing routed turn (the escalation retry runs with
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
