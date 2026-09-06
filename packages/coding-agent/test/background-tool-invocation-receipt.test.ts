import type { AgentRequestId, BackgroundToolCallCompletion, ToolInvocationReceipt } from "@caupulican/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
	BackgroundToolTaskController,
	type BackgroundToolTaskRecord,
	backgroundToolInvocationObservations,
	createBackgroundToolTerminalMessage,
} from "../src/core/background-tool-task-controller.ts";

// Synthetic evidence only: no transcripts, paths, provider payloads, or runtime identities.
const requestId = "fixture-request" as AgentRequestId;
const receipt: ToolInvocationReceipt = {
	version: 1,
	requestId,
	execution: "completed",
	operationStatus: "success",
	postprocessingFailures: ["progress"],
};

function harness(load: readonly unknown[] = []) {
	const persisted: BackgroundToolTaskRecord[] = [];
	const notifications: BackgroundToolTaskRecord[] = [];
	const controller = new BackgroundToolTaskController({
		getSessionId: () => "fixture-session",
		getArtifactStore: () => undefined,
		loadPersistedRecordsNewestFirst: () => load,
		persist: (record) => {
			persisted.push(record);
		},
		notifyTerminal: (records) => {
			notifications.push(...records);
		},
	});
	return { controller, persisted, notifications };
}

function start(controller: BackgroundToolTaskController) {
	const completion = Promise.withResolvers<BackgroundToolCallCompletion>();
	const toolCall = { type: "toolCall" as const, id: "fixture-call", name: "fixture", arguments: {} };
	const handoff = controller.handoff({
		requestId,
		toolCall,
		assistantMessage: {
			role: "assistant",
			content: [toolCall],
			api: "openai-responses",
			provider: "fixture",
			model: "fixture",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 0,
		},
		args: {},
		context: { systemPrompt: "", messages: [], tools: [] },
		elapsedMs: 1,
		completion: completion.promise,
		cancel: () => {},
	});
	expect(handoff).toBeDefined();
	return { completion, toolCall };
}

describe("background invocation evidence", () => {
	it("decodes only bounded terminal notification data without opening unrelated payloads or accessors", () => {
		const record = { toolCallId: "fixture-call", status: "completed", piToolInvocation: receipt };
		const message = { customType: "background-tool-completion", details: { records: [record] } };
		expect(backgroundToolInvocationObservations(message)).toEqual([
			{ toolCallId: "fixture-call", isError: false, details: record },
		]);
		expect(backgroundToolInvocationObservations({ ...message, customType: "unrelated" })).toEqual([]);
		expect(
			backgroundToolInvocationObservations({
				...message,
				details: { records: Array.from({ length: 9 }, () => record) },
			}),
		).toEqual([]);
		const malicious = Object.defineProperty({}, "toolCallId", {
			get: () => {
				throw new Error("must not read getter");
			},
		});
		expect(
			backgroundToolInvocationObservations({
				...message,
				details: { records: [malicious, { ...record, status: "running" }] },
			}),
		).toEqual([]);
	});
	it.each(["completed", "unknown", "absent", "mismatched"] as const)(
		"retains only bound evidence through notification and restart: %s",
		async (mode) => {
			const original = harness();
			const { completion, toolCall } = start(original.controller);
			const supplied =
				mode === "unknown"
					? { version: 1, requestId, execution: "unknown", postprocessingFailures: ["after_hook"] }
					: mode === "mismatched"
						? { ...receipt, requestId: "another-request" }
						: receipt;
			completion.resolve({
				toolCall,
				isError: mode === "unknown",
				result: { content: [], details: mode === "absent" ? {} : { piToolInvocation: supplied } },
			});
			const terminal = await original.controller.wait("tool-task-1");
			await original.controller.waitForNotifications();
			const expected =
				mode === "absent" || mode === "mismatched"
					? { version: 1, requestId, execution: "unknown", postprocessingFailures: [] }
					: supplied;
			expect(terminal.piToolInvocation).toEqual(expected);
			expect(original.notifications[0]?.piToolInvocation).toEqual(expected);
			expect(createBackgroundToolTerminalMessage([terminal]).details.records[0]?.piToolInvocation).toEqual(expected);
			const restored = harness(JSON.parse(JSON.stringify([...original.persisted].reverse())));
			expect(restored.controller.list()[0]?.piToolInvocation).toEqual(expected);
			await restored.controller.shutdown();
			await original.controller.shutdown();
		},
	);

	it("restart fences an in-flight operation without inventing completion or rerunning it", async () => {
		const original = harness();
		start(original.controller);
		expect(original.persisted[0]?.piToolInvocation?.execution).toBe("running");
		const restored = harness(JSON.parse(JSON.stringify(original.persisted)));
		expect(restored.controller.list()[0]).toMatchObject({
			status: "failed",
			piToolInvocation: { execution: "unknown", requestId },
		});
		await restored.controller.shutdown();
		await original.controller.shutdown();
	});

	it("malformed latest evidence cannot resurrect an older success", async () => {
		const original = harness();
		const { completion, toolCall } = start(original.controller);
		completion.resolve({ toolCall, isError: false, result: { content: [], details: { piToolInvocation: receipt } } });
		await original.controller.wait("tool-task-1");
		await original.controller.waitForNotifications();
		const older = original.persisted.at(-1)!;
		const restored = harness([{ ...older, piToolInvocation: { ...receipt, operationStatus: "invented" } }, older]);
		expect(restored.controller.list()).toEqual([]);
		await restored.controller.shutdown();
		await original.controller.shutdown();
	});
});
