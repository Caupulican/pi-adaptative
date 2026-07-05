import type { ModelFitnessReport } from "../research/model-fitness.ts";

/**
 * Fitness applicability doctrine: Class A autonomous adoption requires proof; Class B routed turns
 * are subtractive-only and pass unprobed models. Class C explicit user choices are deliberately not
 * selection-gated here. The `search` lane is probed and reported but has no selection-time consumer yet.
 */
export type FitnessGatedSurface =
	| "router_cheap"
	| "router_medium"
	| "router_expensive"
	| "router_judge"
	| "executor"
	| "curation"
	| "scout_auto";

export type FitnessGateVerdict =
	| { fit: true; probed: boolean }
	| { fit: false; reason: "unprobed" }
	| { fit: false; reason: "lane_failed"; lane: string; succeeded: number; total: number };

type FitnessLane = "research" | "worker" | "judge" | "toolCall" | "digest";

const CLASS_A_SURFACES = new Set<FitnessGatedSurface>(["executor", "curation", "scout_auto"]);

const SURFACE_LANES: Record<FitnessGatedSurface, readonly FitnessLane[]> = {
	router_cheap: ["research", "toolCall"],
	router_medium: ["worker", "toolCall"],
	router_expensive: ["worker", "toolCall"],
	router_judge: ["judge"],
	executor: ["toolCall"],
	curation: ["digest"],
	scout_auto: ["research", "toolCall"],
};

export function laneMeetsFitnessBar(succeeded: number, total: number): boolean {
	return total > 0 && succeeded >= Math.ceil(total * (2 / 3));
}

export function evaluateSurfaceFitness(
	surface: FitnessGatedSurface,
	report: ModelFitnessReport | undefined,
): FitnessGateVerdict {
	if (!report) {
		return CLASS_A_SURFACES.has(surface) ? { fit: false, reason: "unprobed" } : { fit: true, probed: false };
	}

	for (const lane of SURFACE_LANES[surface]) {
		if (lane === "judge") {
			const score = report.judge;
			if (!laneMeetsFitnessBar(score.parsed, score.total)) {
				return { fit: false, reason: "lane_failed", lane, succeeded: score.parsed, total: score.total };
			}
			continue;
		}
		const score = report[lane];
		if (!laneMeetsFitnessBar(score.succeeded, score.total)) {
			return { fit: false, reason: "lane_failed", lane, succeeded: score.succeeded, total: score.total };
		}
	}
	return { fit: true, probed: true };
}
