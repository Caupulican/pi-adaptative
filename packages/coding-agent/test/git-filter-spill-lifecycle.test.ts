// @isolated: mocks child-process and spill-stream owners and mutates the agent-dir environment
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, type WriteStream, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "./temp-dir.ts";

const spawnMock = vi.hoisted(() => vi.fn());
const createSafeWriteStreamMock = vi.hoisted(() => vi.fn());
const endWriteStreamMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock, spawnSync: vi.fn() }));
vi.mock("../src/utils/safe-write-stream.ts", () => ({
	createSafeWriteStream: createSafeWriteStreamMock,
	endWriteStream: endWriteStreamMock,
}));

import { runGitQuery } from "../src/core/tools/git-filter.ts";

const AGENT_DIR_ENV = "PI_ADAPTATIVE_CODING_AGENT_DIR";

interface ChildFixture {
	child: ChildProcess;
	stderr: PassThrough;
	stdout: PassThrough;
}

interface SpillFixture {
	destroy: ReturnType<typeof vi.fn>;
	end: ReturnType<typeof vi.fn>;
	setTerminal(): void;
	stream: WriteStream;
	write: ReturnType<typeof vi.fn>;
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

function spillFixture(): SpillFixture {
	const stream = new EventEmitter() as WriteStream;
	let closed = false;
	let destroyed = false;
	let errored: Error | null = null;
	let writableEnded = false;
	let writableFinished = false;
	Object.defineProperties(stream, {
		closed: { get: () => closed },
		destroyed: { get: () => destroyed },
		errored: { get: () => errored },
		writableEnded: { get: () => writableEnded },
		writableFinished: { get: () => writableFinished },
	});
	const write = vi.fn(() => false);
	const end = vi.fn((callback?: () => void) => {
		if (destroyed) return stream;
		writableEnded = true;
		writableFinished = true;
		closed = true;
		callback?.();
		stream.emit("finish");
		return stream;
	});
	const destroy = vi.fn(() => {
		destroyed = true;
		closed = true;
		stream.emit("close");
		return stream;
	});
	stream.destroy = destroy as unknown as WriteStream["destroy"];
	stream.write = write as unknown as WriteStream["write"];
	stream.end = end as unknown as WriteStream["end"];
	return {
		destroy,
		end,
		setTerminal() {
			destroyed = true;
			errored = new Error("disk full");
		},
		stream,
		write,
	};
}

function completeChild(fixture: ChildFixture, output: string): void {
	fixture.stdout.end(output);
	fixture.stderr.end();
	Object.defineProperty(fixture.child, "exitCode", { value: 0, writable: true });
	fixture.child.emit("exit", 0, null);
	fixture.child.emit("close", 0, null);
}

async function resolvesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | "timed-out"> {
	return Promise.race([
		promise,
		new Promise<"timed-out">((resolve) => {
			setTimeout(() => resolve("timed-out"), timeoutMs);
		}),
	]);
}

beforeEach(() => {
	process.env[AGENT_DIR_ENV] = tempDir("pi-git-spill-lifecycle-");
	process.env.PI_GIT_FILTER_MAX_RETAINED_BYTES = "1";
	spawnMock.mockReset();
	createSafeWriteStreamMock.mockReset();
	endWriteStreamMock.mockReset();
	endWriteStreamMock.mockImplementation(async (stream: WriteStream) => {
		if (stream.writableFinished || stream.destroyed || stream.closed || stream.errored !== null) return;
		await new Promise<void>((resolve) => stream.end(resolve));
	});
});

afterEach(() => {
	delete process.env[AGENT_DIR_ENV];
	delete process.env.PI_GIT_FILTER_MAX_RETAINED_BYTES;
});

describe("git-filter spill lifecycle", () => {
	it("pauses Git stdout while the spill writer is backpressured and resumes on drain", async () => {
		const child = childFixture();
		const spill = spillFixture();
		spill.write.mockReturnValueOnce(false).mockReturnValue(true);
		const pause = vi.spyOn(child.stdout, "pause");
		const resume = vi.spyOn(child.stdout, "resume");
		createSafeWriteStreamMock.mockReturnValue(spill.stream);
		spawnMock.mockImplementation(() => {
			queueMicrotask(() => {
				pause.mockClear();
				resume.mockClear();
				child.stdout.write("overflow");
				spill.stream.emit("drain");
				completeChild(child, "tail");
			});
			return child.child;
		});

		const result = await runGitQuery(process.cwd(), [], ["status"]);

		expect(result.overflow).toBeDefined();
		expect(pause).toHaveBeenCalledTimes(1);
		expect(resume).toHaveBeenCalledTimes(1);
		expect(endWriteStreamMock).toHaveBeenCalledWith(spill.stream);
	});

	it("settles after a spill error that happened before terminal flush", async () => {
		const child = childFixture();
		const spill = spillFixture();
		let spillPath: string | undefined;
		createSafeWriteStreamMock.mockImplementation((path: string, onError?: (error: Error) => void) => {
			spillPath = path;
			writeFileSync(path, "partial spill");
			spill.write.mockImplementation(() => {
				spill.setTerminal();
				onError?.(new Error("disk full"));
				return false;
			});
			return spill.stream;
		});
		spawnMock.mockImplementation(() => {
			queueMicrotask(() => completeChild(child, "overflow"));
			return child.child;
		});

		const result = await resolvesWithin(runGitQuery(process.cwd(), [], ["status"]), 100);

		expect(result).not.toBe("timed-out");
		if (result === "timed-out") return;
		expect(result.overflow).toBeUndefined();
		expect(result.stderr).toContain("spill failed: disk full");
		expect(endWriteStreamMock).toHaveBeenCalledWith(spill.stream);
		expect(spillPath).toBeDefined();
		expect(spillPath && existsSync(spillPath)).toBe(false);
	});

	it("bounds a spill flush that neither drains nor errors", async () => {
		const child = childFixture();
		const spill = spillFixture();
		spill.end.mockImplementation(() => spill.stream);
		createSafeWriteStreamMock.mockReturnValue(spill.stream);
		spawnMock.mockImplementation(() => {
			queueMicrotask(() => completeChild(child, "overflow"));
			return child.child;
		});
		const options = { timeout: 1, spillFlushTimeoutMs: 5 };

		const result = await resolvesWithin(runGitQuery(process.cwd(), [], ["status"], options), 100);

		expect(result).not.toBe("timed-out");
		if (result === "timed-out") return;
		expect(result.overflow).toBeUndefined();
		expect(result.stderr).toContain("spill flush timed out");
		expect(spill.destroy).toHaveBeenCalledTimes(1);
	});

	it("contains a synchronous spill write failure inside the output owner", async () => {
		const child = childFixture();
		const spill = spillFixture();
		spill.write.mockImplementation(() => {
			throw new Error("synchronous disk failure");
		});
		createSafeWriteStreamMock.mockReturnValue(spill.stream);
		let escaped: unknown;
		spawnMock.mockImplementation(() => {
			queueMicrotask(() => {
				try {
					child.stdout.write("overflow");
				} catch (error) {
					escaped = error;
				}
				completeChild(child, "");
			});
			return child.child;
		});

		const result = await runGitQuery(process.cwd(), [], ["status"]);

		expect(escaped).toBeUndefined();
		expect(result.overflow).toBeUndefined();
		expect(result.stderr).toContain("spill failed: synchronous disk failure");
	});
});
