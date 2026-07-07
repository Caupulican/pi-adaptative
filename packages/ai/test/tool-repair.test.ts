import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { Tool, ToolCall } from "../src/types.ts";
import { TOOL_REPAIR_REGISTRY } from "../src/utils/tool-repair/registry.ts";
import { validateToolArguments } from "../src/utils/validation.ts";

function makeTool(name: string, parameters: Tool["parameters"]): Tool {
	return { name, description: `${name} tool`, parameters };
}

function makeCall(name: string, args: Record<string, unknown>): ToolCall {
	return { type: "toolCall", id: "call-1", name, arguments: args };
}

describe("tool argument repair", () => {
	it("returns the original object for valid calls", () => {
		const tool = makeTool("read", Type.Object({ path: Type.String(), limit: Type.Optional(Type.Number()) }));
		const args = { path: "README.md", limit: 10 };

		expect(validateToolArguments(tool, makeCall("read", args))).toBe(args);
	});

	it("repairs TypeBox array shape failures without mutating the original args", () => {
		const tool = makeTool(
			"edit",
			Type.Object({
				path: Type.String(),
				edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
			}),
		);
		const args = {
			path: "a.txt",
			edits: JSON.stringify([{ oldText: "old", newText: "new" }]),
		};

		expect(validateToolArguments(tool, makeCall("edit", args))).toEqual({
			path: "a.txt",
			edits: [{ oldText: "old", newText: "new" }],
		});
		expect(args.edits).toBe('[{"oldText":"old","newText":"new"}]');
	});

	it("wraps a single object where an array of objects is expected", () => {
		const tool = makeTool(
			"edit",
			Type.Object({
				path: Type.String(),
				edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
			}),
		);

		expect(
			validateToolArguments(tool, makeCall("edit", { path: "a.txt", edits: { oldText: "old", newText: "new" } })),
		).toEqual({ path: "a.txt", edits: [{ oldText: "old", newText: "new" }] });
	});

	it("drops null and empty-object placeholders only for optional fields", () => {
		const tool = makeTool(
			"read",
			Type.Object({ path: Type.String(), limit: Type.Optional(Type.Number()), tail: Type.Optional(Type.Number()) }),
		);

		expect(validateToolArguments(tool, makeCall("read", { path: "a.txt", limit: null, tail: {} }))).toEqual({
			path: "a.txt",
		});
		expect(() => validateToolArguments(tool, makeCall("read", { path: null }))).toThrow("Validation failed");
	});

	it("repairs scalar, enum, unwrap, and numeric-array shape failures", () => {
		const tool = makeTool("search", {
			type: "object",
			properties: {
				limit: { type: "integer" },
				ignoreCase: { type: "boolean" },
				filter: { enum: ["none", "minimal", "aggressive"] },
				count: { type: "number" },
				numbers: { type: "array", items: { type: "number" } },
			},
			required: ["limit", "ignoreCase", "filter", "count", "numbers"],
		} as Tool["parameters"]);

		expect(
			validateToolArguments(
				tool,
				makeCall("search", {
					limit: "10",
					ignoreCase: "false",
					filter: " Minimal ",
					count: [2],
					numbers: ["1", "2"],
				}),
			),
		).toEqual({ limit: 10, ignoreCase: false, filter: "minimal", count: 2, numbers: [1, 2] });
	});

	it("repairs named bash command shapes", () => {
		const tool = makeTool("bash", Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }));

		expect(validateToolArguments(tool, makeCall("bash", { command: ["ls", "-la"], timeout: "30" }))).toEqual({
			command: "ls -la",
			timeout: 30,
		});
		expect(validateToolArguments(tool, makeCall("bash", { command: { cmd: "pwd" }, timeout: {} }))).toEqual({
			command: "pwd",
		});
	});

	it("keeps the registry as the named repair source of truth", () => {
		expect(TOOL_REPAIR_REGISTRY.map((entry) => entry.name)).toEqual([
			"nullOptionalDrop",
			"nullRequiredBounce",
			"jsonStringParse",
			"singleObjectWrap",
			"bareScalarWrap",
			"emptyObjectPlaceholder",
			"numberFromString",
			"boolFromString",
			"enumCaseNormalize",
			"singleElementUnwrap",
			"stringifiedNumberInArray",
			"bashCommandArgvJoin",
			"bashCommandUnwrap",
		]);
	});
});
