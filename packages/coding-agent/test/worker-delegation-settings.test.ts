import { describe, expect, it } from "vitest";
import { MAX_WORKER_AUTHORITY_PATH_LENGTH, MAX_WORKER_AUTHORITY_PATHS } from "../src/core/orchestration/contracts.ts";
import {
	DEFAULT_WORKER_DELEGATION_MAX_USD,
	DEFAULT_WORKER_DELEGATION_MAX_WALL_CLOCK_MS,
	InMemorySettingsStorage,
	SettingsManager,
	type WorkerDelegationSettings,
} from "../src/core/settings-manager.ts";

describe("worker delegation settings", () => {
	it("returns fully-defaulted values when nothing is configured", () => {
		const settingsManager = SettingsManager.inMemory();

		const resolved = settingsManager.getWorkerDelegationSettings();

		expect(resolved.enabled).toBe(true);
		expect(resolved.orchestrationProfile).toBeUndefined();
		expect(resolved.maxUsd).toBe(DEFAULT_WORKER_DELEGATION_MAX_USD);
		expect(resolved.maxWallClockMs).toBe(DEFAULT_WORKER_DELEGATION_MAX_WALL_CLOCK_MS);
		expect(resolved.maxConcurrent).toBe(20);
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
					writePaths: ["src"],
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
					writePaths: ".",
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
			writePaths: ["src"],
			maxConcurrent: 2,
		});
		const diagnostics = settingsManager.drainErrors();
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.scope).toBe("project");
		expect(diagnostics[0]?.error.message).toContain("workerDelegation.enabled");
		expect(diagnostics[0]?.error.message).toContain("workerDelegation.writePaths");
	});

	it("canonicalizes and bounds persisted write scopes", () => {
		const configuredPaths = [
			" src ",
			"src",
			"",
			"x".repeat(MAX_WORKER_AUTHORITY_PATH_LENGTH + 1),
			...Array.from({ length: MAX_WORKER_AUTHORITY_PATHS + 2 }, (_, index) => `path-${index}`),
		];
		const settingsManager = SettingsManager.inMemory({
			workerDelegation: { writePaths: configuredPaths },
		});

		const resolved = settingsManager.getWorkerDelegationSettings();
		expect(resolved.writePaths).toHaveLength(MAX_WORKER_AUTHORITY_PATHS);
		expect(resolved.writePaths[0]).toBe("src");
		expect(new Set(resolved.writePaths).size).toBe(resolved.writePaths.length);
		expect(resolved.writePaths.every((path) => path.length <= MAX_WORKER_AUTHORITY_PATH_LENGTH)).toBe(true);
		expect(settingsManager.drainErrors()[0]?.error.message).toContain("workerDelegation.writePaths");
	});

	it("does not retain mutable write-path input from a settings update", () => {
		const settingsManager = SettingsManager.inMemory();
		const update: WorkerDelegationSettings = { writeEnabled: true, writePaths: ["src"] };

		settingsManager.setWorkerDelegationSettings(update);
		update.writePaths![0] = "../outside";

		expect(settingsManager.getWorkerDelegationSettings().writePaths).toEqual(["src"]);
	});

	it("canonicalizes settings updates before persisting them", async () => {
		const storage = new InMemorySettingsStorage();
		const settingsManager = SettingsManager.fromStorage(storage);

		settingsManager.setWorkerDelegationSettings({
			maxUsd: -1,
			maxWallClockMs: 1.5,
			writePaths: [" src ", "", "x".repeat(MAX_WORKER_AUTHORITY_PATH_LENGTH + 1)],
			maxConcurrent: 0,
		});
		await settingsManager.flush();

		let persisted: string | undefined;
		storage.withLock("global", (current) => {
			persisted = current;
			return undefined;
		});
		expect(JSON.parse(persisted ?? "{}").workerDelegation).toEqual({ writePaths: ["src"] });
	});

	it("reapplies normalized scope precedence after reload", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({ workerDelegation: { enabled: false, writeEnabled: false, writePaths: ["src"] } }),
		);
		storage.withLock("project", () =>
			JSON.stringify({ workerDelegation: { enabled: true, writeEnabled: true, writePaths: ["project"] } }),
		);
		const settingsManager = SettingsManager.fromStorage(storage);
		expect(settingsManager.getWorkerDelegationSettings()).toMatchObject({
			enabled: true,
			writeEnabled: true,
			writePaths: ["project"],
		});
		expect(settingsManager.drainErrors()).toEqual([]);

		storage.withLock("project", () =>
			JSON.stringify({ workerDelegation: { enabled: "invalid", writeEnabled: "invalid", writePaths: "project" } }),
		);
		await settingsManager.reload();

		expect(settingsManager.getWorkerDelegationSettings()).toMatchObject({
			enabled: false,
			writeEnabled: false,
			writePaths: ["src"],
		});
		const diagnostics = settingsManager.drainErrors();
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.scope).toBe("project");
		expect(diagnostics[0]?.error.message).toContain("workerDelegation.writeEnabled");
	});
});
