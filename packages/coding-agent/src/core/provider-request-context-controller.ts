import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AgentContextPlan, AgentContextWire } from "../kernel/index.ts";
import { HOST_TRANSIENT_CLEARED_DETAILS, readTransientRecordPayload } from "../kernel/index.ts";
import { createCustomMessage } from "../kernel/messages.ts";
import type { AgentMessage } from "../kernel/types.ts";
import {
	TASK_AUTOMATION_CONTEXT_CLEARED,
	TASK_AUTOMATION_CONTEXT_CUSTOM_TYPE,
	type TaskAutomationContextPlan,
} from "./automation/task-automation-runtime-adapter.ts";
import type { EdgeGrantView } from "./autonomy/edge-policy.ts";
import {
	type AuthorityContextRecord,
	buildAuthorityContextRecord,
	type PathAliasLegendRecord,
	renderAuthorityContext,
	renderPathAliasLegend,
} from "./comms/host-injection-records.ts";
import { SELF_COMPACTION_GUIDANCE_CUSTOM_TYPE } from "./compaction/self-compaction.ts";
import type { ContextAuditReport } from "./context/context-audit.ts";
import type { ContextProjection } from "./context/context-projection.ts";
import type { EnforcePromptPolicyResult } from "./context/context-prompt-enforcement.ts";
import type { PromptPolicyShadowReport } from "./context/context-prompt-policy.ts";
import type { MemoryPromptPlan } from "./context/memory-prompt-plan.ts";
import type { MemoryRetrievalReport } from "./context/memory-retrieval.ts";
import { PATH_ALIAS_LEGEND_CUSTOM_TYPE } from "./context/path-alias-table.ts";
import { frozenPrefixLength } from "./context/prefix-stability.ts";
import type { ContextGcReport, ContextGcResult } from "./context-gc.ts";
import {
	captureGoalContextProjection,
	injectCompactGoalContext,
	type RoutedGoalContext,
} from "./goals/compact-goal-context.ts";
import type { GoalState } from "./goals/goal-state.ts";
import type { CurrentTurnReflectionCuePlan } from "./reflection-controller.ts";
import type { SkillPromptSection, SkillVaultController } from "./skill-vault.ts";
import {
	TASK_DIRECTORY_CONTEXT_CLEARED,
	TASK_DIRECTORY_CONTEXT_CUSTOM_TYPE,
	type TaskDirectoryContextPlan,
} from "./tasks/task-directory-context.ts";

/**
 * The steps one request's context is planned with. The mechanics every conversation needs (context GC,
 * path aliases, the authority context) are required; the steps that belong to the session's head (its
 * extensions, memory recall, observers, curation, goal, skills, reflection and task context) are
 * optional, so a worker conversation plans with the same controller and simply lacks them.
 */
export interface ProviderRequestContextControllerDeps {
	transformBase?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	transformExtensions?(messages: AgentMessage[]): Promise<{
		messages: AgentMessage[];
		transientMessages: AgentMessage[];
		isCurrent?(): boolean;
	}>;
	runContextAudit?(messages: AgentMessage[]): ContextAuditReport;
	runPromptPolicyPlanning?(report: ContextAuditReport): PromptPolicyShadowReport;
	/** Capture the complete final provider-visible request without publishing speculative state. */
	previewContextProjection?(messages: readonly AgentMessage[]): ContextProjection;
	/** Publish a projection only after the surrounding provider plan is accepted. */
	commitContextProjection?(projection: ContextProjection): void;
	runMemoryRetrieval?(messages: AgentMessage[]): Promise<MemoryRetrievalReport>;
	applyContextGc(
		messages: AgentMessage[],
		writePayloads: boolean,
		/** Already-sent boundary packing must not rewrite below (see `frozenPrefixLength`). */
		frozenBelow: number,
	): ContextGcResult;
	correlatePromptPolicyWithContextGc?(report: ContextGcReport): void;
	runPromptEnforcement?(
		messages: AgentMessage[],
		report: PromptPolicyShadowReport,
		sourceMessages: AgentMessage[],
		frozenBelow: number,
		gcReport: ContextGcReport,
	): EnforcePromptPolicyResult;
	enqueueRelevanceCuration?(messages: AgentMessage[], report: PromptPolicyShadowReport): void;
	maybeDrainBrainCuration?(): void;
	/** Add the memory records for this request; the returned plan joins the request plan's currency and commit. */
	appendMemoryEvidence?(
		messages: AgentMessage[],
		report: MemoryRetrievalReport,
		wireMessages: readonly AgentMessage[],
	): MemoryPromptPlan;
	previewReflectionCue?(): CurrentTurnReflectionCuePlan | undefined;
	previewTaskDirectoryContext?(): TaskDirectoryContextPlan;
	previewTaskAutomationContext?(): TaskAutomationContextPlan;
	previewSelfCompactionGuidance?(): { readonly content: string | undefined; readonly cleared: string };
	getGoalState?(): GoalState | undefined;
	getRoutedGoalContext?(): RoutedGoalContext | undefined;
	/** Why automatic continuation is stopped for a lasting reason, in one sentence for the model; undefined while it is not. */
	getGoalAutoContinueNote?(): string | undefined;
	skillVault?: Pick<
		SkillVaultController,
		"previewSkillSections" | "getContextRevision" | "previewExclusionReminder" | "commitSkillSections"
	>;
	/**
	 * Edge authority grants the run in progress may use (`effectiveEdgeGrants`: the session's on the owner's own runs and
	 * outside a run and on a full-authority phone run, fewer on a fenced or guarded phone run); projected after compaction or whenever active.
	 */
	getEdgeGrants?(): readonly EdgeGrantView[];
	applyPathAliases(messages: AgentMessage[]): {
		messages: AgentMessage[];
		/** The legend delta for the aliases visible on this request's wire, given what it carries besides `messages`. */
		legendFor?(
			visibleMessages: readonly AgentMessage[],
			visibleTexts: readonly string[],
		): PathAliasLegendRecord | undefined;
	};
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

/**
 * Durable record kind prefix of one active skill: `active_skill_context:<name>`, one kind per skill name. The name is the
 * skill's identity and its kind never changes for a loaded skill, so a change re-sends only that skill's record.
 */
export const ACTIVE_SKILL_RECORD_KIND_PREFIX = "active_skill_context:";
/** The combined kind the skill context used before it split per skill. Nothing produces it now; a session holding it gets one cleared record. */
export const ACTIVE_SKILL_CONTEXT_CUSTOM_TYPE = "active_skill_context";
/** Kind of the session-wide exclusion reminder, which rides beside the per-skill records. */
export const ACTIVE_SKILL_EXCLUSIONS_CUSTOM_TYPE = "active_skill_exclusions";
/** Typed identity a per-skill record carries in `details.record`: the record kind and the skill name. */
const ACTIVE_SKILL_RECORD_KIND = "active_skill";
const ACTIVE_SKILL_RECORD_VERSION = 1;

function activeSkillRecordKind(name: string): string {
	return `${ACTIVE_SKILL_RECORD_KIND_PREFIX}${name}`;
}

function activeSkillClearedText(name: string): string {
	return `ACTIVE SKILL "${name}": no longer active. Every record of this skill above is stale; load the skill again before relying on it.`;
}

const ACTIVE_SKILL_LEGACY_CLEARED_TEXT =
	"ACTIVE SKILL CONTEXT: superseded by one record per active skill; the skill records above are the current ones.";
const ACTIVE_SKILL_EXCLUSIONS_CLEARED_TEXT = "EXCLUDED SKILLS: none. The exclusion record above is no longer current.";

/** What a session's history says about the skill records it already holds. */
interface SkillHistoryState {
	/** Names of the skills with a per-skill record on record (typed by `details.record`), loaded now or not. */
	readonly skillNames: ReadonlySet<string>;
	/** The combined kind is on record. */
	readonly legacyRecord: boolean;
	/** The exclusion reminder kind is on record. */
	readonly exclusionRecord: boolean;
}

function skillHistoryState(...histories: readonly (readonly AgentMessage[])[]): SkillHistoryState {
	const skillNames = new Set<string>();
	let legacyRecord = false;
	let exclusionRecord = false;
	for (const history of histories) {
		for (const message of history) {
			if (message.role !== "custom") continue;
			if (message.customType === ACTIVE_SKILL_CONTEXT_CUSTOM_TYPE) legacyRecord = true;
			else if (message.customType === ACTIVE_SKILL_EXCLUSIONS_CUSTOM_TYPE) exclusionRecord = true;
			const payload = readTransientRecordPayload(message.details);
			if (payload?.k !== ACTIVE_SKILL_RECORD_KIND) continue;
			const name = (payload as { name?: unknown }).name;
			if (typeof name === "string") skillNames.add(name);
		}
	}
	return { skillNames, legacyRecord, exclusionRecord };
}

/**
 * The skill records a request offers, appended once per change by `reconcileTransientRecords`: one record per active skill (its
 * section), a cleared record for each skill on record that is no longer active, the exclusion reminder, and one cleared record
 * for the retired combined kind where a session holds it. An unchanged skill offers the same content, so it is not re-sent.
 */
function skillTransientMessages(
	sections: readonly SkillPromptSection[],
	history: SkillHistoryState,
	exclusionReminder: string | undefined,
): AgentMessage[] {
	const active = new Set(sections.map((entry) => entry.name));
	const messages: AgentMessage[] = sections.map((entry) =>
		createCustomMessage(
			activeSkillRecordKind(entry.name),
			entry.section,
			false,
			{ record: { v: ACTIVE_SKILL_RECORD_VERSION, k: ACTIVE_SKILL_RECORD_KIND, name: entry.name } },
			deterministicTransientTimestamp(entry.section),
		),
	);
	for (const name of history.skillNames) {
		if (active.has(name)) continue;
		const cleared = activeSkillClearedText(name);
		messages.push(
			createCustomMessage(
				activeSkillRecordKind(name),
				cleared,
				false,
				HOST_TRANSIENT_CLEARED_DETAILS,
				deterministicTransientTimestamp(cleared),
			),
		);
	}
	if (history.legacyRecord) {
		messages.push(
			createCustomMessage(
				ACTIVE_SKILL_CONTEXT_CUSTOM_TYPE,
				ACTIVE_SKILL_LEGACY_CLEARED_TEXT,
				false,
				HOST_TRANSIENT_CLEARED_DETAILS,
				deterministicTransientTimestamp(ACTIVE_SKILL_LEGACY_CLEARED_TEXT),
			),
		);
	}
	if (exclusionReminder !== undefined) {
		messages.push(
			createCustomMessage(
				ACTIVE_SKILL_EXCLUSIONS_CUSTOM_TYPE,
				exclusionReminder,
				false,
				undefined,
				deterministicTransientTimestamp(exclusionReminder),
			),
		);
	} else if (history.exclusionRecord) {
		messages.push(
			createCustomMessage(
				ACTIVE_SKILL_EXCLUSIONS_CUSTOM_TYPE,
				ACTIVE_SKILL_EXCLUSIONS_CLEARED_TEXT,
				false,
				HOST_TRANSIENT_CLEARED_DETAILS,
				deterministicTransientTimestamp(ACTIVE_SKILL_EXCLUSIONS_CLEARED_TEXT),
			),
		);
	}
	return messages;
}

/** Whether two skill section lists are the same skills with the same sections, in the same order. */
function sameSkillSections(left: readonly SkillPromptSection[], right: readonly SkillPromptSection[]): boolean {
	return (
		left.length === right.length &&
		left.every((entry, index) => entry.name === right[index]?.name && entry.section === right[index]?.section)
	);
}

/** Durable record kind carrying the session authority and active edge grants projection. */
export const AUTHORITY_CONTEXT_CUSTOM_TYPE = "authority_context";

function appendAuthorityContext(
	transientMessages: AgentMessage[],
	record: AuthorityContextRecord | undefined,
): AgentMessage[] {
	if (record === undefined) return transientMessages;
	const context = renderAuthorityContext(record);
	return [
		...transientMessages,
		createCustomMessage(
			AUTHORITY_CONTEXT_CUSTOM_TYPE,
			context,
			false,
			{ record },
			deterministicTransientTimestamp(context),
		),
	];
}

function appendPathAliasLegend(
	transientMessages: AgentMessage[],
	record: PathAliasLegendRecord | undefined,
): AgentMessage[] {
	if (!record) return transientMessages;
	const legend = renderPathAliasLegend(record);
	return [
		...transientMessages,
		createCustomMessage(
			PATH_ALIAS_LEGEND_CUSTOM_TYPE,
			legend,
			false,
			// A legend record is a cumulative delta: every earlier record of the kind stays current,
			// so the planner must not stamp it as superseding and the GC must not pack the earlier ones.
			{ cumulative: true, record },
			deterministicTransientTimestamp(legend),
		),
	];
}

export function hasConversationSummaryMarker(
	messages: readonly AgentMessage[],
	extensionMessages?: readonly AgentMessage[],
): boolean {
	const isSummary = (message: AgentMessage) =>
		message.role === "compactionSummary" || message.role === "branchSummary";
	return messages.some(isSummary) || (extensionMessages?.some(isSummary) ?? false);
}

/** The authority record this request carries: the active grants, the cleared record (no grant), or none. */
function resolveAuthorityContext(
	getEdgeGrants: (() => readonly EdgeGrantView[]) | undefined,
	messages: readonly AgentMessage[],
	extensionMessages: readonly AgentMessage[],
): AuthorityContextRecord | undefined {
	const grants = getEdgeGrants?.();
	if (grants && grants.length > 0) {
		return buildAuthorityContextRecord(grants);
	}
	const hasAuthorityRecordInHistory =
		messages.some((message) => message.role === "custom" && message.customType === AUTHORITY_CONTEXT_CUSTOM_TYPE) ||
		extensionMessages.some(
			(message) => message.role === "custom" && message.customType === AUTHORITY_CONTEXT_CUSTOM_TYPE,
		);
	if (hasAuthorityRecordInHistory || hasConversationSummaryMarker(messages, extensionMessages)) {
		return buildAuthorityContextRecord([]);
	}
	return undefined;
}

/** Coordinates replay-safe request context planning and accepted-plan lifecycle commit. */
export class ProviderRequestContextController {
	private readonly deps: ProviderRequestContextControllerDeps;

	constructor(deps: ProviderRequestContextControllerDeps) {
		this.deps = deps;
	}

	/**
	 * `wire` is what the request carries to the model outside these messages and this plan's transients (see
	 * `AgentContextWire`); it is read only to name every alias the model can see.
	 */
	async plan(
		messages: AgentMessage[],
		sentPrefixCount: number,
		signal?: AbortSignal,
		wire: AgentContextWire = {},
	): Promise<AgentContextPlan> {
		const transformed = this.deps.transformBase ? await this.deps.transformBase(messages, signal) : messages;
		const extensionPlan = this.deps.transformExtensions
			? await this.deps.transformExtensions(transformed)
			: { messages: transformed, transientMessages: [] as AgentMessage[] };
		const routedGoalContext = this.deps.getRoutedGoalContext?.();
		const goalAutoContinueNote = this.deps.getGoalAutoContinueNote?.();
		const goalContextProjection = captureGoalContextProjection(
			extensionPlan.messages,
			routedGoalContext,
			goalAutoContinueNote,
		);
		const reflectionCuePlan = this.deps.previewReflectionCue?.();
		const directoryPlan = this.deps.previewTaskDirectoryContext?.();
		const directoryContent =
			directoryPlan?.content ??
			(directoryPlan &&
			extensionPlan.messages.some(
				(message) => message.role === "custom" && message.customType === TASK_DIRECTORY_CONTEXT_CUSTOM_TYPE,
			)
				? TASK_DIRECTORY_CONTEXT_CLEARED
				: undefined);
		const automationPlan = this.deps.previewTaskAutomationContext?.();
		const rawAutomationContent = automationPlan?.isCurrent() ? automationPlan.content : undefined;
		const hasPriorAutomationContext =
			messages.some(
				(message) => message.role === "custom" && message.customType === TASK_AUTOMATION_CONTEXT_CUSTOM_TYPE,
			) ||
			extensionPlan.messages.some(
				(message) => message.role === "custom" && message.customType === TASK_AUTOMATION_CONTEXT_CUSTOM_TYPE,
			);
		const automationContent =
			rawAutomationContent ??
			(hasPriorAutomationContext && automationPlan?.isCurrent() ? TASK_AUTOMATION_CONTEXT_CLEARED : undefined);
		const selfCompaction = this.deps.previewSelfCompactionGuidance?.();
		const isGuidanceRecord = (message: AgentMessage) =>
			message.role === "custom" && message.customType === SELF_COMPACTION_GUIDANCE_CUSTOM_TYPE;
		const selfCompactionText =
			selfCompaction?.content ??
			(selfCompaction && (messages.some(isGuidanceRecord) || extensionPlan.messages.some(isGuidanceRecord))
				? selfCompaction.cleared
				: undefined);
		const providerTransients = [
			...extensionPlan.transientMessages,
			...(reflectionCuePlan ? [reflectionCuePlan.message] : []),
			...(selfCompaction && selfCompactionText
				? [
						createCustomMessage(
							SELF_COMPACTION_GUIDANCE_CUSTOM_TYPE,
							selfCompactionText,
							false,
							selfCompaction.content === undefined ? HOST_TRANSIENT_CLEARED_DETAILS : undefined,
							deterministicTransientTimestamp(selfCompactionText),
						),
					]
				: []),
			...(directoryContent
				? [
						createCustomMessage(
							TASK_DIRECTORY_CONTEXT_CUSTOM_TYPE,
							directoryContent,
							false,
							directoryPlan?.content !== undefined && directoryPlan.record
								? { record: directoryPlan.record }
								: undefined,
							deterministicTransientTimestamp(directoryContent),
						),
					]
				: []),
			...(automationContent
				? [
						createCustomMessage(
							TASK_AUTOMATION_CONTEXT_CUSTOM_TYPE,
							automationContent,
							false,
							undefined,
							deterministicTransientTimestamp(automationContent),
						),
					]
				: []),
		];
		const durableMessages = injectCompactGoalContext(extensionPlan.messages, undefined);
		// `sentPrefixCount` indexes `messages` as received above; `durableMessages` is the same
		// conversation after transformBase/extension hooks/goal-context stripping may have reshaped
		// it. Re-anchor the mark by reference so packing only ever freezes what is PROVABLY still the
		// same already-sent content, computed once and reused for both the preview and commit GC
		// passes below so they can never disagree about what is frozen.
		const frozenBelow = frozenPrefixLength(messages, sentPrefixCount, durableMessages);
		const extensionMessages = [...durableMessages, ...providerTransients];
		const auditReport = this.deps.runContextAudit?.(extensionMessages);
		const shadowReport = auditReport ? this.deps.runPromptPolicyPlanning?.(auditReport) : undefined;
		const memoryReport = this.deps.runMemoryRetrieval
			? await this.deps.runMemoryRetrieval(extensionMessages)
			: undefined;
		const previewGc = this.deps.applyContextGc(durableMessages, false, frozenBelow);
		const pathAliasPlan = this.deps.applyPathAliases(previewGc.messages);
		const previewProviderMessages = [...pathAliasPlan.messages, ...providerTransients];
		const previewEnforcement =
			shadowReport && this.deps.runPromptEnforcement
				? this.deps.runPromptEnforcement(
						previewProviderMessages,
						shadowReport,
						extensionMessages,
						frozenBelow,
						previewGc.report,
					)
				: { messages: previewProviderMessages, transientMessages: [], isCurrent: () => true };
		if (previewEnforcement.messages.length !== previewProviderMessages.length) {
			throw new Error("Provider request enforcement changed message cardinality");
		}
		const compactableMessages = previewEnforcement.messages.slice(0, previewGc.messages.length);
		const goalState = this.deps.getGoalState?.();
		const withExtensionTransients = [
			...previewEnforcement.messages.slice(previewGc.messages.length),
			...previewEnforcement.transientMessages,
		];
		const memoryPlan =
			memoryReport && this.deps.appendMemoryEvidence
				? this.deps.appendMemoryEvidence(
						[...compactableMessages, ...withExtensionTransients],
						memoryReport,
						wire.messages ?? [],
					)
				: undefined;
		const withMemory = memoryPlan?.messages ?? [...compactableMessages, ...withExtensionTransients];
		const beforeSkill = injectCompactGoalContext(withMemory, goalState, goalContextProjection);
		if (!sameMessages(beforeSkill.slice(0, compactableMessages.length), compactableMessages)) {
			throw new Error("Provider request transient contributors changed compactable history");
		}
		const skillVault = this.deps.skillVault;
		const skillSections = skillVault?.previewSkillSections() ?? [];
		const skillRevision = skillVault?.getContextRevision() ?? 0;
		const exclusionReminder = skillVault?.previewExclusionReminder?.();
		const skillRecords = skillVault
			? skillTransientMessages(skillSections, skillHistoryState(messages, extensionPlan.messages), exclusionReminder)
			: [];

		const authorityContext = resolveAuthorityContext(this.deps.getEdgeGrants, messages, extensionPlan.messages);

		const withAuthority = appendAuthorityContext(beforeSkill.slice(compactableMessages.length), authorityContext);
		const beforeLegend = [...withAuthority, ...skillRecords];
		// The legend names every alias the model can see on this request's wire: the planned messages, the transients
		// before it, and what the kernel and a host projection carry around them. Committed lines are never retracted.
		const legend = pathAliasPlan.legendFor?.([...(wire.messages ?? []), ...beforeLegend], wire.texts ?? []);
		const transientMessages = appendPathAliasLegend(beforeLegend, legend);
		const contextProjection = this.deps.previewContextProjection?.([...compactableMessages, ...transientMessages]);

		const dependenciesCurrent = () =>
			extensionPlan.isCurrent?.() !== false &&
			// The memory records were composed against one memory generation, content revision and
			// headroom; a request planned against a different memory state is planned again.
			memoryPlan?.isCurrent() !== false &&
			reflectionCuePlan?.isCurrent() !== false &&
			directoryPlan?.isCurrent() !== false &&
			automationPlan?.isCurrent() !== false &&
			(skillVault?.getContextRevision() ?? 0) === skillRevision &&
			// The goal snapshot is one shared frozen value per journal position (session-goal-state.ts).
			this.deps.getGoalState?.() === goalState &&
			this.deps.getRoutedGoalContext?.() === routedGoalContext &&
			this.deps.getGoalAutoContinueNote?.() === goalAutoContinueNote &&
			isDeepStrictEqual(
				resolveAuthorityContext(this.deps.getEdgeGrants, messages, extensionPlan.messages),
				authorityContext,
			);
		// One projection serves preview, currency check and commit. The plan is a pure function of the
		// durable messages (same array, same objects), the dependencies `dependenciesCurrent` tracks,
		// and the curator digests the GC pass looked up -- which `previewGc.isCurrent()` re-resolves.
		// Re-projecting the whole request per stage, and deep-comparing every message to prove the
		// re-projection matched, cost three full passes over the history on every request.
		const planCurrent = () =>
			dependenciesCurrent() &&
			previewGc.isCurrent() &&
			previewEnforcement.isCurrent() &&
			(skillVault === undefined || sameSkillSections(skillVault.previewSkillSections(), skillSections)) &&
			skillVault?.previewExclusionReminder?.() === exclusionReminder;

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
				this.deps.correlatePromptPolicyWithContextGc?.(previewGc.report);
				if (shadowReport) this.deps.enqueueRelevanceCuration?.(extensionMessages, shadowReport);
				this.deps.maybeDrainBrainCuration?.();
				if (skillVault && !sameSkillSections(skillVault.commitSkillSections(), skillSections)) {
					throw new Error("Committed active skill context diverged from its accepted plan");
				}
				reflectionCuePlan?.commit();
				// Published only now: a discarded plan leaves memory diagnostics and recall accounting untouched.
				memoryPlan?.commit();
				if (contextProjection) this.deps.commitContextProjection?.(contextProjection);
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
