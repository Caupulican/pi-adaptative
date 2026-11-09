/**
 * The plan-node machine: one plan step's life, from planned through running to settled, held, superseded or cancelled. A
 * leaf module that imports only the machine vocabulary and the plan's state type, so the machine charts and the status
 * view read this table without loading the plan executor. The executor reports each step's change to its observer.
 */

import { defineMachine } from "../../kernel/machine-spec.ts";
import type { PlanNodeState } from "./plan-graph.ts";

const NODE_STATES: readonly PlanNodeState[] = [
	"planned",
	"ready",
	"admitted",
	"running",
	"settled",
	"held",
	"superseded",
	"cancelled",
];

function onward(...states: PlanNodeState[]): Partial<Record<PlanNodeState, PlanNodeState>> {
	return Object.fromEntries(states.map((state) => [state, state]));
}

/** One plan step's life; a revise may restart a settled or held step, and a retry may queue a running one again. */
export const PLAN_NODE_MACHINE = defineMachine<PlanNodeState, PlanNodeState>({
	name: "plan-node",
	states: NODE_STATES,
	initial: "planned",
	transitions: {
		planned: onward("ready", "admitted", "settled", "held", "superseded", "cancelled"),
		ready: onward("planned", "admitted", "running", "settled", "superseded", "cancelled"),
		admitted: onward("planned", "running", "settled", "held", "superseded", "cancelled"),
		running: onward("planned", "admitted", "settled", "held", "superseded", "cancelled"),
		held: onward("planned", "ready", "settled", "superseded", "cancelled"),
		settled: onward("planned", "ready", "held", "superseded", "cancelled"),
		superseded: {},
		cancelled: {},
	},
	describe: {
		planned: "waiting for earlier steps",
		ready: "ready to start",
		admitted: "starting",
		running: "running",
		settled: "done",
		held: "held",
		superseded: "replaced",
		cancelled: "stopped",
	},
});
