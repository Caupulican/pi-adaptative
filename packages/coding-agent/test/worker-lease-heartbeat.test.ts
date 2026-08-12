import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerLeaseHeartbeat } from "../src/core/delegation/worker-lease-heartbeat.ts";

afterEach(() => {
	vi.useRealTimers();
});

describe("WorkerLeaseHeartbeat", () => {
	it("renews before expiry and stops without leaving a live timer", () => {
		vi.useFakeTimers();
		const renew = vi.fn();
		const heartbeat = new WorkerLeaseHeartbeat({
			leaseTtlMs: 900,
			renew,
			onFailure: vi.fn(),
		});

		heartbeat.start();
		vi.advanceTimersByTime(299);
		expect(renew).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(renew).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(600);
		expect(renew).toHaveBeenCalledTimes(3);

		heartbeat.stop();
		vi.advanceTimersByTime(900);
		expect(renew).toHaveBeenCalledTimes(3);
	});

	it("stops and exposes the first renewal failure", () => {
		vi.useFakeTimers();
		const failure = new Error("lease persistence unavailable");
		const onFailure = vi.fn();
		const heartbeat = new WorkerLeaseHeartbeat({
			leaseTtlMs: 900,
			renew: vi.fn(() => {
				throw failure;
			}),
			onFailure,
		});

		heartbeat.start();
		vi.advanceTimersByTime(300);

		expect(onFailure).toHaveBeenCalledExactlyOnceWith(failure);
		expect(() => heartbeat.assertHealthy()).toThrow(failure);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("caps unbounded lease intervals at the host timer ceiling", () => {
		vi.useFakeTimers();
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const heartbeat = new WorkerLeaseHeartbeat({
			leaseTtlMs: Number.MAX_SAFE_INTEGER,
			renew: vi.fn(),
			onFailure: vi.fn(),
		});

		heartbeat.start();

		expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 2_147_483_647);
		heartbeat.stop();
	});
});
