import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrchestrationExecutionPolicy } from "../src/core/orchestration/contracts.ts";
import { createRunProcessTool, createRunProcessToolDefinition } from "../src/core/tools/run-process.ts";

const originalScoped = process.env.PI_RUN_PROCESS_TEST_VISIBLE;
const originalSecret = process.env.PI_RUN_PROCESS_TEST_SECRET;

function policy(overrides: Partial<OrchestrationExecutionPolicy> = {}): OrchestrationExecutionPolicy {
	return {
		allowedExecutables: [process.execPath],
		allowedEnvironmentVariables: ["PI_RUN_PROCESS_TEST_VISIBLE"],
		maxOutputBytes: 16 * 1024,
		...overrides,
	};
}

afterEach(() => {
	if (originalScoped === undefined) delete process.env.PI_RUN_PROCESS_TEST_VISIBLE;
	else process.env.PI_RUN_PROCESS_TEST_VISIBLE = originalScoped;
	if (originalSecret === undefined) delete process.env.PI_RUN_PROCESS_TEST_SECRET;
	else process.env.PI_RUN_PROCESS_TEST_SECRET = originalSecret;
});

describe("run_process", () => {
	it("passes argv literally without shell interpretation", async () => {
		const tool = createRunProcessTool(process.cwd(), { policy: policy(), maxWallClockMs: 5_000 });
		const result = await tool.execute("call-1", {
			executable: process.execPath,
			args: ["-e", "console.log(process.argv[1])", "literal; echo not-executed"],
		});

		expect(result.content[0]).toMatchObject({ type: "text" });
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("literal; echo not-executed");
		expect(result.details).toMatchObject({ outcome: "exited", exitCode: 0 });
	});

	it("passes only baseline and owner-allowed environment variables", async () => {
		process.env.PI_RUN_PROCESS_TEST_VISIBLE = "visible";
		process.env.PI_RUN_PROCESS_TEST_SECRET = "secret";
		const tool = createRunProcessTool(process.cwd(), { policy: policy(), maxWallClockMs: 5_000 });
		const result = await tool.execute("call-2", {
			executable: process.execPath,
			args: [
				"-e",
				"console.log((process.env.PI_RUN_PROCESS_TEST_VISIBLE ?? '') + ':' + (process.env.PI_RUN_PROCESS_TEST_SECRET ?? ''))",
			],
		});

		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("visible:");
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").not.toContain("secret");
	});

	it("rejects an executable outside the immutable profile allowlist before spawn", async () => {
		const tool = createRunProcessTool(process.cwd(), { policy: policy(), maxWallClockMs: 5_000 });
		await expect(tool.execute("call-3", { executable: "definitely-not-allowed", args: [] })).rejects.toThrow(
			"process_executable_denied",
		);
	});

	it("terminates a process when its bounded output allocation is exhausted", async () => {
		const tool = createRunProcessTool(process.cwd(), {
			policy: policy({ maxOutputBytes: 128 }),
			maxWallClockMs: 5_000,
		});
		const result = await tool.execute("call-4", {
			executable: process.execPath,
			args: ["-e", "process.stdout.write('x'.repeat(10000))"],
		});

		expect(result.details).toMatchObject({ outcome: "output_limit", truncated: true });
		expect(result.isError).toBe(true);
	});

	it("marks a non-zero process exit as a tool failure while retaining bounded diagnostics", async () => {
		const tool = createRunProcessTool(process.cwd(), { policy: policy(), maxWallClockMs: 5_000 });
		const result = await tool.execute("call-nonzero", {
			executable: process.execPath,
			args: ["-e", "process.stderr.write('repair marker'); process.exit(3)"],
		});

		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({ outcome: "failed", exitCode: 3 });
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("repair marker");
	});

	it("enforces the shared process-output ceiling even if an unchecked caller supplies a larger policy", async () => {
		const tool = createRunProcessTool(process.cwd(), {
			policy: policy({ maxOutputBytes: 2 * 1024 * 1024 }),
			maxWallClockMs: 5_000,
		});
		const result = await tool.execute("call-5", {
			executable: process.execPath,
			args: ["-e", "process.stdout.write('x'.repeat(600000))"],
		});

		expect(result.details).toMatchObject({ outcome: "output_limit", truncated: true });
	});

	it("rejects an oversized argv before invoking the process boundary", async () => {
		const spawn = vi.fn(() => {
			throw new Error("process boundary was invoked");
		});
		const tool = createRunProcessTool(process.cwd(), {
			policy: policy(),
			maxWallClockMs: 5_000,
			spawn,
		});

		await expect(
			tool.execute("call-6", {
				executable: process.execPath,
				args: Array.from({ length: 65 }, (_, index) => `arg-${index}`),
			}),
		).rejects.toThrow("process_argument_invalid");
		expect(spawn).not.toHaveBeenCalled();
	});

	it("keeps the owner executable catalog bounded in the model prompt", () => {
		const allowedExecutables = Array.from({ length: 64 }, (_, index) => `${index}-${"x".repeat(4_000)}`);
		const tool = createRunProcessToolDefinition(process.cwd(), {
			policy: policy({ allowedExecutables }),
			maxWallClockMs: 5_000,
		});

		expect(tool.description.length).toBeLessThanOrEqual(4_096);
	});

	it("rejects an invalid process deadline instead of silently running without one", () => {
		expect(() =>
			createRunProcessToolDefinition(process.cwd(), {
				policy: policy(),
				maxWallClockMs: Number.NaN,
			}),
		).toThrow("process_policy_invalid");
	});
});
