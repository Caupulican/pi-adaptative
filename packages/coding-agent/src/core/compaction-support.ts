/**
 * Compaction support: summarizer model selection (#30 cost guard), request-auth resolution
 * with session-model fallback, and window-adapted compaction settings.
 *
 * Extracted verbatim from AgentSession (agent-session.ts) as a narrow-deps collaborator; the
 * session keeps same-signature private delegations at every call-in point.
 */
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

	/**
	 * Resolve the model used to SUMMARIZE during compaction (cost guard, #30). A compaction summary is an
	 * extraction task — it does not need the main (expensive) model. Selection:
	 *   - an explicit `compaction.model` setting wins, but only if its provider is authed (else fall back);
	 *   - `"auto"` (default) picks the CHEAPEST authed model whose context window can hold a compaction
	 *     (capability floor), and ONLY if it is strictly cheaper than the session model — so we never
	 *     downgrade to an equally-priced but weaker summarizer (agy's floor: don't degrade the checkpoint);
	 *   - otherwise the session model is used (safe default).
	 */
	resolveModel(sessionModel: Model<any>): Model<any> {
		const registry = this.deps.getModelRegistry();
		const setting = this.deps.getSettingsManager().getCompactionModel();
		if (setting && setting !== "auto") {
			const resolved = resolveCliModel({ cliModel: setting, modelRegistry: registry });
			if (resolved.model && registry.hasConfiguredAuth(resolved.model)) return resolved.model;
			return sessionModel; // configured but unusable → don't break compaction
		}
		// "auto": cheapest authed model that can summarize a large context AND is cheaper than the session
		// model. The context-window floor keeps a tiny local model from being picked for a big summary.
		const FLOOR_CONTEXT = 64_000;
		const sessionInputCost = sessionModel.cost?.input ?? Number.POSITIVE_INFINITY;
		let best: Model<any> | undefined;
		for (const m of registry.getAvailable()) {
			if ((m.contextWindow ?? 0) < FLOOR_CONTEXT) continue;
			const cost = m.cost?.input ?? Number.POSITIVE_INFINITY;
			if (cost >= sessionInputCost) continue; // only ever pick something cheaper than the session model
			if (!best || cost < (best.cost?.input ?? Number.POSITIVE_INFINITY)) best = m;
		}
		return best ?? sessionModel;
	}
}
