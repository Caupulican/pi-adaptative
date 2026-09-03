import { describe, expect, it } from "vitest";
import { createCustomMessage } from "../src/messages.ts";
import { reconcileTransientRecords, type TransientRecordSlot } from "../src/transient-records.ts";
import type { AgentMessage } from "../src/types.ts";

const user = (text: string): AgentMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const kinds = (records: AgentMessage[]) => records.map((r) => (r.role === "custom" ? r.customType : r.role));

describe("transient record reconciliation index", () => {
	it("answers a kind with no record yet without rescanning, and stays exact as history grows", () => {
		const slot: TransientRecordSlot = { kind: "ledger", content: "L1", clearedText: "cleared" };
		let history: AgentMessage[] = [user("one")];
		// No record of the kind anywhere: the slot's content is new.
		expect(kinds(reconcileTransientRecords(history, [slot]))).toEqual(["ledger"]);
		// The record lands; the same content on the next request is nothing new.
		history = [...history, createCustomMessage("ledger", "L1", false, undefined, "2026-01-01T00:00:00.000Z")];
		expect(reconcileTransientRecords(history, [slot])).toEqual([]);
		// Appended history keeps the answer exact from the index instead of a walk.
		history = [...history, user("two"), user("three")];
		expect(reconcileTransientRecords(history, [slot])).toEqual([]);
		// Changed content is new again.
		expect(kinds(reconcileTransientRecords(history, [{ ...slot, content: "L2" }]))).toEqual(["ledger"]);
	});

	it("re-indexes a history that changed underneath instead of trusting the old prefix", () => {
		const slot: TransientRecordSlot = { kind: "ledger", content: "L1", clearedText: "cleared" };
		const record = createCustomMessage("ledger", "L1", false, undefined, "2026-01-01T00:00:00.000Z");
		const first = [user("one"), record, user("two")];
		expect(reconcileTransientRecords(first, [slot])).toEqual([]);
		// Same first message object, but the record is gone from the middle (a compaction-like rewrite).
		const rewritten = [first[0]!, user("two"), user("three")];
		expect(kinds(reconcileTransientRecords(rewritten, [slot]))).toEqual(["ledger"]);
	});
});

describe("transient record pointers and cumulative kinds", () => {
	const ledger = "TOOL FAILURE RECOVERY: the protocol applies\nACTIVE TOOL FAILURES mistakes=read:3";
	it("reclaims the tail with a pointer when only the position changed, and re-sends the full record on change", () => {
		const slot: TransientRecordSlot = { kind: "ledger", content: ledger, clearedText: "cleared", trailing: true };
		let history: AgentMessage[] = [user("one")];
		const first = reconcileTransientRecords(history, [slot]);
		expect(kinds(first)).toEqual(["ledger"]);
		history = [...history, ...first];
		// Displaced by ordinary turn growth: a pointer, not the full ledger.
		history = [...history, user("two")];
		const pointer = reconcileTransientRecords(history, [slot]);
		expect(kinds(pointer)).toEqual(["ledger"]);
		const pointerText = (pointer[0] as { content: string }).content;
		expect(pointerText).toBe(
			"TOOL FAILURE RECOVERY: the protocol applies unchanged; the last full record of this kind above is current.",
		);
		expect((pointer[0] as { details?: { pointer?: boolean } }).details?.pointer).toBe(true);
		history = [...history, ...pointer];
		// At the tail again: nothing new.
		expect(reconcileTransientRecords(history, [slot])).toEqual([]);
		// Displaced again after a pointer: another pointer, still not the full text.
		history = [...history, user("three")];
		const again = reconcileTransientRecords(history, [slot]);
		expect((again[0] as { content: string }).content).toContain("unchanged; the last full record");
		history = [...history, ...again];
		// Content changed: the full record returns.
		const changed = reconcileTransientRecords(history, [{ ...slot, content: `${ledger}\nmistakes=read:4` }]);
		expect((changed[0] as { content: string }).content).toContain("mistakes=read:4");
		expect((changed[0] as { details?: unknown }).details).toBeUndefined();
	});

	it("appends a cumulative record without a superseding note whenever its delta is new", () => {
		const slot: TransientRecordSlot = {
			kind: "legend",
			content: "PATH ALIASES (cumulative)\np/a=one",
			cumulative: true,
		};
		let history: AgentMessage[] = [user("one")];
		const first = reconcileTransientRecords(history, [slot]);
		expect((first[0] as { content: string }).content).toBe("PATH ALIASES (cumulative)\np/a=one");
		expect((first[0] as { details?: { cumulative?: boolean } }).details?.cumulative).toBe(true);
		history = [...history, ...first];
		expect(reconcileTransientRecords(history, [slot])).toEqual([]);
		const next = reconcileTransientRecords(history, [{ ...slot, content: "PATH ALIASES (cumulative)\np/b=two" }]);
		expect((next[0] as { content: string }).content).toBe("PATH ALIASES (cumulative)\np/b=two");
	});
});
