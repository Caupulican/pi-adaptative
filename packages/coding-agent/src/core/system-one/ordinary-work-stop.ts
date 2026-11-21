/** The stop judge's bounded evidence projection and the consequential Choice it may settle. */
import { isPlainRecord } from "../../kernel/utils/value-guards.ts";
import { isDecisivelyTrue, readNoul, settledAnswer } from "../decision/noul.ts";
import { choiceAct } from "../decision/thresholds.ts";
import {
	ORDINARY_WORK_EVIDENCE_CHARS,
	type OrdinaryWorkCorrection,
	type OrdinaryWorkJudgment,
	type OrdinaryWorkStopEvidence,
	ordinaryReportEligible,
} from "../ordinary-work-policy.ts";
import { OWNER_REQUEST_CHARACTERS } from "../security/owner-paste-boundary.ts";
import { cleanRedactBound } from "../security/secret-text.ts";
import { projectReportingRequirements, reportingRequestSources } from "./ordinary-reporting.ts";
import { bandedNoulAnswer } from "./policy.ts";
import {
	type ReportingRequirementClassification,
	reportingRequirementClassification,
} from "./reporting-requirement-admission.ts";

export function ordinaryStopState(evidence: OrdinaryWorkStopEvidence, redact: (text: string) => string) {
	if (
		evidence.request.length > OWNER_REQUEST_CHARACTERS ||
		evidence.answer.length > ORDINARY_WORK_EVIDENCE_CHARS ||
		evidence.receipts.length > ORDINARY_WORK_EVIDENCE_CHARS
	)
		return undefined;
	let receipts = "";
	let cursor = 0;
	const receiptCalls: { callId: string; call: string; resultStart: number; resultEnd: number }[] = [];
	const callIds = new Set<string>();
	for (const source of evidence.receiptSources ?? []) {
		if (
			!source.callId ||
			source.callId.length > 512 ||
			callIds.has(source.callId) ||
			![source.receiptStart, source.resultStart, source.resultEnd].every(Number.isSafeInteger) ||
			source.receiptStart < cursor ||
			source.resultStart <= source.receiptStart ||
			source.resultEnd < source.resultStart ||
			source.resultEnd > evidence.receipts.length
		)
			return undefined;
		callIds.add(source.callId);
		const rawCall = evidence.receipts.slice(source.receiptStart, source.resultStart);
		const rawResult = evidence.receipts.slice(source.resultStart, source.resultEnd);
		const call = redact(rawCall);
		const result = redact(rawResult);
		receipts += redact(evidence.receipts.slice(cursor, source.receiptStart)) + call;
		const resultStart = receipts.length;
		receipts += result;
		if (
			call === rawCall &&
			result === rawResult &&
			redact(source.callId) === source.callId &&
			result.trim() &&
			!/\[REDACTED(?:_SECRET)?\]/.test(call + result)
		)
			receiptCalls.push({ callId: source.callId, call, resultStart, resultEnd: receipts.length });
		cursor = source.resultEnd;
	}
	receipts += redact(evidence.receipts.slice(cursor));
	const canonicalReceipts = redact(evidence.receipts);
	if (receipts !== canonicalReceipts) {
		receipts = canonicalReceipts;
		receiptCalls.length = 0;
	}
	if (
		receipts.length > ORDINARY_WORK_EVIDENCE_CHARS ||
		JSON.stringify(receiptCalls).length > ORDINARY_WORK_EVIDENCE_CHARS
	)
		return undefined;
	return {
		request: redact(evidence.request),
		answer: redact(evidence.answer),
		receipts,
		receiptCalls,
		hasCompleteReceipt: evidence.hasCompleteReceipt,
		hostFacts: evidence.hostFacts,
	};
}

export function readOrdinaryStopJudgment(
	answers: Readonly<Record<string, unknown>>,
	evidence: OrdinaryWorkStopEvidence,
): OrdinaryWorkJudgment {
	const selected = (answers.disposition as { choice?: unknown } | undefined)?.choice;
	if (choiceAct(answers.disposition, undefined, "consequential") !== "act") return "unverified";
	if (selected === "actionable" && ordinaryReportEligible(evidence)) {
		if (settledAnswer(answers.report_ready) === true) return "report_ready";
		if (
			bandedNoulAnswer(answers.report_ready, "required_true")?.band === "ambiguous" &&
			bandedNoulAnswer(answers.evidence_sufficient, "required_true")?.band === "soft_pass"
		)
			return "report_review_needed";
	}
	if (!isDecisivelyTrue(answers.evidence_sufficient)) return "unverified";
	if (selected === "fulfilled")
		return evidence.hasCompleteReceipt || (evidence.answer.trim() && isDecisivelyTrue(answers.delivered_in_answer))
			? "fulfilled"
			: "unverified";
	if (selected === "actionable" || selected === "waiting" || selected === "owner_needed") return selected;
	return "unverified";
}

export function readOrdinaryReviewReply(
	text: string,
	reportState?: NonNullable<ReturnType<typeof ordinaryStopState>>,
): "held" | "reviewer_invalid_response" | OrdinaryWorkCorrection {
	let verdict: unknown;
	try {
		verdict = JSON.parse(text);
	} catch {
		return "reviewer_invalid_response";
	}
	if (isPlainRecord(verdict)) {
		if (verdict.decision === "hold") return "held";
		if (verdict.decision === "continue" && typeof verdict.missing === "string" && typeof verdict.next === "string") {
			const missing = cleanRedactBound(verdict.missing, 600);
			const next = cleanRedactBound(verdict.next, 600);
			if (reportState && !hasOrdinaryResultCitation(verdict.citation, reportState))
				return "reviewer_invalid_response";
			if (missing && next) return { missing, next };
		}
	}
	return "reviewer_invalid_response";
}

function hasOrdinaryResultCitation(
	citation: unknown,
	state: NonNullable<ReturnType<typeof ordinaryStopState>>,
): boolean {
	if (!isPlainRecord(citation) || typeof citation.callId !== "string" || typeof citation.quote !== "string")
		return false;
	const { callId, quote } = citation;
	const trimmed = quote.trim();
	if (!trimmed || quote.length > ORDINARY_WORK_EVIDENCE_CHARS) return false;
	if (state.receiptCalls.some((entry) => trimmed === entry.callId || trimmed === entry.call.trim())) return false;
	const source = state.receiptCalls.find((entry) => entry.callId === callId);
	if (!source) return false;
	const result = state.receipts.slice(source.resultStart, source.resultEnd);
	return (result.length <= 600 && quote === result) || result.split(/\r\n|\r|\n/).some((line) => line === quote);
}

interface OrdinaryStopJudgePorts {
	redact(text: string): string;
	evaluate(
		stage: "reporting_requirement" | "ordinary_work_stop",
		state: Record<string, unknown>,
		omit: readonly string[],
		signal?: AbortSignal,
	): Promise<{ answers: Readonly<Record<string, unknown>>; seal(result: string): void }>;
}

export class OrdinaryWorkStopJudge {
	private readonly ports: OrdinaryStopJudgePorts;
	constructor(ports: OrdinaryStopJudgePorts) {
		this.ports = ports;
	}

	async classify(text: string, signal?: AbortSignal): Promise<boolean | undefined> {
		const result = await this.assessReportingRequirement(text, signal);
		return result === "yes" ? true : result === "no" ? false : undefined;
	}

	async assessReportingRequirement(text: string, signal?: AbortSignal): Promise<ReportingRequirementClassification> {
		if (signal?.aborted || !text.trim() || text.length > OWNER_REQUEST_CHARACTERS || this.ports.redact(text) !== text)
			return "unavailable";
		const { answers, seal } = await this.ports.evaluate("reporting_requirement", { preference: text }, [], signal);
		const result = reportingRequirementClassification(answers.reporting_requirement);
		seal(result);
		return signal?.aborted ? "unavailable" : result;
	}

	async assess(evidence: OrdinaryWorkStopEvidence, signal?: AbortSignal) {
		const state = ordinaryStopState(evidence, this.ports.redact);
		if (!state) return { judgment: "unverified" as const, state };
		const { receiptCalls: _receiptCalls, ...judgeState } = state;
		const checkRestriction = Boolean(
			evidence.reporting?.complete && evidence.reporting.requirements.length && evidence.answer.trim(),
		);
		const omit: string[] = [];
		if (!ordinaryReportEligible(evidence)) omit.push("report_ready");
		if (!checkRestriction) omit.push("restricted_presentation");
		const { answers, seal } = await this.ports.evaluate("ordinary_work_stop", judgeState, omit, signal);
		const judgment = readOrdinaryStopJudgment(answers, evidence);
		seal(judgment);
		const facts = evidence.hostFacts;
		const provisionalReportingReview = Boolean(
			evidence.reporting &&
				judgment === "unverified" &&
				(answers.disposition as { choice?: unknown } | undefined)?.choice === "fulfilled" &&
				choiceAct(answers.disposition, undefined, "consequential") === "act" &&
				bandedNoulAnswer(answers.evidence_sufficient, "required_true")?.band === "soft_pass" &&
				facts.terminalStopReason === "stop" &&
				facts.finalAnswerPresent &&
				evidence.answer.trim() &&
				facts.foregroundCallsSettled &&
				evidence.hasCompleteReceipt &&
				state.receiptCalls.length > 0 &&
				facts.foregroundReceipts.recorded === facts.foregroundReceipts.included &&
				facts.backgroundReports.recorded === facts.backgroundReports.included,
		);
		return {
			judgment,
			provisionalReportingReview,
			reportingRequest:
				checkRestriction && evidence.latestOwnerRequest !== undefined
					? reportingRequestSources(state.request, this.ports.redact(evidence.latestOwnerRequest))
					: undefined,
			presentationRestriction: checkRestriction
				? readNoul(answers.restricted_presentation, "required_true")
				: undefined,
			state,
			reporting:
				evidence.reporting && (judgment === "fulfilled" || provisionalReportingReview)
					? projectReportingRequirements(evidence.reporting, this.ports.redact)
					: undefined,
		};
	}
}
