import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { Tool, ToolCall } from "../src/types.ts";
import {
	getValidator,
	selectUnionBranch,
	ToolArgumentValidationError,
	validateToolArguments,
} from "../src/utils/validation.ts";

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

	it("guides union-of-object roots and literal failures with the concrete allowed values", () => {
		const tool: Tool = {
			name: "scoped",
			description: "Scoped tool",
			parameters: Type.Union([
				Type.Object({ scope: Type.Literal("project") }),
				Type.Object({ scope: Type.Literal("user") }),
			]),
		};

		expect(() =>
			validateToolArguments(tool, {
				type: "toolCall",
				id: "union-root",
				name: "scoped",
				arguments: "not-an-object" as unknown as Record<string, unknown>,
			}),
		).toThrow(/root: expected object/i);

		let thrown: unknown;
		const events: unknown[] = [];
		try {
			validateToolArguments(
				tool,
				{
					type: "toolCall",
					id: "literal",
					name: "scoped",
					arguments: { scope: "workspace" },
				},
				{ telemetry: (event) => events.push(event) },
			);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(ToolArgumentValidationError);
		const message = (thrown as ToolArgumentValidationError).message;
		expect(message).toContain('scope: must equal "project"; Allowed values: "project"');
		expect(message).not.toContain("scope: expected string, received string");
		expect(events).toMatchObject([
			{
				failureShape: expect.arrayContaining([
					{ path: "scope", expectedType: 'literal "project"', receivedType: "string", keyword: "const" },
				]),
			},
		]);
		// Negative control: the first discriminated branch remains a usable valid example.
		expect((thrown as ToolArgumentValidationError).enrichment).toContain('Valid example:\n{"scope":"project"}');
	});

	it("builds a validator-passing minimal example for a union-shaped edit schema", () => {
		const tool: Tool = {
			name: "edit",
			description: "Edit a file",
			parameters: Type.Union([
				Type.Object({
					path: Type.String({ minLength: 1 }),
					edits: Type.Array(Type.Object({ oldText: Type.String({ minLength: 1 }), newText: Type.String() }), {
						minItems: 1,
					}),
				}),
				Type.Object({ path: Type.String({ minLength: 1 }), payloadRef: Type.String({ minLength: 1 }) }),
			]),
		};

		let thrown: unknown;
		try {
			validateToolArguments(tool, {
				type: "toolCall",
				id: "edit-union",
				name: "edit",
				arguments: {} as Record<string, unknown>,
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(ToolArgumentValidationError);
		const enrichment = (thrown as ToolArgumentValidationError).enrichment;
		const exampleText = enrichment.match(/Valid example:\n(.*)$/)?.[1];
		expect(exampleText).toBeDefined();
		const example = JSON.parse(exampleText ?? "{}");
		expect(getValidator(tool.parameters).Check(example)).toBe(true);
	});

	it("omits an example rather than allocating from pathological minimum metadata", () => {
		const tool: Tool = {
			name: "oversized",
			description: "Oversized schema",
			parameters: Type.Object({
				values: Type.Array(Type.String(), { minItems: 10_000 }),
				label: Type.String({ minLength: 10_000 }),
			}),
		};

		let thrown: unknown;
		try {
			validateToolArguments(tool, {
				type: "toolCall",
				id: "oversized-example",
				name: "oversized",
				arguments: {},
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(ToolArgumentValidationError);
		const enrichment = (thrown as ToolArgumentValidationError).enrichment;
		expect(enrichment).not.toContain("Valid example:");
		expect(enrichment.length).toBeLessThan(5_000);
	});

	it("identifies the exact forbidden nested property in validation diagnostics", () => {
		const tool: Tool = {
			name: "delegate",
			description: "Delegate",
			parameters: Type.Object(
				{
					authority: Type.Object(
						{
							model: Type.Object(
								{ provider: Type.String(), modelId: Type.String() },
								{ additionalProperties: false },
							),
							thinkingLevel: Type.Optional(Type.String()),
						},
						{ additionalProperties: false },
					),
				},
				{ additionalProperties: false },
			),
		};
		const events: unknown[] = [];
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-nested-extra",
			name: "delegate",
			arguments: {
				authority: {
					model: { provider: "provider", modelId: "model", thinkingLevel: "high" },
				},
			},
		};

		expect(() => validateToolArguments(tool, toolCall, { telemetry: (event) => events.push(event) })).toThrow(
			/authority\.model\.thinkingLevel: must not have additional properties/,
		);
		expect(events).toMatchObject([
			{
				outcome: "bounced",
				failureShape: [
					{
						path: "authority.model.thinkingLevel",
						expectedType: "forbidden",
						receivedType: "string",
						keyword: "additionalProperties",
					},
				],
				errorKeywords: ["additionalProperties"],
			},
		]);
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

describe("discriminated unions", () => {
	const taskSteps: Tool = {
		name: "task_steps",
		description: "steps",
		parameters: Type.Union([
			Type.Object({ action: Type.Literal("set"), steps: Type.Array(Type.Object({ content: Type.String() })) }),
			Type.Object({ action: Type.Literal("list"), showCompleted: Type.Optional(Type.Boolean()) }),
			Type.Object({ action: Type.Literal("update"), id: Type.String() }),
		]),
	};

	it("selects the branch the action names", () => {
		expect(selectUnionBranch(taskSteps.parameters, { action: "list" })).toMatchObject({
			properties: { action: { const: "list" } },
		});
		expect(selectUnionBranch(taskSteps.parameters, { action: "nope" })).toBeUndefined();
		expect(selectUnionBranch(Type.Object({ a: Type.String() }), { a: 1 })).toBeUndefined();
	});

	it("coerces a string boolean on the named branch instead of reporting another branch's fields", () => {
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-list",
			name: "task_steps",
			arguments: { action: "list", showCompleted: "true" as unknown as boolean },
		};
		expect(validateToolArguments(taskSteps, toolCall)).toEqual({ action: "list", showCompleted: true });
	});

	it("reports only the named branch's errors when repair is impossible", () => {
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-update",
			name: "task_steps",
			arguments: { action: "update", id: 42 as unknown as string },
		};
		let message = "";
		try {
			validateToolArguments(taskSteps, toolCall);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("id: expected string");
		expect(message).not.toContain("expected object");
		expect(message).not.toContain('"set"');
	});
});
