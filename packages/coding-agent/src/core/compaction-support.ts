/**
 * Compaction support: summarizer model selection (#30 cost guard), request-auth resolution
 * with session-model fallback, and window-adapted compaction settings.
 *
 * Extracted verbatim from AgentSession (agent-session.ts) as a narrow-deps collaborator; the
 * session keeps same-signature private delegations at every call-in point.
 */
import type { ThinkingLevel } from "@caupulican/pi-agent-core";
import type { CompactionSettings } from "@caupulican/pi-agent-core/node";
import type { Model } from "@caupulican/pi-ai";
import type { ModelRegistry } from "./model-registry.ts";
import { resolveCliModel } from "./model-resolver.ts";
import type { SettingsManager } from "./settings-manager.ts";

export interface CompactionSupportDeps {
	getModel(): Model<any> | undefined;
	getSettingsManager(): SettingsManager;
	getModelRegistry(): ModelRegistry;
	/** True when the agent's streamFn is (or wraps) the raw streamSimple — auth must be explicit then. */
	isRawStream(): boolean;
	/** Host auth resolution that THROWS with a user-actionable message when no key exists. */
	getRequiredRequestAuth(model: Model<any>): Promise<{ apiKey?: string; headers?: Record<string, string> }>;
}

export class CompactionSupport {
	private readonly deps: CompactionSupportDeps;

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

	private resolveConfiguredModel(pattern: string): Model<any> | undefined {
		const registry = this.deps.getModelRegistry();
		const resolved = resolveCliModel({ cliModel: pattern, modelRegistry: registry });
		if (!resolved.model || !registry.hasConfiguredAuth(resolved.model)) return undefined;
		return resolved.model;
	}

	private resolveDefaultModel(sessionModel: Model<any>): Model<any> {
		const router = this.deps.getSettingsManager().getModelRouterSettings();
		if (!router.enabled || !router.cheapModel) return sessionModel;
		return this.resolveConfiguredModel(router.cheapModel) ?? sessionModel;
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
		if (explicitSetting) return this.resolveConfiguredModel(explicitSetting) ?? sessionModel;
		return this.resolveDefaultModel(sessionModel);
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
			const routerModel = this.resolveConfiguredModel(router.cheapModel);
			if (routerModel && this.modelsAreEqual(routerModel, compactionModel)) {
				return router.cheapThinking ?? "low";
			}
		}

		return this.modelsAreEqual(compactionModel, sessionModel) ? "low" : sessionThinkingLevel;
	}
}
