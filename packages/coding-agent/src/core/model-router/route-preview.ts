import type { RouteSelectionSource } from "../autonomy/contracts.ts";
import { interfaceText } from "../language/interface-text.ts";
import type { ModelRouterPoolPreference, ModelRouterSelectionMode } from "../settings/settings-schema.ts";
import { formatRouterPoolSourceLabel, type RouterPoolSource } from "./candidate-pool.ts";
import type { ModelRouterIntent } from "./intent-classifier.ts";

/**
 * Deterministic route preview: what the router would decide for an example task without any
 * provider call. Inspection only — it never mutates the session model or the router's sticky
 * status state.
 */
export interface RoutePreview {
	readonly intent: ModelRouterIntent;
	readonly baselineTier: string;
	readonly risk: string;
	readonly reasonCode: string;
	readonly selectionMode: ModelRouterSelectionMode;
	readonly poolPreference: ModelRouterPoolPreference;
	/** The operator's pin for the baseline tier, when that tier is not auto-selected. */
	readonly manualPin?: string;
	/** The configured pin is excluded by live router eligibility. */
	readonly manualPinOutsidePool?: boolean;
	readonly pool: { readonly customized: boolean; readonly count: number; readonly source: RouterPoolSource };
	readonly subscriptionCandidates: number;
	readonly eligibleCandidates: number;
	readonly chosenModel?: string;
	readonly selection?: RouteSelectionSource;
	readonly fitness?: string;
	/** Why no model resolves, when none does. */
	readonly skipReason?: string;
	/** Candidate lines (auto tiers only), bounded for display. */
	readonly candidates: readonly string[];
}

/** Live preview: the same path a real turn takes (judge, H-MoE), still without executing anything. */
export interface LiveRoutePreview {
	readonly tier: string;
	readonly risk: string;
	readonly reasonCode: string;
	readonly chosenModel?: string;
	readonly selection?: RouteSelectionSource;
	readonly poolPreference: ModelRouterPoolPreference;
	readonly fitness?: string;
	readonly reasons: readonly string[];
	readonly skipReason?: string;
}

export function formatRouteSelectionSource(selection: RouteSelectionSource | undefined): string {
	const words = interfaceText().localModels.routerSetup.preview;
	switch (selection) {
		case "hmoe":
			return "router/H-MoE";
		case "system_one":
			return "router/System One";
		case "auto":
			return "router";
		case "manual":
			return words.sourceManualPin;
		default:
			return words.none;
	}
}

export function formatRoutePreview(preview: RoutePreview): string {
	const words = interfaceText().localModels.routerSetup.preview;
	const lines = [
		words.intent(preview.intent),
		words.baselineTier(preview.baselineTier),
		words.risk(preview.risk),
		words.reason(preview.reasonCode),
		words.selectionMode(preview.selectionMode.toUpperCase()),
		words.manualPin(preview.manualPin ?? words.none),
		preview.pool.customized
			? words.poolSelected(preview.pool.count, formatRouterPoolSourceLabel(preview.pool.source))
			: words.poolFavorites(preview.pool.count),
		words.poolPreference(preview.poolPreference),
		words.subscriptionCandidates(preview.subscriptionCandidates),
		words.eligibleCandidates(preview.eligibleCandidates),
		words.wouldChoose(preview.chosenModel ?? words.noModel),
		words.source(formatRouteSelectionSource(preview.selection)),
	];
	if (preview.manualPinOutsidePool) {
		lines.push(words.excludedPin);
	}
	if (preview.fitness) lines.push(words.fitness(preview.fitness));
	if (preview.skipReason) lines.push(words.skipReason(preview.skipReason));
	if (preview.candidates.length > 0) {
		lines.push(words.candidates);
		for (const candidate of preview.candidates) lines.push(`- ${candidate}`);
	}
	lines.push(words.deterministic);
	return lines.join("\n");
}

export function formatLiveRoutePreview(preview: LiveRoutePreview): string {
	const words = interfaceText().localModels.routerSetup.preview;
	const lines = [
		words.chosenTier(preview.tier),
		words.risk(preview.risk),
		words.reason(preview.reasonCode),
		words.chosenModel(preview.chosenModel ?? words.noModel),
		words.source(formatRouteSelectionSource(preview.selection)),
		words.preference(preview.poolPreference),
	];
	if (preview.fitness) lines.push(words.fitness(preview.fitness));
	if (preview.skipReason) lines.push(words.skipReason(preview.skipReason));
	if (preview.reasons.length > 0) {
		lines.push(words.reasons);
		for (const reason of preview.reasons) lines.push(`- ${reason}`);
	}
	lines.push(words.live);
	return lines.join("\n");
}
