import { describe, expect, it } from "vitest";
import { convertTools } from "../src/providers/google-shared.ts";
import type { Tool } from "../src/types.ts";

function makeTool(parameters: Record<string, unknown>): Tool {
	return {
		name: "test_tool",
		description: "A test tool",
		parameters: parameters as Tool["parameters"],
	};
}

describe("google-shared convertTools", () => {
	it("leaves JSON Schema meta keys out of parameters when useParameters=true", () => {
		const tools = [
			makeTool({
				$schema: "http://json-schema.org/draft-07/schema#",
				$id: "urn:bash-tool",
				$comment: "A bash tool for demonstration",
				$defs: {
					commandDef: { type: "string" },
				},
				definitions: {
					legacyDef: { type: "number" },
				},
				type: "object",
				properties: {
					command: { type: "string" },
				},
				required: ["command"],
			}),
		];

		const result = convertTools(tools, true);
		const decl = result?.[0]?.functionDeclarations?.[0];

		expect(decl).toBeDefined();
		expect(decl?.parameters).toEqual({
			type: "object",
			properties: {
				command: { type: "string" },
			},
			required: ["command"],
		});
		expect(decl?.parameters).not.toHaveProperty("$schema");
		expect(decl?.parameters).not.toHaveProperty("$id");
		expect(decl?.parameters).not.toHaveProperty("$comment");
		expect(decl?.parameters).not.toHaveProperty("$defs");
		expect(decl?.parameters).not.toHaveProperty("definitions");
	});

	it("recursively strips nested JSON Schema meta keys", () => {
		const tools = [
			makeTool({
				$schema: "http://json-schema.org/draft-07/schema#",
				type: "object",
				properties: {
					deep: {
						$schema: "http://json-schema.org/draft-07/schema#",
						$id: "urn:nested",
						type: "string",
					},
				},
			}),
		];

		const result = convertTools(tools, true);
		const decl = result?.[0]?.functionDeclarations?.[0];

		expect(decl).toBeDefined();
		expect(decl?.parameters).toEqual({
			type: "object",
			properties: {
				deep: {
					type: "string",
				},
			},
		});
	});

	it("inlines a local $ref and leaves out one that resolves nowhere", () => {
		const tools = [
			makeTool({
				$schema: "http://json-schema.org/draft-07/schema#",
				$defs: { mode: { type: "string", enum: ["fast", "slow"] } },
				type: "object",
				properties: {
					mode: { $ref: "#/$defs/mode", description: "How to run" },
					dangling: { $ref: "#/$defs/missing", type: "string" },
				},
			}),
		];

		const decl = convertTools(tools, true)?.[0]?.functionDeclarations?.[0];

		expect(decl?.parameters).toEqual({
			type: "object",
			properties: {
				mode: { type: "string", enum: ["fast", "slow"], description: "How to run" },
				dangling: { type: "string" },
			},
		});
	});

	it("writes JSON Schema keywords the OpenAPI subset lacks in the forms it has", () => {
		const tools = [
			makeTool({
				type: "object",
				additionalProperties: false,
				properties: {
					action: { const: "start", type: "string" },
					budget: { type: "number", exclusiveMinimum: 0 },
					note: { type: ["string", "null"] },
					choice: {
						anyOf: [
							{ const: "a", type: "string" },
							{ const: "b", type: "string" },
						],
					},
					either: {
						oneOf: [
							{ type: "object", properties: { x: { type: "string" } }, required: ["x"] },
							{ type: "object", properties: { y: { type: "number" } }, required: ["y"] },
						],
					},
					maybe: { anyOf: [{ type: "string" }, { type: "null" }] },
					mixed: { anyOf: [{ type: "string" }, { type: "number" }] },
				},
			}),
		];

		const decl = convertTools(tools, true)?.[0]?.functionDeclarations?.[0];

		expect(decl?.parameters).toEqual({
			type: "object",
			properties: {
				action: { type: "string", enum: ["start"] },
				budget: { type: "number", minimum: 0 },
				note: { type: "string", nullable: true },
				choice: { type: "string", enum: ["a", "b"] },
				either: { type: "object", properties: { x: { type: "string" }, y: { type: "number" } } },
				maybe: { type: "string", nullable: true },
				mixed: { type: "string", description: "Also accepts: number." },
			},
		});
	});

	it("does not mutate the original Tool.parameters object", () => {
		const originalParameters = {
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "object",
			properties: {
				command: { type: "string" },
			},
			required: ["command"],
		};
		const tools = [makeTool(originalParameters)];

		convertTools(tools, true);

		expect(originalParameters).toEqual({
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "object",
			properties: {
				command: { type: "string" },
			},
			required: ["command"],
		});
	});

	it("preserves $schema in parametersJsonSchema when useParameters=false", () => {
		const tools = [
			makeTool({
				$schema: "http://json-schema.org/draft-07/schema#",
				type: "object",
				properties: {
					command: { type: "string" },
				},
				required: ["command"],
			}),
		];

		const result = convertTools(tools, false);
		const decl = result?.[0]?.functionDeclarations?.[0];

		expect(decl).toBeDefined();
		expect(decl?.parametersJsonSchema).toEqual({
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "object",
			properties: {
				command: { type: "string" },
			},
			required: ["command"],
		});
	});

	it("handles tools without $schema gracefully", () => {
		const tools = [
			makeTool({
				type: "object",
				properties: {
					path: { type: "string" },
				},
				required: ["path"],
			}),
		];

		const result = convertTools(tools, true);
		const decl = result?.[0]?.functionDeclarations?.[0];

		expect(decl).toBeDefined();
		expect(decl?.parameters).toEqual({
			type: "object",
			properties: {
				path: { type: "string" },
			},
			required: ["path"],
		});
	});

	it("returns undefined for empty tool list", () => {
		expect(convertTools([])).toBeUndefined();
		expect(convertTools([], true)).toBeUndefined();
	});
});
