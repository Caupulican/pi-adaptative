import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { complete, fauxAssistantMessage, fauxThinking, registerFauxProvider } from "../src/index.ts";
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

		expect(primer).toContain('<pi:call name="TOOL">{"arg":"value"}</pi:call>');
		expect(primer).toContain("echo");
		expect(primer).toContain("search");
		expect(primer).toContain("value");
		expect(primer).toContain('<pi:call name="echo">{"value":"value"}</pi:call>');
	});

	it("prefers core read and edit worked examples when present", () => {
		const readTool: Tool = {
			name: "read",
			description: "Read a file",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			} as Tool["parameters"],
		};
		const editTool: Tool = {
			name: "edit",
			description: "Edit a file",
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

		const primer = generateTextToolProtocolPrimer([makeTool("bash"), readTool, editTool]);

		expect(primer).toContain('<pi:call name="read">{"path":"src/index.ts"}</pi:call>');
		expect(primer).toContain(
			'<pi:call name="edit">{"path":"src/index.ts","edits":[{"oldText":"foo","newText":"bar"}]}</pi:call>',
		);
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
		expect(parseTextToolCalls('```json\n{"name":"echo","arguments":{"value":"hi"}}\n```', tools).calls).toMatchObject(
			[{ type: "toolCall", name: "echo", arguments: { value: "hi" }, source: "text-protocol" }],
		);
		expect(
			parseTextToolCalls('```json\n{"tool":{"name":"echo","arguments":{"value":"hi"}}}\n```', tools).calls,
		).toMatchObject([{ type: "toolCall", name: "echo", arguments: { value: "hi" }, source: "text-protocol" }]);
		expect(
			parseTextToolCalls('<function name="echo"><param name="value">hi</param></function>', tools).calls,
		).toMatchObject([{ type: "toolCall", name: "echo", arguments: { value: "hi" }, source: "text-protocol" }]);
	});

	it("parses function XML envelopes without guessing ambiguous bodies", () => {
		const tools = [makeTool("echo"), makeTool("read")];
		const primer = generateTextToolProtocolPrimer([makeTool()], { variant: "function-xml" });
		const parsed = parseTextToolCalls(
			'Before <function name="echo"><param name="value">hi</param></function> between <function name="read"><param name="path">/tmp/a</param></function> after',
			tools,
		);
		const ambiguous = parseTextToolCalls(
			'<function name="echo"><param name="value">hi</param> trailing</function>',
			tools,
		);
		const duplicate = parseTextToolCalls(
			'<function name="echo"><param name="value">a</param><param name="value">b</param></function>',
			tools,
		);
		const nested = parseTextToolCalls(
			'<function name="echo"><function name="read"><param name="path">/tmp/a</param></function></function>',
			tools,
		);

		expect(primer).toContain('<function name="echo"><param name="value">value</param></function>');
		expect(parsed.text).toBe("Before  between  after");
		expect(parsed.calls.map((call) => call.name)).toEqual(["echo", "read"]);
		expect(parsed.calls.map((call) => call.arguments)).toEqual([{ value: "hi" }, { path: "/tmp/a" }]);
		expect(ambiguous).toMatchObject({ calls: [], attempted: true, failure: "unrecognized" });
		expect(duplicate).toMatchObject({ calls: [], attempted: true, failure: "unrecognized" });
		expect(nested).toMatchObject({ calls: [], attempted: true, failure: "unrecognized" });
	});

	it("parses tolerated pure-text envelope spelling drift", () => {
		const parsedSingleQuotes = parseTextToolCalls("<pi:call name='read'>{'path': 'package.json'}</pi:call >", [
			makeTool("read"),
		]);
		const parsedBareKey = parseTextToolCalls('<pi:call name="echo">{value:"hi"}</pi:call>', [makeTool("echo")]);
		const parsedBareValue = parseTextToolCalls('<pi:call name="echo">{"value":hi}</pi:call>', [makeTool("echo")]);
		const parsedUnclosed = parseTextToolCalls('<pi:call name="echo">{"value":"hi"}戴</fill>', [makeTool("echo")]);
		const parsedTrailingProse = parseTextToolCalls('<pi:call name="echo">{"value":"hi"} - Echo a value</pi:call>', [
			makeTool("echo"),
		]);

		expect(parsedSingleQuotes.calls).toMatchObject([
			{ type: "toolCall", name: "read", arguments: { path: "package.json" }, source: "text-protocol" },
		]);
		expect(parsedBareKey.calls).toMatchObject([
			{ type: "toolCall", name: "echo", arguments: { value: "hi" }, source: "text-protocol" },
		]);
		expect(parsedBareValue.calls).toMatchObject([
			{ type: "toolCall", name: "echo", arguments: { value: "hi" }, source: "text-protocol" },
		]);
		expect(parsedUnclosed.calls).toMatchObject([
			{ type: "toolCall", name: "echo", arguments: { value: "hi" }, source: "text-protocol" },
		]);
		expect(parsedUnclosed.text).toBe("戴</fill>");
		expect(parsedTrailingProse.calls).toMatchObject([
			{ type: "toolCall", name: "echo", arguments: { value: "hi" }, source: "text-protocol" },
		]);
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

	it("injects the primer without sending native tool definitions to the provider", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const tools = [makeTool()];
		const context: Context = { systemPrompt: "base", messages: [], tools };
		let activeRequest: Context | undefined;
		let inactiveRequest: Context | undefined;
		const inactiveParseEvents: unknown[] = [];

		registration.setResponses([
			(requestContext) => {
				activeRequest = requestContext;
				return fauxAssistantMessage('<pi:call name="echo">{"value":"hi"}</pi:call>');
			},
			(requestContext) => {
				inactiveRequest = requestContext;
				return fauxAssistantMessage('<pi:call name="echo">{"value":"hi"}</pi:call>');
			},
		]);

		const converted = await complete(registration.getModel(), context, { textToolCallProtocol: true });
		expect(activeRequest?.systemPrompt).toContain("Text tool-call protocol is enabled.");
		expect(activeRequest && "tools" in activeRequest).toBe(false);
		expect(converted.stopReason).toBe("toolUse");
		expect(converted.content).toMatchObject([
			{ type: "toolCall", name: "echo", arguments: { value: "hi" }, source: "text-protocol" },
		]);

		const unchanged = await complete(registration.getModel(), context, {
			textToolCallProtocol: false,
			onTextToolProtocolParse: (event) => {
				inactiveParseEvents.push(event);
			},
		});
		expect(inactiveRequest?.tools).toBe(tools);
		expect(inactiveParseEvents).toEqual([]);
		expect(unchanged.content).toMatchObject([
			{ type: "text", text: '<pi:call name="echo">{"value":"hi"}</pi:call>' },
		]);
	});

	it("parses text envelopes from thinking plus text done messages", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const context: Context = { systemPrompt: "base", messages: [], tools: [makeTool()] };

		registration.setResponses([
			fauxAssistantMessage([
				fauxThinking("I should use the protocol."),
				{ type: "text", text: '<pi:call name="echo">{"value":"hi"}</pi:call>' },
			]),
		]);

		const converted = await complete(registration.getModel(), context, { textToolCallProtocol: true });

		expect(converted.stopReason).toBe("toolUse");
		expect(converted.content).toMatchObject([
			{ type: "thinking", thinking: "I should use the protocol." },
			{ type: "toolCall", name: "echo", arguments: { value: "hi" }, source: "text-protocol" },
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
