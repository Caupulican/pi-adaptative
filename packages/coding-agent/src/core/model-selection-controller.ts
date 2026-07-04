/**
 * User-facing model + thinking-level selection.
 *
 * Extracted verbatim from agent-session.ts (god-file decomposition). Owns the manual/explicit model
 * switch and cycle paths and the thinking-level set/cycle/clamp — the deliberate human choices, as
 * opposed to the per-turn auto-routing owned by ModelRouterController. It mutates `agent.state.model`
 * / `agent.state.thinkingLevel` through deps and re-derives the capability-scoped tool surface, but the
 * session keeps the `model`/`thinkingLevel` GETTERS so the drive loop's reads are untouched. Model
 * choice is advisory-only: it warns on a bad-fit fitness probe or an oversized local model, never blocks.
 */

import { totalmem } from "node:os";
import type { Agent, ThinkingLevel } from "@caupulican/pi-agent-core";
import type { SessionManager } from "@caupulican/pi-agent-core/node";
import type { Api, Model } from "@caupulican/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels, modelsAreEqual } from "@caupulican/pi-ai";
import type { AgentSessionEvent, ModelCycleResult } from "./agent-session.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type { ExtensionRunner } from "./extensions/index.ts";
import type { ModelCapabilityProfile } from "./model-capability.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { FitnessStore } from "./models/fitness-store.ts";
import { OLLAMA_PROVIDER } from "./models/local-registration.ts";
import type { OllamaRuntime } from "./models/local-runtime.ts";
import { matchesInstalledLocalModel } from "./models/model-ref.ts";
import { isProbeAllFailed } from "./research/model-fitness.ts";
import type { SettingsManager } from "./settings-manager.ts";

/** Standard thinking levels (fallback set when the current model is unknown). */
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

export interface ModelSelectionControllerDeps {
	getAgent(): Agent;
	getModel(): Model<any> | undefined;
	getThinkingLevel(): ThinkingLevel;
	getModelRegistry(): ModelRegistry;
	getSessionManager(): SessionManager;
	getSettingsManager(): SettingsManager;
	getExtensionRunner(): ExtensionRunner;
	getAgentDir(): string;
	/** Scoped models (--models flag), used by the cycle path. */
	getScopedModels(): Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	/** The user-requested active tool set, re-applied when the model's capability class changes. */
	getRequestedActiveToolNames(): string[] | undefined;
	getActiveToolNames(): string[];
	setActiveToolsByName(toolNames: string[]): void;
	getModelCapabilityProfile(): ModelCapabilityProfile;
	/** Session event emit (warnings + thinking_level_changed; model_select goes via the extension runner). */
	emit(event: AgentSessionEvent): void;
	/** Context-window-usage warning check (session-owned, compaction-adjacent). */
	checkContextWindowUsageWarning(): void;
	/** Resolve the Ollama server URL for a model base URL (local-runtime controller). */
	deriveOllamaServerUrl(modelBaseUrl: string): string;
	/** Local Ollama runtime for the given server URL (used for the oversized-model risk check). */
	getLocalRuntime(serverUrl: string): OllamaRuntime;
}

export class ModelSelectionController {
	private readonly deps: ModelSelectionControllerDeps;

	constructor(deps: ModelSelectionControllerDeps) {
		this.deps = deps;
	}

	private async _emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		if (modelsAreEqual(previousModel, nextModel)) return;
		await this.deps.getExtensionRunner().emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	/**
	 * Set model directly.
	 * Validates that auth is configured, saves to session and settings.
	 * @throws Error if no auth is configured for the model
	 */
	async setModel(model: Model<any>, options: { persistSettings?: boolean } = {}): Promise<void> {
		if (!this.deps.getModelRegistry().hasConfiguredAuth(model)) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const persistSettings = options.persistSettings ?? true;
		const previousModel = this.deps.getModel();
		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		this.deps.getAgent().state.model = model;
		this.deps.getSessionManager().appendModelChange(model.provider, model.id);
		if (persistSettings) {
			this.deps.getSettingsManager().setDefaultModelAndProvider(model.provider, model.id);
		}

		// Re-clamp thinking level for new model's capabilities
		this.setThinkingLevel(thinkingLevel, { persistSettings });

		await this._emitModelSelect(model, previousModel, "set");
		this.deps.checkContextWindowUsageWarning();
		await this._warnIfManualModelChoiceIsRisky(model);

		// Re-derive the model-capability tool surface for the new model (restores the full requested
		// set when moving small -> large, reduces it when moving large -> small).
		const requestedActiveToolNames = this.deps.getRequestedActiveToolNames();
		if (requestedActiveToolNames) {
			const before = this.deps.getActiveToolNames().join(",");
			this.deps.setActiveToolsByName(requestedActiveToolNames);
			const capability = this.deps.getModelCapabilityProfile();
			if (capability.class !== "full" && this.deps.getActiveToolNames().join(",") !== before) {
				this.deps.emit({
					type: "warning",
					message: `Small-context model detected (${capability.contextWindow ?? "unknown"} tokens, class '${capability.class}'): active tools reduced to [${this.deps.getActiveToolNames().join(", ")}]; background lanes ${capability.backgroundLanesEnabled ? "enabled" : "disabled"}.`,
				});
			}
		}
	}

	/**
	 * Manual model choice is a deliberate human decision, not an auto-adoption flow — it is
	 * ADVISORY ONLY: warn on evidence the model is a bad fit, but never block and never prompt
	 * (print/RPC modes only ever see plain warning text through the existing `warning` event, the
	 * same channel `_checkContextWindowUsageWarning` above uses). Two independent checks, both
	 * best-effort:
	 *  - a recorded all-lanes-failed fitness probe on THIS host (see `isProbeAllFailed`);
	 *  - for an Ollama-served local model, weights that exceed ~90% of total system memory, which
	 *    is the exact failure the OOM report reproduced (llama-server needs the whole model resident).
	 */
	private async _warnIfManualModelChoiceIsRisky(model: Model<Api>): Promise<void> {
		const canonicalRef = `${model.provider}/${model.id}`;
		try {
			const fitness = FitnessStore.forAgentDir(this.deps.getAgentDir())
				.getForHost()
				.find((entry) => entry.model === canonicalRef);
			if (fitness && isProbeAllFailed(fitness.report)) {
				this.deps.emit({
					type: "warning",
					message: `${canonicalRef} failed its fitness probe on all surfaces on this host (probed ${fitness.at}) — it is likely to fail in production too. Proceeding because you set it manually.`,
				});
			}
		} catch {
			// advisory only; a lookup failure must never block a manual model choice
		}

		if (model.provider !== OLLAMA_PROVIDER) return;
		try {
			const serverUrl = this.deps.deriveOllamaServerUrl(model.baseUrl);
			const installed = await this.deps.getLocalRuntime(serverUrl).list();
			const entry = installed.find((candidate) => matchesInstalledLocalModel(model.id, candidate.name));
			if (!entry) return;
			const memoryBudget = totalmem() * 0.9;
			if (entry.sizeBytes > memoryBudget) {
				const sizeGb = (entry.sizeBytes / 1e9).toFixed(1);
				const totalGb = (totalmem() / 1e9).toFixed(1);
				this.deps.emit({
					type: "warning",
					message: `${canonicalRef} is ~${sizeGb}GB, over 90% of this machine's ${totalGb}GB RAM — llama-server is likely to OOM when it runs. Proceeding because you set it manually.`,
				});
			}
		} catch {
			// advisory only; an unreachable local server must never block a manual model choice
		}
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		if (this.deps.getScopedModels().length > 0) {
			return this._cycleScopedModel(direction);
		}
		return this._cycleAvailableModel(direction);
	}

	private async _cycleScopedModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const scopedModels = this.deps
			.getScopedModels()
			.filter((scoped) => this.deps.getModelRegistry().hasConfiguredAuth(scoped.model));
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.deps.getModel();
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];
		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.thinkingLevel);

		// Apply model
		this.deps.getAgent().state.model = next.model;
		this.deps.getSessionManager().appendModelChange(next.model.provider, next.model.id);
		this.deps.getSettingsManager().setDefaultModelAndProvider(next.model.provider, next.model.id);

		// Apply thinking level.
		// - Explicit scoped model thinking level overrides current session level
		// - Undefined scoped model thinking level inherits the current session preference
		// setThinkingLevel clamps to model capabilities.
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(next.model, currentModel, "cycle");

		this.deps.checkContextWindowUsageWarning();
		await this._warnIfManualModelChoiceIsRisky(next.model);

		return { model: next.model, thinkingLevel: this.deps.getThinkingLevel(), isScoped: true };
	}

	private async _cycleAvailableModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const availableModels = await this.deps.getModelRegistry().getAvailable();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.deps.getModel();
		let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		this.deps.getAgent().state.model = nextModel;
		this.deps.getSessionManager().appendModelChange(nextModel.provider, nextModel.id);
		this.deps.getSettingsManager().setDefaultModelAndProvider(nextModel.provider, nextModel.id);

		// Re-clamp thinking level for new model's capabilities
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(nextModel, currentModel, "cycle");

		this.deps.checkContextWindowUsageWarning();
		await this._warnIfManualModelChoiceIsRisky(nextModel);

		return { model: nextModel, thinkingLevel: this.deps.getThinkingLevel(), isScoped: false };
	}

	/**
	 * Set thinking level.
	 * Clamps to model capabilities based on available thinking levels.
	 * Saves to session and settings only if the level actually changes.
	 */
	setThinkingLevel(level: ThinkingLevel, options: { persistSettings?: boolean } = {}): void {
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

		// Only persist if actually changing
		const previousLevel = this.deps.getAgent().state.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;
		const persistSettings = options.persistSettings ?? true;

		this.deps.getAgent().state.thinkingLevel = effectiveLevel;

		if (isChanging) {
			this.deps.getSessionManager().appendThinkingLevelChange(effectiveLevel);
			if (persistSettings && (this.supportsThinking() || effectiveLevel !== "off")) {
				this.deps.getSettingsManager().setDefaultThinkingLevel(effectiveLevel);
			}
			this.deps.emit({ type: "thinking_level_changed", level: effectiveLevel });
			void this.deps.getExtensionRunner().emit({
				type: "thinking_level_select",
				level: effectiveLevel,
				previousLevel,
			});
		}
	}

	/**
	 * Cycle to next thinking level.
	 * @returns New level, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.deps.getThinkingLevel());
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	/**
	 * Get available thinking levels for current model.
	 * The provider will clamp to what the specific model supports internally.
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		const model = this.deps.getModel();
		if (!model) return THINKING_LEVELS;
		return getSupportedThinkingLevels(model) as ThinkingLevel[];
	}

	/**
	 * Check if current model supports thinking/reasoning.
	 */
	supportsThinking(): boolean {
		return !!this.deps.getModel()?.reasoning;
	}

	private _getThinkingLevelForModelSwitch(explicitLevel?: ThinkingLevel): ThinkingLevel {
		if (explicitLevel !== undefined) {
			return explicitLevel;
		}
		if (!this.supportsThinking()) {
			return this.deps.getSettingsManager().getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
		}
		return this.deps.getThinkingLevel();
	}

	private _clampThinkingLevel(level: ThinkingLevel, _availableLevels: ThinkingLevel[]): ThinkingLevel {
		const model = this.deps.getModel();
		return model ? (clampThinkingLevel(model, level) as ThinkingLevel) : "off";
	}
}
