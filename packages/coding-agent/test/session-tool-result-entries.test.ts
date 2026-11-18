import { describe, expect, it, vi } from "vitest";
import { SessionToolResultEntries } from "../src/core/context/session-tool-result-entries.ts";
import type { SessionEntry } from "../src/kernel/session/session-entries.ts";

function result(id: string, parentId: string | null, toolCallId: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: "toolResult",
			toolCallId,
			toolName: "read",
			content: [],
			isError: false,
			timestamp: 0,
		},
	};
}

function sourceFixture() {
	const entries = new Map<string, SessionEntry>();
	let leafId: string | null = null;
	let sessionId = "session";
	const source = {
		getSessionId: () => sessionId,
		getLeafId: () => leafId,
		getEntry: vi.fn((id: string) => entries.get(id)),
		getBranch: vi.fn(() => {
			const branch: SessionEntry[] = [];
			let entry = leafId === null ? undefined : entries.get(leafId);
			while (entry) {
				branch.push(entry);
				entry = entry.parentId === null ? undefined : entries.get(entry.parentId);
			}
			return branch.reverse();
		}),
	};
	return {
		source,
		append(entry: SessionEntry) {
			entries.set(entry.id, entry);
			leafId = entry.id;
		},
		select(id: string | null) {
			leafId = id;
		},
		changeSession(id: string) {
			sessionId = id;
		},
	};
}

describe("SessionToolResultEntries", () => {
	it("updates late and repeated tool results without walking the retained prefix or changing past lookups", () => {
		const fixture = sourceFixture();
		const lookup = new SessionToolResultEntries();
		let leafId: string | null = null;
		for (let index = 0; index < 20; index++) {
			const id = `entry-${index}`;
			fixture.append(result(id, leafId, `call-${index}`));
			leafId = id;
		}
		const before = lookup.capture(fixture.source);
		expect(before.resolve("late")).toBeUndefined();

		fixture.source.getEntry.mockClear();
		fixture.append(result("late-entry", leafId, "late"));
		fixture.append(result("repeated-entry", "late-entry", "call-0"));
		fixture.append(result("latest-entry", "repeated-entry", "call-0"));
		const after = lookup.capture(fixture.source);

		expect(after.resolve("late")).toBe("late-entry");
		expect(after.resolve("call-0")).toBe("latest-entry");
		expect(before.resolve("late")).toBeUndefined();
		expect(before.resolve("call-0")).toBe("entry-0");
		expect(fixture.source.getBranch).toHaveBeenCalledTimes(1);
		expect(fixture.source.getEntry.mock.calls).toEqual([
			["latest-entry"],
			["entry-19"],
			["repeated-entry"],
			["late-entry"],
		]);

		const same = lookup.capture(fixture.source);
		expect(same).toBe(after);
	});

	it("rebuilds on navigation and session replacement without changing old snapshots", () => {
		const fixture = sourceFixture();
		const lookup = new SessionToolResultEntries();
		fixture.append(result("shared", null, "call-0"));
		fixture.append(result("left", "shared", "call-0"));
		const left = lookup.capture(fixture.source);

		fixture.select("shared");
		fixture.append(result("right", "shared", "call-1"));
		const right = lookup.capture(fixture.source);
		expect(fixture.source.getBranch).toHaveBeenCalledTimes(1);
		expect(right.resolve("call-0")).toBe("shared");
		expect(right.resolve("call-1")).toBe("right");
		expect(left.resolve("call-0")).toBe("left");
		expect(left.resolve("call-1")).toBeUndefined();

		fixture.changeSession("replacement");
		fixture.append(result("right", null, "replacement-call"));
		const replacement = lookup.capture(fixture.source);
		expect(replacement.resolve("call-1")).toBeUndefined();
		expect(replacement.resolve("replacement-call")).toBe("right");
		expect(right.resolve("call-1")).toBe("right");
	});

	it("takes independent snapshots for sources without an indexed branch", () => {
		let branch = [result("first", null, "call")];
		const source = { getSessionId: () => "session", getBranch: () => branch };
		const lookup = new SessionToolResultEntries();
		const before = lookup.capture(source);
		branch = [...branch, result("second", "first", "call")];
		const after = lookup.capture(source);
		expect(after.resolve("call")).toBe("second");
		expect(before.resolve("call")).toBe("first");
	});
});
