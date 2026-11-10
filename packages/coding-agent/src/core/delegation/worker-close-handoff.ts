/**
 * What a closing owner leaves for its session's next opening. Closing a session interrupts work; it does not cancel it.
 * An attempt that is not executing stays as it is: one that never started stays queued, and one that was interrupted (by
 * this close, or earlier while it waited to go on) stays suspended. Once the closing process has physically settled,
 * the context of each worker with such an attempt is reserved for the same parent (`handoff`), so the next opening takes
 * it up without proof that this process died: a session is closed and opened again inside one process too.
 *
 * This module owns the two rules: which attempts a close leaves alone, and which contexts it hands off. The controller
 * owns the teardown order and applies them.
 */

import { isDeepStrictEqual } from "node:util";
import type { AgentBindingContract } from "../orchestration/contracts.ts";
import type { SpecialistContextClaim } from "../orchestration/specialist-context-ownership.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime.ts";

type CloseProjection = Pick<TaskRuntimeProjection, "agents" | "attempts">;

/** A close leaves an attempt that is not executing as it is: nothing runs for a queued attempt or a suspended one. */
export function attemptStaysAtClose(attempt: Pick<AttemptRuntimeState, "status"> | undefined): boolean {
	return attempt?.status === "queued" || attempt?.status === "suspended";
}

/** What the handoff reads and writes of the closing controller. */
export interface CloseHandoffPort {
	/** The closing owner: only a claim it holds itself is handed off. */
	readonly owner: { readonly parentSessionId: string; readonly incarnation: string };
	snapshot(): CloseProjection;
	/** The context claims this process holds, by worker session id. */
	claims(): ReadonlyMap<string, SpecialistContextClaim>;
	/** Nothing of this worker executes in this process, and none of its execution resources is held. */
	isSettled(agentId: string): boolean;
	/**
	 * Writes one worker's handoff under its mailbox and transcript locks. `assertUnchanged` runs inside those locks,
	 * before the write.
	 */
	publish(agent: AgentBindingContract, claim: SpecialistContextClaim, assertUnchanged: () => void): void;
	/** The claim left this process: the context is the next opening's. */
	released(sessionId: string): void;
	/** One worker's handoff, on its own: a failure is recorded and the other workers are still handed off. */
	step(label: string, run: () => void): void;
}

/** The agent an attempt runs on: the one it is bound to, or the one its dispatch names before it is bound. */
function agentOf(attempt: AttemptRuntimeState): string {
	return attempt.agentId ?? attempt.dispatch.logicalLaneId ?? attempt.taskId;
}

/** A worker's attempts the close left as they are, each with what identifies it while the handoff is written. */
function unfinishedAttemptsOf(projection: CloseProjection, agentId: string): readonly unknown[] {
	return Object.values(projection.attempts)
		.filter((attempt) => attemptStaysAtClose(attempt) && agentOf(attempt) === agentId)
		.map((attempt) => [attempt.attemptId, attempt.status, attempt.lease]);
}

/** An attempt of this worker still holds a live lease: its suspension failed, so its context is not handed off. */
function executes(projection: CloseProjection, agentId: string): boolean {
	return Object.values(projection.attempts).some(
		(attempt) => (attempt.status === "leased" || attempt.status === "running") && agentOf(attempt) === agentId,
	);
}

/**
 * Reserves, for the same parent, the context of every worker of the closing owner that has unfinished work and nothing
 * executing. The caller has closed admission, joined every continuation and found no shutdown failure: only a clean
 * physical shutdown may reserve a context, and a failed one keeps its busy claim. A context that several workers share, a
 * worker with no unfinished attempt, and a claim another owner holds are left as they are.
 */
export function handoffUnfinishedContexts(port: CloseHandoffPort): void {
	const projection = port.snapshot();
	const agents = Object.values(projection.agents);
	for (const [sessionId, claim] of [...port.claims()]) {
		if (claim.parentSessionId !== port.owner.parentSessionId || claim.incarnation !== port.owner.incarnation)
			continue;
		const bindings = agents.filter((candidate) => candidate.resumeContext.sessionId === sessionId);
		const agent = bindings.length === 1 ? bindings[0] : undefined;
		if (!agent) continue;
		const unfinished = unfinishedAttemptsOf(projection, agent.agentId);
		if (unfinished.length === 0 || executes(projection, agent.agentId)) continue;
		port.step(`handoff worker ${agent.agentId} context`, () => {
			port.publish(agent, claim, () => {
				const current = port.snapshot();
				if (
					port.claims().get(sessionId) !== claim ||
					!port.isSettled(agent.agentId) ||
					!isDeepStrictEqual(current.agents[agent.agentId], agent) ||
					!isDeepStrictEqual(unfinishedAttemptsOf(current, agent.agentId), unfinished)
				)
					throw new Error(`Worker ${agent.agentId} shutdown handoff ownership changed.`);
			});
			port.released(sessionId);
		});
	}
}
