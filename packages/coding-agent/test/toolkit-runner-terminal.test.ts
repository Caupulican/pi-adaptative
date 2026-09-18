import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { spawnScriptExecutor } from "../src/core/toolkit/script-runner.ts";
import { spawnProcess, waitForChildProcessWithTermination } from "../src/utils/child-process.ts";

vi.mock("../src/utils/child-process.ts", () => ({
	spawnProcess: vi.fn(),
	waitForChildProcessWithTermination: vi.fn(),
}));

describe("native toolkit terminal reason projection", () => {
	beforeEach(() => vi.resetAllMocks());
	it.each(["exited", "aborted", "timeout"] as const)(
		"keeps reason=%s authoritative over a zero exit",
		async (reason) => {
			const child = Object.assign(new ChildProcess(), {
				stdout: new PassThrough(),
				stderr: new PassThrough(),
			});
			vi.mocked(spawnProcess).mockReturnValue(child);
			vi.mocked(waitForChildProcessWithTermination).mockImplementation(async () => {
				child.stdout?.emit("data", Buffer.from("actual stdout"));
				return { code: 0, reason };
			});
			const result = await spawnScriptExecutor("synthetic", [], "/fixture", 1000);
			expect(result).toMatchObject({
				exitCode: reason === "exited" ? 0 : null,
				timedOut: reason === "timeout",
				stdout: "actual stdout",
			});
			expect(spawnProcess).toHaveBeenCalledOnce();
			expect(waitForChildProcessWithTermination).toHaveBeenCalledOnce();
		},
	);

	it("preserves an established exit when caller cancellation arrives afterward", async () => {
		const abort = new AbortController();
		const child = Object.assign(new ChildProcess(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});
		vi.mocked(spawnProcess).mockReturnValue(child);
		vi.mocked(waitForChildProcessWithTermination).mockImplementation(async () => {
			abort.abort();
			return { code: 0, reason: "exited" };
		});
		await expect(spawnScriptExecutor("synthetic", [], "/fixture", 1000, abort.signal)).resolves.toMatchObject({
			exitCode: 0,
			timedOut: false,
		});
	});

	it("does not report success after output overflow even if the child exits zero", async () => {
		const child = Object.assign(new ChildProcess(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});
		vi.mocked(spawnProcess).mockReturnValue(child);
		vi.mocked(waitForChildProcessWithTermination).mockImplementation(async () => {
			child.stdout?.emit("data", Buffer.alloc(512 * 1024 + 1, "x"));
			return { code: 0, reason: "exited" };
		});
		await expect(spawnScriptExecutor("synthetic", [], "/fixture", 1000)).resolves.toMatchObject({
			exitCode: null,
			stderr: expect.stringContaining("maxBuffer"),
		});
	});

	it("does not spawn after pre-existing cancellation", async () => {
		const abort = new AbortController();
		abort.abort();
		await expect(spawnScriptExecutor("synthetic", [], "/fixture", 1000, abort.signal)).resolves.toMatchObject({
			exitCode: null,
			timedOut: false,
		});
		expect(spawnProcess).not.toHaveBeenCalled();
	});
});
