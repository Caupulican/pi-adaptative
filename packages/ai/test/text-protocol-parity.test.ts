import { describe, expect, it } from "vitest";
import type { Tool } from "../src/types.ts";
import {
	formatVariantEnvelope,
	generateTextToolProtocolPrimer,
	parseTextToolCalls,
	type TextToolProtocolParseFailure,
	type TextToolProtocolVariant,
} from "../src/utils/tool-repair/text-protocol.ts";
import { validateToolArguments } from "../src/utils/validation.ts";

/**
 * The PARITY MATRIX: every native tool-calling capability must have a passing
 * text-protocol equivalent, plus the text-protocol-only superset (parallel + inline rationale +
 * multi-dialect tolerance). This file is that matrix as executable fixtures, scoped to the curated
 * no-native-tools local roster (prism-ml Bonsai / Ternary-Bonsai family, all `toolCalling:false` in
 * default-model-suggestions.ts) for which canonical `<pi:call>` is the natural fit.
 */

const CORE_TOOL_NAMES = ["bash", "read", "edit", "write", "ls", "grep", "find"];

function coreTools(): Tool[] {
	return [
		{
			name: "bash",
			description: "run a bash command",
			parameters: {
				type: "object",
				properties: { command: { type: "string" }, timeout: { type: "number" } },
				required: ["command"],
			} as Tool["parameters"],
		},
		{
			name: "read",
			description: "read a file",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string" },
					offset: { type: "number" },
					limit: { type: "number" },
					lineNumbers: { type: "boolean" },
					tail: { type: "number" },
					filter: { type: "string", enum: ["none", "minimal", "aggressive"] },
				},
				required: ["path"],
			} as Tool["parameters"],
		},
		{
			name: "edit",
			description: "apply targeted text replacements to a file",
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
		},
		{
			name: "write",
			description: "write (create/overwrite) a file",
			parameters: {
				type: "object",
				properties: { path: { type: "string" }, content: { type: "string" } },
				required: ["path", "content"],
			} as Tool["parameters"],
		},
		{
			name: "ls",
			description: "list a directory",
			parameters: {
				type: "object",
				properties: { path: { type: "string" }, limit: { type: "number" }, metadata: { type: "boolean" } },
				required: [],
			} as Tool["parameters"],
		},
		{
			name: "grep",
			description: "search file contents",
			parameters: {
				type: "object",
				properties: {
					pattern: { type: "string" },
					path: { type: "string" },
					glob: { type: "string" },
					ignoreCase: { type: "boolean" },
					literal: { type: "boolean" },
					context: { type: "number" },
					limit: { type: "number" },
				},
				required: ["pattern"],
			} as Tool["parameters"],
		},
		{
			name: "find",
			description: "find files by glob",
			parameters: {
				type: "object",
				properties: {
					pattern: { type: "string" },
					path: { type: "string" },
					limit: { type: "number" },
					ignoreCase: { type: "boolean" },
				},
				required: ["pattern"],
			} as Tool["parameters"],
		},
	];
}

function makeTool(name: string): Tool {
	return {
		name,
		description: `${name} tool`,
		parameters: {
			type: "object",
			properties: { value: { type: "string" } },
			required: [],
		} as Tool["parameters"],
	};
}

describe("text-protocol parity matrix", () => {
	it("parity: parallel/multiple calls per turn parse into multiple ordered ToolCall blocks", () => {
		const tools = [makeTool("a"), makeTool("b"), makeTool("c")];
		const text = [
			'<pi:call name="a">{"value":"1"}</pi:call>',
			'<pi:call name="b">{"value":"2"}</pi:call>',
			'<pi:call name="c">{"value":"3"}</pi:call>',
		].join(" then ");

		const parsed = parseTextToolCalls(text, tools);

		expect(parsed.attempted).toBe(true);
		expect(parsed.calls.map((call) => [call.name, call.arguments])).toEqual([
			["a", { value: "1" }],
			["b", { value: "2" }],
			["c", { value: "3" }],
		]);
	});

	it("parity: a partial-overlap batch salvages every non-overlapping valid call, not just the survivors of a clean batch", () => {
		const tools = [makeTool("a"), makeTool("b"), makeTool("c")];
		// "b" is wrapped in an ambiguous nested envelope (a model mixing dialects mid-reply); "a" and
		// "c" are clean canonical calls either side of it. Native parallel tool-calling has no
		// equivalent failure mode here - this is the text-protocol-specific robustness bar.
		const text =
			'<pi:call name="a">{"value":"1"}</pi:call> then ' +
			'<pi:call name="b"><tool_call>{"name":"b","arguments":{"value":"2"}}</tool_call></pi:call> then ' +
			'<pi:call name="c">{"value":"3"}</pi:call>';

		const parsed = parseTextToolCalls(text, tools);

		expect(parsed.attempted).toBe(true);
		expect(parsed.failure).toBeUndefined();
		expect(parsed.calls.map((call) => [call.name, call.arguments])).toEqual([
			["a", { value: "1" }],
			["b", { value: "2" }],
			["c", { value: "3" }],
		]);
	});

	it("parity: all argument shapes (scalar, array, nested object, enum) round-trip through the canonical dialect", () => {
		const tool: Tool = {
			name: "configure",
			description: "configure something",
			parameters: {
				type: "object",
				properties: {
					flag: { type: "boolean" },
					mode: { type: "string", enum: ["fast", "careful"] },
					count: { type: "number" },
					tags: { type: "array", items: { type: "string" } },
					nested: {
						type: "object",
						properties: { a: { type: "string" }, b: { type: "number" } },
						required: ["a", "b"],
					},
				},
				required: ["flag", "mode", "count", "tags", "nested"],
			} as Tool["parameters"],
		};
		const args = { flag: true, mode: "fast", count: 3, tags: ["x", "y"], nested: { a: "hi", b: 2 } };

		for (const variant of ["tool-tag", "tool-call", "fenced-json"] as const) {
			const envelope = formatVariantEnvelope(variant, "configure", JSON.stringify(args));
			const parsed = parseTextToolCalls(envelope, [tool]);
			expect(parsed.calls, `variant ${variant}`).toMatchObject([{ name: "configure" }]);
			expect(parsed.calls[0]?.arguments, `variant ${variant}`).toEqual(args);
		}
	});

	it("parity: name<->args stay unambiguous even when the args body is malformed", () => {
		const tools = [makeTool("echo"), makeTool("read")];
		// The tool name lives in the envelope ATTRIBUTE, not inside the (broken) JSON body, so a
		// malformed call still identifies which tool to bounce feedback to - a native-call superset
		// (a native malformed-JSON tool call cannot even be attributed to a tool name).
		const parsed = parseTextToolCalls('<pi:call name="read">{"path": not valid json</pi:call>', tools);

		expect(parsed.calls).toMatchObject([{ name: "read", source: "text-protocol" }]);
	});

	it("dialect parity: each of the four recognized dialects round-trips a call", () => {
		const tool: Tool = {
			name: "read",
			description: "read a file",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			} as Tool["parameters"],
		};
		const args = { path: "src/index.ts" };

		// Canonical <pi:call> - the dialect the curated no-native-tools Bonsai/Ternary-Bonsai family
		// is calibrated to (blank chat template -> whatever the primer teaches).
		const canonical = parseTextToolCalls(formatVariantEnvelope("tool-tag", "read", JSON.stringify(args)), [tool]);
		expect(canonical.calls).toMatchObject([{ name: "read", arguments: args }]);

		// The remaining three are LISTEN-only tolerance for models pre-trained on other stacks'
		// conventions (text-protocol-grammar.md §2) - never emitted by pi's own primer, but recognized.
		const toolCall = parseTextToolCalls(formatVariantEnvelope("tool-call", "read", JSON.stringify(args)), [tool]);
		expect(toolCall.calls).toMatchObject([{ name: "read", arguments: args }]);

		const fencedJson = parseTextToolCalls(formatVariantEnvelope("fenced-json", "read", JSON.stringify(args)), [tool]);
		expect(fencedJson.calls).toMatchObject([{ name: "read", arguments: args }]);

		const functionXml = parseTextToolCalls(formatVariantEnvelope("function-xml", "read", JSON.stringify(args)), [
			tool,
		]);
		expect(functionXml.calls).toMatchObject([{ name: "read", arguments: { path: "src/index.ts" } }]);
	});

	it("superset: reasoning before an envelope is preserved as prose and the call still parses", () => {
		const tools = [makeTool("read")];
		const text =
			'I need to check the config file first, so I will read it.\n<pi:call name="read">{"value":"config.json"}</pi:call>';

		const parsed = parseTextToolCalls(text, tools);

		expect(parsed.calls).toMatchObject([{ name: "read", arguments: { value: "config.json" } }]);
		expect(parsed.text).toBe("I need to check the config file first, so I will read it.");
	});

	it("primer: stays under a shrunk size budget while teaching parallel calls, rationale placement, and the full dictionary", () => {
		const primer = generateTextToolProtocolPrimer(coreTools());

		// Budget: the original primer for this exact core-tool fixture was 1853 chars / 20
		// lines. The tightened header must be strictly smaller even though it teaches two NEW rules.
		expect(primer.length).toBeLessThan(1700);
		expect(primer.split("\n").length).toBeLessThanOrEqual(18);

		// Still teaches the parallel-call superset...
		expect(primer).toMatch(/parallel/i);
		// ...and rationale-before-envelope (replacing the old "no prose" absolute)...
		expect(primer).toMatch(/reasoning.*before|before.*envelope/i);
		// ...and keeps the full one-line-per-tool dictionary.
		for (const name of CORE_TOOL_NAMES) {
			expect(primer).toContain(`${name}(`);
		}
	});

	it("mixed-prose is not a producible parse-failure reason", () => {
		// Type-level pin: "mixed-prose" must no longer be assignable to the failure union. If this
		// stops erroring, the dead variant crept back into the type.
		// @ts-expect-error "mixed-prose" was removed from TextToolProtocolParseFailure
		const invalid: TextToolProtocolParseFailure = "mixed-prose";
		expect(invalid).toBeDefined();
	});

	it("single choke point: every call in a multi-call batch is repaired through the same validate-then-repair pipeline", () => {
		const tool = makeTool("echo");
		const text =
			'<tool_call>{"name":"echo","arguments":"{\\"value\\":\\"a\\"}"}</tool_call>' +
			'<tool_call>{"name":"echo","arguments":"{\\"value\\":\\"b\\"}"}</tool_call>';
		const parsed = parseTextToolCalls(text, [tool]);
		expect(parsed.calls).toHaveLength(2);

		const events: Array<{ outcome: string; repairsApplied: string[] }> = [];
		const repaired = parsed.calls.map((call) =>
			validateToolArguments(tool, call, {
				telemetry: (event) => events.push({ outcome: event.outcome, repairsApplied: event.repairsApplied }),
			}),
		);

		// Both calls hit the same choke point (validateToolArguments) and get the SAME repair mode -
		// no batch-aware second path, no per-call special casing.
		expect(repaired).toEqual([{ value: "a" }, { value: "b" }]);
		expect(events).toEqual([
			{ outcome: "repaired", repairsApplied: ["jsonStringParse"] },
			{ outcome: "repaired", repairsApplied: ["jsonStringParse"] },
		]);
	});

	it("declares the full curated no-native-tools variant set (no desync with agent-session's TEXT_TOOL_PROTOCOL_VARIANTS)", () => {
		const variants: readonly TextToolProtocolVariant[] = ["tool-tag", "tool-call", "fenced-json", "function-xml"];
		for (const variant of variants) {
			expect(formatVariantEnvelope(variant, "read", '{"path":"x"}')).toBeTruthy();
		}
	});
});
