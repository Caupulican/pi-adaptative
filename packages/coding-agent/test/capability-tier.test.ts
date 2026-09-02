import { describe, expect, it } from "vitest";
import {
	CAPABILITY_TIER_DEMOTION_TTL_MS,
	capabilityTierPolicy,
	isCapabilityTierDemotion,
	resolveCapabilityTier,
} from "../src/core/capability-tier.ts";

describe("capability tier", () => {
	it("keeps the full class on the frontier tier until evidence demotes it, and lets the demotion expire", () => {
		const now = new Date("2026-09-02T12:00:00Z");
		expect(resolveCapabilityTier({ capabilityClass: "full", now })).toBe("frontier");
		const demotion = { tier: "strong" as const, reason: "runaway_stop", at: "2026-09-02T11:00:00Z" };
		expect(resolveCapabilityTier({ capabilityClass: "full", demotion, now })).toBe("strong");
		const expired = new Date(now.getTime() + CAPABILITY_TIER_DEMOTION_TTL_MS + 1);
		expect(resolveCapabilityTier({ capabilityClass: "full", demotion, now: expired })).toBe("frontier");
		expect(resolveCapabilityTier({ capabilityClass: "full", demotion: { ...demotion, at: "garbage" }, now })).toBe(
			"frontier",
		);
	});

	it("maps every non-full class to constrained regardless of evidence", () => {
		for (const capabilityClass of ["lean", "minimal", "chat"] as const) {
			expect(resolveCapabilityTier({ capabilityClass })).toBe("constrained");
		}
	});

	it("tightens caps and guards down the ladder without turning any feature off above constrained", () => {
		const frontier = capabilityTierPolicy("frontier");
		const strong = capabilityTierPolicy("strong");
		const constrained = capabilityTierPolicy("constrained");
		expect(frontier.pathAliasing).toBe(true);
		expect(strong.pathAliasing).toBe(true);
		expect(constrained.pathAliasing).toBe(false);
		expect(frontier.maxOutputTokens).toBeGreaterThan(strong.maxOutputTokens);
		expect(strong.maxOutputTokens).toBeGreaterThan(constrained.maxOutputTokens);
		expect(frontier.repetitionGuardRepeats).toBeGreaterThan(strong.repetitionGuardRepeats);
		expect(strong.repetitionGuardRepeats).toBeGreaterThanOrEqual(constrained.repetitionGuardRepeats);
		expect(frontier.skillBodyMaxBytes).toBeGreaterThan(strong.skillBodyMaxBytes);
		expect(constrained.protocolProse).toBe("full");
	});

	it("validates a stored demotion record", () => {
		expect(isCapabilityTierDemotion({ tier: "strong", reason: "runaway_stop", at: "2026-09-02T11:00:00Z" })).toBe(
			true,
		);
		expect(isCapabilityTierDemotion({ tier: "frontier", reason: "x", at: "y" })).toBe(false);
		expect(isCapabilityTierDemotion(null)).toBe(false);
	});
});
