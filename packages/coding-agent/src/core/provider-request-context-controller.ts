import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createCustomMessage } from "@caupulican/pi-agent-core/messages";
import type { AgentContextPlan, AgentMessage } from "@caupulican/pi-agent-core/types";
import type { ContextAuditReport } from "./context/context-audit.ts";
import type { PromptEnforcementReport } from "./context/context-prompt-enforcement.ts";
import type { PromptPolicyShadowReport } from "./context/context-prompt-policy.ts";
import type { MemoryRetrievalReport } from "./context/memory-retrieval.ts";
import { PATH_ALIAS_LEGEND_CUSTOM_TYPE } from "./context/path-alias-table.ts";
import { frozenPrefixLength } from "./context/prefix-stability.ts";
import type { ContextGcReport, ContextGcResult } from "./context-gc.ts";
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
		/** Already-sent boundary packing must not rewrite below (see `frozenPrefixLength`). */
		frozenBelow: number,
	): ContextGcResult;
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
	applyPathAliases(messages: AgentMessage[]): {
		messages: AgentMessage[];
		legend?: string;
		legendIds?: readonly string[];
	};
	/** An accepted plan committed the legend delta it carried; later requests send only newer lines. */
	commitPathAliasLegend?(ids: readonly string[]): void;
}

export { PATH_ALIAS_LEGEND_CUSTOM_TYPE };

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
/**
 * Deterministic stand-in for a build timestamp: this message is rebuilt from scratch on every
 * provider request (see {@link appendPathAliasLegend}'s doc comment), and its content is stable
 * whenever the alias table hasn't grown. A `Date.now()` read there made an otherwise
 * byte-identical message differ on every single request, defeating the provider's prefix cache for
 * the whole conversation behind it. The legend is a transient (see `provider-request-planner.ts`'s
 * `transientMessages` handling) that never enters durable history, so this value carries no
 * scheduling meaning of its own — it only has to be a valid, content-derived instant so identical
 * content always serializes to identical bytes.
 */
function deterministicTransientTimestamp(content: string): string {
	const digest = createHash("sha256").update(content).digest();
	return new Date(digest.readUIntBE(0, 6)).toISOString();
}

/** Durable record kind carrying the active skill context; one record per change, never the system prompt. */
export const ACTIVE_SKILL_CONTEXT_CUSTOM_TYPE = "active_skill_context";
const ACTIVE_SKILL_CONTEXT_CLEARED_TEXT =
	"ACTIVE SKILL CONTEXT: none. Every skill record above is no longer active; load a skill again before relying on it.";

/**
 * Active skills used to ride the system prompt. Every load, unload and idle expiry then rewrote the
 * first bytes of the request, which invalidated the provider's cached prefix for the whole
 * conversation and disengaged the websocket delta path (measured live: the request after a
 * `skill load` re-prefilled all 10.5k tokens with cacheRead 0; an idle expiry ten minutes into a
 * long session would have done the same to a far larger prefix). The context now rides a durable
 * host record like memory evidence and goal context: appended once per change by
 * `reconcileTransientRecords`, superseded records packed by context GC. When the last skill leaves,
 * one cleared record says so, so the model never trusts a stale skill record as current.
 */
function appendActiveSkillContext(transientMessages: AgentMessage[], context: string | undefined): AgentMessage[] {
	if (context === undefined) return transientMessages;
	return [
		...transientMessages,
		createCustomMessage(
			ACTIVE_SKILL_CONTEXT_CUSTOM_TYPE,
			context,
			false,
			undefined,
			deterministicTransientTimestamp(context),
		),
	];
}

function appendPathAliasLegend(transientMessages: AgentMessage[], legend: string | undefined): AgentMessage[] {
	if (!legend) return transientMessages;
	return [
		...transientMessages,
		createCustomMessage(
			PATH_ALIAS_LEGEND_CUSTOM_TYPE,
			legend,
			false,
			// A legend record is a cumulative delta: every earlier record of the kind stays current,
			// so the planner must not stamp it as superseding and the GC must not pack the earlier ones.
			{ cumulative: true },
			deterministicTransientTimestamp(legend),
		),
	];
}

/** Coordinates replay-safe request context planning and accepted-plan lifecycle commit. */
export class ProviderRequestContextController {
	private readonly deps: ProviderRequestContextControllerDeps;

	constructor(deps: ProviderRequestContextControllerDeps) {
		this.deps = deps;
	}

	async plan(messages: AgentMessage[], sentPrefixCount: number, signal?: AbortSignal): Promise<AgentContextPlan> {
		const transformed = this.deps.transformBase ? await this.deps.transformBase(messages, signal) : messages;
		const extensionPlan = await this.deps.transformExtensions(transformed);
		const goalContextProjection = captureGoalContextProjection(extensionPlan.messages);
		const reflectionCuePlan = this.deps.previewReflectionCue?.();
		const providerTransients = [
			...extensionPlan.transientMessages,
			...(reflectionCuePlan ? [reflectionCuePlan.message] : []),
		];
		const durableMessages = injectCompactGoalContext(extensionPlan.messages, undefined);
		// `sentPrefixCount` indexes `messages` as received above; `durableMessages` is the same
		// conversation after transformBase/extension hooks/goal-context stripping may have reshaped
		// it. Re-anchor the mark by reference so packing only ever freezes what is PROVABLY still the
		// same already-sent content, computed once and reused for both the preview and commit GC
		// passes below so they can never disagree about what is frozen.
		const frozenBelow = frozenPrefixLength(messages, sentPrefixCount, durableMessages);
		const extensionMessages = [...durableMessages, ...providerTransients];
		const auditReport = this.deps.runContextAudit(extensionMessages);
		const shadowReport = this.deps.runPromptPolicyPlanning(auditReport);
		const memoryReport = await this.deps.runMemoryRetrieval(extensionMessages);
		const previewGc = this.deps.applyContextGc(durableMessages, false, frozenBelow);
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
		if (!sameMessages(beforeSkill.slice(0, compactableMessages.length), compactableMessages)) {
			throw new Error("Provider request transient contributors changed compactable history");
		}
		const legend = pathAliasPlan.legend;
		const skillSection = this.deps.skillVault.previewSystemPromptSection();
		const skillRevision = this.deps.skillVault.getContextRevision();
		// A vault that has projected skills before and holds none now clears the record explicitly.
		const skillContext = skillSection ?? (skillRevision > 0 ? ACTIVE_SKILL_CONTEXT_CLEARED_TEXT : undefined);
		const transientMessages = appendPathAliasLegend(
			appendActiveSkillContext(beforeSkill.slice(compactableMessages.length), skillContext),
			legend,
		);
		const dependenciesCurrent = () =>
			extensionPlan.isCurrent?.() !== false &&
			reflectionCuePlan?.isCurrent() !== false &&
			this.deps.skillVault.getContextRevision() === skillRevision &&
			// The goal snapshot is one shared frozen value per journal position (session-goal-state.ts).
			this.deps.getGoalState() === goalState;
		// One projection serves preview, currency check and commit. The plan is a pure function of the
		// durable messages (same array, same objects), the dependencies `dependenciesCurrent` tracks,
		// and the curator digests the GC pass looked up -- which `previewGc.isCurrent()` re-resolves.
		// Re-projecting the whole request per stage, and deep-comparing every message to prove the
		// re-projection matched, cost three full passes over the history on every request.
		const planCurrent = () =>
			dependenciesCurrent() &&
			previewGc.isCurrent() &&
			this.deps.skillVault.previewSystemPromptSection() === skillSection;

		return {
			messages: compactableMessages,
			transientMessages,
			isCurrent: dependenciesCurrent,
			prepareCommit: () => planCurrent(),
			commit: () => {
				if (!planCurrent()) {
					throw new Error("Committed provider request context diverged from its accepted plan");
				}
				previewGc.commit();
				this.deps.correlatePromptPolicyWithContextGc(previewGc.report);
				this.deps.enqueueRelevanceCuration(previewProviderMessages, shadowReport);
				this.deps.maybeDrainBrainCuration();
				if (this.deps.skillVault.commitSystemPromptSection() !== skillSection) {
					throw new Error("Committed active skill context diverged from its accepted plan");
				}
				reflectionCuePlan?.commit();
				if (pathAliasPlan.legendIds && pathAliasPlan.legendIds.length > 0) {
					this.deps.commitPathAliasLegend?.(pathAliasPlan.legendIds);
				}
			},
		};
	}
}

/**
 * Same messages, cheaply: identity first, structural equality only for the elements that differ.
 * Contributors that leave compactable history alone hand back the very same objects, so this is
 * usually an O(n) reference walk; `isDeepStrictEqual` over the whole history was O(bytes) per
 * request for the same answer.
 */
function sameMessages(left: readonly AgentMessage[], right: readonly AgentMessage[]): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++) {
		if (left[index] !== right[index] && !isDeepStrictEqual(left[index], right[index])) return false;
	}
	return true;
}
