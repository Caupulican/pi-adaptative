import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { SessionManager } from "../../kernel/session/session-manager.ts";
import { PI_OKF_TYPES, type PiOkfType } from "../context/okf-memory.ts";
import { KeyedSingleFlight } from "../models/runtime-operation-coordinator.ts";
import { classifyCustomEntryPersisted, MAX_PERSISTED_CUSTOM_ENTRY_BYTES } from "../session-entry-persistence.ts";
import { isSessionAppendAnchorCurrent, type SessionAppendAnchor } from "../session-snapshot.ts";
import { hasOnlyKeys, isPlainRecord } from "../util/value-guards.ts";
import {
	createLearningAuditId,
	getLearningAuditSnapshots,
	isLearningAuditRecord,
	LEARNING_AUDIT_CUSTOM_TYPE,
	type LearningAuditRecord,
	type LearningRollbackPlan,
} from "./learning-audit.ts";

export type PreparedLearningRollback =
	| { kind: "memory_remove"; target: string }
	| { kind: "memory_restore"; target: string; previous: string }
	| { kind: "memory_add"; previous: string; section: "USER" | "MEMORY" }
	| { kind: "archive_skill"; target: string }
	| { kind: "okf_remove" | "okf_organize"; type: PiOkfType; title: string; plan: LearningRollbackPlan };

export interface LearningRollbackResult {
	ok: boolean;
	reason: string;
}

interface RollbackSnapshot {
	version: 1;
	operationId: string;
	auditId: string;
	auditDigest: string;
	anchor: SessionAppendAnchor;
	phase: "intent" | "applied" | "unknown";
	receipt: LearningAuditRecord;
}

interface RetainedRollback {
	manager: SessionManager;
	snapshot: RollbackSnapshot;
	stage: "prepared" | "unknown" | "applied";
	intentEntryId?: string;
	appliedEntryId?: string;
	receiptEntryId?: string;
}

export interface LearningRollbackControllerDeps {
	getSessionManager(): SessionManager;
	isDisposed(): boolean;
	getContextGeneration?(): number;
	execute(rollback: PreparedLearningRollback): Promise<LearningRollbackResult>;
	warn?(message: string): void;
}

const ROLLBACK_CUSTOM_TYPE = "learning_rollback";
const MAX_PENDING_ROLLBACKS = 64;
// Reserve room for the session entry envelope within the shared physical-row reader's bound.
const MAX_SNAPSHOT_BYTES = MAX_PERSISTED_CUSTOM_ENTRY_BYTES - 1024;

function prepareRollback(plan: LearningRollbackPlan): PreparedLearningRollback | undefined {
	switch (plan.kind) {
		case "memory_remove":
		case "archive_skill":
			return plan.target ? { kind: plan.kind, target: plan.target } : undefined;
		case "memory_restore":
			return plan.target && plan.previous !== undefined
				? { kind: plan.kind, target: plan.target, previous: plan.previous }
				: undefined;
		case "memory_add":
			return plan.previous !== undefined
				? { kind: plan.kind, previous: plan.previous, section: plan.previousTarget === "user" ? "USER" : "MEMORY" }
				: undefined;
		case "okf_remove":
		case "okf_organize": {
			if (!plan.target || (plan.kind === "okf_organize" && plan.previous === undefined)) return undefined;
			const separator = plan.target.indexOf("\0");
			if (separator <= 0 || separator === plan.target.length - 1) return undefined;
			const type = plan.target.slice(0, separator);
			if (!PI_OKF_TYPES.includes(type as PiOkfType)) return undefined;
			return { kind: plan.kind, type: type as PiOkfType, title: plan.target.slice(separator + 1), plan };
		}
	}
}

function auditDigest(audit: LearningAuditRecord): string {
	return createHash("sha256").update(JSON.stringify(audit)).digest("hex");
}

function rollbackReceipt(audit: LearningAuditRecord, id: string, createdAt: string): LearningAuditRecord {
	return {
		id,
		proposalId: audit.proposalId,
		layer: audit.layer,
		action: "rollback",
		summary: `Rolled back: ${audit.summary}`,
		reasonCode: "user_requested_rollback",
		decision: audit.decision,
		rollbackOf: audit.id,
		createdAt,
	};
}

function canonicalSnapshot(value: RollbackSnapshot): RollbackSnapshot {
	const serialized = JSON.stringify(value);
	if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES)
		throw new Error("Rollback record exceeds its byte bound");
	return JSON.parse(serialized) as RollbackSnapshot;
}

function parseSnapshot(value: unknown): RollbackSnapshot {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, ["version", "operationId", "auditId", "auditDigest", "anchor", "phase", "receipt"]) ||
		value.version !== 1 ||
		typeof value.operationId !== "string" ||
		value.operationId.length > 128 ||
		!value.operationId ||
		typeof value.auditId !== "string" ||
		!value.auditId ||
		typeof value.auditDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.auditDigest) ||
		!isPlainRecord(value.anchor) ||
		!hasOnlyKeys(value.anchor, ["sessionId", "leafId"]) ||
		typeof value.anchor.sessionId !== "string" ||
		(value.anchor.leafId !== null && typeof value.anchor.leafId !== "string") ||
		(value.phase !== "intent" && value.phase !== "applied" && value.phase !== "unknown") ||
		!isLearningAuditRecord(value.receipt) ||
		value.receipt.action !== "rollback" ||
		value.receipt.rollbackOf !== value.auditId
	)
		throw new Error("Invalid learning rollback record");
	return canonicalSnapshot(value as unknown as RollbackSnapshot);
}

/** One execution permit per durable intent; publication retries never repeat an inverse. */
export class LearningRollbackController {
	private readonly deps: LearningRollbackControllerDeps;
	private readonly active = new KeyedSingleFlight<LearningRollbackResult>();
	private readonly retained = new Map<string, RetainedRollback>();

	constructor(deps: LearningRollbackControllerDeps) {
		this.deps = deps;
	}

	rollback(auditId: string): Promise<LearningRollbackResult> {
		return this.active.run(auditId, () => this.run(auditId));
	}

	private async run(auditId: string): Promise<LearningRollbackResult> {
		if (this.deps.isDisposed()) return { ok: false, reason: "session_disposed" };
		const manager = this.deps.getSessionManager();
		const generation = this.deps.getContextGeneration?.();
		try {
			const audits = getLearningAuditSnapshots(manager.getEntries());
			const matches = audits.filter((audit) => audit.id === auditId);
			if (matches.length > 1) return { ok: false, reason: "ambiguous_audit_id" };
			const audit = matches[0];
			if (!audit) return { ok: false, reason: "audit_not_found" };
			if (audit.action !== "apply") return { ok: false, reason: "not_an_applied_change" };
			for (const entry of manager.getEntries()) {
				if (entry.type !== "custom" || entry.customType !== LEARNING_AUDIT_CUSTOM_TYPE) continue;
				const receipt = getLearningAuditSnapshots([entry])[0];
				if (receipt?.action !== "rollback" || receipt.rollbackOf !== auditId) continue;
				if (audits.filter((candidate) => candidate.id === receipt.id).length !== 1)
					return { ok: false, reason: "ambiguous_audit_id" };
				if (!this.confirm(manager, entry.id, LEARNING_AUDIT_CUSTOM_TYPE, entry.data))
					return { ok: false, reason: "rollback_receipt_pending" };
				this.retained.delete(auditId);
				return { ok: false, reason: "already_rolled_back" };
			}
			if (!audit.rollback) return { ok: false, reason: "no_rollback_plan" };
			const prepared = prepareRollback(audit.rollback);
			if (!prepared) return { ok: false, reason: "invalid_rollback_plan" };
			const digest = auditDigest(audit);
			let retained = this.retained.get(auditId);
			if (!retained) {
				let previous: { snapshot: RollbackSnapshot; entryId: string } | undefined;
				let intentEntryId: string | undefined;
				for (const entry of manager.getEntries()) {
					if (entry.type !== "custom" || entry.customType !== ROLLBACK_CUSTOM_TYPE) continue;
					const snapshot = parseSnapshot(entry.data);
					if (snapshot.auditId !== auditId) continue;
					if (!previous) {
						if (snapshot.phase !== "intent") throw new Error("Learning rollback outcome has no preceding intent");
						intentEntryId = entry.id;
					}
					if (
						previous &&
						(!isDeepStrictEqual({ ...previous.snapshot, phase: snapshot.phase }, snapshot) ||
							(previous.snapshot.phase !== "intent" && previous.snapshot.phase !== snapshot.phase))
					)
						throw new Error("Conflicting learning rollback records");
					if (!manager.getBranch(entry.id).some((ancestor) => ancestor.id === intentEntryId))
						throw new Error("Learning rollback outcome left its intent branch");
					previous = { snapshot, entryId: entry.id };
				}
				if (previous && previous.snapshot.auditDigest !== digest)
					return { ok: false, reason: "rollback_audit_changed" };
				if (
					previous &&
					!isDeepStrictEqual(
						previous.snapshot.receipt,
						JSON.parse(
							JSON.stringify(
								rollbackReceipt(audit, previous.snapshot.receipt.id, previous.snapshot.receipt.createdAt),
							),
						),
					)
				)
					throw new Error("Learning rollback receipt does not match its source audit");
				if (previous && previous.snapshot.phase !== "applied")
					return { ok: false, reason: "rollback_outcome_unknown" };
				if (this.retained.size >= MAX_PENDING_ROLLBACKS) return { ok: false, reason: "rollback_journal_capacity" };
				const snapshot =
					previous?.snapshot ??
					canonicalSnapshot({
						version: 1,
						operationId: randomUUID(),
						auditId,
						auditDigest: digest,
						anchor: { sessionId: manager.getSessionId(), leafId: manager.getLeafId() },
						phase: "intent",
						receipt: rollbackReceipt(audit, createLearningAuditId(), new Date().toISOString()),
					});
				canonicalSnapshot({ ...snapshot, phase: "applied" });
				retained = {
					manager,
					snapshot,
					stage: previous ? "applied" : "prepared",
					...(previous ? { intentEntryId, appliedEntryId: previous.entryId } : {}),
				};
				this.retained.set(auditId, retained);
			}
			if (retained.manager !== manager || retained.snapshot.auditDigest !== digest)
				return { ok: false, reason: "rollback_audit_changed" };
			const current = (): boolean => {
				if (
					this.deps.isDisposed() ||
					this.deps.getSessionManager() !== manager ||
					this.deps.getContextGeneration?.() !== generation ||
					!isSessionAppendAnchorCurrent(manager, {
						...retained.snapshot.anchor,
						leafId: retained.intentEntryId ?? retained.snapshot.anchor.leafId,
					})
				)
					return false;
				const matching = getLearningAuditSnapshots(manager.getEntries()).filter(
					(candidate) => candidate.id === auditId,
				);
				return matching.length === 1 && auditDigest(matching[0]) === digest;
			};
			if (!current()) return { ok: false, reason: "rollback_context_changed" };
			if (audits.some((candidate) => candidate.id === retained.snapshot.receipt.id))
				throw new Error("Learning rollback receipt identity is already used");
			if (retained.stage === "unknown") return { ok: false, reason: "rollback_outcome_unknown" };
			if (retained.stage === "prepared") {
				retained.intentEntryId ??= manager.appendCustomEntry(ROLLBACK_CUSTOM_TYPE, retained.snapshot);
				if (!this.confirm(manager, retained.intentEntryId, ROLLBACK_CUSTOM_TYPE, retained.snapshot))
					return { ok: false, reason: "rollback_intent_pending" };
				if (!current()) return { ok: false, reason: "rollback_context_changed" };
				// Any false/throw may follow partial effects. Only a positive acknowledgement proves completion.
				retained.stage = "unknown";
				const result = await this.deps.execute(prepared);
				retained.stage = result.ok ? "applied" : "unknown";
				retained.snapshot = canonicalSnapshot({ ...retained.snapshot, phase: retained.stage });
				if (!result.ok) {
					this.deps.warn?.(
						`Learning rollback ${auditId} may have partial effects (${result.reason}); inspection is required.`,
					);
					return { ok: false, reason: "rollback_outcome_unknown" };
				}
			}
			if (!current()) return { ok: false, reason: "rollback_context_changed" };
			retained.appliedEntryId ??= manager.appendCustomEntry(ROLLBACK_CUSTOM_TYPE, retained.snapshot);
			if (!this.confirm(manager, retained.appliedEntryId, ROLLBACK_CUSTOM_TYPE, retained.snapshot))
				return { ok: false, reason: "rollback_receipt_pending" };
			if (!current()) return { ok: false, reason: "rollback_context_changed" };
			if (
				getLearningAuditSnapshots(manager.getEntries()).some(
					(candidate) => candidate.id === retained.snapshot.receipt.id,
				)
			)
				throw new Error("Learning rollback receipt identity is already used");
			retained.receiptEntryId ??= manager.appendCustomEntry(LEARNING_AUDIT_CUSTOM_TYPE, {
				version: 1,
				record: retained.snapshot.receipt,
			});
			if (
				!this.confirm(manager, retained.receiptEntryId, LEARNING_AUDIT_CUSTOM_TYPE, {
					version: 1,
					record: retained.snapshot.receipt,
				})
			)
				return { ok: false, reason: "rollback_receipt_pending" };
			if (!current()) return { ok: false, reason: "rollback_context_changed" };
			this.retained.delete(auditId);
			return { ok: true, reason: "rollback_applied" };
		} catch (error) {
			try {
				this.deps.warn?.(`Learning rollback remains unresolved: ${String(error).slice(0, 512)}`);
			} catch {
				/* Diagnostics do not grant replay. */
			}
			return {
				ok: false,
				reason:
					this.retained.get(auditId)?.stage === "unknown"
						? "rollback_outcome_unknown"
						: "rollback_journal_unavailable",
			};
		}
	}

	private confirm(manager: SessionManager, entryId: string, customType: string, data: unknown): boolean {
		if (!manager.isPersisted()) return true;
		const state = classifyCustomEntryPersisted(manager, entryId, customType, (stored) =>
			isDeepStrictEqual(stored, data),
		);
		if (state === "conflict") throw new Error("Learning rollback persistence conflicts with its intended record");
		return state === "persisted";
	}
}
