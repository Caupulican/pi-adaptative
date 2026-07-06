/**
 * Compaction support: summarizer model selection (#30 cost guard), request-auth resolution
 * with session-model fallback, and window-adapted compaction settings.
 *
 * Extracted verbatim from AgentSession (agent-session.ts) as a narrow-deps collaborator; the
 * session keeps same-signature private delegations at every call-in point.
 */
import type { ThinkingLevel } from "@caupulican/pi-agent-core";
import { type CompactionSettings, summarizerCanIngest } from "@caupulican/pi-agent-core/node";
import type { Model } from "@caupulican/pi-ai";
import type { ModelRegistry } from "./model-registry.ts";
import { resolveCliModel } from "./model-resolver.ts";
import { evaluateSurfaceFitness } from "./model-router/fitness-gate.ts";
import type { ModelFitnessReport } from "./research/model-fitness.ts";
import type { SettingsManager } from "./settings-manager.ts";

export interface CompactionSupportDeps {
	getModel(): Model<any> | undefined;
	getSettingsManager(): SettingsManager;
	getModelRegistry(): ModelRegistry;
	/** True when the agent's streamFn is (or wraps) the raw streamSimple — auth must be explicit then. */
	isRawStream(): boolean;
	/** Host auth resolution that THROWS with a user-actionable message when no key exists. */
	getRequiredRequestAuth(model: Model<any>): Promise<{ apiKey?: string; headers?: Record<string, string> }>;
	isModelExhausted(ref: string): boolean;
	getStoredFitnessReport(ref: string): ModelFitnessReport | undefined;
	/** Estimated tokens of the summarization input (live context; over-estimates, which is safe). */
	estimateSummarizationInputTokens(): number;
	emitWarning(message: string): void;
}

export class CompactionSupport {
	private readonly deps: CompactionSupportDeps;
	private lastSelectionReason: string | undefined;

	constructor(deps: CompactionSupportDeps) {
		this.deps = deps;
	}

	getAdaptedSettings(): CompactionSettings {
		const settings = this.deps.getSettingsManager().getCompactionSettings();
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

		return {
			...settings,
			reserveTokens,
			keepRecentTokens,
		};
	}

	async getRequestAuth(model: Model<any>): Promise<{
		apiKey?: string;
		headers?: Record<string, string>;
	}> {
		if (this.deps.isRawStream()) {
			return this.deps.getRequiredRequestAuth(model);
		}

		const result = await this.deps.getModelRegistry().getApiKeyAndHeaders(model);
		return result.ok ? { apiKey: result.apiKey, headers: result.headers } : {};
	}

	/**
	 * Resolve the summarizer model AND its request auth for auto-compaction. The cheap auxiliary
	 * model (#30) can be nominally available yet fail key resolution at request time (expired
	 * OAuth, revoked key). Falling back to the session model keeps auto-compaction working in
	 * exactly the situations where manual /compact works; only when neither resolves do we fail —
	 * and then with a concrete message instead of a silent no-op.
	 */
	async resolveModelAndAuth(
		compactionModel: Model<any>,
		sessionModel: Model<any>,
	): Promise<{ model: Model<any>; apiKey?: string; headers?: Record<string, string>; failure?: string }> {
		if (this.deps.isRawStream()) {
			const registry = this.deps.getModelRegistry();
			let auth = await registry.getApiKeyAndHeaders(compactionModel);
			if (auth.ok && auth.apiKey) {
				return { model: compactionModel, apiKey: auth.apiKey, headers: auth.headers };
			}
			const isSameModel =
				compactionModel.provider === sessionModel.provider && compactionModel.id === sessionModel.id;
			if (!isSameModel) {
				auth = await registry.getApiKeyAndHeaders(sessionModel);
				if (auth.ok && auth.apiKey) {
					return { model: sessionModel, apiKey: auth.apiKey, headers: auth.headers };
				}
			}
			return {
				model: sessionModel,
				failure: `no usable API key for the summarizer (tried ${compactionModel.id}${isSameModel ? "" : ` and ${sessionModel.id}`})`,
			};
		}

		// Custom streamFn owns auth injection (CLI path) — resolve best-effort, never fail here.
		const { apiKey, headers } = await this.getRequestAuth(compactionModel);
		return { model: compactionModel, apiKey, headers };
	}

	private getExplicitCompactionModelSetting(): string | undefined {
		const setting = this.deps.getSettingsManager().getCompactionModel().trim();
		return setting && setting !== "auto" ? setting : undefined;
	}

	private modelRef(model: Model<any>): string {
		return `${model.provider}/${model.id}`;
	}

	private resolveConfiguredModel(pattern: string): { model?: Model<any>; cause?: "unresolved" | "unauthed" } {
		const registry = this.deps.getModelRegistry();
		const resolved = resolveCliModel({ cliModel: pattern, modelRegistry: registry });
		if (!resolved.model) return { cause: "unresolved" };
		if (!registry.hasConfiguredAuth(resolved.model)) return { cause: "unauthed" };
		return { model: resolved.model };
	}

	private selectConfiguredModel(pattern: string): { model?: Model<any>; cause?: string } {
		const resolved = this.resolveConfiguredModel(pattern);
		if (!resolved.model) return { cause: resolved.cause };
		if (this.deps.isModelExhausted(this.modelRef(resolved.model))) return { cause: "exhausted" };
		return { model: resolved.model };
	}

	private effectiveContextWindow(model: Model<any>): number {
		const registered = model.contextWindow > 0 ? model.contextWindow : Number.POSITIVE_INFINITY;
		const served = this.deps.getStoredFitnessReport(this.modelRef(model))?.capacity?.servedContextWindow;
		return served && served > 0 ? Math.min(registered, served) : registered;
	}

	private modelWithEffectiveWindow(model: Model<any>): Model<any> {
		const contextWindow = this.effectiveContextWindow(model);
		return contextWindow === model.contextWindow ? model : { ...model, contextWindow };
	}

	private resolveDefaultModel(sessionModel: Model<any>): Model<any> {
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

	private modelsAreEqual(left: Model<any>, right: Model<any>): boolean {
		return left.provider === right.provider && left.id === right.id;
	}

	/**
	 * Resolve the model used to SUMMARIZE during compaction. Selection:
	 *   - an explicit `compaction.model` setting wins, but only if its provider is authed (else fall back);
	 *   - `"auto"`/unset follows the model router's configured cheap model when the router is enabled;
	 *   - otherwise the session model is used (safe default).
	 */
	resolveModel(sessionModel: Model<any>): Model<any> {
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
		compactionModel: Model<any>,
		sessionModel: Model<any>,
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
