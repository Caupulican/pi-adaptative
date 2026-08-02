import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { SessionEntry } from "@caupulican/pi-agent-core/node";
import { describe, expect, it } from "vitest";
import { collectActiveContextAudit } from "../src/core/extensions/builtin.ts";

function messageEntry(id: string, text: string, parentId: string | null): SessionEntry {
	const message: AgentMessage = { role: "user", content: text, timestamp: 1 };
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-08-01T00:00:00.000Z",
		message,
	};
}

describe("context audit active-branch selection", () => {
	it("selects the compaction summary, kept prefix, and post-compaction tail once in order", () => {
		const entries: SessionEntry[] = [
			messageEntry("old", "drop me", null),
			messageEntry("kept", "keep me", "old"),
			{
				type: "compaction",
				id: "compact",
				parentId: "kept",
				timestamp: "2026-08-01T00:00:01.000Z",
				summary: "summary text",
				firstKeptEntryId: "kept",
				tokensBefore: 100,
			},
			messageEntry("after", "after compaction", "compact"),
		];

		const audit = collectActiveContextAudit(entries);

		expect(audit.messages.map((message) => message.role)).toEqual(["compactionSummary", "user", "user"]);
		expect(audit.rows.map((row) => row.entryId)).toEqual(["compact", "kept", "after"]);
		expect(audit.rows.map((row) => row.preview)).toEqual(["summary text", "keep me", "after compaction"]);
	});

	it("keeps every message in source order when there is no compaction", () => {
		const entries = [messageEntry("first", "first message", null), messageEntry("second", "second message", "first")];

		const audit = collectActiveContextAudit(entries);

		expect(audit.rows.map((row) => row.entryId)).toEqual(["first", "second"]);
		expect(audit.messages.map((message) => message.role)).toEqual(["user", "user"]);
	});
});
