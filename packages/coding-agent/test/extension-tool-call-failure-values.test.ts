import { writeFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionError, ExtensionFactory } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ToolPerformanceStore } from "../src/core/tool-selection/tool-performance-store.ts";
import { createReadTool } from "../src/core/tools/read.ts";
import { createHarness, getMessageText } from "./suite/harness.ts";
import { createTestExtensionsResult } from "./suite/test-resources.ts";

async function makeRunner(factory: ExtensionFactory) {
	const loaded = await createTestExtensionsResult([factory]);
	return new ExtensionRunner(
		loaded.extensions,
		loaded.runtime,
		process.cwd(),
		SessionManager.inMemory(),
		ModelRegistry.inMemory(AuthStorage.inMemory()),
	);
}

describe("tool_call failure presence", () => {
	it.each([undefined, null, false, 0, "", new Error("ordinary failure")])(
		"rejects a handler failure with value %j while running later handlers",
		async (failure) => {
			const later = vi.fn();
			const errors: ExtensionError[] = [];
			const runner = await makeRunner((pi) => {
				pi.on("tool_call", () => {
					throw failure;
				});
				pi.on("tool_call", () => {
					later();
					return { block: false };
				});
			});
			runner.onError((error) => errors.push(error));
			await expect(
				runner.emitToolCall({ type: "tool_call", toolName: "read", toolCallId: "failure", input: {} }),
			).rejects.toBe(failure);
			expect(later).toHaveBeenCalledOnce();
			expect(errors).toHaveLength(1);
			expect(errors[0].error).toBe(failure instanceof Error ? failure.message : String(failure));
		},
	);

	it.each([undefined, new Error("first failure")])("keeps the first failure identity (%j)", async (first) => {
		const second = new Error("second failure");
		const errors: ExtensionError[] = [];
		const later = vi.fn();
		const runner = await makeRunner((pi) => {
			for (const failure of [first, second]) {
				pi.on("tool_call", () => {
					throw failure;
				});
			}
			pi.on("tool_call", later);
		});
		runner.onError((error) => errors.push(error));
		await expect(
			runner.emitToolCall({ type: "tool_call", toolName: "read", toolCallId: "ordered", input: {} }),
		).rejects.toBe(first);
		expect(later).toHaveBeenCalledOnce();
		expect(errors.map((error) => error.error)).toEqual([
			first instanceof Error ? first.message : String(first),
			second.message,
		]);
	});

	it("allows a normal undefined return without reporting an exception", async () => {
		const errors = vi.fn();
		const runner = await makeRunner((pi) => pi.on("tool_call", () => undefined));
		runner.onError(errors);
		await expect(
			runner.emitToolCall({ type: "tool_call", toolName: "read", toolCallId: "control", input: {} }),
		).resolves.toBeUndefined();
		expect(errors).not.toHaveBeenCalled();
	});

	it.each(
		[false, true].flatMap((listenerThrows) =>
			[undefined, null, false, 0, "", new Error("authorization failed"), "normal return"].map((failure) => ({
				listenerThrows,
				failure,
				throws: failure !== "normal return",
			})),
		),
	)(
		"fences real read I/O (failure=$failure, listenerThrows=$listenerThrows)",
		async ({ throws, failure, listenerThrows }) => {
			const reads = vi.fn((path: string) => readFile(path));
			const later = vi.fn();
			const diagnostic = vi.fn(() => {
				if (listenerThrows) throw new Error("diagnostic failure");
			});
			let providerResult: { isError: boolean; text: string } | undefined;
			const harness = await createHarness({
				initialActiveToolNames: ["read"],
				baseToolsOverride: [createReadTool(process.cwd(), { operations: { readFile: reads, access } })],
				extensionFactories: [
					(pi) => {
						pi.on("tool_call", () => {
							if (throws) throw failure;
						});
						pi.on("tool_call", later);
					},
				],
			});
			try {
				await harness.session.bindExtensions({ onError: diagnostic });
				const path = join(harness.tempDir, "fixture.txt");
				writeFileSync(path, "controlled fixture");
				harness.setResponses([
					fauxAssistantMessage(fauxToolCall("read", { path }), { stopReason: "toolUse" }),
					(context) => {
						const result = context.messages.find((message) => message.role === "toolResult");
						if (result?.role === "toolResult") {
							providerResult = { isError: result.isError, text: getMessageText(result) };
						}
						return fauxAssistantMessage("Done.");
					},
				]);
				await harness.session.prompt("Read the fixture.");
				expect(later).toHaveBeenCalledOnce();
				expect(diagnostic).toHaveBeenCalledTimes(throws ? 1 : 0);
				expect(harness.eventsOfType("tool_execution_end")).toHaveLength(1);
				expect.soft(harness.eventsOfType("tool_execution_end")[0].isError).toBe(throws);
				expect(reads.mock.calls.map(([path]) => path)).toEqual(throws ? [] : [path]);
				expect(providerResult?.isError).toBe(throws);
				if (!throws) expect(providerResult?.text).toContain("controlled fixture");
				await harness.session.disposeAndWait();
				const reader = ToolPerformanceStore.forAgentDir(harness.tempDir, { readOnly: true });
				try {
					const modelRef = `${harness.getModel().provider}/${harness.getModel().id}`;
					expect(reader.get({ modelRef, intentClass: "read", tool: "read" }).sampleCount).toBe(throws ? 0 : 1);
					expect(reader.getObservations(modelRef)).toHaveLength(throws ? 0 : 1);
				} finally {
					reader.close();
				}
			} finally {
				await harness.cleanup();
			}
		},
	);
});
