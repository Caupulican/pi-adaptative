/** The session model as a knowledge judge: one isolated, bounded and accounted structured submission. */
import type { Api, Model } from "@caupulican/pi-ai";
import { resolveModelThinkingLevel } from "@caupulican/pi-ai/models";
import type { TSchema } from "typebox";
import type { AgentTool } from "../../kernel/types.ts";
import type { IsolatedCompletionOptions, IsolatedCompletionResult } from "../agent-session-contracts.ts";
import { BoundedCompletionUsage } from "../cost/bounded-completion-usage.ts";
import { RequestSpendRefusal } from "../cost/request-spend-budget.ts";
import type { SessionSemanticUsageDelivery } from "../cost/semantic-usage-delivery.ts";
import type { DecisionOptions } from "../decision/engine.ts";
import type { LlmCompletionRunner, StructuredJudgmentRequest } from "../decision/engines/structured-llm-engine.ts";
import { DecisionEngineProtocolError } from "../decision/protocol-error.ts";

export const KNOWLEDGE_JUDGMENT_TOOL_NAME = "submit_judgment";
const MAX_STATE_TOKENS = 32_000;
const MAX_JUDGMENT_OUTPUT_TOKENS = 4_096;

export interface KnowledgeJudgmentRunnerDeps {
	readonly model: Model<Api>;
	readonly usageOwner: SessionSemanticUsageDelivery;
	runIsolatedCompletion(options: IsolatedCompletionOptions): Promise<IsolatedCompletionResult>;
}

/**
 * Every judgment spends from the caller's request budget under the caller's accounting origin, through the
 * same bounded-completion owner as extraction. A call without both is refused before any request.
 */
export class KnowledgeJudgmentRunner implements LlmCompletionRunner {
	readonly requestBudget = true;
	readonly requestLifecycle = true;
	readonly maxStateTokens: number;
	private readonly deps: KnowledgeJudgmentRunnerDeps;

	constructor(deps: KnowledgeJudgmentRunnerDeps) {
		this.deps = deps;
		this.maxStateTokens = Math.min(MAX_STATE_TOKENS, Math.floor(deps.model.contextWindow / 2));
	}

	async judge(
		request: StructuredJudgmentRequest,
		options?: Pick<DecisionOptions, "budget" | "origin" | "onRequestAdmitted" | "signal">,
	): Promise<unknown> {
		const budget = options?.budget;
		const origin = options?.origin;
		if (!budget || !origin)
			throw new RequestSpendRefusal("A session-model knowledge judgment requires a bounded spending allowance.");
		options.signal?.throwIfAborted();
		const { model } = this.deps;
		const usage = new BoundedCompletionUsage(this.deps.usageOwner, "knowledge_collection", budget, 1, origin);
		const unsubscribe = options.onRequestAdmitted ? budget.subscribeAdmission(options.onRequestAdmitted) : undefined;
		const capture: { answers?: unknown } = {};
		const submit: AgentTool<TSchema> = {
			name: KNOWLEDGE_JUDGMENT_TOOL_NAME,
			label: "Submit judgment",
			description: "Submit the answer to every decision. This ends the judgment.",
			parameters: request.answerSchema,
			executionMode: "sequential",
			execute: async (_id, params) => {
				if (capture.answers !== undefined)
					throw new DecisionEngineProtocolError("The judgment was already submitted.");
				capture.answers = params;
				return {
					content: [{ type: "text", text: "Judgment received." }],
					details: {},
					terminate: true,
				};
			},
		};
		try {
			const result = await this.deps.runIsolatedCompletion({
				systemPrompt: request.systemPrompt,
				messages: [{ role: "user", content: [{ type: "text", text: request.payload }], timestamp: Date.now() }],
				model,
				thinkingLevel: resolveModelThinkingLevel(model, "low"),
				maxTokens: Math.min(model.maxTokens, MAX_JUDGMENT_OUTPUT_TOKENS),
				maxTurns: 1,
				maxRetries: 0,
				signal: options.signal,
				cacheRetention: "short",
				laneKind: "knowledge_collection",
				tools: [submit],
				beforeToolCall: async (context) => {
					usage.assertHealthy();
					if (context.assistantMessage.content.filter((part) => part.type === "toolCall").length !== 1)
						return { block: true, reason: "Submit the judgment as the only tool call in its message." };
					return undefined;
				},
				requestPreflight: (preflight) => usage.preflight(preflight),
				requestGuard: () => {
					usage.assertHealthy();
				},
				providerResponseObserver: usage,
			});
			usage.assertHealthy();
			if (result.stopReason === "error" || result.stopReason === "aborted")
				throw new Error(result.errorMessage ?? `Knowledge judgment ${result.stopReason}.`);
			if (capture.answers === undefined)
				throw new DecisionEngineProtocolError("The knowledge judgment ended without a submission.");
			return capture.answers;
		} finally {
			unsubscribe?.();
			usage.release();
		}
	}
}
