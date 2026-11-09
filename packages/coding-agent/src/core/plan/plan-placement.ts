/**
 * Where a released plan step runs: the base placement, or a linked machine for a read-only step when local room is zero, as
 * ordered code exits.
 */

import type { Placement } from "../placement/placement-types.ts";
import type { PlanNodeSpec } from "./plan-graph.ts";

export interface PlacementFacts {
	readonly localRunnable: number;
	readonly candidates: readonly { readonly machineId: string; readonly slots: number }[];
	readonly refused: ReadonlySet<string>;
	/** A remote-machine backend is registered: without one no machine can take a step, so a must-pin runs here. */
	readonly remoteBackend: boolean;
	/** The linked machine a placed job for this release already exists on: a replay returns to it, picking no candidate. */
	readonly boundMachine?: string;
}

/** The exit of a must-pinned step that runs here because no remote backend can take it. */
export const PIN_MUST_LOCAL = "pin_machine_must_local";

type Chosen = { readonly placement: Placement; readonly exit: string };

function remote(machineId: string, exit: string): Chosen {
	return { placement: { kind: "remote_machine", machineId }, exit };
}

/** The machine a step's pin names (prefer or must), or undefined for a pin on a bot, a leader or here, or no pin. */
export function pinnedMachineOf(node: PlanNodeSpec): string | undefined {
	const target = node.pin?.target;
	return typeof target === "object" && "machineId" in target ? target.machineId : undefined;
}

/**
 * The placement a released step takes. P1 a non-local base is kept; P2 a must-pin to a machine is honoured when a remote
 * backend is registered, and otherwise the step runs here with exit `pin_machine_must_local`; P3-P7 a step that is not a
 * read-only plain step, has inputs or refs, or is pinned here keeps the base; a release whose placed job already exists on a
 * machine returns to that machine (its job holds the room, so no candidate is picked and local room does not divert it);
 * P8 a prefer-pin to a free candidate; P9 local room keeps the base; P10 the first candidate not refused; P11 the base.
 */
export function placementFor(node: PlanNodeSpec, base: Chosen, facts: PlacementFacts): Chosen {
	if (base.placement.kind !== "local_worker") return base;
	const target = node.pin?.target;
	const pinnedMachine = pinnedMachineOf(node);
	if (node.pin?.mode === "must" && pinnedMachine !== undefined)
		return facts.remoteBackend
			? remote(pinnedMachine, "pin_machine_must")
			: { placement: base.placement, exit: PIN_MUST_LOCAL };
	if (node.kind !== "work") return base;
	if (node.writeScope.length > 0) return base;
	if (node.inputs.length > 0) return base;
	if ((node.brief?.refs?.length ?? 0) > 0) return base;
	if (target === "here") return base;
	// A permanently refused machine is not returned to; the step then takes the ordinary exits below.
	if (facts.boundMachine !== undefined && facts.remoteBackend && !facts.refused.has(facts.boundMachine))
		return remote(facts.boundMachine, "bound_machine");
	const open = (machineId: string): boolean =>
		facts.candidates.some((candidate) => candidate.machineId === machineId) && !facts.refused.has(machineId);
	if (pinnedMachine !== undefined && open(pinnedMachine)) return remote(pinnedMachine, "pin_machine_remote");
	if (facts.localRunnable >= 1) return base;
	const first = facts.candidates.find((candidate) => !facts.refused.has(candidate.machineId));
	return first ? remote(first.machineId, "remote_room") : base;
}
