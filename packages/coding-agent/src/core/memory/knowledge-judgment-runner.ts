/** The session model as a judge for knowledge and routine intake: one isolated, bounded and accounted structured submission. */
import { randomUUID } from "node:crypto";
import type { Api, Model } from "@caupulican/pi-ai";
import { resolveModelThinkingLevel } from "@caupulican/pi-ai/models";
import type { AgentTool } from "../../kernel/types.ts";
import type { IsolatedCompletionOptions, IsolatedCompletionResult } from "../agent-session-contracts.ts";
import { BoundedCompletionUsage } from "../cost/bounded-completion-usage.ts";
import { RequestSpendBudget, RequestSpendRefusal } from "../cost/request-spend-budget.ts";
import type { SessionSemanticUsageDelivery } from "../cost/semantic-usage-delivery.ts";
import type { DecisionOptions, SemanticDecisionEngine } from "../decision/engine.ts";
import {
	type LlmCompletionRunner,
	STRUCTURED_JUDGMENT_SUBMISSION_SCHEMA,
	type StructuredJudgmentRequest,
	StructuredLlmDecisionEngine,
} from "../decision/engines/structured-llm-engine.ts";
import { DecisionEngineProtocolError } from "../decision/protocol-error.ts";
import type { MaintenanceUsageRoute } from "../review/system-one-review-port.ts";
import type { AutoLearnSettings } from "../settings/settings-schema.ts";
import { canonicalDigest } from "../steering/canonical.ts";
import { KNOWLEDGE_COLLECTION_OPERATION_PREFIX } from "./knowledge-collector.ts";

export const KNOWLEDGE_JUDGMENT_TOOL_NAME = "submit_judgment";
const MAX_STATE_TOKENS = 32_000;
const MAX_JUDGMENT_OUTPUT_TOKENS = 4_096;

export interface KnowledgeJudgmentRunnerDeps {
	readonly model: Model<Api>;
	readonly usageOwner: SessionSemanticUsageDelivery;
	/** The maintenance route every judgment is accounted to and the isolated lane it runs in. */
	readonly route: Extract<MaintenanceUsageRoute, "knowledge_collection" | "routine_intake">;
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
			throw new RequestSpendRefusal("A session-model judgment requires a bounded spending allowance.");
		options.signal?.throwIfAborted();
		const { model } = this.deps;
		const usage = new BoundedCompletionUsage(this.deps.usageOwner, this.deps.route, budget, 1, origin);
		const unsubscribe = options.onRequestAdmitted ? budget.subscribeAdmission(options.onRequestAdmitted) : undefined;
		const capture: { answers?: unknown } = {};
		// One fixed definition for every program: the offered tool never breaks the judge's cached prefix.
		const submit: AgentTool<typeof STRUCTURED_JUDGMENT_SUBMISSION_SCHEMA> = {
			name: KNOWLEDGE_JUDGMENT_TOOL_NAME,
			label: "Submit judgment",
			description: "Submit one answer for every decision of the program. This ends the judgment.",
			parameters: STRUCTURED_JUDGMENT_SUBMISSION_SCHEMA,
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
				// The program is identical for every judgment of its kind; the boundary declares the prefix through it stable.
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: request.program, cacheBoundary: true },
							{ type: "text", text: request.state },
						],
						timestamp: Date.now(),
					},
				],
				model,
				thinkingLevel: resolveModelThinkingLevel(model, "low"),
				maxTokens: Math.min(model.maxTokens, MAX_JUDGMENT_OUTPUT_TOKENS),
				maxTurns: 1,
				maxRetries: 0,
				signal: options.signal,
				cacheRetention: "short",
				laneKind: this.deps.route,
				tools: [submit],
				...usage.submissionHooks("Submit the judgment as the only tool call in its message."),
			});
			// A received submission is the answer even if its measured charge failed the allowance. The failed
			// allowance refuses the caller's next request, so a paid answer is never discarded and bought again.
			if (capture.answers !== undefined) return capture.answers;
			usage.assertHealthy();
			if (result.stopReason === "error" || result.stopReason === "aborted")
				throw new Error(result.errorMessage ?? `Session-model judgment ${result.stopReason}.`);
			throw new DecisionEngineProtocolError("The session-model judgment ended without a submission.");
		} finally {
			unsubscribe?.();
			usage.release();
		}
	}
}

export interface SessionKnowledgeJudgeDeps {
	/** The collection model (`autoLearn.model`), resolved exactly as extraction resolves it. */
	model(): Model<Api> | undefined;
	usageOwner(): SessionSemanticUsageDelivery;
	autoLearn(): Required<AutoLearnSettings>;
	maxEstimatedUsd(): number | undefined;
	runIsolatedCompletion(options: IsolatedCompletionOptions): Promise<IsolatedCompletionResult>;
}

/**
 * The session model's knowledge engine. One instance per model and usage owner, because admission
 * fences on engine identity; it is offered only to knowledge, never to other System One consumers.
 */
export class SessionKnowledgeJudge {
	private readonly deps: SessionKnowledgeJudgeDeps;
	private current:
		| { key: string; usageOwner: SessionSemanticUsageDelivery; engine: SemanticDecisionEngine }
		| undefined;

	constructor(deps: SessionKnowledgeJudgeDeps) {
		this.deps = deps;
	}

	engine(): SemanticDecisionEngine | undefined {
		const model = this.deps.model();
		if (!model) return undefined;
		const usageOwner = this.deps.usageOwner();
		const key = canonicalDigest(model);
		if (this.current?.key !== key || this.current.usageOwner !== usageOwner) {
			const runner = new KnowledgeJudgmentRunner({
				model,
				usageOwner,
				route: "knowledge_collection",
				runIsolatedCompletion: (options) => this.deps.runIsolatedCompletion(options),
			});
			this.current = {
				key,
				usageOwner,
				engine: new StructuredLlmDecisionEngine(`${model.provider}/${model.id}`, runner),
			};
		}
		return this.current.engine;
	}

	/** One explicit change spends under the same per-change and per-session limits as automatic collection. */
	explicitRequest(engine: SemanticDecisionEngine | undefined): Pick<DecisionOptions, "budget" | "origin"> | undefined {
		const current = this.current;
		if (!engine || engine !== current?.engine) return undefined;
		const settings = this.deps.autoLearn();
		const operationId = `${KNOWLEDGE_COLLECTION_OPERATION_PREFIX}explicit:${randomUUID()}`;
		const spending = current.usageOwner.spending(KNOWLEDGE_COLLECTION_OPERATION_PREFIX, operationId);
		if (spending.unresolved)
			throw new RequestSpendRefusal("Knowledge spending for this session is not settled yet; retry later.");
		const remaining = Math.min(
			settings.knowledgeMaxUsd,
			settings.knowledgeSessionMaxUsd - spending.totalUsd,
			this.deps.maxEstimatedUsd() ?? Number.POSITIVE_INFINITY,
		);
		if (!(remaining > 0))
			throw new RequestSpendRefusal("The knowledge spending allowance for this session is exhausted.");
		return {
			budget: new RequestSpendBudget(remaining),
			origin: { ...current.usageOwner.captureOrigin(), operationId },
		};
	}
}
