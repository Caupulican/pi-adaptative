/**
 * Compaction support: summarizer model selection (#30 cost guard), request-auth resolution
 * with session-model fallback, and window-adapted compaction settings.
 *
 * This is the policy half of compaction. CompactionController owns detection, execution, retry,
 * persistence, notification, and cancellation; AgentSession keeps compatibility delegations at
 * established regression seams.
 */
import {
	type CompactionSettings,
	type StructuredCompactionRequest,
	summarizerCanIngest,
} from "@caupulican/pi-agent-core/compaction/compaction";
import { convertToLlm } from "@caupulican/pi-agent-core/messages";
import type { AgentMessage, ThinkingLevel } from "@caupulican/pi-agent-core/types";
import type { Api, Context, Model, SimpleStreamOptions } from "@caupulican/pi-ai";
import { materializeProviderRequest } from "@caupulican/pi-ai/stream";
import type { ModelRegistry } from "./model-registry.ts";
import { resolveCliModel } from "./model-resolver.ts";
import { evaluateSurfaceFitness } from "./model-router/fitness-gate.ts";
import type { RequestAuth } from "./request-auth.ts";
import type { ModelFitnessReport } from "./research/model-fitness.ts";
import type { SettingsManager } from "./settings-manager.ts";

const XAI_SUBSCRIPTION_COMPACTION_TRIGGER_PERCENT = 0.8;

/**
 * A metered model whose price steps up above an input-token boundary (grok-4.6 doubles input and
 * cache-read rates above 200k) should compact before crossing it: every turn past the boundary pays
 * the higher rate on the whole prompt. Only the default fraction is lowered; an explicit owner
 * setting and the xAI subscription's session-replacement policy keep their own values.
 */
function tierAwareCompactionTriggerPercent(
	model: Model<Api>,
	contextWindow: number,
	triggerPercent: number | undefined,
	settingsManager: SettingsManager,
): number | undefined {
	if (settingsManager.hasExplicitCompactionTriggerPercent()) return undefined;
	if (triggerPercent === undefined || triggerPercent <= 0 || triggerPercent >= 1) return undefined;
	const boundary = (model.cost?.tiers ?? [])
		.map((tier) => tier.inputTokensAbove)
		.filter((tokens) => Number.isFinite(tokens) && tokens > 0)
		.sort((left, right) => left - right)[0];
	if (boundary === undefined || boundary >= contextWindow * triggerPercent) return undefined;
	return boundary / contextWindow;
}

function usesXaiSubscriptionSessionReplacement(model: Model<Api>): boolean {
	if (model.provider !== "xai" || model.api !== "openai-responses") return false;
	return model.compat !== undefined && "requestFormat" in model.compat && model.compat.requestFormat === "xai-cli";
}

/** Two models share a provider cache lane: the same deployment behind the same API and endpoint. */
export function sameCacheLane(a: Model<Api>, b: Model<Api>): boolean {
	return a.provider === b.provider && a.id === b.id && a.api === b.api && a.baseUrl === b.baseUrl;
}

/** The session lane's last sent provider request: its model, the context as sent, and the history it was planned from. */
export interface LastSentRequest {
	readonly model: Model<Api>;
	readonly context: Context;
	readonly sourceMessages: readonly AgentMessage[];
}

/**
 * The summarizer request for a compaction on the session's own model, which reads the session's cached
 * prefix whatever the provider or the retention strategy: the lane's system prompt, tools and cache
 * session id, and (when it is still the head of the live history) the context exactly as the lane last
 * sent it, extended by the messages persisted since and materialized the same way. Undefined for a
 * summarizer on another model, which shares no cache with the session.
 */
export function sessionLaneSummarizerRequest(input: {
	compactionModel: Model<Api>;
	sessionModel: Model<Api>;
	systemPrompt: string;
	tools: Context["tools"];
	messagesToSummarize: readonly AgentMessage[];
	liveMessages: readonly AgentMessage[];
	lastSent: LastSentRequest | undefined;
	textToolCallProtocol: SimpleStreamOptions["textToolCallProtocol"];
	sessionId: string;
}): StructuredCompactionRequest | undefined {
	if (!sameCacheLane(input.compactionModel, input.sessionModel)) return undefined;
	const materialize = (context: Context) =>
		materializeProviderRequest(context, { textToolCallProtocol: input.textToolCallProtocol }).context;
	const context = materialize({
		systemPrompt: input.systemPrompt,
		messages: convertToLlm([...input.messagesToSummarize]),
		tools: input.tools,
	});
	const sentContext = extendSentContext(
		input.lastSent,
		input.compactionModel,
		input.liveMessages,
		(newer) => materialize({ ...(input.lastSent?.context ?? {}), messages: convertToLlm([...newer]) }).messages,
	);
	return {
		context,
		...(sentContext ? { sentContext } : {}),
		sessionId: input.sessionId,
		cacheRetention: "short",
	};
}

function extendSentContext(
	sent: LastSentRequest | undefined,
	model: Model<Api>,
	live: readonly AgentMessage[],
	materializeNewer: (newer: readonly AgentMessage[]) => Context["messages"],
): Context | undefined {
	if (!sent || !sameCacheLane(sent.model, model)) return undefined;
	const planned = sent.sourceMessages.length;
	// The sent request no longer describes this history when its last message is not where it was.
	if (planned > live.length || (planned > 0 && live[planned - 1] !== sent.sourceMessages[planned - 1])) {
		return undefined;
	}
	const newer = live.slice(planned);
	return newer.length === 0
		? sent.context
		: { ...sent.context, messages: [...sent.context.messages, ...materializeNewer(newer)] };
}

export interface CompactionSupportDeps {
	getModel(): Model<Api> | undefined;
	getSettingsManager(): SettingsManager;
	getModelRegistry(): ModelRegistry;
	/** True when the agent's streamFn is (or wraps) the raw streamSimple — auth must be explicit then. */
	isRawStream(): boolean;
	/** Host auth resolution that THROWS with a user-actionable message when no key exists. */
	getRequiredRequestAuth(model: Model<Api>): Promise<RequestAuth>;
	isModelExhausted(ref: string): boolean;
	getStoredFitnessReport(ref: string): ModelFitnessReport | undefined;
	/** Estimated tokens of the summarization input (live context; over-estimates, which is safe). */
	estimateSummarizationInputTokens(): number;
	emitWarning(message: string): void;
	/**
	 * The same readiness/residency gate every other isolated consumer uses
	 * (LocalRuntimeController.ensureIsolatedModelReady) before this model is used for an
	 * out-of-band call. No-ops for a non-managed-local model (checked internally by the gate);
	 * throws with a user-actionable reason when a managed-local model cannot be made ready.
	 */
	ensureModelReady(model: Model<Api>): Promise<void>;
}

export class CompactionSupport {
	private readonly deps: CompactionSupportDeps;
	private lastSelectionReason: string | undefined;

	constructor(deps: CompactionSupportDeps) {
		this.deps = deps;
	}

	getLastSelectionReason(): string | undefined {
		return this.lastSelectionReason;
	}

	getAdaptedSettings(): CompactionSettings {
		const settingsManager = this.deps.getSettingsManager();
		const settings = settingsManager.getCompactionSettings();
		const model = this.deps.getModel();
		if (!model) return settings;
		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return settings;

		// Adapt reserveTokens: at most 25% of context window
		const maxReserve = Math.floor(contextWindow * 0.25);
		const reserveTokens = Math.min(settings.reserveTokens, maxReserve);

		// Adapt keepRecentTokens: at most 50% of context window
		const maxKeepRecent = Math.floor(contextWindow * 0.5);
		const keepRecentTokens = Math.min(settings.keepRecentTokens, maxKeepRecent);
		const sessionReplacement = usesXaiSubscriptionSessionReplacement(model);
		const tierAwareTriggerPercent = sessionReplacement
			? undefined
			: tierAwareCompactionTriggerPercent(model, contextWindow, settings.triggerPercent, settingsManager);

		return {
			...settings,
			reserveTokens,
			keepRecentTokens,
			...(tierAwareTriggerPercent !== undefined ? { triggerPercent: tierAwareTriggerPercent } : {}),
			...(sessionReplacement
				? {
						strategy: "session-replacement" as const,
						triggerPercent: settingsManager.hasExplicitCompactionTriggerPercent()
							? settings.triggerPercent
							: XAI_SUBSCRIPTION_COMPACTION_TRIGGER_PERCENT,
					}
				: {}),
		};
	}

	async getRequestAuth(model: Model<Api>): Promise<RequestAuth> {
		if (this.deps.isRawStream()) {
			return this.deps.getRequiredRequestAuth(model);
		}

		const result = await this.deps.getModelRegistry().getApiKeyAndHeaders(model);
		return result.ok ? { apiKey: result.apiKey, headers: result.headers } : {};
	}

	/**
	 * Readiness/residency gate a candidate summarizer model right before it is handed back for
	 * use. A no-op for a non-managed-local model (checked internally by
	 * {@link CompactionSupportDeps.ensureModelReady}); a managed-local model that cannot be made
	 * ready (server down, model missing, residency refused) returns its failure reason instead of
	 * throwing, so callers can still try the next candidate in the existing auth-fallback ladder
	 * rather than aborting resolution outright.
	 */
	private async readinessFailure(model: Model<Api>): Promise<string | undefined> {
		try {
			await this.deps.ensureModelReady(model);
			return undefined;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}

	/**
	 * Resolve the summarizer model AND its request auth for auto-compaction. The cheap auxiliary
	 * model (#30) can be nominally available yet fail key resolution at request time (expired
	 * OAuth, revoked key) — or, for a managed-local model, fail the readiness/residency gate (
	 * server down, model not installed, residency refused). Falling back to the session model keeps
	 * auto-compaction working in exactly the situations where manual /compact works; only when
	 * neither resolves do we fail — and then with a concrete message instead of a silent no-op or a
	 * bypass of the readiness gate.
	 */
	async resolveModelAndAuth(
		compactionModel: Model<Api>,
		sessionModel: Model<Api>,
	): Promise<{ model: Model<Api>; apiKey?: string; headers?: Record<string, string>; failure?: string }> {
		if (this.deps.isRawStream()) {
			const registry = this.deps.getModelRegistry();
			let auth = await registry.getApiKeyAndHeaders(compactionModel);
			let readiness: string | undefined;
			if (registry.canUseResolvedRequestAuth(compactionModel, auth)) {
				readiness = await this.readinessFailure(compactionModel);
				if (!readiness) return { model: compactionModel, apiKey: auth.apiKey, headers: auth.headers };
			}
			const isSameModel =
				compactionModel.provider === sessionModel.provider && compactionModel.id === sessionModel.id;
			if (!isSameModel) {
				auth = await registry.getApiKeyAndHeaders(sessionModel);
				if (registry.canUseResolvedRequestAuth(sessionModel, auth)) {
					readiness = await this.readinessFailure(sessionModel);
					if (!readiness) return { model: sessionModel, apiKey: auth.apiKey, headers: auth.headers };
				}
			}
			return {
				model: sessionModel,
				failure: readiness
					? `summarizer ${isSameModel ? compactionModel.id : sessionModel.id} not ready: ${readiness}`
					: `no usable request authentication for the summarizer (tried ${compactionModel.id}${isSameModel ? "" : ` and ${sessionModel.id}`})`,
			};
		}

		// Custom streamFn owns auth injection (CLI path) — resolve best-effort, never fail on auth
		// here; a managed-local summarizer must still pass the readiness gate before compact() runs.
		const { apiKey, headers } = await this.getRequestAuth(compactionModel);
		const readiness = await this.readinessFailure(compactionModel);
		if (readiness) {
			return {
				model: compactionModel,
				apiKey,
				headers,
				failure: `summarizer ${compactionModel.id} not ready: ${readiness}`,
			};
		}
		return { model: compactionModel, apiKey, headers };
	}

	private getExplicitCompactionModelSetting(): string | undefined {
		const setting = this.deps.getSettingsManager().getCompactionModel().trim();
		return setting && setting !== "auto" ? setting : undefined;
	}

	private modelRef(model: Model<Api>): string {
		return `${model.provider}/${model.id}`;
	}

	private resolveConfiguredModel(pattern: string): { model?: Model<Api>; cause?: "unresolved" | "unauthed" } {
		const registry = this.deps.getModelRegistry();
		const resolved = resolveCliModel({ cliModel: pattern, modelRegistry: registry });
		if (!resolved.model) return { cause: "unresolved" };
		if (!registry.hasConfiguredAuth(resolved.model)) return { cause: "unauthed" };
		return { model: resolved.model };
	}

	private selectConfiguredModel(pattern: string): { model?: Model<Api>; cause?: string } {
		const resolved = this.resolveConfiguredModel(pattern);
		if (!resolved.model) return { cause: resolved.cause };
		if (this.deps.isModelExhausted(this.modelRef(resolved.model))) return { cause: "exhausted" };
		return { model: resolved.model };
	}

	private effectiveContextWindow(model: Model<Api>): number {
		const registered = model.contextWindow > 0 ? model.contextWindow : Number.POSITIVE_INFINITY;
		const served = this.deps.getStoredFitnessReport(this.modelRef(model))?.capacity?.servedContextWindow;
		return served && served > 0 ? Math.min(registered, served) : registered;
	}

	private modelWithEffectiveWindow(model: Model<Api>): Model<Api> {
		const contextWindow = this.effectiveContextWindow(model);
		return contextWindow === model.contextWindow ? model : { ...model, contextWindow };
	}

	private resolveDefaultModel(sessionModel: Model<Api>): Model<Api> {
		if (usesXaiSubscriptionSessionReplacement(sessionModel)) {
			this.lastSelectionReason = "session_replacement";
			return sessionModel;
		}
		const router = this.deps.getSettingsManager().getModelRouterSettings();
		if (!router.enabled || !router.cheapModel) {
			this.lastSelectionReason = "session_default";
			return sessionModel;
		}
		const selected = this.selectConfiguredModel(router.cheapModel);
		if (!selected.model) {
			this.lastSelectionReason = `fallback:${selected.cause}`;
			return sessionModel;
		}
		// Capacity is a hard constraint, independent of the fitness doctrine: a summarizer whose
		// window cannot hold the actual span produces recall-empty checkpoints (local servers
		// silently truncate over-window prompts instead of erroring), and the verification gate
		// then fails deterministically.
		const estimatedInputTokens = this.deps.estimateSummarizationInputTokens();
		const effectiveWindow = this.effectiveContextWindow(selected.model);
		if (!summarizerCanIngest(this.modelWithEffectiveWindow(selected.model), estimatedInputTokens)) {
			this.lastSelectionReason = `fallback:window_too_small(~${Math.ceil(estimatedInputTokens / 1000)}k input vs ${effectiveWindow} window)`;
			return sessionModel;
		}
		const fitness = this.deps.getStoredFitnessReport(this.modelRef(selected.model));
		const verdict = evaluateSurfaceFitness("compaction", fitness);
		if (!verdict.fit) {
			this.lastSelectionReason =
				verdict.reason === "lane_failed"
					? `fallback:digest_unfit(${verdict.succeeded}/${verdict.total})`
					: "fallback:unprobed";
			return sessionModel;
		}
		this.lastSelectionReason = "router_cheap";
		return selected.model;
	}

	private modelsAreEqual(left: Model<Api>, right: Model<Api>): boolean {
		return left.provider === right.provider && left.id === right.id;
	}

	/**
	 * Resolve the model used to SUMMARIZE during compaction. Selection:
	 *   - an explicit `compaction.model` setting wins, but only if its provider is authed (else fall back);
	 *   - `"auto"`/unset follows the model router's configured cheap model when the router is enabled;
	 *   - otherwise the session model is used (safe default).
	 */
	resolveModel(sessionModel: Model<Api>): Model<Api> {
		const explicitSetting = this.getExplicitCompactionModelSetting();
		if (explicitSetting) {
			const selected = this.selectConfiguredModel(explicitSetting);
			this.lastSelectionReason = selected.model ? "explicit" : `fallback:${selected.cause}`;
			if (!selected.model) this.deps.emitWarning(`Compaction summarizer ${this.lastSelectionReason}`);
			// An explicit user choice is honored (Class C doctrine), but silently sending an
			// over-window prompt yields a recall-empty summary — warn with the numbers.
			if (selected.model) {
				const estimatedInputTokens = this.deps.estimateSummarizationInputTokens();
				const effectiveWindow = this.effectiveContextWindow(selected.model);
				if (!summarizerCanIngest(this.modelWithEffectiveWindow(selected.model), estimatedInputTokens)) {
					this.deps.emitWarning(
						`Compaction summarizer (explicit setting) likely cannot ingest the current context: ~${Math.ceil(estimatedInputTokens / 1000)}k input tokens vs a ${effectiveWindow}-token window`,
					);
				}
			}
			return selected.model ?? sessionModel;
		}
		const model = this.resolveDefaultModel(sessionModel);
		if (this.lastSelectionReason?.startsWith("fallback:")) {
			this.deps.emitWarning(`Compaction summarizer ${this.lastSelectionReason}`);
		}
		return model;
	}

	/** Default compaction should never inherit expensive session thinking. */
	resolveThinkingLevel(
		sessionThinkingLevel: ThinkingLevel | undefined,
		compactionModel: Model<Api>,
		sessionModel: Model<Api>,
	): ThinkingLevel | undefined {
		if (this.getExplicitCompactionModelSetting()) return sessionThinkingLevel;

		const router = this.deps.getSettingsManager().getModelRouterSettings();
		if (router.enabled && router.cheapModel) {
			const routerModel = this.resolveConfiguredModel(router.cheapModel).model;
			if (routerModel && this.modelsAreEqual(routerModel, compactionModel)) {
				return router.cheapThinking ?? "low";
			}
		}

		return this.modelsAreEqual(compactionModel, sessionModel) ? "low" : sessionThinkingLevel;
	}
}
