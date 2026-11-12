/** Fits task-selected knowledge against the same materialized request the kernel will send. */
import type { Api, Model } from "@caupulican/pi-ai";
import type { AgentContextPlan, AgentContextPlanRequest } from "../../kernel/loop-config.ts";
import { createCustomMessage } from "../../kernel/messages.ts";
import { isContextPlanDispatchCurrent } from "../../kernel/provider-request-planner.ts";
import { HOST_REQUEST_ONLY_DETAILS } from "../../kernel/transient-records.ts";
import { resolveMemoryPromptBudget } from "../context/memory-prompt-budget.ts";
import { estimateReplyReserveTokens } from "../context/prompt-headroom.ts";
import {
	KNOWLEDGE_CONTEXT_CLEARED,
	KNOWLEDGE_CONTEXT_CUSTOM_TYPE,
	type KnowledgeProjection,
} from "../memory/knowledge-projection.ts";
import type { WorkerMemoryBroker } from "../memory/worker-memory-tools.ts";

const MAX_FITTING_ATTEMPTS = 6;

export type WorkerKnowledgeContextResult =
	| { kind: "ready"; plan: AgentContextPlan }
	| { kind: "needs_capacity"; promptTokens: number; limitTokens: number };

export async function appendWorkerKnowledgeContext(input: {
	plan: AgentContextPlan;
	model: Model<Api>;
	measureRequest: NonNullable<AgentContextPlanRequest["measureRequest"]>;
	projectKnowledge: NonNullable<WorkerMemoryBroker["projectKnowledge"]>;
	compactionReserveTokens: number;
	maxOutputTokens: number;
	remainingTokenAllowance(): number | undefined;
	signal?: AbortSignal;
}): Promise<WorkerKnowledgeContextResult> {
	const { plan, model, signal } = input;
	const remaining = input.remainingTokenAllowance();
	const reserve = estimateReplyReserveTokens({
		contextWindow: model.contextWindow,
		compactionReserveTokens: input.compactionReserveTokens,
		maxOutputTokens: input.maxOutputTokens,
	});
	const windowLimit =
		Number.isFinite(model.contextWindow) && model.contextWindow > 0
			? model.contextWindow - reserve
			: Number.POSITIVE_INFINITY;
	const compose = (projection: KnowledgeProjection, content = projection.text || KNOWLEDGE_CONTEXT_CLEARED) => {
		const knowledgeCurrent = () =>
			!signal?.aborted && projection.isCurrent() === true && remaining === input.remainingTokenAllowance();
		return {
			...plan,
			transientMessages: [
				...(plan.transientMessages ?? []),
				createCustomMessage(
					KNOWLEDGE_CONTEXT_CUSTOM_TYPE,
					content,
					false,
					HOST_REQUEST_ONLY_DETAILS,
					"1970-01-01T00:00:00.000Z",
				),
			],
			isCurrent: () => plan.isCurrent?.() !== false && knowledgeCurrent(),
			isDispatchCurrent: () => isContextPlanDispatchCurrent(plan) && knowledgeCurrent(),
		};
	};
	try {
		signal?.throwIfAborted();
		// Reserve the mandatory supersession notice even when no optional fact can fit.
		const emptyBudget = resolveMemoryPromptBudget({ contextWindow: 0 });
		const clearProjection = input.projectKnowledge(emptyBudget);
		const clearPlan = compose(clearProjection, KNOWLEDGE_CONTEXT_CLEARED);
		const clearTokens = await input.measureRequest(clearPlan);
		signal?.throwIfAborted();
		if (clearTokens > windowLimit)
			return { kind: "needs_capacity", promptTokens: clearTokens, limitTokens: windowLimit };
		let budget = resolveMemoryPromptBudget({
			contextWindow: model.contextWindow,
			currentPromptTokens: clearTokens,
			reservedTokens: reserve,
			remainingTokenAllowance: remaining,
		});
		const totalLimit = Math.min(windowLimit, clearTokens + budget.maxEstimatedTokens);
		for (let attempt = 0; budget.enabled && attempt < MAX_FITTING_ATTEMPTS; attempt++) {
			const projection = input.projectKnowledge(budget);
			if (!projection.text) break;
			const candidate = compose(projection);
			const tokens = await input.measureRequest(candidate);
			signal?.throwIfAborted();
			if (tokens <= totalLimit) return { kind: "ready", plan: candidate };
			// JSON/protocol framing can exceed the text estimate; retry only a bounded number of smaller views.
			budget = resolveMemoryPromptBudget({
				contextWindow: model.contextWindow,
				currentPromptTokens: clearTokens,
				reservedTokens: reserve,
				remainingTokenAllowance: remaining,
				ceilingTokens: Math.floor(budget.maxEstimatedTokens / 2),
			});
		}
		return { kind: "ready", plan: clearPlan };
	} catch (error) {
		// A plan that never reaches the kernel still owns any resources its earlier stages acquired.
		plan.discard?.();
		throw error;
	}
}
