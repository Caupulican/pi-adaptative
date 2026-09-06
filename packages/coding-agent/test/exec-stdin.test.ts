import { describe, expect, it } from "vitest";
import { execCommand } from "../src/core/exec.ts";

describe("bounded command stdin", () => {
	it("passes literal Unicode input through stdin, never shell arguments", async () => {
		const input = "synthetic é\r\n$(not-a-command)\0";
		const result = await execCommand(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], process.cwd(), {
			stdin: input,
			timeout: 2000,
		});
		expect(result).toMatchObject({ code: 0, killed: false, stdout: input, stdoutTruncated: false });
	});
	it("settles early child exit without leaking an unhandled broken-pipe error", async () => {
		const result = await execCommand(process.execPath, ["-e", "process.exit(7)"], process.cwd(), {
			stdin: "synthetic".repeat(100_000),
			timeout: 2000,
		});
		expect(result.code).toBe(7);
	});
	it("settles a missing executable with pending stdin", async () => {
		const result = await execCommand("pi-synthetic-nonexistent-codec", [], process.cwd(), {
			stdin: "synthetic",
			timeout: 2000,
		});
		expect(result.code).not.toBe(0);
		expect(result.errorMessage).toMatch(/ENOENT/);
	});
});
