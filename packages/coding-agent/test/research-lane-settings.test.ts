import { describe, expect, it } from "vitest";
import {
	DEFAULT_RESEARCH_LANE_IDLE_DELAY_MS,
	DEFAULT_RESEARCH_LANE_MAX_FINDINGS,
	DEFAULT_RESEARCH_LANE_MAX_RUNS_PER_SESSION,
	DEFAULT_RESEARCH_LANE_MAX_SOURCES,
	DEFAULT_RESEARCH_LANE_MAX_USD,
	DEFAULT_RESEARCH_LANE_MAX_WALL_CLOCK_MS,
	SettingsManager,
} from "../src/core/settings-manager.ts";

describe("research lane settings", () => {
	it("returns fully-defaulted values when nothing is configured", () => {
		const settingsManager = SettingsManager.inMemory();

		const resolved = settingsManager.getResearchLaneSettings();

		expect(resolved.enabled).toBe(false);
		expect(resolved.model).toBeUndefined();
		expect(resolved.maxUsd).toBe(DEFAULT_RESEARCH_LANE_MAX_USD);
		expect(resolved.maxSources).toBe(DEFAULT_RESEARCH_LANE_MAX_SOURCES);
		expect(resolved.maxFindings).toBe(DEFAULT_RESEARCH_LANE_MAX_FINDINGS);
		expect(resolved.maxWallClockMs).toBe(DEFAULT_RESEARCH_LANE_MAX_WALL_CLOCK_MS);
		expect(resolved.idleDelayMs).toBe(DEFAULT_RESEARCH_LANE_IDLE_DELAY_MS);
		expect(resolved.maxRunsPerSession).toBe(DEFAULT_RESEARCH_LANE_MAX_RUNS_PER_SESSION);
	});

	it("honors configured values within bounds", () => {
		const settingsManager = SettingsManager.inMemory({
			researchLane: {
				enabled: true,
				model: "anthropic/claude-haiku-4-5*",
				maxUsd: 0.5,
				maxSources: 4,
				maxFindings: 5,
				maxWallClockMs: 30_000,
				idleDelayMs: 1_000,
				maxRunsPerSession: 3,
			},
		});

		const resolved = settingsManager.getResearchLaneSettings();

		expect(resolved.enabled).toBe(true);
		expect(resolved.model).toBe("anthropic/claude-haiku-4-5*");
		expect(resolved.maxUsd).toBe(0.5);
		expect(resolved.maxSources).toBe(4);
		expect(resolved.maxFindings).toBe(5);
		expect(resolved.maxWallClockMs).toBe(30_000);
		expect(resolved.idleDelayMs).toBe(1_000);
		expect(resolved.maxRunsPerSession).toBe(3);
	});

	it("falls back to defaults for invalid or out-of-range values", () => {
		const settingsManager = SettingsManager.inMemory({
			researchLane: {
				enabled: true,
				model: "   ",
				maxUsd: -1,
				maxSources: 0,
				maxFindings: 999,
				maxWallClockMs: Number.NaN,
				idleDelayMs: -5,
				maxRunsPerSession: 10_000,
			},
		});

		const resolved = settingsManager.getResearchLaneSettings();

		expect(resolved.model).toBeUndefined();
		expect(resolved.maxUsd).toBe(DEFAULT_RESEARCH_LANE_MAX_USD);
		expect(resolved.maxSources).toBe(DEFAULT_RESEARCH_LANE_MAX_SOURCES);
		expect(resolved.maxFindings).toBe(DEFAULT_RESEARCH_LANE_MAX_FINDINGS);
		expect(resolved.maxWallClockMs).toBe(DEFAULT_RESEARCH_LANE_MAX_WALL_CLOCK_MS);
		expect(resolved.idleDelayMs).toBe(DEFAULT_RESEARCH_LANE_IDLE_DELAY_MS);
		expect(resolved.maxRunsPerSession).toBe(DEFAULT_RESEARCH_LANE_MAX_RUNS_PER_SESSION);
	});

	it("accepts fractional maxUsd values (number, not integer, sanitization)", () => {
		const settingsManager = SettingsManager.inMemory({ researchLane: { maxUsd: 0.05 } });
		expect(settingsManager.getResearchLaneSettings().maxUsd).toBe(0.05);
	});

	it("round-trips through setResearchLaneSettings", () => {
		const settingsManager = SettingsManager.inMemory();

		settingsManager.setResearchLaneSettings({ enabled: true, maxUsd: 1 });

		const resolved = settingsManager.getResearchLaneSettings();
		expect(resolved.enabled).toBe(true);
		expect(resolved.maxUsd).toBe(1);
		expect(resolved.maxFindings).toBe(DEFAULT_RESEARCH_LANE_MAX_FINDINGS);
	});
});
