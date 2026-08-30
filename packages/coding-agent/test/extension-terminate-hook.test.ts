import { fauxAssistantMessage } from "@caupulican/pi-ai/faux";
import { describe, expect, it } from "vitest";
import { createHarness } from "./suite/harness.ts";

describe("Extension hook terminate (F14)", () => {
	it("terminates tool loop when tool_call blocks with terminate: true", async () => {
		let secondResponseAttempted = false;
		const harness = await createHarness({
			tools: [
				{
					name: "test_tool",
					label: "Test Tool",
					description: "Test tool",
					parameters: { type: "object", properties: {} },
					execute: async () => ({ content: [{ type: "text", text: "tool executed" }], details: {} }),
				},
			],
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", async () => {
						return { block: true, reason: "blocked by policy", terminate: true };
					});
				},
			],
		});

		harness.setResponses([
			fauxAssistantMessage([
				{
					type: "toolCall",
					id: "call_1",
					name: "test_tool",
					arguments: {},
				},
			]),
			() => {
				secondResponseAttempted = true;
				return fauxAssistantMessage("should not happen");
			},
		]);

		await harness.session.prompt("run tool");

		expect(secondResponseAttempted).toBe(false);
		const lastMessage = harness.session.messages.at(-1);
		expect(lastMessage?.role).toBe("toolResult");
	});

	it("terminates tool loop when tool_result returns terminate: true", async () => {
		let secondResponseAttempted = false;
		const harness = await createHarness({
			tools: [
				{
					name: "test_tool",
					label: "Test Tool",
					description: "Test tool",
					parameters: { type: "object", properties: {} },
					execute: async () => ({ content: [{ type: "text", text: "tool executed" }], details: {} }),
				},
			],
			extensionFactories: [
				(pi) => {
					pi.on("tool_result", async () => {
						return { terminate: true };
					});
				},
			],
		});

		harness.setResponses([
			fauxAssistantMessage([
				{
					type: "toolCall",
					id: "call_1",
					name: "test_tool",
					arguments: {},
				},
			]),
			() => {
				secondResponseAttempted = true;
				return fauxAssistantMessage("should not happen");
			},
		]);

		await harness.session.prompt("run tool");

		expect(secondResponseAttempted).toBe(false);
		const lastMessage = harness.session.messages.at(-1);
		expect(lastMessage?.role).toBe("toolResult");
	});

	it("proceeds normally when terminate is false or omitted (negative control)", async () => {
		let providerExecuted = false;
		const harness = await createHarness({
			tools: [
				{
					name: "test_tool",
					label: "Test Tool",
					description: "Test tool",
					parameters: { type: "object", properties: {} },
					execute: async () => ({ content: [{ type: "text", text: "tool executed" }], details: {} }),
				},
			],
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", async () => {
						return { terminate: false };
					});
					pi.on("tool_result", async () => {
						return { terminate: false };
					});
				},
			],
		});

		harness.setResponses([
			fauxAssistantMessage([
				{
					type: "toolCall",
					id: "call_1",
					name: "test_tool",
					arguments: {},
				},
			]),
			() => {
				providerExecuted = true;
				return fauxAssistantMessage("normal response");
			},
		]);

		await harness.session.prompt("run something");

		// terminate:false must not stop the loop — the follow-up request happens.
		expect(providerExecuted).toBe(true);
		const lastMessage = harness.session.messages.at(-1);
		expect(lastMessage?.role).toBe("assistant");
		expect((lastMessage as any)?.stopReason).toBe("stop");
	});

	it("continues the loop when only SOME finalized results in a batch terminate (mixed batch, upstream batch rule)", async () => {
		let secondResponseAttempted = false;
		const harness = await createHarness({
			tools: [
				{
					name: "tool_a",
					label: "Tool A",
					description: "Terminates",
					parameters: { type: "object", properties: {} },
					execute: async () => ({ content: [{ type: "text", text: "a done" }], details: {} }),
				},
				{
					name: "tool_b",
					label: "Tool B",
					description: "Does not terminate",
					parameters: { type: "object", properties: {} },
					execute: async () => ({ content: [{ type: "text", text: "b done" }], details: {} }),
				},
			],
			extensionFactories: [
				(pi) => {
					pi.on("tool_result", async (event) => {
						// Only tool_a's result terminates; tool_b's does not.
						if (event.toolCallId === "call_a") return { terminate: true };
						return undefined;
					});
				},
			],
		});

		harness.setResponses([
			fauxAssistantMessage([
				{ type: "toolCall", id: "call_a", name: "tool_a", arguments: {} },
				{ type: "toolCall", id: "call_b", name: "tool_b", arguments: {} },
			]),
			() => {
				secondResponseAttempted = true;
				return fauxAssistantMessage("follow-up after mixed batch");
			},
		]);

		await harness.session.prompt("run both tools");

		// The loop stops early only when EVERY finalized result in the batch terminates.
		expect(secondResponseAttempted).toBe(true);
	});

	it("still forces a continuation when an active verification obligation exists, even though the batch terminated (feature protection)", async () => {
		let secondResponseAttempted = false;
		const harness = await createHarness({
			tools: [
				{
					name: "verification_probe",
					label: "Verification probe",
					description: "Deterministic failing verification fixture",
					parameters: { type: "object", properties: {} },
					execute: async () => ({
						content: [{ type: "text", text: "unit-suite: failed" }],
						details: {
							piVerification: {
								version: 1,
								id: "unit-suite",
								status: "failed",
								summary: "unit-suite failed",
							},
						},
						isError: true,
						errorKind: "operation_outcome",
					}),
				},
			],
			extensionFactories: [
				(pi) => {
					// Every finalized result in this (single-call) batch terminates...
					pi.on("tool_result", async () => ({ terminate: true }));
				},
			],
		});

		harness.setResponses([
			fauxAssistantMessage([{ type: "toolCall", id: "call_1", name: "verification_probe", arguments: {} }]),
			() => {
				secondResponseAttempted = true;
				return fauxAssistantMessage("still checking the unit suite");
			},
		]);

		await harness.session.prompt("run verification");

		// ...but agent-loop.ts honors VerificationObligationTracker over terminate (agent-loop.ts
		// ~line 505): an active verification obligation must still force a continuation.
		expect(secondResponseAttempted).toBe(true);
	});
});
