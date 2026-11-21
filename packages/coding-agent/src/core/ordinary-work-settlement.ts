/** Settles a live stop or recovered ordinary request against its canonical receipts while the foreground owns dispatch. */
import type { AssistantMessage } from "@caupulican/pi-ai";
import { assistantAnswerTextParts } from "../kernel/assistant-answer.ts";
import type { AgentMessage } from "../kernel/types.ts";
import { RUNAWAY_STOP_CUSTOM_TYPE } from "./agent-session-contracts.ts";
import { containsStatedOwnerQuote } from "./learning/owner-evidence-ledger.ts";
import { ordinaryCompletionReports } from "./ordinary-work-completions.ts";
import type { OrdinaryWorkController, OrdinaryWorkRecord } from "./ordinary-work-controller.ts";
import {
	ORDINARY_REPORTING_RESERVATION,
	ORDINARY_WORK_CONTINUATION_TYPE,
	ORDINARY_WORK_EVIDENCE_CHARS,
	ORDINARY_WORK_MAX_CONTINUATIONS,
	type OrdinaryWorkStopEvidence,
} from "./ordinary-work-policy.ts";
import { awaitsLaunchedWork, ORDINARY_WORK_WORKER_WAIT_MS } from "./ordinary-work-wait.ts";
import { ownerRequestForJudge } from "./security/owner-paste-boundary.ts";
import { wrapUntrustedText } from "./security/untrusted-boundary.ts";
import { withinPlanRequestBound } from "./system-one/plan-request-bound.ts";
import type { SettlementJudges } from "./system-one/settlement-judges.ts";
import { toolResultEvidence } from "./system-one/unsettled-ladder.ts";
import { type RunTurnOrigin, turnOriginOf } from "./turn-origin.ts";

interface ReviewOptions {
	expected: OrdinaryWorkRecord;
	signal: AbortSignal;
	mayDispatch(): boolean;
	warn(message: string): void;
	atRoundCap?: boolean;
	answer?: AssistantMessage;
	missingFinal?: boolean;
	requireFreshCompletion?: boolean;
}

function visibleAnswer(message: AssistantMessage | undefined): string {
	return assistantAnswerTextParts(message).join("\n");
}

export async function reviewOrdinaryWork(
	work: OrdinaryWorkController,
	judges: Pick<SettlementJudges, "decideOrdinaryWorkStop">,
	options: ReviewOptions,
): Promise<AgentMessage | undefined> {
	const { expected, signal, mayDispatch, warn } = options;
	if (signal.aborted || !mayDispatch()) return;
	const evidence = work.evidence(expected);
	if (!evidence) return;
	const awaiting = awaitsLaunchedWork(expected);
	if (expected.status === "waiting" && !awaiting) return;
	const { reports, fresh } = ordinaryCompletionReports(evidence);
	// A request waiting on work it launched is reviewed for new evidence, or once its wait on that work ran out.
	const waitExpired = expected.status === "waiting" && work.workerWaitExpired(evidence);
	if (!fresh && ((awaiting && !waitExpired) || options.requireFreshCompletion)) return;
	const tail = evidence.messages.at(-1);
	const terminal = tail?.role === "assistant" ? tail : undefined;
	const answer = !options.missingFinal && terminal?.stopReason === "stop" ? terminal : undefined;
	const text = visibleAnswer(answer);
	if (
		options.answer &&
		(!terminal ||
			terminal.timestamp !== options.answer.timestamp ||
			terminal.provider !== options.answer.provider ||
			terminal.model !== options.answer.model ||
			terminal.stopReason !== options.answer.stopReason ||
			visibleAnswer(terminal) !== visibleAnswer(options.answer))
	)
		return;
	if (expected.reason === ORDINARY_REPORTING_RESERVATION && !work.reportingRevision(expected)) {
		work.checkpoint(expected, { status: "unverified", reason: "reporting_changed" });
		return;
	}
	const held = work.beginReview(expected);
	if (!held) return;
	if (!evidence.request.trim() || evidence.unavailableAttachmentEntryIds.length > 0) {
		work.checkpoint(held, { status: "unverified", reason: "owner_evidence_unavailable" });
		return;
	}
	if (evidence.entries.some((e) => e.type === "custom" && e.customType === RUNAWAY_STOP_CUSTOM_TYPE)) {
		work.checkpoint(held, { status: "unverified", reason: "kernel_runaway_stop" });
		return;
	}
	if (evidence.unresolvedToolCallIds.length || evidence.lifecycle.refusalReasons.length) {
		if (work.checkpoint(held, { status: "unverified", reason: "ambiguous_execution_receipt" }))
			warn("The request remains open. Its execution record is ambiguous, so automatic continuation stopped.");
		return;
	}
	// A worker this request launched still owes its result: a host fact, so the request waits without a judgment.
	const pendingLaunched = work.pendingLaunchedWork(evidence);
	if (pendingLaunched !== undefined && pendingLaunched > 0) {
		if (!waitExpired) {
			const waiting = work.checkpoint(held, {
				status: "waiting",
				reason: "waiting",
				frontierEntryId: evidence.entries.at(-1)?.id,
			});
			if (waiting) work.armWorkerWait(waiting, evidence.entries);
			return;
		}
		// Its wait ran out, also a host fact: one continuation checks on the work; with none left the owner decides.
		const reserved = work.reserveContinuation(held);
		if (reserved) return workerWaitContinuation(reserved);
		work.checkpoint(held, {
			status: "owner_needed",
			reason: "worker_wait_exhausted",
			frontierEntryId: evidence.entries.at(-1)?.id,
		});
		return;
	}
	const resultCount = evidence.messages.filter((message) => message.role === "toolResult").length;
	const note =
		"Only the listed receipts are evidence. Omitted results cannot establish success, failure, or missing work.";
	const label = "Background reports from the matching producers:";
	let available = ORDINARY_WORK_EVIDENCE_CHARS - note.length - label.length - 4;
	const background: string[] = [];
	for (let i = reports.length - 1; i >= 0; i--) {
		const report = reports[i]!;
		if (report.length + 1 > available) continue;
		background.push(report);
		available -= report.length + 1;
	}
	const complete = toolResultEvidence(evidence.messages, available).results.filter((receipt) => receipt.complete);
	const receiptParts = complete.length < resultCount || reports.length > background.length ? [note] : [];
	const receiptSources: NonNullable<OrdinaryWorkStopEvidence["receiptSources"]>[number][] = [];
	let receiptOffset = receiptParts.length ? note.length + 1 : 0;
	for (const receipt of complete) {
		if (receipt.source)
			receiptSources.push({
				callId: receipt.source.callId,
				receiptStart: receiptOffset,
				resultStart: receiptOffset + receipt.source.resultOffset,
				resultEnd: receiptOffset + receipt.text.length,
			});
		receiptParts.push(receipt.text);
		receiptOffset += receipt.text.length + 1;
	}
	if (background.length) receiptParts.push(label, ...background.reverse());
	const reporting = text.trim() ? work.reportingRequirements() : undefined;
	if (
		expected.reason === ORDINARY_REPORTING_RESERVATION &&
		(!text.trim() || !reporting?.complete || !reporting.requirements.length)
	) {
		work.checkpoint(held, { status: "unverified", reason: "reporting_unverified" });
		return;
	}
	const latestOwner = evidence.ownerInputs.at(-1);
	const projection: OrdinaryWorkStopEvidence = {
		...(reporting && (!reporting.complete || reporting.requirements.length)
			? {
					reporting,
					...(latestOwner && evidence.ownerInputs.length > 1
						? { latestOwnerRequest: ownerRequestForJudge(latestOwner.words) ?? "" }
						: {}),
					isCurrentOwnerQuote: (quote: string) =>
						Boolean(latestOwner?.sourceId && containsStatedOwnerQuote(latestOwner.words, quote)),
				}
			: {}),
		request: evidence.request,
		answer: text,
		hasCompleteReceipt: complete.length > 0,
		receiptSources,
		hostFacts: {
			interrupted: expected.reason === "process_interrupted" || terminal?.stopReason === "aborted",
			terminalStopReason: terminal?.stopReason ?? "missing",
			finalAnswerPresent: text.trim().length > 0,
			foregroundCallsSettled: true,
			foregroundReceipts: { recorded: resultCount, included: complete.length },
			backgroundReports: { recorded: reports.length, included: background.length },
			pendingBackgroundWork: pendingLaunched === undefined ? "not_checked" : "workers_reported",
		},
		receipts: receiptParts.join("\n"),
	};
	const count = options.atRoundCap ? ORDINARY_WORK_MAX_CONTINUATIONS : held.continuationCount;
	const judgment =
		(await withinPlanRequestBound((bounded) => judges.decideOrdinaryWorkStop(projection, count, bounded), {
			deadline: signal,
		})) ?? "review_timed_out";
	if (signal.aborted || !work.isCurrent(held)) return;
	if (!mayDispatch()) {
		work.checkpoint(held, { status: "unverified", reason: "review_superseded" });
		return;
	}
	if (
		expected.reason === ORDINARY_REPORTING_RESERVATION &&
		typeof judgment === "object" &&
		!judgment.missingReportingIds
	) {
		work.checkpoint(held, { status: "unverified", reason: "reporting_unverified" });
		return;
	}
	if (typeof judgment === "string") {
		const reason = judgment === "unverified" && text.trim().length > 0 ? "answer_recorded_unverified" : judgment;
		const status =
			reason === "fulfilled" || reason === "waiting" || reason === "owner_needed" ? reason : "unverified";
		if (
			work.checkpoint(held, { status, reason, frontierEntryId: evidence.entries.at(-1)?.id, reporting }) &&
			(reason === "held" || reason === "limited")
		)
			warn(
				reason === "limited"
					? "The request remains open. It reached its automatic continuation limit."
					: "The request remains open. The independent reviewer stopped further attempts.",
			);
		return;
	}
	let revision: { snapshot: NonNullable<typeof reporting>; text: string } | undefined;
	if (judgment.missingReportingIds) {
		const ids = new Set(judgment.missingReportingIds);
		const rules = reporting?.requirements.filter((rule) => ids.has(rule.id));
		if (
			!reporting?.complete ||
			!rules?.length ||
			rules.length !== ids.size ||
			judgment.responseMode !== "answer_only"
		) {
			work.checkpoint(held, { status: "unverified", reason: "reporting_unverified" });
			return;
		}
		revision = {
			snapshot: reporting,
			text: wrapUntrustedText(JSON.stringify(rules.map((rule) => rule.text)), "confirmed-reporting-requirements"),
		};
	}
	const reserved = work.reserveContinuation(held, judgment.responseMode, revision);
	if (!reserved) return;
	return {
		role: "custom",
		customType: ORDINARY_WORK_CONTINUATION_TYPE,
		display: false,
		content: revision
			? "Revise the presentation of your preceding answer using the applicable confirmed reporting requirements supplied for this turn. Preserve the supported facts. Current owner instructions take precedence. This turn has no tools."
			: judgment.responseMode === "answer_only"
				? "Answer the original request using its recorded results. Follow the reporting preferences the owner has already given. This turn has no tools."
				: [
						"Continue the unfinished part of the existing owner request. Check the reviewer’s suggestion against the original scope, permissions and receipts before acting.",
						wrapUntrustedText(JSON.stringify(judgment), "ordinary-work-review"),
					].join("\n"),
		details: {
			sessionId: reserved.sessionId,
			openingEntryId: reserved.openingEntryId,
			generation: reserved.generation,
			revision: reserved.revision,
			...(revision ? { reportingRevision: true } : {}),
			...(judgment.responseMode === "answer_only" ? { responseMode: "answer_only" } : {}),
		},
		timestamp: Date.now(),
	};
}

/** The continuation an expired wait on launched work spends: the foreground checks the workers it is waiting on. */
function workerWaitContinuation(reserved: OrdinaryWorkRecord): AgentMessage {
	return {
		role: "custom",
		customType: ORDINARY_WORK_CONTINUATION_TYPE,
		display: false,
		content: `A worker this request launched has not reported its result within ${ORDINARY_WORK_WORKER_WAIT_MS / 60_000} minutes. Check its progress, then cancel it, redirect it, or keep waiting for it, and say which. Do not redo its work while it still runs.`,
		details: {
			sessionId: reserved.sessionId,
			openingEntryId: reserved.openingEntryId,
			generation: reserved.generation,
			revision: reserved.revision,
		},
		timestamp: Date.now(),
	};
}

export interface ForegroundOrdinaryWork {
	work: OrdinaryWorkController;
	judges: Pick<SettlementJudges, "decideOrdinaryWorkStop">;
	mayReview(): boolean;
}

export function ordinaryOpening(message: AgentMessage | undefined): boolean {
	if (!message) return false;
	if (message.role === "custom") return message.customType === ORDINARY_WORK_CONTINUATION_TYPE;
	const kind = turnOriginOf(message)?.k;
	return kind === "owner-typed" || kind === "owner-channel";
}

export function reviewForegroundStop(
	ordinary: ForegroundOrdinaryWork | undefined,
	origin: RunTurnOrigin,
	ownerOpening: boolean,
	answer: AssistantMessage | undefined,
	signal: AbortSignal,
	atRoundCap: boolean,
	available: () => boolean,
	warn: (text: string) => void,
) {
	const live = origin.live();
	if (
		!ordinary ||
		(answer !== undefined && answer.stopReason !== "stop" && answer.stopReason !== "length") ||
		!live ||
		(live.origin.k !== "owner-typed" && live.origin.k !== "owner-channel")
	)
		return;
	const mayDispatch = () => available() && ordinary.mayReview();
	if (!mayDispatch()) return;
	const expected = ordinary.work.current();
	if (!expected || (expected.status !== "active" && expected.status !== "waiting")) return;
	return reviewOrdinaryWork(ordinary.work, ordinary.judges, {
		expected,
		signal,
		requireFreshCompletion: !live.decidedInRun && !ownerOpening,
		answer,
		missingFinal: answer?.stopReason !== "stop",
		mayDispatch,
		warn,
		atRoundCap,
	});
}
