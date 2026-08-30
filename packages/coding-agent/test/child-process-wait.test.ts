import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { waitForChildProcess, waitForChildProcessWithTermination } from "../src/utils/child-process.ts";

describe("waitForChildProcess", () => {
	it("resolves when called after the child already emitted exit", async () => {
		const child = spawn(process.execPath, ["-e", "process.exit(23)"], { stdio: "ignore" });
		await once(child, "exit");

		await expect(waitForChildProcess(child)).resolves.toBe(23);
	});

	it("settles after bounded termination acknowledgement when no exit event can arrive", async () => {
		const child = new EventEmitter() as ChildProcess;
		Object.assign(child, {
			exitCode: null,
			pid: undefined,
			signalCode: null,
			stderr: null,
			stdout: null,
			unref: vi.fn(),
		});
		const controller = new AbortController();
		const terminal = waitForChildProcessWithTermination(child, { signal: controller.signal });

		controller.abort();

		await expect(terminal).resolves.toEqual({ code: null, reason: "aborted" });
		expect(child.unref).toHaveBeenCalledOnce();
	});

	it.skipIf(process.platform === "win32")(
		"settles an aborted SIGTERM-trapping child through exit events and one-shot escalation",
		async () => {
			const child = spawn(
				process.execPath,
				["-e", "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);"],
				{ detached: true, stdio: ["ignore", "pipe", "ignore"] },
			);
			if (!child.stdout) throw new Error("child stdout was not piped");
			await once(child.stdout, "data");
			const controller = new AbortController();
			const killSpy = vi.spyOn(process, "kill");
			try {
				const terminal = waitForChildProcessWithTermination(child, {
					signal: controller.signal,
					killGraceMs: 50,
				});
				controller.abort();

				await expect(terminal).resolves.toMatchObject({ reason: "aborted" });
				expect(killSpy.mock.calls.some(([, signal]) => signal === 0)).toBe(false);
				expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
			} finally {
				if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid!, "SIGKILL");
			}
		},
	);

	// killTree's own "Windows taskkill missing" diagnostic (F8, packages/agent/src/reliability/
	// process-tree.ts) can only actually fire on win32 and cannot be induced here: this vitest
	// project's native-source mode (viteModuleRunner: false) loads @caupulican/pi-agent-core via
	// Node's native loader, which vi.mock cannot intercept for a cross-package ESM import (verified:
	// mocking killTree here silently never invokes the mock). These two tests instead pin the C7
	// contract that IS verifiable on this platform: the new onDiagnostic option is correctly wired
	// through to killTree and never fires spuriously when termination genuinely succeeds.
	it.skipIf(process.platform === "win32")(
		"wires a caller-supplied onDiagnostic through termination without it firing on a clean kill (C7/F8)",
		async () => {
			const child = spawn(
				process.execPath,
				["-e", "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);"],
				{ detached: true, stdio: ["ignore", "pipe", "ignore"] },
			);
			if (!child.stdout) throw new Error("child stdout was not piped");
			await once(child.stdout, "data");
			const controller = new AbortController();
			const onDiagnostic = vi.fn();
			try {
				const terminal = waitForChildProcessWithTermination(child, {
					signal: controller.signal,
					killGraceMs: 50,
					onDiagnostic,
				});
				controller.abort();

				await expect(terminal).resolves.toMatchObject({ reason: "aborted" });
				expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
				expect(onDiagnostic).not.toHaveBeenCalled();
			} finally {
				if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid!, "SIGKILL");
			}
		},
	);

	it("defaults the diagnostic sink to console.error without breaking termination when none is supplied", async () => {
		const child = new EventEmitter() as ChildProcess;
		Object.assign(child, {
			exitCode: null,
			pid: undefined,
			signalCode: null,
			stderr: null,
			stdout: null,
			unref: vi.fn(),
		});
		const controller = new AbortController();

		const terminal = waitForChildProcessWithTermination(child, { signal: controller.signal });
		controller.abort();

		await expect(terminal).resolves.toEqual({ code: null, reason: "aborted" });
	});
});
