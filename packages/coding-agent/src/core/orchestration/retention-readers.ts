/**
 * Read-only mailbox readers for the retention pass: whether an agent's mailbox holds a pending control message, and whether a
 * delegation objective has a pending delegated message. Each reads the mailbox file through a claim-free WorkerAgentMailbox,
 * so it needs the agent directory, the session id and the projection only: no worker controller, no delegate tool, and
 * nothing is written. A mailbox that does not read counts as pending, so the work it may hold is kept, and the damage is
 * reported through `warn` (the pass reports each text once).
 */

import { WorkerAgentMailbox } from "../delegation/worker-agent-control.ts";
import type { TaskRuntimeProjection } from "./task-runtime-state.ts";

type Warn = (message: string) => void;

function reportUnreadable(agentId: string, error: unknown, warn: Warn): void {
	const reason = error instanceof Error ? error.message : String(error);
	warn(`Orchestration retention: the worker mailbox of agent ${agentId} does not read (${reason}); its work is kept.`);
}

/** Whether the agent's mailbox holds a message not yet delivered. An unreadable mailbox holds one. */
export function hasPendingControlMessages(agentDir: string, sessionId: string, agentId: string, warn: Warn): boolean {
	try {
		return new WorkerAgentMailbox({ agentDir, parentSessionId: sessionId, agentId }).pending().length > 0;
	} catch (error) {
		reportUnreadable(agentId, error, warn);
		return true;
	}
}

/**
 * Whether a pending message filed under a delegation objective sits in some agent's mailbox, as a predicate over objective
 * ids. Every agent of the projection is read once, when this is called. An unreadable mailbox makes every objective pending,
 * because the messages it holds cannot be attributed.
 */
export function delegatedMessagesPending(
	agentDir: string,
	sessionId: string,
	state: TaskRuntimeProjection,
	warn: Warn,
): (objectiveId: string) => boolean {
	const filed = new Set<string>();
	for (const agentId of Object.keys(state.agents)) {
		try {
			for (const message of new WorkerAgentMailbox({ agentDir, parentSessionId: sessionId, agentId }).pending()) {
				if (message.delegationObjectiveId !== undefined) filed.add(message.delegationObjectiveId);
			}
		} catch (error) {
			reportUnreadable(agentId, error, warn);
			return () => true;
		}
	}
	return (objectiveId) => filed.has(objectiveId);
}
