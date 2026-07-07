import { afterEach, describe, expect, it } from "vitest";
import { complete, fauxAssistantMessage, registerFauxProvider } from "../src/index.ts";
import type { Context, Tool } from "../src/types.ts";
import { generateTextToolProtocolPrimer, parseTextToolCalls } from "../src/utils/tool-repair/text-protocol.ts";

function makeTool(name = "echo"): Tool {
	return {
		name,
		description: "Echo a value",
		parameters: {
			type: "object",
			properties: { value: { type: "string" } },
			required: ["value"],
		} as Tool["parameters"],
	};
}

describe("text tool-call protocol", () => {
	const registrations: Array<{ unregister(): void }> = [];

	afterEach(() => {
		for (const registration of registrations.splice(0)) registration.unregister();
	});

	it("generates a primer from the live tool list", () => {
		const primer = generateTextToolProtocolPrimer([makeTool("echo"), makeTool("search")]);

		expect(primer).toContain('<tool name="TOOL_NAME">');
		expect(primer).toContain("echo");
		expect(primer).toContain("search");
		expect(primer).toContain("value");
	});

	it("parses supported envelopes into tool calls", () => {
		const tools = [makeTool()];

		expect(parseTextToolCalls('<tool name="echo">{"value":"hi"}</tool>', tools).calls).toMatchObject([
			{ type: "toolCall", name: "echo", arguments: { value: "hi" }, source: "text-protocol" },
		]);
		expect(
			parseTextToolCalls('<tool_call>{"name":"echo","arguments":{"value":"hi"}}</tool_call>', tools).calls,
		).toMatchObject([{ type: "toolCall", name: "echo", arguments: { value: "hi" }, source: "text-protocol" }]);
		expect(parseTextToolCalls('```json\n{"name":"echo","arguments":{"value":"hi"}}\n```', tools).calls).toMatchObject(
			[{ type: "toolCall", name: "echo", arguments: { value: "hi" }, source: "text-protocol" }],
		);
	});

	it("turns malformed known envelopes into bouncable tool calls", () => {
		const parsed = parseTextToolCalls('<tool name="echo">{"value":</tool>', [makeTool()]);

		expect(parsed.calls).toMatchObject([
			{
				type: "toolCall",
				name: "echo",
				arguments: {},
				rawArguments: { text: '{"value":' },
				source: "text-protocol",
			},
		]);
	});

	it("leaves prose and unknown tools as text", () => {
		const tools = [makeTool()];

		expect(parseTextToolCalls("please call echo", tools)).toEqual({
			calls: [],
			text: "please call echo",
			attempted: false,
		});
		expect(parseTextToolCalls('Before <tool name="echo">{"value":"hi"}</tool>', tools)).toEqual({
			calls: [],
			text: 'Before <tool name="echo">{"value":"hi"}</tool>',
			attempted: true,
			failure: "mixed-prose",
		});
		expect(parseTextToolCalls('<tool name="missing">{"value":"hi"}</tool>', tools)).toEqual({
			calls: [],
			text: '<tool name="missing">{"value":"hi"}</tool>',
			attempted: true,
			failure: "unrecognized",
		});
	});

	it("injects the primer and converts final text only when the flag is enabled", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const tools = [makeTool()];
		const context: Context = { systemPrompt: "base", messages: [], tools };
		let promptedWithPrimer = false;

		registration.setResponses([
			(requestContext) => {
				promptedWithPrimer = requestContext.systemPrompt?.includes("Text tool-call protocol is enabled.") ?? false;
				return fauxAssistantMessage('<tool name="echo">{"value":"hi"}</tool>');
			},
			fauxAssistantMessage('<tool name="echo">{"value":"hi"}</tool>'),
		]);

		const converted = await complete(registration.getModel(), context, { textToolCallProtocol: true });
		expect(promptedWithPrimer).toBe(true);
		expect(converted.stopReason).toBe("toolUse");
		expect(converted.content).toMatchObject([
			{ type: "toolCall", name: "echo", arguments: { value: "hi" }, source: "text-protocol" },
		]);

		const unchanged = await complete(registration.getModel(), context, { textToolCallProtocol: false });
		expect(unchanged.content).toMatchObject([{ type: "text", text: '<tool name="echo">{"value":"hi"}</tool>' }]);
	});
});
