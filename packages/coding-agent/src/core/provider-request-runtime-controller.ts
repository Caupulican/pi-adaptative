import type { Agent } from "@caupulican/pi-agent-core/agent";
import { getApplicableAssistantUsageInfo } from "@caupulican/pi-agent-core/compaction/compaction";
import { estimateProviderRequestTokens } from "@caupulican/pi-agent-core/provider-request-estimator";
import { composeRequestSystemPrompt, narrowRequestMaxTokens } from "@caupulican/pi-agent-core/provider-request-planner";
import type { ProviderRequestAdmissionContext } from "@caupulican/pi-agent-core/types";
import type { Api, AssistantMessage, Model } from "@caupulican/pi-ai";
import type { CompactionController } from "./compaction-controller.ts";
import type { ProviderRequestContextController } from "./provider-request-context-controller.ts";

interface RequestEnvelopeSnapshot {
	modelKey: string;
	tokens: number;
}

interface UsageEnvelopeAnchor extends RequestEnvelopeSnapshot {
	message: AssistantMessage;
}

export interface ProviderRequestRuntimeControllerDeps {
	agent: Agent;
	compaction: Pick<CompactionController, "admitProviderRequest" | "measureLiveContextTokens">;
	context: ProviderRequestContextController;
	admitGoalRequest(): number | undefined;
	/**
	 * True once the goal owning the currently held execution lease crossed its token budget from
	 * charging the response just received. Checked before EVERY provider request (including a
	 * multi-step tool-loop follow-up); returning true ends the loop gracefully after the current
	 * turn's in-flight work completes, instead of letting a doomed request reach admission and throw.
	 */
	shouldStopGoalExecutionAfterTurn(): boolean;
}

/** Installs and owns the one provider planning/admission hook generation on an Agent. */
export class ProviderRequestRuntimeController {
	private readonly deps: ProviderRequestRuntimeControllerDeps;
	private previousTransformContext: Agent["transformContext"];
	private previousPlanContext: Agent["planContext"];
	private previousAdmission: Agent["admitProviderRequest"];
	private previousShouldStopAfterTurn: Agent["shouldStopAfterTurn"];
	private installedTransformContext: Agent["transformContext"];
	private installedPlanContext: Agent["planContext"];
	private installedAdmission: Agent["admitProviderRequest"];
	private installedShouldStopAfterTurn: Agent["shouldStopAfterTurn"];
	private pendingSentEnvelope: RequestEnvelopeSnapshot | undefined;
	private usageEnvelopeAnchor: UsageEnvelopeAnchor | undefined;

	constructor(deps: ProviderRequestRuntimeControllerDeps) {
		this.deps = deps;
	}

	private modelKey(model: Pick<Model<Api>, "provider" | "id">): string {
		return `${model.provider}\u0000${model.id}`;
	}

	/**
	 * A provider usage sample already includes the system/tool envelope of the request that produced
	 * it. Reuse that authoritative same-model total and charge only the envelope change plus trailing
	 * conversation. A resumed or restored controller treats the current envelope as the baseline;
	 * first requests and model switches retain the conservative full-payload fallback.
	 */
	private estimateRequestTokens(
		request: ProviderRequestAdmissionContext,
		fallbackTokens: number,
		nonCompactableTokens: number,
	): number {
		const usageInfo = getApplicableAssistantUsageInfo(request.sourceContext.messages);
		if (!usageInfo) return fallbackTokens;
		const usageMessage = request.sourceContext.messages[usageInfo.index];
		if (
			usageMessage?.role !== "assistant" ||
			usageMessage.provider !== request.model.provider ||
			usageMessage.model !== request.model.id
		) {
			return fallbackTokens;
		}

		const modelKey = this.modelKey(request.model);
		if (this.usageEnvelopeAnchor?.message !== usageMessage || this.usageEnvelopeAnchor.modelKey !== modelKey) {
			this.usageEnvelopeAnchor = {
				message: usageMessage,
				modelKey,
				tokens:
					this.pendingSentEnvelope?.modelKey === modelKey ? this.pendingSentEnvelope.tokens : nonCompactableTokens,
			};
		}

		const envelopeDelta = nonCompactableTokens - this.usageEnvelopeAnchor.tokens;
		const measuredTokens = this.deps.compaction.measureLiveContextTokens() + envelopeDelta;
		// The materialized plan is authoritative when replay-safe transforms such as context GC
		// shrink history for this exact request. Provider usage corrects an inflated character
		// estimate, but must not reintroduce bytes the accepted plan has already projected away.
		return Math.max(nonCompactableTokens, Math.min(fallbackTokens, measuredTokens));
	}

	private recordSentEnvelope(model: Model<Api>, tokens: number): void {
		this.pendingSentEnvelope = { modelKey: this.modelKey(model), tokens };
	}

	install(): void {
		if (this.installedPlanContext) return;
		const agent = this.deps.agent;
		this.previousTransformContext = agent.transformContext;
		this.previousPlanContext = agent.planContext;
		this.previousAdmission = agent.admitProviderRequest;
		this.previousShouldStopAfterTurn = agent.shouldStopAfterTurn;
		const previousTransformContext = this.previousTransformContext?.bind(agent);
		const previousPlanContext = this.previousPlanContext?.bind(agent);
		const previousAdmission = this.previousAdmission?.bind(agent);
		const previousShouldStopAfterTurn = this.previousShouldStopAfterTurn?.bind(agent);

		this.installedPlanContext = async ({ messages, attempt }, signal) => {
			const basePlan = previousPlanContext
				? await previousPlanContext({ messages, attempt }, signal)
				: {
						messages: previousTransformContext ? await previousTransformContext(messages, signal) : messages,
					};
			const sessionPlan = await this.deps.context.plan(basePlan.messages, signal);
			return {
				messages: sessionPlan.messages,
				transientMessages: [...(basePlan.transientMessages ?? []), ...(sessionPlan.transientMessages ?? [])],
				transientSystemPrompt: composeRequestSystemPrompt(
					basePlan.transientSystemPrompt,
					sessionPlan.transientSystemPrompt,
				),
				isCurrent: () => basePlan.isCurrent?.() !== false && sessionPlan.isCurrent?.() !== false,
				prepareCommit: () => {
					if (basePlan.isCurrent?.() === false || sessionPlan.isCurrent?.() === false) return false;
					return basePlan.prepareCommit?.() !== false && sessionPlan.prepareCommit?.() !== false;
				},
				commit: () => {
					basePlan.commit?.();
					sessionPlan.commit?.();
				},
				discard: () => {
					sessionPlan.discard?.();
					basePlan.discard?.();
				},
			};
		};
		this.installedTransformContext = async (messages, signal) => {
			const plan = await this.installedPlanContext?.({ messages, attempt: 0 }, signal);
			if (!plan) return messages;
			try {
				return [...plan.messages, ...(plan.transientMessages ?? [])];
			} finally {
				plan.discard?.();
			}
		};
		this.installedAdmission = async (request, signal) => {
			const fallbackTokens = estimateProviderRequestTokens(request.context, request.model);
			const nonCompactableTokens = estimateProviderRequestTokens(request.nonCompactableContext, request.model);
			const requestTokens = this.estimateRequestTokens(request, fallbackTokens, nonCompactableTokens);
			const decision = await this.deps.compaction.admitProviderRequest({
				requestTokens,
				nonCompactableTokens,
				attempt: request.attempt,
			});
			if (decision.action === "replan") {
				return {
					action: "replan",
					context: { ...request.sourceContext, messages: agent.state.messages.slice() },
				};
			}
			const previous = (await previousAdmission?.(request, signal)) ?? { action: "send" as const };
			if (previous.action === "replan") return previous;
			const goalMaxTokens = this.deps.admitGoalRequest();
			// Validated narrowing (shared with the planner's own final pass) instead of a hand-rolled
			// min-merge, so a degenerate goal-computed ceiling fails loudly here at admission instead of
			// silently passing through to fail deep inside the planner.
			const maxTokens = narrowRequestMaxTokens(
				previous.maxTokens,
				goalMaxTokens,
				request.model.maxTokens,
				"goal execution budget",
			);
			this.recordSentEnvelope(request.model, nonCompactableTokens);
			return maxTokens === undefined ? previous : { action: "send", maxTokens };
		};
		this.installedShouldStopAfterTurn = async (signal) => {
			if (this.deps.shouldStopGoalExecutionAfterTurn()) return true;
			return (await previousShouldStopAfterTurn?.(signal)) ?? false;
		};

		agent.planContext = this.installedPlanContext;
		agent.transformContext = this.installedTransformContext;
		agent.admitProviderRequest = this.installedAdmission;
		agent.shouldStopAfterTurn = this.installedShouldStopAfterTurn;
	}

	dispose(): void {
		const agent = this.deps.agent;
		if (agent.transformContext === this.installedTransformContext) {
			agent.transformContext = this.previousTransformContext;
		}
		if (agent.planContext === this.installedPlanContext) agent.planContext = this.previousPlanContext;
		if (agent.admitProviderRequest === this.installedAdmission) {
			agent.admitProviderRequest = this.previousAdmission;
		}
		if (agent.shouldStopAfterTurn === this.installedShouldStopAfterTurn) {
			agent.shouldStopAfterTurn = this.previousShouldStopAfterTurn;
		}
		this.installedTransformContext = undefined;
		this.installedPlanContext = undefined;
		this.installedAdmission = undefined;
		this.installedShouldStopAfterTurn = undefined;
		this.pendingSentEnvelope = undefined;
		this.usageEnvelopeAnchor = undefined;
	}
}
