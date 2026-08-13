import { estimateProviderRequestTokens } from "@caupulican/pi-agent-core";
import type { Agent } from "@caupulican/pi-agent-core/agent";
import { narrowRequestMaxTokens } from "@caupulican/pi-agent-core/agent-loop";
import type { CompactionController } from "./compaction-controller.ts";
import type { ProviderRequestContextController } from "./provider-request-context-controller.ts";

export interface ProviderRequestRuntimeControllerDeps {
	agent: Agent;
	compaction: Pick<CompactionController, "admitProviderRequest">;
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

	constructor(deps: ProviderRequestRuntimeControllerDeps) {
		this.deps = deps;
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
			const requestTokens = estimateProviderRequestTokens(request.context);
			const decision = await this.deps.compaction.admitProviderRequest({
				requestTokens,
				nonCompactableTokens: estimateProviderRequestTokens(request.nonCompactableContext),
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
	}
}
