import { ChildProcess } from "node:child_process";
import { getEventListeners } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_FILE_CODEC_PROTOCOL_BYTES } from "../src/core/tools/file-codec-runner.ts";
import { createFileCodecReadSession } from "../src/core/tools/file-codec-stream.ts";
import { spawnProcess } from "../src/utils/child-process.ts";

vi.mock("../src/utils/child-process.ts", { spy: true });
vi.mock("../src/core/python-runtime.ts", () => ({
	ensurePythonRuntime: vi.fn(async () => ({
		status: "ready",
		pythonPath: "fixture-python",
		uvPath: "fixture-uv",
		pythonInstalled: false,
	})),
}));

afterEach(() => {
	vi.clearAllMocks();
	vi.useRealTimers();
});

interface Request {
	sequence: number;
	final: boolean;
}

function backend(onRequest: (request: Request) => void) {
	const child = new ChildProcess();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const requests: Request[] = [];
	child.stdout = stdout;
	child.stderr = stderr;
	child.stdin = new Writable({
		write(data: Buffer, _encoding, callback) {
			const request: Request = JSON.parse(data.toString("utf8"));
			requests.push(request);
			onRequest(request);
			callback();
		},
	});
	vi.mocked(spawnProcess).mockReturnValueOnce(child);
	const finish = (code: number) => {
		Object.defineProperty(child, "exitCode", { value: code, configurable: true });
		stdout.end();
		stderr.end();
		child.emit("exit", code, null);
		child.emit("close", code, null);
	};
	return { child, stdout, stderr, requests, finish };
}

function frame(request: Request, extra: Record<string, unknown> = {}): string {
	return `${JSON.stringify({ ...request, text: "é🙂\r\n", encoding: "utf-16-le", ...extra })}\n`;
}

describe("codec read stream framing and terminal evidence", () => {
	it("handles every byte boundary and waits for final process termination", async () => {
		const b = backend((request) => {
			for (const byte of Buffer.from(frame(request))) b.stdout.write(Buffer.from([byte]));
			if (request.final) b.finish(0);
		});
		const controller = new AbortController();
		const session = await createFileCodecReadSession(controller.signal);
		try {
			expect(await session.decode(Buffer.from("first"), "utf-16-le", false)).toEqual({
				text: "é🙂\r\n",
				encoding: "utf-16-le",
				detected: false,
			});
			expect(await session.decode(Buffer.alloc(0), "utf-16-le", true)).toEqual({
				text: "é🙂\r\n",
				encoding: "utf-16-le",
				detected: false,
			});
			expect(b.requests.map((request) => request.sequence)).toEqual([0, 1]);
			expect(b.stdout.destroyed).toBe(true);
		} finally {
			await session.close();
		}
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});

	it.each([
		{ name: "stale sequence", response: (r: Request) => Buffer.from(frame(r, { sequence: r.sequence + 1 })) },
		{ name: "wrong final marker", response: (r: Request) => Buffer.from(frame(r, { final: !r.final })) },
		{ name: "non-string text", response: (r: Request) => Buffer.from(frame(r, { text: [] })) },
		{ name: "ill-formed Unicode", response: (r: Request) => Buffer.from(frame(r, { text: "\ud800" })) },
		{ name: "missing encoding", response: (r: Request) => Buffer.from(frame(r, { encoding: null })) },
		{ name: "invalid UTF-8", response: () => Buffer.from([0xff, 10]) },
		{ name: "malformed JSON", response: () => Buffer.from("FIXTURE_PRIVATE_TEXT\n") },
		{ name: "duplicate frames", response: (r: Request) => Buffer.from(frame(r) + frame(r)) },
		{ name: "trailing bytes", response: (r: Request) => Buffer.from(`${frame(r)}x`) },
	])("rejects $name without exposing frame payloads", async ({ response }) => {
		const b = backend((request) => b.stdout.write(response(request)));
		const session = await createFileCodecReadSession();
		try {
			await expect(session.decode(Buffer.from("x"), "utf-16-le", false)).rejects.toThrow(
				/could not verify preservation/,
			);
		} finally {
			await session.close();
		}
		expect(b.stdout.destroyed).toBe(true);
		expect(b.requests).toHaveLength(1);
	});

	it("rejects an oversized frame before retaining its bytes", async () => {
		const b = backend(() => b.stdout.write(Buffer.alloc(MAX_FILE_CODEC_PROTOCOL_BYTES + 1, 0x78)));
		const session = await createFileCodecReadSession();
		try {
			await expect(session.decode(Buffer.from("x"), "utf-16-le", false)).rejects.toThrow(/could not verify/);
		} finally {
			await session.close();
		}
	});

	it.each([0, 1])("accepts an availability diagnostic only with its matching error exit: %s", async (code) => {
		const b = backend((request) => {
			b.stdout.write(frame(request, { error: "codec_unavailable" }));
			b.finish(code);
		});
		const session = await createFileCodecReadSession();
		try {
			await expect(session.decode(Buffer.from("x"), "X-FIXTURE", false)).rejects.toThrow(
				code === 1 ? /iconv is unavailable/ : /could not verify/,
			);
		} finally {
			await session.close();
		}
	});

	it("rejects premature death even after a previous chunk succeeded", async () => {
		const b = backend((request) => b.stdout.write(frame(request)));
		const session = await createFileCodecReadSession();
		try {
			await session.decode(Buffer.from("x"), "utf-16-le", false);
			b.finish(0);
			await expect(session.decode(Buffer.from("y"), "utf-16-le", true)).rejects.toThrow(/could not verify/);
		} finally {
			await session.close();
		}
		expect(spawnProcess).toHaveBeenCalledTimes(1);
	});

	it("does not report final success for a nonzero process exit", async () => {
		const b = backend((request) => {
			b.stdout.write(frame(request));
			b.finish(7);
		});
		const session = await createFileCodecReadSession();
		try {
			await expect(session.decode(Buffer.from("x"), "utf-16-le", true)).rejects.toThrow(/could not verify/);
		} finally {
			await session.close();
		}
	});

	it("rejects a partial final frame and private stderr", async () => {
		const b = backend((request) => {
			b.stdout.write(frame(request).slice(0, -1));
			b.stderr.write("FIXTURE_PRIVATE_TEXT");
			b.finish(1);
		});
		const session = await createFileCodecReadSession();
		try {
			const error = await session.decode(Buffer.from("x"), "utf-16-le", true).catch((error: unknown) => error);
			expect(error).toBeInstanceOf(Error);
			expect(String(error)).not.toContain("FIXTURE_PRIVATE_TEXT");
		} finally {
			await session.close();
		}
	});

	it("cancels a pending frame and detaches its abort subscription", async () => {
		const b = backend(() => {});
		const controller = new AbortController();
		const session = await createFileCodecReadSession(controller.signal);
		const result = session.decode(Buffer.from("x"), "utf-16-le", false);
		controller.abort();
		await expect(result).rejects.toThrow(/aborted/);
		await session.close();
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
		expect(b.stdout.destroyed).toBe(true);
	});

	it("times out a silent frame without waiting forever for child close", async () => {
		vi.useFakeTimers();
		const b = backend(() => {});
		const session = await createFileCodecReadSession();
		const result = session.decode(Buffer.from("x"), "utf-16-le", false).catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(String(await result)).toMatch(/timed out/);
		await session.close();
		expect(b.stdout.destroyed).toBe(true);
	});

	it("rejects concurrent requests without overwriting the admitted request", async () => {
		const b = backend(() => {});
		const session = await createFileCodecReadSession();
		const first = session.decode(Buffer.from("x"), "utf-16-le", false);
		await expect(session.decode(Buffer.from("y"), "utf-16-le", false)).rejects.toThrow(/not available/);
		b.stdout.write(frame(b.requests[0]));
		expect(await first).toMatchObject({ text: "é🙂\r\n" });
		await session.close();
		expect(b.requests).toHaveLength(1);
	});

	it.each(["stdout", "stderr"] as const)("contains asynchronous %s errors and closes the session", async (stream) => {
		const b = backend(() => {});
		const session = await createFileCodecReadSession();
		const result = session.decode(Buffer.from("x"), "utf-16-le", false).catch((error: unknown) => error);
		try {
			expect(() => b[stream].emit("error", new Error("FIXTURE_PRIVATE_TEXT"))).not.toThrow();
			expect(String(await result)).toMatch(/could not verify/);
			expect(String(await result)).not.toContain("FIXTURE_PRIVATE_TEXT");
		} finally {
			await session.close();
		}
	});

	it("releases streams after an asynchronous spawn failure", async () => {
		const b = backend(() => {});
		const session = await createFileCodecReadSession();
		const result = session.decode(Buffer.from("x"), "utf-16-le", false).catch((error: unknown) => error);
		b.child.emit("error", new Error("FIXTURE_PRIVATE_TEXT"));
		expect(String(await result)).toMatch(/could not verify/);
		await session.close();
		expect(b.stdout.destroyed).toBe(true);
		expect(b.stderr.destroyed).toBe(true);
		expect(b.child.stdin?.destroyed).toBe(true);
	});
});

/**
 * The detection pass runs on the same session, before the decode frames it resolves the encoding
 * for. Its final frame ends the pass, not the helper: the process has to stay up to decode. A
 * verdict offered before the source has ended would be a verdict on bytes nobody has read yet.
 */
describe("codec detection frames on the read session", () => {
	interface DetectRequest extends Request {
		operation?: string;
		source?: string;
	}

	function detectBackend(answer: (request: DetectRequest) => string) {
		const child = new ChildProcess();
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const requests: DetectRequest[] = [];
		child.stdout = stdout;
		child.stderr = stderr;
		child.stdin = new Writable({
			write(data: Buffer, _encoding, callback) {
				const request: DetectRequest = JSON.parse(data.toString("utf8"));
				requests.push(request);
				stdout.write(answer(request));
				callback();
			},
		});
		vi.mocked(spawnProcess).mockReturnValueOnce(child);
		const finish = (code: number) => {
			Object.defineProperty(child, "exitCode", { value: code, configurable: true });
			stdout.end();
			stderr.end();
			child.emit("exit", code, null);
			child.emit("close", code, null);
		};
		return { child, stdout, stderr, requests, finish };
	}

	it("streams every chunk, answers on the final frame, and keeps the helper alive to decode", async () => {
		const b = detectBackend((request) => {
			if (request.operation === "detect") {
				const verdict = request.final ? { encoding: "latin-1", detected: true } : {};
				return `${JSON.stringify({ sequence: request.sequence, final: request.final, ...verdict })}\n`;
			}
			if (request.final) setImmediate(() => b.finish(0));
			return `${JSON.stringify({ sequence: request.sequence, final: request.final, text: "é", encoding: "latin-1", detected: false })}\n`;
		});
		const session = await createFileCodecReadSession();
		try {
			expect(await session.detect([Buffer.from("first"), Buffer.from("second")])).toEqual({
				encoding: "latin-1",
				detected: true,
			});
			// The helper is still serving: the decode frames the verdict was resolved for follow it.
			expect(await session.decode(Buffer.from("first"), "latin-1", true)).toEqual({
				text: "é",
				encoding: "latin-1",
				detected: false,
			});
		} finally {
			await session.close();
		}
		expect(b.requests.map((request) => [request.operation, request.final])).toEqual([
			["detect", false],
			["detect", false],
			["detect", true],
			["decode", true],
		]);
		expect(b.requests.map((request) => request.sequence)).toEqual([0, 1, 2, 3]);
		expect(spawnProcess).toHaveBeenCalledTimes(1);
	});

	it.each([
		{
			name: "a verdict before the source ended",
			answer: (r: DetectRequest) =>
				`${JSON.stringify({ sequence: r.sequence, final: r.final, encoding: "latin-1", detected: true })}\n`,
		},
		{
			name: "a final frame with no encoding",
			answer: (r: DetectRequest) => `${JSON.stringify({ sequence: r.sequence, final: r.final })}\n`,
		},
		{
			name: "a final frame that does not say whether it detected",
			answer: (r: DetectRequest) =>
				`${JSON.stringify({ sequence: r.sequence, final: r.final, encoding: r.final ? "latin-1" : undefined })}\n`,
		},
	])("rejects $name", async ({ answer }) => {
		const b = detectBackend(answer);
		const session = await createFileCodecReadSession();
		try {
			await expect(session.detect([Buffer.from("first")])).rejects.toThrow(/could not verify preservation/);
		} finally {
			await session.close();
		}
		expect(b.stdout.destroyed).toBe(true);
	});

	it("reports missing evidence from the detection pass with its own error exit", async () => {
		const b = detectBackend((request) => {
			setImmediate(() => b.finish(1));
			return `${JSON.stringify({ sequence: request.sequence, final: request.final, error: "encoding_required" })}\n`;
		});
		const session = await createFileCodecReadSession();
		try {
			await expect(session.detect([Buffer.from("first")])).rejects.toThrow(
				/Source encoding is unknown or malformed/,
			);
		} finally {
			await session.close();
		}
	});
});
