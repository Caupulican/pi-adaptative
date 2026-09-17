import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ToolResultEvent, ToolResultEventResult } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { createHarness, getMessageText } from "./suite/harness.ts";
import { createTestExtensionsResult } from "./suite/test-resources.ts";

describe("extension result projection admission", () => {
	it.each([false, true])("delivers a real write through patch admission (getterThrows=%s)", async (getterThrows) => {
		let delivered = "";
		let deliveredError: boolean | undefined;
		const harness = await createHarness({
			initialActiveToolNames: ["write"],
			extensionFactories: [
				(pi) => {
					pi.on("tool_result", () => ({
						content: [{ type: "text", text: "accepted replacement" }],
						get details() {
							if (getterThrows) throw new Error("patch failed before admission");
							return { accepted: true };
						},
					}));
					pi.on("tool_result", (event) => ({
						content: [...event.content, { type: "text", text: "later handler" }],
					}));
				},
			],
		});
		const path = join(harness.tempDir, "created.txt");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path, content: "created once" }), { stopReason: "toolUse" }),
			(context) => {
				const result = context.messages.find((message) => message.role === "toolResult");
				delivered = getMessageText(result);
				if (result?.role === "toolResult") deliveredError = result.isError;
				return fauxAssistantMessage("Done.");
			},
		]);
		await harness.session.prompt("Create the file.");
		expect(await readFile(path, "utf8")).toBe("created once");
		expect(harness.eventsOfType("tool_execution_end")).toHaveLength(1);
		expect(deliveredError).toBe(false);
		expect(delivered).toContain("later handler");
		if (getterThrows) {
			expect(delivered).toContain("Successfully wrote");
			expect(delivered).not.toContain("accepted replacement");
		} else {
			expect(delivered).toContain("accepted replacement");
		}
	});

	it.each(
		[false, true].flatMap((previousPatch) =>
			(["details", "isError", "usage", "terminate"] as const).map((failingField) => ({
				previousPatch,
				failingField,
			})),
		),
	)(
		"does not publish earlier fields when $failingField fails (previousPatch=$previousPatch)",
		async ({ failingField, previousPatch }) => {
			const acceptedContent = previousPatch ? "previous accepted patch" : "original successful write";
			const acceptedDetails = previousPatch ? { phase: "enriched" } : { phase: "written" };
			const later = vi.fn((event: ToolResultEvent) => ({
				content: [...event.content, { type: "text" as const, text: "accepted later" }],
			}));
			const loaded = await createTestExtensionsResult([
				(pi) => {
					pi.on("tool_result", () =>
						previousPatch
							? {
									content: [{ type: "text", text: acceptedContent }],
									details: acceptedDetails,
									isError: false,
									terminate: false,
								}
							: undefined,
					);
					pi.on("tool_result", () => {
						const proposed: ToolResultEventResult = {
							content: [{ type: "text", text: "rejected partial projection" }],
							details: { rejected: true },
							isError: true,
						};
						Object.defineProperty(proposed, failingField, {
							get() {
								throw new Error("cannot read projection field");
							},
						});
						return proposed;
					});
					pi.on("tool_result", later);
				},
			]);
			const runner = new ExtensionRunner(
				loaded.extensions,
				loaded.runtime,
				process.cwd(),
				SessionManager.inMemory(),
				ModelRegistry.inMemory(AuthStorage.inMemory()),
			);
			const errors = vi.fn();
			runner.onError(errors);
			const result = await runner.emitToolResult({
				type: "tool_result",
				toolName: "write",
				toolCallId: "completed-write",
				input: { path: "artifact", content: "created" },
				content: [{ type: "text", text: "original successful write" }],
				details: { phase: "written" },
				isError: false,
			});
			expect(errors).toHaveBeenCalledOnce();
			expect(later).toHaveBeenCalledOnce();
			expect(result).toMatchObject({
				content: [
					{ type: "text", text: acceptedContent },
					{ type: "text", text: "accepted later" },
				],
				details: acceptedDetails,
				isError: false,
				terminate: previousPatch ? false : undefined,
			});
		},
	);

	it.each([false, true])("accepts a complete projection with one field read (accessor=%s)", async (accessor) => {
		const content = vi.fn(() => [{ type: "text" as const, text: "accepted projection" }]);
		const loaded = await createTestExtensionsResult([
			(pi) => {
				pi.on("tool_result", () =>
					accessor
						? Object.defineProperty({}, "content", { get: content })
						: { content: [{ type: "text", text: "accepted projection" }] },
				);
			},
		]);
		const runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			process.cwd(),
			SessionManager.inMemory(),
			ModelRegistry.inMemory(AuthStorage.inMemory()),
		);
		await expect(
			runner.emitToolResult({
				type: "tool_result",
				toolName: "write",
				toolCallId: "control",
				input: {},
				content: [{ type: "text", text: "original" }],
				details: {},
				isError: false,
			}),
		).resolves.toMatchObject({ content: [{ type: "text", text: "accepted projection" }], isError: false });
		expect(content).toHaveBeenCalledTimes(accessor ? 1 : 0);
	});
});
