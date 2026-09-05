import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENV_AGENT_DIR, VERSION } from "../src/config.ts";
import { getManagedToolBinaryPath } from "../src/utils/tools-manager.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-herdr-command-")));
	const home = join(root, "home");
	const agent = join(home, "agent");
	const bin = join(home, "bin");
	mkdirSync(agent, { recursive: true });
	mkdirSync(bin);
	const run = (args: string[]) =>
		spawnSync(process.execPath, ["--conditions=pi-source", cli, ...args], {
			cwd: root,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: agent,
				HOME: home,
				USERPROFILE: home,
				PATH: bin,
				PI_OFFLINE: "1",
				PI_SKIP_VERSION_CHECK: "1",
			},
			encoding: "utf8",
			timeout: 15000,
		});
	return { root, agent, bin, run };
}

function expectNoSessionOrOtherTools(agent: string) {
	for (const name of ["settings.json", "auth.json", "sessions", "runtimes", "tools"]) {
		expect(existsSync(join(agent, name))).toBe(false);
	}
	for (const tool of ["rg", "jq", "uv"] as const) {
		expect(existsSync(getManagedToolBinaryPath(tool, process.platform, join(agent, "bin")))).toBe(false);
	}
}

describe("Herdr-only installer CLI entry", () => {
	it("reports an offline fresh install as optional degradation without loading a session", () => {
		const f = fixture();
		try {
			const result = f.run(["--provision-herdr"]);
			expect(result.error).toBeUndefined();
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain("Checking Herdr");
			expect(result.stdout).toContain("[WARN] Herdr");
			expect(result.stdout).toContain("offline");
			expect(result.stdout).toContain("Pi remains usable");
			expectNoSessionOrOtherTools(f.agent);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	});

	it("reports an existing managed binary and exposes it idempotently without executing it", () => {
		const f = fixture();
		try {
			const managed = getManagedToolBinaryPath("herdr", process.platform, join(f.agent, "bin"));
			mkdirSync(dirname(managed), { recursive: true });
			// An intentionally non-runnable fixture proves this command never starts the collaboration service.
			writeFileSync(managed, "managed fixture, not a program\n", { mode: 0o700 });
			for (let attempt = 0; attempt < 2; attempt++) {
				const result = f.run(["--provision-herdr"]);
				expect(result.error).toBeUndefined();
				expect(result.status, result.stderr).toBe(0);
				expect(result.stdout).toContain("[OK] Herdr");
				expect(result.stdout).toContain("on PATH");
				expect(result.stdout).not.toContain("Downloading");
				expectNoSessionOrOtherTools(f.agent);
			}
			const exposed = join(f.bin, process.platform === "win32" ? "herdr.cmd" : "herdr");
			if (process.platform === "win32") expect(readFileSync(exposed, "utf8")).toContain(managed);
			else expect(realpathSync(exposed)).toBe(managed);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	});

	it("negative control: version does not invoke provisioning or create managed tools", () => {
		const f = fixture();
		try {
			const result = f.run(["--version"]);
			expect(result.error).toBeUndefined();
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout.trim()).toBe(VERSION);
			expect(existsSync(join(f.agent, "bin"))).toBe(false);
			expectNoSessionOrOtherTools(f.agent);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	});
});
