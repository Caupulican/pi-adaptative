/**
 * Frontier reads of the transcript memory coordinator: the frontier snapshot, the expiry and admission checks it
 * relies on, the evidence of a confirmed frontier, the frontier selection computed for a session, and the denial
 * check that keeps forgotten nodes out of every read.
 */

import type { MemoryReadEvidence } from "./memory-read-context.ts";
import type { CoordinatorHost } from "./transcript-coordinator-host.ts";
import { selectFrontier, type TranscriptFrontierGap, type TranscriptFrontierSelection } from "./transcript-frontier.ts";
import { namesForgottenSession } from "./transcript-summary-catalog.ts";
import type { TranscriptSummaryNode } from "./transcript-summary-node.ts";

export function frontierSnapshotOf(
	host: Pick<
		CoordinatorHost,
		| "frontiers"
		| "catalog"
		| "forgottenSessions"
		| "nodeDenied"
		| "frontierExpired"
		| "frontierNotAdmitted"
		| "frontierBytes"
	>,
	lineageKey: string,
):
	| {
			selection: TranscriptFrontierSelection;
			nodes: ReadonlyMap<string, TranscriptSummaryNode>;
			gap?: TranscriptFrontierGap;
	  }
	| undefined {
	const selection = host.frontiers.get(lineageKey);
	const nodes = host.catalog.sessionNodes(lineageKey);
	if (!selection || !nodes) return undefined;
	// A forgotten session's frontier, or one naming a denied summary, is never described.
	if (
		host.forgottenSessions.has(lineageKey) ||
		selection.nodeIds.some((id) => {
			const named = host.catalog.get(id);
			return named !== undefined && host.nodeDenied(named);
		})
	) {
		return undefined;
	}
	// A late retention wake must never expose expired derived text: the frontier is withheld until it is revoked.
	if (host.frontierExpired(lineageKey)) return undefined;
	// Likewise a summary without a current admission is never described until it is re-admitted.
	if (host.frontierNotAdmitted(lineageKey)) return undefined;
	const gap = host.frontierBytes.get(lineageKey)?.gap;
	return { selection, nodes, ...(gap ? { gap } : {}) };
}

export function frontierExpiredAt(
	host: Pick<CoordinatorHost, "frontiers" | "catalog" | "retentionCutoff">,
	lineageKey: string,
): boolean {
	const selection = host.frontiers.get(lineageKey);
	const nodes = host.catalog.sessionNodes(lineageKey);
	const cutoff = host.retentionCutoff();
	return (
		!!selection &&
		!!nodes &&
		selection.nodeIds.some((id) => {
			const node = nodes.get(id);
			const refusal = node && host.catalog.readRefusal(node, cutoff);
			return refusal === "expired" || refusal === "age_unknown";
		})
	);
}

export function frontierEvidenceOf(
	host: Pick<CoordinatorHost, "frontierRead" | "catalog">,
	nodeIds: readonly string[],
	selection: TranscriptFrontierSelection,
	sourceHandles: readonly string[],
): MemoryReadEvidence | undefined {
	const held = host.frontierRead;
	if (!held || held.selection !== selection) return undefined;
	const nodes = nodeIds.map((id) => host.catalog.get(id));
	if (nodes.some((node) => node === undefined)) return undefined;
	const evidence = host.catalog.evidence(
		nodes as TranscriptSummaryNode[],
		held.observation,
		held.context,
		held.fence,
		{ sourceHandles: sourceHandles.filter((ref) => ref.startsWith("tx:")) },
	);
	return evidence.isCurrent() ? evidence : undefined;
}

export function computeFrontierSelection(
	host: Pick<CoordinatorHost, "catalog" | "runtime" | "ports" | "frontiers">,
	sessionId: string,
	extra?: TranscriptSummaryNode,
) {
	// The catalog owns the approved ordered index. A not-yet-published candidate is a read-only overlay and cannot
	// change the live index if persistence refuses the transaction.
	const hasUnapproved = host.catalog.hasUnapproved(sessionId);
	const total = host.runtime.get(sessionId)?.total;
	return selectFrontier({
		sessionId,
		index: host.catalog.frontierIndex(sessionId, extra),
		allowanceBytes: host.ports.settings().frontierMaxBytes,
		...(host.frontiers.get(sessionId)
			? { previous: host.frontiers.get(sessionId) as TranscriptFrontierSelection }
			: {}),
		...(total !== undefined
			? {
					tail: {
						toIndexExclusive: total,
						reason: hasUnapproved
							? "summaries pending, awaiting admission, or not yet captured"
							: "summaries pending or not yet captured",
					},
				}
			: {}),
	});
}

export function frontierNotAdmittedAt(
	host: Pick<CoordinatorHost, "frontiers" | "catalog">,
	lineageKey: string,
): boolean {
	const selection = host.frontiers.get(lineageKey);
	const nodes = host.catalog.sessionNodes(lineageKey);
	return !!selection && !!nodes && selection.nodeIds.some((id) => !host.catalog.isApproved(nodes.get(id)));
}

export function isNodeDenied(
	host: Pick<CoordinatorHost, "forgottenSessions" | "catalog" | "nodeDenied">,
	node: TranscriptSummaryNode,
	seen: Set<string> = new Set(),
): boolean {
	if (host.forgottenSessions.size === 0) return false;
	if (namesForgottenSession(node, host.forgottenSessions)) return true;
	for (const childId of node.children ?? []) {
		if (seen.has(childId)) continue;
		seen.add(childId);
		const child = host.catalog.get(childId);
		if (child !== undefined && host.nodeDenied(child, seen)) return true;
	}
	return false;
}
