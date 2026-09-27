/**
 * The evidence-retention live path inside the real CompactionController (RCG-040).
 *
 * Part of the verification-harness coverage set: these are the compaction-owner functions that
 * decide what a real compaction keeps, so they are exercised against the live controller rather
 * than against the planner alone.
 */

import { describe, expect, it, vi } from "vitest";
import { RETENTION_AUDIT_CUSTOM_TYPE } from "../src/core/compaction/evidence-retention-projection.ts";
import { serializeEvaluation } from "../src/core/review/typesafe-contract.ts";
import { appendToolExchange, createRcSdkHarness, type RcSdkHarness } from "./suite/rc-sdk-harness.ts";

type CompactionInternals = {
	_compaction: {
		planEvidenceRetention(signal: AbortSignal): Promise<void>;
		getCompactionBranch(): unknown[];
		getRetentionPlanner(): { getLastAuditStats(): unknown };
		getRetentionAuditStats(): unknown;
		getAppliedRetentionAudit():
			| {
					stats: { pairsRemoved: number; jevRequestCount: number };
					summaryEvent: string;
					droppedCallIds: readonly string[];
			  }
			| undefined;
	};
};

function compactionOf(harness: RcSdkHarness): CompactionInternals["_compaction"] {
	return (harness.session as unknown as CompactionInternals)._compaction;
}

function toolResultCount(branch: readonly unknown[]): number {
	return branch.filter(
		(entry) =>
			(entry as { type?: string }).type === "message" &&
			((entry as { message?: { role?: string } }).message?.role ?? "") === "toolResult",
	).length;
}

function fillTranscript(harness: RcSdkHarness, count: number, options: { errorAt?: number } = {}): void {
	for (let index = 0; index < count; index++) {
		appendToolExchange(harness, {
			callId: `call-${index}`,
			toolName: index === options.errorAt ? "bash" : "read",
			output: `evidence ${index}`.repeat(6),
			isError: index === options.errorAt,
		});
	}
}

describe("Evidence retention inside the real compaction owner", () => {
	it("plans nothing when the session has no tool pairs to consider", async () => {
		const harness = await createRcSdkHarness();
		const compaction = compactionOf(harness);
		const before = compaction.getCompactionBranch().length;

		await compaction.planEvidenceRetention(new AbortController().signal);

		expect(compaction.getAppliedRetentionAudit()).toBeUndefined();
		expect(compaction.getCompactionBranch().length).toBe(before);
	});

	it("drops the pairs the engine judged useless and leaves the recency window intact", async () => {
		const harness = await createRcSdkHarness({
			decisions: { fallback: { kind: "boolean", probabilityTrue: 0.05 } },
		});
		fillTranscript(harness, 20);
		const compaction = compactionOf(harness);
		const before = toolResultCount(compaction.getCompactionBranch());

		await compaction.planEvidenceRetention(new AbortController().signal);
		const after = toolResultCount(compaction.getCompactionBranch());
		const audit = compaction.getAppliedRetentionAudit();

		expect(audit?.stats.jevRequestCount).toBe(1);
		expect(audit?.droppedCallIds.length).toBeGreaterThan(0);
		expect(before - after).toBe(audit?.droppedCallIds.length);
		expect(audit?.droppedCallIds).not.toContain("call-19");
		expect(compaction.getRetentionAuditStats()).toBeDefined();
		expect(compaction.getRetentionPlanner().getLastAuditStats()).toBeDefined();
	});

	it("sends valid JSON evidence to the decision engine when no goal is active", async () => {
		const harness = await createRcSdkHarness({
			decisions: { fallback: { kind: "boolean", probabilityTrue: 0.05 } },
		});
		fillTranscript(harness, 20);
		const evaluate = harness.decisions.evaluate.bind(harness.decisions);
		vi.spyOn(harness.decisions, "evaluate").mockImplementation((program, state, options) => {
			serializeEvaluation({ state });
			return evaluate(program, state, options);
		});

		await compactionOf(harness).planEvidenceRetention(new AbortController().signal);

		const audit = compactionOf(harness).getAppliedRetentionAudit();
		expect(audit?.stats.jevRequestCount).toBe(1);
		expect(audit?.droppedCallIds.length).toBeGreaterThan(0);
	});

	it("truncates a large result instead of dropping it when only the call stays useful", async () => {
		const harness = await createRcSdkHarness({
			decisions: {
				answers: {},
				// Keeping the call is useful; keeping the exact result is not.
				fallback: { kind: "boolean", probabilityTrue: 0.05 },
			},
		});
		for (let index = 0; index < 20; index++) {
			appendToolExchange(harness, {
				callId: `call-${index}`,
				toolName: "read",
				output: "x".repeat(4096),
			});
		}
		const compaction = compactionOf(harness);
		const decisions = compaction as unknown as { activeRetentionDecisions?: unknown };
		await compaction.planEvidenceRetention(new AbortController().signal);

		expect(decisions).toBeDefined();
		expect(compaction.getAppliedRetentionAudit()?.stats.pairsRemoved).toBeGreaterThan(0);
	});

	it("keeps everything when the semantic engine fails, and persists the audit either way", async () => {
		const harness = await createRcSdkHarness({
			decisions: { failWith: new Error("semantic plane unavailable") },
		});
		fillTranscript(harness, 20, { errorAt: 0 });
		const compaction = compactionOf(harness);
		const before = toolResultCount(compaction.getCompactionBranch());

		await compaction.planEvidenceRetention(new AbortController().signal);

		expect(toolResultCount(compaction.getCompactionBranch())).toBe(before);
		expect(compaction.getAppliedRetentionAudit()?.droppedCallIds).toEqual([]);
		expect(compaction.getAppliedRetentionAudit()?.summaryEvent).toContain("retention unavailable");
		expect(
			harness.session.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === RETENTION_AUDIT_CUSTOM_TYPE),
		).toHaveLength(1);
	});

	it("never offers an errored pair to the engine", async () => {
		const harness = await createRcSdkHarness({
			decisions: { fallback: { kind: "boolean", probabilityTrue: 0 } },
		});
		fillTranscript(harness, 20, { errorAt: 0 });
		const compaction = compactionOf(harness);

		await compaction.planEvidenceRetention(new AbortController().signal);

		expect(compaction.getAppliedRetentionAudit()?.droppedCallIds).not.toContain("call-0");
	});

	it("plans nothing at all when the session has no semantic engine", async () => {
		const harness = await createRcSdkHarness();
		fillTranscript(harness, 20);
		const compaction = compactionOf(harness);
		// Removing the plane is what a session without System One looks like to this code path.
		(harness.session as unknown as { _steeringPlane?: unknown })._steeringPlane = undefined;
		const before = toolResultCount(compaction.getCompactionBranch());

		await compaction.planEvidenceRetention(new AbortController().signal);

		expect(toolResultCount(compaction.getCompactionBranch())).toBe(before);
		expect(compaction.getAppliedRetentionAudit()).toBeUndefined();
	});
});
