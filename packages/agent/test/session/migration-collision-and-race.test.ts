import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileEntry } from "../../src/session/session-manager.ts";

const mockState = vi.hoisted(() => ({
	randomUuids: [] as string[],
	statBasenamesToThrow: new Set<string>(),
}));

vi.mock("node:crypto", async () => {
	const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
	return {
		...actual,
		randomUUID: () => mockState.randomUuids.shift() ?? actual.randomUUID(),
	};
});

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		statSync: (path: string) => {
			if (mockState.statBasenamesToThrow.has(basename(path))) {
				const error = new Error("ENOENT: no such file or directory, stat");
				throw Object.assign(error, { code: "ENOENT" });
			}
			return actual.statSync(path);
		},
	};
});

const { findMostRecentSession, migrateSessionEntries } = await import("../../src/session/session-manager.ts");

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-session-race-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	mockState.randomUuids = [];
	mockState.statBasenamesToThrow.clear();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function messageEntry(timestamp: string): FileEntry {
	return {
		type: "message",
		timestamp,
		message: { role: "user", content: timestamp, timestamp: Date.parse(timestamp) },
	} as FileEntry;
}

describe("session migration collision and race handling", () => {
	it("retries generated ids that collide during v1 migration", () => {
		mockState.randomUuids = [
			"aaaaaaaa-0000-4000-8000-000000000000",
			"aaaaaaaa-1111-4000-8000-000000000000",
			"bbbbbbbb-2222-4000-8000-000000000000",
			"cccccccc-3333-4000-8000-000000000000",
		];
		const entries: FileEntry[] = [
			{ type: "session", id: "sess-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" },
			messageEntry("2026-01-01T00:00:01.000Z"),
			messageEntry("2026-01-01T00:00:02.000Z"),
			messageEntry("2026-01-01T00:00:03.000Z"),
		];

		migrateSessionEntries(entries);

		const migrated = entries.slice(1).map((entry) => entry as FileEntry & { id: string; parentId: string | null });
		expect(migrated.map((entry) => entry.id)).toEqual(["aaaaaaaa", "bbbbbbbb", "cccccccc"]);
		expect(new Set(migrated.map((entry) => entry.id)).size).toBe(migrated.length);
		expect(migrated.map((entry) => entry.parentId)).toEqual([null, "aaaaaaaa", "bbbbbbbb"]);
	});

	it("skips files that vanish before stat while finding the most recent session", () => {
		const dir = createTempDir();
		const vanished = join(dir, "2026-01-01T00-00-03_vanished.jsonl");
		const remaining = join(dir, "2026-01-01T00-00-02_remaining.jsonl");
		writeFileSync(
			vanished,
			`${JSON.stringify({ type: "session", version: 3, id: "vanished", timestamp: "2026-01-01T00:00:03.000Z", cwd: dir })}\n`,
		);
		writeFileSync(
			remaining,
			`${JSON.stringify({ type: "session", version: 3, id: "remaining", timestamp: "2026-01-01T00:00:02.000Z", cwd: dir })}\n`,
		);
		mockState.statBasenamesToThrow.add(basename(vanished));

		expect(findMostRecentSession(dir)).toBe(remaining);
	});
});
