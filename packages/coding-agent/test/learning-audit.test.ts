import { describe, expect, it } from "vitest";
import {
	appendLearningAuditSnapshot,
	getLearningAuditSnapshots,
	isLearningAuditRecord,
	LEARNING_AUDIT_CUSTOM_TYPE,
	type LearningAuditRecord,
	proposalFromReflectionWrite,
	rollbackPlanForReflectionWrite,
} from "../src/core/learning/learning-audit.ts";
import type { ReflectionWrite } from "../src/core/learning/reflection-engine.ts";
import { SessionManager } from "../src/core/session-manager.ts";

function auditRecord(overrides: Partial<LearningAuditRecord> = {}): LearningAuditRecord {
	return {
		id: "audit-1",
		proposalId: "p-1",
		layer: "memory",
		action: "apply",
		summary: "Add MEMORY memory: run checks",
		reasonCode: "eligible_auto_apply",
		decision: {
			kind: "apply",
			reasonCode: "eligible_auto_apply",
			confidence: 95,
			summary: "Add MEMORY memory: run checks",
			requiresApproval: false,
		},
		rollback: { kind: "memory_remove", target: "run checks", instructions: "Remove the added MEMORY memory text." },
		createdAt: "2026-07-01T00:00:00.000Z",
		...overrides,
	};
}

describe("proposalFromReflectionWrite / rollbackPlanForReflectionWrite", () => {
	it("derives a memory proposal with an inverse remove for memory_add", () => {
		const write: ReflectionWrite = { kind: "memory_add", section: "MEMORY", text: "Always run npm run check" };
		const proposal = proposalFromReflectionWrite(write, "p-1");
		expect(proposal).toMatchObject({ id: "p-1", layer: "memory" });
		expect(proposal.summary).toContain("Always run npm run check");
		expect(proposal.rollbackPlan).toBeTruthy();

		const rollback = rollbackPlanForReflectionWrite(write);
		expect(rollback.kind).toBe("memory_remove");
		expect(rollback.target).toBe("Always run npm run check");
	});

	it("derives a restore rollback for memory_replace", () => {
		const write: ReflectionWrite = { kind: "memory_replace", target: "old fact", text: "new fact" };
		const rollback = rollbackPlanForReflectionWrite(write);
		expect(rollback.kind).toBe("memory_restore");
		expect(rollback.target).toBe("new fact");
		expect(rollback.previous).toBe("old fact");
	});

	it("derives an add-back rollback for memory_remove", () => {
		const write: ReflectionWrite = { kind: "memory_remove", target: "stale fact" };
		const rollback = rollbackPlanForReflectionWrite(write);
		expect(rollback.kind).toBe("memory_add");
		expect(rollback.previous).toBe("stale fact");
	});

	it("derives a skill proposal with an archive rollback for promote_skill", () => {
		const write: ReflectionWrite = { kind: "promote_skill", name: "release-flow", description: "d", body: "b" };
		const proposal = proposalFromReflectionWrite(write, "p-2");
		expect(proposal.layer).toBe("skill");

		const rollback = rollbackPlanForReflectionWrite(write);
		expect(rollback.kind).toBe("archive_skill");
		expect(rollback.target).toBe("release-flow");
	});
});

describe("isLearningAuditRecord", () => {
	it("accepts valid records and rejects malformed ones", () => {
		expect(isLearningAuditRecord(auditRecord())).toBe(true);
		expect(isLearningAuditRecord(auditRecord({ rollback: undefined }))).toBe(true);
		expect(isLearningAuditRecord(undefined)).toBe(false);
		expect(isLearningAuditRecord(auditRecord({ action: "undo" as never }))).toBe(false);
		expect(isLearningAuditRecord(auditRecord({ layer: "firmware" as never }))).toBe(false);
		expect(isLearningAuditRecord({ ...auditRecord(), decision: { kind: "apply" } })).toBe(false);
	});
});

describe("session learning audit snapshots", () => {
	it("round-trips records and skips malformed payloads", () => {
		const sessionManager = SessionManager.inMemory();

		appendLearningAuditSnapshot(sessionManager, auditRecord());
		sessionManager.appendCustomEntry(LEARNING_AUDIT_CUSTOM_TYPE, { version: 2, record: auditRecord() });
		sessionManager.appendCustomEntry(LEARNING_AUDIT_CUSTOM_TYPE, "malformed");
		appendLearningAuditSnapshot(
			sessionManager,
			auditRecord({ id: "audit-1-rollback", action: "rollback", rollbackOf: "audit-1", rollback: undefined }),
		);

		const records = getLearningAuditSnapshots(sessionManager.getEntries());
		expect(records).toHaveLength(2);
		expect(records[0]?.id).toBe("audit-1");
		expect(records[1]?.action).toBe("rollback");
		expect(records[1]?.rollbackOf).toBe("audit-1");

		records[0]!.summary = "mutated";
		expect(getLearningAuditSnapshots(sessionManager.getEntries())[0]?.summary).toContain("run checks");
	});
});
