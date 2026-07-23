import { afterEach, describe, expect, it } from "vitest";
import type { OrchestrationExecutionPolicy } from "../src/core/orchestration/contracts.ts";
import { createRunProcessTool } from "../src/core/tools/run-process.ts";

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
	});
});
