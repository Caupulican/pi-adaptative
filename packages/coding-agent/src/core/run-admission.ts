/**
 * A session host's refusal of a run at its start (`AgentSessionConfig.admitRun`), and how the session's own loops read
 * it: no turn ran, so a goal's continuation neither counts the pass nor stops the goal on it, and the host that refused
 * takes the work up again once its cause clears. Typed by the error's identity, never by its words.
 */

import { AgentBusyError } from "../kernel/agent.ts";

/** The errors a host's admission threw as its refusal of a run. */
const refusals = new WeakSet<Error>();

/** `error`, which a host's admission throws, marked as its refusal of the run (`isRunAdmissionRefusal`): what it throws. */
export function runAdmissionRefusal(error: unknown): Error {
	const refusal = error instanceof Error ? error : new Error(String(error));
	refusals.add(refusal);
	return refusal;
}

/** Whether `error` is a host's refusal of a run at its start (`runAdmissionRefusal`). */
export function isRunAdmissionRefusal(error: unknown): boolean {
	return error instanceof Error && refusals.has(error);
}

/**
 * Whether a goal continuation's pass ended before its turn was admitted: another foreground owner held the agent
 * (`AgentBusyError`), or the session's host refused the run (`isRunAdmissionRefusal`). Neither consumes a turn of the
 * goal nor blocks it.
 */
export function isContinuationNotAdmitted(error: unknown): boolean {
	return error instanceof AgentBusyError || isRunAdmissionRefusal(error);
}
