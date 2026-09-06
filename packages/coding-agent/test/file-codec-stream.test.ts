import { afterEach, describe, expect, it, vi } from "vitest";
import { execCommand } from "../src/core/exec.ts";
import { decodeTextChunks } from "../src/core/tools/file-text-decoder.ts";
import { spawnProcess } from "../src/utils/child-process.ts";

vi.mock("../src/utils/child-process.ts", { spy: true });
vi.mock("../src/core/exec.ts", { spy: true });
vi.mock("../src/core/python-runtime.ts", () => ({
	ensurePythonRuntime: vi.fn(async () => ({
		status: "ready",
		pythonPath: process.platform === "win32" ? "python" : "python3",
		uvPath: "synthetic-unused",
		pythonInstalled: false,
	})),
}));

afterEach(() => vi.clearAllMocks());

describe("encoded read process ownership", () => {
	it("uses one bounded helper for the entire read, not one process per chunk", async () => {
		const bytes = Buffer.from("\uFEFFcafé🙂\r\nlast", "utf16le");
		const pieces = [...bytes].map((byte) => Buffer.from([byte]));
		let text = "";
		for await (const part of decodeTextChunks(pieces)) text += part;
		expect(text).toBe("café🙂\r\nlast");
		expect(spawnProcess).toHaveBeenCalledTimes(1);
		expect(execCommand).not.toHaveBeenCalled();
		const child = vi.mocked(spawnProcess).mock.results[0].value;
		expect(child.exitCode).toBe(0);
	});

	it("keeps native UTF-8 reads process-free", async () => {
		let text = "";
		for await (const part of decodeTextChunks([Buffer.from("café")])) text += part;
		expect(text).toBe("café");
		expect(spawnProcess).not.toHaveBeenCalled();
		expect(execCommand).not.toHaveBeenCalled();
	});

	it("preserves source I/O failure identity while reaping the helper", async () => {
		const failure = new Error("synthetic backend I/O failure");
		async function* source() {
			yield Buffer.from("\uFEFFfirst", "utf16le");
			throw failure;
		}
		const reader = decodeTextChunks(source());
		expect(await reader.next()).toEqual({ value: "first", done: false });
		await expect(reader.next()).rejects.toBe(failure);
		const child = vi.mocked(spawnProcess).mock.results[0].value;
		expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
	});

	it("reaps its helper and closes the source when the consumer returns early", async () => {
		let closed = false;
		async function* source() {
			try {
				yield Buffer.from("\uFEFFfirst", "utf16le");
				throw new Error("must not pull another source chunk");
			} finally {
				closed = true;
			}
		}
		for await (const text of decodeTextChunks(source())) {
			expect(text).toBe("first");
			break;
		}
		expect(closed).toBe(true);
		expect(spawnProcess).toHaveBeenCalledTimes(1);
		const child = vi.mocked(spawnProcess).mock.results[0].value;
		expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
	});
});
