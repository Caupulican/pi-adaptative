/**
 * Session reconciliation of the transcript memory coordinator: reads each held or recovered session against its
 * lineage, drops records that no longer belong, restarts discovery, and aborts or invalidates a session's work.
 */

import type { CoordinatorHost } from "./transcript-coordinator-host.ts";
import type { TranscriptCoverage } from "./transcript-memory-contracts.ts";
import { holdReason, RECONCILIATION_WAITING } from "./transcript-memory-reason-text.ts";
import {
	type CoverageVerdict,
	lineageStamp,
	type SessionRuntime,
	type VerifiedLineage,
	vouchesFor,
} from "./transcript-session-runtime.ts";

export async function reconcileAllSessions(
	host: Pick<
		CoordinatorHost,
		| "ports"
		| "noteInternalCause"
		| "reconcileHeldSessions"
		| "sessionTimestamps"
		| "dropOrphanedSessionRecords"
		| "live"
		| "reconcileSession"
	>,
	epoch: number,
): Promise<void> {
	const sessions = await host.ports.reader.listSessions();
	if (sessions.status !== "ok") {
		host.noteInternalCause(`listing sessions: ${sessions.status}: ${sessions.reason}`);
		// A failed listing still reaches the recovered leaves held for reconciliation, by their own sessions.
		await host.reconcileHeldSessions(new Set(), epoch);
		return;
	}
	for (const session of sessions.sessions) host.sessionTimestamps.set(session.sessionId, session.timestamp ?? null);
	// False only when the writer is gone or the drop was refused (the coordinator stopped).
	const listed = new Set(sessions.sessions.map((s) => s.sessionId));
	if (!(await host.dropOrphanedSessionRecords(listed, sessions.coverage))) return;
	const visited = new Set<string>();
	for (const session of sessions.sessions) {
		if (!host.live(epoch)) return;
		visited.add(session.sessionId);
		await host.reconcileSession(session.sessionId, epoch);
	}
	await host.reconcileHeldSessions(visited, epoch);
}

export async function reconcileHeldSessionsOf(
	host: Pick<CoordinatorHost, "scheduler" | "parked" | "live" | "reconcileSession">,
	visited: ReadonlySet<string>,
	epoch: number,
): Promise<void> {
	const scheduler = host.scheduler;
	if (!scheduler) return;
	const sessions = new Set<string>();
	for (const [id, hold] of host.parked) {
		if (hold.scope !== "reconciliation") continue;
		const sessionId = scheduler.get(id)?.sessionId;
		if (sessionId !== undefined && !visited.has(sessionId)) sessions.add(sessionId);
	}
	for (const sessionId of sessions) {
		if (!host.live(epoch)) return;
		await host.reconcileSession(sessionId, epoch);
	}
}

export async function reconcileSessionOf(
	host: Pick<CoordinatorHost, "reconcileSessionRead" | "scheduler" | "live" | "parked">,
	sessionId: string,
	epoch: number,
): Promise<void> {
	const unread = await host.reconcileSessionRead(sessionId, epoch);
	const scheduler = host.scheduler;
	if (!host.live(epoch) || !scheduler) return;
	const reason =
		unread === undefined
			? RECONCILIATION_WAITING
			: holdReason(
					unread,
					"a recovered summary job waits for its session to be read again, so the budget it had under capture version 1 is adopted first",
				);
	for (const [id, hold] of host.parked) {
		if (hold.scope !== "reconciliation" || scheduler.get(id)?.sessionId !== sessionId) continue;
		host.parked.set(id, { scope: "reconciliation", reason });
	}
}

export async function reconcileSessionReadOf(
	host: Pick<
		CoordinatorHost,
		| "scheduler"
		| "live"
		| "forgottenSessions"
		| "ports"
		| "invalidateSession"
		| "noteInternalCause"
		| "runtime"
		| "cursors"
		| "revocationDue"
		| "revokeDeadCoverage"
		| "restartDiscovery"
		| "enumerateLeaves"
		| "certifyCursor"
	>,
	sessionId: string,
	epoch: number,
): Promise<string | undefined> {
	const scheduler = host.scheduler;
	if (!host.live(epoch) || !scheduler || host.forgottenSessions.has(sessionId)) return;
	const probe = await host.ports.reader.listLineageSpans({ sessionId, fromIndex: 0, maxSpans: 1 });
	if (!host.live(epoch)) return;
	if (probe.status === "not_found") {
		await host.invalidateSession(sessionId, epoch);
		return;
	}
	if (probe.status !== "ok") {
		host.noteInternalCause(`reading ${sessionId}: ${probe.status}: ${probe.reason}`);
		return `${probe.status}: ${probe.reason}`;
	}
	let runtime = host.runtime.get(sessionId);
	if (!runtime) {
		const cursor = host.cursors.get(sessionId);
		runtime = {
			next: { fromIndex: cursor?.coveredSpanCount ?? 0, ordinal: cursor?.nextOrdinal ?? 0 },
			total: probe.total,
			verifiedDigest: cursor?.lineageDigest,
			verifiedStamp: undefined,
			backpressured: false,
		};
		host.runtime.set(sessionId, runtime);
	}
	runtime.total = probe.total;
	const stamp = lineageStamp(probe);
	// Taken before the revocation, so the read that rediscovers the session after a change is not forced again: it
	// starts from the verification this read made ({@link restartDiscovery}) and verifies again only if the
	// lineage moved since.
	const due = host.revocationDue.delete(sessionId);
	if (due || !vouchesFor(runtime, probe)) {
		// The lineage moved (a branch switch, a rewrite): keep what is still live, revoke the rest. A change
		// rediscovers the session itself and answers that read's cause here; an unreadable lineage is not judged
		// and the next read tries again.
		let dead: CoverageVerdict;
		try {
			dead = await host.revokeDeadCoverage(sessionId, epoch, stamp);
		} catch (error) {
			// A store write that threw left the judgment unmade, as an unreadable verification does: the revocation
			// stays due for the next read (the mailbox keeps the error as the internal cause).
			if (due) host.revocationDue.add(sessionId);
			throw error;
		}
		if (dead.kind === "unreadable") {
			if (due) host.revocationDue.add(sessionId);
			return dead.cause;
		}
		if (dead.kind === "changed") return;
		// Every node and job is still live. The newest lineage the verification read: its pages share the probe's
		// stamp, so the probe's lineage is a prefix of it, and a check that passed on spans appended since is
		// verified on it, not on the probe's.
		host.restartDiscovery(sessionId, runtime, { digest: dead.digest ?? probe.lineageDigest, stamp });
	} else if (runtime.verifiedDigest === probe.lineageDigest) {
		// The probe saw exactly the verified lineage, so its stamp names that lineage from now on: a pure append
		// keeps the stamp and needs no verification.
		runtime.verifiedStamp = stamp;
	}
	const unread = await host.enumerateLeaves(sessionId, runtime, epoch, stamp);
	await host.certifyCursor(sessionId, runtime, epoch);
	return unread;
}

/**
 * Drop what is kept per session (anchors, spent budgets) for sessions CONFIRMED ABSENT: not in the index and
 * no accepted node references them. Coverage reports skipped, unsupported, failing and cut-off sessions only
 * as counts, never per session id, so absence can be confirmed only when those counts are all zero and the
 * indexed count equals the listing: then the listing is the whole catalog. Otherwise nothing is dropped (a
 * skipped, unreadable or unsupported session keeps its anchors and spent budgets, or its age would reset
 * when it returns). Never by age. `coverage` is the one the listing answer carried: counts that describe exactly
 * the catalog `indexed` was listed from, never a later snapshot that may describe another one.
 */
export async function dropOrphanedRecordsOf(
	host: Pick<CoordinatorHost, "catalog" | "scheduler" | "dormant" | "dropSessionRecords" | "deferStoreWork" | "epoch">,
	indexed: ReadonlySet<string>,
	coverage: TranscriptCoverage,
): Promise<boolean> {
	if (
		coverage.truncated ||
		coverage.sessionsSkipped > 0 ||
		coverage.sessionsUnsupported > 0 ||
		coverage.activeFailures > 0 ||
		coverage.sessionsEligible !== coverage.sessionsIndexed ||
		coverage.sessionsIndexed !== indexed.size
	) {
		return true;
	}
	const referenced = new Set<string>();
	for (const node of host.catalog.values()) {
		referenced.add(node.sessionId);
		for (const ref of node.contextRefs) referenced.add(ref.sessionId);
	}
	const held = new Set<string>([
		...host.catalog.anchoredSessionIds(),
		...(host.scheduler?.spentSessionIds() ?? []),
		...[...host.dormant.values()].map((node) => node.sessionId),
	]);
	const orphans = new Set([...held].filter((sessionId) => !indexed.has(sessionId) && !referenced.has(sessionId)));
	if (orphans.size === 0) return true;
	const dropped = await host.dropSessionRecords(orphans);
	// A drop the store could not write goes to the next discovery after the store backoff; this one goes on.
	if (dropped !== true && dropped !== false) host.deferStoreWork(dropped.reason, { discover: true }, host.epoch);
	return dropped !== false;
}

export function restartDiscoveryOf(
	host: Pick<CoordinatorHost, "cursors">,
	sessionId: string,
	runtime: SessionRuntime,
	verified: VerifiedLineage | undefined,
): void {
	const cursor = host.cursors.get(sessionId);
	runtime.next = { fromIndex: cursor?.coveredSpanCount ?? 0, ordinal: cursor?.nextOrdinal ?? 0 };
	runtime.backpressured = false;
	runtime.verifiedDigest = verified ? verified.digest : cursor?.lineageDigest;
	runtime.verifiedStamp = verified?.stamp;
}

export function abortSessionJobs(
	host: Pick<CoordinatorHost, "scheduler" | "inFlight" | "abortDeniedInputs">,
	sessionId: string,
): void {
	const scheduler = host.scheduler;
	if (!scheduler) return;
	const ids = new Set(scheduler.snapshot().flatMap((job) => (job.sessionId === sessionId ? [job.id] : [])));
	for (const entry of host.inFlight.values()) if (ids.has(entry.jobId)) entry.controller.abort();
	host.abortDeniedInputs();
}

/**
 * Abort running work of OTHER sessions that is built on denied nodes (a parent over a child that consulted a forgotten
 * session, a re-admission of such a node): its inputs are denied now, so it must not reach a model again.
 */
export function abortDeniedJobInputs(
	host: Pick<CoordinatorHost, "scheduler" | "inFlight" | "catalog" | "nodeDenied">,
): void {
	const scheduler = host.scheduler;
	if (!scheduler) return;
	for (const entry of host.inFlight.values()) {
		const job = scheduler.get(entry.jobId);
		if (!job) continue;
		const inputs = job.kind === "readmission" ? [job.nodeId] : job.kind === "parent" ? (job.children ?? []) : [];
		const denied = inputs.some((id) => {
			const node = id === undefined ? undefined : host.catalog.get(id);
			return node !== undefined && host.nodeDenied(node);
		});
		if (denied) entry.controller.abort();
	}
}
