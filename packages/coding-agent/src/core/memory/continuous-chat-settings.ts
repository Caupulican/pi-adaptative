/**
 * ICM continuous-chat settings: the intrinsic view sizes and compaction concurrency, and the validation of the one
 * cheap model the chat's compactions run on. The model and its external egress come from the existing memory history
 * settings; nothing here reads or creates a credential.
 */

import type { Api, Model, ThinkingLevel } from "@caupulican/pi-ai";
import { getSupportedThinkingLevels } from "@caupulican/pi-ai/models";
import { isLocalExecutionModel } from "../models/model-endpoint.ts";
import type { MemorySystem } from "../settings/settings-schema.ts";
import { CONTINUOUS_CHAT_MAX_CONCURRENT_COMPACTIONS } from "./continuous-chat-work-queue.ts";
import type { TranscriptSummarizerDeps } from "./transcript-summarizer.ts";

export interface ContinuousChatViewBudget {
	readonly lowBytes: number;
	readonly highBytes: number;
}

export interface ContinuousChatSettings {
	/** True only under the ICM memory system; the OKF system never builds the chat. */
	readonly enabled: boolean;
	/** The summary tree is part of ICM, not an opt-in: `history.hierarchy` is never read for the chat. */
	readonly summaryTree: "intrinsic";
	readonly summaryModel: string | undefined;
	/** The reasoning effort of every compaction: a line of at most 512 bytes does not need more than a little. */
	readonly thinkingLevel: ContinuousChatThinkingLevel;
	readonly allowExternalSummaryEgress: boolean;
	readonly maxConcurrentCompactions: number;
	readonly turnView: ContinuousChatViewBudget;
	readonly causalView: ContinuousChatViewBudget;
}

/** The settings the chat reads: the memory system and the existing history settings owner. */
export interface ContinuousChatSettingsSource {
	getMemorySystem(): MemorySystem;
	getMemoryHistorySettings(): {
		summaryModel: string | undefined;
		compactionThinkingLevel: ContinuousChatThinkingLevel | undefined;
		allowExternalSummaryEgress: boolean;
	};
}

/** Intrinsic to ICM: the turn view is merged down to `lowBytes` once it passes `highBytes`. */
export const CONTINUOUS_CHAT_TURN_VIEW_BUDGET: ContinuousChatViewBudget = { lowBytes: 64_000, highBytes: 128_000 };
/** Intrinsic to ICM: a compaction's causal view is merged down to `lowBytes` once it passes `highBytes`. */
export const CONTINUOUS_CHAT_CAUSAL_VIEW_BUDGET: ContinuousChatViewBudget = { lowBytes: 16_000, highBytes: 32_000 };
export type ContinuousChatThinkingLevel = Extract<ThinkingLevel, "minimal" | "low" | "medium" | "high" | "xhigh">;

/** The compaction reasoning effort when `contextPolicy.memory.history.compactionThinkingLevel` is unset. */
export const DEFAULT_CONTINUOUS_CHAT_COMPACTION_THINKING_LEVEL: ContinuousChatThinkingLevel = "low";

export function readContinuousChatSettings(source: ContinuousChatSettingsSource): ContinuousChatSettings {
	const history = source.getMemoryHistorySettings();
	return {
		enabled: source.getMemorySystem() === "icm",
		summaryTree: "intrinsic",
		summaryModel: history.summaryModel,
		thinkingLevel: history.compactionThinkingLevel ?? DEFAULT_CONTINUOUS_CHAT_COMPACTION_THINKING_LEVEL,
		allowExternalSummaryEgress: history.allowExternalSummaryEgress,
		maxConcurrentCompactions: CONTINUOUS_CHAT_MAX_CONCURRENT_COMPACTIONS,
		turnView: CONTINUOUS_CHAT_TURN_VIEW_BUDGET,
		causalView: CONTINUOUS_CHAT_CAUSAL_VIEW_BUDGET,
	};
}

export type ContinuousChatSummaryModelResolution =
	| { ok: true; model: Model<Api>; reference: string; thinkingLevel: ContinuousChatThinkingLevel }
	| { ok: false; reason: string };

/**
 * Resolves the configured cheap model through the existing summary-model resolver (the one the transcript summarizer
 * uses), then checks its egress and its xhigh thinking level. Every refusal names the setting to change. Nothing falls
 * back for invalid settings; the shared resolver may recover a valid catalog model's failed credential or quota.
 * No result is cached: the next call resolves again.
 */
export function validateContinuousChatSummaryModel(
	settings: Pick<ContinuousChatSettings, "summaryModel" | "thinkingLevel" | "allowExternalSummaryEgress">,
	deps: Pick<TranscriptSummarizerDeps, "resolveModel">,
): ContinuousChatSummaryModelResolution {
	if (settings.summaryModel === undefined) {
		return {
			ok: false,
			reason:
				'The ICM chat needs a cheap model for its compactions, and contextPolicy.memory.history.summaryModel is not set: set it to a configured model, for example "<provider>/<model>". If that model is not local, also set contextPolicy.memory.history.allowExternalSummaryEgress to true.',
		};
	}
	const model = deps.resolveModel(settings.summaryModel);
	if (model === undefined) {
		return {
			ok: false,
			reason: `The ICM chat's summary model ${settings.summaryModel} (contextPolicy.memory.history.summaryModel) is unknown or not authenticated: set it to a configured model, for example "<provider>/<model>".`,
		};
	}
	const reference = `${model.provider}/${model.id}`;
	if (!isLocalExecutionModel(model) && !settings.allowExternalSummaryEgress) {
		return {
			ok: false,
			reason: `The ICM chat's summary model ${reference} is not local, and external summary egress is not allowed: set contextPolicy.memory.history.allowExternalSummaryEgress to true to allow it.`,
		};
	}
	if (!getSupportedThinkingLevels(model).includes(settings.thinkingLevel)) {
		return {
			ok: false,
			reason: `The ICM chat's summary model ${reference} does not support ${settings.thinkingLevel} thinking, which its compactions request: set contextPolicy.memory.history.compactionThinkingLevel to a level it supports, or contextPolicy.memory.history.summaryModel to another model, for example "<provider>/<model>".`,
		};
	}
	return { ok: true, model, reference, thinkingLevel: settings.thinkingLevel };
}
