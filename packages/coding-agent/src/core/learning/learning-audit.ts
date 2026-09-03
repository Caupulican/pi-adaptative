import type { SessionEntry, SessionManager } from "@caupulican/pi-agent-core/node";
import type { LearningDecision } from "../autonomy/contracts.ts";
import {
	appendSessionSnapshot,
	getSessionSnapshots,
	type SessionSnapshotCodec,
	type SessionSnapshotPayload,
} from "../session-snapshot.ts";
import type { DurableChangeLayer, DurableChangeProposal } from "./learning-gate.ts";
import type { ReflectionWrite } from "./reflection-engine.ts";

/**
 * Audit + rollback metadata for durable learning changes. Every reflection-sourced write that the
 * learning policy applies (or converts to a proposal) leaves one of these records in the session
 * log, so `/autonomy diagnostics` can explain what changed, why, and how to undo it — and
 * `rollbackLearningWrite` can execute the inverse operation.
 */

export type LearningRollbackKind =
	| "memory_remove"
	| "memory_restore"
	| "memory_add"
	| "okf_remove"
	| "okf_organize"
	| "archive_skill";

export interface LearningRollbackPlan {
	kind: LearningRollbackKind;
	/** Text currently present because of the change (to remove/replace), or the skill name to archive. */
	target?: string;
	/** Original text to restore (memory_restore/memory_add). */
	previous?: string;
	/** Organization rollback only: the hot file `previous` was removed from; absent means the general file. */
	previousTarget?: "memory" | "project";
	/** Compare-and-delete guard for a structured record created by this exact audited write. */
	expectedDigest?: string;
	/** Organization rollback only: false when the OKF record predated this hot-memory move. */
	removeOkf?: boolean;
	instructions: string;
}

// "apply_failed" is distinct from "apply": the gate decided to apply, but the underlying write tool
// (e.g. the memory tool) refused it (budget exceeded, drift, threat) without throwing. It must never
// be treated as "apply" by a rollback-eligibility check — there is nothing durable to undo.
export type LearningAuditAction = "apply" | "apply_failed" | "propose" | "rollback";

/** reasonCode for an "apply_failed" audit — distinct from the gate's own reasonCode (e.g.
 * "eligible_auto_apply") so the record is honest about WHERE it stopped: the gate approved the
 * write, but the write tool refused it after the fact. */
export const APPLY_WRITE_REFUSED_REASON_CODE = "apply_write_refused";

export interface LearningAuditRecord {
	id: string;
	proposalId: string;
	layer: DurableChangeLayer;
	action: LearningAuditAction;
	summary: string;
	reasonCode: string;
	decision: LearningDecision;
	rollback?: LearningRollbackPlan;
	/** For action "rollback": the audit id of the applied change this record undoes. */
	rollbackOf?: string;
	createdAt: string;
}

function describeWrite(write: ReflectionWrite): string {
	switch (write.kind) {
		case "memory_add":
			return `Add ${write.section} memory: ${write.text}`;
		case "okf_add":
			return `Add OKF ${write.type}: ${write.title}`;
		case "okf_organize":
			return `Organize MEMORY fact into OKF ${write.type}: ${write.title}`;
		case "memory_replace":
			return `Replace memory "${write.target}" with "${write.text}"`;
		case "memory_remove":
			return `Remove memory: ${write.target}`;
		case "promote_skill":
			return `Promote skill "${write.name}": ${write.description}`;
	}
}

export function proposalFromReflectionWrite(write: ReflectionWrite, proposalId: string): DurableChangeProposal {
	return {
		id: proposalId,
		layer: write.kind === "promote_skill" ? "skill" : "memory",
		summary: describeWrite(write),
		rollbackPlan: rollbackPlanForReflectionWrite(write).instructions,
	};
}

/**
 * Contradiction count a reflection write carries against existing durable knowledge. A
 * `memory_replace`/`memory_remove` is only emitted when the reflection engine CONFRONTS an existing
 * fact (it supersedes or deletes it) — that supersession is the gate's contradiction signal, so such
 * a write must route through approval rather than silently overwriting prior memory. A `memory_add`
 * or `promote_skill` is purely additive and contradicts nothing.
 */
export function contradictionsForReflectionWrite(write: ReflectionWrite): number {
	switch (write.kind) {
		case "memory_replace":
		case "memory_remove":
			return 1;
		case "memory_add":
		case "okf_add":
		case "okf_organize":
		case "promote_skill":
			return 0;
	}
}

export function rollbackPlanForReflectionWrite(write: ReflectionWrite): LearningRollbackPlan {
	switch (write.kind) {
		case "memory_add":
			return {
				kind: "memory_remove",
				target: write.text,
				instructions: `Remove the added ${write.section} memory text.`,
			};
		case "okf_add":
			return {
				kind: "okf_remove",
				target: `${write.type}\0${write.title}`,
				instructions: "Remove the added structured OKF memory record.",
			};
		case "okf_organize":
			return {
				kind: "okf_organize",
				target: `${write.type}\0${write.title}`,
				previous: write.sourceText,
				removeOkf: true,
				instructions: "Restore the exact hot-memory source first, then remove only the audited OKF record.",
			};
		case "memory_replace":
			return {
				kind: "memory_restore",
				target: write.text,
				previous: write.target,
				instructions: "Replace the new memory text with the original text it overwrote.",
			};
		case "memory_remove":
			return {
				kind: "memory_add",
				previous: write.target,
				instructions: "Re-add the removed text to the MEMORY file (it may originally have lived in USER).",
			};
		case "promote_skill":
			return {
				kind: "archive_skill",
				target: write.name,
				instructions: "Archive the promoted skill so it no longer loads.",
			};
	}
}

const AUDIT_ACTIONS: readonly string[] = ["apply", "apply_failed", "propose", "rollback"];
const ROLLBACK_KINDS: readonly string[] = [
	"memory_remove",
	"memory_restore",
	"memory_add",
	"okf_remove",
	"okf_organize",
	"archive_skill",
];
const LAYERS: readonly string[] = ["memory", "skill", "prompt", "extension", "tool", "script", "settings", "source"];

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function isLearningRollbackPlan(value: unknown): value is LearningRollbackPlan {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const plan = value as Record<string, unknown>;
	if (typeof plan.kind !== "string" || !ROLLBACK_KINDS.includes(plan.kind)) return false;
	if (!isOptionalString(plan.target) || !isOptionalString(plan.previous)) return false;
	if (plan.previousTarget !== undefined && plan.previousTarget !== "memory" && plan.previousTarget !== "project") {
		return false;
	}
	if (!isOptionalString(plan.expectedDigest)) return false;
	if (plan.removeOkf !== undefined && typeof plan.removeOkf !== "boolean") return false;
	return typeof plan.instructions === "string";
}

function isLearningDecisionShape(value: unknown): value is LearningDecision {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const decision = value as Record<string, unknown>;
	return (
		(decision.kind === "no-op" || decision.kind === "proposal" || decision.kind === "apply") &&
		typeof decision.reasonCode === "string" &&
		typeof decision.confidence === "number" &&
		typeof decision.summary === "string" &&
		typeof decision.requiresApproval === "boolean"
	);
}

export function isLearningAuditRecord(value: unknown): value is LearningAuditRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (typeof record.id !== "string" || record.id.length === 0) return false;
	if (typeof record.proposalId !== "string") return false;
	if (typeof record.layer !== "string" || !LAYERS.includes(record.layer)) return false;
	if (typeof record.action !== "string" || !AUDIT_ACTIONS.includes(record.action)) return false;
	if (typeof record.summary !== "string" || typeof record.reasonCode !== "string") return false;
	if (!isLearningDecisionShape(record.decision)) return false;
	if (record.rollback !== undefined && !isLearningRollbackPlan(record.rollback)) return false;
	if (!isOptionalString(record.rollbackOf)) return false;
	return typeof record.createdAt === "string";
}

export function cloneLearningAuditRecordForStorage(record: LearningAuditRecord): LearningAuditRecord {
	return {
		...record,
		decision: { ...record.decision },
		...(record.rollback ? { rollback: { ...record.rollback } } : {}),
	};
}

export const LEARNING_AUDIT_CUSTOM_TYPE = "learning_audit";

export type LearningAuditSnapshotPayload = SessionSnapshotPayload<"record", LearningAuditRecord>;

const LEARNING_AUDIT_SNAPSHOT_CODEC: SessionSnapshotCodec<LearningAuditRecord, "record"> = {
	customType: LEARNING_AUDIT_CUSTOM_TYPE,
	valueKey: "record",
	isValue: isLearningAuditRecord,
	clone: cloneLearningAuditRecordForStorage,
};

export function appendLearningAuditSnapshot(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	record: LearningAuditRecord,
): string {
	return appendSessionSnapshot(sessionManager, LEARNING_AUDIT_SNAPSHOT_CODEC, record);
}

export function getLearningAuditSnapshots(entries: readonly SessionEntry[]): LearningAuditRecord[] {
	return getSessionSnapshots(entries, LEARNING_AUDIT_SNAPSHOT_CODEC);
}
