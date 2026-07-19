import { describe, expect, it } from "vitest";
import type { Tool, ToolCall, ToolResultMessage } from "../src/types.ts";
import { parseTextToolCalls, type TextToolProtocolVariant } from "../src/utils/tool-repair/text-protocol.ts";
import {
	renderTextProtocolAssistantCall,
	renderTextProtocolToolResult,
} from "../src/utils/tool-repair/text-protocol-history.ts";
import { validateToolArguments } from "../src/utils/validation.ts";

const ALL_VARIANTS: readonly TextToolProtocolVariant[] = ["tool-tag", "tool-call", "fenced-json", "function-xml"];

function makeCall(name: string, args: Record<string, unknown>, id = "call-1"): ToolCall {
	return { type: "toolCall", id, name, arguments: args };
}

function readTool(): Tool {
	return {
		name: "read",
		description: "Read a file",
		parameters: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		} as Tool["parameters"],
	};
}

function editTool(): Tool {
	return {
		name: "edit",
		description: "Apply targeted text replacements",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string" },
				edits: {
					type: "array",
					items: {
						type: "object",
						properties: { oldText: { type: "string" }, newText: { type: "string" } },
						required: ["oldText", "newText"],
					},
				},
			},
			required: ["path", "edits"],
		} as Tool["parameters"],
	};
}

describe("text-protocol-history render helpers", () => {
	describe("renderTextProtocolAssistantCall", () => {
		it("renders each dialect via the shared formatVariantEnvelope (no second formatting path)", () => {
			const call = makeCall("read", { path: "src/index.ts" });

			expect(renderTextProtocolAssistantCall(call, "tool-tag")).toBe(
				'<pi:call name="read">{"path":"src/index.ts"}</pi:call>',
			);
			expect(renderTextProtocolAssistantCall(call, "tool-call")).toBe(
				'<tool_call>{"name":"read","arguments":{"path":"src/index.ts"}}</tool_call>',
			);
			expect(renderTextProtocolAssistantCall(call, "fenced-json")).toBe(
				'```tool_call\n{"name":"read","arguments":{"path":"src/index.ts"}}\n```',
			);
			expect(renderTextProtocolAssistantCall(call, "function-xml")).toBe(
				'<function name="read"><param name="path">src/index.ts</param></function>',
			);
		});

		// MANDATORY (§2.3): the render MUST be exactly what the LISTEN parser accepts and the
		// primer taught. Every dialect, a scalar arg and an array arg (the shape open models most
		// often break, per the grammar doc), round-trips to the SAME canonical call.
		it.each(ALL_VARIANTS)("round-trips through parseTextToolCalls for the %s dialect (scalar args)", (variant) => {
			const call = makeCall("read", { path: "src/index.ts" });
			const rendered = renderTextProtocolAssistantCall(call, variant);

			const parsed = parseTextToolCalls(rendered, [readTool()]);

			expect(parsed.calls).toMatchObject([{ name: "read", arguments: { path: "src/index.ts" } }]);
		});

		// function-xml is excluded here: per text-protocol-grammar.md §2.4, its params are always
		// string-valued at the LISTEN layer ("Each param becomes a string-valued argument; R31
		// owns string-to-number, string-to-bool, and JSON-string coercion after parsing") - array
		// args round-trip as a JSON string, not a real array, until R31 coerces it. See the
		// dedicated function-xml case below for that exact (and still lossless) contract.
		it.each(["tool-tag", "tool-call", "fenced-json"] as const)(
			"round-trips through parseTextToolCalls for the %s dialect (array args)",
			(variant) => {
				const call = makeCall("edit", {
					path: "src/app.ts",
					edits: [{ oldText: "foo", newText: "bar" }],
				});
				const rendered = renderTextProtocolAssistantCall(call, variant);

				const parsed = parseTextToolCalls(rendered, [editTool()]);

				expect(parsed.calls).toMatchObject([
					{ name: "edit", arguments: { path: "src/app.ts", edits: [{ oldText: "foo", newText: "bar" }] } },
				]);
			},
		);

		it("function-xml renders array args as a param string LISTEN preserves verbatim - R31 owns the array coercion, not this render", () => {
			const call = makeCall("edit", { path: "src/app.ts", edits: [{ oldText: "foo", newText: "bar" }] });
			const rendered = renderTextProtocolAssistantCall(call, "function-xml");

			const parsed = parseTextToolCalls(rendered, [editTool()]);
			expect(parsed.calls).toMatchObject([
				{
					name: "edit",
					arguments: { path: "src/app.ts", edits: JSON.stringify([{ oldText: "foo", newText: "bar" }]) },
				},
			]);

			const repaired = validateToolArguments(editTool(), parsed.calls[0]!);
			expect(repaired).toEqual({ path: "src/app.ts", edits: [{ oldText: "foo", newText: "bar" }] });
		});

		it("preserves multi-call document order across independent renders (parallel-call parity)", () => {
			const readCall = makeCall("read", { path: "a.txt" }, "call-1");
			const editCall = makeCall("edit", { path: "b.txt", edits: [{ oldText: "x", newText: "y" }] }, "call-2");

			const rendered = [readCall, editCall]
				.map((call) => renderTextProtocolAssistantCall(call, "tool-tag"))
				.join("\n");
			const parsed = parseTextToolCalls(rendered, [readTool(), editTool()]);

			expect(parsed.calls.map((call) => call.name)).toEqual(["read", "edit"]);
			expect(parsed.calls.map((call) => call.arguments)).toEqual([
				{ path: "a.txt" },
				{ path: "b.txt", edits: [{ oldText: "x", newText: "y" }] },
			]);
		});
	});

	describe("renderTextProtocolToolResult", () => {
		function makeResult(text: string, toolName = "read"): ToolResultMessage {
			return {
				role: "toolResult",
				toolCallId: "call-1",
				toolName,
				content: [{ type: "text", text }],
				isError: false,
				timestamp: 1,
			};
		}

		it("labels the result by tool name so a phone model (no tool_call_id) links it by name + order", () => {
			expect(renderTextProtocolToolResult(makeResult("file body", "read"))).toBe("Tool result (read):\nfile body");
		});

		it("joins multiple text blocks", () => {
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "grep",
				content: [
					{ type: "text", text: "line 1" },
					{ type: "text", text: "line 2" },
				],
				isError: false,
				timestamp: 1,
			};
			expect(renderTextProtocolToolResult(result)).toBe("Tool result (grep):\nline 1\nline 2");
		});

		it("falls back to a placeholder for image-only (no text) results", () => {
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" }],
				isError: false,
				timestamp: 1,
			};
			expect(renderTextProtocolToolResult(result)).toBe("Tool result (read):\n(see attached image)");
		});
	});
});
