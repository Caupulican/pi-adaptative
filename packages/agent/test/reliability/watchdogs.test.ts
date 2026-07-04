import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSilenceWatchdog } from "../../src/reliability/watchdogs.ts";

describe("createSilenceWatchdog", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("fires onSilence exactly once after silenceMs with no touches", () => {
		const onSilence = vi.fn();
		createSilenceWatchdog({ silenceMs: 1000, onSilence });
		vi.advanceTimersByTime(999);
		expect(onSilence).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(onSilence).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(5000);
		expect(onSilence).toHaveBeenCalledTimes(1);
	});

	it("touch resets the countdown", () => {
		const onSilence = vi.fn();
		const wd = createSilenceWatchdog({ silenceMs: 1000, onSilence });
		for (let i = 0; i < 10; i++) {
			vi.advanceTimersByTime(900);
			wd.touch();
		}
		expect(onSilence).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1000);
		expect(onSilence).toHaveBeenCalledTimes(1);
	});

	it("disarm prevents firing and makes touch a no-op", () => {
		const onSilence = vi.fn();
		const wd = createSilenceWatchdog({ silenceMs: 1000, onSilence });
		wd.disarm();
		vi.advanceTimersByTime(10_000);
		wd.touch();
		vi.advanceTimersByTime(10_000);
		expect(onSilence).not.toHaveBeenCalled();
	});
});
