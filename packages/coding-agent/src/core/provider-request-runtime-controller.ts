import { estimateProviderRequestTokens } from "@caupulican/pi-agent-core";
import type { Agent } from "@caupulican/pi-agent-core/agent";
import type { CompactionController } from "./compaction-controller.ts";
import type { ProviderRequestContextController } from "./provider-request-context-controller.ts";

export interface ProviderRequestRuntimeControllerDeps {
	agent: Agent;
	compaction: Pick<CompactionController, "admitProviderRequest">;
	context: ProviderRequestContextController;
}

/** Installs and owns the one provider planning/admission hook generation on an Agent. */
export class ProviderRequestRuntimeController {
	private readonly deps: ProviderRequestRuntimeControllerDeps;
	private previousTransformContext: Agent["transformContext"];
	private previousPlanContext: Agent["planContext"];
	private previousAdmission: Agent["admitProviderRequest"];
	private installedTransformContext: Agent["transformContext"];
	private installedPlanContext: Agent["planContext"];
	private installedAdmission: Agent["admitProviderRequest"];

	constructor(deps: ProviderRequestRuntimeControllerDeps) {
		this.deps = deps;
	}

	install(): void {
		if (this.installedPlanContext) return;
		const agent = this.deps.agent;
		this.previousTransformContext = agent.transformContext;
		this.previousPlanContext = agent.planContext;
		this.previousAdmission = agent.admitProviderRequest;
		const previousTransformContext = this.previousTransformContext?.bind(agent);
		const previousPlanContext = this.previousPlanContext?.bind(agent);
		const previousAdmission = this.previousAdmission?.bind(agent);

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
			const decision = await this.deps.compaction.admitProviderRequest({
				requestTokens: estimateProviderRequestTokens(request.context),
				nonCompactableTokens: estimateProviderRequestTokens(request.nonCompactableContext),
				attempt: request.attempt,
			});
			if (decision.action === "replan") {
				return {
					action: "replan",
					context: { ...request.sourceContext, messages: agent.state.messages.slice() },
				};
			}
			return (await previousAdmission?.(request, signal)) ?? { action: "send" };
		};

		agent.planContext = this.installedPlanContext;
		agent.transformContext = this.installedTransformContext;
		agent.admitProviderRequest = this.installedAdmission;
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
		this.installedTransformContext = undefined;
		this.installedPlanContext = undefined;
		this.installedAdmission = undefined;
	}
}
