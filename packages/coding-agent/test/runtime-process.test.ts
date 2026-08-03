import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Transform } from "node:stream";
import { describe, expect, it } from "vitest";
import {
	createRuntimeCommandRunner,
	fetchRuntimeDownload,
	installRuntimeArchive,
	removePartialDownload,
	resolveRuntimeLifecycleDependencies,
	runtimeCommandAvailable,
	tryFileSizeBytes,
	waitForWritableClosed,
	writeRuntimeDownload,
} from "../src/core/models/runtime-process.ts";

describe("runtime process ownership", () => {
	it("retains an exact bounded tail while progress receives every fragmented output unit", async () => {
		const progress: string[] = [];
		const runner = createRuntimeCommandRunner({ timeoutMs: 5_000, killGraceMs: 100, maxOutputUnits: 4_096 });
		const result = await runner(
			process.execPath,
			["-e", "for(let i=0;i<32768;i++)process.stdout.write(String(i%10))"],
			{ onOutput: (chunk) => progress.push(chunk) },
		);
		const completeOutput = progress.join("");

		expect(result.ok).toBe(true);
		expect(completeOutput).toHaveLength(32_768);
		expect(result.stdout).toBe(completeOutput.slice(-4_096));
		expect(result.stderr).toBe("");
	});

	it("keeps small stdout and stderr unchanged as the negative control", async () => {
		const runner = createRuntimeCommandRunner({ timeoutMs: 5_000, killGraceMs: 100, maxOutputUnits: 4_096 });
		const result = await runner(process.execPath, [
			"-e",
			"process.stdout.write('small-out');process.stderr.write('small-error')",
		]);

		expect(result).toMatchObject({ ok: true, stdout: "small-out", stderr: "small-error", code: 0 });
	});

	it("uses the bounded default when an invalid output limit is injected", async () => {
		const runner = createRuntimeCommandRunner({ timeoutMs: 5_000, killGraceMs: 100, maxOutputUnits: Number.NaN });
		const result = await runner(process.execPath, ["-e", "process.stdout.write('not-truncated')"]);

		expect(result.stdout).toBe("not-truncated");
	});

	it("terminates a hung runtime command at its configured deadline", async () => {
		const runner = createRuntimeCommandRunner({ timeoutMs: 100, killGraceMs: 100 });
		const result = await runner(process.execPath, ["-e", "setInterval(()=>{},1000)"]);

		expect(result.ok).toBe(false);
		expect(result.error).toBe(`${process.execPath} timed out after 100ms`);
	});

	it("returns the successful response body by identity without consuming or joining it", async () => {
		const body = {} as ReadableStream<Uint8Array>;
		const response = { ok: true, status: 200, body } as Response;
		const result = await fetchRuntimeDownload(async () => response, "https://example.test/runtime.bin");

		expect(result).toEqual({ ok: true, response, body });
	});

	it("resolves injected lifecycle dependencies once and streams archive identity to extraction", async () => {
		const fetchFn = (async () => new Response()) as typeof fetch;
		const spawnFn = () => ({ pid: 1, kill: () => true, unref: () => {}, on: () => undefined }) as never;
		const existsFn = () => true;
		const sleepFn = async () => {};
		expect(resolveRuntimeLifecycleDependencies({ fetchFn, spawnFn, existsFn, sleepFn })).toEqual([
			fetchFn,
			spawnFn,
			existsFn,
			sleepFn,
		]);

		const root = mkdtempSync(join(tmpdir(), "pi-runtime-extract-"));
		const input = {} as NodeJS.ReadableStream;
		try {
			const response = { ok: true, status: 200, body: input } as unknown as Response;
			const result = await installRuntimeArchive(
				async () => response,
				"https://example.test/runtime.zip",
				join(root, "runtime"),
				{ name: "runtime.zip", kind: "zip" },
				async (receivedInput, receivedDir, kind) => {
					expect(receivedInput).toBe(input);
					expect(receivedDir).toBe(join(root, "runtime"));
					expect(kind).toBe("zip");
					return { ok: true };
				},
			);
			expect(result).toEqual({ ok: true });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("maps transport and HTTP failures without exposing a body", async () => {
		await expect(
			fetchRuntimeDownload(async () => {
				throw new Error("connection reset");
			}, "https://example.test/runtime.bin"),
		).resolves.toEqual({ ok: false, error: "download-fail: connection reset" });
		await expect(
			fetchRuntimeDownload(
				async () => ({ ok: false, status: 503, body: null }) as Response,
				"https://example.test/runtime.bin",
			),
		).resolves.toEqual({ ok: false, error: "download-fail: HTTP 503" });
	});

	it("owns runtime file probes and best-effort partial cleanup", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-process-"));
		const file = join(root, "partial.bin");
		try {
			writeFileSync(file, "runtime-bytes");
			expect(tryFileSizeBytes(file)).toBe(13);
			removePartialDownload(file);
			expect(existsSync(file)).toBe(false);
			expect(tryFileSizeBytes(file)).toBeUndefined();
			expect(() => removePartialDownload(file)).not.toThrow();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("closes a failed pipeline stream before partial-file cleanup proceeds", async () => {
		const stream = new PassThrough();
		await waitForWritableClosed(stream);
		expect(stream.destroyed).toBe(true);
		expect(stream.closed).toBe(true);
		await expect(waitForWritableClosed(stream)).resolves.toBeUndefined();
	});

	it("streams runtime payloads and removes a partial file after transform failure", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-runtime-write-"));
		const complete = join(root, "complete.bin");
		const partial = join(root, "partial.bin");
		try {
			await expect(writeRuntimeDownload(Readable.from(["one", "two"]), complete)).resolves.toEqual({ ok: true });
			expect(tryFileSizeBytes(complete)).toBe(6);

			const fail = new Transform({
				transform(_chunk, _encoding, callback) {
					callback(new Error("integrity stream failed"));
				},
			});
			await expect(writeRuntimeDownload(Readable.from(["partial"]), partial, fail)).resolves.toEqual({
				ok: false,
				error: "download-fail: integrity stream failed",
			});
			expect(existsSync(partial)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("detects the current runtime executable and rejects a missing command", () => {
		expect(runtimeCommandAvailable(process.execPath)).toBe(true);
		expect(runtimeCommandAvailable("pi-command-that-does-not-exist-7e7a99")).toBe(false);
	});

	it("accepts both Node undefined and cross-spawn null as a successful probe", () => {
		expect(runtimeCommandAvailable("available", () => ({ error: undefined }))).toBe(true);
		expect(runtimeCommandAvailable("available", () => ({ error: null }))).toBe(true);
		expect(runtimeCommandAvailable("missing", () => ({ error: new Error("ENOENT") }))).toBe(false);
	});
});
