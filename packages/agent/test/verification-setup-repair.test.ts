import type { ToolResultMessage } from "@caupulican/pi-ai/types";
import { describe, expect, it } from "vitest";
import { retainedVerificationDetails, VerificationObligationTracker } from "../src/verification-obligations.ts";

function receipt(fields: Record<string, unknown>): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "check",
		toolName: "bash",
		timestamp: 1,
		content: [{ type: "text", text: "host verification" }],
		isError: fields.status !== "passed",
		details: { piVerification: { version: 1, ...fields } },
	};
}

describe("verification setup repair", () => {
	it("rejects unknown execution phases without dropping a valid receipt", () => {
		expect(
			retainedVerificationDetails({
				piVerification: { version: 1, id: "check", status: "failed", outcome: "unknown" },
			}),
		).toBeUndefined();
		expect(
			retainedVerificationDetails({
				piVerification: { version: 1, id: "check", status: "failed", outcome: "unconfirmed" },
			})?.piVerification.outcome,
		).toBe("unconfirmed");
	});
	it("exposes setup repair only while the host retains proof of an empty invocation", () => {
		const tracker = new VerificationObligationTracker([
			receipt({ id: "setup", status: "failed", outcome: "setup_failed", repairGroup: "scope-a" }),
		]);
		expect(tracker.requestInstruction()).toContain(
			'- setup (empty-test setup; corrected bash may set repairOf="setup")',
		);
		tracker.record([receipt({ id: "setup", status: "failed", outcome: "executed", repairGroup: "scope-a" })]);
		expect(tracker.requestInstruction()).not.toContain('repairOf="setup"');
		expect(tracker.requestInstruction()).toContain("- setup");
	});

	it.each(
		[
			[{ id: "missing", repairGroup: "scope-a" }],
			[{ id: "setup", repairGroup: "x".repeat(129) }],
			[
				{ id: "setup", repairGroup: "scope-a" },
				{ id: "setup", repairGroup: "scope-a" },
			],
			[
				{ id: "setup", repairGroup: "scope-a" },
				{ id: "actual", repairGroup: "scope-a" },
			],
		].map((setupFailures) => ({ setupFailures })),
	)("ignores malformed checkpoint repair evidence without erasing prior failures: %j", ({ setupFailures }) => {
		const tracker = new VerificationObligationTracker([
			receipt({ id: "prior", status: "failed" }),
			{
				role: "compactionSummary",
				summary: "checkpoint",
				tokensBefore: 10,
				timestamp: 1,
				details: { piVerificationObligations: { version: 1, activeIds: ["actual", "setup"], setupFailures } },
			},
		]);
		expect(tracker.getActiveIds()).toEqual(["prior"]);
	});

	it("does not infer a repair link merely from matching scope", () => {
		const tracker = new VerificationObligationTracker([
			receipt({ id: "setup", status: "failed", outcome: "setup_failed", repairGroup: "scope-a" }),
			receipt({ id: "corrected", status: "passed", outcome: "executed", repairGroup: "scope-a" }),
		]);
		expect(tracker.getActiveIds()).toEqual(["setup"]);
	});

	it("revokes setup repair eligibility after an executed failure, including across compaction", () => {
		const tracker = new VerificationObligationTracker([
			receipt({ id: "setup", status: "failed", outcome: "setup_failed", repairGroup: "scope-a" }),
			receipt({ id: "setup", status: "failed", outcome: "executed", repairGroup: "scope-a" }),
		]);
		const checkpoint = tracker.createSnapshotDetails();
		expect(checkpoint?.piVerificationObligations.setupFailures).toBeUndefined();
		tracker.restore([
			{ role: "compactionSummary", summary: "checkpoint", tokensBefore: 10, timestamp: 1, details: checkpoint },
		]);
		tracker.record([
			receipt({ id: "corrected", status: "passed", outcome: "executed", repairGroup: "scope-a", repairOf: "setup" }),
		]);
		expect(tracker.getActiveIds()).toEqual(["setup"]);
	});

	it("bounds repair evidence alongside active identities after overflow", () => {
		const tracker = new VerificationObligationTracker(
			Array.from({ length: 100 }, (_, index) =>
				receipt({ id: `setup-${index}`, status: "failed", outcome: "setup_failed", repairGroup: "scope-a" }),
			),
		);
		const snapshot = tracker.createSnapshotDetails()?.piVerificationObligations;
		expect(snapshot?.activeIds).toHaveLength(16);
		expect(snapshot?.setupFailures).toHaveLength(15);
		expect(snapshot?.setupFailures?.every(({ id }) => snapshot.activeIds.includes(id))).toBe(true);
		expect(snapshot?.activeIds).toContain("_verification_overflow");
	});

	it("preserves repair eligibility through a bounded compaction checkpoint", () => {
		const original = new VerificationObligationTracker([
			receipt({ id: "setup", status: "failed", outcome: "setup_failed", repairGroup: "scope-a" }),
			receipt({ id: "actual", status: "failed", outcome: "executed", repairGroup: "scope-a" }),
		]);
		const restored = new VerificationObligationTracker([
			{
				role: "compactionSummary",
				summary: "checkpoint",
				tokensBefore: 10,
				timestamp: 1,
				details: JSON.parse(JSON.stringify(original.createSnapshotDetails())),
			},
		]);
		restored.record([
			receipt({ id: "corrected", status: "passed", outcome: "executed", repairGroup: "scope-a", repairOf: "setup" }),
		]);
		expect(restored.getActiveIds()).toEqual(["actual"]);
	});

	it("preserves bounded setup and repair evidence in the canonical wire projection", () => {
		const piVerification = {
			version: 1,
			id: "repaired",
			status: "passed",
			outcome: "executed",
			repairGroup: "scope-a",
			repairOf: "setup",
		};
		expect(retainedVerificationDetails({ piVerification })).toEqual({ piVerification });
	});

	it("allows only a matching executed pass to resolve an explicitly linked setup failure", () => {
		const tracker = new VerificationObligationTracker([
			receipt({ id: "setup", status: "failed", outcome: "setup_failed", repairGroup: "scope-a" }),
			receipt({ id: "real-failure", status: "failed", outcome: "executed", repairGroup: "scope-a" }),
			receipt({ id: "corrected", status: "passed", outcome: "executed", repairGroup: "scope-a", repairOf: "setup" }),
		]);
		expect(tracker.getActiveIds()).toEqual(["real-failure"]);
	});

	it.each([
		{ outcome: "executed", repairGroup: "other" },
		{ outcome: "unconfirmed", repairGroup: "scope-a" },
		{ outcome: "setup_failed", repairGroup: "scope-a" },
		{ repairGroup: "scope-a" },
		{ outcome: "executed" },
	])("does not allow incomplete or mismatched repair claims: %j", (claim) => {
		const tracker = new VerificationObligationTracker([
			receipt({ id: "setup", status: "failed", outcome: "setup_failed", repairGroup: "scope-a" }),
			receipt({ id: "corrected", status: "passed", repairOf: "setup", ...claim }),
		]);
		expect(tracker.getActiveIds()).toEqual(["setup"]);
	});

	it.each(["executed", "unconfirmed", undefined])(
		"never downgrades an existing %s failure into repairable setup",
		(outcome) => {
			const tracker = new VerificationObligationTracker([
				receipt({ id: "check", status: "failed", outcome, repairGroup: "scope-a" }),
				receipt({ id: "check", status: "failed", outcome: "setup_failed", repairGroup: "scope-a" }),
				receipt({
					id: "corrected",
					status: "passed",
					outcome: "executed",
					repairGroup: "scope-a",
					repairOf: "check",
				}),
			]);
			expect(tracker.getActiveIds()).toEqual(["check"]);
		},
	);

	it("does not let an older background pass resolve a later setup failure", () => {
		const placeholder: ToolResultMessage = {
			...receipt({}),
			isError: false,
			details: { sessionId: "session", taskId: "task-old", status: "running" },
		};
		const tracker = new VerificationObligationTracker([
			placeholder,
			receipt({ id: "setup", status: "failed", outcome: "setup_failed", repairGroup: "scope-a" }),
			{
				...receipt({
					id: "corrected",
					status: "passed",
					outcome: "executed",
					repairGroup: "scope-a",
					repairOf: "setup",
					originTaskId: "task-old",
				}),
				details: {
					taskId: "task-old",
					piVerification: {
						version: 1,
						id: "corrected",
						status: "passed",
						outcome: "executed",
						repairGroup: "scope-a",
						repairOf: "setup",
						originTaskId: "task-old",
					},
				},
			},
		]);
		expect(tracker.getActiveIds()).toEqual(["setup"]);
	});
});
