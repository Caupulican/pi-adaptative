/**
 * Tests for getToolPath's cross-run system-PATH resolution cache (tools-manager.ts).
 *
 * getToolPath() checks the managed tools dir (a single existsSync stat, already cheap) before
 * falling back to commandExists(), which spawns a synchronous `<name> --version` probe. That probe
 * used to re-run on every process start (interactive-mode.ts's init() calls ensureTool("fd")/("rg")
 * unconditionally), even when the system binary never moved. The fix persists the resolved absolute
 * path + mtime under <agentDir>/cache/tool-paths.json so a warm run can skip the probe and just stat
 * the cached path; a deleted/moved/replaced binary invalidates the entry and forces a re-probe.
 *
 * child_process is mocked (not spied) to deterministically count probe calls without spawning real
 * subprocesses -- the same pattern footer-data-provider.test.ts uses for spawnSync. Only the probe is
 * faked; resolveOnSystemPath still does real filesystem lookups against the environment's real `rg`,
 * so the suite skips cleanly (like fff-search-parity.test.ts) on a box where `rg` isn't on PATH.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

vi.mock("child_process", () => ({
	spawnSync: vi.fn((cmd: string) => {
		if (cmd === "rg") return { status: 0, stdout: "", stderr: "", error: undefined };
		return { status: 1, stdout: "", stderr: "", error: new Error(`spawn ${cmd} ENOENT`) };
	}),
}));

import { getToolPath } from "../src/utils/tools-manager.ts";

interface CachedEntry {
	path: string;
	mtimeMs: number;
}

function isOnRealSystemPath(name: string): boolean {
	const dirs = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean);
	return dirs.some((dir) => existsSync(join(dir, name)));
}

// Real availability gate (pure fs, unaffected by the child_process mock above), matching how
// fff-search-parity.test.ts gates on the real getToolPath("rg") rather than asserting on a
// platform that may not have it.
const RG_AVAILABLE = isOnRealSystemPath("rg");

describe.skipIf(!RG_AVAILABLE || process.platform === "win32")("getToolPath cross-run resolution cache", () => {
	let agentDir: string;
	let cacheFile: string;
	let previousAgentDirEnv: string | undefined;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-tool-path-cache-"));
		cacheFile = join(agentDir, "cache", "tool-paths.json");
		previousAgentDirEnv = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		vi.mocked(spawnSync).mockClear();
	});

	afterEach(() => {
		if (previousAgentDirEnv === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDirEnv;
		rmSync(agentDir, { recursive: true, force: true });
	});

	function readCacheEntry(): CachedEntry {
		const raw = JSON.parse(readFileSync(cacheFile, "utf-8")) as Record<string, CachedEntry>;
		return raw.rg;
	}

	it("probes once on a cold resolve, then skips the probe entirely on a warm resolve", () => {
		const first = getToolPath("rg");
		expect(typeof first).toBe("string");
		const firstPath = first as string;
		// Resolved to a real, existing absolute path (not the bare "rg" fallback).
		expect(existsSync(firstPath)).toBe(true);

		const probesAfterFirst = vi.mocked(spawnSync).mock.calls.length;
		expect(probesAfterFirst).toBeGreaterThan(0);

		expect(existsSync(cacheFile)).toBe(true);
		expect(readCacheEntry().path).toBe(firstPath);

		const second = getToolPath("rg");
		expect(second).toBe(firstPath);
		// The warm resolve was served entirely from the persisted cache -- no new probe.
		expect(vi.mocked(spawnSync).mock.calls.length).toBe(probesAfterFirst);
	});

	it("re-probes and self-heals when the cached mtime no longer matches the binary on disk", () => {
		const first = getToolPath("rg") as string;
		const probesAfterFirst = vi.mocked(spawnSync).mock.calls.length;
		const entry = readCacheEntry();

		// Simulate a binary replaced in place (e.g. a package upgrade): same path, stale mtime.
		writeFileSync(cacheFile, JSON.stringify({ rg: { path: entry.path, mtimeMs: entry.mtimeMs - 1 } }));

		const second = getToolPath("rg");
		expect(second).toBe(first);
		expect(vi.mocked(spawnSync).mock.calls.length).toBeGreaterThan(probesAfterFirst);
		// The stale entry was corrected back to the real mtime on re-probe.
		expect(readCacheEntry()).toEqual(entry);
	});

	it("re-probes and self-heals when the cached path no longer exists (deleted/moved binary)", () => {
		const first = getToolPath("rg") as string;
		const probesAfterFirst = vi.mocked(spawnSync).mock.calls.length;

		writeFileSync(cacheFile, JSON.stringify({ rg: { path: join(agentDir, "no-such-rg-binary"), mtimeMs: 1 } }));

		const second = getToolPath("rg");
		expect(second).toBe(first);
		expect(vi.mocked(spawnSync).mock.calls.length).toBeGreaterThan(probesAfterFirst);
		expect(readCacheEntry().path).toBe(first);
	});
});
