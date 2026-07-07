import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { complete, fauxAssistantMessage, registerFauxProvider } from "../src/index.ts";
import type { Context, Tool } from "../src/types.ts";
import { TOOL_REPAIR_MODE_NAMES } from "../src/utils/tool-repair/registry.ts";
import { generateTextToolProtocolPrimer, parseTextToolCalls } from "../src/utils/tool-repair/text-protocol.ts";
import { validateToolArguments } from "../src/utils/validation.ts";

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

		expect(primer).toContain('<pi:call name="TOOL_NAME">');
		expect(primer).toContain("echo");
		expect(primer).toContain("search");
		expect(primer).toContain("value");
	});

	it("parses grammar-supported envelopes into tool calls", () => {
		const tools = [makeTool()];

		expect(parseTextToolCalls('<pi:call name="echo">{"value":"hi"}</pi:call>', tools).calls).toMatchObject([
			{ type: "toolCall", name: "echo", arguments: { value: "hi" }, source: "text-protocol" },
		]);
		expect(
			parseTextToolCalls('<tool_call>{"name":"echo","arguments":{"value":"hi"}}</tool_call>', tools).calls,
		).toMatchObject([{ type: "toolCall", name: "echo", arguments: { value: "hi" }, source: "text-protocol" }]);
		expect(parseTextToolCalls('```tool\n{"name":"echo","arguments":{"value":"hi"}}\n```', tools).calls).toMatchObject(
			[{ type: "toolCall", name: "echo", arguments: { value: "hi" }, source: "text-protocol" }],
		);
	});

	it("preserves prose outside envelopes and keeps multi-call order", () => {
		const tools = [makeTool("read"), makeTool("write")];
		const parsed = parseTextToolCalls(
			'Before <pi:call name="read">{"value":"a"}</pi:call> between <tool_call>{"name":"write","arguments":{"value":"b"}}</tool_call> after',
			tools,
		);

		expect(parsed).toMatchObject({ attempted: true, text: "Before  between  after" });
		expect(parsed.calls.map((call) => call.name)).toEqual(["read", "write"]);
		expect(parsed.calls.map((call) => call.arguments.value)).toEqual(["a", "b"]);
	});

	it("turns unknown tools and malformed known envelopes into bouncable tool calls", () => {
		const tools = [makeTool("echo"), makeTool("read")];
		const unknown = parseTextToolCalls('<pi:call name="missing">{"value":"hi"}</pi:call>', tools);
		const malformed = parseTextToolCalls('<pi:call name="echo">{"value":</pi:call>', tools);

		expect(unknown.calls).toMatchObject([
			{
				type: "toolCall",
				name: "missing",
				arguments: { value: "hi" },
				source: "text-protocol",
				errorMessage: 'Unknown tool "missing". Valid tools: echo, read.',
			},
		]);
		expect(malformed.calls).toMatchObject([
			{
				type: "toolCall",
				name: "echo",
				rawArguments: { text: '{"value":' },
				source: "text-protocol",
			},
		]);
		expect(malformed.calls[0]?.arguments).toBe('{"value":');
	});

	it("passes stringified arguments through the shared R31 repair layer", () => {
		const tool = makeTool();
		const parsed = parseTextToolCalls('<tool_call>{"name":"echo","arguments":"{\\"value\\":\\"hi\\"}"}</tool_call>', [
			tool,
		]);
		const events: Array<{ outcome: string; repairsApplied: string[] }> = [];

		const args = validateToolArguments(tool, parsed.calls[0], {
			telemetry: (event) => events.push({ outcome: event.outcome, repairsApplied: event.repairsApplied }),
		});

		expect(args).toEqual({ value: "hi" });
		expect(events).toContainEqual({ outcome: "repaired", repairsApplied: ["jsonStringParse"] });
	});

	it("leaves plain prose as text and rejects overlapping envelopes", () => {
		const tools = [makeTool()];

		expect(parseTextToolCalls("please call echo", tools)).toEqual({
			calls: [],
			text: "please call echo",
			attempted: false,
		});
		expect(
			parseTextToolCalls(
				'<pi:call name="echo"><tool_call>{"name":"echo","arguments":{"value":"hi"}}</tool_call></pi:call>',
				tools,
			),
		).toEqual({
			calls: [],
			text: '<pi:call name="echo"><tool_call>{"name":"echo","arguments":{"value":"hi"}}</tool_call></pi:call>',
			attempted: true,
			failure: "overlap",
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
				return fauxAssistantMessage('<pi:call name="echo">{"value":"hi"}</pi:call>');
			},
			fauxAssistantMessage('<pi:call name="echo">{"value":"hi"}</pi:call>'),
		]);

		const converted = await complete(registration.getModel(), context, { textToolCallProtocol: true });
		expect(promptedWithPrimer).toBe(true);
		expect(converted.stopReason).toBe("toolUse");
		expect(converted.content).toMatchObject([
			{ type: "toolCall", name: "echo", arguments: { value: "hi" }, source: "text-protocol" },
		]);

		const unchanged = await complete(registration.getModel(), context, { textToolCallProtocol: false });
		expect(unchanged.content).toMatchObject([
			{ type: "text", text: '<pi:call name="echo">{"value":"hi"}</pi:call>' },
		]);
	});

	it("keeps repair registry names documented in the user doc and bundled skill", () => {
		const docs = [
			{
				name: "tool-repair docs",
				text: readFileSync(new URL("../../coding-agent/docs/tool-repair.md", import.meta.url), "utf-8"),
			},
			{
				name: "tool-call-repair skill",
				text: readFileSync(
					new URL("../../coding-agent/src/bundled-resources/skills/tool-call-repair/SKILL.md", import.meta.url),
					"utf-8",
				),
			},
		];

		for (const { name, text } of docs) {
			for (const mode of TOOL_REPAIR_MODE_NAMES) {
				expect.soft(text, `${name} is missing ${mode}`).toContain(mode);
			}
		}
	});
});
