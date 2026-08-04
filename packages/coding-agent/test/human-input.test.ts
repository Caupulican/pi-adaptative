import { SessionManager } from "@caupulican/pi-agent-core/node";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryArtifactStore } from "../src/core/context/context-artifacts.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import {
	appendHumanInputSnapshot,
	beginHumanInputRequest,
	createHumanInputRequest,
	formatHumanInputAnswerText,
	getResumableHumanInputSnapshot,
	getWorkerHumanInputsRequiringDelivery,
	HUMAN_INPUT_WORKER_RESPONSE_CUSTOM_TYPE,
	resolveHumanInput,
} from "../src/core/human-input.ts";
import { HumanInputController } from "../src/core/human-input-controller.ts";
import { createHarness } from "./suite/harness.ts";

const questions = [
	{
		id: "scope",
		header: "Scope",
		question: "How broad should this be?",
		options: [
			{ label: "Focused", description: "Keep the change narrow." },
			{ label: "Complete", description: "Cover the whole workflow." },
		],
	},
];

function appendToolCall(sessionManager: SessionManager, toolCallId: string): void {
	sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name: "ask_question", arguments: { questions } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	});
}

describe("durable human input", () => {
	it("restores an unanswered tool call and stops restoring after its tool result", () => {
		const sessionManager = SessionManager.inMemory();
		appendToolCall(sessionManager, "call-1");
		const request = createHumanInputRequest({
			source: "tool",
			toolCallId: "call-1",
			toolName: "ask_question",
			questions,
			acceptsImages: true,
			now: () => "2026-01-01T00:00:00.000Z",
		});
		beginHumanInputRequest(sessionManager, request);
		expect(getResumableHumanInputSnapshot(sessionManager)?.request.toolCallId).toBe("call-1");

		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "ask_question",
			content: [{ type: "text", text: "answered" }],
			isError: false,
			timestamp: 2,
		});
		expect(getResumableHumanInputSnapshot(sessionManager)).toBeUndefined();
	});

	it("retains an unrestricted answer as an artifact while keeping prompt output bounded", async () => {
		const sessionManager = SessionManager.inMemory();
		const artifactStore = createInMemoryArtifactStore();
		const request = createHumanInputRequest({
			source: "tool",
			toolCallId: "call-2",
			toolName: "ask_question",
			questions,
			acceptsImages: false,
		});
		beginHumanInputRequest(sessionManager, request);
		const fullAnswer = "exact owner answer\n".repeat(2_000);
		const resolved = await resolveHumanInput({
			sessionManager,
			request,
			artifactStore,
			present: async () => ({
				answers: [
					{
						id: "scope",
						header: "Scope",
						question: questions[0]!.question,
						selected: [],
						custom: fullAnswer,
						skipped: false,
					},
				],
				cancelled: false,
				imageContents: [],
			}),
		});

		const answer = resolved.snapshot.answers[0]!;
		expect(answer.custom?.length).toBeLessThan(fullAnswer.length);
		expect(answer.customArtifact).toBeDefined();
		expect(artifactStore.read(answer.customArtifact!.id)).toMatchObject({ content: fullAnswer });
		expect(formatHumanInputAnswerText(resolved.snapshot)).toContain(
			`artifact tool-output:${answer.customArtifact!.id}`,
		);
	});

	it("rejects malformed host answers instead of trusting RPC-owned question metadata", async () => {
		const sessionManager = SessionManager.inMemory();
		const request = createHumanInputRequest({
			source: "tool",
			toolCallId: "call-invalid",
			questions,
			acceptsImages: false,
		});
		await expect(
			resolveHumanInput({
				sessionManager,
				request,
				present: async () => ({
					answers: [
						{
							id: "scope",
							header: "Forged",
							question: "Forged",
							selected: ["Unknown option"],
							skipped: false,
						},
					],
					cancelled: false,
					imageContents: [],
				}),
			}),
		).rejects.toThrow("unknown option");

		await expect(
			resolveHumanInput({
				sessionManager,
				request,
				present: async () => ({
					answers: [
						{
							id: "scope",
							header: "Forged",
							question: "Forged",
							selected: ["Focused"],
							customArtifact: {
								id: "forged",
								kind: "transcript_slice",
								byteLength: 1,
								createdAtTurn: 0,
								reproducible: false,
							},
							skipped: false,
						},
					],
					cancelled: false,
					imageContents: [],
				}),
			}),
		).rejects.toThrow("artifact references are harness-owned");

		await expect(
			resolveHumanInput({
				sessionManager,
				request,
				present: async () => ({
					answers: [
						{
							id: "scope",
							header: "Scope",
							question: questions[0]!.question,
							selected: ["Focused", "Focused"],
							skipped: false,
						},
					],
					cancelled: false,
					imageContents: [],
				}),
			}),
		).rejects.toThrow("duplicate option");
	});

	it("keeps worker owner responses pending until a context-visible delivery marker exists", () => {
		const sessionManager = SessionManager.inMemory();
		const request = createHumanInputRequest({
			source: "worker",
			workerRequestId: "worker-1",
			questions,
			acceptsImages: false,
		});
		beginHumanInputRequest(sessionManager, request);
		appendHumanInputSnapshot(sessionManager, {
			request,
			status: "answered",
			answers: [
				{
					id: "scope",
					header: "Scope",
					question: questions[0]!.question,
					selected: ["Review now"],
					skipped: false,
				},
			],
			updatedAt: new Date().toISOString(),
		});
		expect(getWorkerHumanInputsRequiringDelivery(sessionManager)).toHaveLength(1);

		sessionManager.appendCustomMessageEntry(HUMAN_INPUT_WORKER_RESPONSE_CUSTOM_TYPE, "delivered", false, {
			requestId: request.requestId,
		});
		expect(getWorkerHumanInputsRequiringDelivery(sessionManager)).toEqual([]);

		const replayed = SessionManager.inMemory();
		const replayedRequest = createHumanInputRequest({
			source: "worker",
			workerRequestId: "worker-replayed",
			questions,
			acceptsImages: false,
		});
		replayed.appendCustomMessageEntry(HUMAN_INPUT_WORKER_RESPONSE_CUSTOM_TYPE, "replayed", false, {
			requestId: replayedRequest.requestId,
		});
		beginHumanInputRequest(replayed, replayedRequest);
		expect(getWorkerHumanInputsRequiringDelivery(replayed)).toEqual([]);
	});

	it("indexes appended worker-input state without rescanning the long active branch", () => {
		const sessionManager = SessionManager.inMemory();
		const controller = new HumanInputController({
			getSessionManager: () => sessionManager,
			getUIContext: () => ({}) as ExtensionUIContext,
			getExtensionMode: () => "rpc",
			waitForIdle: async () => {},
			isDisposed: () => false,
			isStreaming: () => false,
			getModel: () => undefined,
			getArtifactStore: createInMemoryArtifactStore,
			getImageStore: () => undefined,
			runAgentPrompt: async () => {},
			sendCustomMessage: async () => {},
			emitWarning: () => {},
		});
		const branchSpy = vi.spyOn(sessionManager, "getBranch");
		const entrySpy = vi.spyOn(sessionManager, "getEntry");
		const request = createHumanInputRequest({
			source: "worker",
			workerRequestId: "worker-long-session",
			questions,
			acceptsImages: false,
		});
		beginHumanInputRequest(sessionManager, request);
		const requestLeafId = sessionManager.getLeafId();
		if (!requestLeafId) throw new Error("Worker request entry was not persisted");

		expect(controller.workerInputsWillWakeParent(["worker-long-session"])).toBe(true);
		expect(branchSpy).toHaveBeenCalledTimes(1);
		for (let index = 0; index < 1_000; index++) {
			sessionManager.appendCustomEntry("unrelated-long-session-state", { index });
			expect(controller.workerInputsWillWakeParent(["worker-long-session"])).toBe(true);
		}

		expect(branchSpy).toHaveBeenCalledTimes(1);
		expect(entrySpy).toHaveBeenCalledTimes(1_000);
		sessionManager.appendCustomMessageEntry(HUMAN_INPUT_WORKER_RESPONSE_CUSTOM_TYPE, "delivered", false, {
			requestId: request.requestId,
		});
		expect(controller.workerInputsWillWakeParent(["worker-long-session"])).toBe(false);
		expect(controller.workerInputsWillWakeParent(["negative-control-worker"])).toBe(false);
		expect(branchSpy).toHaveBeenCalledTimes(1);
		expect(entrySpy).toHaveBeenCalledTimes(1_001);

		sessionManager.branch(requestLeafId);
		expect(controller.workerInputsWillWakeParent(["worker-long-session"])).toBe(true);
		expect(branchSpy).toHaveBeenCalledTimes(2);
	});

	it("replays the original tool call through AgentSession after a restart boundary", async () => {
		const harness = await createHarness({
			models: [{ id: "vision-model", contextWindow: 128_000, input: ["text", "image"] }],
			settings: { images: { clipboardDirectory: "captures" } },
		});
		try {
			const toolCall = fauxAssistantMessage(fauxToolCall("ask_question", { questions }, { id: "call-resume" }), {
				stopReason: "toolUse",
			});
			harness.session.agent.state.messages = [toolCall];
			harness.sessionManager.appendMessage(toolCall);
			const request = createHumanInputRequest({
				source: "tool",
				toolCallId: "call-resume",
				toolName: "ask_question",
				questions,
				acceptsImages: true,
			});
			beginHumanInputRequest(harness.sessionManager, request);
			let presentations = 0;
			const baseUi = harness.session.extensionRunner.getUIContext();
			await harness.session.bindExtensions({
				mode: "rpc",
				uiContext: {
					...baseUi,
					askQuestions: async () => {
						presentations++;
						return {
							answers: [
								{
									id: "scope",
									header: "Scope",
									question: questions[0]!.question,
									selected: ["Focused"],
									custom: "Review [RPC image]",
									images: [{ label: "[RPC image]", mimeType: "image/png" }],
									skipped: false,
								},
							],
							cancelled: false,
							imageContents: [
								{
									type: "image" as const,
									data: Buffer.from([1, 2, 3]).toString("base64"),
									mimeType: "image/png",
								},
							],
						};
					},
				},
			});
			harness.setResponses([fauxAssistantMessage("continued")]);

			expect(await harness.session.resumePendingHumanInput()).toBe(true);
			expect(presentations).toBe(1);
			expect(harness.session.messages.map((message) => message.role)).toEqual([
				"assistant",
				"toolResult",
				"assistant",
			]);
			const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
			expect(toolResult?.content).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ type: "text", text: expect.stringContaining("[Image #1]") }),
					{ type: "image", data: Buffer.from([1, 2, 3]).toString("base64"), mimeType: "image/png" },
				]),
			);
			expect(getResumableHumanInputSnapshot(harness.sessionManager)).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});
});
