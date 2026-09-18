import { createEmptyUsage, readAgentToolExecutionError, retainedToolInvocation, runAgentLoop } from "@caupulican/pi-agent-core";
import { AssistantMessageEventStream } from "@caupulican/pi-ai/event-stream";
import type { Model } from "@caupulican/pi-ai/types";
import { describe, expect, it, vi } from "vitest";
import type { ScriptExecution } from "../src/core/toolkit/script-runner.ts";
import { createRunToolkitScriptToolDefinition } from "../src/core/tools/run-toolkit-script.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";

const model: Model<"openai-responses"> = {
	id: "fixture", name: "fixture", api: "openai-responses", provider: "fixture", baseUrl: "https://example.invalid",
	reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
};

function fixture(execute: () => Promise<ScriptExecution>) {
	return wrapToolDefinition(createRunToolkitScriptToolDefinition({
		getScripts: () => [{ name: "fixture", description: "Synthetic fixture", runner: "bash", path: "fixture.sh" }], execute,
	}));
}

describe("toolkit execution classification in the real core loop", () => {
	it.each([
		{ name: "success", exitCode: 0, timedOut: false, completed: true, native: false, failureCode: undefined },
		{ name: "negative", exitCode: 3, timedOut: false, completed: true, native: true, failureCode: undefined },
		{ name: "deadline", exitCode: null, timedOut: true, completed: true, native: true, failureCode: "timeout" },
		{ name: "deadline_zero", exitCode: 0, timedOut: true, completed: true, native: true, failureCode: "timeout" },
		{ name: "missing_exit", exitCode: null, timedOut: false, completed: false, native: false, failureCode: "toolkit_execution_incomplete" },
		{ name: "nan_exit", exitCode: Number.NaN, timedOut: false, completed: false, native: false, failureCode: "toolkit_execution_incomplete" },
		{ name: "infinite_exit", exitCode: Infinity, timedOut: false, completed: false, native: false, failureCode: "toolkit_execution_incomplete" },
		{ name: "unsafe_exit", exitCode: Number.MAX_SAFE_INTEGER + 1, timedOut: false, completed: false, native: false, failureCode: "toolkit_execution_incomplete" },
		{ name: "fractional_exit", exitCode: 0.5, timedOut: false, completed: false, native: false, failureCode: "toolkit_execution_incomplete" },
		{ name: "canceled", exitCode: null, timedOut: false, completed: false, native: false, failureCode: "aborted" },
		{ name: "late_abort", exitCode: 0, timedOut: false, completed: true, native: false, failureCode: undefined },
	])("keeps $name distinct from other terminal kinds", async ({ name, exitCode, timedOut, completed, native, failureCode }) => {
		const abort = new AbortController();
		const execute = vi.fn(async () => {
			if (name === "canceled" || name === "late_abort") abort.abort("fixture-stop");
			return { exitCode, timedOut, stdout: "actual stdout", stderr: "actual stderr", durationMs: 10 };
		});
		const tool = fixture(execute);
		const messages = await runAgentLoop(
			[{ role: "user", content: "Run fixture", timestamp: 0 }], { systemPrompt: "Fixture", messages: [], tools: [tool] },
			{
				model, maxProviderTurns: 1,
				convertToLlm: (history) => history.filter((message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult"),
			}, () => {}, abort.signal,
			() => {
				const stream = new AssistantMessageEventStream();
				stream.push({ type: "done", reason: "toolUse", message: {
					role: "assistant", api: model.api, provider: model.provider, model: model.id, usage: createEmptyUsage(), timestamp: 0,
					stopReason: "toolUse", content: [{ type: "toolCall", id: "fixture-call", name: tool.name, arguments: { script: "fixture" } }],
				} });
				return stream;
			},
		);
		const result = messages.find((message) => message.role === "toolResult");
		expect(execute).toHaveBeenCalledOnce();
		expect(result).toBeDefined();
		const receipt = retainedToolInvocation(result?.details);
		expect(receipt).toMatchObject({ execution: completed ? "completed" : "unknown" });
		if (completed) expect(receipt).toMatchObject({ operationStatus: native ? "error" : "success" });
		if (failureCode) expect(receipt).toMatchObject({ failureCode });
		expect(result?.isError).toBe(native || !completed);
		if (native) expect(result?.errorKind).toBe("operation_outcome");
		const text = result?.content.filter((block) => block.type === "text").map((block) => block.text).join("\n") ?? "";
		expect(text).toContain("actual stdout");
		expect(text).toContain("actual stderr");
		if (completed || name === "canceled") expect(text).not.toContain("MUST");
		else expect(text).toContain("MUST");
	});

	it("identifies captured output independently of display duration", async () => {
		const signatures: string[] = [];
		for (const output of [
			{ stdout: "same stdout", stderr: "same stderr", durationMs: 10 },
			{ stdout: "same stdout", stderr: "same stderr", durationMs: 200 },
			{ stdout: "a", stderr: "bc", durationMs: 10 },
			{ stdout: "ab", stderr: "c", durationMs: 10 },
		]) {
			const tool = fixture(async () => ({ exitCode: null, timedOut: true, ...output }));
			try {
				await tool.execute("fixture-call", { script: "fixture" });
				throw new Error("Expected structured timeout");
			} catch (error) {
				const failure = readAgentToolExecutionError(error);
				expect(failure).toMatchObject({ failureCode: "timeout", errorKind: "operation_outcome" });
				expect(failure?.outputSignature).toMatch(/^[a-f0-9]{64}$/);
				signatures.push(failure!.outputSignature);
			}
		}
		expect(signatures[0]).toBe(signatures[1]);
		expect(signatures[0]).not.toBe(signatures[2]);
		expect(signatures[2]).not.toBe(signatures[3]);
	});
});
