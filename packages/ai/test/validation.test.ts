import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { Tool, ToolCall } from "../src/types.ts";
import { validateToolArguments } from "../src/utils/validation.ts";

function createToolCallWithPlainSchema(
	schema: Tool["parameters"],
	value: unknown,
): {
	tool: Tool;
	toolCall: ToolCall;
} {
	const tool: Tool = {
		name: "echo",
		description: "Echo tool",
		parameters: {
			type: "object",
			properties: {
				value: schema,
			},
			required: ["value"],
		} as Tool["parameters"],
	};

	const toolCall: ToolCall = {
		type: "toolCall",
		id: "tool-1",
		name: "echo",
		arguments: { value },
	};

	return { tool, toolCall };
}

describe("validateToolArguments", () => {
	it("still validates when Function constructor is unavailable", () => {
		const originalFunction = globalThis.Function;
		const tool: Tool = {
			name: "echo",
			description: "Echo tool",
			parameters: Type.Object({
				count: Type.Number(),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "echo",
			arguments: { count: "42" as unknown as number },
		};

		globalThis.Function = (() => {
			throw new EvalError("Code generation from strings disallowed for this context");
		}) as unknown as FunctionConstructor;

		try {
			expect(validateToolArguments(tool, toolCall)).toEqual({ count: 42 });
		} finally {
			globalThis.Function = originalFunction;
		}
	});

	it("repairs serialized plain JSON schemas with deterministic scalar rules", () => {
		const passingCases: Array<{
			schema: Tool["parameters"];
			input: unknown;
			expected: unknown;
		}> = [
			{ schema: { type: "number" } as Tool["parameters"], input: "42", expected: 42 },
			{ schema: { type: "integer" } as Tool["parameters"], input: "42", expected: 42 },
			{ schema: { type: "boolean" } as Tool["parameters"], input: "true", expected: true },
			{ schema: { type: "boolean" } as Tool["parameters"], input: "false", expected: false },
			{
				schema: { type: ["number", "string"] } as Tool["parameters"],
				input: "1",
				expected: "1",
			},
		];

		for (const testCase of passingCases) {
			const { tool, toolCall } = createToolCallWithPlainSchema(testCase.schema, testCase.input);
			expect(validateToolArguments(tool, toolCall)).toEqual({ value: testCase.expected });
		}
	});

	it("returns valid arguments unchanged without telemetry hot-path work", () => {
		const tool: Tool = {
			name: "count",
			description: "Count",
			parameters: Type.Object({ count: Type.String(), mode: Type.Optional(Type.Literal("42")) }),
		};
		const args = { count: "42", mode: "42" };
		const events: unknown[] = [];
		const result = validateToolArguments(
			tool,
			{ type: "toolCall", id: "tool-1", name: "count", arguments: args },
			{ model: "test-model", provider: "test-provider", telemetry: (event) => events.push(event) },
		);

		expect(result).toBe(args);
		expect(events).toEqual([]);
	});

	it("emits shape-only validation telemetry for repaired and bounced calls", () => {
		const tool: Tool = {
			name: "count",
			description: "Count",
			parameters: Type.Object({ count: Type.Number() }),
		};
		const events: unknown[] = [];
		const telemetry = (event: unknown) => events.push(event);

		expect(
			validateToolArguments(
				tool,
				{ type: "toolCall", id: "tool-2", name: "count", arguments: { count: "42" as unknown as number } },
				{ model: "test-model", provider: "test-provider", telemetry },
			),
		).toEqual({ count: 42 });
		expect(() =>
			validateToolArguments(
				tool,
				{
					type: "toolCall",
					id: "tool-3",
					name: "count",
					arguments: { count: "secret-value" as unknown as number },
				},
				{ model: "test-model", provider: "test-provider", telemetry },
			),
		).toThrow("Validation failed");

		expect(events).toEqual([
			{
				outcome: "repaired",
				model: "test-model",
				provider: "test-provider",
				tool: "count",
				failureModes: ["numberFromString"],
				repairsApplied: ["numberFromString"],
				taught: "none",
				executionOutcome: "not_run",
			},
			{
				outcome: "bounced",
				model: "test-model",
				provider: "test-provider",
				tool: "count",
				failureModes: ["numberFromString"],
				repairsApplied: [],
				taught: "none",
				executionOutcome: "not_run",
				failureShape: [
					{ path: "count", expectedType: "number", receivedType: "string", keyword: expect.any(String) },
				],
				errorKeywords: [expect.any(String)],
			},
		]);
		expect(JSON.stringify(events)).not.toContain("secret-value");
	});

	it("honors the internal diagnostic repair kill while keeping validation bounces", () => {
		const tool: Tool = {
			name: "count",
			description: "Count",
			parameters: Type.Object({ count: Type.Number() }),
		};
		const events: unknown[] = [];

		expect(() =>
			validateToolArguments(
				tool,
				{ type: "toolCall", id: "tool-1", name: "count", arguments: { count: "42" as unknown as number } },
				{ repairEnabled: false, telemetry: (event) => events.push(event) },
			),
		).toThrow("Validation failed");
		expect(events).toMatchObject([{ outcome: "bounced", failureModes: ["numberFromString"], repairsApplied: [] }]);
	});

	it("includes expected schema fragments and received values in validation bounces", () => {
		const tool: Tool = {
			name: "search",
			description: "Search",
			parameters: Type.Object({
				query: Type.Object({
					limit: Type.Number({ minimum: 1 }),
					mode: Type.Union([Type.Literal("fast"), Type.Literal("deep")]),
				}),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "search",
			arguments: { query: { limit: "many", mode: "slow" } },
		};

		expect(() => validateToolArguments(tool, toolCall)).toThrow(
			/Validation failed for tool "search":\n[\s\S]*query\.limit:[\s\S]*Expected schema: \{"type":"number","minimum":1\}[\s\S]*Example: 1[\s\S]*Received: "many"[\s\S]*query\.mode:[\s\S]*Expected schema: \{"enum":\["fast","deep"\]\}[\s\S]*Example: "fast"[\s\S]*Received: "slow"/,
		);
	});

	it("caps oversized expected schema fragments without dropping failing paths", () => {
		const tool: Tool = {
			name: "select",
			description: "Select",
			parameters: {
				type: "object",
				properties: {
					first: { enum: Array.from({ length: 80 }, (_, index) => `first-${index}`) },
					second: { enum: Array.from({ length: 80 }, (_, index) => `second-${index}`) },
				},
				required: ["first", "second"],
			} as Tool["parameters"],
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "select",
			arguments: { first: "nope", second: "nope" },
		};

		try {
			validateToolArguments(tool, toolCall);
			throw new Error("validation unexpectedly passed");
		} catch (error) {
			const message = String(error instanceof Error ? error.message : error);
			expect(message).toContain("first:");
			expect(message).toContain("second:");
			expect(message).toContain("Expected schema:");
			expect(message).toContain("...[truncated]");
			expect(message.length).toBeLessThan(5000);
		}
	});

	it("rejects invalid coercions for serialized plain JSON schemas", () => {
		const failingCases: Array<{
			schema: Tool["parameters"];
			input: unknown;
		}> = [
			{ schema: { type: "boolean" } as Tool["parameters"], input: "1" },
			{ schema: { type: "boolean" } as Tool["parameters"], input: "0" },
			{ schema: { type: "null" } as Tool["parameters"], input: "null" },
			{ schema: { type: "integer" } as Tool["parameters"], input: "42.1" },
			{ schema: { type: "number" } as Tool["parameters"], input: null },
			{ schema: { type: "string" } as Tool["parameters"], input: null },
		];

		for (const testCase of failingCases) {
			const { tool, toolCall } = createToolCallWithPlainSchema(testCase.schema, testCase.input);
			expect(() => validateToolArguments(tool, toolCall)).toThrow("Validation failed");
		}
	});
});
