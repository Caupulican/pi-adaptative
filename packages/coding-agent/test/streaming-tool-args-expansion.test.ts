/**
 * Alias expansion in the streaming tool-call path must run only once the arguments are complete.
 *
 * `applyStreamingMessageUpdate` runs per streamed chunk, and a message carrying a tool call bypasses
 * the UI update throttle, so anything done per call there is multiplied by the chunk count. Alias
 * expansion walks the entire argument payload, which made a large `write` O(chunks x payload):
 * measured at 1,455ms of UI work for a 200KB write over 1,600 chunks, and 2,065ms for a 1MB write.
 * Gating on completion makes it one linear pass (1.98ms and 11ms respectively).
 *
 * Partial arguments are mid-token anyway, so expanding them is not merely expensive but meaningless.
 */

import type { AssistantMessage } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const TABLE = {
	cwd: "/repo",
	entries: [{ id: "p/module02.ts", path: "src/core/module02.ts" }],
	reservedIds: [] as string[],
};

function toolCallMessage(args: Record<string, unknown>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name: "write", arguments: args }],
		timestamp: 1,
	} as unknown as AssistantMessage;
}

function createHost() {
	const attached: unknown[] = [];
	const updated: unknown[] = [];
	let active = false;
	const host = {
		session: { peekPathAliasTable: () => TABLE },
		activeToolCalls: {
			hasActive: () => active,
			getActive: () => ({ updateArgs: (args: unknown) => updated.push(args) }),
		},
		attachToolExecutionComponent: vi.fn((_name: string, _id: string, args: unknown) => {
			attached.push(args);
			active = true;
		}),
	};
	return { host, attached, updated };
}

function run(host: unknown, message: AssistantMessage, argumentsComplete: boolean): void {
	(
		InteractiveMode.prototype as unknown as {
			attachStreamingToolActions(this: unknown, message: AssistantMessage, complete: boolean): void;
		}
	).attachStreamingToolActions.call(host, message, argumentsComplete);
}

describe("streaming tool-call argument expansion", () => {
	it("passes arguments through untouched while they are still streaming", () => {
		const { host, attached } = createHost();
		const args = { path: "p/module02.ts", content: "half a fi" };

		run(host, toolCallMessage(args), false);

		// Untouched by identity: no walk of the payload happened at all.
		expect(attached[0]).toBe(args);
	});

	it("expands aliases once the arguments are complete", () => {
		const { host, attached } = createHost();

		run(host, toolCallMessage({ path: "p/module02.ts", content: "done" }), true);

		expect(attached[0]).toEqual({ path: "src/core/module02.ts", content: "done" });
	});

	it("does not walk the payload on any mid-stream update of a long tool call", () => {
		const { host, attached, updated } = createHost();
		// First chunk attaches, the rest update the live component — the hot loop.
		for (let chunk = 1; chunk <= 50; chunk++) {
			run(host, toolCallMessage({ path: "p/module02.ts", content: "x".repeat(chunk) }), false);
		}
		const seen = [...attached, ...updated] as { path: string }[];

		expect(seen).toHaveLength(50);
		// Every mid-stream value keeps the raw alias: expansion never ran.
		expect(seen.every((args) => args.path === "p/module02.ts")).toBe(true);

		// ...and the final, complete update is the one that expands.
		run(host, toolCallMessage({ path: "p/module02.ts", content: "x".repeat(50) }), true);
		expect((updated.at(-1) as { path: string }).path).toBe("src/core/module02.ts");
	});
});
