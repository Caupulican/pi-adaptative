import { fauxAssistantMessage } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { getInFlightWorkUnits } from "../src/core/reload-blockers.ts";
import { FileMutationIntentController } from "../src/core/tools/file-mutation-intent.ts";
import { createHarness } from "./suite/harness.ts";

const WORKER_RESULT = JSON.stringify({
	summary: "Worker completed without retaining lane payloads.",
	status: "completed",
	findings: [],
});

describe("worker payload cleanup lifecycle", () => {
	it("keeps the worker registered as in-flight until lane-owned payload cleanup finishes", async () => {
		const harness = await createHarness();
		let releaseCleanup: (() => void) | undefined;
		const cleanupGate = new Promise<void>((resolve) => {
			releaseCleanup = resolve;
		});
		let markCleanupEntered: (() => void) | undefined;
		const cleanupEntered = new Promise<void>((resolve) => {
			markCleanupEntered = resolve;
		});
		const originalDispose = FileMutationIntentController.prototype.dispose;
		const disposeSpy = vi.spyOn(FileMutationIntentController.prototype, "dispose").mockImplementation(async function (
			this: FileMutationIntentController,
		) {
			markCleanupEntered?.();
			await cleanupGate;
			await originalDispose.call(this);
		});
		let run: Promise<unknown> | undefined;

		try {
			harness.setResponses([fauxAssistantMessage(WORKER_RESULT)]);
			run = harness.session.runWorkerDelegationOnce({ instructions: "Complete one bounded worker task." });
			await cleanupEntered;

			expect(
				getInFlightWorkUnits(harness.tempDir).some(
					(unit) => unit.kind === "lane" && unit.label.startsWith("worker:"),
				),
			).toBe(true);

			releaseCleanup?.();
			await run;
			expect(getInFlightWorkUnits(harness.tempDir).some((unit) => unit.label.startsWith("worker:"))).toBe(false);
		} finally {
			releaseCleanup?.();
			await run?.catch(() => {});
			disposeSpy.mockRestore();
			harness.cleanup();
		}
	});
});
