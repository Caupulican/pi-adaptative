/**
 * killTree termination-evidence invariant.
 *
 * killTree's outcome is consumed as a liveness claim: herdr-runtime.ts only warns that "native work
 * may still be running" when the outcome is "failed", and child-process.ts settles the wait as if
 * the tree is gone for every other outcome. The invariant under test is therefore about evidence,
 * not about mechanism: "already_dead", "terminated" and "killed" each assert the process tree is
 * gone, so none of them may be returned while the PID is demonstrably still alive. An unsuccessful
 * signal (EPERM) or a child "error" event is a failure to *send*, never proof of death; the honest
 * answer in that case is "failed", which preserves the caller's uncertainty.
 *
 * Everything here is simulated: process.kill is replaced by a scripted kernel model and spawnSync is
 * mocked, so no unrelated process is signalled and both the POSIX and the win32 branch run
 * identically on any host OS.
 */
import type * as NodeChildProcess from "node:child_process";
import { type ChildProcess, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { killTree, killTreeNow } from "../../src/reliability/process-tree.ts";

// This suite scripts signal evidence; target authorization has its own OS-adapter regressions.
vi.mock("../../src/reliability/process-termination-protection.ts", () => ({
	readProcessTerminationProtection: () => new Set<number>(),
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof NodeChildProcess>();
	return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

/** Outcomes that assert the tree is gone. Returning any of them requires evidence of termination. */
const TERMINATION_CLAIMS: ReadonlyArray<string> = ["already_dead", "terminated", "killed"];

/** How a scripted kernel answers a signal aimed at the process group (-pid) or the PID itself. */
type SignalResponse = "delivered" | "eperm" | "esrch";

interface KernelScript {
	/** Whether the PID still exists, independent of whether signals can be delivered to it. */
	alive: boolean;
	group: SignalResponse;
	direct: SignalResponse;
}

interface SignalRecord {
	target: number;
	/** Mirrors node's own `process.kill` signal parameter, which is `string | number`. */
	signal: string | number;
}

function errnoError(code: string): NodeJS.ErrnoException {
	const error: NodeJS.ErrnoException = new Error(`mock ${code}`);
	error.code = code;
	return error;
}

/**
 * Replaces process.kill with a model of the kernel's answers. Signal 0 is the liveness probe:
 * a live-but-inaccessible process answers EPERM (which isProcessAlive already reads as alive),
 * a gone process answers ESRCH.
 */
function installKernel(script: KernelScript): { sent: SignalRecord[]; script: KernelScript } {
	const sent: SignalRecord[] = [];
	vi.spyOn(process, "kill").mockImplementation((target: number, signal?: string | number): true => {
		if (signal === 0) {
			if (!script.alive) throw errnoError("ESRCH");
			if (script.direct === "eperm") throw errnoError("EPERM");
			return true;
		}
		sent.push({ target, signal: signal ?? "SIGTERM" });
		const response = target < 0 ? script.group : script.direct;
		if (response === "eperm") throw errnoError("EPERM");
		if (response === "esrch") throw errnoError("ESRCH");
		return true;
	});
	return { sent, script };
}

function mockChild(pid: number): ChildProcess {
	const child = new EventEmitter() as ChildProcess;
	Object.assign(child, { pid, exitCode: null, signalCode: null, unref: vi.fn() });
	return child;
}

function withPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

const realPlatform = process.platform;

afterEach(() => {
	withPlatform(realPlatform);
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("killTree termination evidence", () => {
	describe("posix: an undeliverable signal is not evidence of death", () => {
		it("does not claim already_dead when both group and direct SIGTERM are denied (EPERM) and the PID is alive", async () => {
			withPlatform("linux");
			// A child that exec'd a setuid helper: still running, no longer signalable by this parent.
			const { sent } = installKernel({ alive: true, group: "eperm", direct: "eperm" });

			const outcome = await killTree(mockChild(4242), { graceMs: 50 });

			expect(sent.map((record) => record.target)).toEqual([-4242, 4242]);
			expect(TERMINATION_CLAIMS).not.toContain(outcome);
			expect(outcome).toBe("failed");
		});

		it("does not claim already_dead when the group is gone (ESRCH) but the direct PID is denied (EPERM) and alive", async () => {
			withPlatform("linux");
			// Distinct control: the group-kill ESRCH alone would be real death evidence; the direct
			// EPERM that follows it contradicts that reading and must dominate.
			installKernel({ alive: true, group: "esrch", direct: "eperm" });

			const outcome = await killTree(mockChild(4243), { graceMs: 50 });

			expect(TERMINATION_CLAIMS).not.toContain(outcome);
			expect(outcome).toBe("failed");
		});

		it("negative control: claims already_dead when group and direct both answer ESRCH and the PID is gone", async () => {
			withPlatform("linux");
			installKernel({ alive: false, group: "esrch", direct: "esrch" });

			expect(await killTree(mockChild(4244), { graceMs: 50 })).toBe("already_dead");
		});

		it("negative control: an already-terminal child stays inert and is never signalled", async () => {
			withPlatform("linux");
			const { sent } = installKernel({ alive: false, group: "esrch", direct: "esrch" });
			const child = mockChild(4245);
			Object.assign(child, { exitCode: 0 });

			expect(await killTree(child, { graceMs: 50 })).toBe("already_dead");
			expect(sent).toEqual([]);
		});
	});

	describe("posix: escalation must not convert a failed SIGKILL into a claim", () => {
		it("does not claim terminated when SIGKILL is denied after the grace period and the PID is alive", async () => {
			withPlatform("linux");
			vi.useFakeTimers();
			const kernel = installKernel({ alive: true, group: "delivered", direct: "delivered" });
			const child = mockChild(4246);

			const settled = killTree(child, { graceMs: 100 });
			// The child exec'd a setuid helper during the grace window: SIGTERM landed, SIGKILL cannot.
			kernel.script.group = "eperm";
			kernel.script.direct = "eperm";
			await vi.advanceTimersByTimeAsync(100);
			const outcome = await settled;

			expect(kernel.sent.map((record) => record.signal)).toEqual(["SIGTERM", "SIGKILL", "SIGKILL"]);
			expect(TERMINATION_CLAIMS).not.toContain(outcome);
			expect(outcome).toBe("failed");
		});

		it("does not claim killed when the post-SIGKILL acknowledgement deadline expires with the PID still alive", async () => {
			withPlatform("linux");
			vi.useFakeTimers();
			// SIGKILL is accepted by the kernel but the target never leaves the process table within
			// the acknowledgement window (uninterruptible sleep). The win32 branch already re-checks
			// liveness here; the posix branch must reach the same verdict from the same evidence.
			installKernel({ alive: true, group: "delivered", direct: "delivered" });
			const child = mockChild(4247);

			const settled = killTree(child, { graceMs: 100 });
			await vi.advanceTimersByTimeAsync(100);
			await vi.advanceTimersByTimeAsync(1000);
			const outcome = await settled;

			expect(TERMINATION_CLAIMS).not.toContain(outcome);
			expect(outcome).toBe("failed");
		});

		it("negative control: claims killed when the acknowledgement deadline expires and the PID is confirmed gone", async () => {
			withPlatform("linux");
			vi.useFakeTimers();
			const kernel = installKernel({ alive: true, group: "delivered", direct: "delivered" });
			const child = mockChild(4248);

			const settled = killTree(child, { graceMs: 100 });
			await vi.advanceTimersByTimeAsync(100);
			kernel.script.alive = false;
			await vi.advanceTimersByTimeAsync(1000);

			expect(await settled).toBe("killed");
		});

		it("negative control: claims terminated when the child's exit event arrives inside the grace window", async () => {
			withPlatform("linux");
			vi.useFakeTimers();
			installKernel({ alive: true, group: "delivered", direct: "delivered" });
			const child = mockChild(4249);

			const settled = killTree(child, { graceMs: 100 });
			await vi.advanceTimersByTimeAsync(10);
			Object.assign(child, { exitCode: null, signalCode: "SIGTERM" });
			child.emit("exit", null, "SIGTERM");

			expect(await settled).toBe("terminated");
		});
	});

	describe('a child "error" event is not evidence of death', () => {
		it("does not claim already_dead on posix when the child emits an error and the PID is alive", async () => {
			withPlatform("linux");
			installKernel({ alive: true, group: "delivered", direct: "delivered" });
			const child = mockChild(4250);

			const settled = killTree(child, { graceMs: 5000 });
			// e.g. an IPC/stdio error on the handle: the tree is untouched by it.
			child.emit("error", new Error("channel closed"));
			const outcome = await settled;

			expect(TERMINATION_CLAIMS).not.toContain(outcome);
			expect(outcome).toBe("failed");
		});

		it("does not claim killed on win32 when the child emits an error and the PID is alive", async () => {
			withPlatform("win32");
			installKernel({ alive: true, group: "delivered", direct: "delivered" });
			vi.mocked(spawnSync).mockReturnValueOnce({ status: 0 } as ReturnType<typeof spawnSync>);
			const child = mockChild(4251);

			const settled = killTree(child);
			child.emit("error", new Error("channel closed"));
			const outcome = await settled;

			expect(TERMINATION_CLAIMS).not.toContain(outcome);
			expect(outcome).toBe("failed");
		});

		it("negative control: an error event settles killed once the PID is confirmed gone", async () => {
			withPlatform("win32");
			installKernel({ alive: false, group: "esrch", direct: "esrch" });
			vi.mocked(spawnSync).mockReturnValueOnce({ status: 0 } as ReturnType<typeof spawnSync>);
			const child = mockChild(4252);

			const settled = killTree(child);
			child.emit("error", new Error("channel closed"));

			expect(await settled).toBe("killed");
		});
	});

	describe("win32 taskkill invocation and failure controls", () => {
		it("invokes the absolute SystemRoot taskkill.exe with /F /T /PID", () => {
			withPlatform("win32");
			const originalSystemRoot = process.env.SystemRoot;
			process.env.SystemRoot = "C:\\Windows";
			try {
				vi.mocked(spawnSync).mockReturnValueOnce({ status: 0 } as ReturnType<typeof spawnSync>);

				expect(killTreeNow(4253)).toEqual({ success: true });
				expect(vi.mocked(spawnSync).mock.calls[0]?.[0]).toBe(join("C:\\Windows", "System32", "taskkill.exe"));
				expect(vi.mocked(spawnSync).mock.calls[0]?.[1]).toEqual(["/F", "/T", "/PID", "4253"]);
			} finally {
				if (originalSystemRoot === undefined) delete process.env.SystemRoot;
				else process.env.SystemRoot = originalSystemRoot;
			}
		});

		it("negative control: a nonzero taskkill status reports failure without killing anything", () => {
			withPlatform("win32");
			vi.mocked(spawnSync).mockReturnValueOnce({ status: 1 } as ReturnType<typeof spawnSync>);

			expect(killTreeNow(4254)).toEqual({ success: false, error: "taskkill exited with code 1" });
		});

		it("negative control: a spawnSync error reports failure without killing anything", () => {
			withPlatform("win32");
			vi.mocked(spawnSync).mockReturnValueOnce({
				error: new Error("spawnSync taskkill.exe ENOENT"),
			} as unknown as ReturnType<typeof spawnSync>);

			expect(killTreeNow(4255)).toEqual({ success: false, error: "spawnSync taskkill.exe ENOENT" });
		});

		it("negative control: killTree settles failed and diagnoses a nonzero taskkill while the PID is alive", async () => {
			withPlatform("win32");
			vi.useFakeTimers();
			installKernel({ alive: true, group: "delivered", direct: "delivered" });
			vi.mocked(spawnSync).mockReturnValueOnce({ status: 1 } as ReturnType<typeof spawnSync>);
			const diagnostics: string[] = [];

			const settled = killTree(mockChild(4256), { onDiagnostic: (diag) => diagnostics.push(diag) });
			await vi.advanceTimersByTimeAsync(1000);

			expect(await settled).toBe("failed");
			expect(diagnostics).toEqual(["Windows taskkill failed: taskkill exited with code 1"]);
		});
	});
});
