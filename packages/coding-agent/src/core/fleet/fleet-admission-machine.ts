/**
 * The fleet admission machine: whether a session admits new workers (`running`) or holds them (`stopped`, until resumed).
 * A leaf module that imports only the machine vocabulary, so the machine charts and the status view read this table without
 * loading the fleet scheduler. The scheduler reports each stop and resume to its observer.
 */

import { defineMachine } from "../../kernel/machine-spec.ts";

export const FLEET_STOP_MACHINE = defineMachine<"running" | "stopped", "stop" | "resume">({
	name: "fleet-admission",
	states: ["running", "stopped"],
	initial: "running",
	transitions: { running: { stop: "stopped" }, stopped: { resume: "running" } },
	describe: { running: "admitting workers as room allows", stopped: "stopped: nothing new starts until resumed" },
});
