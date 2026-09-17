import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import type { ToolResultMessage } from "@caupulican/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionFactory, ToolResultEvent } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
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

describe("extension diagnostic listener isolation", () => {
	it.each([
		["null prototype", () => Object.create(null)],
		[
			"throwing coercion",
			() => ({
				[Symbol.toPrimitive]: () => {
					throw new Error("coercion failed");
				},
			}),
		],
		[
			"throwing message",
			() =>
				Object.defineProperty(new Error(), "message", {
					get: () => {
						throw new Error("message failed");
					},
				}),
		],
		[
			"throwing stack",
			() =>
				Object.defineProperty(new Error("original message"), "stack", {
					get: () => {
						throw new Error("stack failed");
					},
				}),
		],
	] as const)("keeps failure identity and handler execution when reporting %s", async (_name, makeFailure) => {
		const failure: unknown = makeFailure();
		const later = vi.fn();
		const diagnostic = vi.fn();
		const runner = await makeRunner((pi) => {
			pi.on("tool_call", () => {
				throw failure;
			});
			pi.on("tool_call", later);
		});
		runner.onError(diagnostic);
		await expect(
			runner.emitToolCall({ type: "tool_call", toolCallId: "unprintable", toolName: "write", input: {} }),
		).rejects.toBe(failure);
		expect(later).toHaveBeenCalledOnce();
		expect(diagnostic).toHaveBeenCalledOnce();
		expect(diagnostic.mock.calls[0][0].error).toEqual(expect.any(String));
	});

	for (const listenerThrows of [false, true]) {
		it.each([undefined, new Error("authorization failure")])(
			`retains the first failure and visits later handlers/listeners (listenerThrows=${listenerThrows}, failure=%j)`,
			async (failure) => {
				const laterHandler = vi.fn();
				const laterListener = vi.fn();
				const runner = await makeRunner((pi) => {
					pi.on("tool_call", () => {
						throw failure;
					});
					pi.on("tool_call", laterHandler);
				});
				runner.onError(() => {
					if (listenerThrows) throw new Error("diagnostic sink failed");
				});
				const unsubscribe = runner.onError(laterListener);
				await expect(
					runner.emitToolCall({ type: "tool_call", toolCallId: "guarded", toolName: "write", input: {} }),
				).rejects.toBe(failure);
				expect(laterHandler).toHaveBeenCalledOnce();
				expect(laterListener).toHaveBeenCalledOnce();
				unsubscribe();
				await expect(
					runner.emitToolCall({ type: "tool_call", toolCallId: "unsubscribed", toolName: "write", input: {} }),
				).rejects.toBe(failure);
				expect(laterListener).toHaveBeenCalledOnce();
			},
		);
	}

	it.each(
		["return", "throw", "reject"].flatMap((listenerMode) =>
			["ordinary", "unprintable", "no failure"].map((failure) => ({ listenerMode, failure })),
		),
	)(
		"delivers a completed real write (listenerMode=$listenerMode, failure=$failure)",
		async ({ listenerMode, failure }) => {
			const delivered: ToolResultMessage[] = [];
			const laterResultHandler = vi.fn((event: ToolResultEvent) => ({
				content: [...event.content, { type: "text" as const, text: "later projection applied" }],
			}));
			const diagnostic = vi.fn(() => {
				if (listenerMode === "throw") throw new Error("diagnostic sink failed");
				if (listenerMode === "reject") return Promise.reject(new Error("diagnostic sink rejected"));
			});
			const harness = await createHarness({
				initialActiveToolNames: ["write"],
				extensionFactories: [
					(pi) => {
						pi.on("tool_result", () => {
							if (failure === "no failure") return;
							if (failure === "unprintable") throw Object.create(null);
							throw new Error("result extension failed");
						});
						pi.on("tool_result", laterResultHandler);
					},
				],
			});
			await harness.session.bindExtensions({ onError: diagnostic });
			const path = join(harness.tempDir, "delivered.txt");
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("write", { path, content: "delivered once" }), { stopReason: "toolUse" }),
				(context) => {
					delivered.push(...structuredClone(context.messages.filter((message) => message.role === "toolResult")));
					return fauxAssistantMessage("Done.");
				},
			]);
			await harness.session.prompt("Create the artifact.");
			expect(await readFile(path, "utf8")).toBe("delivered once");
			expect.soft(diagnostic).toHaveBeenCalledTimes(failure === "no failure" ? 0 : 1);
			expect.soft(laterResultHandler).toHaveBeenCalledOnce();
			const terminals = harness.eventsOfType("tool_execution_end");
			expect(terminals).toHaveLength(1);
			expect.soft(terminals[0].isError).toBe(false);
			const result = harness.session.messages.find((message) => message.role === "toolResult");
			expect.soft(result?.role === "toolResult" && result.isError).toBe(false);
			expect.soft(getMessageText(result)).toContain("Successfully wrote");
			expect.soft(getMessageText(result)).not.toContain("After-tool hook failed");
			expect(delivered).toHaveLength(1);
			expect.soft(delivered[0].isError).toBe(false);
			expect.soft(delivered[0].toolCallId).toBe(terminals[0].toolCallId);
			expect.soft(getMessageText(delivered[0])).toContain("Successfully wrote");
			expect.soft(getMessageText(delivered[0])).toContain("later projection applied");
			expect.soft(getMessageText(delivered[0])).not.toContain("After-tool hook failed");
			const persisted = harness.sessionManager
				.getBranch()
				.flatMap((entry) =>
					entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [],
				);
			expect(persisted).toHaveLength(1);
			expect.soft(persisted[0].isError).toBe(false);
			expect.soft(persisted[0].toolCallId).toBe(terminals[0].toolCallId);
			expect.soft(getMessageText(persisted[0])).toContain("later projection applied");
			expect.soft(getMessageText(persisted[0])).not.toContain("After-tool hook failed");
			expect(harness.faux.state.callCount).toBe(2);
		},
	);

	it("contains a delayed rejected listener without delaying the next listener", async () => {
		const runner = await makeRunner(() => {});
		let reject!: (reason: Error) => void;
		const pending = new Promise<void>((_resolve, rejectPromise) => {
			reject = rejectPromise;
		});
		const later = vi.fn();
		runner.onError(() => pending);
		runner.onError(later);
		runner.emitError({ extensionPath: "test", event: "tool_result", error: "original" });
		expect(later).toHaveBeenCalledOnce();
		reject(new Error("delayed diagnostic rejection"));
		// Event-loop boundary exposes unhandled rejections to the test runner, without polling.
		await new Promise<void>((resolve) => setImmediate(resolve));
	});
});
