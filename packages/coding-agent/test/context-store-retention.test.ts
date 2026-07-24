import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	acquireContextStoreRetention,
	getContextStoreDir,
	migrateLegacyContextStores,
	pruneContextStores,
} from "../src/core/context/context-store-retention.ts";
import { acquireWorkRun } from "../src/utils/work-directory.ts";

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
	it("leases one bounded session namespace and creates payload children lazily", () => {
		const agentDir = tempDir();
		const lease = acquireContextStoreRetention(agentDir, "session-1");

		expect(lease.gcDir).toBe(join(agentDir, "work", "context", "sessions", "session-1", "gc"));
		expect(lease.artifactsDir).toBe(join(agentDir, "work", "context", "sessions", "session-1", "artifacts"));
		expect(existsSync(dirname(lease.gcDir))).toBe(true);
		expect(existsSync(lease.gcDir)).toBe(false);
		expect(existsSync(lease.artifactsDir)).toBe(false);
		lease.release();
	});

	it("prunes inactive stores through the shared age, count, and byte policy", () => {
		const agentDir = tempDir();
		const now = Date.now();
		const expired = acquireContextStoreRetention(agentDir, "expired", { maxTotalBytes: Number.MAX_SAFE_INTEGER });
		mkdirSync(expired.gcDir);
		writeFileSync(join(expired.gcDir, "payload"), "expired");
		expired.release();
		utimesSync(dirname(expired.gcDir), new Date(now - 10_000), new Date(now - 10_000));
		const current = acquireContextStoreRetention(agentDir, "current", { maxTotalBytes: Number.MAX_SAFE_INTEGER });
		current.release();

		const removed = pruneContextStores(agentDir, {
			now,
			maxAgeMs: 5_000,
			maxSessionDirs: 1,
			maxTotalBytes: Number.MAX_SAFE_INTEGER,
		});

		expect(removed).toEqual([dirname(expired.gcDir)]);
		expect(existsSync(dirname(expired.gcDir))).toBe(false);
		expect(existsSync(dirname(current.gcDir))).toBe(true);
	});

	it("never prunes a session until every process lease is released", () => {
		const agentDir = tempDir();
		const first = acquireContextStoreRetention(agentDir, "active-session");
		const second = acquireContextStoreRetention(agentDir, "active-session");
		const options = { maxAgeMs: 0, maxSessionDirs: 0, maxTotalBytes: 0, now: Date.now() + 1 };

		expect(pruneContextStores(agentDir, options)).toEqual([]);
		first.release();
		expect(pruneContextStores(agentDir, options)).toEqual([]);
		second.release();
		expect(pruneContextStores(agentDir, options)).toEqual([
			dirname(getContextStoreDir(agentDir, "gc", "active-session")),
		]);
	});

	it("migrates recognized legacy payloads without retaining empty split stores", () => {
		const agentDir = tempDir();
		const legacyGcDir = join(agentDir, "context-gc", "legacy-session");
		mkdirSync(legacyGcDir, { recursive: true });
		writeFileSync(join(legacyGcDir, "0123456789abcdef01234567.txt"), "payload");
		const legacyArtifactsDir = join(agentDir, "context-artifacts", "legacy-session");
		mkdirSync(legacyArtifactsDir, { recursive: true });

		migrateLegacyContextStores(agentDir);

		const migratedPath = join(getContextStoreDir(agentDir, "gc", "legacy-session"), "0123456789abcdef01234567.txt");
		expect(readFileSync(migratedPath, "utf8")).toBe("payload");
		expect(existsSync(join(agentDir, "context-gc"))).toBe(false);
		expect(existsSync(join(agentDir, "context-artifacts"))).toBe(false);
	});

	it("defers migration of a legacy managed store until its active lease is released", () => {
		const agentDir = tempDir();
		const legacy = acquireWorkRun({
			agentDir,
			category: "context",
			tenant: "gc",
			runId: "leased-session",
			retention: false,
		});
		writeFileSync(join(legacy.path, "0123456789abcdef01234567.txt"), "leased payload");

		migrateLegacyContextStores(agentDir);
		expect(existsSync(join(legacy.path, "0123456789abcdef01234567.txt"))).toBe(true);

		legacy.release();
		migrateLegacyContextStores(agentDir);
		expect(
			readFileSync(
				join(getContextStoreDir(agentDir, "gc", "leased-session"), "0123456789abcdef01234567.txt"),
				"utf8",
			),
		).toBe("leased payload");
		expect(existsSync(legacy.path)).toBe(false);
	});
});
