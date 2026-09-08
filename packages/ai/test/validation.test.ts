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

	it("names the violated constraint for a well-typed value instead of repeating its type", () => {
		const tool: Tool = {
			name: "brief",
			description: "Brief",
			parameters: Type.Object({
				task: Type.Optional(Type.String({ maxLength: 3_500 })),
				tags: Type.Optional(Type.Array(Type.String(), { maxItems: 2 })),
			}),
		};
		const events: unknown[] = [];
		const telemetry = (event: unknown) => events.push(event);

		expect(() =>
			validateToolArguments(
				tool,
				{
					type: "toolCall",
					id: "tool-long",
					name: "brief",
					arguments: { task: "x".repeat(3_610), tags: ["a", "b", "c"] },
				},
				{ model: "test-model", provider: "test-provider", telemetry, repairEnabled: false },
			),
		).toThrow("Validation failed");

		expect(events).toEqual([
			expect.objectContaining({
				outcome: "bounced",
				failureShape: expect.arrayContaining([
					{
						path: "task",
						expectedType: "string",
						receivedType: "string",
						keyword: "maxLength",
						constraint: "must not have more than 3500 characters (received 3610 characters)",
					},
					{
						path: "tags",
						expectedType: "array",
						receivedType: "array",
						keyword: "maxItems",
						constraint: "must not have more than 2 items (received 3 items)",
					},
				]),
			}),
		]);
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
		// One line for the failed discriminator decision, listing every branch literal.
		expect(message).toContain('scope: must be one of "project", "user"; Allowed values: "project", "user"');
		expect(message).not.toContain("must equal");
		expect(message).not.toContain("scope: expected string, received string");
		expect(events).toMatchObject([
			{
				failureShape: [
					{ path: "scope", expectedType: 'one of "project", "user"', receivedType: "string", keyword: "enum" },
				],
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

	it("retains independent false-schema and boolean-type errors beside forbidden properties", () => {
		const tool: Tool = {
			name: "strict",
			description: "Strict tool",
			parameters: {
				type: "object",
				properties: { denied: false, enabled: { type: "boolean" } },
				additionalProperties: false,
			} as Tool["parameters"],
		};
		const events: unknown[] = [];
		expect(() =>
			validateToolArguments(
				tool,
				{
					type: "toolCall",
					id: "independent-errors",
					name: "strict",
					arguments: { denied: 1, enabled: "invalid", extra: 2 },
				},
				{ telemetry: (event) => events.push(event) },
			),
		).toThrow(ToolArgumentValidationError);
		expect(events).toMatchObject([
			{
				errorKeywords: ["additionalProperties", "boolean", "type"],
				failureShape: [
					{ path: "extra", keyword: "additionalProperties" },
					{ path: "denied", keyword: "boolean" },
					{ path: "enabled", keyword: "type" },
				],
			},
		]);
		const valid = { enabled: true };
		expect(
			validateToolArguments(tool, { type: "toolCall", id: "valid-control", name: "strict", arguments: valid }),
		).toBe(valid);
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

	it("reports the missing discriminator as a property-level required error, not the branch object", () => {
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-empty",
			name: "task_steps",
			arguments: {},
		};
		const events: unknown[] = [];
		let message = "";
		try {
			validateToolArguments(taskSteps, toolCall, { telemetry: (event) => events.push(event) });
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}

		expect(message).toContain('action: required, one of "set", "list", "update"');
		expect(message).not.toMatch(/action:[^\n]*object/);
		// Branch-contingent requirements and the union shell's false "expected object" are not reported:
		// the only decision that failed is the discriminator.
		expect(message).not.toContain("steps:");
		expect(message).not.toContain("id:");
		expect(message).not.toContain("root:");
		expect(message.split("\n").filter((line) => line.startsWith("  - "))).toHaveLength(1);

		expect(events).toMatchObject([
			{
				outcome: "bounced",
				failureShape: expect.arrayContaining([
					{
						path: "action",
						expectedType: 'one of "set", "list", "update"',
						receivedType: "missing",
						keyword: "required",
					},
				]),
			},
		]);
	});

	function failureMessage(tool: Tool, args: unknown): string {
		try {
			validateToolArguments(tool, {
				type: "toolCall",
				id: "union-diagnostics",
				name: tool.name,
				arguments: args as Record<string, unknown>,
			});
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
		return "";
	}

	it("reports an unknown discriminator once with every branch literal, never one line per branch", () => {
		const message = failureMessage(taskSteps, { action: "nope" });
		expect(message).toContain('action: must be one of "set", "list", "update"');
		expect(message).not.toContain("must equal");
		expect(message).not.toContain("steps:");
		expect(message).not.toContain("root:");
		expect(message.split("\n").filter((line) => line.startsWith("  - "))).toHaveLength(1);
	});

	it("reports a non-object union argument as one root line instead of one per branch", () => {
		const message = failureMessage(taskSteps, "str");
		expect(message.match(/root: expected object/g)).toHaveLength(1);
	});

	it("consolidates a nested union at its own instance path", () => {
		const route: Tool = {
			name: "route",
			description: "route",
			parameters: Type.Object({
				target: Type.Union([
					Type.Object({ kind: Type.Literal("a"), x: Type.String() }),
					Type.Object({ kind: Type.Literal("b"), y: Type.Number() }),
				]),
			}),
		};
		const missing = failureMessage(route, { target: {} });
		expect(missing).toContain('target.kind: required, one of "a", "b"');
		expect(missing.split("\n").filter((line) => line.startsWith("  - "))).toHaveLength(1);
		const unknown = failureMessage(route, { target: { kind: "z" } });
		expect(unknown).toContain('target.kind: must be one of "a", "b"');
		expect(unknown.split("\n").filter((line) => line.startsWith("  - "))).toHaveLength(1);
		const scalar = failureMessage(route, { target: 3 });
		expect(scalar.match(/target: expected object/g)).toHaveLength(1);
	});

	it("keeps each branch's requirements and drops the union shell for a union without a discriminator", () => {
		const write: Tool = {
			name: "write",
			description: "write",
			parameters: Type.Union([
				Type.Object({ path: Type.String(), content: Type.String() }),
				Type.Object({ path: Type.String(), contentRef: Type.String() }),
			]),
		};
		const message = failureMessage(write, { path: "a" });
		expect(message).toContain("content: required, expected string");
		expect(message).toContain("contentRef: required, expected string");
		expect(message).not.toContain("root:");
	});

	it("reports a missing non-discriminator property with its own expected type, not the branch object", () => {
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-set-missing-steps",
			name: "task_steps",
			arguments: { action: "set" },
		};
		const events: unknown[] = [];
		let message = "";
		try {
			validateToolArguments(taskSteps, toolCall, { telemetry: (event) => events.push(event) });
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}

		expect(message).toContain("steps: required, expected array");
		expect(message).not.toMatch(/steps: [^;]*object/);

		expect(events).toMatchObject([
			{
				outcome: "bounced",
				failureShape: [
					{
						path: "steps",
						expectedType: "array",
						receivedType: "missing",
						keyword: "required",
					},
				],
			},
		]);
	});
});
