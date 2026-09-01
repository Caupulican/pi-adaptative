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
