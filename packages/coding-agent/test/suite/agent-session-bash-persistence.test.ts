import { Buffer } from "node:buffer";
import type { AgentTool } from "@caupulican/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { CURRENT_TURN_REFLECTION_STATE_CUSTOM_TYPE } from "../../src/core/reflection-controller.ts";
import type { BashOperations } from "../../src/core/tools/bash.ts";
import { createHarness, type Harness } from "./harness.ts";

function getEntryTypes(harness: Harness): string[] {
	return harness.sessionManager.getEntries().map((entry) => entry.type);
}

describe("AgentSession bash and persistence characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("records bash results immediately while idle", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.session.recordBashResult("echo hi", {
			output: "hi",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});

		expect(harness.session.hasPendingBashMessages).toBe(false);
		expect(harness.session.messages[harness.session.messages.length - 1]?.role).toBe("bashExecution");
		expect(getEntryTypes(harness)).toContain("message");
	});

	it("defers bash results while streaming and flushes them before the next prompt", async () => {
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return {
					content: [{ type: "text", text: "released" }],
					details: {},
				};
			},
		};
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("after flush"),
		]);

		const sawToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const firstPrompt = harness.session.prompt("start");
		await sawToolStart;
		harness.session.recordBashResult("echo hi", {
			output: "hi",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});

		expect(harness.session.hasPendingBashMessages).toBe(true);
		expect(harness.session.messages.some((message) => message.role === "bashExecution")).toBe(false);

		releaseToolExecution?.();
		await firstPrompt;

		expect(harness.session.hasPendingBashMessages).toBe(false);
		expect(harness.session.messages.some((message) => message.role === "bashExecution")).toBe(true);

		await harness.session.prompt("next turn");

		expect(harness.session.hasPendingBashMessages).toBe(false);
		expect(harness.session.messages.some((message) => message.role === "bashExecution")).toBe(true);
		expect(getEntryTypes(harness).filter((type) => type === "message").length).toBeGreaterThan(0);
	});

	it("executes bash commands and records the result", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const result = await harness.session.executeBash("printf 'hello'");

		expect(result.output).toContain("hello");
		expect(harness.session.messages[harness.session.messages.length - 1]?.role).toBe("bashExecution");
	});

	it("cancels running bash commands with abortBash", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				return await new Promise<{ exitCode: number | null }>((_resolve, reject) => {
					options.signal?.addEventListener(
						"abort",
						() => {
							reject(new Error("aborted"));
						},
						{ once: true },
					);
				});
			},
		};

		const bashPromise = harness.session.executeBash("sleep", undefined, { operations });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(harness.session.isBashRunning).toBe(true);
		harness.session.abortBash();

		const result = await bashPromise;
		expect(result.cancelled).toBe(true);
		expect(harness.session.isBashRunning).toBe(false);
	});

	it("persists user, assistant, toolResult, and custom messages in order", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
			},
		};
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.sendCustomMessage({
			customType: "note",
			content: "hello",
			display: true,
			details: { a: 1 },
		});
		await harness.session.prompt("start");

		const entries = harness.sessionManager.getEntries();
		expect(entries.map((entry) => entry.type)).toEqual([
			"custom_message",
			"custom",
			"message",
			"request_snapshot",
			"message",
			"foreground_tool_start",
			"message",
			"foreground_tool_terminal",
			"request_snapshot",
			"message",
			"custom",
		]);
		// Two provider requests, and the reflection cue was delivered on neither: it is queued `pending`
		// when the turn starts and only becomes `due` at the turn's end-of-work boundary, to be carried
		// by the next ordinary request. No `consumed` state is written here because nothing consumed it.
		const reflectionCueStates = entries.filter(
			(entry) => entry.type === "custom" && entry.customType === CURRENT_TURN_REFLECTION_STATE_CUSTOM_TYPE,
		);
		expect(reflectionCueStates).toMatchObject([{ data: { status: "pending" } }, { data: { status: "due" } }]);
		expect(reflectionCueStates[1]).not.toMatchObject({ data: { activeRunToken: expect.any(String) } });
		expect(entries.some((entry) => entry.type === "custom" && entry.customType === "tool_argument_validation")).toBe(
			false,
		);
		expect(harness.session.messages.map((message) => message.role)).toEqual([
			"custom",
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
	});

	it("does not emit message_end for bash execution messages", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const messageEndRoles: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "message_end") {
				messageEndRoles.push(event.message.role);
			}
		});

		harness.session.recordBashResult("echo hi", {
			output: "hi",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});

		expect(messageEndRoles).toEqual([]);
	});

	it("persists aborted assistant messages", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("x".repeat(20_000))]);

		const sawMessageUpdate = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "message_update") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("hi");
		await sawMessageUpdate;
		await harness.session.abort();
		await promptPromise;

		const entries = harness.sessionManager.getEntries();
		const lastMessageEntry = entries.filter((entry) => entry.type === "message").at(-1);
		expect(lastMessageEntry?.type).toBe("message");
		if (lastMessageEntry?.type === "message") {
			expect(lastMessageEntry.message.role).toBe("assistant");
			if (lastMessageEntry.message.role === "assistant") {
				expect(lastMessageEntry.message.stopReason).toBe("aborted");
			}
		}
		// An aborted turn is still a turn whose work ended, so its undelivered cue is promoted to `due`
		// rather than consumed — the abort means no provider request ever carried it.
		const finalEntry = entries.at(-1);
		expect(finalEntry).toMatchObject({
			type: "custom",
			customType: CURRENT_TURN_REFLECTION_STATE_CUSTOM_TYPE,
			data: { status: "due" },
		});
		if (finalEntry?.type === "custom") {
			expect(finalEntry.data).not.toMatchObject({ activeRunToken: expect.any(String) });
		}
	});

	it("records bash output through custom operations", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				options.onData(Buffer.from("hello from custom ops"));
				return { exitCode: 0 };
			},
		};

		const result = await harness.session.executeBash("custom", undefined, { operations });

		expect(result.output).toContain("hello from custom ops");
		expect(harness.session.messages[harness.session.messages.length - 1]?.role).toBe("bashExecution");
	});
});
