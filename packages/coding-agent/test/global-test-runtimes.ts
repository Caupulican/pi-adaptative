/**
 * Vitest global setup: provision the rebuildable runtimes every Windows test file shares, once per
 * run, before any worker starts. Each test file gets a fresh agent dir (test-agent-dir-isolation-setup.ts);
 * without this, the first shell-engine test in each file downloaded uv and installed CPython inside
 * its 30 s budget, which stalled Windows CI (captured by ci-hang-diagnostics-setup.ts).
 *
 * The shared directory is itself an agent dir: `bin/` holds uv and goes on PATH for the workers (a
 * machine with uv installed), while `runtimes/` and `cache/uv` are linked into every isolated agent dir.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { defenderStatus, sampleRunnerLoad } from "./ci-runner-load.ts";

export const SHARED_TEST_RUNTIME_ROOT = join(realpathSync.native(tmpdir()), "pi-agent-test-shared");

export default async function setup(): Promise<void> {
	if (process.platform !== "win32") return;
	const evidence = process.env.PI_CI_HANG_DIAGNOSTICS === "1";
	if (evidence) {
		const [defender, load] = await Promise.all([defenderStatus(), sampleRunnerLoad()]);
		process.stderr.write(`[runner] ${defender}\n[runner] before provisioning: ${load}\n`);
	}
	const startedAt = Date.now();
	mkdirSync(SHARED_TEST_RUNTIME_ROOT, { recursive: true });
	const script = fileURLToPath(new URL("./provision-test-runtimes.ts", import.meta.url));
	const result = spawnSync(process.execPath, ["--conditions=pi-source", script], {
		env: { ...process.env, [ENV_AGENT_DIR]: SHARED_TEST_RUNTIME_ROOT },
		encoding: "utf8",
		timeout: 600_000,
		windowsHide: true,
	});
	if (result.status !== 0) {
		// Tests still run; the first engine test in a file then provisions for itself, as before.
		process.stderr.write(
			`[test-runtimes] provisioning failed (${result.error?.message ?? `exit ${result.status}`}): ${(result.stdout ?? "").trim()} ${(result.stderr ?? "").trim().slice(-600)}\n`,
		);
	}
	if (evidence) process.stderr.write(`[runner] provisioning took ${Date.now() - startedAt} ms\n`);
	process.env.PATH = `${join(SHARED_TEST_RUNTIME_ROOT, "bin")}${delimiter}${process.env.PATH ?? ""}`;
}
