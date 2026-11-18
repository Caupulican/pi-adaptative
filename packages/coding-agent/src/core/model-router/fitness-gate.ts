import type { FitnessReportLookup } from "../models/fitness-store.ts";
import type { ModelFitnessReport } from "../research/model-fitness.ts";
import type { ModelRouterFitnessStatuses, ModelRouterStatusSettings } from "./status.ts";

/**
 * Fitness applicability doctrine: Class A autonomous adoption requires proof; Class B routed turns
 * are subtractive-only and pass unprobed models. Compaction is always-on subtractive composition:
 * digest-failed probed cheap summarizers fall back, while unprobed models pass. Class C explicit
 * user choices are deliberately not selection-gated here. The `search` lane is probed and reported
 * but has no selection-time consumer yet.
 */
export type FitnessGatedSurface =
	| "compaction"
	| "router_cheap"
	| "router_medium"
	| "router_expensive"
	| "executor"
	| "curation"
	| "scout_auto";

export type FitnessGateVerdict =
	| { fit: true; probed: boolean }
	| { fit: false; reason: "unprobed" }
	| { fit: false; reason: "lane_failed"; lane: string; succeeded: number; total: number };

type FitnessLane = "research" | "worker" | "toolCall" | "digest";

const CLASS_A_SURFACES = new Set<FitnessGatedSurface>(["executor", "curation", "scout_auto"]);

const SURFACE_LANES: Record<FitnessGatedSurface, readonly FitnessLane[]> = {
	compaction: ["digest"],
	router_cheap: ["research", "toolCall"],
	router_medium: ["worker", "toolCall"],
	router_expensive: ["worker", "toolCall"],
	executor: ["toolCall"],
	curation: ["digest"],
	scout_auto: ["research", "toolCall"],
};

export function laneMeetsFitnessBar(succeeded: number, total: number): boolean {
	return total > 0 && succeeded >= Math.ceil(total * (2 / 3));
}

function unprobedVerdict(surface: FitnessGatedSurface): FitnessGateVerdict {
	return CLASS_A_SURFACES.has(surface) ? { fit: false, reason: "unprobed" } : { fit: true, probed: false };
}

export function evaluateSurfaceFitness(
	surface: FitnessGatedSurface,
	report: ModelFitnessReport | undefined,
): FitnessGateVerdict {
	if (!report) return unprobedVerdict(surface);

	for (const lane of SURFACE_LANES[surface]) {
		const score = report[lane];
		if (!score) return unprobedVerdict(surface);
		if (!laneMeetsFitnessBar(score.succeeded, score.total)) {
			return { fit: false, reason: "lane_failed", lane, succeeded: score.succeeded, total: score.total };
		}
	}
	return { fit: true, probed: true };
}

type RouterFitnessTier = keyof ModelRouterFitnessStatuses;

export function routerSurfaceForTier(tier: RouterFitnessTier): FitnessGatedSurface {
	return tier === "cheap" ? "router_cheap" : tier === "medium" ? "router_medium" : "router_expensive";
}

export function evaluateModelFitness(
	surface: FitnessGatedSurface,
	model: { provider: string; id: string },
	fitness: FitnessReportLookup,
): FitnessGateVerdict {
	return evaluateSurfaceFitness(surface, fitness(`${model.provider}/${model.id}`));
}

export function formatFitnessFailure(verdict: Exclude<FitnessGateVerdict, { fit: true }>): string {
	return verdict.reason === "unprobed" ? "unprobed" : `${verdict.lane} ${verdict.succeeded}/${verdict.total}`;
}

export function formatFitnessVerdict(verdict: FitnessGateVerdict): string {
	if (verdict.fit) return verdict.probed ? "fit" : "unprobed";
	return verdict.reason === "unprobed" ? "unprobed" : `unfit (${formatFitnessFailure(verdict)})`;
}

export function collectRouterTierFitnessStatuses(
	settings: Pick<ModelRouterStatusSettings, "cheapModel" | "mediumModel" | "expensiveModel">,
	fitness: FitnessReportLookup,
	resolveAccessibleModel: (pattern: string) => { provider: string; id: string } | undefined,
): ModelRouterFitnessStatuses {
	const statuses: ModelRouterFitnessStatuses = {};
	for (const tier of ["cheap", "medium", "expensive"] as const) {
		const pattern = settings[`${tier}Model`];
		if (!pattern) continue;
		const model = resolveAccessibleModel(pattern);
		if (!model) continue;
		const verdict = evaluateModelFitness(routerSurfaceForTier(tier), model, fitness);
		statuses[tier] = verdict.fit
			? { status: verdict.probed ? "fit" : "unprobed" }
			: verdict.reason === "unprobed"
				? { status: "unprobed" }
				: { status: "unfit", lane: verdict.lane, succeeded: verdict.succeeded, total: verdict.total };
	}
	return statuses;
}
