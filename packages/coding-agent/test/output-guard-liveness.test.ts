import { afterEach, describe, expect, it, vi } from "vitest";
import {
	restoreStdout,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../src/core/output-guard.ts";

describe("raw stdout liveness", () => {
	afterEach(() => {
		restoreStdout();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("rejects a flush when the underlying write callback never arrives", async () => {
		vi.useFakeTimers();
		const originalWrite = process.stdout.write;
		const hangingWrite = vi.fn(() => true) as unknown as typeof process.stdout.write;
		process.stdout.write = hangingWrite;
		const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
		try {
			takeOverStdout();
			writeRawStdout("terminal frame");
			const flush = waitForRawStdoutBackpressure();
			const rejection = expect(flush).rejects.toThrow("stdout write callback timed out after 5000ms");

			await vi.advanceTimersByTimeAsync(5_001);

			await rejection;
			expect(exit).toHaveBeenCalledWith(1);
		} finally {
			restoreStdout();
			process.stdout.write = originalWrite;
		}
	});
});
