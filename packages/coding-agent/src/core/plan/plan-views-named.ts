/**
 * Plan views with the owner's names for the machines steps run on and the machines their pins name. Names are read when the
 * views are built, never stored in the plan record. The fleet record is read once per agents directory and again only after
 * it changes, so a render reads no file while nothing changed.
 */

import { FleetMachines } from "../remote/fleet-machines.ts";
import { listPlanViews, type PlanNodeView, type PlanProjection, type PlanView } from "./plan-view.ts";

/** One agents directory's machine names: read on first use, dropped whenever the fleet record changes. */
class MachineNames {
	private readonly machines: FleetMachines;
	private names: ReadonlyMap<string, string> | undefined;

	constructor(agentDir: string) {
		this.machines = new FleetMachines(agentDir);
		// Subscribed before the first read, so a change made after that read always drops the map.
		this.machines.subscribe(() => {
			this.names = undefined;
		});
	}

	get(): ReadonlyMap<string, string> {
		if (this.names === undefined)
			this.names = new Map(this.machines.list().map((machine) => [machine.machineId, machine.name]));
		return this.names;
	}
}

const namesByAgentsDir = new Map<string, MachineNames>();

function machineNames(agentDir: string): ReadonlyMap<string, string> {
	let names = namesByAgentsDir.get(agentDir);
	if (names === undefined) {
		names = new MachineNames(agentDir);
		namesByAgentsDir.set(agentDir, names);
	}
	return names.get();
}

/** A step involves a machine when it runs on one or its pin names one: only then is the fleet record consulted. */
function involvesMachine(node: PlanNodeView): boolean {
	return node.placement?.kind === "remote_machine" || node.pinnedMachine !== undefined;
}

/**
 * Plan views with the owner's names for the machines steps run on and their pins name. Returns `[]` for an absent projection.
 * The fleet record is consulted only when some step involves a machine; a machine the record does not name keeps no name in
 * its view.
 */
export function namedPlanViews(projection: PlanProjection | undefined, agentDir: string): readonly PlanView[] {
	if (projection === undefined) return [];
	const views = listPlanViews(projection);
	if (!views.some((view) => view.nodes.some(involvesMachine))) return views;
	return listPlanViews(projection, machineNames(agentDir));
}
