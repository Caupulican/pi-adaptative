/**
 * Re-admission flow of the transcript memory coordinator: the accepted summaries that await re-judgment, the wait
 * each unapproved node reports, and the steps that enqueue and judge a node again.
 */

import { createHash } from "node:crypto";
import type { CoordinatorHost } from "./transcript-coordinator-host.ts";
import type { JobOutcome, SourceReadFailure } from "./transcript-job-outcome.ts";
import type { TranscriptReadmissionWait } from "./transcript-memory-status.ts";
import {
	needsReadmission,
	summaryTextDigest,
	TRANSCRIPT_SUMMARY_ADMISSION_CONTRACT_VERSION,
} from "./transcript-summary-admission.ts";
import type { TranscriptSummaryNode } from "./transcript-summary-node.ts";
import {
	readmissionJobKey,
	type TranscriptSummaryClaimToken,
	type TranscriptSummaryJob,
} from "./transcript-summary-scheduler.ts";

/**
 * The body of a re-admission job under its claim: re-read the node's sources (or its approved children), judge the
 * exact text once (or reuse the kept paid verdict), and hand the judgment to {@link settleReadmitted}. A node that is
 * gone ends the job stale. A revocation that replaced the node ends its readmission jobs first (endRevokedReadmissions), so a job never judges the text of a rebuilt node: its identity names the text it judges. A node already approved (its
 * admission was made durable before a stop) completes the job ready with its attempt returned, without a call.
 */
export async function readmitSummaryNode(
	host: Pick<
		CoordinatorHost,
		"ports" | "catalog" | "nodeDenied" | "modelWorkBlock" | "readmissionRequest" | "setReadmission" | "judge"
	>,
	job: TranscriptSummaryJob,
	token: TranscriptSummaryClaimToken,
	signal: AbortSignal,
): Promise<JobOutcome> {
	const port = host.ports.admission;
	const node = job.nodeId !== undefined ? host.catalog.get(job.nodeId) : undefined;
	if (!node) return { kind: "stale", reason: "the summary is gone" };
	// Approved already: the admission of this identity was made durable before the job could settle (a stop in between).
	if (!needsReadmission(node)) return { kind: "approved" };
	if (host.nodeDenied(node)) return { kind: "stale", reason: "the summary belongs to a forgotten session" };
	if (!port) return { kind: "held", scope: "model_work", reason: "no summary admission evaluator is configured" };
	const block = host.modelWorkBlock();
	if (block !== undefined) return { kind: "held", scope: "model_work", reason: block.reason };
	const prepared = await host.readmissionRequest(node, signal);
	if (prepared === undefined || signal.aborted) return { kind: "aborted" };
	if ("wait" in prepared) {
		host.setReadmission(node.id, "waiting", prepared.wait);
		switch (prepared.wait) {
			case "child_not_approved":
				return { kind: "held", scope: "children", reason: "a child summary is not approved yet" };
			case "source_unreadable":
			case "store_unavailable":
				return {
					kind: "fail",
					failure: {
						kind: "transient",
						reason: "source_not_ready",
						message: `re-admission waits: ${prepared.wait}`,
					},
				};
			case "source_read_refused":
				return {
					kind: "fail",
					failure: {
						kind: "policy",
						reason: "source_read_refused",
						message: "the source read was refused for good",
					},
				};
			default:
				// The sources changed or cannot be used for this exact text: the identity is spent. A finished (failed)
				// job is remembered with its budget, so the same node is not judged again at once; a stale job would be.
				return {
					kind: "fail",
					failure: {
						kind: "policy",
						reason: `readmission_${prepared.wait}`,
						message: `re-admission cannot proceed: ${prepared.wait}`,
					},
				};
		}
	}
	const inputDigest = createHash("sha256").update(JSON.stringify(prepared.request), "utf8").digest("hex");
	const judged = await host.judge(job, token, port, prepared.request, inputDigest, signal);
	if ("outcome" in judged) return judged.outcome;
	return { kind: "readmitted", node, result: judged.result, reused: judged.reused, inputDigest };
}

export function enqueueReadmissionJobs(
	host: Pick<
		CoordinatorHost,
		"scheduler" | "ports" | "writer" | "modelWorkBlock" | "readmissionCandidates" | "noteEnqueued" | "markJobsDirty"
	>,
): void {
	const scheduler = host.scheduler;
	if (!scheduler || !host.ports.admission || !host.writer || host.modelWorkBlock() !== undefined) return;
	for (const node of host.readmissionCandidates()) {
		const result = scheduler.enqueueReadmission(
			{
				nodeId: node.id,
				sessionId: node.sessionId,
				level: node.level,
				ordinal: node.ordinal,
				spanRange: { fromIndex: node.spanRange.fromIndex, toIndexExclusive: node.spanRange.toIndexExclusive },
				contractVersion: TRANSCRIPT_SUMMARY_ADMISSION_CONTRACT_VERSION,
				recipeVersion: node.recipeVersion,
				textDigest: summaryTextDigest(node.text),
			},
			host.ports.now(),
		);
		if (result.status === "created") {
			host.noteEnqueued();
			host.markJobsDirty();
		} else if (result.status !== "exists") break;
	}
}

/** Accepted model summaries without a current admission, children before parents. */
export function readmissionCandidatesOf(
	host: Pick<CoordinatorHost, "catalog" | "forgottenSessions">,
): TranscriptSummaryNode[] {
	return host.catalog
		.needingReadmission()
		.filter((node) => !host.catalog.deniedByForget(node, host.forgottenSessions))
		.sort((a, b) => a.level - b.level || a.ordinal - b.ordinal);
}

export function unapprovedWaitOf(
	host: Pick<CoordinatorHost, "catalog" | "readmissionState" | "readmissionFailed">,
	node: TranscriptSummaryNode,
): TranscriptReadmissionWait | undefined {
	const approval = host.catalog.approval(node);
	if (approval.approved) return undefined;
	if (approval.reason === "child_not_approved") return "child_not_approved";
	if (approval.reason === "text_changed") return "admission_mismatch";
	const hold = host.readmissionState.get(node.id);
	if (hold?.state === "rejected") return "judged_rejected";
	if (hold?.state === "uncertain") return "judged_uncertain";
	// An outage is a wait only while its job still retries: a job that ended failed has spent its identity for good.
	if (hold?.state === "unavailable" && !host.readmissionFailed(node)) return "evaluator_unavailable";
	// A job that ended failed spent its identity: that outranks the wait it last reported while it still retried.
	if (host.readmissionFailed(node)) return "readmission_failed";
	return hold?.wait ?? "not_yet_judged";
}

/**
 * Whether this node's re-admission job ended failed. Read from the scheduler, not from the hold, so it holds after a
 * restart (the holds are per run) and for an outage that exhausted the job's attempts.
 */
export function readmissionFailedOf(host: Pick<CoordinatorHost, "scheduler">, node: TranscriptSummaryNode): boolean {
	const identity = readmissionJobKey(
		node.id,
		TRANSCRIPT_SUMMARY_ADMISSION_CONTRACT_VERSION,
		summaryTextDigest(node.text),
		node.recipeVersion,
	);
	return host.scheduler?.get(identity)?.state === "failed";
}

export function readmissionSourceWaitOf(
	host: Pick<CoordinatorHost, "readmissionWait">,
	node: TranscriptSummaryNode,
	outcome: SourceReadFailure,
): TranscriptReadmissionWait {
	if (outcome.kind === "stale") return host.readmissionWait(node, "source_coverage_changed", outcome.reason);
	return host.readmissionWait(
		node,
		outcome.failure.kind === "transient" ? "source_unreadable" : "source_read_refused",
		outcome.failure.message,
	);
}

export function readmissionWaitOf(
	host: Pick<CoordinatorHost, "noteInternalCause" | "noteBenignEvent">,
	node: TranscriptSummaryNode,
	wait: TranscriptReadmissionWait,
	cause: string,
): TranscriptReadmissionWait {
	// A wait is a normal state of the judgment, not a fault: it is an event, and never overwrites the active fault cause.
	// A permanent refusal of a source read is a fault.
	const record = `re-admission of ${node.id.slice(0, 16)}: ${cause}`;
	if (wait === "source_read_refused") host.noteInternalCause(record);
	else host.noteBenignEvent(record);
	return wait;
}

export function readmissionWriteFailure(
	host: Pick<CoordinatorHost, "readmissionWait" | "live" | "catalog" | "setReadmission">,
	node: TranscriptSummaryNode,
	epoch: number,
	cause: string,
	transient: boolean,
): void {
	const wait = host.readmissionWait(node, transient ? "store_unavailable" : "judgment_discarded", cause);
	if (!host.live(epoch) || host.catalog.get(node.id) !== node) return;
	host.setReadmission(node.id, "waiting", wait);
}
