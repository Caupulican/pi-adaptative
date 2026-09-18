import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import { createEmptyUsage } from "@caupulican/pi-ai/usage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LaneToolUsage } from "../src/core/autonomy/lane-tool-usage.ts";
import { WorkerToolAdapterRegistry } from "../src/core/autonomy/worker-tool-adapter-registry.ts";
import { WorkerConversationStore } from "../src/core/delegation/worker-conversation-store.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { DurableTaskRuntime } from "../src/core/orchestration/task-runtime.ts";
import { createHarness } from "./suite/harness.ts";

afterEach(() => vi.restoreAllMocks());

describe("worker final-only tool receipt delivery", () => {
	it.each([
		{ dispose: false, failure: "none" },
		{ dispose: true, failure: "none" },
		{ dispose: true, failure: "before_write" },
		{ dispose: true, failure: "after_write" },
	] as const)("settles a native loop result: $dispose, storage failure=$failure", async ({ dispose, failure }) => {
		const harness = await createHarness({
			initialActiveToolNames: ["delegate", "typesafe_review"],
			settings: { workerDelegation: { enabled: true, orchestrationProfile: undefined } },
		});
		const sessionId = harness.sessionManager.getSessionId();
		const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
		const call = fauxToolCall("typesafe_review", {
			action: "evaluate",
			evaluation: { state: "fixture", questions: { q: { type: "noul", instructions: "Is this a fixture?" } } },
		});
		const usage = { ...createEmptyUsage(), input: 100, output: 10, totalTokens: 110 };
		const recordUsage = DurableTaskRuntime.prototype.recordAttemptUsage;
		let writes = 0;
		let failedReport: Parameters<DurableTaskRuntime["recordAttemptUsage"]> | undefined;
		const receiptAttempts: Array<Parameters<DurableTaskRuntime["recordAttemptUsage"]>> = [];
		let notifyPersisted: () => void = () => {};
		const persisted = new Promise<void>((resolve) => {
			notifyPersisted = resolve;
		});
		vi.spyOn(DurableTaskRuntime.prototype, "recordAttemptUsage").mockImplementation(function (
			this: DurableTaskRuntime,
			handle,
			cumulative,
		) {
			const previous =
				this.getSnapshot().attempts[handle.attemptId]?.usageAccounting?.generations[handle.leaseId]?.reported;
			const isFinalReceipt = failedReport
				? handle.attemptId === failedReport[0].attemptId && handle.leaseId === failedReport[0].leaseId
				: previous &&
					cumulative.inputTokens - previous.inputTokens === usage.input &&
					cumulative.outputTokens - previous.outputTokens === usage.output;
			if (!isFinalReceipt) return recordUsage.call(this, handle, cumulative);
			writes++;
			receiptAttempts.push(structuredClone([handle, cumulative]));
			if (failure !== "none" && writes === 1) {
				failedReport = structuredClone([handle, cumulative]);
				if (failure === "after_write") recordUsage.call(this, handle, cumulative);
				throw new Error("fixture final receipt storage failure");
			}
			const result = recordUsage.call(this, handle, cumulative);
			notifyPersisted();
			return result;
		});
		let notifyStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			notifyStarted = resolve;
		});
		let releaseResult: () => void = () => {};
		const resultReady = new Promise<void>((resolve) => {
			releaseResult = resolve;
		});
		const materialize = WorkerToolAdapterRegistry.prototype.materialize;
		const backend = vi.fn(async () => {
			notifyStarted();
			await resultReady;
			// Exercise the legal final-only adapter contract. The transport is a fixture:
			// no HTTP request or interim reportUsage callback occurs in this test.
			return { content: [{ type: "text" as const, text: "Final receipt fixture" }], details: {}, usage };
		});
		vi.spyOn(WorkerToolAdapterRegistry.prototype, "materialize").mockImplementation(function (
			this: WorkerToolAdapterRegistry,
			name,
			context,
		) {
			const result = materialize.call(this, name, context);
			if (name !== "typesafe_review" || !result.ok) return result;
			return { ok: true, tool: { ...result.tool, execute: backend } };
		});
		const report = vi.spyOn(LaneToolUsage.prototype, "report");
		const closed = vi.spyOn(LaneToolUsage.prototype, "close");
		const settle = LaneToolUsage.prototype.settle;
		let settlementFailure: unknown;
		let notifySettled: () => void = () => {};
		const settled = new Promise<void>((resolve) => {
			notifySettled = resolve;
		});
		vi.spyOn(LaneToolUsage.prototype, "settle").mockImplementation(function (this: LaneToolUsage, id, receipt) {
			try {
				return settle.call(this, id, receipt);
			} catch (error) {
				if (id === call.id) settlementFailure = error;
				throw error;
			} finally {
				if (id === call.id) notifySettled();
			}
		});
		try {
			harness.authStorage.set("typesafe", { type: "api_key", key: "final-receipt-fixture-key" });
			harness.setResponses([
				fauxAssistantMessage(call, { stopReason: "toolUse" }),
				fauxAssistantMessage('{"summary":"Recorded fixture.","status":"completed"}'),
			]);
			const work = harness.session.runWorkerDelegationOnce({ instructions: "Evaluate the final receipt fixture." });
			await started;
			expect(report.mock.calls.filter(([id]) => id === call.id)).toHaveLength(0);
			if (dispose) {
				harness.session.dispose();
				await work;
				expect(closed).toHaveBeenCalled();
			}
			releaseResult();
			await settled;
			await work;
			// Production must own this retry after the outer worker and its surface have ended.
			// The fixture never calls settle, close, flushUsage or recordAttemptUsage to retry it.
			await persisted;
			if (failure === "none") expect(settlementFailure).toBeUndefined();
			else expect(settlementFailure).toEqual(new Error("fixture final receipt storage failure"));
			expect(writes).toBe(failure === "none" ? 1 : 2);
			if (failedReport) expect(receiptAttempts).toEqual([failedReport, failedReport]);
			expect(backend).toHaveBeenCalledOnce();
			expect(fetcher).not.toHaveBeenCalled();
			expect(report.mock.calls.filter(([id]) => id === call.id)).toEqual([[call.id, usage]]);
			const lane = harness.session.getLaneRecords().find((record) => record.type === "worker");
			if (!lane?.agentId) throw new Error("Missing actual worker lane");
			const lifecycle = new WorkerLifecycle({ agentDir: harness.tempDir, sessionId });
			const agent = lifecycle.getAgent(lane.agentId);
			if (!agent) throw new Error("Missing durable worker identity");
			const messages = new WorkerConversationStore()
				.open({
					agentDir: harness.tempDir,
					resumeContext: agent.resumeContext,
					expectedLogicalAgentId: agent.agentId,
				})
				.getRawTranscript();
			const assistantTokens = messages.reduce(
				(total, message) => total + (message.role === "assistant" ? message.usage.totalTokens : 0),
				0,
			);
			expect(lifecycle.getAttemptUsage(lane.laneId)?.totalTokens).toBe(assistantTokens + 110);
			expect(messages.filter((message) => message.role === "toolResult")).toHaveLength(dispose ? 0 : 1);
			if (dispose) {
				expect(Object.values(lifecycle.getActiveAttempt(lane.laneId)!.usageReceipts ?? {})).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ usage: expect.objectContaining({ totalTokens: 110 }) }),
					]),
				);
			} else {
				expect(messages.find((message) => message.role === "toolResult")).toMatchObject({
					toolCallId: call.id,
					content: [{ type: "text", text: "Final receipt fixture" }],
					usage,
				});
				expect(harness.session.getCumulativeUsage().totalTokens).toBe(assistantTokens + 110);
			}
		} finally {
			releaseResult();
			await harness.cleanup();
		}
	});
});
