import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { Tool, ToolCall } from "../src/types.ts";
import {
	TOOL_REPAIR_MODE_NAMES,
	TOOL_REPAIR_REGISTRY,
	type ToolRepairModeName,
} from "../src/utils/tool-repair/registry.ts";
import { validateToolArguments } from "../src/utils/validation.ts";

const testDir = path.dirname(fileURLToPath(import.meta.url));

function makeTool(name: string, parameters: Tool["parameters"]): Tool {
	return { name, description: `${name} tool`, parameters };
}

function makeCall(name: string, args: Record<string, unknown>): ToolCall {
	return { type: "toolCall", id: "call-1", name, arguments: args };
}

interface RepairFixture {
	mode: ToolRepairModeName;
	tool: Tool;
	args?: Record<string, unknown>;
	call?: ToolCall;
	expected: Record<string, unknown>;
}

interface BounceFixture {
	mode: ToolRepairModeName;
	tool: Tool;
	args?: Record<string, unknown>;
	call?: ToolCall;
}

function callForFixture(fixture: RepairFixture | BounceFixture): ToolCall {
	return fixture.call ?? makeCall(fixture.tool.name, fixture.args ?? {});
}

const objectPayloadTool = makeTool("payload", Type.Object({ payload: Type.Object({ name: Type.String() }) }));
const arrayOfObjectsTool = makeTool(
	"edit",
	Type.Object({
		path: Type.String(),
		edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
	}),
);
const arrayOfStringsTool = makeTool("tag", Type.Object({ tags: Type.Array(Type.String()) }));
const searchTool = makeTool("search", {
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
const readTool = makeTool("read", Type.Object({ path: Type.String(), limit: Type.Optional(Type.Number()) }));
const optionalNumberTool = makeTool("read", Type.Object({ path: Type.String(), tail: Type.Optional(Type.Number()) }));
const requiredNumberTool = makeTool("count", Type.Object({ value: Type.Number() }));
const requiredBoolTool = makeTool("flag", Type.Object({ enabled: Type.Boolean() }));
const bashTool = makeTool("bash", Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }));

const repairFixtures: readonly RepairFixture[] = [
	{
		mode: "nullOptionalDrop",
		tool: readTool,
		args: { path: "README.md", limit: null },
		expected: { path: "README.md" },
	},
	{ mode: "jsonStringParse", tool: arrayOfStringsTool, args: { tags: '["src"]' }, expected: { tags: ["src"] } },
	{
		mode: "jsonObjectPropertySalvage",
		tool: readTool,
		call: {
			type: "toolCall",
			id: "call-1",
			name: "read",
			arguments: '{"path":"README.md" extra:1000}' as unknown as ToolCall["arguments"],
		},
		expected: { path: "README.md" },
	},
	{
		mode: "singleObjectWrap",
		tool: arrayOfObjectsTool,
		args: { path: "a.txt", edits: { oldText: "old", newText: "new" } },
		expected: { path: "a.txt", edits: [{ oldText: "old", newText: "new" }] },
	},
	{ mode: "bareScalarWrap", tool: arrayOfStringsTool, args: { tags: "src" }, expected: { tags: ["src"] } },
	{
		mode: "emptyObjectPlaceholder",
		tool: optionalNumberTool,
		args: { path: "README.md", tail: {} },
		expected: { path: "README.md" },
	},
	{ mode: "numberFromString", tool: requiredNumberTool, args: { value: "42" }, expected: { value: 42 } },
	{ mode: "boolFromString", tool: requiredBoolTool, args: { enabled: " False " }, expected: { enabled: false } },
	{
		mode: "enumCaseNormalize",
		tool: searchTool,
		args: { limit: 1, ignoreCase: false, filter: " Minimal ", count: 2, numbers: [1] },
		expected: { limit: 1, ignoreCase: false, filter: "minimal", count: 2, numbers: [1] },
	},
	{ mode: "propertyCaseNormalize", tool: readTool, args: { Path: "README.md" }, expected: { path: "README.md" } },
	{
		mode: "singleElementUnwrap",
		tool: searchTool,
		args: { limit: 1, ignoreCase: false, filter: "minimal", count: [2], numbers: [1] },
		expected: { limit: 1, ignoreCase: false, filter: "minimal", count: 2, numbers: [1] },
	},
	{
		mode: "stringifiedNumberInArray",
		tool: searchTool,
		args: { limit: 1, ignoreCase: false, filter: "minimal", count: 2, numbers: ["1", "2"] },
		expected: { limit: 1, ignoreCase: false, filter: "minimal", count: 2, numbers: [1, 2] },
	},
	{ mode: "bashCommandArgvJoin", tool: bashTool, args: { command: ["ls", "-la"] }, expected: { command: "ls -la" } },
	{ mode: "bashCommandUnwrap", tool: bashTool, args: { command: { cmd: "pwd" } }, expected: { command: "pwd" } },
];

const bounceFixtures: readonly BounceFixture[] = [
	{ mode: "nullOptionalDrop", tool: readTool, args: { path: "README.md", limit: "not-a-number" } },
	{ mode: "nullRequiredBounce", tool: readTool, args: { path: null } },
	{ mode: "jsonStringParse", tool: objectPayloadTool, args: { payload: "not json" } },
	{ mode: "jsonObjectPropertySalvage", tool: readTool, args: { path: 1 } },
	{ mode: "singleObjectWrap", tool: arrayOfObjectsTool, args: { path: "a.txt", edits: { oldText: "old" } } },
	{ mode: "bareScalarWrap", tool: arrayOfStringsTool, args: { tags: 3 } },
	{ mode: "emptyObjectPlaceholder", tool: requiredNumberTool, args: { value: {} } },
	{ mode: "numberFromString", tool: requiredNumberTool, args: { value: "forty-two" } },
	{ mode: "boolFromString", tool: requiredBoolTool, args: { enabled: "yes" } },
	{
		mode: "enumCaseNormalize",
		tool: searchTool,
		args: { limit: 1, ignoreCase: false, filter: "maximal", count: 2, numbers: [1] },
	},
	{ mode: "propertyCaseNormalize", tool: readTool, args: { path: 3, Path: "README.md" } },
	{
		mode: "singleElementUnwrap",
		tool: searchTool,
		args: { limit: 1, ignoreCase: false, filter: "minimal", count: [2, 3], numbers: [1] },
	},
	{
		mode: "stringifiedNumberInArray",
		tool: searchTool,
		args: { limit: 1, ignoreCase: false, filter: "minimal", count: 2, numbers: ["1", "two"] },
	},
	{ mode: "bashCommandArgvJoin", tool: bashTool, args: { command: ["ls", 2] } },
	{ mode: "bashCommandUnwrap", tool: bashTool, args: { command: { cmd: 2 } } },
];

describe("tool argument repair", () => {
	it("documents every registry mode in operator docs and the bundled repair catalogue", () => {
		const docs = readFileSync(path.resolve(testDir, "../../coding-agent/docs/tool-repair.md"), "utf8");
		const catalogue = readFileSync(
			path.resolve(
				testDir,
				"../../coding-agent/src/bundled-resources/skills/tool-call-repair/references/repair-catalogue.md",
			),
			"utf8",
		);

		for (const mode of TOOL_REPAIR_MODE_NAMES) {
			expect(docs).toContain(mode);
			expect(catalogue).toContain(mode);
		}
	});

	it("keeps one positive fixture for every executable registry mode", () => {
		const coveredModes = new Set(repairFixtures.map((fixture) => fixture.mode));
		for (const mode of TOOL_REPAIR_MODE_NAMES) {
			if (mode === "nullRequiredBounce") continue;
			expect(coveredModes.has(mode), `${mode} needs a repair fixture`).toBe(true);
		}

		for (const fixture of repairFixtures) {
			expect(validateToolArguments(fixture.tool, callForFixture(fixture)), fixture.mode).toEqual(fixture.expected);
		}
	});

	it("keeps one bounce fixture for every registry mode", () => {
		const coveredModes = new Set(bounceFixtures.map((fixture) => fixture.mode));
		for (const mode of TOOL_REPAIR_MODE_NAMES) {
			expect(coveredModes.has(mode), `${mode} needs a bounce fixture`).toBe(true);
		}

		for (const fixture of bounceFixtures) {
			expect(() => validateToolArguments(fixture.tool, callForFixture(fixture)), fixture.mode).toThrow();
		}
	});

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

	it("normalizes root property key casing", () => {
		const tool = makeTool("read", Type.Object({ path: Type.String(), limit: Type.Optional(Type.Number()) }));

		expect(validateToolArguments(tool, makeCall("read", { Path: "README.md" }))).toEqual({ path: "README.md" });
	});

	it("composes container, nested property-case, and scalar repairs to a valid result", () => {
		const tool = makeTool(
			"configure",
			Type.Object({
				payload: Type.Object({ enabled: Type.Boolean(), count: Type.Integer() }),
			}),
		);
		const call = makeCall("configure", {
			payload: '{"Enabled":"false","count":"2"}',
		});

		expect(validateToolArguments(tool, call)).toEqual({ payload: { enabled: false, count: 2 } });
		expect(call.repairNotes).toEqual([
			expect.stringContaining("jsonStringParse"),
			expect.stringContaining("propertyCaseNormalize"),
			expect.stringContaining("numberFromString"),
			expect.stringContaining("boolFromString"),
		]);
	});

	it("repairs text-protocol JSON strings with smart quote delimiters", () => {
		const tool = makeTool("read", Type.Object({ path: Type.String() }));

		expect(
			validateToolArguments(tool, {
				type: "toolCall",
				id: "call-1",
				name: "read",
				arguments: '{"path:”README.md”}' as unknown as ToolCall["arguments"],
			}),
		).toEqual({ path: "README.md" });
	});

	it("salvages declared properties from malformed text-protocol JSON object strings", () => {
		const tool = makeTool("read", Type.Object({ path: Type.String() }));

		expect(
			validateToolArguments(tool, {
				type: "toolCall",
				id: "call-1",
				name: "read",
				arguments: '{"path":"README.md" extra:1000}' as unknown as ToolCall["arguments"],
			}),
		).toEqual({ path: "README.md" });
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

	it("applies the shared shell command repairs to PowerShell", () => {
		const tool = makeTool(
			"powershell",
			Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }),
		);

		expect(
			validateToolArguments(tool, makeCall("powershell", { command: ["Get-ChildItem", "-Force"], timeout: "30" })),
		).toEqual({ command: "Get-ChildItem -Force", timeout: 30 });
		expect(validateToolArguments(tool, makeCall("powershell", { command: { command: "Get-Location" } }))).toEqual({
			command: "Get-Location",
		});
	});

	it("keeps the registry as the named repair source of truth", () => {
		expect(TOOL_REPAIR_REGISTRY.map((entry) => entry.name)).toEqual([
			"nullOptionalDrop",
			"nullRequiredBounce",
			"jsonStringParse",
			"jsonObjectPropertySalvage",
			"singleObjectWrap",
			"bareScalarWrap",
			"emptyObjectPlaceholder",
			"numberFromString",
			"boolFromString",
			"enumCaseNormalize",
			"propertyCaseNormalize",
			"singleElementUnwrap",
			"stringifiedNumberInArray",
			"bashCommandArgvJoin",
			"bashCommandUnwrap",
		]);
	});
});
