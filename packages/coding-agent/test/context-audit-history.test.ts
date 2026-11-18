import type { ToolResultMessage } from "@caupulican/pi-ai";
import { observeHistoryWork } from "@caupulican/pi-ai/history-work";
import { expect, it } from "vitest";
import { createInMemoryArtifactStore } from "../src/core/context/context-artifacts.ts";
import { ContextAuditHistory, runContextAudit } from "../src/core/context/context-audit.ts";
import { planPromptPolicy } from "../src/core/context/context-prompt-policy.ts";
import { createVersionedMessageHistory, immutableHistoryMessage } from "../src/kernel/message-revision.ts";

function tool(id: string, text: string, artifactId?: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text }],
		timestamp: 0,
		isError: false,
		details: { artifactId },
	};
}

it("keeps delayed reports equal to their full recompute across append, rewrite, truncate and reset", () => {
	const audit = new ContextAuditHistory();
	const messages = createVersionedMessageHistory([immutableHistoryMessage(tool("one", "α"))!]);
	const capture = (turnIndex: number) => {
		const options = { turnIndex };
		return { report: audit.capture(messages, options), expected: runContextAudit(messages, options).items };
	};
	const first = capture(1);
	messages.push(immutableHistoryMessage(tool("two", "second"))!);
	const second = capture(2);
	messages[0] = immutableHistoryMessage(tool("one", "replacement"))!;
	const edited = capture(3);
	messages.length = 1;
	const truncated = capture(4);
	audit.clear();
	for (const { report, expected } of [first, second, edited, truncated]) {
		expect(report.items).toEqual(expected);
	}
});

it("captures artifact availability, store availability and creation turn before reports are read", () => {
	const audit = new ContextAuditHistory();
	const artifactStore = createInMemoryArtifactStore();
	const write = { kind: "tool_output", content: "archived", createdAtTurn: 2, reproducible: true } as const;
	const { ref } = artifactStore.write(write);
	const messages = createVersionedMessageHistory(
		["one", "two"].map((id) => immutableHistoryMessage(tool(id, "λ", ref.id))!),
	);
	const work = observeHistoryWork(messages);
	const initial = audit.capture(messages, { turnIndex: 3, artifactStore });
	const absentStore = audit.capture(messages, { turnIndex: 4 });
	const expectedInitial = runContextAudit([...messages], { turnIndex: 3, artifactStore }).items;
	artifactStore.cleanup();
	const missing = audit.capture(messages, { turnIndex: 5, artifactStore });
	const expectedMissing = runContextAudit([...messages], { turnIndex: 5, artifactStore }).items;
	artifactStore.write(write);
	const restored = audit.capture(messages, { turnIndex: 6, artifactStore });
	expect(work.auditSourceRowsVisited).toBe(2);
	expect(work.auditArtifactRefsChecked).toBe(3);
	expect(work.auditRowsMaterialized).toBe(0);
	expect(initial.items).toEqual(expectedInitial);
	expect(initial.items[0].item.createdAtTurn).toBe(2);
	expect(missing.items).toEqual(expectedMissing);
	expect(missing.items[0].item.createdAtTurn).toBe(5);
	expect(absentStore.items[0].packToArtifactHardConstraints).not.toEqual(
		missing.items[0].packToArtifactHardConstraints,
	);
	expect(restored.items).toEqual(expectedInitial);
	expect(work.auditRowsMaterialized).toBe(8);
});

it("isolates policy from edits to public audit rows and snapshots unversioned mutable source rows", () => {
	const source = [tool("first", "captured")];
	const audit = new ContextAuditHistory();
	const captured = audit.capture(source, { turnIndex: 1 });
	const expected = planPromptPolicy(runContextAudit(source, { turnIndex: 1 }));
	const shadow = planPromptPolicy(captured, true);
	source[0].toolCallId = "changed";
	captured.items[0].toolCallId = "edited diagnostic";
	captured.items[0].retention.allowedActions.length = 0;
	expect(shadow).toEqual(expected);
	expect(audit.capture(source, { turnIndex: 2 }).items[0].toolCallId).toBe("changed");
});

it("audits a changing extension suffix without indexing it as durable history", () => {
	const audit = new ContextAuditHistory();
	const messages = createVersionedMessageHistory([immutableHistoryMessage(tool("persisted", "first"))!]);
	const first = audit.capture(messages, { turnIndex: 1 }, undefined, [tool("temporary", "brief")]);
	messages.push(immutableHistoryMessage(tool("another", "next"))!);
	const work = observeHistoryWork(messages);
	const replacement = tool("changed", "new brief");
	const next = audit.capture(messages, { turnIndex: 2 }, undefined, [replacement]);
	expect(work.auditSourceRowsVisited).toBe(2);
	expect(work.auditRowsMaterialized).toBe(0);
	expect(first.items.map(({ toolCallId, messageIndex }) => [toolCallId, messageIndex])).toEqual([
		["persisted", 0],
		["temporary", 1],
	]);
	expect(next.items).toEqual(runContextAudit([...messages, replacement], { turnIndex: 2 }).items);
});
