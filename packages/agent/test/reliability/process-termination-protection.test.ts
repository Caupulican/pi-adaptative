import type * as ChildProcess from "node:child_process";
import { spawnSync } from "node:child_process";
import type * as Fs from "node:fs";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	collectProtectedProcessIds,
	createProcessTerminationProtectionReader,
} from "../../src/reliability/process-termination-protection.ts";

vi.mock("node:child_process", async (original) => ({ ...(await original<typeof ChildProcess>()), spawnSync: vi.fn() }));
vi.mock("node:fs", async (original) => ({ ...(await original<typeof Fs>()), readFileSync: vi.fn() }));
const platform = process.platform;
afterEach(() => {
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
	vi.restoreAllMocks();
});

describe("bounded ancestry protection", () => {
	it("protects higher ancestors and a sibling group leader without protecting an ordinary child", () => {
		const table = new Map([
			[100, { pid: 100, parentPid: 90, groupId: 95 }],
			[90, { pid: 90, parentPid: 80, groupId: 90 }],
			[80, { pid: 80, parentPid: 1, groupId: 80 }],
		]);
		const ids = collectProtectedProcessIds(100, 90, (pid) => table.get(pid));
		expect([...(ids ?? [])].sort((a, b) => a - b)).toEqual([1, 80, 90, 95, 100]);
		expect(ids?.has(101)).toBe(false);
	});
	it.each(["missing", "cycle", "wrong-identity", "negative-parent", "fractional-group", "changed-parent", "too-deep"])(
		"denies incomplete ancestry (%s)",
		(failure) => {
			let reads = 0;
			const ids = collectProtectedProcessIds(100, 90, (pid) => {
				reads++;
				if (failure === "missing") return undefined;
				if (failure === "too-deep") return { pid, parentPid: pid === 100 ? 90 : pid === 90 ? 1000 : pid + 1 };
				return {
					pid: failure === "wrong-identity" ? pid + 1 : pid,
					parentPid:
						failure === "negative-parent"
							? -1
							: failure === "changed-parent"
								? 50
								: pid === 100
									? 90
									: failure === "cycle"
										? 100
										: pid + 1,
					groupId: failure === "fractional-group" ? 1.5 : 100,
				};
			});
			expect(ids).toBeUndefined();
			expect(reads).toBeLessThanOrEqual(128);
			if (failure === "too-deep") expect(reads).toBe(128);
		},
	);
	it("reads Linux stat with closing parentheses in comm and refuses an inaccessible ancestor", () => {
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		vi.mocked(readFileSync).mockImplementation((path) => {
			const pid = Number(String(path).split("/")[2]);
			return `${pid} (a tricky ) name)) S ${pid === process.pid ? process.ppid : 1} 7171 7171`;
		});
		const read = createProcessTerminationProtectionReader();
		expect(read()?.has(7171)).toBe(true);
		vi.mocked(readFileSync).mockImplementation(() => {
			throw new Error("EACCES");
		});
		expect(read()).toBeUndefined();
	});
	it.each(["darwin", "win32"])(
		"reads a bounded %s snapshot and reuses successful launch ancestry",
		(targetPlatform) => {
			Object.defineProperty(process, "platform", { value: targetPlatform, configurable: true });
			const stdout =
				targetPlatform === "win32"
					? JSON.stringify([
							{ ProcessId: process.pid, ParentProcessId: process.ppid },
							{ ProcessId: process.ppid, ParentProcessId: 7171 },
							{ ProcessId: 7171, ParentProcessId: 0 },
						])
					: `${process.pid} ${process.ppid} 8181\n${process.ppid} 7171 7171\n7171 1 7171`;
			vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout } as ReturnType<typeof spawnSync>);
			const read = createProcessTerminationProtectionReader();
			expect(read()?.has(7171)).toBe(true);
			expect(read()?.has(7171)).toBe(true);
			expect(spawnSync).toHaveBeenCalledOnce();
			expect(vi.mocked(spawnSync).mock.calls[0]?.[2]).toMatchObject({
				timeout: 2000,
				maxBuffer: 4 * 1024 * 1024,
				windowsHide: true,
			});
		},
	);
	it.each(["garbage", "[]", "null", '[{"ProcessId":5,"ParentProcessId":1}]'])(
		"refuses a malformed or incomplete Windows snapshot %s",
		(stdout) => {
			Object.defineProperty(process, "platform", { value: "win32", configurable: true });
			vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout } as ReturnType<typeof spawnSync>);
			expect(createProcessTerminationProtectionReader()()).toBeUndefined();
		},
	);
	it("does not cache observer failure as authorization", () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: "" } as ReturnType<typeof spawnSync>);
		const read = createProcessTerminationProtectionReader();
		expect(read()).toBeUndefined();
		expect(read()).toBeUndefined();
		expect(spawnSync).toHaveBeenCalledTimes(2);
	});
});
