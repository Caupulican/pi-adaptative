import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessCapability } from "../src/core/capability-contract.ts";
import {
	WorkerConversation,
	WorkerConversationStore,
	type WorkerTranscriptMessage,
} from "../src/core/delegation/worker-conversation-store.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { TypeSafeEvidenceStore } from "../src/core/review/typesafe-evidence-store.ts";
import { createHarness } from "./suite/harness.ts";

afterEach(() => vi.restoreAllMocks());

describe("worker TypeSafe review", () => {
	it.each([
		{ name: "default inherited", capabilities: undefined, permitted: true },
		{ name: "large evidence", capabilities: undefined, permitted: true, evidence: "e".repeat(20_000) },
		{ name: "service rejection", capabilities: undefined, permitted: true, status: 401 },
		{ name: "uncertain verdict", capabilities: undefined, permitted: true, confidence: 0.94 },
		{ name: "billed transport retry", capabilities: undefined, permitted: true, retry: true },
		{ name: "transcript append failure", capabilities: undefined, permitted: true, appendFailure: true },
		{
			name: "explicit judgment",
			capabilities: ["semantic.judge"] as HarnessCapability[],
			permitted: true,
		},
		{ name: "no authority", capabilities: [] as HarnessCapability[], permitted: false },
		{
			name: "network and credential only",
			capabilities: ["network.http", "credentials.use"] as HarnessCapability[],
			permitted: false,
		},
	])(
		"uses the packaged reviewer under $name authority",
		async ({
			capabilities,
			permitted,
			evidence = "worker evidence",
			status = 200,
			confidence = 1,
			retry = false,
			appendFailure = false,
		}) => {
			const accepted = status === 200 && confidence >= 0.95;
			const serviceUsage = {
				inputTokens: retry ? 107 : 100,
				outputTokens: retry ? 13 : 10,
				totalTokens: retry ? 120 : 110,
			};
			if (appendFailure) {
				const append = WorkerConversation.prototype.appendMessage;
				vi.spyOn(WorkerConversation.prototype, "appendMessage").mockImplementation(function (
					this: WorkerConversation,
					message: WorkerTranscriptMessage,
				) {
					if (message.role === "toolResult" && message.toolName === "typesafe_review")
						throw new Error("Fixture transcript storage failure after billed Jev response");
					return append.call(this, message);
				});
			}
			const harness = await createHarness({
				initialActiveToolNames: ["delegate", "typesafe_review", "skill"],
				settings: { workerDelegation: { enabled: true, orchestrationProfile: undefined } },
			});
			const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
				Response.json(
					{
						model: "jev-1.13.0",
						answers: {
							q: {
								type: "choice",
								choice: "supports",
								confidence,
								probabilities: { supports: 1, insufficient: 0 },
							},
						},
						usage: { input_tokens: 100, output_tokens: 10 },
					},
					{ status },
				),
			);
			if (retry)
				fetcher.mockResolvedValueOnce(
					Response.json(
						{ error: "fixture rate limit", usage: { input_tokens: 7, output_tokens: 3 } },
						{ status: 429, headers: { "Retry-After": "0" } },
					),
				);
			try {
				harness.authStorage.set("typesafe", { type: "api_key", key: "worker-fixture-key" });
				harness.setResponses([
					(context) => {
						expect(context.tools?.map((tool) => tool.name)).toContain("typesafe_review");
						expect(context.tools?.find((tool) => tool.name === "typesafe_review")?.description).toContain(
							"Check typesafe_review status at work start",
						);
						return fauxAssistantMessage(
							fauxToolCall("typesafe_review", {
								action: "review",
								review: {
									state: { fixture: evidence },
									questions: {
										q: {
											instructions: "Does the supplied evidence support the fixture?",
											criteria: { supports: "Supported", insufficient: "Missing" },
											expected: "supports",
										},
									},
								},
							}),
							{ stopReason: "toolUse" },
						);
					},
					(context) => {
						expect(
							context.messages.find(
								(message) => message.role === "toolResult" && message.toolName === "typesafe_review",
							),
						).toMatchObject({ isError: status !== 200 });
						const projected = context.messages.find(
							(message) => message.role === "toolResult" && message.toolName === "typesafe_review",
						);
						expect(JSON.stringify(projected?.content)).not.toContain("worker evidence");
						expect(JSON.stringify(context)).not.toContain("worker-fixture-key");
						return fauxAssistantMessage(
							'{"summary":"Reviewed the fixture with Jev.","status":"completed","findings":[]}',
						);
					},
				]);
				const result = await harness.session.runWorkerDelegationOnce({
					instructions: "Review the supplied fixture with Jev.",
					...(capabilities ? { authority: { capabilities, toolNames: ["typesafe_review"] } } : {}),
				});
				if (permitted) {
					expect(result, JSON.stringify(result)).toMatchObject({
						started: true,
						record: { status: appendFailure ? "failed" : "succeeded" },
					});
					expect(fetcher).toHaveBeenCalledTimes(retry ? 2 : 1);
					expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({
						model: "jev-1.13.0",
						state: { fixture: evidence },
					});
					if (!result.started || !result.record) throw new Error("Missing worker record");
					const lifecycle = new WorkerLifecycle({
						agentDir: harness.tempDir,
						sessionId: harness.sessionManager.getSessionId(),
					});
					const agent = lifecycle.getAgent(result.record.agentId!);
					if (!agent) throw new Error("Missing worker agent");
					expect(
						lifecycle.getLatestAgentAttempt(agent.agentId)?.dispatch.executionContract?.worker.authority.budget,
					).toEqual({});
					const conversation = new WorkerConversationStore().open({
						agentDir: harness.tempDir,
						resumeContext: agent.resumeContext,
						expectedLogicalAgentId: agent.agentId,
					});
					const persisted = conversation
						.getRawTranscript()
						.find((message) => message.role === "toolResult" && message.toolName === "typesafe_review");
					const assistantUsage = conversation.getRawTranscript().reduce(
						(usage, message) => {
							if (message.role === "assistant") {
								usage.inputTokens += message.usage.input;
								usage.outputTokens += message.usage.output;
								usage.totalTokens += message.usage.totalTokens;
							}
							return usage;
						},
						{ inputTokens: 0, outputTokens: 0, totalTokens: 0 },
					);
					const expectedUsage = {
						inputTokens: assistantUsage.inputTokens + serviceUsage.inputTokens,
						outputTokens: assistantUsage.outputTokens + serviceUsage.outputTokens,
						totalTokens: assistantUsage.totalTokens + serviceUsage.totalTokens,
					};
					expect(lifecycle.getAttemptUsage(result.record.laneId)).toMatchObject(expectedUsage);
					expect(conversation.getRawTranscriptUsage()).toMatchObject(
						appendFailure ? assistantUsage : expectedUsage,
					);
					if (appendFailure) {
						expect(persisted).toBeUndefined();
						return;
					}
					expect(persisted).toMatchObject({
						details: { accepted, evidence: { id: expect.any(String) } },
						usage: {
							input: serviceUsage.inputTokens,
							output: serviceUsage.outputTokens,
							totalTokens: serviceUsage.totalTokens,
						},
					});
					if (persisted?.role !== "toolResult") throw new Error("Missing review evidence");
					const id = (persisted.details as { evidence: { id: string } }).evidence.id;
					const reopened = TypeSafeEvidenceStore.file(harness.tempDir, harness.sessionManager.getSessionId());
					let offset: number | undefined = 0;
					let archived = "";
					while (offset !== undefined) {
						const page = reopened.read(id, offset);
						archived += page.text;
						offset = page.nextOffset;
					}
					expect(JSON.parse(archived)).toMatchObject({
						record: { accepted, request: { state: { fixture: evidence } } },
					});
					if (retry) {
						expect(JSON.parse(archived)).toMatchObject({
							record: {
								transportAttempts: [
									{ attempt: 1, status: 429, response: { usage: { input_tokens: 7, output_tokens: 3 } } },
									{ attempt: 2, status, response: { usage: { input_tokens: 100, output_tokens: 10 } } },
								],
							},
						});
						expect(fetcher.mock.calls[0][1]?.body).toBe(fetcher.mock.calls[1][1]?.body);
					}
				} else {
					expect(result).toEqual({
						started: false,
						skipReason: "orchestration_tool_capability_missing:typesafe_review",
					});
					expect(fetcher).not.toHaveBeenCalled();
				}
			} finally {
				await harness.cleanup();
			}
		},
	);
});
