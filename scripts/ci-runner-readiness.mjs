#!/usr/bin/env node
/**
 * Windows CI evidence: how fast the runner creates processes over the first minutes of a test job.
 *
 * Test stalls on the Windows runners coincided with process creation so slow that a cold PowerShell
 * could not start in 40 s and taskkill timed out after 10 s, while CPU and memory looked idle. This
 * samples the time to run `cmd /c exit` and `git --version` every 5 s for up to 120 s and prints each
 * sample, so each run shows whether (and for how long) the runner is slow before its tests start.
 * It records only; it never fails the job.
 */
import { execFile } from "node:child_process";

const INTERVAL_MS = 5_000;
const DURATION_MS = Number(process.env.PI_RUNNER_READINESS_MS ?? 120_000);

function time(command, args) {
	const startedAt = Date.now();
	return new Promise((resolve) => {
		execFile(command, args, { timeout: 60_000, windowsHide: true }, (error) =>
			resolve(error ? `failed ${Date.now() - startedAt}ms` : `${Date.now() - startedAt}ms`),
		);
	});
}

const startedAt = Date.now();
while (Date.now() - startedAt < DURATION_MS) {
	const [cmd, git] = await Promise.all([time("cmd.exe", ["/d", "/c", "exit 0"]), time("git", ["--version"])]);
	process.stdout.write(`[runner-readiness] +${Math.round((Date.now() - startedAt) / 1000)}s cmd ${cmd} git ${git}\n`);
	await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
}
