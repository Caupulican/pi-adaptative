import {
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	generateTextToolProtocolPrimer,
	type Message,
	type Model,
} from "@caupulican/pi-ai";
import { ToolArgumentValidationError, validateToolArguments } from "@caupulican/pi-ai/validation";
import { type TSchema, Type } from "typebox";
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { startAgentProviderRequest } from "../src/agent-loop.ts";
import { projectToolSchemaForProvider, projectToolsForProvider } from "../src/provider-tool-projection.ts";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";

const parameters = Type.Object(
	{
		action: Type.Union([Type.Literal("inspect"), Type.Literal("apply")], {
			description: "Exact operation. Apply mutates state and inspect does not.",
		}),
		path: Type.String({ minLength: 1, description: "Target path. Required for both operations." }),
		force: Type.Optional(
			Type.Boolean({
				default: false,
				description: "Set true only when the caller explicitly authorized replacement.",
			}),
		),
	},
	{ additionalProperties: false, description: "Arguments accepted by the exact execution contract." },
);

const tool: AgentTool<typeof parameters> = {
	name: "state_tool",
	label: "State tool",
	description: "Inspect or apply state.\nMUST use apply only with explicit replacement authority.",
	providerDescription: "Inspect state; apply only with explicit replacement authority.",
	parameters,
	async execute() {
		return { content: [{ type: "text", text: "ok" }], details: {} };
	},
};

function model(): Model<"openai-responses"> {
	return {
		id: "projection-test",
		name: "Projection test",
		api: "openai-responses",
		provider: "faux",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_768,
		maxTokens: 2_048,
	};
}

const convertToLlm = (messages: AgentMessage[]): Message[] =>
	messages.filter((message) => message.role !== "custom") as Message[];

describe("root discriminated union projection", () => {
	function unionTool(parameters: TSchema) {
		return projectToolsForProvider([
			{
				name: "task_steps",
				label: "Task steps",
				description: "Plan steps.",
				parameters,
				async execute() {
					return { content: [{ type: "text", text: "ok" }], details: {} };
				},
			} as AgentTool,
		])[0];
	}

	it("flattens a root object union into one object with the discriminator enum and per-action requirements", () => {
		// Live defect: grok-4.6 fused branch actions into invented names (`task_steps_vis-_-vis_set`) for
		// every tool whose wire schema was a root-level anyOf, while every flat-schema tool worked.
		const projected = unionTool(
			Type.Union([
				Type.Object(
					{ action: Type.Literal("set"), steps: Type.Array(Type.String({ minLength: 1 })) },
					{ additionalProperties: false },
				),
				Type.Object(
					{ action: Type.Literal("update"), id: Type.String(), status: Type.Optional(Type.String()) },
					{ additionalProperties: false },
				),
				Type.Object({ action: Type.Literal("list") }, { additionalProperties: false }),
				Type.Object({ action: Type.Literal("clear"), id: Type.Number() }, { additionalProperties: false }),
			]),
		);
		expect(projected.parameters).toEqual({
			type: "object",
			properties: {
				action: { type: "string", enum: ["set", "update", "list", "clear"] },
				steps: { type: "array", items: { type: "string", minLength: 1 } },
				id: { anyOf: [{ type: "string" }, { type: "number" }] },
				status: { type: "string" },
			},
			required: ["action"],
		});
		expect(projected.description).toBe(
			'Plan steps. Arguments by action: "set" requires steps; "update" requires id, accepts status; "list" takes no other arguments; "clear" requires id.',
		);
	});

	it("leaves a root union without a shared string discriminator untouched", () => {
		const projected = unionTool(
			Type.Union([
				Type.Object({ path: Type.String() }, { additionalProperties: false }),
				Type.Object({ url: Type.String() }, { additionalProperties: false }),
			]),
		);
		expect(projected.parameters).toMatchObject({ type: "object", anyOf: [{}, {}] });
		expect(projected.description).toBe("Plan steps.");
	});
});

describe("provider tool projection", () => {
	it("makes object-only unions explicit without narrowing mixed or unconstrained branches", () => {
		const schema = Type.Union([
			Type.Object({ path: Type.String() }, { additionalProperties: false }),
			Type.Object({ ref: Type.String() }, { additionalProperties: false }),
		]);
		const projected = projectToolSchemaForProvider(schema) as typeof schema;
		expect(projected).toMatchObject({ type: "object" });
		const original = Compile(schema);
		const output = Compile(projected);
		for (const value of [null, [], 1, "text", {}, { path: "a" }, { ref: "b" }, { path: "a", ref: "b" }]) {
			expect(output.Check(value)).toBe(original.Check(value));
		}
		for (const branch of [Type.String(), {}, true]) {
			const mixed = { anyOf: [schema.anyOf[0], branch] };
			expect(projectToolSchemaForProvider(mixed)).toEqual(mixed);
		}
		expect(projectToolSchemaForProvider({ anyOf: [] })).toEqual({ anyOf: [] });
		expect(schema).not.toHaveProperty("type");
	});
	it("projects an action union to one flat provider object and keeps validation on the full union", () => {
		const schema = Type.Union([
			Type.Object(
				{ action: Type.Literal("set"), count: Type.Integer({ minimum: 1 }) },
				{ additionalProperties: false },
			),
			Type.Object(
				{ action: Type.Literal("intake"), count: Type.Integer({ minimum: 1 }) },
				{ additionalProperties: false },
			),
			Type.Object({ action: Type.Literal("clear") }, { additionalProperties: false }),
			Type.Object({ action: Type.Literal("compact") }, { additionalProperties: false }),
			Type.Object(
				{ action: Type.Literal("limited"), count: Type.Integer({ minimum: 2 }) },
				{ additionalProperties: false },
			),
		]);
		const before = JSON.stringify(schema);
		const projected = projectToolSchemaForProvider(schema) as Record<string, unknown>;
		expect(JSON.stringify(schema)).toBe(before);
		// The wire shape is one object: every action as an enum, merged properties, shared requirements.
		expect(projected).toEqual({
			type: "object",
			properties: {
				action: { type: "string", enum: ["set", "intake", "clear", "compact", "limited"] },
				count: {
					anyOf: [
						{ type: "integer", minimum: 1 },
						{ type: "integer", minimum: 2 },
					],
				},
			},
			required: ["action"],
		});
		expect(JSON.stringify(projected).length).toBeLessThan(before.length);
		// Per-branch constraints stay with the authoritative schema the harness validates against.
		const originalValidator = Compile(schema);
		expect(originalValidator.Check({ action: "limited", count: 1 })).toBe(false);
		expect(originalValidator.Check({ action: "set", count: 1 })).toBe(true);
		expect(Compile(projected as never).Check({ action: "set", count: 1 })).toBe(true);
	});

	it("preserves exclusive unions and distinct branch requirements or discriminator constraints", () => {
		const branches = [
			{ properties: { action: { const: "a", type: "string" } }, required: ["action"] },
			{ properties: { action: { const: "b", type: "string" } }, required: [] },
			{ properties: { action: { const: "c", type: "string", pattern: "^c$" } }, required: ["action"] },
		];
		for (const schema of [{ anyOf: branches }, { oneOf: [branches[0], branches[0]] }]) {
			expect(projectToolSchemaForProvider(schema)).toEqual(schema);
		}
	});

	it("removes recurring schema prose while preserving the executable contract and source tool", () => {
		const before = JSON.stringify(tool);
		const [projected] = projectToolsForProvider([tool]);
		const projectedJson = JSON.stringify(projected);

		expect(projected).not.toBe(tool);
		expect(projected?.description).toBe("Inspect state; apply only with explicit replacement authority.");
		expect(projectedJson).not.toContain("Exact operation");
		expect(projectedJson).not.toContain("Target path");
		expect(projectedJson).not.toMatch(/"~(?:kind|optional)"/);
		expect(projectedJson).toContain('"required":["action","path"]');
		expect(projectedJson).toContain('"enum":["inspect","apply"]');
		expect(projectedJson).toContain('"additionalProperties":false');
		expect(projectedJson).toContain('"minLength":1');
		expect(projectedJson).toContain('"default":false');
		expect(projectedJson.length).toBeLessThan(before.length * 0.72);
		expect(JSON.stringify(tool)).toBe(before);
	});

	it("copies only enumerable JSON schema fields", () => {
		const valueSchema = { type: "string", pattern: "^[a-z]+$" };
		Object.defineProperty(valueSchema, "~kind", { value: "String", enumerable: false });
		Object.defineProperty(valueSchema, "~optional", { value: "Optional", enumerable: false });
		const schema = {
			type: "object",
			properties: { description: { type: "string" }, value: valueSchema },
			required: ["description", "value"],
		};

		const projected = projectToolSchemaForProvider(schema);

		expect(projected).toEqual(schema);
		expect(JSON.stringify(projected)).not.toMatch(/"~(?:kind|optional)"/);
		expect(JSON.stringify(projected)).toContain('"description":{"type":"string"}');
		expect(JSON.stringify(projected)).toContain('"pattern":"^[a-z]+$"');
	});

	it("preserves a schema property literally named __proto__ without mutating the projection prototype", () => {
		const schema = JSON.parse(
			'{"type":"object","properties":{"__proto__":{"type":"string"}},"required":["__proto__"]}',
		) as unknown;

		const projected = projectToolSchemaForProvider(schema) as Record<string, unknown>;

		expect(JSON.stringify(projected)).toContain('"__proto__":{"type":"string"}');
		expect(Object.getPrototypeOf(projected)).toBeNull();
	});

	it("compacts only pure primitive-literal unions", () => {
		const schema = {
			type: "object",
			properties: {
				action: {
					anyOf: [
						{ const: "inspect", type: "string", description: "read" },
						{ const: "apply", type: "string", description: "write" },
					],
				},
				payload: {
					anyOf: [
						{ type: "object", properties: { value: { type: "string" } }, required: ["value"] },
						{ type: "object", properties: { count: { type: "number" } }, required: ["count"] },
					],
				},
				mixed: {
					anyOf: [
						{ const: "all", type: "string" },
						{ const: 1, type: "number" },
					],
				},
			},
		};

		const projected = projectToolSchemaForProvider(schema) as typeof schema;

		expect(projected.properties.action).toEqual({ type: "string", enum: ["inspect", "apply"] });
		expect(projected.properties.payload.anyOf).toHaveLength(2);
		expect(projected.properties.payload.anyOf[0]).toMatchObject({ required: ["value"] });
		expect(projected.properties.payload.anyOf[1]).toMatchObject({ required: ["count"] });
		expect(projected.properties.mixed.anyOf).toHaveLength(2);
	});

	it("keeps `type` on an enum-bearing property even though every enum value already satisfies it", () => {
		// Providers whose function-declaration schema requires `type` per property (Google's
		// OpenAPI subset) reject the entire tool list with a 400 if `type` is dropped just because
		// it is redundant given a closed enum. minLength/maxLength stay safe to drop.
		const schema = {
			type: "object",
			properties: {
				mode: { type: "string", enum: ["inspect", "apply"], minLength: 1, maxLength: 20 },
			},
		};

		const projected = projectToolSchemaForProvider(schema) as typeof schema;

		expect(projected.properties.mode).toEqual({ type: "string", enum: ["inspect", "apply"] });
	});

	it("keeps exact full-schema teaching on the cold validation path", () => {
		try {
			validateToolArguments(tool, {
				type: "toolCall",
				id: "bad-call",
				name: tool.name,
				arguments: { action: "replace" },
			});
			throw new Error("Expected validation to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(ToolArgumentValidationError);
			const validationError = error as ToolArgumentValidationError;
			expect(validationError.enrichment).toContain("Exact operation");
			expect(validationError.enrichment).toContain("Target path");
			expect(validationError.enrichment).toContain("explicitly authorized replacement");
		}
	});

	it("keeps projected enum validation equivalent for representative valid and invalid calls", () => {
		const [projected] = projectToolsForProvider([tool]);
		const validCall = {
			type: "toolCall" as const,
			id: "valid-call",
			name: tool.name,
			arguments: { action: "apply", path: "state.json", force: true },
		};

		expect(() => validateToolArguments(projected, validCall)).not.toThrow();
		for (const argumentsValue of [
			{ action: "replace", path: "state.json" },
			{ action: "inspect" },
			{ action: "inspect", path: "state.json", unexpected: true },
		]) {
			expect(() =>
				validateToolArguments(projected, {
					type: "toolCall",
					id: "invalid-call",
					name: tool.name,
					arguments: argumentsValue,
				}),
			).toThrow(ToolArgumentValidationError);
		}
	});

	it("uses the same compact exact signature for text-only tool models", () => {
		const projected = projectToolsForProvider([tool]);
		const primer = generateTextToolProtocolPrimer(projected);

		expect(primer).toContain("state_tool(action:inspect|apply, path:string, force:bool?=false)");
		expect(primer).toContain("apply only with explicit replacement authority");
		expect(primer).not.toContain("Target path. Required for both operations.");
	});

	it("projects only the provider request while retaining original tools for execution", async () => {
		let seenContext: Context | undefined;
		const streamFn: NonNullable<Parameters<typeof startAgentProviderRequest>[3]> = (_model, context) => {
			seenContext = context;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("done") });
			});
			return stream;
		};
		const context: AgentContext = {
			systemPrompt: "base",
			messages: [{ role: "user", content: "go", timestamp: 1 }],
			tools: [tool],
		};
		const config: AgentLoopConfig = { model: model(), convertToLlm };

		await startAgentProviderRequest(context, config, undefined, streamFn);

		expect(seenContext?.tools?.[0]).not.toBe(tool);
		expect(JSON.stringify(seenContext?.tools?.[0]?.parameters)).not.toContain("Target path");
		expect(context.tools?.[0]).toBe(tool);
		expect(JSON.stringify(context.tools?.[0]?.parameters)).toContain("Target path");
	});
});
