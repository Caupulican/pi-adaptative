import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerConversationStore } from "../src/core/delegation/worker-conversation-store.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { DurableTaskRuntime } from "../src/core/orchestration/task-runtime.ts";
import { type TypeSafeEvidenceRef, TypeSafeEvidenceStore } from "../src/core/review/typesafe-evidence-store.ts";
import { createHarness } from "./suite/harness.ts";

afterEach(() => vi.restoreAllMocks());

describe("worker billed review cancellation", () => {
	it.each([
		{ shutdown: false, failUsageWrite: false },
		{ shutdown: true, failUsageWrite: false },
		{ shutdown: false, failUsageWrite: true },
	])("retains a received service charge: %j", async ({ shutdown, failUsageWrite }) => {
		const harness = await createHarness({
			initialActiveToolNames: ["delegate", "typesafe_review", "skill"],
			settings: { workerDelegation: { enabled: true, orchestrationProfile: undefined } },
		});
		const sessionId = harness.sessionManager.getSessionId();
		const save = TypeSafeEvidenceStore.prototype.save;
		const recordUsage = DurableTaskRuntime.prototype.recordAttemptUsage;
		let billedUsageWrites = 0;
		vi.spyOn(DurableTaskRuntime.prototype, "recordAttemptUsage").mockImplementation(function (
			this: DurableTaskRuntime,
			handle,
			usage,
		) {
			const previous =
				this.getSnapshot().attempts[handle.attemptId]?.usageAccounting?.generations[handle.leaseId]?.reported;
			if (
				previous &&
				usage.inputTokens - previous.inputTokens === 100 &&
				usage.outputTokens - previous.outputTokens === 10
			) {
				billedUsageWrites++;
				if (failUsageWrite && billedUsageWrites === 1) throw new Error("fixture usage write failure");
			}
			return recordUsage.call(this, handle, usage);
		});
		let receipt: TypeSafeEvidenceRef | undefined;
		vi.spyOn(TypeSafeEvidenceStore.prototype, "save").mockImplementation(function (
			this: TypeSafeEvidenceStore,
			toolCallId,
			record,
		) {
			receipt = save.call(this, toolCallId, record);
			// The real service response has been decoded and archived. Reproduce the owner
			// leaving before the loop publishes the result; no late transcript write is allowed.
			if (shutdown) harness.session.dispose();
			return receipt;
		});
		const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				model: "jev-1.13.0",
				answers: { q: { type: "choice", choice: "yes", confidence: 1, probabilities: { yes: 1, no: 0 } } },
				usage: { input_tokens: 100, output_tokens: 10 },
			}),
		);
		try {
			harness.authStorage.set("typesafe", { type: "api_key", key: "worker-cancel-fixture-key" });
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("typesafe_review", {
						action: "review",
						review: {
							state: "fixture",
							questions: {
								q: {
									instructions: "Is the fixture present?",
									criteria: { yes: "Present", no: "Absent" },
									expected: "yes",
								},
							},
						},
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage('{"summary":"Checked fixture.","status":"completed"}'),
			]);
			await harness.session.runWorkerDelegationOnce({ instructions: "Review the fixture with Jev." });
			expect(fetcher).toHaveBeenCalledOnce();
			expect(billedUsageWrites).toBe(failUsageWrite ? 2 : 1);
			expect(receipt).toBeDefined();
			const archived = TypeSafeEvidenceStore.file(harness.tempDir, sessionId).read(receipt!.id);
			expect(JSON.parse(archived.text)).toMatchObject({
				record: { response: { usage: { input_tokens: 100, output_tokens: 10 } } },
			});
			const lane = harness.session.getLaneRecords().find((record) => record.type === "worker");
			if (!lane?.agentId) throw new Error("Missing actual worker lane");
			const lifecycle = new WorkerLifecycle({ agentDir: harness.tempDir, sessionId });
			const agent = lifecycle.getAgent(lane.agentId);
			if (!agent) throw new Error("Missing durable worker identity");
			const conversation = new WorkerConversationStore().open({
				agentDir: harness.tempDir,
				resumeContext: agent.resumeContext,
				expectedLogicalAgentId: agent.agentId,
			});
			const messages = conversation.getRawTranscript();
			const assistantTokens = messages.reduce(
				(tokens, message) => tokens + (message.role === "assistant" ? message.usage.totalTokens : 0),
				0,
			);
			expect(messages.filter((message) => message.role === "toolResult")).toHaveLength(shutdown ? 0 : 1);
			expect(lifecycle.getAttemptUsage(lane.laneId)?.totalTokens).toBe(assistantTokens + 110);
		} finally {
			await harness.cleanup();
		}
	});
});
