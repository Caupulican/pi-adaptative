import { createWriteStream, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSafeWriteStream, endWriteStream } from "../src/utils/safe-write-stream.ts";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Bounded race instead of a long sleep: proves settlement within `ms` without waiting out a real hang.
async function resolvesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
	return Promise.race([promise.then(() => true), delay(ms).then(() => false)]);
}

describe("createSafeWriteStream", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `safe-write-stream-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("writes normally to a valid path", async () => {
		const file = join(tempDir, "out.log");
		const stream = createSafeWriteStream(file);
		stream.write("hello");
		await new Promise<void>((resolve, reject) => {
			stream.end((error?: Error | null) => (error ? reject(error) : resolve()));
		});
		expect(readFileSync(file, "utf-8")).toBe("hello");
	});

	it("reports stream errors via callback instead of crashing the process", async () => {
		const errors: Error[] = [];
		const stream = createSafeWriteStream(join(tempDir, "missing-dir", "out.log"), (error) => {
			errors.push(error);
		});
		stream.write("data that will never land");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(errors.length).toBeGreaterThan(0);
	});

	it("swallows stream errors when no callback is provided", async () => {
		const stream = createSafeWriteStream(join(tempDir, "missing-dir", "out.log"));
		stream.write("data");
		await new Promise((resolve) => setTimeout(resolve, 50));
		// Reaching this line means the error event did not crash the process.
		expect(stream.destroyed).toBe(true);
	});
});

describe("endWriteStream", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `safe-write-stream-end-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("resolves promptly for a stream that already errored and closed before being called", async () => {
		const stream = createWriteStream(join(tempDir, "already-errored.log"));
		// A real fs.WriteStream throws an uncaught exception on an unhandled "error" event.
		stream.on("error", () => {});
		const closed = new Promise<void>((resolve) => stream.once("close", resolve));
		stream.destroy(new Error("boom"));
		await closed;

		// The stream is already terminal, so listeners attached only now would never fire:
		// this must resolve from the pre-existing state, not from a fresh event.
		expect(await resolvesWithin(endWriteStream(stream), 200)).toBe(true);
	});

	it("resolves on a second call for a stream that already errored and closed", async () => {
		const stream = createWriteStream(join(tempDir, "double-end.log"));
		stream.on("error", () => {});
		const closed = new Promise<void>((resolve) => stream.once("close", resolve));
		stream.destroy(new Error("boom"));
		await closed;

		expect(await resolvesWithin(endWriteStream(stream), 200)).toBe(true);
		// Second call: the first call's listeners are gone and the stream was already
		// terminal before this call even started.
		expect(await resolvesWithin(endWriteStream(stream), 200)).toBe(true);
	});

	it("resolves after a full flush with complete content on disk for a healthy stream", async () => {
		const file = join(tempDir, "healthy.log");
		const stream = createWriteStream(file);
		stream.write("hello ");
		stream.write("world");

		await endWriteStream(stream);

		expect(readFileSync(file, "utf-8")).toBe("hello world");
	});
});
