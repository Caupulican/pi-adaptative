import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSafeWriteStream } from "../src/utils/safe-write-stream.ts";

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
