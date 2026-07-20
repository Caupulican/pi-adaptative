import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProcessMatrixEntry } from "../src/core/process-matrix/codes.ts";
import {
	buildEntryId,
	entryPath,
	listEntries,
	processMatrixDir,
	readEntry,
	removeEntry,
	writeEntry,
	writeEntrySync,
} from "../src/core/process-matrix/store.ts";

const cleanups: string[] = [];

function tempAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-process-matrix-store-"));
	cleanups.push(dir);
	return dir;
}

afterEach(() => {
	while (cleanups.length > 0) {
		const dir = cleanups.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function masterEntry(overrides: Partial<ProcessMatrixEntry> = {}): ProcessMatrixEntry {
	return {
		entryId: buildEntryId("master", "session-1"),
		role: "master",
		pid: 1000,
		sessionId: "session-1",
		hostname: "host-a",
		startedAt: "2026-07-19T00:00:00.000Z",
		heartbeatAt: "2026-07-19T00:00:00.000Z",
		status: "running",
		...overrides,
	};
}

describe("process-matrix store", () => {
	it("buildEntryId is `<role>-<sessionId>`", () => {
		expect(buildEntryId("master", "session-1")).toBe("master-session-1");
		expect(buildEntryId("worker", "session-2")).toBe("worker-session-2");
	});

	it("processMatrixDir/entryPath resolve under state/process-matrix", () => {
		const agentDir = tempAgentDir();
		expect(processMatrixDir(agentDir)).toBe(join(agentDir, "state", "process-matrix"));
		expect(entryPath(agentDir, "master-session-1")).toBe(
			join(agentDir, "state", "process-matrix", "master-session-1.json"),
		);
	});

	it("a missing entry reads as absent, and listEntries on a missing dir is empty", async () => {
		const agentDir = tempAgentDir();
		expect(await readEntry(agentDir, "master-session-1")).toBeUndefined();
		expect(await listEntries(agentDir)).toEqual([]);
	});

	it("writeEntry/readEntry round-trip, tab-indented with a trailing newline", async () => {
		const agentDir = tempAgentDir();
		const entry = masterEntry();
		await writeEntry(agentDir, entry);

		expect(await readEntry(agentDir, entry.entryId)).toEqual(entry);
		const raw = readFileSync(entryPath(agentDir, entry.entryId), "utf-8");
		expect(raw.endsWith("\n")).toBe(true);
		expect(raw).toContain('\n\t"role"');
	});

	it("writeEntrySync/readEntry round-trip (the exit-hook writer)", async () => {
		const agentDir = tempAgentDir();
		const entry = masterEntry({ status: "closed" });
		writeEntrySync(agentDir, entry);
		expect(await readEntry(agentDir, entry.entryId)).toEqual(entry);
	});

	it("a corrupt entry file reads as absent and is skipped by listEntries", async () => {
		const agentDir = tempAgentDir();
		const good = masterEntry();
		await writeEntry(agentDir, good);
		writeFileSync(entryPath(agentDir, "worker-broken"), "{not json", "utf-8");

		expect(await readEntry(agentDir, "worker-broken")).toBeUndefined();
		const listed = await listEntries(agentDir);
		expect(listed).toEqual([good]);
	});

	it("listEntries ignores non-.json files and entries missing entryId", async () => {
		const agentDir = tempAgentDir();
		const good = masterEntry();
		await writeEntry(agentDir, good);
		writeFileSync(join(processMatrixDir(agentDir), "readme.txt"), "not an entry", "utf-8");
		writeFileSync(join(processMatrixDir(agentDir), "no-id.json"), JSON.stringify({ role: "worker" }), "utf-8");

		const listed = await listEntries(agentDir);
		expect(listed).toEqual([good]);
	});

	it("removeEntry deletes the file and is a no-op when already absent", async () => {
		const agentDir = tempAgentDir();
		const entry = masterEntry();
		await writeEntry(agentDir, entry);
		await removeEntry(agentDir, entry.entryId);
		expect(await readEntry(agentDir, entry.entryId)).toBeUndefined();
		await expect(removeEntry(agentDir, entry.entryId)).resolves.toBeUndefined();
	});
});
