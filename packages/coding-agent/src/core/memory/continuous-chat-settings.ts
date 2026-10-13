/**
 * ICM continuous-chat settings: the intrinsic view sizes and compaction concurrency, and the validation of the one
 * cheap model the chat's compactions run on. The model and its external egress come from the existing memory history
 * settings; nothing here reads or creates a credential.
 */

import type { Api, Model } from "@caupulican/pi-ai";
import { getSupportedThinkingLevels } from "@caupulican/pi-ai/models";
import { isLocalExecutionModel } from "../models/model-endpoint.ts";
import type { MemorySystem } from "../settings/settings-schema.ts";
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
	readonly allowExternalSummaryEgress: boolean;
	readonly maxConcurrentCompactions: number;
	readonly turnView: ContinuousChatViewBudget;
	readonly causalView: ContinuousChatViewBudget;
}

/** The settings the chat reads: the memory system and the existing history settings owner. */
export interface ContinuousChatSettingsSource {
	getMemorySystem(): MemorySystem;
	getMemoryHistorySettings(): { summaryModel: string | undefined; allowExternalSummaryEgress: boolean };
}

/** Intrinsic to ICM: the turn view is merged down to `lowBytes` once it passes `highBytes`. */
export const CONTINUOUS_CHAT_TURN_VIEW_BUDGET: ContinuousChatViewBudget = { lowBytes: 64_000, highBytes: 128_000 };
/** Intrinsic to ICM: a compaction's causal view is merged down to `lowBytes` once it passes `highBytes`. */
export const CONTINUOUS_CHAT_CAUSAL_VIEW_BUDGET: ContinuousChatViewBudget = { lowBytes: 16_000, highBytes: 32_000 };
/** Compactions that may run at once. */
export const CONTINUOUS_CHAT_MAX_CONCURRENT_COMPACTIONS = 8;
/** The reasoning effort every compaction requests: the reference's xhigh, through the model's own thinking levels. */
export const CONTINUOUS_CHAT_COMPACTION_THINKING_LEVEL = "xhigh" as const;

export function readContinuousChatSettings(source: ContinuousChatSettingsSource): ContinuousChatSettings {
	const history = source.getMemoryHistorySettings();
	return {
		enabled: source.getMemorySystem() === "icm",
		summaryTree: "intrinsic",
		summaryModel: history.summaryModel,
		allowExternalSummaryEgress: history.allowExternalSummaryEgress,
		maxConcurrentCompactions: CONTINUOUS_CHAT_MAX_CONCURRENT_COMPACTIONS,
		turnView: CONTINUOUS_CHAT_TURN_VIEW_BUDGET,
		causalView: CONTINUOUS_CHAT_CAUSAL_VIEW_BUDGET,
	};
}

export type ContinuousChatSummaryModelResolution =
	| { ok: true; model: Model<Api>; reference: string }
	| { ok: false; reason: string };

/**
 * Resolves the configured cheap model through the existing summary-model resolver (the one the transcript summarizer
 * uses), then checks its egress and its xhigh thinking level. Every refusal names the setting to change. Nothing falls
 * back to another model, and no result is cached: the next call resolves again.
 */
export function validateContinuousChatSummaryModel(
	settings: Pick<ContinuousChatSettings, "summaryModel" | "allowExternalSummaryEgress">,
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
	if (!getSupportedThinkingLevels(model).includes(CONTINUOUS_CHAT_COMPACTION_THINKING_LEVEL)) {
		return {
			ok: false,
			reason: `The ICM chat's summary model ${reference} does not support xhigh thinking, which its compactions require: set contextPolicy.memory.history.summaryModel to a reasoning model that supports xhigh, for example "<provider>/<model>".`,
		};
	}
	return { ok: true, model, reference };
}
