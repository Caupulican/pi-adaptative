/**
 * The restricted summary task for the history hierarchy, over the existing isolated-completion boundary.
 *
 * No router, no credential client and no tools of its own: the model comes from the session's model
 * registry (configured and authenticated models only), the call is one tool-free text completion on the
 * background provider lane (which yields to the foreground), and what it costs is charged to the owning
 * session through the idempotent spawned-usage ledger so background spend stays visible.
 */

import { randomUUID } from "node:crypto";
import type { Api, Model, Usage } from "@caupulican/pi-ai";
import { addUsage, createEmptyUsage } from "../../kernel/usage.ts";
import type { IsolatedCompletionOptions, IsolatedCompletionResult } from "../agent-session-contracts.ts";
import { isLocalExecutionModel } from "../models/model-endpoint.ts";
import { reportSpawnedUsage } from "../spawned-usage.ts";
import type { TranscriptSummarizerPort } from "./transcript-memory.ts";

const SUMMARY_LANE_KIND = "memory-summary";
const SUMMARY_USAGE_KIND = "memory-history-summary";

export interface TranscriptSummarizerDeps {
	/** Resolve a configured model reference to a model the session can authenticate; undefined when it cannot. */
	resolveModel(reference: string): Model<Api> | undefined;
	runIsolatedCompletion(options: IsolatedCompletionOptions): Promise<IsolatedCompletionResult>;
	addSpawnedUsage(
		usage: Usage,
		options: { label?: string; sourceSessionId?: string; reportId: string },
	): string | undefined;
	getSessionId(): string;
}

export type TranscriptSummarizerResolution =
	| { ok: true; summarizer: TranscriptSummarizerPort; model: string }
	| { ok: false; reason: string };

/**
 * Resolve the configured summary model into a summarizer. `egress` is `local` only for a local-class
 * model (a local runtime provider or a loopback endpoint, the harness's one classification); anything
 * else is external and the coordinator refuses it unless the owner allowed external summary egress.
 */
export function resolveTranscriptSummarizer(
	summaryModel: string | undefined,
	deps: TranscriptSummarizerDeps,
): TranscriptSummarizerResolution {
	if (summaryModel === undefined) {
		return { ok: false, reason: "no summary model is configured (contextPolicy.memory.history.summaryModel)" };
	}
	const model = deps.resolveModel(summaryModel);
	if (!model) {
		return { ok: false, reason: `summary model ${summaryModel} is unresolved or not authenticated` };
	}
	const modelRef = `${model.provider}/${model.id}`;
	return {
		ok: true,
		model: modelRef,
		summarizer: {
			egress: isLocalExecutionModel(model) ? "local" : "external",
			async summarize(input, signal) {
				const spent = createEmptyUsage();
				try {
					const completion = await deps.runIsolatedCompletion({
						systemPrompt: input.system,
						messages: [{ role: "user", content: [{ type: "text", text: input.prompt }], timestamp: Date.now() }],
						model,
						thinkingLevel: "off",
						// A token is at least one byte, so this bounds the reply's token count by its byte ceiling.
						maxTokens: input.maxOutputBytes,
						signal,
						cacheRetention: "short",
						laneKind: SUMMARY_LANE_KIND,
					});
					addUsage(spent, completion.usage);
					if (completion.stopReason !== "stop") {
						throw new Error(
							`summary model ${modelRef} stopped with ${completion.stopReason}: ${completion.errorMessage ?? "no provider detail"}`,
						);
					}
					return { text: completion.text, model: modelRef };
				} finally {
					// Charged whether or not the reply was accepted: the tokens were spent either way.
					reportSpawnedUsage(deps, spent, {
						kind: SUMMARY_USAGE_KIND,
						label: SUMMARY_USAGE_KIND,
						sessionId: deps.getSessionId(),
						identity: randomUUID(),
					});
				}
			},
		},
	};
}
