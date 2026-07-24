import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectAgentDirectoryLayout } from "../src/core/agent-directory-layout.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-agent-layout-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("agent directory layout inspection", () => {
	it("is read-only when the agent directory does not exist", () => {
		const agentDir = join(createTempDir(), "missing-agent");

		expect(inspectAgentDirectoryLayout(agentDir)).toMatchObject({
			scannedEntries: 0,
			unexpectedEntryCount: 0,
			unexpectedEntries: [],
			truncated: false,
		});
		expect(existsSync(agentDir)).toBe(false);
	});

	it("accepts only canonical root config, resources, and storage classes", () => {
		const agentDir = createTempDir();
		writeFileSync(join(agentDir, "auth.json"), "{}");
		writeFileSync(join(agentDir, "MEMORY.md"), "memory");
		for (const name of ["extensions", "profiles", "state", "cache", "work", "sessions"]) {
			mkdirSync(join(agentDir, name));
		}

		expect(inspectAgentDirectoryLayout(agentDir)).toMatchObject({
			scannedEntries: 8,
			unexpectedEntryCount: 0,
			unexpectedEntries: [],
			truncated: false,
		});
	});

	it("bounds both scanning and retained unexpected entry names", () => {
		const agentDir = createTempDir();
		for (const name of ["external-a", "external-b", "external-c"]) mkdirSync(join(agentDir, name));

		const reported = inspectAgentDirectoryLayout(agentDir, { maxReportedEntries: 1 });
		expect(reported.unexpectedEntryCount).toBe(3);
		expect(reported.unexpectedEntries).toHaveLength(1);
		expect(reported.truncated).toBe(false);

		const truncated = inspectAgentDirectoryLayout(agentDir, { maxScannedEntries: 2 });
		expect(truncated.scannedEntries).toBe(2);
		expect(truncated.unexpectedEntryCount).toBe(2);
		expect(truncated.truncated).toBe(true);
	});
});
