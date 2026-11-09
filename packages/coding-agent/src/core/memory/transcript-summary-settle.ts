/**
 * Settlement of summary jobs in the transcript memory coordinator: how a claimed job's result is published or
 * failed, the dependency reads a publication is checked against, and the run of one job from claim to settlement.
 */

import type { CoordinatorHost } from "./transcript-coordinator-host.ts";
import type { DependencyVerdict, JobOutcome } from "./transcript-job-outcome.ts";
import type { TranscriptLineageSpansResult } from "./transcript-memory-contracts.ts";
import type { TranscriptSummarizerPort } from "./transcript-memory-ports.ts";
import { coversLiveSpans } from "./transcript-summary-catalog.ts";
import type { TranscriptSummaryNode } from "./transcript-summary-node.ts";
import type {
	TranscriptSummaryClaimToken,
	TranscriptSummaryFailure,
	TranscriptSummaryJob,
} from "./transcript-summary-scheduler.ts";
import { storeUnavailable } from "./transcript-summary-store.ts";

/** A failure of the summarizer call itself, carrying the provider it came from for the one failure classifier. */
export class SummarizerCallError extends Error {
	readonly provider: string | undefined;
	constructor(model: string, cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		const slash = model.indexOf("/");
		this.provider = slash > 0 ? model.slice(0, slash) : undefined;
	}
}

export function settleJobFailure(
	host: Pick<CoordinatorHost, "scheduler" | "recordFailure" | "countTerminal">,
	job: TranscriptSummaryJob,
	outcome: Extract<JobOutcome, { kind: "stale" | "fail" }>,
	now: number,
	returnClaim = false,
): void {
	const scheduler = host.scheduler;
	if (!scheduler) return;
	if (outcome.kind === "stale") {
		scheduler.markStale(job.id, now);
		host.recordFailure(job, "stale", outcome.reason);
		host.countTerminal("stale");
		return;
	}
	const next = scheduler.failJob(job.id, outcome.failure, now, { returnClaim });
	if (next?.state === "failed") {
		host.recordFailure(job, next.lastError?.reason ?? outcome.failure.kind, outcome.failure.message);
		host.countTerminal("failed", job, next.lastError?.reason ?? outcome.failure.kind, outcome.failure.message);
	}
}

export function settleAbortedJob(
	host: Pick<CoordinatorHost, "started" | "epoch" | "scheduler" | "ports">,
	token: TranscriptSummaryClaimToken,
	epoch: number,
): void {
	if (host.started && epoch === host.epoch && host.scheduler?.ownsClaim(token)) {
		host.scheduler.interrupt(token.jobId, host.ports.now());
	}
}

export function thrownPublicationFailureOf(
	host: Pick<CoordinatorHost, "noteInternalCause">,
	what: string,
	error: unknown,
): TranscriptSummaryFailure {
	const unavailable = storeUnavailable(what, error);
	const failure: TranscriptSummaryFailure = unavailable
		? { kind: "transient", reason: "store_unavailable", message: unavailable.reason }
		: {
				kind: "internal",
				reason: "internal_error",
				message: `${what} failed: ${error instanceof Error ? error.message : String(error)}`,
			};
	host.noteInternalCause(failure.message);
	return failure;
}

export function settlePublicationFailureOf(
	host: Pick<CoordinatorHost, "live" | "settleAborted" | "scheduler" | "settleFailure" | "ports" | "returnsClaim">,
	job: TranscriptSummaryJob,
	token: TranscriptSummaryClaimToken,
	epoch: number,
	paidCall: boolean,
	failure: TranscriptSummaryFailure,
): void {
	if (!host.live(epoch)) {
		host.settleAborted(token, epoch);
		return;
	}
	if (!host.scheduler?.ownsClaim(token)) return;
	host.settleFailure(job, { kind: "fail", failure }, host.ports.now(), host.returnsClaim(job, paidCall));
}

export async function readLiveDependencyOf(
	host: Pick<CoordinatorHost, "catalog" | "ports" | "failureFor">,
	node: TranscriptSummaryNode,
): Promise<DependencyVerdict> {
	const dependency = host.catalog.dependency(node);
	if (dependency?.kind !== "range")
		return { kind: "not_covered", reason: "its dependency cannot be verified against the lineage" };
	const live = await host.ports.reader.listLineageSpans({
		sessionId: node.sessionId,
		fromIndex: dependency.fromIndex,
		maxSpans: dependency.refs.length,
	});
	if (live.status === "ok") {
		return coversLiveSpans(live, dependency.refs)
			? { kind: "covered", live }
			: { kind: "not_covered", reason: "the covered spans or their context changed" };
	}
	const outcome = host.failureFor(live);
	return outcome.kind === "fail" ? { kind: "unanswered", outcome } : { kind: "not_covered", reason: outcome.reason };
}

export async function readPublishedDependencyOf(
	host: Pick<
		CoordinatorHost,
		"readLiveDependency" | "live" | "settleAborted" | "scheduler" | "settleFailure" | "ports" | "returnsClaim"
	>,
	job: TranscriptSummaryJob,
	token: TranscriptSummaryClaimToken,
	node: TranscriptSummaryNode,
	epoch: number,
	paidCall: boolean,
): Promise<Extract<TranscriptLineageSpansResult, { status: "ok" }> | undefined> {
	const verdict = await host.readLiveDependency(node);
	if (!host.live(epoch)) {
		host.settleAborted(token, epoch);
		return undefined;
	}
	if (!host.scheduler?.ownsClaim(token)) return undefined;
	if (verdict.kind === "covered") return verdict.live;
	host.settleFailure(
		job,
		verdict.kind === "unanswered" ? verdict.outcome : { kind: "stale", reason: `${verdict.reason} (at publication)` },
		host.ports.now(),
		host.returnsClaim(job, paidCall),
	);
	return undefined;
}

export function returnsClaimOf(
	host: Pick<CoordinatorHost, "scheduler">,
	job: TranscriptSummaryJob,
	paidCall: boolean,
): boolean {
	return !paidCall && host.scheduler?.get(job.id)?.pendingReply !== undefined;
}

export function afterTerminalOf(
	host: Pick<CoordinatorHost, "markJobsDirty" | "resumeDeferredEnumeration" | "pump" | "maybeFinishBatch">,
	job: TranscriptSummaryJob,
	epoch: number,
): void {
	host.markJobsDirty();
	host.resumeDeferredEnumeration(job.sessionId, epoch);
	host.pump(epoch);
	host.maybeFinishBatch();
}

export async function runSummaryJob(
	host: Pick<CoordinatorHost, "forgetDenial" | "readmitNode" | "buildLeaf" | "buildParent" | "live">,
	job: TranscriptSummaryJob,
	token: TranscriptSummaryClaimToken,
	summarizer: TranscriptSummarizerPort,
	signal: AbortSignal,
	epoch: number,
): Promise<JobOutcome> {
	try {
		// The permanent forget state is confirmed at the provider boundary: a session another root forgot (or whose
		// state cannot be read) never reaches a summarizer.
		const denial = await host.forgetDenial(job.sessionId, epoch);
		if (denial !== undefined) return denial;
		const outcome =
			job.kind === "readmission"
				? await host.readmitNode(job, token, signal)
				: job.kind === "leaf"
					? await host.buildLeaf(job, token, summarizer, signal)
					: await host.buildParent(job, token, summarizer, signal);
		return signal.aborted || !host.live(epoch) ? { kind: "aborted" } : outcome;
	} catch (error) {
		if (signal.aborted) return { kind: "aborted" };
		// A failure of the summarizer call names its originating provider (its `provider/id` model) to the one failure
		// classifier, so that provider's signatures decide what is retryable; any other failure (the evaluator, a
		// source read) is classified provider-neutral.
		const provider = error instanceof SummarizerCallError ? error.provider : undefined;
		return {
			kind: "fail",
			failure: {
				kind: "provider",
				message: error instanceof Error ? error.message : String(error),
				...(provider !== undefined ? { provider } : {}),
			},
		};
	}
}

/**
 * Whether the permanent forget state denies this session now, read from the store (the one owner of that state)
 * before any paid call. A forgotten session ends the job stale and the mirror removes its derived data; a state
 * that cannot be read holds the job before any call, never reading as "nothing forgotten".
 */
export async function forgetDenialOf(
	host: Pick<
		CoordinatorHost,
		"ports" | "forgetRevision" | "live" | "forgottenSessions" | "abortSession" | "queueForgetRefresh"
	>,
	sessionId: string,
	epoch: number,
): Promise<JobOutcome | undefined> {
	const read = await host.ports.store.readForgottenSessions();
	if (read.status !== "ok") {
		return {
			kind: "held",
			scope: "persistence",
			reason: `the permanent forget state could not be confirmed (${read.status}: ${read.reason})`,
		};
	}
	// A job of a stopped generation never adopts state or queues work into the generation that replaced it.
	if (read.revision !== host.forgetRevision && host.live(epoch)) {
		// What the store says is denied now holds for this claim at once (every guard below reads this set) and stops the
		// work already running on it; the removal of the derived data follows on the mailbox.
		const fresh = [...read.sessions].filter((forgotten) => !host.forgottenSessions.has(forgotten));
		for (const forgotten of fresh) host.forgottenSessions.add(forgotten);
		for (const forgotten of fresh) host.abortSession(forgotten);
		host.queueForgetRefresh(epoch);
	}
	if (!read.sessions.has(sessionId)) return undefined;
	return { kind: "stale", reason: `session ${sessionId} was forgotten` };
}
