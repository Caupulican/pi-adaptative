import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { type BedrockOptions, streamBedrock } from "../src/providers/amazon-bedrock.ts";
import type { Context, Model } from "../src/types.ts";

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

interface BedrockPayload {
	toolConfig?: {
		tools?: Array<{ toolSpec?: { inputSchema?: { json?: Record<string, unknown> } } }>;
	};
}

function model(): Model<"bedrock-converse-stream"> {
	return getModel("amazon-bedrock", "global.anthropic.claude-haiku-4-5-20251001-v1:0");
}

async function captureToolConfig(
	parameters: Record<string, unknown>,
	options?: BedrockOptions,
): Promise<BedrockPayload["toolConfig"]> {
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

	it("keeps an empty object union as an object-root schema", async () => {
		const toolConfig = await captureToolConfig({
			anyOf: [{ type: "object" }, { type: "object", additionalProperties: false }],
		});

		const schema = toolConfig?.tools?.[0]?.toolSpec?.inputSchema?.json;
		expect(schema?.type).toBe("object");
		expect(schema?.anyOf).toEqual([{ type: "object" }, { type: "object", additionalProperties: false }]);
	});

	it("preserves object references in local defs instead of flattening them away", async () => {
		const toolConfig = await captureToolConfig({
			$defs: {
				fromRef: { type: "object", properties: { path: { type: "string" } } },
			},
			anyOf: [{ $ref: "#/$defs/fromRef" }, { type: "object", properties: { mode: { type: "string" } } }],
		});

		const schema = toolConfig?.tools?.[0]?.toolSpec?.inputSchema?.json;
		expect(schema?.type).toBe("object");
		expect(schema?.anyOf).toEqual([
			{ $ref: "#/$defs/fromRef" },
			{ type: "object", properties: { mode: { type: "string" } } },
		]);
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

	it("keeps conflicting object properties inside the root union", async () => {
		const toolConfig = await captureToolConfig({
			anyOf: [
				{ type: "object", properties: { value: { type: "string" } }, required: ["value"] },
				{ type: "object", properties: { value: { type: "number" } }, required: ["value"] },
			],
		});

		const schema = toolConfig?.tools?.[0]?.toolSpec?.inputSchema?.json;
		expect(schema?.type).toBe("object");
		expect(schema?.anyOf).toBeDefined();
		expect(schema?.properties).toBeUndefined();
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
