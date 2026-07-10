import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { getLaneRecordSnapshots } from "../src/core/autonomy/session-lane-record.ts";
import { getWorkerRequestSnapshots } from "../src/core/delegation/session-worker-result.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const WORKER_JSON =
	'{"summary":"The validator blocks out-of-scope changes.","findings":[{"summary":"Deny lists override allow lists","confidence":0.8}]}';

function workerLaneRecords(harness: Harness) {
	return getLaneRecordSnapshots(harness.sessionManager.getEntries()).filter((record) => record.type === "worker");
}

describe("AgentSession worker delegation", () => {
	it("runs bounded read-only delegation by default on a capable model", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([fauxAssistantMessage(WORKER_JSON)]);
			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Scout something" });
			expect(run.started).toBe(true);
			expect(getWorkerRequestSnapshots(harness.sessionManager.getEntries())[0]?.envelope.capabilities).toEqual([
				"read_files",
			]);
		} finally {
			harness.cleanup();
		}
	});

	it("keeps an explicit delegation disable independent of Ultra", async () => {
		const harness = await createHarness({
			settings: { workerDelegation: { enabled: false } },
		});
		try {
			const model = harness.session.model;
			if (!model) throw new Error("Expected harness model");
			model.thinkingLevelMap = { max: "max", ultra: "max" };
			harness.session.setThinkingLevel("ultra");
			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Scout safely" });
			expect(run).toMatchObject({ started: false, skipReason: "worker_delegation_disabled" });
		} finally {
			harness.cleanup();
		}
	});

	it("gates delegation against the configured worker model rather than the foreground model", async () => {
		const harness = await createHarness({
			models: [
				{ id: "foreground", contextWindow: 128_000 },
				{ id: "tiny-worker", contextWindow: 4_096 },
			],
			settings: { workerDelegation: { enabled: true, model: "faux/tiny-worker" } },
		});
		try {
			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Scout safely" });

			expect(run).toMatchObject({ started: false, skipReason: "model_delegation_unsupported" });
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

	it("executes a direct scoped write and reports it for parent review", async () => {
		const harness = await createHarness({
			settings: { workerDelegation: { enabled: true, writeEnabled: true, writePaths: ["src"] } },
		});
		try {
			mkdirSync(join(harness.tempDir, "src"), { recursive: true });
			harness.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("write", { path: "src/direct.ts", content: "export const direct = true;\n" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage('{"summary":"direct write complete","actions":[]}'),
			]);

			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Write the direct helper" });

			expect(readFileSync(join(harness.tempDir, "src/direct.ts"), "utf-8")).toBe("export const direct = true;\n");
			expect(run.outcome?.result.changedFiles).toEqual(["src/direct.ts"]);
			expect(run.outcome?.acceptance).toMatchObject({
				outcome: "ask-user",
				reasonCode: "parent_review_required",
			});
			const request = getWorkerRequestSnapshots(harness.sessionManager.getEntries())[0];
			expect(request?.envelope.allowedTools).toEqual(["read", "grep", "find", "ls", "write", "edit"]);
			expect(request?.envelope.allowedTools).not.toContain("delegate");
		} finally {
			harness.cleanup();
		}
	});

	it("blocks and reports a direct write outside the configured scope", async () => {
		const harness = await createHarness({
			settings: { workerDelegation: { enabled: true, writeEnabled: true, writePaths: ["src"] } },
		});
		try {
			mkdirSync(join(harness.tempDir, "src"), { recursive: true });
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("write", { path: "outside.ts", content: "not allowed\n" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage('{"summary":"write was refused"}'),
			]);

			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Try the scoped write" });

			expect(existsSync(join(harness.tempDir, "outside.ts"))).toBe(false);
			expect(run.outcome?.result.changedFiles).toEqual([]);
			expect(run.outcome?.result.status).toBe("blocked");
			expect(run.outcome?.result.blockers?.some((blocker) => blocker.includes("write blocked"))).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("reports a failed direct edit target conservatively for parent review", async () => {
		const harness = await createHarness({
			settings: { workerDelegation: { enabled: true, writeEnabled: true, writePaths: ["src"] } },
		});
		try {
			mkdirSync(join(harness.tempDir, "src"), { recursive: true });
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("edit", { path: "src/missing.ts", oldText: "x", newText: "y" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage('{"summary":"edit failed"}'),
			]);

			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Edit the missing helper" });

			expect(run.outcome?.result.changedFiles).toEqual(["src/missing.ts"]);
			expect(run.outcome?.result.status).toBe("blocked");
			expect(run.outcome?.result.blockers).toContain("edit failed during isolated execution");
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
			expect(serialized).not.toContain("UNTRUSTED");
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			harness.cleanup();
		}
	});
});
