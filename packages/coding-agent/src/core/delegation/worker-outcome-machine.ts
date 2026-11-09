/**
 * The worker-outcome machine: the state of one attempt's recorded outcome, from `none` to the status it was last recorded
 * at. A leaf module that imports only the machine vocabulary and the outcome status constants, so the machine charts and
 * the status view read this table without loading the outcome recorder's controller graph.
 */

import { defineMachine } from "../../kernel/machine-spec.ts";
import { OUTCOME_STATUSES, type OutcomeStatus } from "./worker-outcome-contract.ts";

export type OutcomeMachineState = "none" | OutcomeStatus;

const EVERY_STATUS: Partial<Record<OutcomeStatus, OutcomeMachineState>> = Object.fromEntries(
	OUTCOME_STATUSES.map((status) => [status, status]),
);

/**
 * The outcome of one attempt. A first outcome may be any status; partial, blocked and failed may be re-decided (a
 * verification settles, a later fact arrives); succeeded and cancelled are final for that attempt.
 */
export const WORKER_OUTCOME_MACHINE = defineMachine<OutcomeMachineState, OutcomeStatus>({
	name: "worker-outcome",
	states: ["none", ...OUTCOME_STATUSES],
	initial: "none",
	transitions: {
		none: EVERY_STATUS,
		partial: EVERY_STATUS,
		blocked: EVERY_STATUS,
		failed: EVERY_STATUS,
		succeeded: {},
		cancelled: {},
	},
	describe: {
		none: "no outcome yet",
		succeeded: "done",
		partial: "partly done",
		blocked: "blocked",
		failed: "failed",
		cancelled: "stopped",
	},
});
