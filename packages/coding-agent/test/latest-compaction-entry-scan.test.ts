import type { SessionEntry } from "@caupulican/pi-agent-core/node";
import { describe, expect, it } from "vitest";
import { LatestCompactionEntryScan, type SessionEntryIndex } from "../src/core/session-entry-index.ts";

function entry(id: string, parentId: string | null, type: "message" | "compaction" = "message"): SessionEntry {
	return { id, parentId, type, timestamp: id } as unknown as SessionEntry;
}

/** A branch index that records which entries a lookup touched. */
function indexOf(entries: readonly SessionEntry[], leafId: string | null): SessionEntryIndex & { touched: string[] } {
	const byId = new Map(entries.map((candidate) => [candidate.id, candidate]));
	const touched: string[] = [];
	return {
		leafId,
		touched,
		getEntry: (id) => {
			touched.push(id);
			return byId.get(id);
		},
	};
}

describe("LatestCompactionEntryScan", () => {
	const root = entry("m1", null);
	const m2 = entry("m2", "m1");
	const c3 = entry("c3", "m2", "compaction");
	const m4 = entry("m4", "c3");
	const m5 = entry("m5", "m4");
	const branch = [root, m2, c3, m4, m5];

	it("walks only what was appended since the remembered leaf", () => {
		const scan = new LatestCompactionEntryScan();
		const first = indexOf(branch, "m5");
		expect(scan.find(first)).toBe(c3);
		expect(first.touched).toEqual(["m5", "m4", "c3"]);

		const m6 = entry("m6", "m5");
		const m7 = entry("m7", "m6");
		const later = indexOf([...branch, m6, m7], "m7");
		expect(scan.find(later)).toBe(c3);
		expect(later.touched).toEqual(["m7", "m6", "m5"]);

		const same = indexOf([...branch, m6, m7], "m7");
		expect(scan.find(same)).toBe(c3);
		expect(same.touched).toEqual(["m7"]);
	});

	it("reports a compaction appended after the remembered leaf", () => {
		const scan = new LatestCompactionEntryScan();
		expect(scan.find(indexOf(branch, "m5"))).toBe(c3);
		const c6 = entry("c6", "m5", "compaction");
		const later = indexOf([...branch, c6], "c6");
		expect(scan.find(later)).toBe(c6);
		expect(later.touched).toEqual(["c6"]);
	});

	it("walks a switched branch in full and forgets an emptied one", () => {
		const scan = new LatestCompactionEntryScan();
		expect(scan.find(indexOf(branch, "m5"))).toBe(c3);
		const other = indexOf([...branch, entry("b2", "m1")], "b2");
		expect(scan.find(other)).toBeNull();
		expect(other.touched).toEqual(["b2", "m1"]);

		expect(scan.find(indexOf(branch, null))).toBeNull();
		const again = indexOf(branch, "m5");
		expect(scan.find(again)).toBe(c3);
		expect(again.touched).toEqual(["m5", "m4", "c3"]);
	});
});
