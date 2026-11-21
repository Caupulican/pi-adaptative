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

import { harnessLog } from "../../kernel/harness-log.ts";
import type { AgentMessage } from "../../kernel/index.ts";
import { immutableHistoryMessage, isImmutableHistoryMessage } from "../../kernel/message-revision.ts";
import { type AcceptedPromptPreviews, acceptedPreview } from "./accepted-prompt-previews.ts";
import {
	type ContextRelevanceScope,
	CURATION_RELEVANCE_CONTENT_MAX_CHARS,
	CURATION_RELEVANCE_QUERY_MAX_CHARS,
	contextRelevanceKey,
} from "./brain-curator.ts";
import { type ContextGcReport, packedRecordLookup } from "./context-gc-report.ts";
import {
	artifactPolicyItems,
	type PromptPolicyShadowReport,
	policyAuditView,
	promptPolicyItems,
} from "./context-prompt-policy.ts";
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
import {
	getToolResultArtifactId,
	getToolResultPolicyText,
	getToolResultText,
	isPromptPolicyEnforced,
} from "./context-tool-result.ts";
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
	| "unretained_source"
	| "gc_retrieval_unavailable";

export type PromptProjectionPlacement =
	| "in_place"
	| "tail_overlay"
	| "frozen_original"
	| "accepted_preview"
	| "gc_stub";

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
	/** The accepted preview still present in the prefix, including when more evidence travels at the tail. */
	retainedVisibility?: Exclude<ContextVisibility, "full">;
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
	compressionPolicy?: string;
	acceptProviderHistory?(): void;
	isDispatchCurrent?(): boolean;
	messages: AgentMessage[];
	/** Query-specific tail overlays. Array content keeps them request-only in transient reconciliation. */
	transientMessages: AgentMessage[];
	report: PromptEnforcementReport;
	/** Relevance facts read while planning must still match when the provider plan is accepted. */
	isCurrent(): boolean;
}

export interface PromptEnforcementContext {
	modelScope?: string;
	previews?: ReturnType<AcceptedPromptPreviews["begin"]>;
	artifactAvailable?(id: string): boolean;
	canRetrieve?(): boolean;
	/** Raw pre-GC evidence aligned by index with the provider-visible projection. */
	sourceMessages: AgentMessage[];
	/** Already-sent prefix. Query policy must never rewrite it in place. */
	frozenBelow: number;
	/** Stable GC retrieval handles for evidence that GC projected out of the prefix. */
	gcReport: ContextGcReport;
	/** Versioned durable history with the same tool positions, identities, error and enforcement flags in both projections. */
	alignedPolicyHistory?: readonly AgentMessage[];
}

export const CONTEXT_VISIBILITY_PROJECTION_CUSTOM_TYPE = "context_visibility_projection";

const ENFORCEMENT_ABSOLUTE_RECENT_FLOOR = 4;

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
	const previews = context?.previews;
	const requiredArtifacts = new Set<string>();
	const dispatchCurrent = () => {
		if (previews?.isCurrent() === false) return false;
		if (!requiredArtifacts.size) return true;
		if (context?.canRetrieve?.() === false) return false;
		for (const id of requiredArtifacts) if (context?.artifactAvailable?.(id) === false) return false;
		return true;
	};
	const isCurrent = () =>
		dispatchCurrent() &&
		relevanceReads.every(({ scope, verdict }) => sameVerdict(settings.brainRelevance?.(scope), verdict));
	if (!settings.enabled) {
		return {
			messages,
			transientMessages: [],
			report: { turnIndex: shadowReport.turnIndex, items: [] },
			isCurrent,
			acceptProviderHistory: previews?.accept,
			isDispatchCurrent: previews?.isCurrent,
		};
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
	const audit = context && policyAuditView(shadowReport);
	const sparse =
		audit &&
		((messages === sourceMessages && audit.matchesSource(sourceMessages)) ||
			(context?.alignedPolicyHistory && audit.matchesSource(context.alignedPolicyHistory)))
			? audit
			: undefined;
	const planItems = sparse ? artifactPolicyItems(shadowReport) : promptPolicyItems(shadowReport);
	const currentQuery =
		planItems.length > 0 && settings.brainRelevance
			? latestUserPromptText(sourceMessages, CURATION_RELEVANCE_QUERY_MAX_CHARS)
			: "";
	let nextMessages: AgentMessage[] | undefined;
	const transientMessages: AgentMessage[] = [];
	let getPackedRecord: ReturnType<typeof packedRecordLookup> | undefined;
	const items: PromptEnforcementItemReport[] = [];

	const queryAware = Boolean(settings.brainRelevance);
	function preliminarySkip(
		item: Parameters<typeof skip>[0],
		isError: boolean,
		alreadyEnforced: boolean,
		retained = false,
	) {
		const recent = item.messageIndex >= recentCutoffIndex;
		const floor = recent && item.messageIndex >= absoluteFloorIndex;
		if (!retained && (floor || (recent && !queryAware)))
			return skip(item, "within_recent_window", {
				selectedVisibility: "full",
				visibilityReason: floor ? "absolute_floor" : "recent_window",
				candidateVisibilities: floor ? ["full"] : ["hidden", "short", "long", "full"],
			});
		if (isError) return skip(item, "errored_tool_result");
		if (alreadyEnforced) return skip(item, "already_stubbed_or_packed");
		return undefined;
	}
	for (const planItem of planItems) {
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
		const retained =
			planItem.messageIndex < frozenBelow
				? previews?.get(planItem.messageIndex, sourceMessage, projectedMessage)
				: undefined;
		const skipped = preliminarySkip(
			planItem,
			sourceMessage.isError,
			isPromptPolicyEnforced(projectedMessage.details) || (!context && isContextGcPacked(projectedMessage.details)),
			!!retained,
		);
		if (skipped) {
			items.push(skipped);
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
		// Direct callers may supply mutable rows and a verdict callback. Capture their original text before the callback.
		const mutableText = isImmutableHistoryMessage(sourceMessage) ? undefined : getToolResultText(sourceMessage);
		const { originalChars, excerpt } =
			mutableText === undefined
				? getToolResultPolicyText(sourceMessage)
				: {
						originalChars: mutableText.length,
						excerpt: contextVisibilityExcerpt(mutableText, CURATION_RELEVANCE_CONTENT_MAX_CHARS),
					};
		if (originalChars < settings.minChars) {
			items.push(skip(planItem, "below_min_chars", { artifactId, originalChars }));
			continue;
		}
		const relevanceScope = settings.brainRelevance
			? {
					itemId: planItem.itemId,
					query: currentQuery,
					content: excerpt,
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
		if (basePacked || retained) {
			let retrievalId: string | undefined;
			if (basePacked) {
				getPackedRecord ??= packedRecordLookup(gcReport?.records ?? []);
				const record = getPackedRecord(planItem.messageIndex, planItem.toolCallId);
				if (record?.retrievalAvailable && record.storagePath && record.key) retrievalId = `context:${record.key}`;
			} else if (retained) {
				nextMessages ??= messages.slice();
				nextMessages[planItem.messageIndex] = retained.row;
				previews!.keep(planItem.messageIndex, sourceMessage, projectedMessage, retained);
				requiredArtifacts.add(artifactId);
				retrievalId = artifactId;
			}
			const visible = basePacked ? "hidden" : retained!.visibility;
			const needsOverlay =
				decision.selected === "full" ||
				(decision.selected === "long" && visible !== "long") ||
				(decision.selected === "short" && visible === "hidden");
			if (!needsOverlay && retrievalId) {
				items.push({
					itemId: planItem.itemId,
					toolCallId: planItem.toolCallId,
					messageIndex: planItem.messageIndex,
					enforced: true,
					action: visible === "hidden" ? "artifact_stub" : "artifact_preview",
					artifactId,
					retrievalId,
					originalChars,
					selectedVisibility: decision.selected,
					deliveredVisibility: visible,
					projectionPlacement: basePacked ? "gc_stub" : "accepted_preview",
					...(!basePacked && retained ? { retainedVisibility: retained.visibility } : {}),
					visibilityReason: decision.reason,
					candidateVisibilities: decision.candidates,
					relevanceKey,
					advisory: decision.advisory,
				});
				continue;
			}
			const deliveredVisibility = retrievalId ? decision.selected : "full";
			const originalText = mutableText ?? getToolResultText(sourceMessage);
			const overlayText =
				deliveredVisibility === "short" || deliveredVisibility === "long"
					? buildPreviewText(deliveredVisibility, sourceMessage.toolName, originalText, retrievalId as string)
					: buildFullProjectionText(sourceMessage.toolName, originalText, retrievalId);
			transientMessages.push(
				projectionMessage(sourceMessage, overlayText, {
					selectedVisibility: deliveredVisibility,
					retrievalId,
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
				retrievalId,
				originalChars,
				selectedVisibility: decision.selected,
				deliveredVisibility,
				projectionPlacement: "tail_overlay",
				...(!basePacked && retained ? { retainedVisibility: retained.visibility } : {}),
				visibilityReason: decision.reason,
				candidateVisibilities: decision.candidates,
				relevanceKey,
				advisory: decision.advisory,
				...(!retrievalId ? { skipReason: "gc_retrieval_unavailable" as const } : {}),
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
		if (previews && (!isImmutableHistoryMessage(sourceMessage) || !isImmutableHistoryMessage(projectedMessage))) {
			items.push(skip(planItem, "unretained_source"));
			continue;
		}
		const replacement: typeof projectedMessage = {
			...projectedMessage,
			content: [
				{
					type: "text",
					text:
						decision.selected === "hidden"
							? buildStubText(sourceMessage.toolName, originalChars, artifactId)
							: buildPreviewText(
									decision.selected,
									sourceMessage.toolName,
									mutableText ?? getToolResultText(sourceMessage),
									artifactId,
								),
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
		const row = previews ? immutableHistoryMessage(replacement) : replacement;
		if (row?.role !== "toolResult") {
			items.push(skip(planItem, "unretained_source"));
			continue;
		}
		nextMessages ??= messages.slice();
		nextMessages[planItem.messageIndex] = row;
		previews?.keep(planItem.messageIndex, sourceMessage, projectedMessage, acceptedPreview(row, decision.selected));
		requiredArtifacts.add(artifactId);
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

	let detailed: PromptEnforcementItemReport[] | undefined;
	const report: PromptEnforcementReport = {
		turnIndex: shadowReport.turnIndex,
		get items() {
			if (!sparse) return items;
			if (detailed) return detailed;
			const complete: PromptEnforcementItemReport[] = [];
			let candidate = 0;
			for (const identity of sparse.identities()) {
				if (items[candidate]?.messageIndex === identity.messageIndex) {
					complete.push(items[candidate++]);
				} else {
					complete.push(
						preliminarySkip(identity, identity.isError, identity.alreadyEnforced) ??
							skip(identity, "not_artifact_backed"),
					);
				}
			}
			detailed = complete;
			return detailed;
		},
	};
	harnessLog.debug("context", "prompt policy checked the tool results", () => ({
		items: sparse?.count ?? items.length,
		enforced: items.filter((item) => item.enforced).length,
		inPlace: items.filter((item) => item.enforced && item.projectionPlacement === "in_place").length,
		tailOverlays: items.filter((item) => item.projectionPlacement === "tail_overlay").length,
		frozenPreserved: items.filter((item) => item.skipReason === "frozen_prefix_preserved").length,
		originalChars: items.reduce((sum, item) => sum + (item.enforced ? (item.originalChars ?? 0) : 0), 0),
	}));
	return {
		messages: nextMessages ?? messages,
		transientMessages,
		report,
		isCurrent,
		compressionPolicy: previews?.policy(),
		acceptProviderHistory: previews?.accept,
		isDispatchCurrent: dispatchCurrent,
	};
}
