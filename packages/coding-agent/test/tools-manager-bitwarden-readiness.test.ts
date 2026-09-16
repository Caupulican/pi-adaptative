import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { getToolPath } from "../src/utils/tools-manager.ts";

vi.mock("child_process", () => ({ spawnSync: vi.fn() }));

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Bitwarden executable readiness", () => {
	it("rejects a wrapper whose target is missing, including a previously cached wrapper", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-bw-readiness-"));
		roots.push(root);
		vi.stubEnv(ENV_AGENT_DIR, root);
		vi.stubEnv("PATH", root);
		vi.stubEnv("PATHEXT", ".exe");
		const wrapper = join(root, process.platform === "win32" ? "bw.exe" : "bw");
		writeFileSync(wrapper, "synthetic executable", { mode: 0o755 });
		const probe = { pid: 1, output: [], stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), signal: null };
		vi.mocked(spawnSync).mockReturnValue({ ...probe, status: 127 });
		expect(getToolPath("bw")).toBeNull();
		vi.mocked(spawnSync).mockReturnValue({ ...probe, status: 0 });
		expect(getToolPath("bw")).toBe(wrapper);
		vi.mocked(spawnSync).mockReturnValue({ ...probe, status: 127 });
		expect(getToolPath("bw")).toBeNull();
	});
});
