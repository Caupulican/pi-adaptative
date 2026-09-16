import { createHash } from "node:crypto";
import type { CollaborationAgent as NativeAgent } from "./backend.ts";
import type { CollaborationCoordinatorDeps } from "./coordinator.ts";
import type { CollaborationAgent, CollaborationJob, CollaborationJobStore } from "./job-store.ts";

/** One identity predicate for startup restoration and new-task reuse. */
export function assertCollaborationNativeIdentity(expected: CollaborationAgent, actual: NativeAgent | undefined): void {
	if (
		!expected.backendName ||
		!expected.paneId ||
		!expected.terminalId ||
		!actual ||
		actual.name !== expected.backendName ||
		actual.paneId !== expected.paneId ||
		actual.terminalId !== expected.terminalId ||
		actual.kind !== expected.provider
	)
		throw new Error(`Saved agent ${expected.id} is missing or its native identity changed.`);
}

function recoveryIdentity(job: CollaborationJob): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				job.createdAt,
				job.sessionName,
				job.placement,
				job.socketPath,
				job.dismissed,
				job.agents.map((agent) => [
					agent.id,
					agent.turnId,
					agent.backendName,
					agent.paneId,
					agent.terminalId,
					agent.closed,
					agent.steering?.requestId,
				]),
			]),
		)
		.digest("hex");
}

/** One read-only restoration probe, not a completion poll or a permission to recreate native work. */
export async function reconcileCollaborationSessions(
	store: CollaborationJobStore,
	backend: CollaborationCoordinatorDeps["backend"],
	publish: (jobId: string, identity: string, error?: string) => void,
	isCurrent: () => boolean,
): Promise<void> {
	const jobs = store.list().filter((job) => !job.dismissed && job.agents.some((agent) => !agent.closed));
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(4, jobs.length) }, async () => {
			while (next < jobs.length && isCurrent()) {
				const job = jobs[next++];
				const identity = recoveryIdentity(job);
				let failure: string | undefined;
				try {
					const native = await (await backend(job, false)).listAgents();
					for (const expected of job.agents) {
						if (expected.closed) continue;
						const actual = native.find((agent) => agent.name === expected.backendName);
						assertCollaborationNativeIdentity(expected, actual);
						if (expected.steering) {
							throw new Error(
								`Saved agent ${expected.id} has pending steering (turn ${expected.turnId}); successor intent: "${expected.steering.prompt.slice(0, 100)}".`,
							);
						}
					}
				} catch (error) {
					failure = `Saved collaboration session could not be reattached: ${String(error).slice(0, 400)}`;
				}
				if (!isCurrent()) return;
				// A concurrent new turn/close owns a different reconciliation; this result is stale.
				if (recoveryIdentity(store.load(job.id)) !== identity) continue;
				publish(job.id, identity, failure);
			}
		}),
	);
}
