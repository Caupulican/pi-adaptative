import type { AssistantMessage } from "@caupulican/pi-ai/types";
import { describe, expect, it } from "vitest";
import {
	createToolFailureResult,
	rememberToolFailure,
	sanitizeToolFailureContext,
} from "../src/tool-failure-memory.ts";
import type { AgentMessage } from "../src/types.ts";
import { createEmptyUsage } from "../src/usage.ts";

const INVENTED = "task_steps vis-à-vis goal? Wait I need to use task_steps set with plan.\n\nLet me also read docs.";
const FLATTENED = "write_path_D_/BuildPrj/AGENTS.md_content_# BuildPrj\n";

describe("unknown tool failures are one protocol mistake kind", () => {
	it("keys invented names under unknown_tool and keeps the attempted name as a bounded diagnostic", () => {
		const tracker = new Map();
		const first = rememberToolFailure(tracker, INVENTED, {}, "rejected", "unknown_tool", "Choose an exact name.");
		expect(first.tool).toBe("unknown_tool");
		expect(first.mistakeKind).toBe("unknown_tool");
		expect(first.failureKey.startsWith("unknown_tool:")).toBe(true);
		expect(first.diagnostic).toContain("task_steps vis-à-vis goal");
		expect((first.diagnostic ?? "").length).toBeLessThan(200);
		tracker.set(first.failureKey, first);
		const second = rememberToolFailure(tracker, FLATTENED, {}, "rejected", "unknown_tool", "Choose an exact name.");
		// A different invented name is the same kind of mistake, not a fresh tool with its own count.
		expect(second.kindMistakes).toBe(2);
		expect(second.failureKey).not.toBe(first.failureKey);
		const text = createToolFailureResult(second).content.find((block) => block.type === "text")?.text ?? "";
		expect(text).toContain('"mistake_kind":"unknown_tool"');
		expect(text).toContain('"tool":"unknown_tool"');
		expect(text).not.toContain('"mistake_kind":"write_path');
	});

	it("folds replayed history under the same unknown_tool kind", () => {
		const assistant: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "fixture",
			model: "fixture",
			usage: createEmptyUsage(),
			timestamp: 0,
			stopReason: "toolUse",
			content: [
				{ type: "toolCall", id: "call-1", name: INVENTED, arguments: {} },
				{ type: "toolCall", id: "call-2", name: FLATTENED, arguments: {} },
			],
		};
		const messages: AgentMessage[] = [assistant];
		for (const [id, name] of [
			["call-1", INVENTED],
			["call-2", FLATTENED],
		] as const) {
			const record = rememberToolFailure(new Map(), name, {}, "rejected", "unknown_tool", "Choose an exact name.");
			const result = createToolFailureResult(record);
			messages.push({
				role: "toolResult",
				toolCallId: id,
				toolName: name,
				content: result.content,
				details: result.details,
				isError: true,
				timestamp: 1,
			});
		}
		const ledger = sanitizeToolFailureContext(messages, "fixture").ledger ?? "";
		expect(ledger).toContain("mistakes=unknown_tool:2");
		expect(ledger).toContain('"mistake_kind":"unknown_tool"');
		expect(ledger).not.toContain('"mistake_kind":"task_steps vis');
		expect(ledger).toContain('"kind_mistakes":2');
	});
});
