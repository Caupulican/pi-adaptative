import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireContextStoreRetention, pruneContextStoreRoot } from "../src/core/context/context-store-retention.ts";

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-context-retention-"));
	tempDirs.push(dir);
	return dir;
}

function createStore(root: string, id: string, bytes: number, mtimeMs: number): string {
	const dir = join(root, id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "payload"), "x".repeat(bytes));
	const date = new Date(mtimeMs);
	utimesSync(dir, date, date);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("context store retention", () => {
	it("prunes inactive stores by age, count, and bytes", () => {
		const agentDir = tempDir();
		const root = join(agentDir, "context-gc");
		const now = Date.now();
		const expired = createStore(root, "expired", 8, now - 10_000);
		const oldest = createStore(root, "oldest", 80, now - 2_000);
		const newest = createStore(root, "newest", 80, now - 1_000);

		pruneContextStoreRoot(root, { now, maxAgeMs: 5_000, maxSessionDirs: 1, maxTotalBytes: 100 });

		expect(existsSync(expired)).toBe(false);
		expect(existsSync(oldest)).toBe(false);
		expect(existsSync(newest)).toBe(true);
	});

	it("removes stale lease markers left by dead processes", () => {
		const agentDir = tempDir();
		const root = join(agentDir, "context-gc");
		const leaseDir = join(root, ".leases", "stale-session");
		mkdirSync(leaseDir, { recursive: true });
		writeFileSync(join(leaseDir, "active-dead.json"), JSON.stringify({ pid: 2_147_483_647 }));

		pruneContextStoreRoot(root);

		expect(existsSync(leaseDir)).toBe(false);
	});

	it("never prunes an active session and releases its marker on dispose", () => {
		const agentDir = tempDir();
		const firstLease = acquireContextStoreRetention(agentDir, "active-session", {
			maxAgeMs: 0,
			maxSessionDirs: 0,
			maxTotalBytes: 0,
			now: Date.now() + 1,
		});
		const gcDir = join(agentDir, "context-gc", "active-session");
		const artifactDir = join(agentDir, "context-artifacts", "active-session");

		expect(existsSync(gcDir)).toBe(true);
		expect(existsSync(artifactDir)).toBe(true);
		pruneContextStoreRoot(join(agentDir, "context-gc"), {
			maxAgeMs: 0,
			maxSessionDirs: 0,
			maxTotalBytes: 0,
			now: Date.now() + 1,
		});
		expect(existsSync(gcDir)).toBe(true);
		const secondLease = acquireContextStoreRetention(agentDir, "active-session", {
			maxAgeMs: 0,
			maxSessionDirs: 0,
			maxTotalBytes: 0,
			now: Date.now() + 1,
		});
		firstLease.release();
		pruneContextStoreRoot(join(agentDir, "context-gc"), {
			maxAgeMs: 0,
			maxSessionDirs: 0,
			maxTotalBytes: 0,
			now: Date.now() + 1,
		});
		expect(existsSync(gcDir)).toBe(true);

		secondLease.release();
		pruneContextStoreRoot(join(agentDir, "context-gc"), {
			maxAgeMs: 0,
			maxSessionDirs: 0,
			maxTotalBytes: 0,
			now: Date.now() + 1,
		});
		expect(existsSync(gcDir)).toBe(false);
	});
});
