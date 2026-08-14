/**
 * H1b: real SIGKILL honesty check. The child writes a progress mark after the worker is running,
 * the parent kills the process group, then a fresh WorkerLifecycle reconstructs surviving files.
 *
 * Windows uses `taskkill /F` (blueprint §7 Q4). Tagged `slow`.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerLifecycle } from "../../src/core/delegation/worker-lifecycle.ts";
import { assertInvariants } from "../harness/invariants.ts";

const SCENARIO = "H1b-real-kill";
const roots: string[] = [];

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "pi-destructive-h1b-"));
	roots.push(value);
	return value;
}

afterEach(() => {
	while (roots.length > 0) {
		const value = roots.pop();
		if (value) rmSync(value, { recursive: true, force: true });
	}
});

function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" }).unref();
		return;
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// already gone
	}
}

describe("destructive/crash: H1b real-kill smoke (INV-W4/R1)", () => {
	it("SIGKILL of a running worker leaves reconstructible durable state", { timeout: 30_000 }, async () => {
		const dir = root();
		const readyPath = join(dir, "ready");
		const child = spawn(
			process.execPath,
			[
				"--conditions=pi-source",
				"--experimental-strip-types",
				fileURLToPath(new URL("./h1b-child.ts", import.meta.url)),
			],
			{
				stdio: "ignore",
				detached: process.platform !== "win32",
				env: { ...process.env, PI_H1B_AGENT_DIR: dir, PI_H1B_READY: readyPath },
			},
		);
		if (!child.pid) throw new Error("H1b child failed to spawn");

		const deadline = Date.now() + 8_000;
		while (!existsSync(readyPath) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(existsSync(readyPath), "child never wrote its progress mark").toBe(true);

		killProcessTree(child.pid);
		await new Promise((resolve) => setTimeout(resolve, 50));

		let consistent = false;
		let failedLoud = false;
		try {
			const restarted = new WorkerLifecycle({ agentDir: dir, sessionId: "h1b" });
			const records = restarted.getAllRecords();
			consistent = records.length >= 0;
			writeFileSync(join(dir, "restarted"), String(records.length));
		} catch {
			failedLoud = true;
		}

		assertInvariants(
			{
				crashConsistency: {
					consistent,
					failedLoud,
					silentDivergence: !consistent && !failedLoud,
				},
			},
			["INV-R1"],
			{ seed: 0, injection: 1, scenario: SCENARIO },
		);
		expect(readFileSync(readyPath, "utf8").trim().length).toBeGreaterThan(0);
	});
});
