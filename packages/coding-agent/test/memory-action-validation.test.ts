import { projectToolSchemaForProvider } from "@caupulican/pi-agent-core/provider-tool-projection";
import { ToolArgumentValidationError, validateToolArguments } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { FileStoreProvider } from "../src/core/memory/providers/file-store.ts";

const tool = new FileStoreProvider().getToolDefinitions()[0];
const okfAdd = {
	action: "add",
	target: "okf",
	type: "Debugging Finding",
	title: "Action validation",
	description: "Action requirements are checked before execution.",
	scope: "project",
	content: "The memory tool validates required arguments before storage access.",
	evidenceRefs: ["test/memory-action-validation.test.ts"],
};

describe("memory action preflight", () => {
	it("advertises an object root after provider projection", () => {
		expect(projectToolSchemaForProvider(tool.parameters)).toMatchObject({
			type: "object",
			properties: { action: expect.any(Object) },
			required: ["action"],
		});
	});
	it.each(["type", "title", "description", "scope", "content", "evidenceRefs"])(
		"never invents the missing OKF %s field during deterministic repair",
		(field) => {
			const args = Object.fromEntries(Object.entries(okfAdd).filter(([key]) => key !== field));
			expect(() =>
				validateToolArguments(tool, { type: "toolCall", id: "missing", name: "memory", arguments: args }),
			).toThrow(ToolArgumentValidationError);
		},
	);
	it.each([
		{ action: "add", target: "project" },
		{ action: "replace", target: "user", content: "corrected" },
		{ action: "remove", target: "memory" },
		{ action: "add", target: "okf", title: "Finding", type: "Debugging Finding" },
		{ action: "replace", target: "okf", content: "corrected", oldContent: "old" },
		{ action: "remove", target: "okf" },
		{ action: "list", target: "invalid" },
		{ ...okfAdd, evidenceRefs: [] },
		{ ...okfAdd, tags: ["duplicate", "duplicate"] },
		{ action: "remove", target: "okf", type: "Debugging Finding", title: "Finding", expectedDigest: "invalid" },
	])("rejects incomplete or unsupported $target $action before execution", (args) => {
		expect(() =>
			validateToolArguments(
				tool,
				{ type: "toolCall", id: "invalid", name: "memory", arguments: args },
				{ repairEnabled: false },
			),
		).toThrow(ToolArgumentValidationError);
	});

	it.each([
		okfAdd,
		{ action: "remove", target: "okf", type: "Debugging Finding", title: "Action validation" },
		{ action: "list" },
		{ action: "list", target: "okf" },
		{ action: "add", content: "A verified fact." },
		{ action: "replace", target: "user", content: "corrected", oldContent: "old" },
		{ action: "remove", target: "memory", oldContent: "old" },
	])("accepts complete $target $action", (args) => {
		expect(
			validateToolArguments(
				tool,
				{ type: "toolCall", id: "valid", name: "memory", arguments: args },
				{ repairEnabled: false },
			),
		).toEqual(args);
	});
});
