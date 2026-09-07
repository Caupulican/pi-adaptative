import {
	type AgentRequestId,
	type BackgroundToolCallCompletion,
	captureExecutionContext,
	type ExecutionContext,
	getToolExecutionKey,
	type ToolInvocationReceipt,
} from "@caupulican/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
	BackgroundToolTaskController,
	type BackgroundToolTaskRecord,
	backgroundToolInvocationObservations,
	createBackgroundToolTerminalMessage,
} from "../src/core/background-tool-task-controller.ts";

// Synthetic evidence only: no private transcripts, paths, provider payloads, or runtime identities.
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

function start(controller: BackgroundToolTaskController, executionContext?: ExecutionContext) {
	const completion = Promise.withResolvers<BackgroundToolCallCompletion>();
	const toolCall = { type: "toolCall" as const, id: "fixture-call", name: "fixture", arguments: {} };
	const handoff = controller.handoff({
		requestId,
		executionContext,
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
	const binding = captureExecutionContext({
		attachment: {
			workspaceId: "synthetic-workspace",
			attachmentId: "synthetic-attachment",
			root: "Q:\\synthetic project 日本語",
			flavor: "win32",
			caseSensitive: false,
		},
		sessionId: "fixture-session",
		taskId: "step-2",
		generation: 3,
		cwd: "Q:\\synthetic project 日本語\\package",
	});
	const scope = getToolExecutionKey("context", binding);

	it("refuses a foreign-session context before publishing a background task", async () => {
		const original = harness();
		expect(() => start(original.controller, { ...binding, sessionId: "foreign-session" })).toThrow("session");
		expect(original.persisted).toEqual([]);
		expect(original.controller.list()).toEqual([]);
		await original.controller.shutdown();
	});

	it.each(["matching", "foreign", "absent", "unknown"] as const)(
		"fences directory evidence across handoff, completion, notification and restart: %s",
		async (mode) => {
			const original = harness();
			const mutable = { ...binding, attachment: { ...binding.attachment } };
			const { completion, toolCall } = start(original.controller, mutable);
			const running = original.persisted[0]!;
			expect(running).toMatchObject({ executionContext: binding, piToolInvocation: { executionScope: scope } });
			mutable.cwd = "Q:\\another project";
			mutable.attachment.attachmentId = "new-attachment";
			const supplied =
				mode === "absent"
					? undefined
					: mode === "unknown"
						? { version: 1, requestId, execution: "unknown", postprocessingFailures: [], executionScope: scope }
						: { ...receipt, executionScope: mode === "foreign" ? `context:${"b".repeat(32)}` : scope };
			completion.resolve({
				toolCall,
				isError: false,
				result: {
					content: [],
					details: { piToolInvocation: supplied, piVerification: { version: 1, id: "check", status: "passed" } },
				},
			});
			const terminal = await original.controller.wait("tool-task-1");
			await original.controller.waitForNotifications();
			const restored = harness(JSON.parse(JSON.stringify([...original.persisted].reverse())));
			for (const record of [terminal, original.notifications[0], restored.controller.list()[0]]) {
				expect(record).toMatchObject({
					executionContext: binding,
					piToolInvocation: { executionScope: scope, execution: mode === "matching" ? "completed" : "unknown" },
				});
				expect(record?.piVerification?.status).toBe(mode === "matching" ? "passed" : undefined);
			}
			expect(createBackgroundToolTerminalMessage([terminal]).details.records[0]).toMatchObject({
				executionContext: binding,
			});
			await restored.controller.shutdown();
			await original.controller.shutdown();
		},
	);

	it.each(["shutdown", "restart", "rejection"] as const)(
		"retains admitted scope after %s without inventing completion",
		async (mode) => {
			const original = harness();
			const { completion } = start(original.controller, binding);
			const target = mode === "restart" ? harness(JSON.parse(JSON.stringify(original.persisted))) : original;
			if (mode === "shutdown") await target.controller.shutdown();
			if (mode === "rejection") completion.reject(new Error("Synthetic process loss"));
			const terminal = await target.controller.wait("tool-task-1");
			expect(terminal).toMatchObject({
				executionContext: binding,
				piToolInvocation: { execution: "unknown", executionScope: scope },
			});
			await target.controller.shutdown();
			await original.controller.shutdown();
		},
	);

	it.each(["generation", "accessor"] as const)(
		"rejects a contradictory restored binding without reviving its older success: %s",
		async (mode) => {
			const original = harness();
			const { completion, toolCall } = start(original.controller, binding);
			completion.resolve({
				toolCall,
				isError: false,
				result: { content: [], details: { piToolInvocation: { ...receipt, executionScope: scope } } },
			});
			await original.controller.wait("tool-task-1");
			await original.controller.waitForNotifications();
			const older = original.persisted.at(-1)!;
			const contradictory =
				mode === "generation"
					? { ...older, executionContext: { ...binding, generation: 4 } }
					: Object.defineProperty({ ...older }, "executionContext", {
							get: () => {
								throw new Error("Must not evaluate context accessor");
							},
						});
			const restored = harness([contradictory, older]);
			expect(restored.controller.list()).toEqual([]);
			await restored.controller.shutdown();
			await original.controller.shutdown();
		},
	);

	it("does not restore or project passing verification backed only by unknown scoped execution", async () => {
		const original = harness();
		const { completion, toolCall } = start(original.controller, binding);
		completion.resolve({
			toolCall,
			isError: false,
			result: { content: [], details: { piToolInvocation: { ...receipt, executionScope: scope } } },
		});
		await original.controller.wait("tool-task-1");
		await original.controller.waitForNotifications();
		const contradictory = {
			...original.persisted.at(-1)!,
			piToolInvocation: {
				version: 1 as const,
				requestId,
				execution: "unknown" as const,
				executionScope: scope,
				postprocessingFailures: [],
			},
			piVerification: { version: 1 as const, id: "check", status: "passed" as const, originTaskId: "tool-task-1" },
		};
		const restored = harness([contradictory]);
		expect(restored.controller.list()[0]?.piVerification).toBeUndefined();
		expect(createBackgroundToolTerminalMessage([contradictory]).details.piVerificationEvents).toEqual([]);
		await restored.controller.shutdown();
		await original.controller.shutdown();
	});
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
