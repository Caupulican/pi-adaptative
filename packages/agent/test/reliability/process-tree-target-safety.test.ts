import type * as NodeChildProcess from "node:child_process";
import { type ChildProcess, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import type * as NodeFs from "node:fs";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { killTree, killTreeNow } from "../../src/reliability/process-tree.ts";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof NodeChildProcess>();
	return { ...actual, spawnSync: vi.fn(() => ({ status: 0 })) };
});

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof NodeFs>();
	return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const platform = process.platform;

beforeEach(() => {
	vi.mocked(readFileSync).mockImplementation((path) => {
		const pid = Number(String(path).split("/")[2]);
		const parent = pid === process.pid ? process.ppid : pid === process.ppid ? 17171 : 1;
		return `${pid} (fixture name)) S ${parent} 18181 17171`;
	});
	vi.mocked(spawnSync).mockImplementation((executable) => {
		const rows = [
			{ ProcessId: process.pid, ParentProcessId: process.ppid },
			{ ProcessId: process.ppid, ParentProcessId: 17171 },
			{ ProcessId: 17171, ParentProcessId: 1 },
		];
		const stdout = String(executable).endsWith("powershell.exe")
			? JSON.stringify(rows)
			: rows.map((row) => `${row.ProcessId} ${row.ParentProcessId} 18181`).join("\n");
		return { status: 0, stdout } as ReturnType<typeof spawnSync>;
	});
});

afterEach(() => {
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe.each(["linux", "darwin", "win32"])("process-tree target protection on %s", (targetPlatform) => {
	it("rejects a grandparent and caller process group before destructive OS calls", () => {
		Object.defineProperty(process, "platform", { value: targetPlatform, configurable: true });
		const signal = vi.spyOn(process, "kill").mockReturnValue(true);
		vi.mocked(readFileSync).mockImplementation((path) => {
			const pid = Number(String(path).split("/")[2]);
			const parent = pid === process.pid ? process.ppid : pid === process.ppid ? 17171 : 1;
			return `${pid} (fixture name)) S ${parent} 18181 17171`;
		});
		vi.mocked(spawnSync).mockClear();
		for (const pid of targetPlatform === "win32" ? [17171] : [17171, 18181])
			expect(killTreeNow(pid).success).toBe(false);
		expect(signal).not.toHaveBeenCalled();
		expect(vi.mocked(spawnSync).mock.calls.filter((call) => String(call[0]).endsWith("taskkill.exe"))).toHaveLength(
			0,
		);
	});
	it.each([0, -1, -42, 1, 1.5, NaN, Infinity, 2 ** 32, process.pid, process.ppid])(
		"rejects unsafe target %s without signalling or launching taskkill",
		async (pid) => {
			Object.defineProperty(process, "platform", { value: targetPlatform, configurable: true });
			vi.useFakeTimers();
			const signal = vi.spyOn(process, "kill").mockReturnValue(true);
			vi.mocked(spawnSync).mockClear();
			const child = Object.assign(new EventEmitter(), {
				pid,
				exitCode: null,
				signalCode: null,
				unref: vi.fn(),
			}) as unknown as ChildProcess;

			expect(killTreeNow(pid).success).toBe(false);
			const termination = killTree(child, { graceMs: 1 });
			await vi.runAllTimersAsync();
			expect(await termination).toBe("failed");
			expect(signal).not.toHaveBeenCalled();
			expect(spawnSync).not.toHaveBeenCalled();
			expect(child.listenerCount("exit")).toBe(0);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it("negative control: dispatches an ordinary target to the platform adapter", () => {
		Object.defineProperty(process, "platform", { value: targetPlatform, configurable: true });
		const signal = vi.spyOn(process, "kill").mockReturnValue(true);
		vi.mocked(spawnSync).mockClear();
		expect(killTreeNow(4242).success).toBe(true);
		if (targetPlatform !== "win32") expect(signal).toHaveBeenCalledWith(-4242, "SIGKILL");
		else expect(spawnSync).toHaveBeenCalled();
	});
});
