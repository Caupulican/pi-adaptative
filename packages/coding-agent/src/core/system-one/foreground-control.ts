/**
 * Shared vocabulary of System One's levers. A steer is either queued for the executor's next model
 * turn or delivered now by interrupting the running one (see `worker-control.ts`, the lever System
 * One holds over workers). `systemOneAbortReason` reads the `system_one:` abort-reason format that the
 * goal continuation still classifies as "rerouted"; System One holds no cancel over the root's own
 * turn, so no root abort carries that reason any more.
 */

export type SystemOneSteerDelivery = "queue" | "now";

export const SYSTEM_ONE_ABORT_PREFIX = "system_one:";

/**
 * The System One reason inside an aborted assistant message's error text, which the agent loop
 * writes as `… (system_one:<reason>)`; undefined for an operator or harness abort.
 */
export function systemOneAbortReason(errorMessage: string | undefined): string | undefined {
	if (!errorMessage) return undefined;
	const start = errorMessage.indexOf(`(${SYSTEM_ONE_ABORT_PREFIX}`);
	if (start < 0) return undefined;
	const reason = errorMessage.slice(start + SYSTEM_ONE_ABORT_PREFIX.length + 1).replace(/\)$/, "");
	return reason.length > 0 ? reason : undefined;
}
