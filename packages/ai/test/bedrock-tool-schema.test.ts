import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { type BedrockOptions, streamBedrock } from "../src/providers/amazon-bedrock.ts";
import type { Context, Model, Tool } from "../src/types.ts";
import { validateToolArguments } from "../src/utils/validation.ts";

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

interface BedrockPayload {
	toolConfig?: {
		tools?: Array<{ toolSpec?: { description?: string; inputSchema?: { json?: Record<string, unknown> } } }>;
	};
}

function model(): Model<"bedrock-converse-stream"> {
	return getModel("amazon-bedrock", "us.anthropic.claude-sonnet-5");
}

async function captureToolConfig(parameters: unknown, options?: BedrockOptions): Promise<BedrockPayload["toolConfig"]> {
	let payload: BedrockPayload | undefined;
	const context: Context = {
		messages: [{ role: "user", content: "hello", timestamp: 1 }],
		tools: [{ name: "union_tool", description: "Union tool", parameters: parameters as never }],
	};
	const stream = streamBedrock(model(), context, {
		...options,
		onPayload: (value) => {
			payload = value as BedrockPayload;
			throw new PayloadCaptured();
		},
	});
	await stream.result();
	return payload?.toolConfig;
}

describe("Bedrock tool input schemas", () => {
	it("never emits a top-level combinator for object-union tools", async () => {
		const toolConfig = await captureToolConfig({
			anyOf: [
				{
					type: "object",
					properties: { path: { type: "string" }, content: { type: "string" } },
					required: ["path", "content"],
					additionalProperties: false,
				},
				{
					type: "object",
					properties: { path: { type: "string" }, payloadRef: { type: "string" } },
					required: ["path", "payloadRef"],
					additionalProperties: false,
				},
			],
		});

		const schema = toolConfig?.tools?.[0]?.toolSpec?.inputSchema?.json;
		expect(schema).toMatchObject({
			type: "object",
			properties: {
				path: { type: "string" },
				content: { type: "string" },
				payloadRef: { type: "string" },
			},
			required: ["path"],
		});
		expect(schema).not.toHaveProperty("anyOf");
		expect(schema).not.toHaveProperty("oneOf");
		expect(schema).not.toHaveProperty("allOf");
		expect(toolConfig?.tools?.[0]?.toolSpec?.description).toContain(
			"provide parameters for at least one of the documented alternatives: (path, content) or (path, payloadRef)",
		);
		expect(toolConfig?.tools?.[0]?.toolSpec?.description).toMatch(/^Input constraint:/);
	});

	it("sends an object root for a union of object tool inputs", async () => {
		const toolConfig = await captureToolConfig({
			anyOf: [
				{ type: "object", properties: { path: { type: "string" } }, required: ["path"] },
				{ type: "object", properties: { payloadRef: { type: "string" } }, required: ["payloadRef"] },
			],
		});

		const schema = toolConfig?.tools?.[0]?.toolSpec?.inputSchema?.json;
		expect(schema?.type).toBe("object");
		expect(schema?.properties).toMatchObject({ path: { type: "string" }, payloadRef: { type: "string" } });
	});

	it("preserves an already-valid object schema", async () => {
		const toolConfig = await captureToolConfig({
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		});

		expect(toolConfig?.tools?.[0]?.toolSpec?.inputSchema?.json).toEqual({
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		});
	});

	it("adds the object root omitted by an otherwise object-shaped schema", async () => {
		const toolConfig = await captureToolConfig({
			properties: { path: { type: "string" } },
			required: ["path"],
		});

		expect(toolConfig?.tools?.[0]?.toolSpec?.inputSchema?.json).toEqual({
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		});
	});

	it("projects an empty object union without a root combinator", async () => {
		const toolConfig = await captureToolConfig({
			anyOf: [{ type: "object" }, { type: "object", additionalProperties: false }],
		});

		const schema = toolConfig?.tools?.[0]?.toolSpec?.inputSchema?.json;
		expect(schema).toEqual({ type: "object", properties: {}, required: [] });
	});

	it("resolves local object references into the root projection", async () => {
		const toolConfig = await captureToolConfig({
			$defs: {
				fromRef: { type: "object", properties: { path: { type: "string" } } },
			},
			anyOf: [{ $ref: "#/$defs/fromRef" }, { type: "object", properties: { mode: { type: "string" } } }],
		});

		const schema = toolConfig?.tools?.[0]?.toolSpec?.inputSchema?.json;
		expect(schema?.type).toBe("object");
		expect(schema?.properties).toEqual({ path: { type: "string" }, mode: { type: "string" } });
		expect(schema?.$defs).toEqual({
			fromRef: { type: "object", properties: { path: { type: "string" } } },
		});
		expect(schema).not.toHaveProperty("anyOf");
	});

	it.each(["oneOf", "allOf"] as const)("normalizes a root %s of object branches", async (combinator) => {
		const toolConfig = await captureToolConfig({
			[combinator]: [
				{ type: "object", properties: { path: { type: "string" } } },
				{ type: "object", properties: { mode: { type: "string" } } },
			],
		});

		const schema = toolConfig?.tools?.[0]?.toolSpec?.inputSchema?.json;
		expect(schema?.type).toBe("object");
		expect(schema).not.toHaveProperty(combinator);
	});

	it("keeps only common alternative requirements and merges allOf requirements", async () => {
		const alternativeConfig = await captureToolConfig({
			oneOf: [
				{
					type: "object",
					properties: { shared: { type: "string" }, first: { type: "string" } },
					required: ["shared", "first"],
				},
				{
					type: "object",
					properties: { shared: { type: "string" }, second: { type: "string" } },
					required: ["shared", "second"],
				},
			],
		});
		const allConfig = await captureToolConfig({
			allOf: [
				{ type: "object", properties: { first: { type: "string" } }, required: ["first"] },
				{ type: "object", properties: { second: { type: "string" } }, required: ["second"] },
			],
		});

		expect(alternativeConfig?.tools?.[0]?.toolSpec?.inputSchema?.json?.required).toEqual(["shared"]);
		expect(allConfig?.tools?.[0]?.toolSpec?.inputSchema?.json?.required).toEqual(["first", "second"]);
		expect(alternativeConfig?.tools?.[0]?.toolSpec?.description).toContain("exactly one");
		expect(allConfig?.tools?.[0]?.toolSpec?.description).toContain("all listed parameters apply together");
	});

	it("keeps an explicit root property when a branch defines it differently", async () => {
		const toolConfig = await captureToolConfig({
			properties: { value: { type: "boolean" } },
			anyOf: [
				{ type: "object", properties: { value: { type: "string" }, first: { type: "string" } } },
				{ type: "object", properties: { second: { type: "string" } } },
			],
		});

		expect(toolConfig?.tools?.[0]?.toolSpec?.inputSchema?.json?.properties).toEqual({
			value: { type: "boolean" },
			first: { type: "string" },
			second: { type: "string" },
		});
	});

	it("rejects a malformed root combinator instead of forwarding it", async () => {
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
			tools: [
				{
					name: "malformed_tool",
					description: "Malformed tool",
					parameters: { type: "object", anyOf: { type: "object" } } as never,
				},
			],
		};
		const result = await streamBedrock(model(), context).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain('Bedrock tool "malformed_tool" requires an object input schema');
	});

	it("adds an object root only when a local root reference resolves to an object", async () => {
		const toolConfig = await captureToolConfig({
			$defs: { input: { type: "object", properties: { path: { type: "string" } } } },
			$ref: "#/$defs/input",
		});

		expect(toolConfig?.tools?.[0]?.toolSpec?.inputSchema?.json).toEqual({
			$defs: { input: { type: "object", properties: { path: { type: "string" } } } },
			$ref: "#/$defs/input",
			type: "object",
		});
	});

	it("rejects a primitive union instead of turning it into an object schema", async () => {
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
			tools: [
				{
					name: "primitive_tool",
					description: "Primitive tool",
					parameters: { anyOf: [{ type: "string" }, { type: "null" }] } as never,
				},
			],
		};
		const result = await streamBedrock(model(), context).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain('Bedrock tool "primitive_tool" requires an object input schema');
	});

	it("rejects a primitive branch even when it carries incidental object keywords", async () => {
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
			tools: [
				{
					name: "mixed_tool",
					description: "Mixed tool",
					parameters: {
						anyOf: [
							{ type: "string", properties: { misleading: { type: "string" } } },
							{ type: "object", properties: { path: { type: "string" } } },
						],
					} as never,
				},
			],
		};
		const result = await streamBedrock(model(), context).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain('Bedrock tool "mixed_tool" requires an object input schema');
	});

	it("does not override an explicit primitive root with an object union", async () => {
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
			tools: [
				{
					name: "primitive_root_tool",
					description: "Primitive root tool",
					parameters: {
						type: "string",
						anyOf: [{ type: "object", properties: { path: { type: "string" } } }],
					} as never,
				},
			],
		};
		const result = await streamBedrock(model(), context).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain('Bedrock tool "primitive_root_tool" requires an object input schema');
	});

	it("rejects an unresolved or primitive local root reference", async () => {
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
			tools: [
				{
					name: "ref_tool",
					description: "Ref tool",
					parameters: {
						$defs: { input: { type: "string" } },
						$ref: "#/$defs/input",
					} as never,
				},
			],
		};
		const result = await streamBedrock(model(), context).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain('Bedrock tool "ref_tool" requires an object input schema');
	});

	it("rejects an ambiguous schema instead of assuming every schema is an object", async () => {
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
			tools: [
				{
					name: "ambiguous_tool",
					description: "Ambiguous tool",
					parameters: { description: "Could describe any JSON value" } as never,
				},
			],
		};
		const result = await streamBedrock(model(), context).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain('Bedrock tool "ambiguous_tool" requires an object input schema');
	});

	it("uses the first conflicting property projection without retaining the root union", async () => {
		const toolConfig = await captureToolConfig({
			anyOf: [
				{ type: "object", properties: { value: { type: "string" } }, required: ["value"] },
				{ type: "object", properties: { value: { type: "number" } }, required: ["value"] },
			],
		});

		const schema = toolConfig?.tools?.[0]?.toolSpec?.inputSchema?.json;
		expect(schema?.type).toBe("object");
		expect(schema?.properties).toEqual({ value: { type: "string" } });
		expect(schema).not.toHaveProperty("anyOf");
	});

	it("rejects mixed root combinators rather than silently discarding constraints", async () => {
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
			tools: [
				{
					name: "mixed_composition_tool",
					description: "Mixed composition tool",
					parameters: {
						anyOf: [{ type: "object", properties: { path: { type: "string" } } }],
						allOf: [{ type: "object", properties: { mode: { type: "string" } } }],
					} as never,
				},
			],
		};
		const result = await streamBedrock(model(), context).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain('Bedrock tool "mixed_composition_tool" requires an object input schema');
	});

	it("drops unsupported property names and malformed property schemas from the wire projection", async () => {
		const toolConfig = await captureToolConfig({
			anyOf: [
				{
					type: "object",
					properties: {
						valid_name: { type: "string" },
						"invalid name": { type: "string" },
						malformed: null,
					},
					required: ["valid_name", "invalid name", "malformed"],
				},
				{ type: "object", properties: { valid_name: { type: "string" } }, required: ["valid_name"] },
			],
		});

		expect(toolConfig?.tools?.[0]?.toolSpec?.inputSchema?.json).toMatchObject({
			type: "object",
			properties: { valid_name: { type: "string" } },
			required: ["valid_name"],
		});
	});

	it("detaches the provider projection from the authoritative local schema", async () => {
		const parameters = {
			type: "object",
			properties: { nested: { type: "object", properties: { value: { type: "string" } } } },
		};
		const toolConfig = await captureToolConfig(parameters);
		const properties = toolConfig?.tools?.[0]?.toolSpec?.inputSchema?.json?.properties as
			| Record<string, unknown>
			| undefined;
		const nested = properties?.nested;
		expect(nested).toBeDefined();
		(nested as Record<string, unknown>).description = "payload-only mutation";

		expect(parameters.properties.nested).not.toHaveProperty("description");
	});

	it("keeps execution validation on the original union after flattening the wire schema", async () => {
		const parameters = Type.Union([
			Type.Object({ path: Type.String(), content: Type.String() }),
			Type.Object({ path: Type.String(), payloadRef: Type.String() }),
		]);
		const tool: Tool = { name: "union_tool", description: "Union tool", parameters };
		const toolConfig = await captureToolConfig(parameters);

		expect(toolConfig?.tools?.[0]?.toolSpec?.inputSchema?.json?.required).toEqual(["path"]);
		expect(() =>
			validateToolArguments(
				tool,
				{ type: "toolCall", id: "call-1", name: tool.name, arguments: { path: "file.txt" } },
				{ repairEnabled: false },
			),
		).toThrow('Validation failed for tool "union_tool"');
	});

	it("fails closed when an explicit tool choice includes another invalid schema", async () => {
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
			tools: [
				{
					name: "valid_tool",
					description: "Valid tool",
					parameters: { type: "object", properties: { path: { type: "string" } } } as never,
				},
				{
					name: "invalid_tool",
					description: "Invalid tool",
					parameters: { type: "array", items: { type: "string" } } as never,
				},
			],
		};
		const result = await streamBedrock(model(), context, {
			toolChoice: { type: "tool", name: "valid_tool" },
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain('Bedrock tool "invalid_tool" requires an object input schema');
	});
});
