/**
 * Path aliases are a wire-format token optimization — `p/grep.ts` instead of the full path, to cut
 * tokens on every provider request. They must never reach the operator, who is looking at their own
 * machine and expects their own paths. A model that read `p/module02.ts` in its context writes
 * `p/module02.ts` in its prose and its tool arguments, and both land in the transcript verbatim, so
 * the expansion has to happen at the display boundary.
 */

import type { AgentMessage } from "@caupulican/pi-agent-core/types";
import { describe, expect, it } from "vitest";
import {
	expandArgumentsForDisplay,
	expandMessageForDisplay,
	expandMessageTextForDisplay,
} from "../src/core/context/path-alias-display.ts";
import type { PathAliasTable } from "../src/core/context/path-alias-table.ts";

const table: PathAliasTable = {
	cwd: "/repo",
	entries: [
		{ id: "p/module02.ts", path: "src/core/module02.ts" },
		{ id: "p/notes.md", path: "docs/notes.md" },
	],
	reservedIds: [],
};

const empty: PathAliasTable = { cwd: "/repo", entries: [] };

describe("expandMessageForDisplay", () => {
	it("expands aliases the model wrote into its own prose", () => {
		const message: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Read p/module02.ts, then p/notes.md." }],
			timestamp: 1,
		} as unknown as AgentMessage;

		const shown = expandMessageForDisplay(table, message);

		expect(JSON.stringify(shown)).toContain("src/core/module02.ts");
		expect(JSON.stringify(shown)).toContain("docs/notes.md");
		expect(JSON.stringify(shown)).not.toContain("p/module02.ts");
	});

	it("expands aliases inside tool-call arguments the operator reads", () => {
		const message: AgentMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "p/module02.ts" } }],
			timestamp: 1,
		} as unknown as AgentMessage;

		const shown = expandMessageForDisplay(table, message) as unknown as {
			content: { arguments: { path: string } }[];
		};

		expect(shown.content[0]?.arguments.path).toBe("src/core/module02.ts");
	});

	it("expands aliases in tool output", () => {
		const message: AgentMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "grep",
			content: [{ type: "text", text: "p/module02.ts:2:export const value = 1;" }],
			isError: false,
			timestamp: 2,
		} as unknown as AgentMessage;

		expect(JSON.stringify(expandMessageForDisplay(table, message))).toContain("src/core/module02.ts:2:");
	});

	it("expands bash commands and their output", () => {
		const message: AgentMessage = {
			role: "bashExecution",
			command: "cat p/module02.ts",
			output: "read p/module02.ts ok",
			timestamp: 3,
		} as unknown as AgentMessage;

		const shown = expandMessageForDisplay(table, message) as unknown as { command: string; output: string };

		expect(shown.command).toBe("cat src/core/module02.ts");
		expect(shown.output).toBe("read src/core/module02.ts ok");
	});

	it("leaves a message untouched by identity when it carries no alias", () => {
		const message: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "nothing to expand here" }],
			timestamp: 1,
		} as unknown as AgentMessage;

		expect(expandMessageForDisplay(table, message)).toBe(message);
		expect(expandMessageForDisplay(empty, message)).toBe(message);
	});

	it("never expands an alias-shaped substring inside a real path", () => {
		const message: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "see src/p/module02.ts" }],
			timestamp: 1,
		} as unknown as AgentMessage;

		expect(JSON.stringify(expandMessageForDisplay(table, message))).toContain("src/p/module02.ts");
	});

	it("expands aliases inside a thinking block, the same as prose", () => {
		const message: AgentMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "I should check p/module02.ts first" }],
			timestamp: 1,
		} as unknown as AgentMessage;

		const shown = expandMessageForDisplay(table, message) as unknown as { content: { thinking: string }[] };

		expect(shown.content[0]?.thinking).toBe("I should check src/core/module02.ts first");
		// Raw state is untouched by identity — this is the read-only contract the streaming and
		// history-rebuild call sites both depend on.
		expect(message.content).toEqual([{ type: "thinking", thinking: "I should check p/module02.ts first" }]);
	});

	it("is idempotent: expanding an already-expanded message is a no-op", () => {
		const message: AgentMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "Read p/module02.ts." },
				{ type: "thinking", thinking: "checking p/notes.md" },
			],
			timestamp: 1,
		} as unknown as AgentMessage;

		const once = expandMessageForDisplay(table, message);
		const twice = expandMessageForDisplay(table, once);

		expect(twice).toEqual(once);
	});

	it("reproduces a Windows-style stored path byte-exact, backslashes and all", () => {
		const windowsTable: PathAliasTable = {
			cwd: "/repo",
			entries: [{ id: "p/win.ts", path: String.raw`C:\Users\dev\project\src\win.ts` }],
			reservedIds: [],
		};
		const message: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "see p/win.ts for details" }],
			timestamp: 1,
		} as unknown as AgentMessage;

		const shown = expandMessageForDisplay(windowsTable, message) as unknown as { content: { text: string }[] };

		expect(shown.content[0]?.text).toBe(String.raw`see C:\Users\dev\project\src\win.ts for details`);
	});
});

describe("expandMessageTextForDisplay", () => {
	it("expands text and thinking spans but leaves tool-call arguments untouched, by identity", () => {
		const message: AgentMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "Reading p/module02.ts" },
				{ type: "thinking", thinking: "then p/notes.md" },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "p/module02.ts" } },
			],
			timestamp: 1,
		} as unknown as AgentMessage;

		const shown = expandMessageTextForDisplay(table, message) as unknown as {
			content: [{ text: string }, { thinking: string }, { arguments: { path: string } }];
		};

		expect(shown.content[0].text).toBe("Reading src/core/module02.ts");
		expect(shown.content[1].thinking).toBe("then docs/notes.md");
		// Untouched by identity: a still-streaming tool call's arguments must never be walked here
		// (see the function's doc comment) — attachStreamingToolActions expands them separately,
		// once complete.
		expect(shown.content[2].arguments).toBe((message.content[2] as { arguments: unknown }).arguments);
	});

	it("is idempotent", () => {
		const message: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Read p/module02.ts." }],
			timestamp: 1,
		} as unknown as AgentMessage;

		const once = expandMessageTextForDisplay(table, message);
		const twice = expandMessageTextForDisplay(table, once);

		expect(twice).toEqual(once);
	});

	it("leaves a message untouched by identity when it carries no alias", () => {
		const message: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "nothing to expand here" }],
			timestamp: 1,
		} as unknown as AgentMessage;

		expect(expandMessageTextForDisplay(table, message)).toBe(message);
		expect(expandMessageTextForDisplay(empty, message)).toBe(message);
	});
});

describe("expandArgumentsForDisplay", () => {
	it("expands streamed tool-call arguments", () => {
		expect(expandArgumentsForDisplay(table, { path: "p/notes.md", limit: 5 })).toEqual({
			path: "docs/notes.md",
			limit: 5,
		});
	});

	it("returns the arguments unchanged when no aliases exist yet", () => {
		const args = { path: "docs/notes.md" };
		expect(expandArgumentsForDisplay(empty, args)).toBe(args);
	});
});
