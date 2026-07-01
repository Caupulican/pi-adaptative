/**
 * Live observe-only bridge from AgentMessage[] to the ContextItem/policy-engine layer
 * (Phase 1 audit pass). This module only ever reads messages and the artifact store; it
 * never mutates messages, the transcript, or artifact references. It is the first thing to
 * consume the context-item.ts/context-retention.ts/policy-engine.ts contracts against live
 * session state, but it does not yet change what the model sees -- see
 * docs/context-management-rework/implementation-phases.md for where this sits.
 *
 * Scope for this pass: only `toolResult` messages become `ContextItem`s (kind
 * "tool_output"). Other roles (user/assistant) are skipped; representing them is later
 * work once their ContextItemKind mapping (user_instruction/approval/etc.) is designed.
 *
 * Retrieval-path semantics (deliberately narrower than context-retention.ts's item-level
 * `hasReferencedEvidence`): a transcript ref is attached to every item as provenance
 * evidence (which live message this item came from), but it never counts toward
 * `HardConstraintFlags.hasAvailableRetrievalPath` on its own -- there is no live mechanism
 * today for the model to fetch an older message back into context by session-entry id, so
 * claiming that would overclaim retrievability (the same fail-closed principle
 * `artifact_retrieve` follows). Only a resolved artifact ref (the store still has the
 * payload) counts as an available retrieval path.
 */

import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { ToolResultMessage } from "@caupulican/pi-ai";
import type { ArtifactStore } from "./context-artifacts.ts";
import {
	type ContextEvidenceRef,
	type ContextItem,
	estimateByteLength,
	estimateTokensFromText,
} from "./context-item.ts";
import { evaluateRetentionEligibility, type RetentionEligibility } from "./context-retention.ts";
import { evaluateHardConstraints } from "./policy-engine.ts";
import type { HardConstraintFlags, PolicyFeatures, PolicyHardConstraintCode } from "./policy-types.ts";

export interface ContextAuditOptions {
	/** Current turn index (AgentSession's own per-run counter); used as `createdAtTurn`. */
	turnIndex: number;
	/** Session-scoped artifact store, if one has been constructed. Read-only here. */
	artifactStore?: ArtifactStore;
	/** Resolve the persisted session-entry id for a toolResult message's toolCallId, if known. */
	sessionEntryIdForToolCallId?: (toolCallId: string) => string | undefined;
}

export interface ContextAuditItemReport {
	item: ContextItem;
	/** The source toolResult message's own id and position, always available (unlike refs). */
	toolCallId: string;
	messageIndex: number;
	/** Coarse, store-free eligibility from context-retention.ts (treats any ref as retrievable). */
	retention: RetentionEligibility;
	/** Store-aware hard-constraint codes for keep_raw; always empty (no evaluated action restricts it), included for reportability. */
	keepRawHardConstraints: PolicyHardConstraintCode[];
	/** Store-aware hard-constraint codes for pack_to_artifact; empty means no hard rejection. */
	packToArtifactHardConstraints: PolicyHardConstraintCode[];
	/** Store-aware hard-constraint codes for drop_from_prompt; empty means no hard rejection. */
	dropFromPromptHardConstraints: PolicyHardConstraintCode[];
	/** Store-aware hard-constraint codes for summarize; empty means no hard rejection. */
	summarizeHardConstraints: PolicyHardConstraintCode[];
}

export interface ContextAuditReport {
	turnIndex: number;
	items: ContextAuditItemReport[];
}

function extractToolResultArtifactId(message: ToolResultMessage): string | undefined {
	const details = message.details;
	if (typeof details !== "object" || details === null) return undefined;
	const artifactId = (details as { artifactId?: unknown }).artifactId;
	return typeof artifactId === "string" ? artifactId : undefined;
}

function toolResultText(message: ToolResultMessage): string {
	const parts: string[] = [];
	for (const part of message.content) {
		if (part.type === "text") parts.push(part.text);
	}
	return parts.join("\n");
}

interface BuiltToolOutputItem {
	item: ContextItem;
	/** True only if an artifact ref was found AND resolved against a live store. */
	hasResolvedArtifact: boolean;
}

function buildToolOutputItem(
	message: ToolResultMessage,
	messageIndex: number,
	options: ContextAuditOptions,
): BuiltToolOutputItem {
	const text = toolResultText(message);
	const artifactId = extractToolResultArtifactId(message);
	const sessionEntryId = options.sessionEntryIdForToolCallId?.(message.toolCallId);

	let primaryRef: ContextEvidenceRef | undefined;
	let hasResolvedArtifact = false;
	// createdAtTurn defaults to the current audit turn (an approximation -- see below) and
	// is overridden with the real capture turn when an artifact ref resolves.
	let createdAtTurn = options.turnIndex;
	if (artifactId && options.artifactStore) {
		// Metadata-only: never loads the artifact's payload just to check resolvability and
		// grab ref fields (a per-turn audit pass over every artifact-backed result would
		// otherwise re-read every payload off disk each turn for no reason).
		const ref = options.artifactStore.readRef(artifactId);
		if (ref) {
			primaryRef = { type: "artifact", ref };
			hasResolvedArtifact = true;
			createdAtTurn = ref.createdAtTurn;
		}
	}

	const evidenceRefs: ContextEvidenceRef[] = [];
	if (sessionEntryId) {
		const transcriptRef: ContextEvidenceRef = {
			type: "transcript",
			ref: { sessionEntryId, messageIndex },
		};
		if (!primaryRef) primaryRef = transcriptRef;
		else evidenceRefs.push(transcriptRef);
	}

	const item: ContextItem = {
		id: `tool-output:${message.toolCallId}`,
		kind: "tool_output",
		retentionClass: "ephemeral",
		source: "tool",
		// Transcript-only items (no artifact ref) have no real creation-turn source threaded
		// in yet, so this falls back to the current audit turn as an approximation --
		// deliberately not left silently wrong: no evaluator reads createdAtTurn today, but
		// any future staleness/break-even math must use the real per-item value above, not
		// this fallback, once one exists for non-artifact items too.
		createdAtTurn,
		summary: `${message.toolName} tool result`,
		primaryRef,
		evidenceRefs: evidenceRefs.length > 0 ? evidenceRefs : undefined,
		tokenEstimate: estimateTokensFromText(text),
		byteEstimate: estimateByteLength(text),
	};

	return { item, hasResolvedArtifact };
}

/**
 * Economic/probability fields are zeroed: `evaluateHardConstraints` does not read them for
 * pack_to_artifact/drop_from_prompt (only the break-even scoring math this audit
 * deliberately does not invoke would need real numbers here).
 */
function buildPolicyFeatures(item: ContextItem, built: BuiltToolOutputItem, turnIndex: number): PolicyFeatures {
	return {
		turnIndex,
		expectedRemainingTurns: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		artifactBytes: built.hasResolvedArtifact ? item.byteEstimate : 0,
		charEstimate: item.byteEstimate,
		calibratedTokenEstimate: item.tokenEstimate,
		promptSection: "volatile_tail",
		retentionClass: item.retentionClass,
		isReproducible: true,
		isDecisionBearing: false,
		isPinned: false,
		isOpenRequirement: false,
		isLatestFailure: false,
		isCurrentDiff: false,
		probabilityNeededAgain: 0,
		probabilityErrorIfDropped: 0,
		retrievalCostTokens: 0,
		packCostTokens: 0,
		retryCostTokens: 0,
		failureCostTokens: 0,
		validationCostTokens: 0,
	};
}

function buildHardConstraintFlags(built: BuiltToolOutputItem, artifactStoreAvailable: boolean): HardConstraintFlags {
	return {
		isApprovalOrDenial: false,
		isSafetyConstraint: false,
		isActiveBlocker: false,
		isCurrentValidationResult: false,
		isPathOrToolScope: false,
		// Only a resolved artifact counts; a transcript ref is provenance, not a live
		// retrieval mechanism -- see the module doc comment.
		hasAvailableRetrievalPath: built.hasResolvedArtifact,
		artifactStoreAvailable,
		hasEvidenceRefForSummary: built.item.primaryRef !== undefined || (built.item.evidenceRefs?.length ?? 0) > 0,
		pathOrToolBoundariesEnforced: true,
		validationAvailableAndStrong: false,
		priorAttemptFailedForReasoningOrArchitecture: false,
		isHighImpactOrBroadMultiFileEdit: false,
	};
}

/** Build the ContextItem for a single toolResult message, for direct unit testing. */
export function buildToolResultContextItem(
	message: ToolResultMessage,
	messageIndex: number,
	options: ContextAuditOptions,
): ContextItem {
	return buildToolOutputItem(message, messageIndex, options).item;
}

/**
 * Read-only audit pass: converts live toolResult messages into ContextItems and runs the
 * existing pure retention/hard-constraint evaluators over them. Never mutates `messages`,
 * the transcript, or artifact references -- deterministic given the same messages,
 * `turnIndex`, and artifact-store state (not a cross-turn stability guarantee: turnIndex
 * and artifact-backed createdAtTurn values are expected to change turn over turn).
 */
export function runContextAudit(messages: AgentMessage[], options: ContextAuditOptions): ContextAuditReport {
	const items: ContextAuditItemReport[] = [];
	messages.forEach((message, messageIndex) => {
		if (message.role !== "toolResult") return;
		const built = buildToolOutputItem(message, messageIndex, options);
		const features = buildPolicyFeatures(built.item, built, options.turnIndex);
		const flags = buildHardConstraintFlags(built, options.artifactStore !== undefined);
		items.push({
			item: built.item,
			toolCallId: message.toolCallId,
			messageIndex,
			retention: evaluateRetentionEligibility(built.item),
			keepRawHardConstraints: evaluateHardConstraints("keep_raw", features, flags),
			packToArtifactHardConstraints: evaluateHardConstraints("pack_to_artifact", features, flags),
			dropFromPromptHardConstraints: evaluateHardConstraints("drop_from_prompt", features, flags),
			summarizeHardConstraints: evaluateHardConstraints("summarize", features, flags),
		});
	});
	return { turnIndex: options.turnIndex, items };
}
