/**
 * Query-time enforcement for the context-policy layer (opt-in, default disabled). Unlike
 * context-audit.ts/context-prompt-policy.ts (both strictly observe-only), this module can
 * change provider-visible context. It projects an unsent tool result in place, preserves an
 * already-sent raw prefix, or adds a request-only tail overlay when context GC already packed
 * the evidence. It never touches the transcript, releases/reclaims artifact references, or
 * creates artifacts. Every bounded view points at an existing stable retrieval handle.
 *
 * Eligibility for projection is deliberately conservative (see `enforcePromptPolicy`): the
 * setting must be enabled, the item must be outside the recent-message safety window, not
 * an errored tool result, not already stubbed by this module or already packed by legacy
 * context-gc without a stable retrieval key, must have a resolvable retrieval id, the `artifact_retrieve` tool
 * must actually be active this turn, and must clear `hardConstraints.dropFromPrompt` (see
 * below for why that specific action, not `pack_to_artifact`).
 *
 * Why `dropFromPrompt`, not `packToArtifact`: this operation does not create a new
 * artifact -- it reuses the ref an earlier `pack_to_artifact` capture already produced (see
 * tool-output-artifacts.md's "measure -> digest/preview/artifact -> prompt item" pipeline).
 * `drop_from_prompt` requires an existing retrieval path and is exactly the operation being
 * performed (evicting raw content from the live prompt in favor of that existing path);
 * `pack_to_artifact` is the distinct first-capture operation, which we never invoke here.
 *
 * Why `retrievalToolAvailable` is checked separately from `hasAvailableRetrievalPath`: the
 * latter only proves the artifact still exists in the store; it says nothing about whether
 * the model can currently act on the stub's instruction to call `artifact_retrieve`.
 * `artifact_retrieve` is a companion affordance (auto-activated alongside grep/find, not a
 * default/global tool -- see agent-session.ts's companion-activation enforcement), so active
 * tools can differ turn to turn. Projecting content with an unactionable pointer would be
 * strictly worse than leaving the raw content in place.
 */

import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { ContextGcReport } from "../context-gc.ts";
import {
	type ContextRelevanceScope,
	CURATION_RELEVANCE_CONTENT_MAX_CHARS,
	CURATION_RELEVANCE_QUERY_MAX_CHARS,
	contextRelevanceKey,
} from "./brain-curator.ts";
import type { PromptPolicyShadowReport } from "./context-prompt-policy.ts";
import {
	CONTEXT_VISIBILITY_LONG_CHARS,
	CONTEXT_VISIBILITY_SHORT_CHARS,
	type ContextRelevanceVerdict,
	type ContextVisibility,
	type ContextVisibilityAdvisory,
	type ContextVisibilityReason,
	contextVisibilityExcerpt,
	selectContextVisibility,
} from "./context-query-visibility.ts";
import { getToolResultArtifactId, getToolResultText } from "./context-tool-result.ts";
import { latestUserPromptText } from "./message-text.ts";
import { quantizeRecentBoundary, resolveRecentBoundaryStride } from "./prefix-stability.ts";

export interface ContextPromptEnforcementSettings {
	enabled: boolean;
	preserveRecentMessages: number;
	minChars: number;
	/**
	 * Whether the `artifact_retrieve` tool is actually active this turn -- a runtime fact,
	 * not a persisted setting. Callers must derive this from the live active-tool set (e.g.
	 * `AgentSession.getActiveToolNames().includes("artifact_retrieve")`), never assume it.
	 */
	retrievalToolAvailable: boolean;
	/**
	 * Brain-curator relevance lookup (runtime fact, like `retrievalToolAvailable`; never
	 * persisted). A fresh high-confidence verdict selects only among deterministic bounded
	 * visibility candidates. Missing/uncertain query-aware judgment fails open; when this callback
	 * is absent, the deterministic legacy recent/stale behavior is preserved. No advisory can
	 * bypass the absolute floor or a hard constraint.
	 */
	brainRelevance?: (scope: ContextRelevanceScope) => ContextRelevanceVerdict | undefined;
}

export type PromptEnforcementSkipReason =
	| "message_mismatch"
	| "within_recent_window"
	| "errored_tool_result"
	| "already_stubbed_or_packed"
	| "not_artifact_backed"
	| "retrieval_tool_unavailable"
	| "hard_constraint_rejected"
	| "missing_artifact_id"
	| "below_min_chars"
	| "frozen_prefix_preserved"
	| "gc_retrieval_unavailable";

export type PromptProjectionPlacement = "in_place" | "tail_overlay" | "frozen_original" | "gc_stub";

export interface PromptEnforcementItemReport {
	itemId: string;
	toolCallId: string;
	messageIndex: number;
	enforced: boolean;
	action?: "artifact_stub" | "artifact_preview" | "artifact_full";
	artifactId?: string;
	retrievalId?: string;
	originalChars?: number;
	skipReason?: PromptEnforcementSkipReason;
	selectedVisibility?: ContextVisibility;
	deliveredVisibility?: ContextVisibility;
	projectionPlacement?: PromptProjectionPlacement;
	visibilityReason?: ContextVisibilityReason;
	candidateVisibilities?: readonly ContextVisibility[];
	relevanceKey?: string;
	advisory?: ContextVisibilityAdvisory;
}

export interface PromptEnforcementReport {
	turnIndex: number;
	items: PromptEnforcementItemReport[];
}

export interface EnforcePromptPolicyResult {
	messages: AgentMessage[];
	/** Query-specific tail overlays. Array content keeps them request-only in transient reconciliation. */
	transientMessages: AgentMessage[];
	report: PromptEnforcementReport;
	/** Relevance facts read while planning must still match when the provider plan is accepted. */
	isCurrent(): boolean;
}

export interface PromptEnforcementContext {
	/** Raw pre-GC evidence aligned by index with the provider-visible projection. */
	sourceMessages: AgentMessage[];
	/** Already-sent prefix. Query policy must never rewrite it in place. */
	frozenBelow: number;
	/** Stable GC retrieval handles for evidence that GC projected out of the prefix. */
	gcReport: ContextGcReport;
}

export const CONTEXT_VISIBILITY_PROJECTION_CUSTOM_TYPE = "context_visibility_projection";

const ENFORCEMENT_ABSOLUTE_RECENT_FLOOR = 4;

function isPromptPolicyEnforced(details: unknown): boolean {
	if (typeof details !== "object" || details === null) return false;
	return (details as { promptPolicy?: { enforced?: unknown } }).promptPolicy?.enforced === true;
}

function isContextGcPacked(details: unknown): boolean {
	if (typeof details !== "object" || details === null) return false;
	return (details as { contextGc?: { packed?: unknown } }).contextGc?.packed === true;
}

function buildStubText(toolName: string, originalChars: number, artifactId: string): string {
	return `[content replaced by prompt-policy: originally ${originalChars} chars from a stale ${toolName} tool result. Retrieve the full output with artifact_retrieve using artifactId "${artifactId}".]`;
}

function buildPreviewText(
	visibility: "short" | "long",
	toolName: string,
	originalText: string,
	retrievalId: string,
): string {
	const maxChars = visibility === "short" ? CONTEXT_VISIBILITY_SHORT_CHARS : CONTEXT_VISIBILITY_LONG_CHARS;
	const preview = contextVisibilityExcerpt(originalText, maxChars);
	return `[query-time context visibility ${visibility}: showing ${preview.length} of ${originalText.length} chars from a stale ${toolName} tool result. Full content: artifact_retrieve ${retrievalId}.]\n${preview}`;
}

function buildFullProjectionText(toolName: string, originalText: string, retrievalId?: string): string {
	return `[query-time context visibility full: ${originalText.length} chars from a stale ${toolName} tool result.${retrievalId ? ` Stable retrieval: artifact_retrieve ${retrievalId}.` : ""}]\n${originalText}`;
}

function projectionMessage(
	source: Extract<AgentMessage, { role: "toolResult" }>,
	text: string,
	details: {
		selectedVisibility: ContextVisibility;
		retrievalId?: string;
		relevanceKey?: string;
		messageIndex: number;
	},
): AgentMessage {
	return {
		role: "custom",
		customType: CONTEXT_VISIBILITY_PROJECTION_CUSTOM_TYPE,
		// Array content is intentional: adaptHostTransients treats this as request-only pass-through,
		// so a query-specific view never becomes an accumulating durable record.
		content: [{ type: "text", text }],
		display: false,
		details: {
			contextVisibility: {
				sourceToolCallId: source.toolCallId,
				sourceMessageIndex: details.messageIndex,
				selectedVisibility: details.selectedVisibility,
				...(details.retrievalId ? { retrievalId: details.retrievalId } : {}),
				...(details.relevanceKey ? { relevanceKey: details.relevanceKey } : {}),
			},
		},
		timestamp: source.timestamp,
	};
}

function sameVerdict(left: ContextRelevanceVerdict | undefined, right: ContextRelevanceVerdict | undefined): boolean {
	return left?.relevant === right?.relevant && left?.confidence === right?.confidence;
}

function skip(
	item: { itemId: string; toolCallId: string; messageIndex: number },
	skipReason: PromptEnforcementSkipReason,
	extra?: Omit<PromptEnforcementItemReport, "itemId" | "toolCallId" | "messageIndex" | "enforced" | "skipReason">,
): PromptEnforcementItemReport {
	return {
		itemId: item.itemId,
		toolCallId: item.toolCallId,
		messageIndex: item.messageIndex,
		enforced: false,
		skipReason,
		...extra,
	};
}

/**
 * Apply query-time visibility to the provider-visible `messages` after context GC. Raw aligned
 * evidence in `context.sourceMessages` remains the scoring source. Unsent raw entries may be
 * projected in place; GC-packed entries use request-only tail overlays; already-sent raw entries
 * remain untouched. The function never mutates an input message or array.
 */
export function enforcePromptPolicy(
	messages: AgentMessage[],
	shadowReport: PromptPolicyShadowReport,
	settings: ContextPromptEnforcementSettings,
	context?: PromptEnforcementContext,
): EnforcePromptPolicyResult {
	const sourceMessages = context?.sourceMessages ?? messages;
	const frozenBelow = Math.min(Math.max(0, Math.floor(context?.frozenBelow ?? 0)), messages.length);
	const gcReport = context?.gcReport;
	const relevanceReads: Array<{ scope: ContextRelevanceScope; verdict: ContextRelevanceVerdict | undefined }> = [];
	const isCurrent = () =>
		relevanceReads.every(({ scope, verdict }) => sameVerdict(settings.brainRelevance?.(scope), verdict));
	if (!settings.enabled) {
		return { messages, transientMessages: [], report: { turnIndex: shadowReport.turnIndex, items: [] }, isCurrent };
	}

	// Quantized like context GC's packing boundary: stubbing rewrites history in place, so a
	// cutoff that advances one position per appended message re-prefills the conversation tail on
	// every provider request (see prefix-stability.ts).
	const recentCutoffIndex = quantizeRecentBoundary(
		Math.max(0, sourceMessages.length - settings.preserveRecentMessages),
		resolveRecentBoundaryStride(settings.preserveRecentMessages),
	);
	// Advisory evictions may reach inside the recent window but NEVER past this absolute floor:
	// the last few messages are what the model is actively reasoning over.
	const absoluteFloorIndex = Math.max(0, sourceMessages.length - ENFORCEMENT_ABSOLUTE_RECENT_FLOOR);
	const currentQuery = settings.brainRelevance
		? latestUserPromptText(sourceMessages, CURATION_RELEVANCE_QUERY_MAX_CHARS)
		: "";
	const nextMessages = messages.slice();
	const transientMessages: AgentMessage[] = [];
	let changed = false;
	const items: PromptEnforcementItemReport[] = [];

	for (const planItem of shadowReport.items) {
		const sourceMessage = sourceMessages[planItem.messageIndex];
		const projectedMessage = messages[planItem.messageIndex];
		if (
			sourceMessage?.role !== "toolResult" ||
			sourceMessage.toolCallId !== planItem.toolCallId ||
			projectedMessage?.role !== "toolResult" ||
			projectedMessage.toolCallId !== planItem.toolCallId
		) {
			items.push(skip(planItem, "message_mismatch"));
			continue;
		}
		const insideRecentWindow = planItem.messageIndex >= recentCutoffIndex;
		const insideAbsoluteFloor = insideRecentWindow && planItem.messageIndex >= absoluteFloorIndex;
		if (insideAbsoluteFloor || (insideRecentWindow && !settings.brainRelevance)) {
			items.push(
				skip(planItem, "within_recent_window", {
					selectedVisibility: "full",
					visibilityReason: insideAbsoluteFloor ? "absolute_floor" : "recent_window",
					candidateVisibilities: insideAbsoluteFloor ? ["full"] : ["hidden", "short", "long", "full"],
				}),
			);
			continue;
		}
		if (sourceMessage.isError) {
			items.push(skip(planItem, "errored_tool_result"));
			continue;
		}
		if (isPromptPolicyEnforced(projectedMessage.details)) {
			items.push(skip(planItem, "already_stubbed_or_packed"));
			continue;
		}
		// A diagnostic/direct caller that supplies only the already-packed view has no raw evidence
		// from which to build a query overlay. Preserve the historical no-op behavior in that case.
		if (isContextGcPacked(projectedMessage.details) && !context) {
			items.push(skip(planItem, "already_stubbed_or_packed"));
			continue;
		}
		if (!planItem.hasAvailableRetrievalPath) {
			items.push(skip(planItem, "not_artifact_backed"));
			continue;
		}
		if (!settings.retrievalToolAvailable) {
			items.push(skip(planItem, "retrieval_tool_unavailable"));
			continue;
		}
		if (planItem.hardConstraints.dropFromPrompt.length > 0) {
			items.push(skip(planItem, "hard_constraint_rejected"));
			continue;
		}
		const artifactId = getToolResultArtifactId(sourceMessage.details);
		if (!artifactId) {
			items.push(skip(planItem, "missing_artifact_id"));
			continue;
		}
		const originalText = getToolResultText(sourceMessage);
		const originalChars = originalText.length;
		if (originalChars < settings.minChars) {
			items.push(skip(planItem, "below_min_chars", { artifactId, originalChars }));
			continue;
		}
		const relevanceScope = settings.brainRelevance
			? {
					itemId: planItem.itemId,
					query: currentQuery,
					content: contextVisibilityExcerpt(originalText, CURATION_RELEVANCE_CONTENT_MAX_CHARS),
				}
			: undefined;
		const verdict = relevanceScope ? settings.brainRelevance?.(relevanceScope) : undefined;
		if (relevanceScope) relevanceReads.push({ scope: relevanceScope, verdict });
		const decision = selectContextVisibility({
			insideAbsoluteFloor,
			insideRecentWindow,
			originalChars,
			queryAware: relevanceScope !== undefined,
			verdict,
		});
		const relevanceKey = relevanceScope ? contextRelevanceKey(relevanceScope) : undefined;
		const basePacked = isContextGcPacked(projectedMessage.details);
		const gcRecord = gcReport?.records.find(
			(record) => record.messageIndex === planItem.messageIndex && record.toolCallId === planItem.toolCallId,
		);
		const gcRetrievalId =
			gcRecord?.retrievalAvailable && gcRecord.storagePath && gcRecord.key ? `context:${gcRecord.key}` : undefined;

		if (basePacked) {
			if (decision.selected === "hidden" && gcRetrievalId) {
				items.push({
					itemId: planItem.itemId,
					toolCallId: planItem.toolCallId,
					messageIndex: planItem.messageIndex,
					enforced: true,
					action: "artifact_stub",
					artifactId,
					retrievalId: gcRetrievalId,
					originalChars,
					selectedVisibility: decision.selected,
					deliveredVisibility: "hidden",
					projectionPlacement: "gc_stub",
					visibilityReason: decision.reason,
					candidateVisibilities: decision.candidates,
					relevanceKey,
					advisory: decision.advisory,
				});
				continue;
			}
			const deliveredVisibility = gcRetrievalId ? decision.selected : "full";
			const overlayText =
				deliveredVisibility === "short" || deliveredVisibility === "long"
					? buildPreviewText(deliveredVisibility, sourceMessage.toolName, originalText, gcRetrievalId as string)
					: buildFullProjectionText(sourceMessage.toolName, originalText, gcRetrievalId);
			transientMessages.push(
				projectionMessage(sourceMessage, overlayText, {
					selectedVisibility: deliveredVisibility,
					retrievalId: gcRetrievalId,
					relevanceKey,
					messageIndex: planItem.messageIndex,
				}),
			);
			items.push({
				itemId: planItem.itemId,
				toolCallId: planItem.toolCallId,
				messageIndex: planItem.messageIndex,
				enforced: true,
				action:
					deliveredVisibility === "full"
						? "artifact_full"
						: deliveredVisibility === "hidden"
							? "artifact_stub"
							: "artifact_preview",
				artifactId,
				retrievalId: gcRetrievalId,
				originalChars,
				selectedVisibility: decision.selected,
				deliveredVisibility,
				projectionPlacement: "tail_overlay",
				visibilityReason: decision.reason,
				candidateVisibilities: decision.candidates,
				relevanceKey,
				advisory: decision.advisory,
				...(!gcRetrievalId ? { skipReason: "gc_retrieval_unavailable" as const } : {}),
			});
			continue;
		}

		if (decision.selected === "full") {
			items.push({
				itemId: planItem.itemId,
				toolCallId: planItem.toolCallId,
				messageIndex: planItem.messageIndex,
				enforced: false,
				artifactId,
				originalChars,
				selectedVisibility: decision.selected,
				deliveredVisibility: "full",
				projectionPlacement: "in_place",
				visibilityReason: decision.reason,
				candidateVisibilities: decision.candidates,
				relevanceKey,
				advisory: decision.advisory,
				...(insideRecentWindow ? { skipReason: "within_recent_window" as const } : {}),
			});
			continue;
		}
		if (planItem.messageIndex < frozenBelow) {
			items.push({
				itemId: planItem.itemId,
				toolCallId: planItem.toolCallId,
				messageIndex: planItem.messageIndex,
				enforced: false,
				artifactId,
				originalChars,
				skipReason: "frozen_prefix_preserved",
				selectedVisibility: decision.selected,
				deliveredVisibility: "full",
				projectionPlacement: "frozen_original",
				visibilityReason: decision.reason,
				candidateVisibilities: decision.candidates,
				relevanceKey,
				advisory: decision.advisory,
			});
			continue;
		}

		const existingDetails =
			typeof projectedMessage.details === "object" && projectedMessage.details !== null
				? projectedMessage.details
				: {};
		const action = decision.selected === "hidden" ? "artifact_stub" : "artifact_preview";
		nextMessages[planItem.messageIndex] = {
			...projectedMessage,
			content: [
				{
					type: "text",
					text:
						decision.selected === "hidden"
							? buildStubText(sourceMessage.toolName, originalChars, artifactId)
							: buildPreviewText(decision.selected, sourceMessage.toolName, originalText, artifactId),
				},
			],
			details: {
				...existingDetails,
				promptPolicy: {
					enforced: true,
					action,
					artifactId,
					originalChars,
					reason: "stale_artifact_backed_tool_output",
					selectedVisibility: decision.selected,
					visibilityReason: decision.reason,
					...(relevanceKey ? { relevanceKey } : {}),
				},
			},
		};
		changed = true;
		items.push({
			itemId: planItem.itemId,
			toolCallId: planItem.toolCallId,
			messageIndex: planItem.messageIndex,
			enforced: true,
			action,
			artifactId,
			originalChars,
			selectedVisibility: decision.selected,
			deliveredVisibility: decision.selected,
			projectionPlacement: "in_place",
			visibilityReason: decision.reason,
			candidateVisibilities: decision.candidates,
			relevanceKey,
			advisory: decision.advisory,
		});
	}

	return {
		messages: changed ? nextMessages : messages,
		transientMessages,
		report: { turnIndex: shadowReport.turnIndex, items },
		isCurrent,
	};
}
