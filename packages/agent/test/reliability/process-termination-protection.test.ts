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
	it.each([
		[1800, true],
		[2500, true],
		[3500, true],
		[5500, false],
	] as const)(
		"handles a Windows observer completing after %ims without accepting a timeout",
		(observerMs, observed) => {
			Object.defineProperty(process, "platform", { value: "win32", configurable: true });
			vi.mocked(spawnSync).mockImplementation((_executable, _args, options) => {
				const timedOut = observerMs > (options?.timeout ?? 0);
				const stdout = JSON.stringify([{ ProcessId: process.pid, ParentProcessId: process.ppid }]);
				return {
					pid: 8181,
					status: timedOut ? null : 0,
					signal: null,
					output: [null, stdout, ""],
					stdout,
					stderr: "",
					...(timedOut ? { error: Object.assign(new Error("observer deadline"), { code: "ETIMEDOUT" }) } : {}),
				};
			});
			const diagnostics: string[] = [];
			const ids = createProcessTerminationProtectionReader()((message) => diagnostics.push(message));
			expect(ids !== undefined).toBe(observed);
			if (observed) {
				expect(ids).toEqual(new Set([1, process.pid, process.ppid]));
				expect(diagnostics).toEqual([]);
			} else {
				expect(diagnostics.join("\n")).toContain("ETIMEDOUT");
			}
		},
	);
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
				timeout: targetPlatform === "win32" ? 5000 : 2000,
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
	it("accepts an exited historical Windows parent while protecting every recorded ancestor PID", () => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		const stdout = JSON.stringify([
			{ ProcessId: process.pid, ParentProcessId: process.ppid },
			{ ProcessId: process.ppid, ParentProcessId: 7171 },
		]);
		vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout } as ReturnType<typeof spawnSync>);
		const ids = createProcessTerminationProtectionReader()();
		expect(ids).toEqual(new Set([1, process.pid, process.ppid, 7171]));
		expect(ids?.has(8181)).toBe(false);
	});
	it("never treats an absent self record as an exited historical parent", () => {
		expect(collectProtectedProcessIds(100, 90, () => null)).toBeUndefined();
	});
	it("accepts an exited direct Windows parent and retains its protected PID", () => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		const stdout = JSON.stringify([{ ProcessId: process.pid, ParentProcessId: process.ppid }]);
		vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout } as ReturnType<typeof spawnSync>);
		expect(createProcessTerminationProtectionReader()()).toEqual(new Set([1, process.pid, process.ppid]));
	});
	it("treats a Windows recycled PID loop as an absent historical creator and retains protected ancestors", () => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		const stdout = JSON.stringify([
			{ ProcessId: process.pid, ParentProcessId: process.ppid },
			{ ProcessId: process.ppid, ParentProcessId: 2604 },
			{ ProcessId: 2604, ParentProcessId: process.ppid },
		]);
		vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout } as ReturnType<typeof spawnSync>);
		expect(createProcessTerminationProtectionReader()()).toEqual(new Set([1, process.pid, process.ppid, 2604]));
	});
	it.each(["ETIMEDOUT", "EACCES"])("refuses a Windows observer error %s despite parseable stdout", (code) => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		const stdout = JSON.stringify([{ ProcessId: process.pid, ParentProcessId: process.ppid }]);
		vi.mocked(spawnSync).mockReturnValue({
			pid: 8181,
			output: [null, stdout, ""],
			stderr: "",
			signal: null,
			status: 0,
			stdout,
			error: Object.assign(new Error(code), { code }),
		});
		const diagnostics: string[] = [];
		expect(createProcessTerminationProtectionReader()((message) => diagnostics.push(message))).toBeUndefined();
		expect(diagnostics).toEqual([`Process ancestry snapshot failed: ${code} (limit 5000ms)`]);
	});
	it.each([
		["cycle", 90, "Process ancestry contains a cycle at PID 100"],
		["parent-mismatch", 80, "Process ancestry parent mismatch for PID 100: expected 90, observed 80"],
	] as const)("explains a %s refusal without authorizing termination", (_reason, parentPid, expected) => {
		const diagnostics: string[] = [];
		const result = collectProtectedProcessIds(
			100,
			90,
			(pid) => ({ pid, parentPid: pid === 100 ? parentPid : 100 }),
			(message) => diagnostics.push(message),
		);
		expect(result).toBeUndefined();
		expect(diagnostics).toEqual([expected]);
	});
	it.each([-1, 1.5])("refuses a malformed recorded Windows parent %s", (parentPid) => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		const stdout = JSON.stringify([
			{ ProcessId: process.pid, ParentProcessId: process.ppid },
			{ ProcessId: process.ppid, ParentProcessId: parentPid },
		]);
		vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout } as ReturnType<typeof spawnSync>);
		expect(createProcessTerminationProtectionReader()()).toBeUndefined();
	});
	it.each(["win32", "darwin"])("refuses a failed %s snapshot even when stdout contains ancestry", (targetPlatform) => {
		Object.defineProperty(process, "platform", { value: targetPlatform, configurable: true });
		const stdout =
			targetPlatform === "win32"
				? JSON.stringify([{ ProcessId: process.pid, ParentProcessId: process.ppid }])
				: `${process.pid} ${process.ppid} ${process.pid}`;
		vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout } as ReturnType<typeof spawnSync>);
		expect(createProcessTerminationProtectionReader()()).toBeUndefined();
	});
	it("still refuses a missing macOS ancestor in a successful process snapshot", () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		vi.mocked(spawnSync).mockReturnValue({
			status: 0,
			stdout: `${process.pid} ${process.ppid} ${process.pid}`,
		} as ReturnType<typeof spawnSync>);
		expect(createProcessTerminationProtectionReader()()).toBeUndefined();
	});
	it("does not cache observer failure as authorization", () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: "" } as ReturnType<typeof spawnSync>);
		const read = createProcessTerminationProtectionReader();
		expect(read()).toBeUndefined();
		expect(read()).toBeUndefined();
		expect(spawnSync).toHaveBeenCalledTimes(2);
	});
});
