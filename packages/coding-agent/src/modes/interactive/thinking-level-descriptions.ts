import type { ThinkingLevel } from "@caupulican/pi-agent-core";

/** Provider-neutral labels shared by every interactive thinking-level selector. */
export const THINKING_LEVEL_DESCRIPTIONS: Readonly<Record<ThinkingLevel, string>> = {
	off: "No reasoning",
	minimal: "Very brief reasoning (~1k tokens)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Maximum reasoning (~32k tokens)",
	max: "Maximum reasoning depth for the hardest problems",
	ultra: "Maximum available reasoning effort (provider permitting)",
};
