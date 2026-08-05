import { describe, expect, it } from "vitest";
import {
	DEFAULT_WORKER_DELEGATION_MAX_USD,
	DEFAULT_WORKER_DELEGATION_MAX_WALL_CLOCK_MS,
	SettingsManager,
} from "../src/core/settings-manager.ts";

describe("worker delegation settings", () => {
	it("returns fully-defaulted values when nothing is configured", () => {
		const settingsManager = SettingsManager.inMemory();

		const resolved = settingsManager.getWorkerDelegationSettings();

		expect(resolved.enabled).toBe(true);
		expect(resolved.orchestrationProfile).toBeUndefined();
		expect(resolved.maxUsd).toBe(DEFAULT_WORKER_DELEGATION_MAX_USD);
		expect(resolved.maxWallClockMs).toBe(DEFAULT_WORKER_DELEGATION_MAX_WALL_CLOCK_MS);
		expect(resolved.writeEnabled).toBe(true);
		expect(resolved.writePaths).toEqual(["."]);
	});

	it("honors an explicit disable", () => {
		const settingsManager = SettingsManager.inMemory({
			workerDelegation: { enabled: false, writeEnabled: false, writePaths: [] },
		});

		expect(settingsManager.getWorkerDelegationSettings()).toMatchObject({
			enabled: false,
			writeEnabled: false,
			writePaths: [],
		});
	});

	it("honors configured values and falls back on invalid ones", () => {
		const settingsManager = SettingsManager.inMemory({
			workerDelegation: {
				enabled: true,
				orchestrationProfile: "cheap-worker",
				maxUsd: 1,
				maxWallClockMs: -5,
			},
		});

		const resolved = settingsManager.getWorkerDelegationSettings();

		expect(resolved.enabled).toBe(true);
		expect(resolved.orchestrationProfile).toBe("cheap-worker");
		expect(resolved.maxUsd).toBe(1);
		expect(resolved.maxWallClockMs).toBe(DEFAULT_WORKER_DELEGATION_MAX_WALL_CLOCK_MS);
	});

	it("accepts host scheduler budgets without legacy USD or one-hour ceilings", () => {
		const settingsManager = SettingsManager.inMemory({
			workerDelegation: {
				maxUsd: 25_000,
				maxWallClockMs: 7 * 24 * 60 * 60 * 1_000,
				maxConcurrent: 4_096,
			},
		});

		expect(settingsManager.getWorkerDelegationSettings()).toMatchObject({
			maxUsd: 25_000,
			maxWallClockMs: 604_800_000,
			maxConcurrent: 4_096,
		});
	});

	it("round-trips through setWorkerDelegationSettings", () => {
		const settingsManager = SettingsManager.inMemory();

		settingsManager.setWorkerDelegationSettings({ enabled: true, maxUsd: 0.25 });

		const resolved = settingsManager.getWorkerDelegationSettings();
		expect(resolved.enabled).toBe(true);
		expect(resolved.maxUsd).toBe(0.25);
	});
});
