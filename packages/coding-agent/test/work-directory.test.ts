import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireWorkRun, getWorkRunDir, pruneWorkTenant, WORK_RUN_MANIFEST_FILE } from "../src/utils/work-directory.ts";

const tempDirs: string[] = [];

function createAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-work-directory-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("work directory", () => {
	it("creates the strict category/tenant/run hierarchy with an ownership manifest", () => {
		const agentDir = createAgentDir();
		const lease = acquireWorkRun({
			agentDir,
			category: "context",
			tenant: "artifacts",
			runId: "session-1",
			retention: false,
		});

		expect(lease.path).toBe(join(agentDir, "work", "context", "artifacts", "session-1"));
		expect(existsSync(join(lease.path, WORK_RUN_MANIFEST_FILE))).toBe(true);
		expect(existsSync(join(lease.path, ".leases"))).toBe(true);

		lease.release();
		expect(existsSync(join(lease.path, ".leases"))).toBe(false);
	});

	it("rejects traversal, case-ambiguous, and Windows-reserved segments on every platform", () => {
		const agentDir = createAgentDir();
		expect(() => getWorkRunDir(agentDir, "../context", "artifacts", "run-1")).toThrow(/portable path segment/);
		expect(() => getWorkRunDir(agentDir, "Context", "artifacts", "run-1")).toThrow(/portable path segment/);
		expect(() => getWorkRunDir(agentDir, "context", "con", "run-1")).toThrow(/Windows-reserved/);
		expect(() => getWorkRunDir(agentDir, "context", "artifacts", "run.")).toThrow(/portable path segment/);
	});

	it("protects every active lease and prunes the run after the final release", () => {
		const agentDir = createAgentDir();
		const first = acquireWorkRun({
			agentDir,
			category: "context",
			tenant: "gc",
			runId: "shared-session",
			retention: false,
		});
		const second = acquireWorkRun({
			agentDir,
			category: "context",
			tenant: "gc",
			runId: "shared-session",
			retention: false,
		});
		const retention = { maxAgeMs: 0, maxRuns: 0, maxTotalBytes: 0, now: Date.now() + 1 };

		expect(pruneWorkTenant(agentDir, "context", "gc", retention)).toEqual([]);
		first.release();
		expect(pruneWorkTenant(agentDir, "context", "gc", retention)).toEqual([]);
		second.release();
		expect(pruneWorkTenant(agentDir, "context", "gc", retention)).toEqual([second.path]);
		expect(existsSync(second.path)).toBe(false);
	});

	it("prunes owned inactive runs by age and count while preserving unknown directories", () => {
		const agentDir = createAgentDir();
		const now = Date.now();
		const oldest = acquireWorkRun({
			agentDir,
			category: "logs",
			tenant: "runtime",
			runId: "oldest",
			retention: false,
		});
		oldest.release();
		const newest = acquireWorkRun({
			agentDir,
			category: "logs",
			tenant: "runtime",
			runId: "newest",
			retention: false,
		});
		newest.release();
		utimesSync(oldest.path, new Date(now - 10_000), new Date(now - 10_000));
		utimesSync(newest.path, new Date(now - 1_000), new Date(now - 1_000));
		const unknown = join(agentDir, "work", "logs", "runtime", "not-owned");
		mkdirSync(unknown);
		writeFileSync(join(unknown, "payload"), "keep");

		const removed = pruneWorkTenant(agentDir, "logs", "runtime", {
			now,
			maxAgeMs: 5_000,
			maxRuns: 1,
			maxTotalBytes: Number.MAX_SAFE_INTEGER,
		});

		expect(removed).toEqual([oldest.path]);
		expect(existsSync(newest.path)).toBe(true);
		expect(existsSync(unknown)).toBe(true);
	});

	it("keeps cleanup scans fixed-budget and treats an unmeasured inactive run as over the byte limit", () => {
		const agentDir = createAgentDir();
		const lease = acquireWorkRun({
			agentDir,
			category: "outputs",
			tenant: "bash",
			runId: "bounded",
			retention: false,
		});
		writeFileSync(join(lease.path, "payload"), "payload");
		lease.release();

		const removed = pruneWorkTenant(agentDir, "outputs", "bash", {
			maxAgeMs: Number.MAX_SAFE_INTEGER,
			maxRuns: Number.MAX_SAFE_INTEGER,
			maxTotalBytes: 0,
			maxScannedEntries: 0,
		});

		expect(removed).toEqual([lease.path]);
	});
});
