import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { spawnScriptExecutor } from "../src/core/toolkit/script-runner.ts";
import { spawnProcess } from "../src/utils/child-process.ts";
import { waitForOwnedProcessTreeWithTermination } from "../src/utils/process-group-wait.ts";

vi.mock("../src/utils/child-process.ts", () => ({
	spawnProcess: vi.fn(),
}));
vi.mock("../src/utils/process-group-wait.ts", () => ({
	waitForOwnedProcessTreeWithTermination: vi.fn(),
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
			vi.mocked(waitForOwnedProcessTreeWithTermination).mockImplementation(async () => {
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
			expect(waitForOwnedProcessTreeWithTermination).toHaveBeenCalledOnce();
		},
	);

	it("preserves an established exit when caller cancellation arrives afterward", async () => {
		const abort = new AbortController();
		const child = Object.assign(new ChildProcess(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});
		vi.mocked(spawnProcess).mockReturnValue(child);
		vi.mocked(waitForOwnedProcessTreeWithTermination).mockImplementation(async () => {
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
		vi.mocked(waitForOwnedProcessTreeWithTermination).mockImplementation(async () => {
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

	it.each([new Error("waiter failed"), undefined])(
		"retains captured output when the waiter rejects with %s",
		async (error) => {
			const child = Object.assign(new ChildProcess(), {
				stdout: new PassThrough(),
				stderr: new PassThrough(),
			});
			vi.mocked(spawnProcess).mockReturnValue(child);
			vi.mocked(waitForOwnedProcessTreeWithTermination).mockImplementation(async () => {
				child.stdout.emit("data", Buffer.from("partial result"));
				child.stderr.emit("data", Buffer.from("script diagnostic"));
				throw error;
			});
			await expect(spawnScriptExecutor("synthetic", [], "/fixture", 1000)).resolves.toMatchObject({
				exitCode: null,
				stdout: "partial result",
				stderr: `script diagnostic\n${error instanceof Error ? error.message : String(error)}`,
				timedOut: false,
			});
		},
	);

	it("retains the overflow reason and captured stderr when the waiter rejects", async () => {
		const child = Object.assign(new ChildProcess(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});
		vi.mocked(spawnProcess).mockReturnValue(child);
		vi.mocked(waitForOwnedProcessTreeWithTermination).mockImplementation(async () => {
			child.stderr.emit("data", Buffer.from("script diagnostic"));
			child.stdout.emit("data", Buffer.alloc(512 * 1024 + 1, "x"));
			throw new Error("waiter failed");
		});
		const result = await spawnScriptExecutor("synthetic", [], "/fixture", 1000);
		expect(result.exitCode).toBeNull();
		expect(result.stdout).toBe("x".repeat(512 * 1024));
		expect(result.stderr).toBe("script diagnostic\nCommand output exceeded maxBuffer (524288 bytes)\nwaiter failed");
	});

	it("reports a spawn failure without adding empty output diagnostics", async () => {
		vi.mocked(spawnProcess).mockImplementation(() => {
			throw new Error("spawn failed");
		});
		await expect(spawnScriptExecutor("synthetic", [], "/fixture", 1000)).resolves.toMatchObject({
			exitCode: null,
			stdout: "",
			stderr: "spawn failed",
			timedOut: false,
		});
		expect(waitForOwnedProcessTreeWithTermination).not.toHaveBeenCalled();
	});
});
