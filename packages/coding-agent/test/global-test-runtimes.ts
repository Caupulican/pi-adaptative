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
import { mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { removeTreeSync } from "../src/core/util/remove-tree.ts";
import { defenderStatus, sampleRunnerLoad, spawnLatency } from "./ci-runner-load.ts";

export const SHARED_TEST_RUNTIME_ROOT = join(realpathSync.native(tmpdir()), "pi-agent-test-shared");

/**
 * Process-start latency through the whole run, in the main vitest process (which lives as long as the
 * tests; a sampler started by an earlier CI step is killed when that step ends). Samples over 1 s are
 * logged as they happen, with the load sample, so a stall's timestamps line up with the runner's state.
 */
function startLatencyWatch(): () => void {
	const samples: number[] = [];
	let slow = 0;
	const timer = setInterval(() => {
		const startedAt = Date.now();
		void spawnLatency().then(async () => {
			const elapsed = Date.now() - startedAt;
			samples.push(elapsed);
			if (elapsed < 1_000) return;
			slow++;
			process.stderr.write(
				`[runner] ${new Date().toISOString()} process start took ${elapsed} ms: ${await sampleRunnerLoad()}\n`,
			);
		});
	}, 5_000);
	timer.unref();
	return () => {
		clearInterval(timer);
		const sorted = [...samples].sort((a, b) => a - b);
		const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
		process.stderr.write(
			`[runner] process start over the run: ${samples.length} samples, median ${at(0.5)} ms, p95 ${at(0.95)} ms, max ${sorted.at(-1) ?? 0} ms, ${slow} over 1 s\n`,
		);
	};
}

const STALE_AGENT_DIR_MS = 60 * 60 * 1000;

/**
 * Remove per-file agent dirs (test-agent-dir-isolation-setup.ts) that a killed worker left behind:
 * they are removed on a normal exit only. Anything younger than an hour may belong to a run that is
 * still going, and the shared runtime directory is never touched.
 */
function sweepStaleAgentDirs(): void {
	const root = realpathSync.native(tmpdir());
	const now = Date.now();
	for (const name of readdirSync(root)) {
		if (!name.startsWith("pi-agent-test-")) continue;
		const path = join(root, name);
		if (path === SHARED_TEST_RUNTIME_ROOT) continue;
		try {
			if (now - statSync(path).mtimeMs > STALE_AGENT_DIR_MS) removeTreeSync(path);
		} catch {
			// Removed concurrently, or still in use by another run: the next sweep retries.
		}
	}
}

export default async function setup(): Promise<(() => void) | undefined> {
	sweepStaleAgentDirs();
	if (process.platform !== "win32") return undefined;
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
	return evidence ? startLatencyWatch() : undefined;
}
