import { expect, it } from "vitest";
import { Agent } from "../src/kernel/agent.ts";
import { PrefixFirstMatch, PrefixFold, takePrefixFoldOperations } from "../src/kernel/prefix-fold.ts";
import {
	createToolFailureMemoryTracker,
	createToolFailureResult,
	rememberToolFailure,
	restoreToolFailureRecord,
	sanitizeToolFailureContext,
	type ToolFailureMemoryRecord,
	trackerFromFailureRecords,
} from "../src/kernel/tool-failure-memory.ts";
import type { AgentMessage } from "../src/kernel/types.ts";

const row = (timestamp: number): AgentMessage => ({ role: "user", content: "test", timestamp });

it.each(["self_compaction_pending", "blocked"])("can retry a peer call after a saved %s compaction refusal", (code) => {
	const args = { action: "obligations" };
	const diagnostic =
		'Tool "peer" is refused: a self_compact note is saved and the context is compacted when this turn ends.';
	const record = rememberToolFailure(
		new Map(),
		"peer",
		args,
		"rejected",
		code,
		"Finish the turn.",
		diagnostic,
		"policy",
	);
	const refusal = {
		...createToolFailureResult(record),
		role: "toolResult" as const,
		toolCallId: "peer-1",
		toolName: "peer",
		timestamp: 1,
		isError: true,
	};
	expect(restoreToolFailureRecord(refusal, "peer", args)).toBeUndefined();
	expect(createToolFailureMemoryTracker([refusal]).size).toBe(0);
	if (code === "blocked") {
		const raw = { ...refusal, details: undefined };
		expect(restoreToolFailureRecord(raw, "peer", args)).toBeUndefined();
		expect(restoreToolFailureRecord({ ...raw, errorKind: "operation_outcome" }, "peer", args)).toBeDefined();
	}
});

it("reads only appended Agent rows and invalidates structural and content changes", () => {
	const agent = new Agent({ initialState: { messages: [row(1), row(2), row(3)] } });
	const sum = new PrefixFold<AgentMessage, { value: number }>(
		() => ({ value: 0 }),
		(state, item) => {
			state.value += item.timestamp;
		},
	);
	const match = new PrefixFirstMatch<AgentMessage>((item) => item.timestamp === 2);
	const history = agent.state.messages;
	expect(sum.fold(history, 2).value).toBe(3);
	expect(match.find(history)).toBe(1);
	agent.appendMessage(row(4));
	takePrefixFoldOperations();
	expect(sum.fold(history).value).toBe(10);
	expect(match.find(history)).toBe(1);
	expect(takePrefixFoldOperations()).toBe(2);
	agent.removeMessage(history[1]!);
	expect(sum.fold(history).value).toBe(8);
	expect(match.find(history)).toBe(-1);
	agent.replaceMessageContents(history[0]!, row(2));
	expect(match.find(history)).toBe(0);
	expect(sum.fold(history).value).toBe(9);
});

it("rechecks unowned arrays after a middle replacement even when endpoints and length are unchanged", () => {
	const history = [row(1), row(2), row(3)];
	const match = new PrefixFirstMatch<AgentMessage>((item) => item.timestamp === 2);
	expect(match.find(history)).toBe(1);
	history[1] = row(4);
	expect(match.find(history)).toBe(-1);
});

it("seeds the tool tracker from the accepted analysis with the same failures as a history replay", () => {
	const history: AgentMessage[] = [
		{
			role: "toolResult",
			toolCallId: "read-1",
			toolName: "read",
			timestamp: 1,
			isError: true,
			content: [{ type: "text", text: "File does not exist" }],
		},
	];
	let failures: readonly ToolFailureMemoryRecord[] = [];
	sanitizeToolFailureContext(history, "", 0, undefined, "full", (records) => {
		failures = records;
	});
	const expected = createToolFailureMemoryTracker(history);
	expect(expected.size).toBe(1);
	history.length = 0;
	expect(trackerFromFailureRecords(failures)).toEqual(expected);
});
