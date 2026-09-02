/**
 * Stateful foreground cost-guard owner.
 *
 * The controller brackets each ordinary foreground turn, projects the exact provider request once
 * routing and context shaping are complete, and retains only the latest UI decision. AgentSession
 * coordinates the turn; it does not own cost accounting or request-reasoning policy.
 */

import type { Api, Context, Model, SimpleStreamOptions } from "@caupulican/pi-ai";
import { getSupportedThinkingLevels } from "@caupulican/pi-ai/models";
import {
	type CostGuardDecision,
	type CostGuardSettings,
	downgradeReasoning,
	estimateTurnCostUsd,
	evaluateCostGuard,
} from "./cost-guard.ts";
import { estimateContextPromptTokens } from "./models/perf-profile.ts";

export interface CostGuardControllerDeps {
	getSettings(): CostGuardSettings;
	getCompactionReserveTokens(): number;
	getSpawnedUsageCost(): number;
	isUnmeteredSubscription(model: Model<Api>): boolean;
}

export class CostGuardController {
	private readonly deps: CostGuardControllerDeps;
	private lastDecision: CostGuardDecision | undefined;
	private turnBaselineUsd = 0;

	constructor(deps: CostGuardControllerDeps) {
		this.deps = deps;
	}

	/** Snapshot cumulative spawned spend before any work in a new foreground turn begins. */
	beginForegroundTurn(): void {
		this.turnBaselineUsd = this.deps.getSpawnedUsageCost();
	}

	/** Latest decision for the host UI. Disabled settings hide and invalidate prior projections. */
	getLastDecision(): CostGuardDecision | undefined {
		return this.deps.getSettings().enabled ? this.lastDecision : undefined;
	}

	/** A settings transition invalidates the prior decision before another request is projected. */
	invalidateDecision(): void {
		this.lastDecision = undefined;
	}

	/** Active threshold projected into the foreground capability envelope. */
	getEnabledMaxTurnUsd(): number | undefined {
		const settings = this.deps.getSettings();
		return settings.enabled ? settings.maxTurnUsd : undefined;
	}

	/**
	 * Resolve cost policy after routing/context conversion reveals the real request. This projection
	 * is not an output cap; warning mode preserves capability and downgrade changes only this request.
	 * Background spend is turn-local: cumulative spawned usage minus the baseline captured by
	 * {@link beginForegroundTurn}. Per-lane dollar caps remain independent. Best-effort: never throws.
	 */
	resolveRequestReasoning(
		model: Model<Api>,
		context: Context,
		reasoning: SimpleStreamOptions["reasoning"],
		requestMaxTokens: number | undefined,
	): SimpleStreamOptions["reasoning"] {
		try {
			const guard = this.deps.getSettings();
			if (!guard.enabled || guard.maxTurnUsd <= 0 || !model.cost || this.deps.isUnmeteredSubscription(model)) {
				this.lastDecision = undefined;
				return reasoning;
			}
			const inputTokens = estimateContextPromptTokens(context);
			// Project against the session response reserve, never a frontier model's theoretical output
			// maximum; a request cap (the session output cap, a goal budget) can only lower that.
			const maxOutputTokens = Math.min(
				model.maxTokens ?? 4096,
				this.deps.getCompactionReserveTokens(),
				requestMaxTokens ?? Number.POSITIVE_INFINITY,
			);
			const estUsd = estimateTurnCostUsd({
				inputTokens,
				maxOutputTokens,
				cost: model.cost,
				longContextPricing: model.longContextPricing,
			});
			// A dedup/rollup correction may move the cumulative total backward transiently; it must never
			// turn background spend negative or lower the request projection.
			const cumulativeBackgroundUsd = Math.max(0, this.deps.getSpawnedUsageCost() - this.turnBaselineUsd);
			const decision = evaluateCostGuard(estUsd, guard, cumulativeBackgroundUsd);
			this.lastDecision = decision;
			if (!decision.over || guard.action !== "downgrade" || reasoning === undefined) return reasoning;
			return downgradeReasoning(reasoning, getSupportedThinkingLevels(model), model.thinkingLevelMap) as NonNullable<
				SimpleStreamOptions["reasoning"]
			>;
		} catch {
			// Cost policy is advisory/request-local and must never disrupt the foreground provider call.
			return reasoning;
		}
	}
}
