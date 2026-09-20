import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

const cliPath = resolve(import.meta.dirname, "../src/cli.ts");

/**
 * Test-infrastructure bound only: how long this test waits for the CLI child before declaring the
 * run stuck. It is not a product startup contract — nothing in the CLI promises to start within it.
 * The previous 10s left no headroom on a contended Windows runner, where a cold source-resolved
 * startup competes with seven other shards, and the kill surfaced as an unexplained SIGKILL.
 */
const EXTENSION_STARTUP_TEST_TIMEOUT_MS = 30_000;

/**
 * The vitest case must outlive the child bound, otherwise the suite-wide `testTimeout` fires first
 * and the failure reads as a generic vitest timeout with the child's stderr discarded.
 */
const EXTENSION_STARTUP_CASE_TIMEOUT_MS = EXTENSION_STARTUP_TEST_TIMEOUT_MS + 15_000;

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

async function runCli(
	args: string[],
	cwd: string,
	agentDir: string,
): Promise<{
	code: number | null;
	signal: NodeJS.Signals | null;
	stderr: string;
	timedOut: boolean;
}> {
	let stderr = "";
	// Match the vitest worker's --conditions=pi-source (vitest.config.ts execArgv) so the child
	// resolves workspace deps from source; the default import condition links the gitignored
	// dist/, and a stale local build crashes startup before the behavior under test.
	const child = spawn(process.execPath, ["--conditions=pi-source", cliPath, ...args], {
		cwd,
		env: {
			...process.env,
			[ENV_AGENT_DIR]: agentDir,
			NO_COLOR: "1",
			PI_OFFLINE: "1",
			TSX_TSCONFIG_PATH: resolve(import.meta.dirname, "../../../tsconfig.json"),
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});

	return new Promise((resolvePromise, reject) => {
		// A kill is recorded rather than retried: a child that really hangs must still fail, and
		// say so, instead of being re-run until it happens to finish.
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, EXTENSION_STARTUP_TEST_TIMEOUT_MS);
		child.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (code, signal) => {
			clearTimeout(timeout);
			resolvePromise({ code, signal, stderr, timedOut });
		});
	});
}

describe("extension startup isolation", () => {
	it(
		"reports a throwing extension as a warning instead of a fatal startup diagnostic",
		async () => {
			const tempRoot = mkdtempSync(join(tmpdir(), "pi-extension-startup-isolation-"));
			tempDirs.push(tempRoot);
			const agentDir = join(tempRoot, "agent");
			const projectDir = join(tempRoot, "project");
			const extensionPath = join(tempRoot, "throwing-extension.ts");
			mkdirSync(agentDir, { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(
				extensionPath,
				`export default function (pi) {
	pi.sendMessage({ customType: "invalid-load-action", content: "not allowed during load", display: false });
}
`,
				"utf8",
			);

			const result = await runCli(
				["--no-extensions", "--extension", extensionPath, "--model", "missing-model", "-p", "hi"],
				projectDir,
				agentDir,
			);

			// Named first so a runner timeout reports itself rather than surfacing as a bare
			// `expected null to be 1` with the child's captured stderr thrown away.
			expect(
				result.timedOut,
				`extension-startup child exceeded its ${EXTENSION_STARTUP_TEST_TIMEOUT_MS}ms test timeout and was SIGKILLed (exit ${result.code}, signal ${result.signal}); captured stderr:\n${result.stderr}`,
			).toBe(false);
			expect(result.code, `CLI exited with signal ${result.signal}; captured stderr:\n${result.stderr}`).toBe(1);
			expect(result.signal).toBeNull();
			expect(result.stderr).toContain(`Warning: Failed to load extension "${extensionPath}"`);
			expect(result.stderr).not.toContain(`Error: Failed to load extension "${extensionPath}"`);
		},
		EXTENSION_STARTUP_CASE_TIMEOUT_MS,
	);
});
