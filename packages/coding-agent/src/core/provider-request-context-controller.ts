import { isDeepStrictEqual } from "node:util";
import type { AgentContextPlan, AgentMessage } from "@caupulican/pi-agent-core/types";
import type { ContextAuditReport } from "./context/context-audit.ts";
import type { PromptEnforcementReport } from "./context/context-prompt-enforcement.ts";
import type { PromptPolicyShadowReport } from "./context/context-prompt-policy.ts";
import type { MemoryRetrievalReport } from "./context/memory-retrieval.ts";
import type { ContextGcReport } from "./context-gc.ts";
import { injectCompactGoalContext } from "./goals/compact-goal-context.ts";
import type { GoalState } from "./goals/goal-state.ts";
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
	getGoalState(): GoalState | undefined;
	skillVault: SkillVaultController;
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
		const durableMessages = injectCompactGoalContext(extensionPlan.messages, undefined);
		const extensionMessages = [...durableMessages, ...extensionPlan.transientMessages];
		const auditReport = this.deps.runContextAudit(extensionMessages);
		const shadowReport = this.deps.runPromptPolicyPlanning(auditReport);
		const memoryReport = await this.deps.runMemoryRetrieval(extensionMessages);
		const previewGc = this.deps.applyContextGc(durableMessages, false);
		const previewProviderMessages = [...previewGc.messages, ...extensionPlan.transientMessages];
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
		const beforeSkill = injectCompactGoalContext(withMemory, goalState);
		const plannedMessages = this.deps.skillVault.previewContext(beforeSkill);
		if (!isDeepStrictEqual(plannedMessages.slice(0, compactableMessages.length), compactableMessages)) {
			throw new Error("Provider request transient contributors changed compactable history");
		}
		const transientMessages = plannedMessages.slice(compactableMessages.length);
		const skillRevision = this.deps.skillVault.getContextRevision();
		const dependenciesCurrent = () =>
			extensionPlan.isCurrent?.() !== false &&
			this.deps.skillVault.getContextRevision() === skillRevision &&
			isDeepStrictEqual(this.deps.getGoalState(), goalState);
		const projectCommit = (writePayloads: boolean) => {
			const gc = this.deps.applyContextGc(durableMessages, writePayloads);
			const providerMessages = [...gc.messages, ...extensionPlan.transientMessages];
			const enforcement = this.deps.runPromptEnforcement(providerMessages, shadowReport);
			return { enforcement, gc, providerMessages };
		};

		return {
			messages: compactableMessages,
			transientMessages,
			isCurrent: dependenciesCurrent,
			prepareCommit: () => {
				if (!dependenciesCurrent()) return false;
				const projected = projectCommit(false);
				return (
					isDeepStrictEqual(projected.enforcement.messages, previewEnforcement.messages) &&
					isDeepStrictEqual(this.deps.skillVault.previewContext(beforeSkill), plannedMessages)
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
				if (!isDeepStrictEqual(this.deps.skillVault.projectContext(beforeSkill), plannedMessages)) {
					throw new Error("Committed active skill context diverged from its accepted plan");
				}
			},
		};
	}
}
