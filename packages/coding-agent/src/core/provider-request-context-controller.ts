import { isDeepStrictEqual } from "node:util";
import { createCustomMessage } from "@caupulican/pi-agent-core/messages";
import type { AgentContextPlan, AgentMessage } from "@caupulican/pi-agent-core/types";
import type { ContextAuditReport } from "./context/context-audit.ts";
import type { PromptEnforcementReport } from "./context/context-prompt-enforcement.ts";
import type { PromptPolicyShadowReport } from "./context/context-prompt-policy.ts";
import type { MemoryRetrievalReport } from "./context/memory-retrieval.ts";
import type { ContextGcReport } from "./context-gc.ts";
import { captureGoalContextProjection, injectCompactGoalContext } from "./goals/compact-goal-context.ts";
import type { GoalState } from "./goals/goal-state.ts";
import type { CurrentTurnReflectionCuePlan } from "./reflection-controller.ts";
import type { SkillVaultController } from "./skill-vault.ts";

export interface ProviderRequestContextControllerDeps {
	transformBase?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	transformExtensions(messages: AgentMessage[]): Promise<{
		messages: AgentMessage[];
		transientMessages: AgentMessage[];
		isCurrent?(): boolean;
	}>;
	runContextAudit(messages: AgentMessage[]): ContextAuditReport;
	runPromptPolicyPlanning(report: ContextAuditReport): PromptPolicyShadowReport;
	runMemoryRetrieval(messages: AgentMessage[]): Promise<MemoryRetrievalReport>;
	applyContextGc(
		messages: AgentMessage[],
		writePayloads: boolean,
	): { messages: AgentMessage[]; report: ContextGcReport };
	correlatePromptPolicyWithContextGc(report: ContextGcReport): void;
	runPromptEnforcement(
		messages: AgentMessage[],
		report: PromptPolicyShadowReport,
	): { messages: AgentMessage[]; report: PromptEnforcementReport };
	enqueueRelevanceCuration(messages: AgentMessage[], report: PromptPolicyShadowReport): void;
	maybeDrainBrainCuration(): void;
	appendMemoryEvidence(messages: AgentMessage[], report: MemoryRetrievalReport): AgentMessage[];
	previewReflectionCue?(): CurrentTurnReflectionCuePlan | undefined;
	getGoalState(): GoalState | undefined;
	skillVault: SkillVaultController;
	applyPathAliases(messages: AgentMessage[]): { messages: AgentMessage[]; legend?: string };
}

export const PATH_ALIAS_LEGEND_CUSTOM_TYPE = "path_alias_legend";

/**
 * Carry the path-alias legend as the last transient message rather than in the system prompt.
 *
 * The legend names every alias the model can currently hit, so it necessarily changes as new
 * aliases mint. In the system prompt that change is maximally expensive: the system prompt is the
 * FIRST thing on the wire (`input[0]` for the Responses transports the xAI subscription path uses),
 * so a single new alias on turn 40 makes the whole conversation a cache miss and re-prefills every
 * token of it. Appended at the tail instead, the same change costs only the few hundred tokens
 * after it. The legend is a lookup table, not an instruction, so the tail is also where it reads
 * most naturally — right next to the ids it explains.
 */
function appendPathAliasLegend(transientMessages: AgentMessage[], legend: string | undefined): AgentMessage[] {
	if (!legend) return transientMessages;
	return [
		...transientMessages,
		createCustomMessage(PATH_ALIAS_LEGEND_CUSTOM_TYPE, legend, false, undefined, new Date().toISOString()),
	];
}

/** Coordinates replay-safe request context planning and accepted-plan lifecycle commit. */
export class ProviderRequestContextController {
	private readonly deps: ProviderRequestContextControllerDeps;

	constructor(deps: ProviderRequestContextControllerDeps) {
		this.deps = deps;
	}

	async plan(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentContextPlan> {
		const transformed = this.deps.transformBase ? await this.deps.transformBase(messages, signal) : messages;
		const extensionPlan = await this.deps.transformExtensions(transformed);
		const goalContextProjection = captureGoalContextProjection(extensionPlan.messages);
		const reflectionCuePlan = this.deps.previewReflectionCue?.();
		const providerTransients = [
			...extensionPlan.transientMessages,
			...(reflectionCuePlan ? [reflectionCuePlan.message] : []),
		];
		const durableMessages = injectCompactGoalContext(extensionPlan.messages, undefined);
		const extensionMessages = [...durableMessages, ...providerTransients];
		const auditReport = this.deps.runContextAudit(extensionMessages);
		const shadowReport = this.deps.runPromptPolicyPlanning(auditReport);
		const memoryReport = await this.deps.runMemoryRetrieval(extensionMessages);
		const previewGc = this.deps.applyContextGc(durableMessages, false);
		const pathAliasPlan = this.deps.applyPathAliases(previewGc.messages);
		const previewProviderMessages = [...pathAliasPlan.messages, ...providerTransients];
		const previewEnforcement = this.deps.runPromptEnforcement(previewProviderMessages, shadowReport);
		if (previewEnforcement.messages.length !== previewProviderMessages.length) {
			throw new Error("Provider request enforcement changed message cardinality");
		}
		const compactableMessages = previewEnforcement.messages.slice(0, previewGc.messages.length);
		const goalState = this.deps.getGoalState();
		const withExtensionTransients = previewEnforcement.messages.slice(previewGc.messages.length);
		const withMemory = this.deps.appendMemoryEvidence(
			[...compactableMessages, ...withExtensionTransients],
			memoryReport,
		);
		const beforeSkill = injectCompactGoalContext(withMemory, goalState, goalContextProjection);
		if (!isDeepStrictEqual(beforeSkill.slice(0, compactableMessages.length), compactableMessages)) {
			throw new Error("Provider request transient contributors changed compactable history");
		}
		const legend = pathAliasPlan.legend;
		const transientMessages = appendPathAliasLegend(beforeSkill.slice(compactableMessages.length), legend);
		const transientSystemPrompt = this.deps.skillVault.previewSystemPromptSection();
		const skillRevision = this.deps.skillVault.getContextRevision();
		const dependenciesCurrent = () =>
			extensionPlan.isCurrent?.() !== false &&
			reflectionCuePlan?.isCurrent() !== false &&
			this.deps.skillVault.getContextRevision() === skillRevision &&
			isDeepStrictEqual(this.deps.getGoalState(), goalState);
		const projectCommit = (writePayloads: boolean) => {
			const gc = this.deps.applyContextGc(durableMessages, writePayloads);
			const aliased = this.deps.applyPathAliases(gc.messages);
			const providerMessages = [...aliased.messages, ...providerTransients];
			const enforcement = this.deps.runPromptEnforcement(providerMessages, shadowReport);
			return { enforcement, gc, providerMessages, aliased };
		};

		return {
			messages: compactableMessages,
			transientMessages,
			transientSystemPrompt,
			isCurrent: dependenciesCurrent,
			prepareCommit: () => {
				if (!dependenciesCurrent()) return false;
				const projected = projectCommit(false);
				return (
					isDeepStrictEqual(projected.enforcement.messages, previewEnforcement.messages) &&
					this.deps.skillVault.previewSystemPromptSection() === transientSystemPrompt &&
					projected.aliased.legend === legend
				);
			},
			commit: () => {
				const committed = projectCommit(true);
				if (!isDeepStrictEqual(committed.enforcement.messages, previewEnforcement.messages)) {
					throw new Error("Committed provider request context diverged from its accepted plan");
				}
				this.deps.correlatePromptPolicyWithContextGc(committed.gc.report);
				this.deps.enqueueRelevanceCuration(committed.providerMessages, shadowReport);
				this.deps.maybeDrainBrainCuration();
				if (committed.aliased.legend !== legend) {
					throw new Error("Committed path alias legend diverged from its accepted plan");
				}
				if (this.deps.skillVault.commitSystemPromptSection() !== transientSystemPrompt) {
					throw new Error("Committed active skill context diverged from its accepted plan");
				}
				reflectionCuePlan?.commit();
			},
		};
	}
}
