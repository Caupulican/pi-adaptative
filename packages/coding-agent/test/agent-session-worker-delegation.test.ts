import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { getLaneRecordSnapshots } from "../src/core/autonomy/session-lane-record.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const WORKER_JSON =
	'{"summary":"The validator blocks out-of-scope changes.","findings":[{"summary":"Deny lists override allow lists","confidence":0.8}]}';

function workerLaneRecords(harness: Harness) {
	return getLaneRecordSnapshots(harness.sessionManager.getEntries()).filter((record) => record.type === "worker");
}

describe("AgentSession worker delegation", () => {
	it("skips when worker delegation is disabled (default)", async () => {
		const harness = await createHarness();
		try {
			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Scout something" });
			expect(run.started).toBe(false);
			expect(run.skipReason).toBe("worker_delegation_disabled");
			expect(workerLaneRecords(harness)).toHaveLength(0);
		} finally {
			harness.cleanup();
		}
	});

	it("skips on empty instructions", async () => {
		const harness = await createHarness({ settings: { workerDelegation: { enabled: true } } });
		try {
			const run = await harness.session.runWorkerDelegationOnce({ instructions: "   " });
			expect(run.started).toBe(false);
			expect(run.skipReason).toBe("missing_instructions");
		} finally {
			harness.cleanup();
		}
	});

	it("runs a scout worker end to end: result, lane record, acceptance", async () => {
		const harness = await createHarness({ settings: { workerDelegation: { enabled: true } } });
		try {
			harness.setResponses([fauxAssistantMessage(WORKER_JSON)]);

			const run = await harness.session.runWorkerDelegationOnce({
				instructions: "Summarize the delegation validation rules",
			});

			expect(run.started).toBe(true);
			expect(run.record?.status).toBe("succeeded");
			expect(run.record?.reasonCode).toBe("worker_completed");
			expect(run.outcome?.accepted).toBe(true);
			expect(run.outcome?.result.usageReportId).toBe(`worker:${harness.session.sessionId}:${run.record?.laneId}`);

			const results = harness.session.getWorkerResultSnapshots();
			expect(results).toHaveLength(1);
			expect(results[0]?.status).toBe("completed");
			expect(results[0]?.summary).toBe("The validator blocks out-of-scope changes.");
			expect(results[0]?.evidence?.findings).toHaveLength(1);

			const lanes = workerLaneRecords(harness);
			expect(lanes).toHaveLength(1);
			expect(lanes[0]?.status).toBe("succeeded");

			const diagnostics = harness.session.getAutonomyDiagnosticSnapshot();
			expect(diagnostics.delegation?.some((entry) => entry.title.startsWith("Lane worker-"))).toBe(true);
			expect(diagnostics.delegation?.some((entry) => entry.title.startsWith("Worker worker-"))).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("records a blocked worker as requiring parent review", async () => {
		const harness = await createHarness({ settings: { workerDelegation: { enabled: true } } });
		try {
			harness.setResponses([
				fauxAssistantMessage('{"summary":"Stuck","status":"blocked","blockers":["Need repo access"]}'),
			]);

			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Do the impossible" });

			expect(run.record?.status).toBe("failed");
			expect(run.record?.reasonCode).toBe("worker_blocked");
			expect(run.outcome?.accepted).toBe(false);
			expect(run.outcome?.acceptance.outcome).toBe("block");
			expect(harness.session.getWorkerResultSnapshots()[0]?.status).toBe("blocked");
		} finally {
			harness.cleanup();
		}
	});

	it("lets the model delegate through the delegate tool in a full turn", async () => {
		const harness = await createHarness({ settings: { workerDelegation: { enabled: true } } });
		try {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("delegate", { instructions: "Scout the validation rules" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(WORKER_JSON),
				fauxAssistantMessage("Delegation reviewed."),
			]);

			await harness.session.prompt("Please delegate a scout task", { autoContinueGoal: false });

			expect(harness.session.getWorkerResultSnapshots()).toHaveLength(1);
			expect(workerLaneRecords(harness)[0]?.status).toBe("succeeded");

			const serialized = JSON.stringify(harness.session.messages);
			expect(serialized).toContain("UNTRUSTED");
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			harness.cleanup();
		}
	});
});
