import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createRepoReadToolDefinition } from "../src/core/tools/repo-read.ts";
import type { spawnProcess } from "../src/utils/child-process.ts";

const OUTPUT_CAP_BYTES = 512 * 1024;
const NO_CONTEXT = undefined as never;

interface ChildFixture {
	child: ChildProcess;
	stderr: PassThrough;
	stdout: PassThrough;
}

function childFixture(): ChildFixture {
	const child = new EventEmitter() as ChildProcess;
	const stderr = new PassThrough();
	const stdout = new PassThrough();
	Object.defineProperties(child, {
		exitCode: { value: null, writable: true },
		pid: { value: undefined, writable: true },
		signalCode: { value: null, writable: true },
		stderr: { value: stderr },
		stdout: { value: stdout },
	});
	child.kill = vi.fn(() => true) as ChildProcess["kill"];
	child.unref = vi.fn() as unknown as ChildProcess["unref"];
	return { child, stderr, stdout };
}

function settle(fixture: ChildFixture, output: Buffer): void {
	fixture.stdout.end(output);
	fixture.stderr.end();
	const { child } = fixture;
	Object.defineProperty(child, "exitCode", { value: 0, writable: true });
	child.emit("exit", 0, null);
	child.emit("close", 0, null);
}

describe("repo_read process ownership", () => {
	it("routes an overflowing output cap through the bounded owner without a direct child signal", async () => {
		const fixture = childFixture();
		const spawn = vi.fn(() => {
			queueMicrotask(() => fixture.stdout.write(Buffer.alloc(OUTPUT_CAP_BYTES + 1, "x")));
			return fixture.child;
		}) as unknown as typeof spawnProcess;
		const tool = createRepoReadToolDefinition(process.cwd(), { spawn, timeoutMs: 5 });

		const result = await tool.execute("cap", { action: "status" }, undefined, undefined, NO_CONTEXT);

		expect(result.details).toMatchObject({ capped: true });
		expect(fixture.child.kill).not.toHaveBeenCalled();
		expect(spawn).toHaveBeenCalledWith(
			"git",
			expect.any(Array),
			expect.objectContaining({ detached: process.platform !== "win32" }),
		);
	});

	it("does not classify output that exactly fills the byte budget as capped", async () => {
		const fixture = childFixture();
		const spawn = vi.fn(() => {
			queueMicrotask(() => settle(fixture, Buffer.alloc(OUTPUT_CAP_BYTES, "x")));
			return fixture.child;
		}) as unknown as typeof spawnProcess;
		const tool = createRepoReadToolDefinition(process.cwd(), { spawn, timeoutMs: 50 });

		const result = await tool.execute("exact-cap", { action: "status" }, undefined, undefined, NO_CONTEXT);

		expect(result.details?.capped).toBeUndefined();
		expect(fixture.child.kill).not.toHaveBeenCalled();
	});

	it("preserves whichever of user abort and output overflow is observed first", async () => {
		const abortFirst = new AbortController();
		const abortFirstChild = childFixture();
		const abortFirstSpawn = vi.fn(() => {
			queueMicrotask(() => abortFirst.abort());
			return abortFirstChild.child;
		}) as unknown as typeof spawnProcess;
		const abortFirstTool = createRepoReadToolDefinition(process.cwd(), {
			spawn: abortFirstSpawn,
			timeoutMs: 50,
		});

		await expect(
			abortFirstTool.execute("abort-first", { action: "status" }, abortFirst.signal, undefined, NO_CONTEXT),
		).rejects.toThrow("Operation aborted");
		expect(abortFirstChild.child.kill).not.toHaveBeenCalled();

		const capFirst = new AbortController();
		const capFirstChild = childFixture();
		const capFirstSpawn = vi.fn(() => {
			queueMicrotask(() => {
				capFirstChild.stdout.write(Buffer.alloc(OUTPUT_CAP_BYTES + 1, "x"));
				capFirst.abort();
			});
			return capFirstChild.child;
		}) as unknown as typeof spawnProcess;
		const capFirstTool = createRepoReadToolDefinition(process.cwd(), { spawn: capFirstSpawn, timeoutMs: 50 });

		const result = await capFirstTool.execute(
			"cap-first",
			{ action: "status" },
			capFirst.signal,
			undefined,
			NO_CONTEXT,
		);

		expect(result.details).toMatchObject({ capped: true });
		expect(capFirstChild.child.kill).not.toHaveBeenCalled();
	});

	it("does not launch the main Git read when cancellation wins after object-path preflight", async () => {
		const cancellation = new AbortController();
		const fixture = childFixture();
		const spawn = vi.fn(() => {
			queueMicrotask(() => {
				settle(fixture, Buffer.from(`${process.cwd()}\n`));
				cancellation.abort();
			});
			return fixture.child;
		}) as unknown as typeof spawnProcess;
		const tool = createRepoReadToolDefinition(process.cwd(), { spawn, timeoutMs: 50 });

		await expect(
			tool.execute(
				"between-phases",
				{ action: "show", revisions: ["HEAD:package.json"] },
				cancellation.signal,
				undefined,
				NO_CONTEXT,
			),
		).rejects.toThrow("Operation aborted");

		expect(spawn).toHaveBeenCalledTimes(1);
	});
});
