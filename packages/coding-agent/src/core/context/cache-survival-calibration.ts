import type { SurvivalSettings } from "./cache-survival.ts";

/**
 * Survival estimator settings chosen by `node scripts/session-reuse-census.mjs --survival
 * --write-calibration <this file> <sessions>`: the grid point that best predicted held-out requests.
 * Generated; rerun the census to recalibrate.
 *
 * Evidence: 89 sessions, 3883 observations, held-out mse 0.1709 vs 0.1776 baseline, coverage 1.00.
 */
export const CACHE_SURVIVAL_CALIBRATION: SurvivalSettings = {
	halfLifeMs: 86400000,
	poolingWeight: 16,
	binsPerDecade: 2,
};
