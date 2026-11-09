import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AgentContextPlan, AgentContextWire } from "../kernel/index.ts";
import { HOST_TRANSIENT_CLEARED_DETAILS } from "../kernel/index.ts";
import { createCustomMessage } from "../kernel/messages.ts";
import { PrefixFirstMatchByFirstItem } from "../kernel/prefix-fold.ts";
import { recordedTransientKinds, transientRecordMessageOf } from "../kernel/transient-records.ts";
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
import type { PathAliasSyncResult } from "./context/path-alias-session.ts";
import { collectWireTexts, PATH_ALIAS_LEGEND_CUSTOM_TYPE } from "./context/path-alias-table.ts";
import { frozenPrefixLength } from "./context/prefix-stability.ts";
import type { ContextGcReport, ContextGcResult } from "./context-gc.ts";
import {
	captureGoalContextProjection,
	injectCompactGoalContext,
	type RoutedGoalContext,
} from "./goals/compact-goal-context.ts";
import type { GoalState } from "./goals/goal-state.ts";
import {
	OWNER_RETURN_BRIEF_CUSTOM_TYPE,
	RETURN_BRIEF_CLEARED_TEXT,
	type ReturnBriefPlan,
} from "./owner-decisions/return-brief.ts";
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
	/** The return brief of the owner turn in progress, when the owner came back after an idle gap (see the controller). */
	previewReturnBrief?(): Promise<ReturnBriefPlan>;
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
	/** The request's aliased messages, with the legend the request's wire needs (see {@link PathAliasSyncResult}). */
	applyPathAliases(messages: AgentMessage[]): PathAliasSyncResult;
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

/**
 * Whether a kind on record still needs its cleared record: the kind is on record and its last record is not the cleared text
 * already. A kind never recorded has nothing to clear; a kind already cleared has nothing to append.
 */
function clearedRecordNeeded(
	recorded: ReturnType<typeof recordedTransientKinds>,
	kind: string,
	clearedText: string,
): boolean {
	const last = recorded.get(kind);
	return last !== undefined && last.content !== clearedText;
}

/**
 * The skill records a request offers, appended once per change by `reconcileTransientRecords`: one record per active skill (its
 * section), a cleared record for each skill on record that is no longer active, the exclusion reminder, and one cleared record
 * for the retired combined kind where a session holds it. An unchanged skill offers the same content, so it is not re-sent.
 * `recorded` is the last record of each kind on the request's records (its history and carried head), so a request reads the
 * skill records it needs in place of rescanning the history and re-deciding every skill ever loaded.
 */
function skillTransientMessages(
	sections: readonly SkillPromptSection[],
	recorded: ReturnType<typeof recordedTransientKinds>,
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
	for (const kind of recorded.keys()) {
		if (!kind.startsWith(ACTIVE_SKILL_RECORD_KIND_PREFIX)) continue;
		const name = kind.slice(ACTIVE_SKILL_RECORD_KIND_PREFIX.length);
		const cleared = activeSkillClearedText(name);
		if (active.has(name) || !clearedRecordNeeded(recorded, kind, cleared)) continue;
		messages.push(
			createCustomMessage(
				kind,
				cleared,
				false,
				HOST_TRANSIENT_CLEARED_DETAILS,
				deterministicTransientTimestamp(cleared),
			),
		);
	}
	if (clearedRecordNeeded(recorded, ACTIVE_SKILL_CONTEXT_CUSTOM_TYPE, ACTIVE_SKILL_LEGACY_CLEARED_TEXT)) {
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
	} else if (
		clearedRecordNeeded(recorded, ACTIVE_SKILL_EXCLUSIONS_CUSTOM_TYPE, ACTIVE_SKILL_EXCLUSIONS_CLEARED_TEXT)
	) {
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

/**
 * A conversation summary, by role. This is the one fact the authority decision reads that is not a record kind, so the record
 * index does not answer it.
 */
function isConversationSummaryMessage(message: AgentMessage): boolean {
	return message.role === "compactionSummary" || message.role === "branchSummary";
}

/**
 * The summary scans of the history and of the extension view, one per array lineage: the two can share a first message while
 * differing after it, so they never reset each other.
 */
const historySummaryScans = new PrefixFirstMatchByFirstItem<AgentMessage>(isConversationSummaryMessage);
const viewSummaryScans = new PrefixFirstMatchByFirstItem<AgentMessage>(isConversationSummaryMessage);

/**
 * Whether the history or the extension view holds a conversation summary. Read on every call: each scan validates the array
 * it resumes from by identity and content epoch, so an entry that appeared in place still flips the answer.
 */
export function hasConversationSummaryMarker(
	messages: readonly AgentMessage[],
	extensionMessages?: readonly AgentMessage[],
): boolean {
	return (
		historySummaryScans.find(messages) >= 0 ||
		(extensionMessages !== undefined && viewSummaryScans.find(extensionMessages) >= 0)
	);
}

/** What one pass over a request's extension view establishes (see {@link scanRequestView}). */
interface RequestViewScan {
	/** The view holds a conversation summary. */
	readonly summaryMarker: boolean;
	/** The view holds a task directory record (any record of the kind, as `holdsRecordOfKind` reads it). */
	readonly directoryRecorded: boolean;
}

/**
 * One pass over a request's extension view, answering both view questions the planner asks: its summary marker and its
 * directory record. `plan` runs it at most once per plan, on the first question that reaches the view, and reuses the result.
 * The history is not part of this pass; a history that is a different array from the view is read for its summary marker
 * separately, and only when that question needs it.
 */
function scanRequestView(view: readonly AgentMessage[]): RequestViewScan {
	let summaryMarker = false;
	let directoryRecorded = false;
	for (const message of view) {
		if (isConversationSummaryMessage(message)) {
			summaryMarker = true;
		} else if (message.role === "custom" && message.customType === TASK_DIRECTORY_CONTEXT_CUSTOM_TYPE) {
			directoryRecorded = true;
		}
	}
	return { summaryMarker, directoryRecorded };
}

/**
 * The authority record this request carries: the active grants, the cleared record (no grant), or none. `authorityRecorded` says
 * whether the request's records (the history and its carried head) ever carried an authority record: such a record is current until
 * it is cleared. Both history facts are read only when the grants leave the answer open, so a granted request reads neither.
 * The extension view is not consulted for the authority record: a view is the history minus what a projection drops, and no
 * extension may write this host-reserved kind, so the view holds no authority record the history lacks.
 */
function resolveAuthorityContext(
	getEdgeGrants: (() => readonly EdgeGrantView[]) | undefined,
	authorityRecorded: () => boolean,
	conversationSummarized: () => boolean,
): AuthorityContextRecord | undefined {
	const grants = getEdgeGrants?.();
	if (grants && grants.length > 0) {
		return buildAuthorityContextRecord(grants);
	}
	if (authorityRecorded() || conversationSummarized()) {
		return buildAuthorityContextRecord([]);
	}
	return undefined;
}

/**
 * The record kinds a carried head holds for the whole turn: each loaded skill's record, the authority context and the task
 * directory. Every other record stays turn-scoped, since its content changes without an owner or agent action.
 */
export function isCarriedRecordKind(kind: string): boolean {
	return (
		kind.startsWith(ACTIVE_SKILL_RECORD_KIND_PREFIX) ||
		kind === AUTHORITY_CONTEXT_CUSTOM_TYPE ||
		kind === TASK_DIRECTORY_CONTEXT_CUSTOM_TYPE
	);
}

function isCarriedRecordMessage(message: AgentMessage): message is Extract<AgentMessage, { role: "custom" }> {
	return message.role === "custom" && isCarriedRecordKind(message.customType);
}

/** Whether a history holds a custom record of one kind. A scan: `recordedTransientKinds` answers the same question from its index. */
function holdsRecordOfKind(messages: readonly AgentMessage[], kind: string): boolean {
	return messages.some((message) => message.role === "custom" && message.customType === kind);
}

/** The texts a frame's messages carry, for the frame legend to name: every frame message except the carried records. */
function frameTextsOf(frame: readonly AgentMessage[]): string[] {
	return frame.filter((message) => !isCarriedRecordMessage(message)).flatMap(collectWireTexts);
}

/** Coordinates replay-safe request context planning and accepted-plan lifecycle commit. */
export class ProviderRequestContextController {
	private readonly deps: ProviderRequestContextControllerDeps;
	/**
	 * The carried kinds in the order each was first carried, append-only for the session: a head lists its records in this order,
	 * so a kind that leaves the head does not move the others, and a kind that joins it lands after those already carried.
	 */
	private readonly carryOrder: string[] = [];

	constructor(deps: ProviderRequestContextControllerDeps) {
		this.deps = deps;
	}

	/**
	 * The records a carried head holds, as reconciliation would append each: the active carried-kind records of this request in
	 * carry order, then the frame legend when one was made.
	 */
	private carriedHeadRecords(
		transientMessages: readonly AgentMessage[],
		frameLegend: AgentMessage | undefined,
	): AgentMessage[] {
		const active = transientMessages.filter(isCarriedRecordMessage);
		for (const message of active) {
			if (!this.carryOrder.includes(message.customType)) this.carryOrder.push(message.customType);
		}
		const rank = (kind: string): number => this.carryOrder.indexOf(kind);
		const heads = [...active].sort((left, right) => rank(left.customType) - rank(right.customType));
		const records: AgentMessage[] = [];
		for (const message of heads) {
			const record = transientRecordMessageOf(message);
			if (record !== undefined) records.push(record);
		}
		return frameLegend === undefined ? records : [...records, frameLegend];
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
		// The request's records by kind: the history, with the carried head ahead of it when a frame carries one. Each kind's
		// last record answers the presence checks below. The extension view is not scanned for these kinds: they are host-reserved
		// (no extension can write one), and the side-trip brief is a suffix of the history, so the view holds none the history lacks.
		const carriedSubset = (wire.messages ?? []).filter(isCarriedRecordMessage);
		const requestRecords: readonly AgentMessage[] =
			carriedSubset.length === 0 ? messages : [...carriedSubset, ...messages];
		const recorded = recordedTransientKinds(requestRecords);
		// The view's facts come from one pass over the view, run by the first question that reaches the view and reused for the
		// rest of this plan. A plan that asks neither question (a granted authority, no directory to judge) runs no pass.
		let viewScan: RequestViewScan | undefined;
		const scanView = (): RequestViewScan => (viewScan ??= scanRequestView(extensionPlan.messages));
		const directoryPlan = this.deps.previewTaskDirectoryContext?.();
		// The directory is judged on the request's view and on its carried head: a view a side trip narrows still reads its own.
		const directoryRecorded = () =>
			scanView().directoryRecorded || holdsRecordOfKind(carriedSubset, TASK_DIRECTORY_CONTEXT_CUSTOM_TYPE);
		const directoryContent =
			directoryPlan?.content ?? (directoryPlan && directoryRecorded() ? TASK_DIRECTORY_CONTEXT_CLEARED : undefined);
		const automationPlan = this.deps.previewTaskAutomationContext?.();
		const rawAutomationContent = automationPlan?.isCurrent() ? automationPlan.content : undefined;
		const hasPriorAutomationContext = recorded.has(TASK_AUTOMATION_CONTEXT_CUSTOM_TYPE);
		const automationContent =
			rawAutomationContent ??
			(hasPriorAutomationContext && automationPlan?.isCurrent() ? TASK_AUTOMATION_CONTEXT_CLEARED : undefined);
		// A brief is current for its one owner turn. Once that turn is past, the last record of its kind clears it, once:
		// a cleared record reads back as the cleared text, so a later request does not repeat it.
		const returnBriefPlan = await this.deps.previewReturnBrief?.();
		const rawReturnBrief = returnBriefPlan?.content;
		const priorReturnBrief = recorded.get(OWNER_RETURN_BRIEF_CUSTOM_TYPE)?.content;
		const returnBriefContent =
			rawReturnBrief ??
			(priorReturnBrief !== undefined && priorReturnBrief !== RETURN_BRIEF_CLEARED_TEXT
				? RETURN_BRIEF_CLEARED_TEXT
				: undefined);
		const selfCompaction = this.deps.previewSelfCompactionGuidance?.();
		const selfCompactionText =
			selfCompaction?.content ??
			(selfCompaction && recorded.has(SELF_COMPACTION_GUIDANCE_CUSTOM_TYPE) ? selfCompaction.cleared : undefined);
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
			...(returnBriefContent
				? [
						createCustomMessage(
							OWNER_RETURN_BRIEF_CUSTOM_TYPE,
							returnBriefContent,
							false,
							rawReturnBrief === undefined ? HOST_TRANSIENT_CLEARED_DETAILS : undefined,
							deterministicTransientTimestamp(returnBriefContent),
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
		const skillRecords = skillVault ? skillTransientMessages(skillSections, recorded, exclusionReminder) : [];

		// The history is a separate array from the view only when it is not the view itself; a view that is the history was scanned above.
		const authorityContext = resolveAuthorityContext(
			this.deps.getEdgeGrants,
			() => recorded.has(AUTHORITY_CONTEXT_CUSTOM_TYPE),
			() =>
				scanView().summaryMarker ||
				(messages !== extensionPlan.messages && historySummaryScans.find(messages) >= 0),
		);

		const withAuthority = appendAuthorityContext(beforeSkill.slice(compactableMessages.length), authorityContext);
		const beforeLegend = [...withAuthority, ...skillRecords];
		// A carried frame's legend is made on the turn's first request, while its wire carries none yet; later requests read the
		// one the head carries. `carry` marks a projection that places the records of a carried head ahead of its frame.
		const frameLegend =
			wire.carry === true && !holdsRecordOfKind(wire.messages ?? [], PATH_ALIAS_LEGEND_CUSTOM_TYPE)
				? pathAliasPlan.frameLegend?.(frameTextsOf(wire.messages ?? []))
				: undefined;
		// The legend names every alias the model can see on this request's wire: the planned messages, the transients
		// before it, and what the kernel and a host projection carry around them. Committed lines are never retracted.
		const legend = pathAliasPlan.legendFor?.(
			[...(wire.messages ?? []), ...beforeLegend, ...(frameLegend === undefined ? [] : [frameLegend])],
			wire.texts ?? [],
		);
		const transientMessages = appendPathAliasLegend(beforeLegend, legend);
		const carriedRecords = wire.carry === true ? this.carriedHeadRecords(transientMessages, frameLegend) : undefined;
		const contextProjection = this.deps.previewContextProjection?.([...compactableMessages, ...transientMessages]);

		const dependenciesCurrent = () =>
			extensionPlan.isCurrent?.() !== false &&
			// The memory records were composed against one memory generation, content revision and
			// headroom; a request planned against a different memory state is planned again.
			memoryPlan?.isCurrent() !== false &&
			reflectionCuePlan?.isCurrent() !== false &&
			directoryPlan?.isCurrent() !== false &&
			automationPlan?.isCurrent() !== false &&
			(returnBriefPlan?.content === undefined || returnBriefPlan.isCurrent()) &&
			(skillVault?.getContextRevision() ?? 0) === skillRevision &&
			// The goal snapshot is one shared frozen value per journal position (session-goal-state.ts).
			this.deps.getGoalState?.() === goalState &&
			this.deps.getRoutedGoalContext?.() === routedGoalContext &&
			this.deps.getGoalAutoContinueNote?.() === goalAutoContinueNote &&
			isDeepStrictEqual(
				// Re-read on every currency check, never from the plan's scan: a summary or authority record that appeared in place
				// after planning must still flip the result.
				resolveAuthorityContext(
					this.deps.getEdgeGrants,
					() => recordedTransientKinds(requestRecords).has(AUTHORITY_CONTEXT_CUSTOM_TYPE),
					() => hasConversationSummaryMarker(messages, extensionPlan.messages),
				),
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
			...(carriedRecords === undefined ? {} : { carriedRecords }),
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
				// The owner is shown the brief only by a request that is sent, so its items are marked seen here.
				returnBriefPlan?.commit?.();
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
