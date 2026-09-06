import { describe, expect, it, vi } from "vitest";
import { execCommand } from "../src/core/exec.ts";
import { ensurePythonRuntime, type PythonRuntimeOutcome } from "../src/core/python-runtime.ts";
import { createFileCodecRunner } from "../src/core/tools/file-codec-runner.ts";

vi.mock("../src/core/python-runtime.ts", () => ({ ensurePythonRuntime: vi.fn() }));
vi.mock("../src/core/exec.ts", () => ({ execCommand: vi.fn() }));

describe("codec provisioning cancellation", () => {
	it.each([false, true])(
		"reports converter availability only from complete helper evidence: truncated=%s",
		async (truncated) => {
			vi.mocked(ensurePythonRuntime).mockResolvedValue({
				status: "ready",
				pythonPath: "/synthetic/python",
				uvPath: "/synthetic/uv",
				pythonInstalled: false,
			});
			vi.mocked(execCommand).mockResolvedValue({
				code: 1,
				killed: false,
				stdoutTruncated: truncated,
				stderrTruncated: false,
				stdout: '{"error":"codec_unavailable"}',
				stderr: "",
			});
			const run = await createFileCodecRunner();
			await expect(run({ operation: "decode", encoding: "X-FIXTURE", source: "" })).rejects.toThrow(
				truncated ? /could not verify preservation/ : /iconv is unavailable/,
			);
			vi.mocked(execCommand).mockClear();
		},
	);

	it("detaches the canceled caller without waiting for or canceling shared provisioning", async () => {
		const ready = Promise.withResolvers<PythonRuntimeOutcome>();
		vi.mocked(ensurePythonRuntime).mockReturnValue(ready.promise);
		const controller = new AbortController();
		let canceled = false;
		const first = createFileCodecRunner(controller.signal).catch(() => {
			canceled = true;
		});
		const second = createFileCodecRunner();
		controller.abort();
		// Flush only microtasks: the provisioning promise deliberately remains unresolved.
		for (let step = 0; step < 20; step++) await Promise.resolve();
		const detachedBeforeReady = canceled;
		ready.resolve({
			status: "ready",
			pythonPath: "/synthetic/python",
			uvPath: "/synthetic/uv",
			pythonInstalled: false,
		});
		await first;
		expect(typeof (await second)).toBe("function");
		expect(detachedBeforeReady).toBe(true);
		expect(execCommand).not.toHaveBeenCalled();
	});
});
