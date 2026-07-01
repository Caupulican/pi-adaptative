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

		expect(resolved.enabled).toBe(false);
		expect(resolved.model).toBeUndefined();
		expect(resolved.maxUsd).toBe(DEFAULT_WORKER_DELEGATION_MAX_USD);
		expect(resolved.maxWallClockMs).toBe(DEFAULT_WORKER_DELEGATION_MAX_WALL_CLOCK_MS);
	});

	it("honors configured values and falls back on invalid ones", () => {
		const settingsManager = SettingsManager.inMemory({
			workerDelegation: { enabled: true, model: "anthropic/claude-haiku-4-5*", maxUsd: 1, maxWallClockMs: -5 },
		});

		const resolved = settingsManager.getWorkerDelegationSettings();

		expect(resolved.enabled).toBe(true);
		expect(resolved.model).toBe("anthropic/claude-haiku-4-5*");
		expect(resolved.maxUsd).toBe(1);
		expect(resolved.maxWallClockMs).toBe(DEFAULT_WORKER_DELEGATION_MAX_WALL_CLOCK_MS);
	});

	it("round-trips through setWorkerDelegationSettings", () => {
		const settingsManager = SettingsManager.inMemory();

		settingsManager.setWorkerDelegationSettings({ enabled: true, maxUsd: 0.25 });

		const resolved = settingsManager.getWorkerDelegationSettings();
		expect(resolved.enabled).toBe(true);
		expect(resolved.maxUsd).toBe(0.25);
	});
});
