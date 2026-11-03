import { createHash } from "node:crypto";
import { settleIndependentLifecycle } from "../lifecycle-settlement.ts";
import {
	COLLABORATION_PANE_NOT_FOUND,
	type CollaborationBackend,
	CollaborationBackendError,
	type CollaborationAgent as NativeAgent,
} from "./backend.ts";
import type { CollaborationAgent, CollaborationJob } from "./job-record.ts";
import { type CollaborationJobStore, collaborationAcquisitionAbandoned } from "./job-store.ts";

/** Opens (or, for an already-admitted new job, creates) the native backend that hosts a job. */
export type CollaborationBackendFactory = (job: CollaborationJob, create?: boolean) => Promise<CollaborationBackend>;

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
 * proves a DIFFERENT terminal now occupies it, or the reachable backend answers that no pane has that
 * id (`COLLABORATION_PANE_NOT_FOUND`) — our claim on it is settled, nothing of ours remains.
 * A registration under our name pointing elsewhere is never itself proof of "gone": pane ids and
 * process names both get reused after the owning process exits, so only a lookup on our OWN paneId
 * can settle it — a name mismatch falls through to that lookup exactly like a name that was never
 * registered at all. Anything the backend cannot answer for certain — an existing pane with no
 * recorded terminalId to check it against (a paneId alone is never proof by itself; ids get reused),
 * or any other `getPane` failure (unreachable server, timeout, malformed reply) — is "unverifiable":
 * never a claim, the caller's own notice stays up.
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
	let currentPane: { terminalId: string };
	try {
		currentPane = await backend.getPane(agent.paneId);
	} catch (error) {
		// Only the server's own "no such pane" answer proves absence; a failure to ask proves nothing.
		return error instanceof CollaborationBackendError && error.code === COLLABORATION_PANE_NOT_FOUND
			? "gone"
			: "unverifiable";
	}
	if (!agent.terminalId) return "unverifiable";
	return currentPane.terminalId === agent.terminalId ? "ours" : "gone";
}

const ACTIVE_STATUSES: readonly string[] = ["idle", "reserved", "running"];

/**
 * Settles the turn of each member whose acquisition its exited issuer abandoned
 * ({@link collaborationAcquisitionAbandoned}). One without a
 * recorded pane has nothing to verify or close: the request may still have created a pane or
 * workspace, so its turn ends failed while `acquiring` stays set and no closure is ever claimed.
 * One with a recorded pane is left `stopping` for the verified close in `resolveStrandedMember`.
 * Needs no backend, so an unreachable backend cannot keep the turn running.
 */
function settleAbandonedAcquisitions(store: CollaborationJobStore, job: CollaborationJob): void {
	for (const initial of job.agents) {
		const current = store.load(job.id).agents.find((candidate) => candidate.id === initial.id);
		// Already settled once: a terminal status with the acquisition still unresolved.
		if (
			!current ||
			!collaborationAcquisitionAbandoned(current) ||
			current.closed ||
			(!current.stopping && !ACTIVE_STATUSES.includes(current.status))
		)
			continue;
		const stopping = current.stopping ? current : store.beginStop(job.id, current.id, current.turnId);
		if (!stopping || stopping.paneId) continue;
		store.finishStop(
			job.id,
			stopping.id,
			stopping.turnId,
			"failed",
			`Resource acquisition abandoned by its exited issuer (pid ${current.acquiredBy?.pid}); any pane it created${job.workspaceId ? ` in workspace ${job.workspaceId}` : ""} is untracked and needs manual inspection.`,
		);
	}
}

/**
 * Resolves one member left mid-stop by a process that died before finishing it — D8's recycle
 * exhaustion, the team-wide launch rollback, or `stopCollaborationAgent`'s own paneId branch
 * throwing. Reconcile runs at session start and on an explicit `job_status`, so a `stopping` found
 * here is normally left over from an earlier process. A member still `acquiring` is left untouched
 * unless the process that issued the acquisition is proven gone (`abandoned`) — job-store.ts's own
 * doctrine: an absent pane
 * is not evidence that none exists — and even then only a recorded pane is verified and closed.
 */
async function resolveStrandedMember(
	store: CollaborationJobStore,
	client: CollaborationBackend,
	jobId: string,
	agent: CollaborationAgent,
	native: readonly NativeAgent[],
	abandoned: boolean,
): Promise<void> {
	if (agent.acquiring && (!abandoned || !agent.paneId)) return;
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
	backend: CollaborationBackendFactory,
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
				// An acquisition records the process that issued it; once that process is proven gone by its full
				// identity nobody remains to record the acquisition's outcome. Judged per member, on the issuer, so
				// a take-back or an adoption neither hides an abandoned acquisition nor abandons a live one.
				settleAbandonedAcquisitions(store, job);
				const client = await backend(job, false);
				const native = await client.listAgents();
				// Resolve any member stranded mid-stop before checking reattachment: a member this
				// settles can never poison the job's own identity check with a shape it no longer has.
				for (const initial of job.agents) {
					const current = store.load(job.id).agents.find((candidate) => candidate.id === initial.id);
					if (!current || current.closed || !current.stopping) continue;
					await resolveStrandedMember(
						store,
						client,
						job.id,
						current,
						native,
						collaborationAcquisitionAbandoned(current),
					);
				}
				const settled = store.load(job.id);
				identity = recoveryIdentity(settled);
				for (const expected of settled.agents) {
					if (expected.closed) continue;
					// A settled member that never recorded a pane and holds no outstanding acquisition has no
					// native identity to reattach (a released acquisition, for one); asserting one would only
					// raise a false "identity changed" notice until the job is archived.
					if (!expected.paneId && !expected.acquiring && !ACTIVE_STATUSES.includes(expected.status)) continue;
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
