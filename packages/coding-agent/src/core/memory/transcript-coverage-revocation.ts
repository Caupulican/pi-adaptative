/**
 * Coverage revocation of the transcript memory coordinator: revokes summary coverage that a moved lineage no longer
 * supports, applies a published revocation to the mirror, and ends the jobs, frontiers and re-admissions it touches.
 */

import type { CoordinatorHost } from "./transcript-coordinator-host.ts";
import type { PublishedRevocation } from "./transcript-job-outcome.ts";
import type { TranscriptMemoryRevocationRecord } from "./transcript-memory-status.ts";
import type { VerifiedLineage } from "./transcript-session-runtime.ts";

export function lineageMovedDuring(
	host: Pick<CoordinatorHost, "revocationDue" | "noteBenignEvent">,
	sessionId: string,
	during: string,
): string {
	host.revocationDue.add(sessionId);
	const cause = `${during}: the lineage moved during verification`;
	host.noteBenignEvent(`${cause} (${sessionId})`);
	return cause;
}

export function staleJobsOf(
	host: Pick<CoordinatorHost, "scheduler" | "ports" | "inFlight" | "countTerminal" | "maybeFinishBatch">,
	jobIds: readonly string[],
): void {
	const scheduler = host.scheduler;
	if (!scheduler) return;
	const now = host.ports.now();
	const ids = new Set(jobIds);
	for (const entry of host.inFlight.values()) if (ids.has(entry.jobId)) entry.controller.abort();
	for (const id of jobIds) if (scheduler.markStale(id, now)) host.countTerminal("stale");
	host.maybeFinishBatch();
}

export async function applyRevocationOf(
	host: Pick<
		CoordinatorHost,
		| "sessionsOf"
		| "mirrorRevocation"
		| "dropFrontiers"
		| "runtime"
		| "revocationDue"
		| "ports"
		| "noteInternalCause"
		| "cursors"
		| "restartDiscovery"
		| "republishFrontiers"
		| "markJobsDirty"
		| "reconcileSession"
	>,
	result: PublishedRevocation,
	epoch: number,
	options: {
		reason: TranscriptMemoryRevocationRecord["reason"];
		dropSession?: string;
		rereadSession?: { sessionId: string; verified: VerifiedLineage | undefined };
		droppedReady?: number;
	},
): Promise<void> {
	const { dropSession, rereadSession: reread } = options;
	const affected = host.sessionsOf(result.revoked);
	host.mirrorRevocation(result, options.reason, dropSession, options.droppedReady ?? 0);
	host.dropFrontiers([...(dropSession !== undefined ? [dropSession] : []), ...result.removedFrontiers]);
	if (dropSession !== undefined) {
		host.runtime.delete(dropSession);
		host.revocationDue.delete(dropSession);
		affected.delete(dropSession);
	}
	// The store pulled the cursors of sessions that lost leaves back; discovery resumes from them.
	const read = affected.size > 0 ? await host.ports.store.readManifest() : undefined;
	// A manifest that cannot be read leaves those cursors unknown: discovery restarts them from the start of the
	// lineage, where every accepted leaf is recognized again.
	if (read !== undefined && read.status !== "ok") {
		host.noteInternalCause(
			`reading cursors after a revocation: ${read.status === "unavailable" ? read.reason : read.status}`,
		);
	}
	const manifest = read?.status === "ok" ? read.manifest : undefined;
	for (const sessionId of affected) {
		const cursor = manifest?.sessions[sessionId];
		if (cursor) host.cursors.set(sessionId, cursor);
		else host.cursors.delete(sessionId);
		const runtime = host.runtime.get(sessionId);
		if (runtime && sessionId === reread?.sessionId) host.restartDiscovery(sessionId, runtime, reread.verified);
		else host.runtime.delete(sessionId);
	}
	await host.republishFrontiers([...affected], epoch);
	host.markJobsDirty();
	for (const sessionId of affected) {
		if (sessionId !== reread?.sessionId) await host.reconcileSession(sessionId, epoch);
	}
}

export function mirrorRevocationOf(
	host: Pick<CoordinatorHost, "catalog" | "dormant" | "afterRevocation">,
	result: PublishedRevocation,
	reason: TranscriptMemoryRevocationRecord["reason"],
	dropSession: string | undefined,
	droppedReady: number,
): void {
	for (const id of result.parked) {
		const node = host.catalog.get(id);
		if (node) host.dormant.set(id, node);
	}
	for (const id of result.purged) host.dormant.delete(id);
	host.afterRevocation(
		result.revoked,
		result.revision,
		dropSession !== undefined ? [dropSession] : [],
		reason,
		droppedReady,
	);
}

export function dropFrontierSelections(
	host: Pick<CoordinatorHost, "frontiers" | "frontierBytes">,
	names: readonly string[],
): void {
	for (const name of names) {
		host.frontiers.delete(name);
		host.frontierBytes.delete(name);
	}
}

export function sessionsOfNodes(host: Pick<CoordinatorHost, "catalog">, nodeIds: readonly string[]): Set<string> {
	const sessions = new Set<string>();
	for (const id of nodeIds) {
		const node = host.catalog.get(id);
		if (node) sessions.add(node.sessionId);
	}
	return sessions;
}

export function endSessionJobsOf(
	host: Pick<CoordinatorHost, "scheduler" | "ports" | "countTerminal" | "maybeFinishBatch">,
	sessionId: string,
	to: "cancelled" | "stale",
): number {
	const ended = host.scheduler?.endSession(sessionId, to, host.ports.now());
	for (const _job of ended?.ended ?? []) host.countTerminal(to);
	host.maybeFinishBatch();
	return ended?.droppedReady.length ?? 0;
}

export function endRevokedReadmissionsOf(
	host: Pick<CoordinatorHost, "scheduler" | "ports" | "settlingReadmissions" | "inFlight" | "countTerminal">,
	sessionIds: Iterable<string>,
	revoked: ReadonlySet<string>,
): void {
	for (const sessionId of sessionIds) {
		for (const ended of host.scheduler?.endReadmissions(
			sessionId,
			revoked,
			host.ports.now(),
			host.settlingReadmissions,
		) ?? []) {
			for (const entry of host.inFlight.values()) if (entry.jobId === ended.id) entry.controller.abort();
			// A job that had already finished (ready) was counted when it did; only a job ended here is stale.
			if (ended.state !== "ready") host.countTerminal("stale");
		}
	}
}
