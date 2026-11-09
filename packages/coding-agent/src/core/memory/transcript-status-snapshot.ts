/**
 * Status snapshot of the transcript memory coordinator: the diagnostics view assembled from its state (phase, job
 * counts, frontiers, retention, admission and held work), and the admission and hold views it includes.
 */

import { MAX_STATUS_BATCHES } from "./transcript-batch-account.ts";
import type { CoordinatorHost } from "./transcript-coordinator-host.ts";
import { isTerminalSummaryJobState } from "./transcript-memory-contracts.ts";
import { bounded, MAX_HELD_REASON_CHARS } from "./transcript-memory-reason-text.ts";
import type {
	TranscriptMemoryAdmissionStatus,
	TranscriptMemoryFrontierStatus,
	TranscriptMemoryModelWorkBlock,
	TranscriptMemoryStatus,
	TranscriptReadmissionWait,
} from "./transcript-memory-status.ts";
import {
	admissionEgressBlocked,
	TRANSCRIPT_SUMMARY_ADMISSION_CONTRACT_VERSION,
} from "./transcript-summary-admission.ts";
import { TRANSCRIPT_SUMMARY_MAX_SPENT_ATTEMPTS } from "./transcript-summary-scheduler.ts";

const MAX_STATUS_FRONTIERS = 20;

export function statusSnapshot(
	host: Pick<
		CoordinatorHost,
		| "run"
		| "frontiers"
		| "frontierBytes"
		| "catalog"
		| "ports"
		| "nextRetentionAt"
		| "batch"
		| "admissionStatus"
		| "sessions"
		| "proofLedger"
		| "lastRevocation"
		| "causes"
	>,
): TranscriptMemoryStatus {
	const counts = host.run.scheduler?.counts() ?? {
		queued: 0,
		running: 0,
		ready: 0,
		retry_wait: 0,
		failed: 0,
		cancelled: 0,
		stale: 0,
	};
	let oldest: number | undefined;
	for (const job of host.run.scheduler?.snapshot() ?? []) {
		if (isTerminalSummaryJobState(job.state)) continue;
		if (oldest === undefined || job.createdAt < oldest) oldest = job.createdAt;
	}
	const frontiers: TranscriptMemoryFrontierStatus[] = [...host.frontiers.entries()]
		.sort((a, b) => b[1].revision - a[1].revision)
		.slice(0, MAX_STATUS_FRONTIERS)
		.map(([lineageKey, selection]) => {
			const measured = host.frontierBytes.get(lineageKey);
			return {
				lineageKey,
				revision: selection.revision,
				bytes: measured?.bytes ?? 0,
				nodeCount: selection.nodeIds.length,
				omittedBeforeIndex: selection.omittedBeforeIndex,
				coveredThroughIndex: selection.coveredThroughIndex,
				...(measured?.gap ? { gap: measured.gap } : {}),
			};
		});
	const aged = host.catalog.agedNodeCount();
	const anchored = host.catalog.anchorCounts();
	const retentionDays = host.ports.settings().retentionDays;
	const nextDeadlineAt = host.nextRetentionAt();
	let pendingParents = 0;
	for (const job of host.run.scheduler?.snapshot() ?? []) {
		if (job.kind === "parent" && !isTerminalSummaryJobState(job.state)) pendingParents += 1;
	}
	return {
		enabled: host.run.started,
		phase: host.run.starting
			? "starting"
			: host.run.started
				? "running"
				: host.run.scheduler || host.run.disabledReason
					? "stopped"
					: "off",
		...(host.run.disabledReason ? { disabledReason: host.run.disabledReason } : {}),
		counts,
		...(oldest !== undefined ? { oldestBacklogAgeMs: Math.max(0, host.ports.now() - oldest) } : {}),
		recentFailures: [...host.batch.recentFailures],
		recoveryIssues: [...host.run.recoveryIssues],
		acceptedNodes: host.catalog.size,
		catalogBytes: [...host.catalog.values()].reduce((total, node) => total + node.bytes, 0),
		nodesAgedByAnchor: aged,
		admission: host.admissionStatus(),
		retention: {
			scope: "derived_summaries_only",
			...(retentionDays !== undefined ? { days: retentionDays } : {}),
			...(nextDeadlineAt !== undefined ? { nextDeadlineAt } : {}),
			eventTimeUnknownSources: anchored.firstCapture,
			sessionTimestampSources: anchored.sessionTimestamp,
			heldForAnchor: host.sessions.anchorHeldCount,
		},
		pendingParentRederivations: pendingParents,
		spentAttempts: {
			recorded: host.proofLedger.recorded,
			reserved: host.proofLedger.reserved,
			bound: TRANSCRIPT_SUMMARY_MAX_SPENT_ATTEMPTS,
			...(host.proofLedger.hold ? { hold: { ...host.proofLedger.hold } } : {}),
		},
		...(host.lastRevocation ? { lastRevocation: { ...host.lastRevocation } } : {}),
		frontierCount: host.frontiers.size,
		frontiers,
		recentBatches: host.batch.persistedBatches.slice(-MAX_STATUS_BATCHES),
		...(host.causes.last ? { lastInternalError: { ...host.causes.last } } : {}),
		...(host.causes.active ? { activeCause: { ...host.causes.active } } : {}),
	};
}

export function admissionStatusSnapshot(
	host: Pick<CoordinatorHost, "holds" | "modelWorkBlock" | "catalog" | "unapprovedWait" | "batch" | "run">,
): TranscriptMemoryAdmissionStatus {
	host.holds.prune((id) => host.run.scheduler?.get(id)?.state);
	const blocked = host.modelWorkBlock();
	let unapproved = 0;
	const waitingFor: Partial<Record<TranscriptReadmissionWait, number>> = {};
	for (const node of host.catalog.values()) {
		const wait = host.unapprovedWait(node);
		if (wait === undefined) continue;
		unapproved += 1;
		waitingFor[wait] = (waitingFor[wait] ?? 0) + 1;
	}
	const readmission = { admitted: 0, rejected: 0, uncertain: 0, unavailable: 0 };
	for (const { state } of host.holds.readmission.values()) if (state !== "waiting") readmission[state] += 1;
	const held = host.holds.first();
	return {
		contractVersion: TRANSCRIPT_SUMMARY_ADMISSION_CONTRACT_VERSION,
		...(blocked ? { blocked } : {}),
		heldJobs: host.holds.parked.size,
		...(held
			? {
					heldKind: held.scope,
					heldReason: bounded(held.reason, MAX_HELD_REASON_CHARS),
					heldByKind: host.holds.counts(),
				}
			: {}),
		judgments: { ...host.batch.judgments },
		reused: host.batch.reusedAdmissions,
		unapprovedNodes: unapproved,
		work: host.run.scheduler?.workCounts() ?? {
			logicalAttempts: 0,
			semanticRequests: 0,
			transportAttempts: 0,
			receiptsRecorded: 0,
			receiptsPending: 0,
			receiptsLost: 0,
			reused: 0,
		},
		readmission: { ...readmission, waitingFor },
	};
}

export function modelWorkBlockOf(
	host: Pick<CoordinatorHost, "ports" | "egressBlocked">,
): TranscriptMemoryModelWorkBlock | undefined {
	const summarizer = host.ports.summarizer;
	if (!summarizer) return { kind: "no_summarizer", reason: "no summarizer is configured" };
	const settings = host.ports.settings();
	const summaryBlocked = host.egressBlocked(summarizer);
	if (summaryBlocked) return { kind: "summary_egress_not_allowed", reason: summaryBlocked };
	const port = host.ports.admission;
	if (!port) {
		return {
			kind: "no_admission_evaluator",
			reason: "no summary admission evaluator is configured, so model summaries are held (exact copies still flow)",
		};
	}
	const egress = admissionEgressBlocked(port, settings.allowExternalAdmissionEgress);
	if (egress) return { kind: "admission_egress_not_allowed", reason: egress };
	const unavailable = port.availability();
	if (unavailable) {
		return {
			kind: unavailable.cause === "not_bound" ? "admission_not_bound" : "admission_not_calibrated",
			reason: unavailable.reason,
		};
	}
	return undefined;
}
