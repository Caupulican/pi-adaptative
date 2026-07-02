/**
 * First enforcement pilot for the context-policy layer (opt-in, default disabled). Unlike
 * context-audit.ts/context-prompt-policy.ts (both strictly observe-only), this module CAN
 * change the provider-visible message array -- but only ever via stub-in-place on
 * artifact-backed tool_output results, never by removing a message or breaking
 * assistant/toolResult pairing. It never touches the transcript, never releases/reclaims
 * artifact references, and never writes a new artifact -- it only replaces the visible
 * text of an already artifact-backed message with a bounded pointer to the existing
 * artifact, retrievable via the `artifact_retrieve` tool.
 *
 * Eligibility for stubbing is deliberately conservative (see `enforcePromptPolicy`): the
 * setting must be enabled, the item must be outside the recent-message safety window, not
 * an errored tool result, not already stubbed by this module or already packed by legacy
 * context-gc this turn, must have a resolvable artifact id, the `artifact_retrieve` tool
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
 * tools can differ turn to turn. Stubbing content with an unactionable pointer would be
 * strictly worse than leaving the raw content in place.
 */

import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { ToolResultMessage } from "@caupulican/pi-ai";
import { CURATION_RELEVANCE_MIN_CONFIDENCE } from "./brain-curator.ts";
import type { PromptPolicyShadowReport } from "./context-prompt-policy.ts";

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
	 * persisted). ASYMMETRIC by design: an explicit high-confidence irrelevance verdict may
	 * evict an otherwise-eligible item from within the recent window (never past the absolute
	 * floor), but an advisory can never keep an item the policy wants gone, never stub a
	 * hard-constraint-protected item, and its absence is byte-for-byte today's behavior.
	 */
	brainRelevance?: (itemId: string) => { relevant: boolean; confidence: number } | undefined;
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
	| "below_min_chars";

export interface PromptEnforcementItemReport {
	itemId: string;
	toolCallId: string;
	messageIndex: number;
	enforced: boolean;
	action?: "artifact_stub";
	artifactId?: string;
	originalChars?: number;
	skipReason?: PromptEnforcementSkipReason;
	/** Set when a brain-curator irrelevance verdict allowed eviction inside the recent window. */
	advisory?: "brain_irrelevant";
}

export interface PromptEnforcementReport {
	turnIndex: number;
	items: PromptEnforcementItemReport[];
}

export interface EnforcePromptPolicyResult {
	messages: AgentMessage[];
	report: PromptEnforcementReport;
}

const ENFORCEMENT_ABSOLUTE_RECENT_FLOOR = 4;

function extractDetailsArtifactId(details: unknown): string | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const artifactId = (details as { artifactId?: unknown }).artifactId;
	return typeof artifactId === "string" ? artifactId : undefined;
}

/** True if legacy context-gc already packed this message this turn, or this module already stubbed it. */
function isAlreadyStubbedOrPacked(details: unknown): boolean {
	if (typeof details !== "object" || details === null) return false;
	const record = details as { promptPolicy?: { enforced?: unknown }; contextGc?: { packed?: unknown } };
	return record.promptPolicy?.enforced === true || record.contextGc?.packed === true;
}

function toolResultText(message: ToolResultMessage): string {
	const parts: string[] = [];
	for (const part of message.content) {
		if (part.type === "text") parts.push(part.text);
	}
	return parts.join("\n");
}

function buildStubText(toolName: string, originalChars: number, artifactId: string): string {
	return `[content replaced by prompt-policy: originally ${originalChars} chars from a stale ${toolName} tool result. Retrieve the full output with artifact_retrieve using artifactId "${artifactId}".]`;
}

function skip(
	item: { itemId: string; toolCallId: string; messageIndex: number },
	skipReason: PromptEnforcementSkipReason,
	extra?: { artifactId?: string; originalChars?: number },
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
 * Apply the first enforcement pilot to `messages` (expected to be the provider-visible
 * array after existing context-gc has already run). Returns a new array only when at least
 * one item was actually stubbed; otherwise returns the same `messages` reference unchanged
 * (in particular, always true when `settings.enabled` is false). Never mutates `messages`
 * or any message object within it -- every stubbed entry is a fresh object.
 */
export function enforcePromptPolicy(
	messages: AgentMessage[],
	shadowReport: PromptPolicyShadowReport,
	settings: ContextPromptEnforcementSettings,
): EnforcePromptPolicyResult {
	if (!settings.enabled) {
		return { messages, report: { turnIndex: shadowReport.turnIndex, items: [] } };
	}

	const recentCutoffIndex = Math.max(0, messages.length - settings.preserveRecentMessages);
	// Advisory evictions may reach inside the recent window but NEVER past this absolute floor:
	// the last few messages are what the model is actively reasoning over.
	const absoluteFloorIndex = Math.max(0, messages.length - ENFORCEMENT_ABSOLUTE_RECENT_FLOOR);
	const nextMessages = messages.slice();
	let changed = false;
	const items: PromptEnforcementItemReport[] = [];

	for (const planItem of shadowReport.items) {
		const message = messages[planItem.messageIndex];
		if (!message || message.role !== "toolResult" || message.toolCallId !== planItem.toolCallId) {
			items.push(skip(planItem, "message_mismatch"));
			continue;
		}
		let advisoryEviction = false;
		if (planItem.messageIndex >= recentCutoffIndex) {
			const advisory = settings.brainRelevance?.(planItem.itemId);
			advisoryEviction =
				advisory !== undefined &&
				!advisory.relevant &&
				advisory.confidence >= CURATION_RELEVANCE_MIN_CONFIDENCE &&
				planItem.messageIndex < absoluteFloorIndex;
			if (!advisoryEviction) {
				items.push(skip(planItem, "within_recent_window"));
				continue;
			}
		}
		if (message.isError) {
			items.push(skip(planItem, "errored_tool_result"));
			continue;
		}
		if (isAlreadyStubbedOrPacked(message.details)) {
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
		const artifactId = extractDetailsArtifactId(message.details);
		if (!artifactId) {
			items.push(skip(planItem, "missing_artifact_id"));
			continue;
		}
		const originalChars = toolResultText(message).length;
		if (originalChars < settings.minChars) {
			items.push(skip(planItem, "below_min_chars", { artifactId, originalChars }));
			continue;
		}

		const existingDetails = typeof message.details === "object" && message.details !== null ? message.details : {};
		nextMessages[planItem.messageIndex] = {
			...message,
			content: [{ type: "text", text: buildStubText(message.toolName, originalChars, artifactId) }],
			details: {
				...existingDetails,
				promptPolicy: {
					enforced: true,
					action: "artifact_stub",
					artifactId,
					originalChars,
					reason: "stale_artifact_backed_tool_output",
				},
			},
		};
		changed = true;
		items.push({
			itemId: planItem.itemId,
			toolCallId: planItem.toolCallId,
			messageIndex: planItem.messageIndex,
			enforced: true,
			action: "artifact_stub",
			artifactId,
			originalChars,
			...(advisoryEviction ? { advisory: "brain_irrelevant" as const } : {}),
		});
	}

	return {
		messages: changed ? nextMessages : messages,
		report: { turnIndex: shadowReport.turnIndex, items },
	};
}
