/**
 * Observe-first shadow/planning layer, one step closer to prompt construction than
 * context-audit.ts (Phase 1). This module re-shapes an already-computed `ContextAuditReport`
 * into a deterministic per-item policy plan, and can correlate that plan against the
 * legacy context-gc's actual packed records. It never enforces anything: `appliedAction` is
 * a literal `"keep_raw"` on every item -- the type itself makes it impossible for this
 * module to report having changed prompt behavior. Nothing here mutates messages, the
 * transcript, or artifact references; it only reads an already-computed report.
 *
 * Single source of truth for feature/flag construction remains context-audit.ts
 * (`buildPolicyFeatures`/`buildHardConstraintFlags`): this module reuses the hard-constraint
 * codes already computed there rather than reconstructing them, so there is exactly one
 * place that decides how a tool_output item's PolicyFeatures/HardConstraintFlags are built.
 */

import type { ContextGcPackedRecord, ContextGcReport } from "../context-gc.ts";
import type { ContextAuditReport } from "./context-audit.ts";
import type { ContextEvidenceRef, ContextItemKind, ContextRetentionClass, ContextSource } from "./context-item.ts";
import type { RetentionAction } from "./context-retention.ts";
import type { PolicyHardConstraintCode } from "./policy-types.ts";

export interface PromptPolicyHardConstraints {
	keepRaw: PolicyHardConstraintCode[];
	packToArtifact: PolicyHardConstraintCode[];
	dropFromPrompt: PolicyHardConstraintCode[];
	summarize: PolicyHardConstraintCode[];
}

export interface PromptPolicyItemReport {
	itemId: string;
	kind: ContextItemKind;
	retentionClass: ContextRetentionClass;
	source: ContextSource;
	toolCallId: string;
	messageIndex: number;
	primaryRefType: ContextEvidenceRef["type"] | undefined;
	/**
	 * True only for a resolved artifact ref, never for a transcript ref -- the same
	 * fail-closed resolved-artifact-only rule context-audit.ts uses (a transcript ref is
	 * provenance, not a live retrieval mechanism; see that module's doc comment).
	 */
	hasAvailableRetrievalPath: boolean;
	/** Coarse, store-free eligibility from context-retention.ts (treats any ref as retrievable). */
	allowedRetentionActions: RetentionAction[];
	hardConstraints: PromptPolicyHardConstraints;
	/**
	 * This shadow/planning pass never changes behavior: the applied action is always
	 * "keep_raw", regardless of what the hard-constraint/retention analysis above would
	 * otherwise allow. Typed as a literal so nothing here can ever report applying anything
	 * else.
	 */
	appliedAction: "keep_raw";
}

export interface PromptPolicyShadowReport {
	turnIndex: number;
	items: PromptPolicyItemReport[];
}

/**
 * Deterministic re-shaping of an audit report into the shadow policy plan shape. Pure: no
 * I/O, no mutation, given the same audit report this always returns an equal result.
 */
export function planPromptPolicy(auditReport: ContextAuditReport): PromptPolicyShadowReport {
	return {
		turnIndex: auditReport.turnIndex,
		items: auditReport.items.map((entry) => ({
			itemId: entry.item.id,
			kind: entry.item.kind,
			retentionClass: entry.item.retentionClass,
			source: entry.item.source,
			toolCallId: entry.toolCallId,
			messageIndex: entry.messageIndex,
			primaryRefType: entry.item.primaryRef?.type,
			hasAvailableRetrievalPath: entry.item.primaryRef?.type === "artifact",
			allowedRetentionActions: entry.retention.allowedActions,
			hardConstraints: {
				keepRaw: entry.keepRawHardConstraints,
				packToArtifact: entry.packToArtifactHardConstraints,
				dropFromPrompt: entry.dropFromPromptHardConstraints,
				summarize: entry.summarizeHardConstraints,
			},
			appliedAction: "keep_raw",
		})),
	};
}

export interface PromptPolicyGcCorrelationEntry {
	itemId: string;
	toolCallId: string;
	/** True if the legacy context-gc pass actually packed this item's tool result this turn. */
	actuallyPackedByLegacyGc: boolean;
	gcPackReason?: ContextGcPackedRecord["reason"];
	/** True if the shadow plan's pack_to_artifact hard constraints did not reject packing. */
	policyWouldAllowPack: boolean;
	/** True if the shadow plan's drop_from_prompt hard constraints did not reject dropping. */
	policyWouldAllowDrop: boolean;
}

export interface PromptPolicyGcCorrelationReport {
	turnIndex: number;
	entries: PromptPolicyGcCorrelationEntry[];
}

/**
 * Report-only correlation between the shadow plan and what the legacy context-gc pass
 * actually did this turn. Does not influence context-gc in any way -- it runs after gc has
 * already produced its report, purely to observe what each side did/would do.
 *
 * Deliberately does not derive an "agrees with legacy gc" boolean: legacy context-gc
 * "packing" summarizes/stubs a tool result in place (provider-visible content shrinks in
 * place), while the policy action `pack_to_artifact` means artifact-backed capture and
 * out-of-band retrieval -- a different operation with different semantics, not a
 * calibrated equivalent. Collapsing them into one "agreement" boolean would overclaim
 * semantic agreement between the two and risk a later enforcement slice mistaking this
 * observe-only diagnostic for a calibrated authority. The raw booleans below are reported
 * as-is; comparing them is left to the reader.
 */
export function correlateWithContextGc(
	shadowReport: PromptPolicyShadowReport,
	gcReport: ContextGcReport,
): PromptPolicyGcCorrelationReport {
	const packedByToolCallId = new Map<string, ContextGcPackedRecord>();
	for (const record of gcReport.records) packedByToolCallId.set(record.toolCallId, record);

	const entries: PromptPolicyGcCorrelationEntry[] = shadowReport.items.map((item) => {
		const gcRecord = packedByToolCallId.get(item.toolCallId);
		return {
			itemId: item.itemId,
			toolCallId: item.toolCallId,
			actuallyPackedByLegacyGc: gcRecord !== undefined,
			gcPackReason: gcRecord?.reason,
			policyWouldAllowPack: item.hardConstraints.packToArtifact.length === 0,
			policyWouldAllowDrop: item.hardConstraints.dropFromPrompt.length === 0,
		};
	});

	return { turnIndex: shadowReport.turnIndex, entries };
}
