import type { ToolResultMessage } from "@caupulican/pi-ai";
import { observeHistoryWork } from "@caupulican/pi-ai/history-work";
import { expect, it } from "vitest";
import { ContextAuditHistory, runContextAudit } from "../src/core/context/context-audit.ts";
import {
	type ContextGcPackedRecord,
	type ContextGcReport,
	packedRecordLookup,
	recordPack,
} from "../src/core/context/context-gc-report.ts";
import { correlateWithContextGc, planPromptPolicy } from "../src/core/context/context-prompt-policy.ts";
import { createVersionedMessageHistory, immutableHistoryMessage } from "../src/kernel/message-revision.ts";

function record(
	messageIndex: number,
	toolCallId: string,
	reason: ContextGcPackedRecord["reason"],
): ContextGcPackedRecord {
	return {
		toolName: "read",
		toolCallId,
		messageIndex,
		reason,
		originalChars: 5,
		originalTokens: 2,
		packedTokens: 1,
		retrievalAvailable: false,
	};
}

it("captures GC reasons while deferring policy rows and isolates the correlation from diagnostic edits", () => {
	const result: ToolResultMessage = {
		role: "toolResult",
		toolName: "read",
		toolCallId: "call",
		content: [{ type: "text", text: "value" }],
		timestamp: 0,
		isError: false,
	};
	const source = createVersionedMessageHistory([immutableHistoryMessage(result)!]);
	const work = observeHistoryWork(source);
	const audit = new ContextAuditHistory().capture(source, { turnIndex: 2 });
	const shadow = planPromptPolicy(audit, true);
	const gc: ContextGcReport = {
		enabled: true,
		savedTokens: 1,
		originalTokens: 2,
		packedTokens: 1,
		packedCount: 2,
		records: [],
	};
	recordPack(gc, record(0, "call", "superseded-read"));
	recordPack(gc, record(2, "call", "stale-tool-result"));
	const expected = correlateWithContextGc(planPromptPolicy(runContextAudit([result], { turnIndex: 2 })), gc);
	const correlation = correlateWithContextGc(shadow, gc, true);
	const external = correlateWithContextGc(shadow, { ...gc, records: [...gc.records] }, true);
	expect(work.auditRowsMaterialized).toBe(0);
	gc.records[1].reason = "stale-semantic-memory";
	gc.records.length = 0;
	shadow.items[0].hardConstraints.dropFromPrompt.length = 0;
	shadow.items[0].toolCallId = "edited diagnostic";
	expect(correlation).toEqual(expected);
	expect(external).toEqual(expected);
	expect(correlation.entries[0].gcPackReason).toBe("stale-tool-result");
	expect(correlation.entries).toBe(correlation.entries);
	expect(work.auditRowsMaterialized).toBe(1);
});

it("selects the first GC record matching both the message index and the tool call for enforcement", () => {
	const records = [
		record(3, "other", "superseded-read"),
		record(3, "call", "stale-tool-result"),
		record(3, "call", "superseded-read"),
		record(4, "call", "superseded-read"),
	];
	const lookup = packedRecordLookup(records);
	expect(lookup(3, "call")).toBe(records[1]);
	expect(lookup(4, "call")).toBe(records[3]);
	expect(lookup(4, "other")).toBeUndefined();
});
