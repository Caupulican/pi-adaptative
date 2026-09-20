import type { RouteSelectionSource } from "../autonomy/contracts.ts";
import type { ModelRouterPoolPreference, ModelRouterSelectionMode } from "../settings-manager.ts";
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
	/** The pin resolves outside a customized pool: it still wins, and it routes outside the pool. */
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
	switch (selection) {
		case "hmoe":
			return "router/H-MoE";
		case "auto":
			return "router";
		case "manual":
			return "manual pin";
		default:
			return "none";
	}
}

export function formatRoutePreview(preview: RoutePreview): string {
	const lines = [
		`Intent: ${preview.intent}`,
		`Baseline tier: ${preview.baselineTier}`,
		`Risk: ${preview.risk}`,
		`Reason: ${preview.reasonCode}`,
		`Selection mode: ${preview.selectionMode.toUpperCase()}`,
		`Manual pin: ${preview.manualPin ?? "none"}`,
		`Pool: ${preview.pool.customized ? `${preview.pool.count} selected (${formatRouterPoolSourceLabel(preview.pool.source)})` : `all enabled (${preview.pool.count})`}`,
		`Pool preference: ${preview.poolPreference}`,
		`Subscription candidates: ${preview.subscriptionCandidates}`,
		`Eligible candidates: ${preview.eligibleCandidates}`,
		`Would choose: ${preview.chosenModel ?? "no model (turn stays on the session model)"}`,
		`Source: ${formatRouteSelectionSource(preview.selection)}`,
	];
	if (preview.manualPinOutsidePool) {
		lines.push("Pool exception: the manual pin is outside the candidate pool; the pin wins and routes outside it.");
	}
	if (preview.fitness) lines.push(`Fitness: ${preview.fitness}`);
	if (preview.skipReason) lines.push(`Skip reason: ${preview.skipReason}`);
	if (preview.candidates.length > 0) {
		lines.push("Candidates:");
		for (const candidate of preview.candidates) lines.push(`- ${candidate}`);
	}
	lines.push("Deterministic preview: no provider call was made and the session model is unchanged.");
	return lines.join("\n");
}

export function formatLiveRoutePreview(preview: LiveRoutePreview): string {
	const lines = [
		`Chosen tier: ${preview.tier}`,
		`Risk: ${preview.risk}`,
		`Reason: ${preview.reasonCode}`,
		`Chosen model: ${preview.chosenModel ?? "no model (turn stays on the session model)"}`,
		`Source: ${formatRouteSelectionSource(preview.selection)}`,
		`Preference: ${preview.poolPreference}`,
	];
	if (preview.fitness) lines.push(`Fitness: ${preview.fitness}`);
	if (preview.skipReason) lines.push(`Skip reason: ${preview.skipReason}`);
	if (preview.reasons.length > 0) {
		lines.push("Reasons:");
		for (const reason of preview.reasons) lines.push(`- ${reason}`);
	}
	lines.push("Live preview: the routing judge/H-MoE may have run; the session model is unchanged.");
	return lines.join("\n");
}
