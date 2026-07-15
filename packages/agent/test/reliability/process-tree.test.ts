import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isProcessAlive, killTree, killTreeNow } from "../../src/reliability/process-tree.ts";

const posixOnly = it.skipIf(process.platform === "win32");

function spawnDetached(script: string, captureStdout = false, env?: NodeJS.ProcessEnv): ChildProcess {
	const child = spawn("bash", ["-c", script], {
		detached: true,
		env: { ...process.env, ...env },
		stdio: ["ignore", captureStdout ? "pipe" : "ignore", "ignore"],
	});
	if (child.pid === undefined) throw new Error("spawn failed");
	return child;
}

function waitForExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", () => resolve());
	});
}

function waitForReady(child: ChildProcess, expectedLines = 1): Promise<void> {
	const stdout = child.stdout;
	if (!stdout) throw new Error("child stdout is not piped");
	return new Promise((resolve, reject) => {
		let output = "";
		child.once("error", reject);
		stdout.setEncoding("utf8");
		stdout.on("data", (chunk: string) => {
			output += chunk;
			if (output.split("\n").length - 1 >= expectedLines) resolve();
		});
	});
}

function waitForFileBytes(filePath: string, minimumBytes: number): Promise<void> {
	const hasEnoughBytes = () => {
		try {
			return fs.statSync(filePath).size >= minimumBytes;
		} catch {
			return false;
		}
	};
	if (hasEnoughBytes()) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const watcher = fs.watch(path.dirname(filePath), () => {
			if (!hasEnoughBytes()) return;
			watcher.close();
			resolve();
		});
		watcher.once("error", reject);
	});
}

describe("process-tree", () => {
	posixOnly("isProcessAlive: true for a live child, false after it exits", async () => {
		const child = spawnDetached("sleep 30");
		expect(isProcessAlive(child.pid!)).toBe(true);
		await killTree(child, { graceMs: 100 });
		expect(isProcessAlive(child.pid!)).toBe(false);
	});

	posixOnly("killTree terminates a cooperative process via its exit event", async () => {
		const child = spawnDetached("sleep 30");
		const outcome = await killTree(child, { graceMs: 2000 });
		expect(outcome).toBe("terminated");
		expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
	});

	posixOnly("killTree escalates to SIGKILL when SIGTERM is trapped without polling liveness", async () => {
		const child = spawnDetached('trap "" TERM; printf "ready\\n"; while :; do sleep 30 & wait $!; done', true);
		await waitForReady(child);
		const killSpy = vi.spyOn(process, "kill");

		const outcome = await killTree(child, { graceMs: 300 });

		expect(outcome).toBe("killed");
		expect(killSpy.mock.calls.some(([, signal]) => signal === 0)).toBe(false);
		expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
	});

	posixOnly("killTree signals grandchildren in the same group", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-process-tree-"));
		const terminationFile = path.join(tempDir, "terminated.txt");
		const child = spawnDetached(
			`child() {
				trap 'printf x >> "$TERMINATION_FILE"; exit 0' TERM
				printf 'ready\\n'
				while :; do sleep 30 & wait $!; done
			}
			child & child & wait`,
			true,
			{ TERMINATION_FILE: terminationFile },
		);
		try {
			await waitForReady(child, 2);
			const grandchildrenTerminated = waitForFileBytes(terminationFile, 2);
			await killTree(child, { graceMs: 300 });
			await grandchildrenTerminated;
			expect(fs.readFileSync(terminationFile, "utf8")).toBe("xx");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	posixOnly("killTree on an already-dead child returns already_dead", async () => {
		const child = spawnDetached("true");
		await waitForExit(child);
		expect(await killTree(child, { graceMs: 100 })).toBe("already_dead");
	});

	posixOnly("killTreeNow kills immediately", async () => {
		const child = spawnDetached("sleep 30");
		const exited = waitForExit(child);
		killTreeNow(child.pid!);
		await exited;
		expect(isProcessAlive(child.pid!)).toBe(false);
	});
});
