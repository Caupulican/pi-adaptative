import type { ThinkingLevel } from "@caupulican/pi-agent-core";
import { beforeAll, describe, expect, it } from "vitest";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

describe("extended thinking-level theme colors", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("uses the highest-intensity border color for max and ultra", () => {
		const xhigh = theme.getThinkingBorderColor("xhigh")("border");

		expect(theme.getThinkingBorderColor("max")("border")).toBe(xhigh);
		expect(theme.getThinkingBorderColor("ultra")("border")).toBe(xhigh);
	});

	// P1n: upstream (fbdd46389) makes colors.thinkingMax optional and resolves it via
	// withThemeColorFallbacks() as `thinkingMax ?? thinkingXhigh`. The local theme schema never
	// grew a separate thinkingMax/thinkingUltra token at all -- xhigh/max/ultra are documented
	// (ThemeJsonSchema, theme.ts) and switch-cased in getThinkingBorderColor() as permanently
	// sharing the single thinkingXhigh token, which is an equally-valid, simpler way to reach the
	// SAME observable fallback outcome the test above already pins. What upstream does not have,
	// and this codebase must never lose by silent shrinkage, is the "ultra" level itself: local
	// ThinkingLevel (packages/agent/src/types.ts) is a deliberate superset of upstream, adding
	// "ultra" above upstream's "max" ceiling. This guard fails two independent ways if that
	// superset is ever narrowed: the `satisfies`-style tuple assignment fails tsc (not just
	// vitest) if "max" or "ultra" is ever removed from the canonical ThinkingLevel union, and the
	// runtime loop fails if getThinkingBorderColor() ever stops explicitly handling one of them
	// (its `default` case silently resolves to thinkingOff, so a dropped `case` would show up as
	// an unexpected match against the "off" color instead of thinkingXhigh).
	it("never shrinks the local ThinkingLevel set below its upstream-superset shape (P1n guard)", () => {
		const allLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
		const typeGuard: readonly ThinkingLevel[] = allLevels;
		expect(typeGuard).toHaveLength(8);
		expect(allLevels).toContain("max");
		expect(allLevels).toContain("ultra");

		const offColor = theme.getThinkingBorderColor("off")("border");
		for (const level of allLevels) {
			const resolved = theme.getThinkingBorderColor(level)("border");
			expect(resolved).toBeTruthy();
			if (level !== "off") {
				expect(resolved).not.toBe(offColor);
			}
		}
	});
});
