/**
 * A plan a newer build wrote, carried whole across this build's compactions. This build keeps such a plan by its identity
 * (`isPlanCarried`), and its snapshot holds only that identity, which a build up to 0.104.65 reads as before. What the
 * plan is stays verbatim in its carried chain beside the snapshot (`orchestration/snapshot-carry-file.ts`): its base (the
 * plans-map entry of the snapshot the compaction that started the chain replaced) and every `plan.*` event of it since,
 * in journal order, each compaction appending the events it folds. When the session is read, a carried plan whose
 * snapshot identity is of a version the reading build decodes (the identity an older build, this one, wrote) is rebuilt
 * from that base and those events (`projectionWithCarriedPlans`); a build that does not decode it keeps the identity
 * without reading the chain, and each compaction carries the plan on until a build that knows it opens the session.
 */

import type { OrchestrationEvent } from "../orchestration/contracts.ts";
import { toJsonObject } from "../orchestration/contracts.ts";
import { projectionForStorage } from "../orchestration/dispatch-storage.ts";
import type {
	CarriedEntry,
	CarriedWrite,
	CompactionBasis,
	CompactionFold,
} from "../orchestration/snapshot-carry-file.ts";
import { record } from "../orchestration/task-runtime-projection.ts";
import { DurableTaskRuntimeError, type TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import { planRuntimeStateFromValue } from "./plan-codec.ts";
import { isPlanCarried, isPlanLostToOlderBuild, type PlanRuntimeState } from "./plan-graph.ts";
import { isPlanEventType, reducePlanEvent } from "./plan-reducer.ts";

const LABEL = "carried plans";

/**
 * The fold of a compaction through `state`: its projection as the snapshot, and per carried plan the plan events of the
 * folded tail, appended to the plan's chain when the replaced snapshot carried it, else starting one from that snapshot's
 * entry of the plan (none when the plan was recorded within the tail).
 */
export function carriedPlansFold(state: TaskRuntimeProjection): (basis: CompactionBasis) => CompactionFold {
	return (basis) => foldWithCarriedPlans(state, basis);
}

function foldWithCarriedPlans(state: TaskRuntimeProjection, basis: CompactionBasis): CompactionFold {
	const projection = projectionForStorage(state);
	// A snapshot written before plans existed has no plans map.
	const prior = basis.prior?.projection.plans;
	const priorPlans = prior === undefined ? {} : record(prior, "replaced snapshot plans");
	const carried: Record<string, CarriedWrite> = {};
	for (const [planId, plan] of Object.entries(state.plans)) {
		if (!isPlanCarried(plan.record)) continue;
		const events = basis.tail.filter((event) => isPlanEventType(event.type) && event.aggregateId === planId);
		const priorEntry = priorPlans[planId];
		carried[planId] =
			basis.prior?.carried.has(planId) || priorEntry === undefined
				? { events }
				: { base: toJsonObject(priorEntry), events };
	}
	return Object.keys(carried).length === 0 ? { projection } : { projection, carried };
}

/**
 * The projection a snapshot and its carry hold: each carried plan whose snapshot identity is of a version this build
 * decodes is rebuilt from its base and events, through the same decoder and reducer the journal is read with. Any other
 * carried plan stays the snapshot's identity (the snapshot already holds what this build reads of it, its closing
 * included) and its chain is not read. A plan the snapshot no longer has, or holds whole, is read as the snapshot holds it.
 */
export function projectionWithCarriedPlans(
	state: TaskRuntimeProjection,
	carried: ReadonlyMap<string, CarriedEntry> | undefined,
): TaskRuntimeProjection {
	if (carried === undefined) return state;
	const plans: Record<string, PlanRuntimeState> = { ...state.plans };
	let rebuilt = false;
	for (const [planId, entry] of carried) {
		if (!isPlanLostToOlderBuild(plans[planId]?.record)) continue;
		rebuilt = true;
		delete plans[planId];
		const base = entry.base();
		if (base) plans[planId] = planRuntimeStateFromValue(base, `${LABEL}.${planId}.base`);
		for (const event of entry.events()) reducePlanEvent(plans, state.tasks, planEventOf(planId, event));
	}
	return rebuilt ? { ...state, plans } : state;
}

function planEventOf(planId: string, event: OrchestrationEvent): OrchestrationEvent {
	if (isPlanEventType(event.type) && event.aggregateId === planId) return event;
	throw new DurableTaskRuntimeError(`${LABEL}.${planId} holds an event that is not one of the plan's.`);
}
