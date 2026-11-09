/**
 * Retention policy of the transcript memory coordinator: the retention cutoff and window, the age of each source
 * span, the retention time of dormant nodes, the anchoring of session timestamps and the pass that revokes expired
 * summaries.
 */

import type { CoordinatorHost } from "./transcript-coordinator-host.ts";
import type { TranscriptSourceSpan } from "./transcript-memory-contracts.ts";
import { transcriptRetentionCutoff } from "./transcript-summary-catalog.ts";
import type { TranscriptSummaryNode } from "./transcript-summary-node.ts";

/** Expired roots revoked per drain; the rest follow through the mailbox so foreground work is never starved. */
const RETENTION_REVOKE_BATCH = 256;

export function retentionCutoffAt(host: Pick<CoordinatorHost, "ports">): number | undefined {
	return transcriptRetentionCutoff(host.ports.settings().retentionDays, host.ports.now());
}

/** The entry's event time, else its persisted anchor; undefined only for a source not yet anchored. */
export function spanTimeOf(host: Pick<CoordinatorHost, "catalog">, span: TranscriptSourceSpan): number | undefined {
	const stamped = span.timestamp === undefined ? Number.NaN : Date.parse(span.timestamp);
	if (!Number.isNaN(stamped)) return stamped;
	const anchor = host.catalog.anchorAt(span.ref);
	return anchor === undefined ? undefined : Date.parse(anchor);
}

export function spansExpired(
	host: Pick<CoordinatorHost, "spanTime">,
	spans: readonly TranscriptSourceSpan[],
	cutoff: number | undefined,
): boolean {
	if (cutoff === undefined) return false;
	return spans.some((span) => {
		const at = host.spanTime(span);
		return at !== undefined && at < cutoff;
	});
}

/** True when retention is on and the source is past the window or has no age yet: it must not feed a new summary. */
export function isOutsideRetentionWindow(
	host: Pick<CoordinatorHost, "retentionCutoff" | "spanTime">,
	span: TranscriptSourceSpan,
): boolean {
	const cutoff = host.retentionCutoff();
	if (cutoff === undefined) return false;
	const at = host.spanTime(span);
	return at === undefined || at < cutoff;
}

export function nextRetentionDeadline(host: Pick<CoordinatorHost, "catalog" | "ports">): number | undefined {
	return host.catalog.nextRetentionAt(host.ports.settings().retentionDays);
}

/**
 * The retention instant of a dormant node: its own dependencies (judged by the catalog) and, for a parent, every
 * child's, children looked up among accepted and dormant nodes. A parent has no coverage of its own: its age is
 * the oldest of its dated dependency and its children's, and an undated context source (aged by its anchor) is
 * visible only through the child. A child that is neither accepted nor dormant, or that has no age, leaves the
 * age unknown (undefined), which retention purges: the parent is only a cache.
 */
export function dormantRetentionTimeOf(
	host: Pick<CoordinatorHost, "catalog" | "dormant" | "dormantRetentionTime">,
	node: TranscriptSummaryNode,
): number | undefined {
	let oldest = host.catalog.nodeRetentionTime(node);
	for (const childId of node.children ?? []) {
		const child = host.catalog.get(childId) ?? host.dormant.get(childId);
		const at = child === undefined ? undefined : host.dormantRetentionTime(child);
		if (at === undefined) return undefined;
		if (oldest === undefined || at < oldest) oldest = at;
	}
	return oldest;
}

export async function applyRetentionPass(
	host: Pick<
		CoordinatorHost,
		| "retentionCutoff"
		| "run"
		| "live"
		| "catalog"
		| "dormant"
		| "dormantRetentionTime"
		| "deferStoreWork"
		| "fatal"
		| "applyRevocation"
		| "enqueue"
		| "applyRetention"
		| "pump"
	>,
	epoch: number,
): Promise<void> {
	const cutoff = host.retentionCutoff();
	const writer = host.run.writer;
	if (cutoff === undefined || !writer || !host.live(epoch)) return;
	const due: { id: string; at: number }[] = [];
	for (const node of host.catalog.values()) {
		const at = host.catalog.nodeRetentionTime(node);
		if (at !== undefined && at < cutoff) due.push({ id: node.id, at });
	}
	// Dormant content past the window (or whose age cannot be bounded) is purged too: it could never be
	// republished, and derived text must not outlive its sources' window.
	const dueDormant = new Set<string>();
	for (const node of host.dormant.values()) {
		const at = host.dormantRetentionTime(node);
		if (at === undefined || at < cutoff) dueDormant.add(node.id);
	}
	if (due.length === 0 && dueDormant.size === 0) return;
	due.sort((a, b) => a.at - b.at);
	const batch = new Set(due.slice(0, RETENTION_REVOKE_BATCH).map((entry) => entry.id));
	const result = await writer.revokeNodes((id) => batch.has(id), "retention", {
		purgeDormant: (id) => dueDormant.has(id),
	});
	if (result.status === "unavailable") {
		// Expired text stays withheld on every read meanwhile; the revocation is tried again after the store backoff.
		host.deferStoreWork(result.reason, { retention: true }, epoch);
		return;
	}
	if (result.status !== "published") return host.fatal(`retention was refused: ${result.status}`);
	// Nodes this coordinator holds as accepted must be in the manifest; if none are, the mirror is broken and
	// another pass would find the same nodes forever. Stop with the real cause instead.
	if (batch.size > 0 && result.revoked.length === 0) {
		return host.fatal("retention found accepted nodes the manifest does not hold");
	}
	await host.applyRevocation(result, epoch, { reason: "retention" });
	if (due.length > batch.size) {
		void host.enqueue(async () => {
			if (!host.live(epoch)) return;
			await host.applyRetention(epoch);
			host.pump(epoch);
		});
	}
}

export async function sessionTimestampOf(
	host: Pick<CoordinatorHost, "sessions" | "ports" | "causes">,
	sessionId: string,
): Promise<string | null | undefined> {
	if (!host.sessions.hasStamp(sessionId)) {
		const sessions = await host.ports.reader.listSessions();
		if (sessions.status !== "ok") {
			host.causes.noteInternal(`listing sessions for retention anchors: ${sessions.status}: ${sessions.reason}`);
			return undefined;
		}
		for (const session of sessions.sessions) host.sessions.recordStamp(session.sessionId, session.timestamp ?? null);
		if (!host.sessions.hasStamp(sessionId)) host.sessions.recordStamp(sessionId, null);
	}
	const stamp = host.sessions.stampOf(sessionId) ?? null;
	return stamp !== null && Number.isNaN(Date.parse(stamp)) ? null : stamp;
}
