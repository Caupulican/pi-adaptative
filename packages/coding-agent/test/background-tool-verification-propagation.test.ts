import type { AgentContext, BackgroundToolCallCompletion, BackgroundToolCallContext } from "@caupulican/pi-agent-core";
import type { AssistantMessage } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	BackgroundToolTaskController,
	type BackgroundToolTaskRecord,
} from "../src/core/background-tool-task-controller.ts";
import type {
	ForegroundRecoveryController,
	ForegroundSubmissionLease,
} from "../src/core/foreground-recovery-controller.ts";
import { ForegroundTerminalHandoffController } from "../src/core/foreground-terminal-handoff-controller.ts";

type VerificationStatus = "failed" | "passed";

function assistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name: "slow", arguments: {} }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function controlledContext(toolCallId: string): {
	context: BackgroundToolCallContext;
	resolveCompletion(completion: BackgroundToolCallCompletion): void;
} {
	let resolveCompletion: ((completion: BackgroundToolCallCompletion) => void) | undefined;
	const completion = new Promise<BackgroundToolCallCompletion>((resolve) => {
		resolveCompletion = resolve;
	});
	const toolCall = { type: "toolCall" as const, id: toolCallId, name: "slow", arguments: {} };
	return {
		context: {
			assistantMessage: assistantMessage(),
			toolCall,
			args: toolCall.arguments,
			context: { systemPrompt: "", messages: [], tools: [] } satisfies AgentContext,
			elapsedMs: 15_000,
			completion,
			cancel: vi.fn(),
		},
		resolveCompletion: resolveCompletion!,
	};
}

function completion(id: string, status: VerificationStatus, isError: boolean): BackgroundToolCallCompletion {
	return {
		toolCall: { type: "toolCall", id: `call-${id}`, name: "slow", arguments: {} },
		result: {
			content: [{ type: "text", text: `${status} ${id}` }],
			details: { piVerification: { version: 1, id, status } },
		},
		isError,
	};
}

function parentTranscriptHarness() {
	const lease = {} as ForegroundSubmissionLease;
	const messages: Array<{ details: unknown }> = [];
	const handoffs = new ForegroundTerminalHandoffController({
		foreground: {
			waitForIdle: vi.fn(async () => undefined),
			tryAcquireSubmission: vi.fn(() => lease),
			releaseSubmission: vi.fn(),
		} as unknown as ForegroundRecoveryController,
		isDisposed: () => false,
		getGoalStateSnapshot: () => undefined,
		startCustomMessageTurn: vi.fn(async (message) => {
			messages.push({ details: message.details });
			return { completion: Promise.resolve() };
		}),
		enqueueCustomMessageTurn: vi.fn(async () => undefined),
		sendCustomMessage: vi.fn(async () => undefined),
		warn: vi.fn(),
	});
	const persisted: BackgroundToolTaskRecord[] = [];
	const controller = new BackgroundToolTaskController({
		getSessionId: () => "session-a",
		getArtifactStore: () => undefined,
		persist: (record) => persisted.push(record),
		notifyTerminal: (records, options) => handoffs.notifyTools(records, options.wakeParent),
	});
	return { controller, messages, persisted };
}

function deliveredVerificationEvents(messages: readonly { details: unknown }[]) {
	return messages.flatMap((message) => {
		const details = message.details as { piVerificationEvents?: unknown[] };
		return details.piVerificationEvents ?? [];
	});
}

describe("background tool verification propagation", () => {
	it("keeps concurrent failures independent and emits a same-id pass that clears only that obligation", async () => {
		const { controller, messages, persisted } = parentTranscriptHarness();
		const alpha = controlledContext("call-alpha");
		const beta = controlledContext("call-beta");
		controller.handoff(alpha.context);
		controller.handoff(beta.context);

		alpha.resolveCompletion(completion("verify-alpha", "failed", true));
		beta.resolveCompletion(completion("verify-beta", "failed", true));
		await controller.waitForNotifications();

		const alphaPass = controlledContext("call-alpha-pass");
		controller.handoff(alphaPass.context);
		alphaPass.resolveCompletion(completion("verify-alpha", "passed", false));
		await controller.waitForNotifications();

		expect(deliveredVerificationEvents(messages)).toEqual([
			{ version: 1, id: "verify-alpha", status: "failed", originTaskId: "tool-task-1" },
			{ version: 1, id: "verify-beta", status: "failed", originTaskId: "tool-task-2" },
			{ version: 1, id: "verify-alpha", status: "passed", originTaskId: "tool-task-3" },
		]);
		expect(messages[0]?.details).toEqual(
			expect.objectContaining({
				records: expect.arrayContaining([
					expect.objectContaining({ taskId: "tool-task-1" }),
					expect.objectContaining({ taskId: "tool-task-2" }),
				]),
			}),
		);
		expect(persisted).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					piVerification: { version: 1, id: "verify-alpha", status: "failed", originTaskId: "tool-task-1" },
				}),
				expect.objectContaining({
					piVerification: { version: 1, id: "verify-beta", status: "failed", originTaskId: "tool-task-2" },
				}),
				expect.objectContaining({
					piVerification: { version: 1, id: "verify-alpha", status: "passed", originTaskId: "tool-task-3" },
				}),
			]),
		);

		const active = new Set<string>();
		for (const event of deliveredVerificationEvents(messages) as Array<{
			id: string;
			status: VerificationStatus;
		}>) {
			if (event.status === "passed") active.delete(event.id);
			else active.add(event.id);
		}
		expect([...active]).toEqual(["verify-beta"]);
		await controller.shutdown();
	});

	it("delivers simultaneous verification failures in bounded terminal handoffs without omitting an obligation", async () => {
		const { controller, messages, persisted } = parentTranscriptHarness();
		const contexts = Array.from({ length: 9 }, (_, index) => controlledContext(`call-batch-${index + 1}`));
		for (const context of contexts) controller.handoff(context.context);
		for (const [index, context] of contexts.entries()) {
			context.resolveCompletion(completion(`verify-batch-${index + 1}`, "failed", true));
		}
		await controller.waitForNotifications();

		const deliveredRecords = messages.flatMap((message) => {
			const details = message.details as { records?: Array<{ taskId: string }> };
			return details.records ?? [];
		});
		const recordsByMessage = messages.map(
			(message) => (message.details as { records: Array<{ taskId: string }> }).records,
		);
		expect(messages).toHaveLength(2);
		expect(recordsByMessage.map((records) => records.length)).toEqual([8, 1]);
		expect(recordsByMessage.map((records) => records.map((record) => record.taskId))).toEqual([
			Array.from({ length: 8 }, (_, index) => `tool-task-${index + 1}`),
			["tool-task-9"],
		]);
		expect(deliveredRecords.map((record) => record.taskId)).toEqual(
			Array.from({ length: 9 }, (_, index) => `tool-task-${index + 1}`),
		);
		expect(deliveredVerificationEvents(messages)).toEqual(
			Array.from({ length: 9 }, (_, index) => ({
				version: 1,
				id: `verify-batch-${index + 1}`,
				status: "failed",
				originTaskId: `tool-task-${index + 1}`,
			})),
		);
		expect(
			persisted.filter((record) => record.terminalDelivery === "delivered").map((record) => record.taskId),
		).toEqual(Array.from({ length: 9 }, (_, index) => `tool-task-${index + 1}`));
		await controller.shutdown();
	});

	it("replays bounded verification metadata after restart and leaves ordinary results unchanged", async () => {
		const pending = {
			sessionId: "session-a",
			taskId: "tool-task-7",
			toolCallId: "call-restart",
			toolName: "slow",
			status: "failed",
			startedAt: "2026-08-21T20:00:00.000Z",
			completedAt: "2026-08-21T20:00:01.000Z",
			elapsedBeforeHandoffMs: 15_000,
			summary: "slow failed",
			output: "failed verification",
			terminalDelivery: "pending",
			piVerification: { version: 1, id: "verify-restart", status: "failed" },
		} as unknown as BackgroundToolTaskRecord;
		const delivered: BackgroundToolTaskRecord[] = [];
		const restored = new BackgroundToolTaskController({
			getSessionId: () => "session-a",
			getArtifactStore: () => undefined,
			loadPersistedRecordsNewestFirst: () => [pending],
			persist: vi.fn(),
			notifyTerminal: (records) => {
				delivered.push(...records);
			},
		});

		await restored.waitForNotifications();
		expect(delivered).toEqual([
			expect.objectContaining({
				piVerification: { version: 1, id: "verify-restart", status: "failed", originTaskId: "tool-task-7" },
			}),
		]);
		await restored.shutdown();

		const { controller, messages } = parentTranscriptHarness();
		const ordinary = controlledContext("call-ordinary");
		controller.handoff(ordinary.context);
		ordinary.resolveCompletion({
			toolCall: ordinary.context.toolCall,
			result: { content: [{ type: "text", text: "ordinary output" }], details: { source: "ordinary" } },
			isError: false,
		});
		await controller.waitForNotifications();

		expect(messages).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({
					records: [expect.not.objectContaining({ piVerification: expect.anything() })],
				}),
			}),
		]);
		expect(deliveredVerificationEvents(messages)).toEqual([]);
		await controller.shutdown();
	});

	it("does not persist or deliver malformed verification metadata", async () => {
		const { controller, messages, persisted } = parentTranscriptHarness();
		const malformed = controlledContext("call-malformed");
		controller.handoff(malformed.context);
		malformed.resolveCompletion({
			toolCall: malformed.context.toolCall,
			result: {
				content: [{ type: "text", text: "malformed verification" }],
				details: { piVerification: { version: 1, id: "x".repeat(129), status: "failed" } },
			},
			isError: true,
		});
		await controller.waitForNotifications();

		expect(persisted.at(-1)).not.toHaveProperty("piVerification");
		expect(deliveredVerificationEvents(messages)).toEqual([]);
		await controller.shutdown();
	});
});
