/**
 * The compaction policy a worker's conversation runs under: the worker's own context window with root's boundaries, admitted as a
 * worker's conversation store reads it. A pure function of the model and the compaction settings.
 */
import type { Api, Model } from "@caupulican/pi-ai";
import { assessCompactionNeed, hardCompactionTriggerTokens } from "../../kernel/compaction/compaction.ts";
import type { AgentMessage } from "../../kernel/index.ts";
import type { ParentExecutionSettingsSource } from "./parent-execution-context.ts";
import type { WorkerConversationRetentionPolicy } from "./worker-conversation-store.ts";

/** Root's compaction reserve on the worker's own window: never more than a quarter of it. */
export function laneCompactionReserveTokens(contextWindow: number, reserveTokens: number): number {
	return Math.min(reserveTokens, Math.floor(contextWindow * 0.25));
}

export function workerConversationRetentionPolicy(
	model: Model<Api>,
	settingsManager: ParentExecutionSettingsSource,
	admitEarly?: (contextTokens: number, messages: readonly AgentMessage[]) => boolean,
): WorkerConversationRetentionPolicy | undefined {
	const settings = settingsManager.getCompactionSettings();
	const contextWindow = Math.floor(model.contextWindow ?? 0);
	if (!settings.enabled || contextWindow < 4) return undefined;
	// Root's boundaries on the worker's own window: the hard limit always compacts; the fractional
	// trigger is the early band, where a compaction runs only when its price admits it.
	const laneSettings = {
		...settings,
		reserveTokens: laneCompactionReserveTokens(contextWindow, settings.reserveTokens),
	};
	const modelTrigger =
		model.autoCompactionTriggerTokens && model.autoCompactionTriggerTokens > 0
			? Math.floor(model.autoCompactionTriggerTokens)
			: undefined;
	const maxContextTokens = hardCompactionTriggerTokens(contextWindow, laneSettings, modelTrigger);
	if (maxContextTokens < 2) return undefined;
	const keepRecentTokens = Math.max(
		1,
		Math.min(settings.keepRecentTokens, Math.floor(contextWindow * 0.5), maxContextTokens - 1),
	);
	return {
		maxContextTokens,
		keepRecentTokens,
		...(admitEarly
			? {
					admitEarlyCompaction: (contextTokens: number, messages: readonly AgentMessage[]) =>
						assessCompactionNeed(
							contextTokens,
							contextWindow,
							{ ...laneSettings, keepRecentTokens },
							modelTrigger,
						) === "early" && admitEarly(contextTokens, messages),
				}
			: {}),
	};
}
