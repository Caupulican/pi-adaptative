import { describe, expect, it, vi } from "vitest";
import { execCommand } from "../src/core/exec.ts";
import { ensurePythonRuntime, type PythonRuntimeOutcome } from "../src/core/python-runtime.ts";
import { createFileCodecRunner } from "../src/core/tools/file-codec-runner.ts";

vi.mock("../src/core/python-runtime.ts", () => ({ ensurePythonRuntime: vi.fn() }));
vi.mock("../src/core/exec.ts", () => ({ execCommand: vi.fn() }));

describe("codec provisioning cancellation", () => {
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
