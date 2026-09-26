import { createHash } from "node:crypto";
import { settleIndependentLifecycle } from "../lifecycle-settlement.ts";
import type { CollaborationBackend, CollaborationAgent as NativeAgent } from "./backend.ts";
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

export type PaneOwnership = "ours" | "gone" | "unverifiable";

/**
 * Classifies whether a member's original pane is still confirmed as its own, given whatever live
 * registration the caller already resolved — a single `getAgent` lookup (the launch path's own
 * cleanup, coordinator.ts's `verifiedClosePane`) or an entry already fetched from a batch
 * `listAgents()` (session reconciliation) — and, only when that alone cannot decide it, a direct
 * `getPane` lookup on the member's OWN recorded paneId. Shared by both callers so the launch-time and
 * reload-time verification rules can never drift apart.
 *
 * "ours": the registration confirms the exact paneId (and, whenever a terminalId was recorded, the
 * exact terminalId too) — still live and safe to close. "gone": a direct lookup on our own paneId
 * proves a DIFFERENT terminal now occupies it — our claim on it is settled, nothing of ours remains.
 * A registration under our name pointing elsewhere is never itself proof of "gone": pane ids and
 * process names both get reused after the owning process exits, so only a lookup on our OWN paneId
 * can settle it — a name mismatch falls through to that lookup exactly like a name that was never
 * registered at all. Anything the backend cannot answer for certain — no terminalId was ever
 * recorded to check a raw pane lookup against (a paneId alone is never proof by itself; ids get
 * reused), or a `getPane` exception — is "unverifiable": never a claim, the caller's own notice
 * stays up.
 */
export async function classifyPaneOwnership(
	backend: CollaborationBackend,
	agent: { paneId: string; terminalId?: string },
	registered: { paneId: string; terminalId: string } | undefined,
): Promise<PaneOwnership> {
	if (
		registered &&
		registered.paneId === agent.paneId &&
		(!agent.terminalId || registered.terminalId === agent.terminalId)
	) {
		return "ours";
	}
	if (!agent.terminalId) return "unverifiable";
	try {
		const currentPane = await backend.getPane(agent.paneId);
		return currentPane.terminalId === agent.terminalId ? "ours" : "gone";
	} catch {
		// A getPane exception cannot distinguish "genuinely gone" from "backend cannot answer" — treated
		// the same way: unverifiable, never a claim.
		return "unverifiable";
	}
}

/**
 * Resolves one member left mid-stop by a process that died before finishing it — D8's recycle
 * exhaustion, the team-wide launch rollback, or `stopCollaborationAgent`'s own paneId branch
 * throwing. Never runs against a live in-progress stop: reconcile only executes at a fresh session
 * start, so any `stopping` found here is necessarily left over from an earlier, now-dead process. A
 * member still `acquiring` is left untouched — job-store.ts's own doctrine: an absent pane is not
 * evidence that none exists, and this function never infers otherwise.
 */
async function resolveStrandedMember(
	store: CollaborationJobStore,
	client: CollaborationBackend,
	jobId: string,
	agent: CollaborationAgent,
	native: readonly NativeAgent[],
): Promise<void> {
	if (agent.acquiring) return;
	let resolved = !agent.paneId; // the acquisition already positively resolved with no resource
	if (agent.paneId) {
		const registered = agent.backendName
			? native.find((candidate) => candidate.name === agent.backendName)
			: undefined;
		const status = await classifyPaneOwnership(
			client,
			{ paneId: agent.paneId, terminalId: agent.terminalId },
			registered,
		);
		if (status === "unverifiable") return;
		if (status === "ours") {
			try {
				await client.closePane(agent.paneId);
			} catch {
				return; // present, ours, could not be closed — stays uncertain
			}
		}
		resolved = true; // "gone", or a verified "ours" just closed above
	}
	if (!resolved) return;
	store.finishAcquisition(jobId, agent.id);
	store.finishStop(
		jobId,
		agent.id,
		agent.turnId,
		"failed",
		agent.evidence || "Resolved at session reconciliation: no live resource remained.",
	);
}

/**
 * A read-only restoration probe for session reattachment that also resolves members whose own
 * launch/stop cleanup was left uncertain. It never recreates native work, and it only ever closes a
 * pane whose identity it has verified belongs to that exact member, or records closure when the
 * resource is confirmed gone or was already proven never created; anything it cannot verify — an
 * outstanding acquisition, a live pane it cannot confirm is (or is not) ours, or an unreachable
 * backend — stays uncertain and keeps the operator notice, exactly as before.
 */
export async function reconcileCollaborationSessions(
	store: CollaborationJobStore,
	backend: CollaborationCoordinatorDeps["backend"],
	publish: (jobId: string, identity: string, error?: string) => void,
	isCurrent: () => boolean,
): Promise<void> {
	const jobs = store.list().filter((job) => !job.dismissed && job.agents.some((agent) => !agent.closed));
	let next = 0;
	const workers = Array.from({ length: Math.min(4, jobs.length) }, async () => {
		while (next < jobs.length && isCurrent()) {
			const job = jobs[next++];
			let identity = recoveryIdentity(job);
			let failure: string | undefined;
			try {
				const client = await backend(job, false);
				const native = await client.listAgents();
				// Resolve any member stranded mid-stop before checking reattachment: a member this
				// settles can never poison the job's own identity check with a shape it no longer has.
				for (const initial of job.agents) {
					const current = store.load(job.id).agents.find((candidate) => candidate.id === initial.id);
					if (!current || current.closed || !current.stopping) continue;
					await resolveStrandedMember(store, client, job.id, current, native);
				}
				const settled = store.load(job.id);
				identity = recoveryIdentity(settled);
				for (const expected of settled.agents) {
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
	});
	await settleIndependentLifecycle(
		workers.map((worker) => () => worker),
		"Collaboration session reconciliation workers failed",
	);
}
