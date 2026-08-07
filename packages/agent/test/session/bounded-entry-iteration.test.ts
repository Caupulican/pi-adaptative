import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_SESSION_ENTRY_VISIT_COUNT, SessionManager } from "../../src/session/session-manager.ts";

interface SessionManagerEntryIndexInternals {
	coldPayloadEntryIds: Set<string>;
	_resetEntryFileIndex(clearColdPayloads?: boolean): void;
	_ensureEntryFileLocations(retainedIds: ReadonlySet<string>): void;
}

describe("SessionManager bounded entry iteration", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("visits a bounded borrowed range without allocating through getEntries", () => {
		const manager = SessionManager.inMemory("/repo");
		manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		manager.appendCustomEntry("marker", { retained: true });
		manager.appendMessage({ role: "user", content: "second", timestamp: 2 });
		const getEntries = vi.spyOn(manager, "getEntries");
		const visited: Array<{ index: number; type: string }> = [];

		const next = manager.visitEntries(1, 2, (entry, index) => {
			visited.push({ index, type: entry.type });
		});

		expect(next).toBe(3);
		expect(visited).toEqual([
			{ index: 1, type: "custom" },
			{ index: 2, type: "message" },
		]);
		expect(getEntries).not.toHaveBeenCalled();
	});

	it("rejects unbounded or invalid borrowed ranges", () => {
		const manager = SessionManager.inMemory("/repo");
		expect(() => manager.visitEntries(-1, 1, () => undefined)).toThrow(/start index/i);
		expect(() => manager.visitEntries(0, 0, () => undefined)).toThrow(/visit count/i);
		expect(() => manager.visitEntries(0, MAX_SESSION_ENTRY_VISIT_COUNT + 1, () => undefined)).toThrow(/visit count/i);
	});

	it("resolves cold payload locations only for entries inside the borrowed range", () => {
		const manager = SessionManager.inMemory("/repo");
		for (const content of ["outside-before", "inside", "outside-after"]) {
			manager.appendMessage({ role: "user", content, timestamp: 1 });
		}
		const messageEntries = manager.getEntries().filter((entry) => entry.type === "message");
		const internals = manager as unknown as SessionManagerEntryIndexInternals;
		for (const entry of messageEntries) internals.coldPayloadEntryIds.add(entry.id);
		const ensureLocations = vi.spyOn(internals, "_ensureEntryFileLocations");

		manager.visitEntries(1, 1, () => undefined);

		expect(ensureLocations).toHaveBeenCalledTimes(1);
		expect([...ensureLocations.mock.calls[0]![0]]).toEqual([messageEntries[1]!.id]);
		expect(ensureLocations.mock.calls[0]![0]).not.toContain(messageEntries[0]!.id);
		expect(ensureLocations.mock.calls[0]![0]).not.toContain(messageEntries[2]!.id);
	});

	it("resolves sequential cold pages after the first page advances the file index", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-bounded-session-pages-"));
		tempDirs.push(dir);
		const sessionFile = join(dir, "session.jsonl");
		const firstPayload = "a".repeat(32 * 1024);
		const secondPayload = "b".repeat(32 * 1024);
		writeFileSync(
			sessionFile,
			`${[
				{
					type: "session",
					version: 3,
					id: "bounded-pages",
					timestamp: "2026-08-07T00:00:00.000Z",
					cwd: dir,
				},
				{
					type: "message",
					id: "entry-first",
					parentId: null,
					timestamp: "2026-08-07T00:00:01.000Z",
					message: { role: "user", content: firstPayload, timestamp: 1 },
				},
				{
					type: "message",
					id: "entry-second",
					parentId: "entry-first",
					timestamp: "2026-08-07T00:00:02.000Z",
					message: { role: "user", content: secondPayload, timestamp: 2 },
				},
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
			"utf8",
		);

		const manager = SessionManager.open(sessionFile, dir, dir);
		(manager as unknown as SessionManagerEntryIndexInternals)._resetEntryFileIndex();
		const persistedBytes: number[] = [];

		manager.visitEntries(0, 1, (_entry, _index, bytes) => persistedBytes.push(bytes ?? 0));
		manager.visitEntries(1, 1, (_entry, _index, bytes) => persistedBytes.push(bytes ?? 0));

		expect(persistedBytes).toHaveLength(2);
		expect(persistedBytes.every(Number.isFinite)).toBe(true);
		expect(persistedBytes.every((bytes) => bytes > 32 * 1024)).toBe(true);
	});
});
