/**
 * System One's levers over a worker: the same two the root has. Cancel ends the lane at once; a
 * steer is delivered for the worker's next model turn (a running worker takes it mid-run, an idle
 * one wakes on it) or now, by interrupting the running attempt, queueing the directive on the
 * worker's mailbox and resuming the attempt so its next turn opens on the directive.
 */

import type { SystemOneSteerDelivery } from "./foreground-control.ts";

export interface SystemOneWorkerControl {
	cancelWorker(agentId: string, reason: string): void;
	steerWorker(agentId: string, directive: string, delivery: SystemOneSteerDelivery): void;
}

export interface SessionWorkerControlDeps {
	cancelWorkerAgent(agentId: string, reason: string): void;
	/** Wakes an idle agent on the message or steers a running one; queues when the agent is neither. */
	followUpWorkerAgent(agentId: string, message: string): { started: boolean; steering: boolean; skipReason?: string };
	interruptWorkerAgent(agentId: string): { interrupted: boolean; reason?: string };
	queueWorkerAgentMessage(agentId: string, message: string): void;
	resumeWorkerAgent(agentId: string): { started: boolean; skipReason?: string };
	recordDirective(agentId: string, directive: string): void;
	emitWarning(message: string): void;
}

export function createSessionWorkerControl(deps: SessionWorkerControlDeps): SystemOneWorkerControl {
	return {
		cancelWorker(agentId, reason) {
			deps.recordDirective(agentId, `cancel: ${reason}`);
			deps.cancelWorkerAgent(agentId, reason);
		},
		steerWorker(agentId, directive, delivery) {
			deps.recordDirective(agentId, `steer (${delivery}): ${directive}`);
			if (delivery === "queue") {
				const result = deps.followUpWorkerAgent(agentId, directive);
				if (!result.started && !result.steering && result.skipReason) {
					deps.emitWarning(`System One steer for worker ${agentId} was only queued: ${result.skipReason}`);
				}
				return;
			}
			const interrupted = deps.interruptWorkerAgent(agentId);
			if (!interrupted.interrupted) {
				// Not running: the follow-up wakes or queues it, which is "now" for an idle worker.
				deps.followUpWorkerAgent(agentId, directive);
				return;
			}
			deps.queueWorkerAgentMessage(agentId, directive);
			const resumed = deps.resumeWorkerAgent(agentId);
			if (!resumed.started) {
				deps.emitWarning(
					`System One interrupted worker ${agentId} but could not resume it: ${resumed.skipReason ?? "unknown"}`,
				);
			}
		},
	};
}
