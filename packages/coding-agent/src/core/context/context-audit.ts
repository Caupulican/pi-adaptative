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

import type { ToolResultMessage } from "@caupulican/pi-ai";
import { countHistoryWork, inheritHistoryWork } from "@caupulican/pi-ai/history-work";
import type { AgentMessage } from "../../kernel/index.ts";
import {
	type MessageHistoryVersion,
	messageHistoryVersion,
	unchangedMessagePrefix,
} from "../../kernel/message-revision.ts";
import { type ArtifactStore, readArtifactRefs } from "./context-artifacts.ts";
import {
	type ContextArtifactRef,
	type ContextEvidenceRef,
	type ContextItem,
	estimateByteLength,
	estimateTokensFromText,
} from "./context-item.ts";
import { evaluateRetentionEligibility, type RetentionEligibility } from "./context-retention.ts";
import { getToolResultArtifactId, getToolResultText } from "./context-tool-result.ts";
import { evaluateHardConstraints } from "./policy-engine.ts";
import type { HardConstraintFlags, PolicyFeatures, PolicyHardConstraintCode } from "./policy-types.ts";
import type { SessionToolResultEntrySnapshot } from "./session-tool-result-entries.ts";

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

export interface BuiltToolOutputItem {
	item: ContextItem;
	/** True only if an artifact ref was found AND resolved against a live store. */
	hasResolvedArtifact: boolean;
}

interface ToolRow {
	toolCallId: string;
	toolName: string;
	messageIndex: number;
	artifactId: string | undefined;
	tokenEstimate: number;
	byteEstimate: number;
}

function measureToolResult(message: ToolResultMessage, messageIndex: number): ToolRow {
	const text = getToolResultText(message);
	return {
		toolCallId: message.toolCallId,
		toolName: message.toolName,
		messageIndex,
		artifactId: getToolResultArtifactId(message.details),
		tokenEstimate: estimateTokensFromText(text),
		byteEstimate: estimateByteLength(text),
	};
}

function buildToolOutputItem(
	row: ToolRow,
	turnIndex: number,
	artifact: ContextArtifactRef | undefined,
	sessionEntryId: string | undefined,
): BuiltToolOutputItem {
	const { messageIndex } = row;
	let primaryRef: ContextEvidenceRef | undefined = artifact && { type: "artifact", ref: { ...artifact } };
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
		id: `tool-output:${row.toolCallId}`,
		kind: "tool_output",
		retentionClass: "ephemeral",
		source: "tool",
		// Transcript-only items (no artifact ref) have no real creation-turn source threaded
		// in yet, so this falls back to the current audit turn as an approximation --
		// deliberately not left silently wrong: no evaluator reads createdAtTurn today, but
		// any future staleness/break-even math must use the real per-item value above, not
		// this fallback, once one exists for non-artifact items too.
		createdAtTurn: artifact?.createdAtTurn ?? turnIndex,
		summary: `${row.toolName} tool result`,
		primaryRef,
		evidenceRefs: evidenceRefs.length > 0 ? evidenceRefs : undefined,
		tokenEstimate: row.tokenEstimate,
		byteEstimate: row.byteEstimate,
	};

	return { item, hasResolvedArtifact: artifact !== undefined };
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
	const row = measureToolResult(message, messageIndex);
	return buildToolOutputItem(
		row,
		options.turnIndex,
		row.artifactId ? options.artifactStore?.readRef(row.artifactId) : undefined,
		options.sessionEntryIdForToolCallId?.(row.toolCallId),
	).item;
}

function evaluateRow(
	row: ToolRow,
	built: BuiltToolOutputItem,
	turnIndex: number,
	storeAvailable: boolean,
): ContextAuditItemReport {
	const { item } = built;
	const features = buildPolicyFeatures(item, built, turnIndex);
	const flags = buildHardConstraintFlags(built, storeAvailable);
	return {
		item,
		toolCallId: row.toolCallId,
		messageIndex: row.messageIndex,
		retention: evaluateRetentionEligibility(item),
		keepRawHardConstraints: evaluateHardConstraints("keep_raw", features, flags),
		packToArtifactHardConstraints: evaluateHardConstraints("pack_to_artifact", features, flags),
		dropFromPromptHardConstraints: evaluateHardConstraints("drop_from_prompt", features, flags),
		summarizeHardConstraints: evaluateHardConstraints("summarize", features, flags),
	};
}

interface AuditIndex {
	rows: ToolRow[];
	artifactIds: Set<string>;
}

function emptyIndex(): AuditIndex {
	return { rows: [], artifactIds: new Set() };
}

function appendRow(index: AuditIndex, row: ToolRow): void {
	index.rows.push(row);
	if (row.artifactId) index.artifactIds.add(row.artifactId);
}

/** A rewrite gets its own index so earlier reports keep their ordering and extent. */
function forkIndex(index: AuditIndex, unchanged: number): AuditIndex {
	const fork = emptyIndex();
	for (const row of index.rows) {
		if (row.messageIndex >= unchanged) break;
		appendRow(fork, row);
	}
	return fork;
}

function indexSuffix(
	index: AuditIndex,
	messages: readonly AgentMessage[],
	start: number,
	offset = 0,
	workOwner = messages,
): void {
	countHistoryWork(workOwner, "auditSourceRowsVisited", messages.length - start);
	// Measure before publishing. A malformed tool result must not leave a partially appended index on retry.
	const appended: ToolRow[] = [];
	for (let i = start; i < messages.length; i++) {
		const message = messages[i];
		if (message.role === "toolResult") appended.push(measureToolResult(message, offset + i));
	}
	for (const row of appended) appendRow(index, row);
}

const policyRows = new WeakMap<ContextAuditReport, () => ContextAuditItemReport[]>();

/** Internal policy projections must be independent of edits to published debug rows. */
export function auditItemsForPolicy(report: ContextAuditReport): readonly ContextAuditItemReport[] {
	return policyRows.get(report)?.() ?? report.items;
}

/** Capture external metadata now. Lazy readers must see the store and transcript as of this request. */
function captureReport(
	index: AuditIndex,
	messages: readonly AgentMessage[],
	{ turnIndex, artifactStore, sessionEntryIdForToolCallId }: ContextAuditOptions,
	defer: boolean,
	transients?: readonly AgentMessage[],
): ContextAuditReport {
	const segments = [{ index, end: index.rows.length }];
	let artifactIds = index.artifactIds;
	if (transients?.length) {
		const tail = emptyIndex();
		indexSuffix(tail, transients, 0, messages.length, messages);
		segments.push({ index: tail, end: tail.rows.length });
		if (artifactStore && tail.artifactIds.size) {
			artifactIds = new Set(index.artifactIds);
			for (const id of tail.artifactIds) artifactIds.add(id);
		}
	}
	const storeAvailable = artifactStore !== undefined;
	const artifacts = artifactStore && artifactIds.size ? readArtifactRefs(artifactStore, artifactIds) : undefined;
	if (artifacts) countHistoryWork(messages, "auditArtifactRefsChecked", artifactIds.size);
	let canonical: ContextAuditItemReport[] | undefined;
	function materialize(): ContextAuditItemReport[] {
		if (canonical) return canonical;
		const result: ContextAuditItemReport[] = [];
		for (const { index, end } of segments) {
			countHistoryWork(report, "auditRowsMaterialized", end);
			for (let i = 0; i < end; i++) {
				const row = index.rows[i];
				const artifact = row.artifactId ? artifacts?.get(row.artifactId) : undefined;
				const built = buildToolOutputItem(row, turnIndex, artifact, sessionEntryIdForToolCallId?.(row.toolCallId));
				result.push(evaluateRow(row, built, turnIndex, storeAvailable));
			}
		}
		canonical = result;
		return canonical;
	}
	let published: ContextAuditItemReport[] | undefined;
	const report: ContextAuditReport = {
		turnIndex,
		get items() {
			published ??= structuredClone(materialize());
			return published;
		},
	};
	inheritHistoryWork(messages, report);
	policyRows.set(report, materialize);
	if (!defer) materialize();
	return report;
}

/** Full, independent recomputation for explicit diagnostics and caller-owned inputs. */
export function runContextAudit(messages: readonly AgentMessage[], options: ContextAuditOptions): ContextAuditReport {
	const index = emptyIndex();
	indexSuffix(index, messages, 0);
	return captureReport(index, messages, options, false);
}

/** Request-local reports share measured immutable tool facts up to the captured row count. */
export class ContextAuditHistory {
	private index = emptyIndex();
	private version: MessageHistoryVersion | undefined;
	private length = 0;

	capture(
		messages: readonly AgentMessage[],
		options: Omit<ContextAuditOptions, "sessionEntryIdForToolCallId">,
		sessionEntries?: SessionToolResultEntrySnapshot,
		transients?: readonly AgentMessage[],
	): ContextAuditReport {
		const version = messageHistoryVersion(messages);
		const snapshotOptions = { ...options, sessionEntryIdForToolCallId: sessionEntries?.resolve };
		if (!version) {
			this.clear();
			const index = emptyIndex();
			countHistoryWork(messages, "oldRowsRead", messages.length);
			indexSuffix(index, messages, 0);
			return captureReport(index, messages, snapshotOptions, true, transients);
		}
		const unchanged = this.version ? unchangedMessagePrefix(this.version, version) : 0;
		const start = Math.min(unchanged, this.length);
		const index = start < this.length ? forkIndex(this.index, start) : this.index;
		if (start < this.length)
			countHistoryWork(messages, "oldRowsRead", index.rows.length + Math.min(this.length, messages.length) - start);
		indexSuffix(index, messages, start);
		this.version = version;
		this.length = messages.length;
		this.index = index;
		return captureReport(index, messages, snapshotOptions, true, transients);
	}

	clear(): void {
		this.index = emptyIndex();
		this.version = undefined;
		this.length = 0;
	}
}
