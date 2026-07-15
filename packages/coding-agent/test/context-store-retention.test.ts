import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	acquireContextStoreRetention,
	getContextStoreDir,
	pruneContextStores,
} from "../src/core/context/context-store-retention.ts";

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-context-retention-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("context store retention", () => {
	it("places both stores in the shared multi-tenant work hierarchy", () => {
		const agentDir = tempDir();
		const lease = acquireContextStoreRetention(agentDir, "session-1");

		expect(lease.gcDir).toBe(join(agentDir, "work", "context", "gc", "session-1"));
		expect(lease.artifactsDir).toBe(join(agentDir, "work", "context", "artifacts", "session-1"));
		expect(existsSync(lease.gcDir)).toBe(true);
		expect(existsSync(lease.artifactsDir)).toBe(true);
		lease.release();
	});

	it("prunes inactive stores through the shared age, count, and byte policy", () => {
		const agentDir = tempDir();
		const now = Date.now();
		const expired = acquireContextStoreRetention(agentDir, "expired", { maxTotalBytes: Number.MAX_SAFE_INTEGER });
		writeFileSync(join(expired.gcDir, "payload"), "expired");
		expired.release();
		utimesSync(expired.gcDir, new Date(now - 10_000), new Date(now - 10_000));
		const current = acquireContextStoreRetention(agentDir, "current", { maxTotalBytes: Number.MAX_SAFE_INTEGER });
		current.release();

		const removed = pruneContextStores(agentDir, "gc", {
			now,
			maxAgeMs: 5_000,
			maxSessionDirs: 1,
			maxTotalBytes: Number.MAX_SAFE_INTEGER,
		});

		expect(removed).toEqual([expired.gcDir]);
		expect(existsSync(expired.gcDir)).toBe(false);
		expect(existsSync(current.gcDir)).toBe(true);
	});

	it("never prunes a session until every process lease is released", () => {
		const agentDir = tempDir();
		const first = acquireContextStoreRetention(agentDir, "active-session");
		const second = acquireContextStoreRetention(agentDir, "active-session");
		const options = { maxAgeMs: 0, maxSessionDirs: 0, maxTotalBytes: 0, now: Date.now() + 1 };

		expect(pruneContextStores(agentDir, "gc", options)).toEqual([]);
		first.release();
		expect(pruneContextStores(agentDir, "gc", options)).toEqual([]);
		second.release();
		expect(pruneContextStores(agentDir, "gc", options)).toEqual([
			getContextStoreDir(agentDir, "gc", "active-session"),
		]);
	});
});
