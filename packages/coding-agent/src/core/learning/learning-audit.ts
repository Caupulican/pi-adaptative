import type { LearningDecision } from "../autonomy/contracts.ts";
import type { SessionEntry, SessionManager } from "../session-manager.ts";
import type { DurableChangeLayer, DurableChangeProposal } from "./learning-gate.ts";
import type { ReflectionWrite } from "./reflection-engine.ts";

/**
 * Audit + rollback metadata for durable learning changes. Every reflection-sourced write that the
 * learning policy applies (or converts to a proposal) leaves one of these records in the session
 * log, so `/autonomy diagnostics` can explain what changed, why, and how to undo it — and
 * `rollbackLearningWrite` can execute the inverse operation.
 */

export type LearningRollbackKind = "memory_remove" | "memory_restore" | "memory_add" | "archive_skill";

export interface LearningRollbackPlan {
	kind: LearningRollbackKind;
	/** Text currently present because of the change (to remove/replace), or the skill name to archive. */
	target?: string;
	/** Original text to restore (memory_restore/memory_add). */
	previous?: string;
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
const ROLLBACK_KINDS: readonly string[] = ["memory_remove", "memory_restore", "memory_add", "archive_skill"];
const LAYERS: readonly string[] = ["memory", "skill", "prompt", "extension", "tool", "script", "settings", "source"];

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function isLearningRollbackPlan(value: unknown): value is LearningRollbackPlan {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const plan = value as Record<string, unknown>;
	if (typeof plan.kind !== "string" || !ROLLBACK_KINDS.includes(plan.kind)) return false;
	if (!isOptionalString(plan.target) || !isOptionalString(plan.previous)) return false;
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

export interface LearningAuditSnapshotPayload {
	version: 1;
	record: LearningAuditRecord;
}

export function appendLearningAuditSnapshot(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	record: LearningAuditRecord,
): string {
	const payload: LearningAuditSnapshotPayload = {
		version: 1,
		record: cloneLearningAuditRecordForStorage(record),
	};
	return sessionManager.appendCustomEntry(LEARNING_AUDIT_CUSTOM_TYPE, payload);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

export function getLearningAuditSnapshots(entries: readonly SessionEntry[]): LearningAuditRecord[] {
	const records: LearningAuditRecord[] = [];

	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== LEARNING_AUDIT_CUSTOM_TYPE) {
			continue;
		}

		const payload = entry.data;
		if (!isPlainRecord(payload)) continue;
		if (payload.version !== 1) continue;
		if (!("record" in payload)) continue;
		const record = payload.record;
		if (isLearningAuditRecord(record)) {
			records.push(cloneLearningAuditRecordForStorage(record));
		}
	}

	return records;
}
