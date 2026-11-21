import { type OrdinaryWorkStopEvidence, ordinaryReportEligible } from "../../../src/core/ordinary-work-policy.ts";
import type { ScriptedJudgment, SystemOneDecodedRequest } from "./session-fixture.ts";

const DEFAULTS: Readonly<Record<string, ScriptedJudgment>> = {
	disposition: { kind: "choice", choice: "unverified", confidence: 0.99 },
	delivered_in_answer: { kind: "noul", probability: 0.01 },
	evidence_sufficient: { kind: "noul", probability: 0.01 },
	report_ready: { kind: "noul", probability: 0.01 },
	restricted_presentation: { kind: "noul", probability: 0.09 },
};

/** Unrelated journeys hold ordinary work; a phase declaring any stop question owns the complete strict script. */
export function unrelatedOrdinaryStopDefaults(
	request: SystemOneDecodedRequest,
	expected: ReadonlyMap<string, ScriptedJudgment>,
	families: ReadonlyMap<string, ScriptedJudgment>,
): Readonly<Record<string, ScriptedJudgment>> | undefined {
	if (request.phase.startsWith("ordinary-stop-")) return;
	const ids = Object.keys(request.questions);
	if (
		![
			"delivered_in_answer,disposition,evidence_sufficient",
			"delivered_in_answer,disposition,evidence_sufficient,report_ready",
			"delivered_in_answer,disposition,evidence_sufficient,restricted_presentation",
		].includes(ids.sort().join()) ||
		ids.some(
			(id) =>
				!Object.hasOwn(DEFAULTS, id) ||
				expected.has(id) ||
				[...families.keys()].some((prefix) => id.startsWith(prefix)),
		)
	)
		return;
	const state = request.state;
	if (
		!state ||
		typeof state !== "object" ||
		Object.keys(state).sort().join() !== "answer,hasCompleteReceipt,hostFacts,receipts,request"
	)
		return;
	if (!["request", "answer", "receipts"].every((key) => typeof Reflect.get(state, key) === "string")) return;
	if (typeof Reflect.get(state, "hasCompleteReceipt") !== "boolean") return;
	const facts = Reflect.get(state, "hostFacts");
	if (
		!facts ||
		typeof facts !== "object" ||
		Object.keys(facts).sort().join() !==
			"backgroundReports,finalAnswerPresent,foregroundCallsSettled,foregroundReceipts,interrupted,pendingBackgroundWork,terminalStopReason" ||
		typeof facts.interrupted !== "boolean" ||
		typeof facts.finalAnswerPresent !== "boolean" ||
		facts.foregroundCallsSettled !== true ||
		!["workers_reported", "not_checked"].includes(facts.pendingBackgroundWork) ||
		!["stop", "length", "toolUse", "error", "aborted", "missing"].includes(facts.terminalStopReason)
	)
		return;
	for (const coverage of [facts.foregroundReceipts, facts.backgroundReports]) {
		if (
			!coverage ||
			typeof coverage !== "object" ||
			Object.keys(coverage).sort().join() !== "included,recorded" ||
			!Number.isSafeInteger(coverage.recorded) ||
			!Number.isSafeInteger(coverage.included) ||
			coverage.included < 0 ||
			coverage.recorded < coverage.included
		)
			return;
	}
	const disposition = request.questions.disposition;
	if (
		disposition?.type !== "choice" ||
		Object.keys(disposition.criteria ?? {})
			.sort()
			.join() !== "actionable,fulfilled,owner_needed,unverified,waiting"
	)
		return;
	if (request.questions.delivered_in_answer?.type !== "noul" || request.questions.evidence_sufficient?.type !== "noul")
		return;
	if (request.questions.report_ready && request.questions.report_ready.type !== "noul") return;
	if (Boolean(request.questions.report_ready) !== ordinaryReportEligible(state as OrdinaryWorkStopEvidence)) return;
	if (
		request.questions.restricted_presentation &&
		(request.questions.restricted_presentation.type !== "noul" || !String(Reflect.get(state, "answer")).trim())
	)
		return;
	return DEFAULTS;
}
