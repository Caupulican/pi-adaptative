import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerConversationStore } from "../src/core/delegation/worker-conversation-store.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { type TypeSafeEvidenceRef, TypeSafeEvidenceStore } from "../src/core/review/typesafe-evidence-store.ts";
import { createHarness } from "./suite/harness.ts";

afterEach(() => vi.restoreAllMocks());

describe("worker service receipt after execution shutdown", () => {
	it.each([false, true])(
		"retains known billed usage when shutdown races body decoding: shutdown=%s",
		async (shutdown) => {
			const harness = await createHarness({
				initialActiveToolNames: ["delegate", "typesafe_review"],
				settings: { workerDelegation: { enabled: true, orchestrationProfile: undefined } },
			});
			const sessionId = harness.sessionManager.getSessionId();
			let receipt: TypeSafeEvidenceRef | undefined;
			let notifyReceipt: () => void = () => {};
			const receiptReady = new Promise<void>((resolve) => {
				notifyReceipt = resolve;
			});
			const save = TypeSafeEvidenceStore.prototype.save;
			vi.spyOn(TypeSafeEvidenceStore.prototype, "save").mockImplementation(function (
				this: TypeSafeEvidenceStore,
				toolCallId,
				record,
			) {
				receipt = save.call(this, toolCallId, record);
				notifyReceipt();
				return receipt;
			});
			const response = Response.json({
				model: "jev-1.13.0",
				answers: { q: { type: "noul", noul: 1 } },
				usage: { input_tokens: 100, output_tokens: 10 },
			});
			const reader = response.body!.getReader();
			const read = reader.read.bind(reader);
			vi.spyOn(reader, "read").mockImplementation(async () => {
				const chunk = await read();
				// All bytes have arrived, but the awaiting reviewer has not decoded them yet.
				// Owner shutdown fences execution before the final read continuation resumes.
				if (shutdown && chunk.done) harness.session.dispose();
				return chunk;
			});
			vi.spyOn(response.body!, "getReader").mockReturnValue(reader);
			const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
			try {
				harness.authStorage.set("typesafe", { type: "api_key", key: "late-receipt-fixture-key" });
				harness.setResponses([
					fauxAssistantMessage(
						fauxToolCall("typesafe_review", {
							action: "evaluate",
							evaluation: {
								state: "fixture",
								questions: { q: { type: "noul", instructions: "Is this a fixture?" } },
							},
						}),
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage('{"summary":"Checked fixture.","status":"completed"}'),
				]);
				await harness.session.runWorkerDelegationOnce({ instructions: "Evaluate the fixture with Jev." });
				await receiptReady;
				expect(fetcher).toHaveBeenCalledOnce();
				const archived = TypeSafeEvidenceStore.file(harness.tempDir, sessionId).read(receipt!.id);
				expect(JSON.parse(archived.text)).toMatchObject({
					record: { response: { usage: { input_tokens: 100, output_tokens: 10 } } },
				});
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
					(tokens, message) => tokens + (message.role === "assistant" ? message.usage.totalTokens : 0),
					0,
				);
				expect(messages.filter((message) => message.role === "toolResult")).toHaveLength(shutdown ? 0 : 1);
				expect(lifecycle.getAttemptUsage(lane.laneId)?.totalTokens).toBe(assistantTokens + 110);
			} finally {
				await harness.cleanup();
			}
		},
	);
});
