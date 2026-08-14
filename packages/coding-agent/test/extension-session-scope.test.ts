import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	applyExtensionSessionHeal,
	ExtensionSessionScope,
	extensionScopeOwnerKey,
} from "../src/core/extensions/extension-session-scope.ts";
import type { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { wrapRegisteredTool } from "../src/core/extensions/wrapper.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";

const trelloSchema = Type.Object({
	action: Type.String(),
	boardId: Type.Optional(Type.String()),
	envFile: Type.Optional(Type.String()),
});

describe("extension session scope", () => {
	it("fills boardId from a resolved nested board identity on the next call", () => {
		const scope = new ExtensionSessionScope();
		scope.observeSuccess(
			"trello",
			trelloSchema,
			{ action: "resolve_project_scope", project: "GrimDex" },
			{ status: "resolved", board: { id: "board-grimdex", name: "Grimdex" } },
		);
		expect(scope.prepare("trello", trelloSchema, { action: "list_lists", envFile: "/tmp/trello.env" })).toEqual({
			action: "list_lists",
			envFile: "/tmp/trello.env",
			boardId: "board-grimdex",
		});
	});

	it("does not overwrite an explicit boardId or retain unresolved scope", () => {
		const scope = new ExtensionSessionScope();
		scope.observeSuccess(
			"trello",
			trelloSchema,
			{ action: "resolve_project_scope" },
			{ status: "needs_board_selection", board: { id: "board-other", name: "Other" } },
		);
		expect(scope.prepare("trello", trelloSchema, { action: "list_lists" })).toEqual({ action: "list_lists" });

		scope.observeSuccess(
			"trello",
			trelloSchema,
			{ action: "list_lists", boardId: "board-explicit" },
			{ boardId: "board-explicit", count: 3 },
		);
		expect(scope.prepare("trello", trelloSchema, { action: "list_lists", boardId: "board-keep" })).toEqual({
			action: "list_lists",
			boardId: "board-keep",
		});
	});

	it("keeps identity scoped to one extension owner", () => {
		const scope = new ExtensionSessionScope();
		scope.observeSuccess(
			"trello",
			trelloSchema,
			{ action: "list_lists", boardId: "board-a" },
			{ boardId: "board-a" },
		);
		expect(scope.prepare("github", trelloSchema, { action: "list_lists" })).toEqual({ action: "list_lists" });
		expect(scope.prepare("trello", trelloSchema, { action: "list_lists" })).toEqual({
			action: "list_lists",
			boardId: "board-a",
		});
	});

	it("does not treat command or path fields as healable identity", () => {
		const schema = Type.Object({
			command: Type.Optional(Type.String()),
			path: Type.Optional(Type.String()),
			boardId: Type.Optional(Type.String()),
		});
		const scope = new ExtensionSessionScope();
		scope.observeSuccess(
			"mixed",
			schema,
			{ command: "rm -rf /", path: "/secrets", boardId: "board-ok" },
			{ command: "rm -rf /", path: "/secrets", boardId: "board-ok" },
		);
		expect(scope.prepare("mixed", schema, {})).toEqual({ boardId: "board-ok" });
	});
});

describe("extension tool wrap session heal", () => {
	it("heals a later list_lists call from resolve_project_scope evidence", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const definition: ToolDefinition<typeof trelloSchema> = {
			name: "trello",
			label: "Trello",
			description: "Trello",
			parameters: trelloSchema,
			async execute(_id, params) {
				seen.push(params as Record<string, unknown>);
				if (params.action === "resolve_project_scope") {
					return {
						content: [{ type: "text", text: "resolved" }],
						details: { status: "resolved", board: { id: "board-grimdex", name: "Grimdex" } },
					};
				}
				if (!params.boardId) throw new Error("boardId is required unless TRELLO_BOARD_ID");
				return {
					content: [{ type: "text", text: `lists on ${params.boardId}` }],
					details: { boardId: params.boardId, count: 1 },
				};
			},
		};
		const runner = { createContext: () => ({}) } as ExtensionRunner;
		const tool = wrapRegisteredTool(
			{
				definition,
				sourceInfo: createSyntheticSourceInfo("/tmp/extensions/trello/index.ts", {
					source: "local",
					baseDir: "/tmp/extensions/trello",
				}),
			},
			runner,
		);

		await tool.execute("1", { action: "resolve_project_scope" }, undefined, undefined);
		const prepared = tool.prepareArguments?.({ action: "list_lists", envFile: "/tmp/trello.env" });
		expect(prepared).toEqual({
			action: "list_lists",
			envFile: "/tmp/trello.env",
			boardId: "board-grimdex",
		});
		const result = await tool.execute(
			"2",
			prepared as { action: string; boardId: string; envFile: string },
			undefined,
			undefined,
		);
		expect(result.content[0]).toMatchObject({ text: "lists on board-grimdex" });
		expect(seen[1]).toMatchObject({ boardId: "board-grimdex" });
	});

	it("does not heal builtin tools", () => {
		const definition: ToolDefinition<typeof trelloSchema> = {
			name: "read",
			label: "Read",
			description: "Read",
			parameters: trelloSchema,
			async execute() {
				return { content: [{ type: "text", text: "ok" }], details: { boardId: "should-not-stick" } };
			},
		};
		const healed = applyExtensionSessionHeal(definition, "unused", new ExtensionSessionScope());
		expect(
			extensionScopeOwnerKey(createSyntheticSourceInfo("<builtin:read>", { source: "builtin" })),
		).toBeUndefined();
		expect(healed.prepareArguments).toBeTypeOf("function");
	});
});
