/**
 * Evidence retention projection.
 *
 * Turns a live session branch into the tool call/result pairs the EvidenceRetentionPlanner reasons
 * about, and applies the planner's decisions back onto a branch projection before
 * `prepareCompaction` reads it. Planner ownership alone is not delivery: the decisions have to
 * change what the real compaction keeps. Conforms to COMPACTION_LIVE_PATH.md and RCG-030..RCG-035.
 *
 * Only tool call/result pairs are ever eligible. Every other entry — user turns, durable owner rule
 * records, charter provenance, checkpoints — passes through untouched, which is what pins them.
 */

import type { SessionEntry } from "@caupulican/pi-agent-core/session";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@caupulican/pi-ai";
import type {
	EvidenceRetentionDecision,
	RetentionDisposition,
	ToolCallResultPair,
} from "./evidence-retention-planner.ts";

/** Deterministic pin inputs owned by the host, independent of any semantic judgment. */
export interface RetentionPinContext {
	/** Unresolved proof obligations; any pair naming one is pinned. */
	readonly unresolvedProofObligations?: readonly string[];
	/** Tool names whose evidence the host always retains exactly. */
	readonly pinnedToolNames?: readonly string[];
	/** Trailing pairs never offered to the planner. */
	readonly preserveRecentPairs?: number;
}

const DEFAULT_PRESERVE_RECENT_PAIRS = 12;

/** Session custom-entry type carrying the applied retention audit. */
export const RETENTION_AUDIT_CUSTOM_TYPE = "evidence-retention-audit";

/** Host surfaces whose results carry live execution state the next transition owner still needs. */
const ALWAYS_PINNED_TOOL_NAMES: readonly string[] = [
	"delegate",
	"delegate_status",
	"goal",
	"task_steps",
	"task_directory",
	"memory",
];

interface BranchToolCallSite {
	readonly entryIndex: number;
	readonly call: ToolCall;
}

function entryMessage(entry: SessionEntry): AssistantMessage | ToolResultMessage | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message as { role?: string };
	if (message.role === "assistant" || message.role === "toolResult") {
		return entry.message as AssistantMessage | ToolResultMessage;
	}
	return undefined;
}

function resultText(result: ToolResultMessage): string {
	return result.content
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("")
		.trim();
}

/**
 * Pairs every tool call on the branch with its result, in branch order.
 * A call with no result is not a pair: it is an open operation and is never eligible.
 */
export function collectToolCallResultPairs(
	branch: readonly SessionEntry[],
	pins: RetentionPinContext = {},
): readonly ToolCallResultPair[] {
	const callSites = new Map<string, BranchToolCallSite>();
	const pairs: ToolCallResultPair[] = [];
	const pinnedToolNames = new Set([...ALWAYS_PINNED_TOOL_NAMES, ...(pins.pinnedToolNames ?? [])]);
	const obligations = pins.unresolvedProofObligations ?? [];

	for (let index = 0; index < branch.length; index++) {
		const message = entryMessage(branch[index]!);
		if (!message) continue;
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") callSites.set(block.id, { entryIndex: index, call: block });
			}
			continue;
		}

		const site = callSites.get(message.toolCallId);
		if (!site) continue;
		const text = resultText(message);
		const mentionsObligation = obligations.some(
			(obligation) => obligation.length > 0 && (text.includes(obligation) || message.toolName === obligation),
		);
		pairs.push({
			callId: message.toolCallId,
			toolName: message.toolName,
			callPayload: site.call.arguments,
			resultPayload: text,
			tokens: Math.ceil(text.length / 4),
			occurredAt: new Date(message.timestamp).toISOString(),
			hasError: message.isError === true,
			isProofObligation: mentionsObligation || pinnedToolNames.has(message.toolName),
		});
	}

	return pairs;
}

/** The recency window the planner must treat as pinned for this branch. */
export function resolvePreserveRecentPairs(pins: RetentionPinContext = {}): number {
	return pins.preserveRecentPairs ?? DEFAULT_PRESERVE_RECENT_PAIRS;
}

function truncatedResultText(original: string, decision: EvidenceRetentionDecision): string {
	const reference = decision.artifactRef ? ` Full evidence retained at ${decision.artifactRef}.` : "";
	return `[compaction] Result elided by evidence-preserving compaction (${original.length} bytes).${reference}`;
}

export interface AppliedRetentionProjection {
	readonly branch: SessionEntry[];
	readonly droppedCallIds: readonly string[];
	readonly truncatedCallIds: readonly string[];
}

/**
 * Applies retention decisions to a branch projection.
 *
 * `drop_pair` removes the tool call and its result together, so no orphaned call or result can
 * reach the provider. `keep_call_truncate_result` keeps the call verbatim and replaces the result
 * body with a bounded reference. `keep_exact` and every unlisted entry are untouched.
 */
export function applyRetentionDecisionsToBranch(
	branch: readonly SessionEntry[],
	decisions: readonly EvidenceRetentionDecision[],
): AppliedRetentionProjection {
	const byCallId = new Map<string, RetentionDisposition>();
	const artifactRefs = new Map<string, EvidenceRetentionDecision>();
	for (const decision of decisions) {
		if (decision.disposition === "keep_exact") continue;
		byCallId.set(decision.callId, decision.disposition);
		artifactRefs.set(decision.callId, decision);
	}
	if (byCallId.size === 0) {
		return { branch: [...branch], droppedCallIds: [], truncatedCallIds: [] };
	}

	// A call is only dropped when its result is dropped with it, which the pairing already ensures:
	// both sides carry the same callId and the same disposition.
	const dropped = new Set<string>();
	const truncated = new Set<string>();
	const projected: SessionEntry[] = [];
	let retainedParentId: string | null = null;

	for (const entry of branch) {
		const message = entryMessage(entry);
		let nextEntry: SessionEntry = entry;

		if (message?.role === "assistant") {
			const keptContent = message.content.filter(
				(block) => !(block.type === "toolCall" && byCallId.get(block.id) === "drop_pair"),
			);
			if (keptContent.length !== message.content.length) {
				for (const block of message.content) {
					if (block.type === "toolCall" && byCallId.get(block.id) === "drop_pair") dropped.add(block.id);
				}
				// An assistant turn whose every block was a dropped call carries nothing; removing it
				// keeps the projection coherent instead of emitting an empty assistant message.
				if (keptContent.length === 0) continue;
				nextEntry = { ...entry, message: { ...message, content: keptContent } } as SessionEntry;
			}
		} else if (message?.role === "toolResult") {
			const disposition = byCallId.get(message.toolCallId);
			if (disposition === "drop_pair") {
				dropped.add(message.toolCallId);
				continue;
			}
			if (disposition === "keep_call_truncate_result") {
				truncated.add(message.toolCallId);
				const decision = artifactRefs.get(message.toolCallId);
				nextEntry = {
					...entry,
					message: {
						...message,
						content: [
							{
								type: "text",
								text: truncatedResultText(resultText(message), decision as EvidenceRetentionDecision),
							},
						],
					},
				} as SessionEntry;
			}
		}

		// Removing entries breaks ancestry for everything downstream; relink the linear branch while
		// preserving every retained entry id.
		const parentId = (nextEntry as { parentId?: string | null }).parentId ?? null;
		projected.push(
			parentId === retainedParentId ? nextEntry : ({ ...nextEntry, parentId: retainedParentId } as SessionEntry),
		);
		retainedParentId = (nextEntry as { id?: string }).id ?? retainedParentId;
	}

	return {
		branch: projected,
		droppedCallIds: [...dropped],
		truncatedCallIds: [...truncated],
	};
}
