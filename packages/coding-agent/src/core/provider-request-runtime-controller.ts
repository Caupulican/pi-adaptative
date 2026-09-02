import type { Agent } from "@caupulican/pi-agent-core/agent";
import { createApplicableAssistantUsageFinder } from "@caupulican/pi-agent-core/compaction/compaction";
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
	/** Session-wide per-response output cap; see SettingsManager.getMaxOutputTokens. */
	maxOutputTokens(): number;
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
	/** One usage-anchor finder per controller: it replays only messages appended since its last call. */
	private readonly findUsage = createApplicableAssistantUsageFinder();
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
		const usageInfo = this.findUsage(request.sourceContext.messages);
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

		// Forward the whole request object to `previousPlanContext` instead of rebuilding a
		// `{ messages, attempt }` literal from destructured parts: a request field this wrapper
		// doesn't itself read (the required `sentPrefixCount`, and any field added after it) must
		// still reach the wrapped hook unchanged. A destructure-and-rebuild silently drops whatever
		// wasn't named at the time it was written -- which is exactly how `sentPrefixCount` itself
		// went missing here before this fix.
		this.installedPlanContext = async (request, signal) => {
			const basePlan = previousPlanContext
				? await previousPlanContext(request, signal)
				: {
						messages: previousTransformContext
							? await previousTransformContext(request.messages, signal)
							: request.messages,
					};
			// `request.sentPrefixCount` indexes `request.messages`. In this codebase's actual wiring
			// `previousPlanContext`/`previousTransformContext` are never installed before this
			// controller (nothing sets `agent.planContext`/`agent.transformContext` first), so
			// `basePlan.messages` is `request.messages` unchanged and the mark applies directly. If a
			// future previous hook ever DOES reshape messages, `ProviderRequestContextController.plan`
			// re-anchors the mark by reference (`frozenPrefixLength`) rather than trusting the raw
			// index, so a misaligned mark here degrades to under-freezing, never to a corrupted rewrite.
			const sessionPlan = await this.deps.context.plan(basePlan.messages, request.sentPrefixCount, signal);
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
		// `transformContext` carries no `attempt`/`sentPrefixCount` of its own -- it is a strictly
		// narrower legacy hook (messages in, messages out) that this controller keeps wired only so
		// a config built WITHOUT `planContext` still degrades to something reasonable. INVESTIGATED,
		// not defaulted for convenience: `sentPrefixCount: 0` is not a placeholder here, it is the
		// only value that can be correct at this call site, for two independent reasons traced
		// through both packages (cross-package planContext routing fix).
		//
		// 1. This call is unreachable from any live production path today. `buildContextPlan`
		//    (`provider-request-planner.ts`) only falls back to `config.transformContext` when
		//    `config.planContext` is unset; `Agent.createLoopConfig()` (`agent.ts`) always copies
		//    BOTH `this.planContext` and `this.transformContext` from the same instance, and this
		//    controller always installs both together (`install()` above) -- so the foreground loop
		//    never takes the fallback branch. No isolated/child completion threads this installed
		//    `transformContext` through either (the only other consumer, `reflection-controller.ts`'s
		//    `runIsolatedCompletion`, uses a caller-supplied `opts.transformContext`, never this one,
		//    and never sets `planContext` on that config at all). Confirmed by grepping every
		//    `.transformContext(` call in both packages.
		// 2. Even if a future caller invoked `agent.transformContext(...)` directly, this class has
		//    no way to answer "how much of `messages` has already gone out on a provider request":
		//    that count lives in `Agent`'s private `loopContinuationState.providerRequestPrefixState`
		//    (`agent.ts`), reset to a fresh zero at the start of every `runPromptMessages()` call and
		//    never exposed outside the class. There is no cross-package accessor for it.
		//
		// `0` is also the SAFE direction to be wrong in if this ever does become reachable: per
		// `AgentContextPlanRequest`'s own contract, a too-low count only makes the sanitizer more
		// conservative about what it may rewrite (a cache-cost regression), never licenses it to
		// touch bytes that were genuinely already sent (which a too-HIGH count could do). If this
		// hook is ever wired to a real caller, that caller must supply its own tracked
		// `sentPrefixCount` -- this wrapper cannot synthesize one.
		this.installedTransformContext = async (messages, signal) => {
			const plan = await this.installedPlanContext?.({ messages, attempt: 0, sentPrefixCount: 0 }, signal);
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
			// Every request carries an output cap: the session-wide per-response cap, narrowed further
			// by the goal's remaining budget when one applies. Validated narrowing (shared with the
			// planner's own final pass) instead of a hand-rolled min-merge, so a degenerate ceiling
			// fails loudly here at admission instead of silently passing through to fail deep inside
			// the planner.
			const outputCap = this.deps.maxOutputTokens();
			const maxTokens = narrowRequestMaxTokens(
				previous.maxTokens,
				goalMaxTokens === undefined ? outputCap : Math.min(goalMaxTokens, outputCap),
				request.model.maxTokens,
				goalMaxTokens === undefined || goalMaxTokens >= outputCap ? "output cap" : "goal execution budget",
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
