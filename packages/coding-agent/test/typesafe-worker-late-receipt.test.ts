import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LaneToolUsage } from "../src/core/autonomy/lane-tool-usage.ts";
import { WorkerConversationStore } from "../src/core/delegation/worker-conversation-store.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { DurableTaskRuntime } from "../src/core/orchestration/task-runtime.ts";
import { type TypeSafeEvidenceRef, TypeSafeEvidenceStore } from "../src/core/review/typesafe-evidence-store.ts";
import { createHarness } from "./suite/harness.ts";

afterEach(() => vi.restoreAllMocks());

describe("worker service receipt after execution shutdown", () => {
	it.each([
		"running",
		"suspended",
		"resumed",
		"disposed_surface",
		"disposed_surface_write_retry",
		"disposed_surface_postcommit_retry",
	] as const)("retains known billed usage when body decoding finishes after the worker is %s", async (state) => {
		const failUsageWrite = state === "disposed_surface_write_retry" || state === "disposed_surface_postcommit_retry";
		const waitForSurfaceDisposal = state === "disposed_surface" || failUsageWrite;
		const harness = await createHarness({
			initialActiveToolNames: ["delegate", "typesafe_review"],
			settings: { workerDelegation: { enabled: true, orchestrationProfile: undefined } },
		});
		const sessionId = harness.sessionManager.getSessionId();
		const closed = vi.spyOn(LaneToolUsage.prototype, "close");
		let notifySettlement: () => void = () => {};
		const settlementReady = new Promise<void>((resolve) => {
			notifySettlement = resolve;
		});
		const settle = LaneToolUsage.prototype.settle;
		vi.spyOn(LaneToolUsage.prototype, "settle").mockImplementation(function (this: LaneToolUsage, id, usage) {
			try {
				return settle.call(this, id, usage);
			} finally {
				// Evidence storage precedes result publication. Wait for the real callback too,
				// including its failure, so this test cannot inspect counters before a retry.
				notifySettlement();
			}
		});
		const recordUsage = DurableTaskRuntime.prototype.recordAttemptUsage;
		let billedUsageWrites = 0;
		let failedReceipt: Parameters<DurableTaskRuntime["recordAttemptUsage"]> | undefined;
		const receiptAttempts: Array<Parameters<DurableTaskRuntime["recordAttemptUsage"]>> = [];
		vi.spyOn(DurableTaskRuntime.prototype, "recordAttemptUsage").mockImplementation(function (
			this: DurableTaskRuntime,
			handle,
			usage,
		) {
			const previous =
				this.getSnapshot().attempts[handle.attemptId]?.usageAccounting?.generations[handle.leaseId]?.reported;
			const isReceipt = failedReceipt
				? handle.attemptId === failedReceipt[0].attemptId && handle.leaseId === failedReceipt[0].leaseId
				: previous &&
					usage.inputTokens - previous.inputTokens === 100 &&
					usage.outputTokens - previous.outputTokens === 10;
			if (isReceipt) {
				billedUsageWrites++;
				receiptAttempts.push(structuredClone([handle, usage]));
				if (failUsageWrite && billedUsageWrites === 1) {
					failedReceipt = structuredClone([handle, usage]);
					if (state === "disposed_surface_postcommit_retry") recordUsage.call(this, handle, usage);
					throw new Error("fixture late usage write failure");
				}
			}
			return recordUsage.call(this, handle, usage);
		});
		let notifyReadBlocked: () => void = () => {};
		const readBlocked = new Promise<void>((resolve) => {
			notifyReadBlocked = resolve;
		});
		let releaseRead: () => void = () => {};
		const readRelease = new Promise<void>((resolve) => {
			releaseRead = resolve;
		});
		let resumedFence: number | undefined;
		let checkpointsBeforeReceipt: readonly string[] | undefined;
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
			if (waitForSurfaceDisposal && chunk.done) {
				notifyReadBlocked();
				await readRelease;
			} else if (state !== "running" && chunk.done) {
				harness.session.dispose();
				if (state === "resumed") {
					const lane = harness.session.getLaneRecords().find((record) => record.type === "worker");
					if (!lane?.agentId) throw new Error("Missing worker to resume");
					const lifecycle = new WorkerLifecycle({ agentDir: harness.tempDir, sessionId });
					const handle = lifecycle.resumeAgent(lane.laneId, lane.agentId, 60_000, "resumed-fixture-owner");
					resumedFence = handle.fencingToken;
					checkpointsBeforeReceipt = [...lifecycle.getActiveAttempt(lane.laneId)!.checkpointIds];
				}
			}
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
			const work = harness.session.runWorkerDelegationOnce({ instructions: "Evaluate the fixture with Jev." });
			if (waitForSurfaceDisposal) {
				await readBlocked;
				harness.session.dispose();
				await work;
				// Hold the actual response until the worker's finally disposed its tool surface.
				expect(closed).toHaveBeenCalled();
				releaseRead();
			} else await work;
			await receiptReady;
			await settlementReady;
			expect(fetcher).toHaveBeenCalledOnce();
			expect(billedUsageWrites).toBe(failUsageWrite ? 2 : 1);
			if (failedReceipt) expect(receiptAttempts).toEqual([failedReceipt, failedReceipt]);
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
			expect(messages.filter((message) => message.role === "toolResult")).toHaveLength(state === "running" ? 1 : 0);
			expect(lifecycle.getAttemptUsage(lane.laneId)?.totalTokens).toBe(assistantTokens + 110);
			const attempt = lifecycle.getActiveAttempt(lane.laneId)!;
			if (state === "running") {
				// The packaged background owner delivers every charge, not only its terminal snapshot.
				expect(harness.session.getCumulativeUsage().totalTokens).toBe(assistantTokens + 110);
			} else {
				// Disposal prevents a late parent write; received usage must remain in its durable outbox.
				const pending = Object.values(attempt.usageReceipts ?? {});
				expect(pending).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							usage: expect.objectContaining({ inputTokens: 100, outputTokens: 10, totalTokens: 110 }),
						}),
					]),
				);
			}
			if (state === "resumed") {
				expect(resumedFence).toBeDefined();
				expect(lifecycle.getActiveAttempt(lane.laneId)).toMatchObject({
					status: "running",
					lease: { fencingToken: resumedFence, ownerId: "resumed-fixture-owner" },
					checkpointIds: checkpointsBeforeReceipt,
				});
			}
		} finally {
			releaseRead();
			await harness.cleanup();
		}
	});
});
