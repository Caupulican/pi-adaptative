import { expect, it } from "vitest";
import { sessionContextItems } from "../src/kernel/session/session-context-builder.ts";
import type { CompactionEntry, SessionEntry } from "../src/kernel/session/session-entries.ts";

const timestamp = new Date(0).toISOString();
function message(id: string): SessionEntry {
	return { type: "message", id, parentId: null, timestamp, message: { role: "user", content: id, timestamp: 0 } };
}
function cut(id: string, coveredThroughEntryId?: string, summarizedGapEntryIds?: string[]): CompactionEntry {
	return {
		type: "compaction",
		id,
		parentId: null,
		timestamp,
		summary: "summary",
		firstKeptEntryId: id,
		tokensBefore: 10,
		retention: { mode: "original-user", userEntryId: "owner" },
		coveredThroughEntryId,
		summarizedGapEntryIds,
	};
}

it("restores only eligible gaps at each cut, in the order the cuts first emit them", () => {
	const path = [
		message("owner"),
		message("a"),
		message("b"),
		cut("first", "a"),
		message("c"),
		cut("second", "owner", ["b"]),
	];
	expect(sessionContextItems(path).map(({ entry }) => entry.id)).toEqual(["owner", "second", "a", "b", "c"]);
	// b was present in the second summary. A subsequent cut must suppress both earlier appearances.
	path.push(cut("third", "second", ["b"]));
	expect(sessionContextItems(path).map(({ entry }) => entry.id)).toEqual(["owner", "third", "a", "c"]);
});

it("recovers a legacy cut only from the latest matching preparation after the preceding checkpoint", () => {
	const prepared = (id: string, parentId: string): SessionEntry => ({
		type: "custom",
		id,
		parentId,
		timestamp,
		customType: "compaction_prepared",
		data: { result: { summary: "summary", retention: { mode: "original-user" } } },
	});
	const path = [
		message("owner"),
		prepared("old", "owner"),
		message("b"),
		prepared("latest", "b"),
		message("c"),
		cut("first"),
	];
	expect(sessionContextItems(path).map(({ entry }) => entry.id)).toEqual(["owner", "first", "c"]);
	path.push(message("d"), cut("second"));
	expect(sessionContextItems(path).map(({ entry }) => entry.id)).toEqual(["owner", "second", "c"]);
});

it("carries cumulative and superseding records in branch order across kinds", () => {
	const record = (id: string, customType: string, cumulative: boolean): SessionEntry => ({
		type: "custom_message",
		id,
		parentId: null,
		timestamp,
		customType,
		display: false,
		content: id,
		details: cumulative ? { cumulative: true } : { superseding: true },
	});
	const entries = [
		record("old", "A", true),
		record("before", "B", true),
		record("new", "A", false),
		record("after", "A", true),
		record("last", "B", true),
	];
	const checkpoint = cut("cut");
	expect(sessionContextItems([...entries, checkpoint]).map(({ entry }) => entry.id)).toEqual([
		"cut",
		"before",
		"new",
		"after",
		"last",
	]);
});
