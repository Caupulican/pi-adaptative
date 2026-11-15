/**
 * A plan a newer build wrote, carried whole across this build's compactions. This build keeps such a plan by its identity
 * (`isPlanCarried`), and its snapshot holds only that identity, which a build up to 0.104.65 reads as before. What the
 * plan is stays verbatim in the carry file beside the snapshot (`orchestration/snapshot-carry-file.ts`): per plan, its
 * base (the plans-map entry of the snapshot a compaction replaces, or the base the carry of that snapshot already kept)
 * and every `plan.*` event of it since, in journal order. When the session is read, each carried plan is rebuilt over the
 * snapshot's identity from that base and those events (`projectionWithCarriedPlans`): a build that decodes the plan reads
 * it whole, and one that does not reads its identity again, so each compaction carries it on until a build that knows it
 * opens the session.
 */

import type { JsonObject } from "../autonomy/contracts.ts";
import { isOrchestrationEvent, type OrchestrationEvent, toJsonObject } from "../orchestration/contracts.ts";
import type { CompactionBasis, CompactionFold } from "../orchestration/snapshot-carry-file.ts";
import { exactRecord, record } from "../orchestration/task-runtime-projection.ts";
import { DurableTaskRuntimeError, type TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import { planRuntimeStateFromValue } from "./plan-codec.ts";
import { isPlanCarried, isPlanFromNewerBuild, type PlanRuntimeState } from "./plan-graph.ts";
import { isPlanEventType, reducePlanEvent } from "./plan-reducer.ts";

/** One carried plan: the entry it is rebuilt from (none when its `plan.recorded` is among the events) and its events. */
interface CarriedPlan {
	readonly base?: JsonObject;
	readonly events: readonly OrchestrationEvent[];
}

const LABEL = "carried plans";

function carriedPlansFromValue(value: JsonObject | undefined): Record<string, CarriedPlan> {
	if (value === undefined) return {};
	const plans = record(exactRecord(value, LABEL, ["plans"]).plans, `${LABEL}.plans`);
	const decoded: Record<string, CarriedPlan> = {};
	for (const [planId, entry] of Object.entries(plans)) {
		const label = `${LABEL}.plans.${planId}`;
		const input = exactRecord(entry, label, ["base", "events"]);
		if (!Array.isArray(input.events)) throw new DurableTaskRuntimeError(`${label}.events is not a list.`);
		const events = input.events.map((event, index) => {
			if (isOrchestrationEvent(event) && isPlanEventType(event.type) && event.aggregateId === planId) return event;
			throw new DurableTaskRuntimeError(`${label}.events[${index}] is not an event of the plan.`);
		});
		const base = input.base === undefined ? undefined : toJsonObject(record(input.base, `${label}.base`));
		decoded[planId] = { ...(base ? { base } : {}), events };
	}
	return decoded;
}

/**
 * The fold of a compaction through `state`: its projection as the snapshot, and each carried plan's base and events.
 * A plan's base is the one the replaced snapshot's carry kept, else that snapshot's own entry of it; the plan's events in
 * the folded tail follow the events already kept.
 */
export function carriedPlansFold(state: TaskRuntimeProjection): (basis: CompactionBasis) => CompactionFold {
	return (basis) => foldWithCarriedPlans(state, basis);
}

function foldWithCarriedPlans(state: TaskRuntimeProjection, basis: CompactionBasis): CompactionFold {
	const projection = toJsonObject(state);
	const kept = carriedPlansFromValue(basis.prior?.carried);
	// A snapshot written before plans existed has no plans map.
	const prior = basis.prior?.projection.plans;
	const priorPlans = prior === undefined ? {} : record(prior, "replaced snapshot plans");
	const plans: Record<string, CarriedPlan> = {};
	for (const [planId, plan] of Object.entries(state.plans)) {
		if (!isPlanCarried(plan.record)) continue;
		const priorEntry = priorPlans[planId];
		const base = kept[planId] ? kept[planId].base : priorEntry === undefined ? undefined : toJsonObject(priorEntry);
		const events = [
			...(kept[planId]?.events ?? []),
			...basis.tail.filter((event) => isPlanEventType(event.type) && event.aggregateId === planId),
		];
		plans[planId] = { ...(base ? { base } : {}), events };
	}
	return Object.keys(plans).length === 0 ? { projection } : { projection, carried: toJsonObject({ plans }) };
}

/**
 * The projection a snapshot and its carry hold: each carried plan the snapshot keeps by its identity is rebuilt from its
 * base and events, through the same decoder and reducer the journal is read with. A plan the snapshot no longer has, or
 * holds whole, is read as the snapshot holds it.
 */
export function projectionWithCarriedPlans(
	state: TaskRuntimeProjection,
	carried: JsonObject | undefined,
): TaskRuntimeProjection {
	if (carried === undefined) return state;
	const plans: Record<string, PlanRuntimeState> = { ...state.plans };
	for (const [planId, carry] of Object.entries(carriedPlansFromValue(carried))) {
		const identity = plans[planId];
		if (!identity || !isPlanFromNewerBuild(identity.record)) continue;
		delete plans[planId];
		if (carry.base) plans[planId] = planRuntimeStateFromValue(carry.base, `${LABEL}.plans.${planId}.base`);
		for (const event of carry.events) reducePlanEvent(plans, state.tasks, event);
	}
	return { ...state, plans };
}
