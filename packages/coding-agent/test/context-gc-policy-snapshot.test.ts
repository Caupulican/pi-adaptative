import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultMessage } from "@caupulican/pi-ai";
import { observeHistoryWork } from "@caupulican/pi-ai/history-work";
import { expect, it } from "vitest";
import { AcceptedPromptPreviews } from "../src/core/context/accepted-prompt-previews.ts";
import { createInMemoryArtifactStore } from "../src/core/context/context-artifacts.ts";
import { ContextAuditHistory, runContextAudit } from "../src/core/context/context-audit.ts";
import {
	type ContextGcPackedRecord,
	type ContextGcReport,
	packedRecordLookup,
	recordPack,
} from "../src/core/context/context-gc-report.ts";
import { enforcePromptPolicy } from "../src/core/context/context-prompt-enforcement.ts";
import { correlateWithContextGc, planPromptPolicy } from "../src/core/context/context-prompt-policy.ts";
import { applyContextGc } from "../src/core/context-gc.ts";
import { ownerSessionStorageRoots } from "../src/core/orchestration/session-bundle-lifecycle.ts";
import { createVersionedMessageHistory, immutableHistoryMessage } from "../src/kernel/message-revision.ts";
import { SessionManager } from "../src/kernel/session/session-manager.ts";

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

it("replays only accepted artifact views and puts a later full disclosure at the request tail", () => {
	const store = createInMemoryArtifactStore();
	const text = "example ".repeat(240);
	const artifactId = store.write({ kind: "tool_output", content: text, createdAtTurn: 0, reproducible: false }).ref.id;
	const tool: ToolResultMessage = {
		role: "toolResult",
		toolName: "read",
		toolCallId: "r",
		isError: false,
		timestamp: 1,
		content: [{ type: "text", text }],
		details: { artifactId },
	};
	const source = createVersionedMessageHistory([immutableHistoryMessage(tool)!]);
	for (let i = 0; i < 5; i++)
		source.push(immutableHistoryMessage({ role: "user", content: "next", timestamp: i + 2 })!);
	const history = new AcceptedPromptPreviews();
	let available = true;
	const plan = (frozenBelow: number, relevant?: boolean, scope = "chat", enabled = true) => {
		const audit = runContextAudit(source, { turnIndex: 20, artifactStore: available ? store : undefined });
		return enforcePromptPolicy(
			source,
			planPromptPolicy(audit),
			{
				enabled,
				minChars: 1,
				preserveRecentMessages: 1,
				retrievalToolAvailable: true,
				brainRelevance: relevant === undefined ? undefined : () => ({ relevant, confidence: relevant ? 1 : 0.1 }),
			},
			{
				sourceMessages: source,
				frozenBelow,
				gcReport: applyContextGc([], { enabled: false }).report,
				previews: history.begin(scope),
				artifactAvailable: () => available,
			},
		);
	};
	const first = plan(0, false);
	const preview = first.messages[0];
	expect(first.report.items[0]).toMatchObject({ action: "artifact_preview", deliveredVisibility: "short" });
	expect(plan(source.length).messages[0]).toBe(source[0]);
	first.acceptProviderHistory!();
	const next = plan(source.length, true);
	expect(next.messages[0]).toBe(preview);
	expect(next.compressionPolicy).toBe(first.compressionPolicy);
	expect(next.transientMessages).toHaveLength(1);
	expect(next.report.items[0]).toMatchObject({ projectionPlacement: "tail_overlay", deliveredVisibility: "full" });
	expect(plan(source.length, true, "other").messages[0]).toBe(source[0]);
	available = false;
	expect(next.isDispatchCurrent!()).toBe(false);
	const raw = plan(source.length);
	expect(raw.messages[0]).toBe(source[0]);
	raw.acceptProviderHistory!();
	next.acceptProviderHistory!();
	available = true;
	expect(plan(source.length).messages[0]).toBe(source[0]);
	const old = plan(0);
	const disabled = plan(source.length, undefined, "chat", false);
	disabled.acceptProviderHistory!();
	old.acceptProviderHistory!();
	expect(plan(source.length).messages[0]).toBe(source[0]);
	plan(0).acceptProviderHistory!();
	source[0] = immutableHistoryMessage({ ...tool, content: [{ type: "text", text: "edited evidence" }] })!;
	expect(plan(source.length).messages[0]).toBe(source[0]);
});

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

it("keeps a disk-backed tool result unchanged across acceptance and the next frozen request", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-gc-cold-"));
	try {
		const session = SessionManager.create(dir, ownerSessionStorageRoots(dir));
		const id = session.appendMessage({
			role: "toolResult",
			toolName: "delegate",
			toolCallId: "cold",
			content: [{ type: "text", text: "Worker report. ".repeat(2000) }],
			timestamp: 0,
			isError: false,
		});
		session.flushBufferedEntries();
		session.releasePersistedMessagePayload(id);
		const count = session.getEntryCount();
		const visited = session.visitEntries(count - 1, 1, (entry) => {
			if (entry.type !== "message") throw new Error("Expected a persisted tool result");
			const row = entry.message;
			const getter = Object.getOwnPropertyDescriptor(row, "content")?.get;
			expect(getter).toBeTypeOf("function");
			const settings = { preserveRecentMessages: 0, writePayloads: false, deferProviderAcceptance: true };
			const first = applyContextGc([row], settings);
			expect(first.messages[0]).toBe(row);
			expect(first.report.packedCount).toBe(0);
			first.commit();
			first.acceptProviderHistory?.();
			const next = applyContextGc([row], { ...settings, frozenBelow: 1 });
			expect(next.messages[0]).toBe(row);
			expect(Object.getOwnPropertyDescriptor(row, "content")?.get).toBe(getter);
		});
		expect(visited).toBe(count);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
