import { describe, expect, it } from "vitest";
import {
	DEFAULT_WORKER_DELEGATION_MAX_USD,
	DEFAULT_WORKER_DELEGATION_MAX_WALL_CLOCK_MS,
	InMemorySettingsStorage,
	SettingsManager,
} from "../src/core/settings-manager.ts";

describe("worker delegation settings", () => {
	it("returns fully-defaulted values when nothing is configured", () => {
		const settingsManager = SettingsManager.inMemory();

		const resolved = settingsManager.getWorkerDelegationSettings();

		// Ordinary delegation is unbounded unless the owner or an active profile supplies a ceiling.
		expect(DEFAULT_WORKER_DELEGATION_MAX_USD).toBe(0);
		expect(DEFAULT_WORKER_DELEGATION_MAX_WALL_CLOCK_MS).toBe(0);
		expect(resolved.enabled).toBe(true);
		expect(resolved.orchestrationProfile).toBeUndefined();
		expect(resolved.maxUsd).toBe(DEFAULT_WORKER_DELEGATION_MAX_USD);
		expect(resolved.maxWallClockMs).toBe(DEFAULT_WORKER_DELEGATION_MAX_WALL_CLOCK_MS);
		expect(resolved.maxConcurrent).toBe(20);
		expect(resolved.writeEnabled).toBe(true);
		expect("writePaths" in resolved).toBe(false);
	});

	it("keeps explicit 0 as the same unbounded policy as the omitted default", () => {
		const settingsManager = SettingsManager.inMemory({
			workerDelegation: { maxUsd: 0, maxWallClockMs: 0 },
		});

		const resolved = settingsManager.getWorkerDelegationSettings();

		expect(resolved.maxUsd).toBe(0);
		expect(resolved.maxWallClockMs).toBe(0);
		expect(settingsManager.drainErrors()).toEqual([]);
	});

	it("honors an explicit disable", () => {
		const settingsManager = SettingsManager.inMemory({
			workerDelegation: { enabled: false, writeEnabled: false },
		});

		expect(settingsManager.getWorkerDelegationSettings()).toMatchObject({
			enabled: false,
			writeEnabled: false,
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
		const diagnostics = settingsManager.drainErrors();
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.scope).toBe("global");
		expect(diagnostics[0]?.error.message).toContain("workerDelegation.maxWallClockMs");
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
		expect(settingsManager.drainErrors()).toEqual([]);
	});

	it("round-trips through setWorkerDelegationSettings", () => {
		const settingsManager = SettingsManager.inMemory();

		settingsManager.setWorkerDelegationSettings({ enabled: true, maxUsd: 0.25 });

		const resolved = settingsManager.getWorkerDelegationSettings();
		expect(resolved.enabled).toBe(true);
		expect(resolved.maxUsd).toBe(0.25);
	});

	it("ignores malformed project fields instead of defeating valid global restrictions", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({
				workerDelegation: {
					enabled: false,
					orchestrationProfile: "safe-worker",
					maxUsd: 2,
					maxWallClockMs: 240_000,
					writeEnabled: false,
					maxConcurrent: 2,
				},
			}),
		);
		storage.withLock("project", () =>
			JSON.stringify({
				workerDelegation: {
					enabled: "yes",
					orchestrationProfile: 42,
					maxUsd: -1,
					maxWallClockMs: 1.5,
					writeEnabled: "yes",
					maxConcurrent: 0,
				},
			}),
		);
		const settingsManager = SettingsManager.fromStorage(storage);

		expect(settingsManager.getWorkerDelegationSettings()).toEqual({
			enabled: false,
			orchestrationProfile: "safe-worker",
			maxUsd: 2,
			maxWallClockMs: 240_000,
			writeEnabled: false,
			maxConcurrent: 2,
		});
		const diagnostics = settingsManager.drainErrors();
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.scope).toBe("project");
		expect(diagnostics[0]?.error.message).toContain("workerDelegation.enabled");
	});

	it("drops a legacy writePaths field instead of retaining a dead scope owner", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ workerDelegation: { writePaths: ["legacy-scope"] } }));
		const settingsManager = SettingsManager.fromStorage(storage);

		expect("writePaths" in settingsManager.getWorkerDelegationSettings()).toBe(false);
		settingsManager.setWorkerDelegationSettings({ writeEnabled: true });
		await settingsManager.flush();

		let persisted: string | undefined;
		storage.withLock("global", (current) => {
			persisted = current;
			return undefined;
		});
		expect(JSON.parse(persisted ?? "{}").workerDelegation).toEqual({ writeEnabled: true });
	});
});
