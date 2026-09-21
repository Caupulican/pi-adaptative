import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { killTree, killTreeNow } from "../../src/reliability/process-tree.ts";

const detail = "Process ancestry snapshot failed: ETIMEDOUT (limit 5000ms)";
vi.mock("../../src/reliability/process-termination-protection.ts", () => ({
	readProcessTerminationProtection: (onDiagnostic?: (message: string) => void) => {
		onDiagnostic?.("Process ancestry snapshot failed: ETIMEDOUT (limit 5000ms)");
		return undefined;
	},
}));

const platform = process.platform;

afterEach(() => {
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function ownedChild(pid: number): ChildProcess {
	return Object.assign(new EventEmitter(), {
		pid,
		exitCode: null,
		signalCode: null,
		unref: vi.fn(),
	}) as unknown as ChildProcess;
}

describe("process termination when the host ancestry cannot be read", () => {
	it("a pid-only request reports the snapshot failure and never signals the unverified target", () => {
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		const signal = vi.spyOn(process, "kill").mockReturnValue(true);
		expect(killTreeNow(4242)).toMatchObject({ success: false, error: expect.stringContaining(detail) });
		expect(signal).not.toHaveBeenCalled();
	});

	it("an owned live child is terminated by ownership; its tree kill never reads the ancestry", async () => {
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		vi.useFakeTimers();
		const signal = vi.spyOn(process, "kill").mockReturnValue(true);
		const diagnostics: string[] = [];
		const child = ownedChild(4242);
		const termination = killTree(child, { graceMs: 1, onDiagnostic: (message) => diagnostics.push(message) });
		expect(signal).toHaveBeenCalledWith(-4242, "SIGTERM");
		child.emit("exit", 0, null);
		expect(await termination).toBe("terminated");
		expect(diagnostics.join("\n")).not.toContain(detail);

		signal.mockClear();
		expect(killTreeNow(ownedChild(4243))).toEqual({ success: true });
		expect(signal).toHaveBeenCalledWith(-4243, "SIGKILL");
	});

	it("an owned child that already exited is not signalled, and its pid is not reused as a target", () => {
		const signal = vi.spyOn(process, "kill").mockReturnValue(true);
		const exited = Object.assign(new EventEmitter(), {
			pid: 4244,
			exitCode: 0,
			signalCode: null,
		}) as unknown as ChildProcess;
		expect(killTreeNow(exited)).toMatchObject({ success: false, error: expect.stringContaining("already exited") });
		expect(signal).not.toHaveBeenCalled();
	});
});
