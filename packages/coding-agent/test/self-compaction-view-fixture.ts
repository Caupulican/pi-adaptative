import {
	DEFAULT_SELF_COMPACTION_SETTINGS,
	resolveSelfCompactionThresholds,
} from "../src/core/compaction/self-compaction.ts";
import type { SelfCompactionView } from "../src/core/compaction/self-compaction-controller.ts";

const thresholds = resolveSelfCompactionThresholds(200_000, 180_000, 120_000, DEFAULT_SELF_COMPACTION_SETTINGS)!;

export function gaugeView(overrides: Partial<SelfCompactionView> = {}): SelfCompactionView {
	return {
		enabled: true,
		settingsError: null,
		level: "warning",
		phase: "warning",
		cycles: 0,
		usedTokens: 110_000,
		cachedTokens: 60_000,
		usedPercent: 55,
		contextWindow: 200_000,
		thresholds,
		tokensUntilWarning: 0,
		tokensUntilForced: thresholds.forcedTokens - 110_000,
		toolsLocked: false,
		handoff: { status: "none", attempts: 0, noteChars: null, lastError: null, ownerRequested: false },
		...overrides,
	};
}
