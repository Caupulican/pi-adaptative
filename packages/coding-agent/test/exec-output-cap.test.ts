import { describe, expect, it } from "vitest";
import { execCommand } from "../src/core/exec.ts";

describe("execCommand output retention", () => {
	it("caps runaway stdout to the configured buffer and flags truncation", async () => {
		const result = await execCommand(
			process.execPath,
			["-e", "const chunk = 'x'.repeat(64 * 1024); for (let i = 0; i < 64; i++) process.stdout.write(chunk);"],
			process.cwd(),
			{ maxBuffer: 256 * 1024 },
		);

		expect(result.code).toBe(0);
		expect(result.stdoutTruncated).toBe(true);
		expect(result.stdout.length).toBeLessThanOrEqual(256 * 1024 + 64 * 1024);
		expect(result.stdout.endsWith("x")).toBe(true);
	});

	it("caps runaway stderr independently and flags truncation", async () => {
		const result = await execCommand(
			process.execPath,
			["-e", "const chunk = 'e'.repeat(64 * 1024); for (let i = 0; i < 64; i++) process.stderr.write(chunk);"],
			process.cwd(),
			{ maxBuffer: 256 * 1024 },
		);

		expect(result.code).toBe(0);
		expect(result.stderrTruncated).toBe(true);
		expect(result.stderr.length).toBeLessThanOrEqual(256 * 1024 + 64 * 1024);
	});

	it("returns complete output unchanged when under the buffer limit", async () => {
		const result = await execCommand(
			process.execPath,
			["-e", "process.stdout.write('hello stdout'); process.stderr.write('hello stderr');"],
			process.cwd(),
		);

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("hello stdout");
		expect(result.stderr).toBe("hello stderr");
		expect(result.stdoutTruncated).toBe(false);
		expect(result.stderrTruncated).toBe(false);
	});
});
