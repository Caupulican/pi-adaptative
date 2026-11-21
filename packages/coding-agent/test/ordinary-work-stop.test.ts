import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type AssistantMessage, createEmptyUsage, getModel } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	containsStatedOwnerQuote,
	OWNER_EVIDENCE_CUSTOM_TYPE,
	OwnerEvidenceLedger,
} from "../src/core/learning/owner-evidence-ledger.ts";
import { DecisionLedgerStore } from "../src/core/operator-projection/decision-ledger-store.ts";
import { OrdinaryWorkController } from "../src/core/ordinary-work-controller.ts";
import {
	assertOrdinaryDispatch,
	ORDINARY_WORK_MAX_CONTINUATIONS,
	type OrdinaryWorkJudgment,
	type OrdinaryWorkStopEvidence,
	ordinaryReportEligible,
	requiresOrdinaryReportReview,
} from "../src/core/ordinary-work-policy.ts";
import { reviewOrdinaryWork } from "../src/core/ordinary-work-settlement.ts";
import type { OwnerInputId } from "../src/core/owner-input-ledger.ts";
import { PLAN_UPDATE_CUSTOM_TYPE } from "../src/core/proof/proof-sheet.ts";
import { ProviderRequestRuntimeController } from "../src/core/provider-request-runtime-controller.ts";
import type { SystemOneController } from "../src/core/system-one/controller.ts";
import { projectReportingRequirements, reportingVerdict } from "../src/core/system-one/ordinary-reporting.ts";
import {
	OrdinaryWorkStopJudge,
	ordinaryStopState,
	readOrdinaryReviewReply,
	readOrdinaryStopJudgment,
} from "../src/core/system-one/ordinary-work-stop.ts";
import { SettlementJudges } from "../src/core/system-one/settlement-judges.ts";
import { toolResultEvidence } from "../src/core/system-one/unsettled-ladder.ts";
import { Agent } from "../src/kernel/agent.ts";
import { stampOwnerInput } from "../src/kernel/owner-input-stamp.ts";
import { ownerSessionStorageRoots } from "../src/kernel/session/session-bundle-paths.ts";
import { SessionManager } from "../src/kernel/session/session-manager.ts";

const evidence: OrdinaryWorkStopEvidence = {
	request: "Compare both reports",
	answer: "I read the first report.",
	receipts: "",
	hasCompleteReceipt: false,
	hostFacts: {
		interrupted: false,
		terminalStopReason: "stop",
		finalAnswerPresent: true,
		foregroundCallsSettled: true,
		foregroundReceipts: { recorded: 0, included: 0 },
		backgroundReports: { recorded: 0, included: 0 },
		pendingBackgroundWork: "not_checked",
	},
};
const signal = new AbortController().signal;
const reportReceipt = '[read {"path":"report.txt"}] Report title';
const reportEvidence: OrdinaryWorkStopEvidence = {
	...evidence,
	request: "Read the report and give me its title",
	answer: "",
	receipts: reportReceipt,
	receiptSources: [
		{
			callId: "read-report",
			receiptStart: 0,
			resultStart: reportReceipt.indexOf("Report title"),
			resultEnd: reportReceipt.length,
		},
	],
	hasCompleteReceipt: true,
	hostFacts: {
		...evidence.hostFacts,
		interrupted: true,
		terminalStopReason: "aborted",
		finalAnswerPresent: false,
		foregroundReceipts: { recorded: 1, included: 1 },
	},
};
const reportAnswers = {
	disposition: { choice: "actionable", distribution: { actionable: 0.99, fulfilled: 0.01 } },
	evidence_sufficient: { noul: 0.53 },
	report_ready: { noul: 0.95 },
};

function stopJudge(reply?: string, judgment: OrdinaryWorkJudgment = "actionable", report = reportEvidence) {
	const jev = {
		evaluateOrdinaryWorkStop: async () => ({
			judgment,
			state: ordinaryStopState(requiresOrdinaryReportReview(judgment) ? report : evidence, (text) => text),
		}),
	};
	const judges = new SettlementJudges({
		getSystemOneController: () => jev as unknown as SystemOneController,
		resolveExpensiveModel: () => ({ skip: "No provider runs in this fixture." }),
		runIsolatedCompletion: async () => {
			throw new Error("Unexpected model request");
		},
		warn: () => {},
	});
	const consult = vi
		.spyOn(judges, "consultExpensiveModel")
		.mockResolvedValue(reply === undefined ? undefined : { text: reply, ref: "reviewer" });
	return { judges, consult };
}

describe("ordinary work stop", () => {
	it("can ground a requested error report in a fully recorded failed operation without authorizing a retry", () => {
		const projected = toolResultEvidence([
			{ role: "assistant", content: [{ type: "toolCall", id: "failed-read", arguments: { path: "private.txt" } }] },
			{
				role: "toolResult",
				toolName: "read",
				toolCallId: "failed-read",
				isError: true,
				content: [{ type: "text", text: "Permission denied" }],
			},
		]).results[0]!;
		expect(projected.source?.callId).toBe("failed-read");
		const state = ordinaryStopState(
			{
				...reportEvidence,
				request: "Explain why the recorded read failed",
				receipts: projected.text,
				receiptSources: [
					{
						callId: projected.source!.callId,
						receiptStart: 0,
						resultStart: projected.source!.resultOffset,
						resultEnd: projected.text.length,
					},
				],
			},
			(text) => text,
		)!;
		expect(
			readOrdinaryReviewReply(
				JSON.stringify({
					decision: "continue",
					missing: "Failure report",
					next: "Report the recorded failure",
					citation: { callId: "failed-read", quote: "Permission denied" },
				}),
				state,
			),
		).toEqual({ missing: "Failure report", next: "Report the recorded failure" });
	});
	it.each([0.85, 0.87, 0.95])("selects grounded answer-only delivery at report readiness %s", async (probability) => {
		expect(ordinaryReportEligible(reportEvidence)).toBe(true);
		expect(readOrdinaryStopJudgment({ ...reportAnswers, report_ready: { noul: probability } }, reportEvidence)).toBe(
			"report_ready",
		);
		const delta = { missing: "The requested title", next: "Report the retained title" };
		const { judges, consult } = stopJudge(
			JSON.stringify({ decision: "continue", ...delta, citation: { callId: "read-report", quote: "Report title" } }),
			"report_ready",
		);
		expect(await judges.decideOrdinaryWorkStop(reportEvidence, 0, signal)).toEqual({
			...delta,
			responseMode: "answer_only",
		});
		expect(consult).toHaveBeenCalledTimes(1);
		expect(consult.mock.calls[0]?.[0].systemPrompt).toContain("only deliver an answer from these completed receipts");
	});

	it.each([
		undefined,
		null,
		{},
		{ callId: "wrong-call", quote: "Report title" },
		{ callId: "read-report", quote: "" },
		{ callId: "read-report", quote: "   " },
		{ callId: "read-report", quote: "Report" },
		{ callId: "read-report", quote: "Report title and details" },
		{ callId: "read-report", quote: "read-report" },
		{ callId: "read-report", quote: '[read {"path":"report.txt"}]' },
		{ callId: "read-report", quote: reportReceipt },
	])("holds a report review with absent or invalid citation %#", async (citation) => {
		const { judges, consult } = stopJudge(
			JSON.stringify({ decision: "continue", missing: "Title", next: "Report title", citation }),
			"report_ready",
		);
		expect(await judges.decideOrdinaryWorkStop(reportEvidence, 0, signal)).toBe("reviewer_invalid_response");
		expect(consult).toHaveBeenCalledTimes(1);
	});

	it("ties whole lines and short results to their producing call without accepting partial or cross-receipt text", () => {
		const second = '[read {"path":"other.txt"}] Other title\nSecond line';
		const receipts = `${reportReceipt}\n${second}`;
		const state = ordinaryStopState(
			{
				...reportEvidence,
				receipts,
				receiptSources: [
					...reportEvidence.receiptSources!,
					{
						callId: "read-other",
						receiptStart: reportReceipt.length + 1,
						resultStart: reportReceipt.length + 1 + second.indexOf("Other title"),
						resultEnd: receipts.length,
					},
				],
			},
			(text) => text,
		)!;
		const cite = (callId: string, quote: string) =>
			readOrdinaryReviewReply(
				JSON.stringify({
					decision: "continue",
					missing: "Title",
					next: "Report title",
					citation: { callId, quote },
				}),
				state,
			);
		expect(cite("read-other", "Other title")).toEqual({ missing: "Title", next: "Report title" });
		expect(cite("read-other", "Other title\nSecond line")).toEqual({ missing: "Title", next: "Report title" });
		expect(cite("read-report", "Other title")).toBe("reviewer_invalid_response");
		expect(cite("read-report", "Report title\nOther title")).toBe("reviewer_invalid_response");
		expect(cite("read-other", "Other title\nSecond")).toBe("reviewer_invalid_response");
	});

	it("rejects duplicate source identities and citations from a superseded result", () => {
		const source = reportEvidence.receiptSources![0]!;
		const duplicate = `${reportReceipt}\n${reportReceipt}`;
		expect(
			ordinaryStopState(
				{
					...reportEvidence,
					receipts: duplicate,
					receiptSources: [
						source,
						{
							...source,
							receiptStart: source.receiptStart + reportReceipt.length + 1,
							resultStart: source.resultStart + reportReceipt.length + 1,
							resultEnd: duplicate.length,
						},
					],
				},
				(text) => text,
			),
		).toBeUndefined();
		const updated = reportReceipt.replace("Report title", "Updated title");
		const state = ordinaryStopState(
			{ ...reportEvidence, receipts: updated, receiptSources: [{ ...source, resultEnd: updated.length }] },
			(text) => text,
		)!;
		expect(
			readOrdinaryReviewReply(
				JSON.stringify({
					decision: "continue",
					missing: "Title",
					next: "Report title",
					citation: { callId: "read-report", quote: "Report title" },
				}),
				state,
			),
		).toBe("reviewer_invalid_response");
		expect(
			ordinaryStopState(
				{ ...reportEvidence, receiptSources: [{ ...source, resultEnd: reportReceipt.length + 1 }] },
				(text) => text,
			),
		).toBeUndefined();
	});

	it("checks citations against the exact redacted projection and rejects dropped, empty and redacted result evidence", () => {
		const quote = (text: string, state: NonNullable<ReturnType<typeof ordinaryStopState>>) =>
			readOrdinaryReviewReply(
				JSON.stringify({
					decision: "continue",
					missing: "Title",
					next: "Report title",
					citation: { callId: "read-report", quote: text },
				}),
				state,
			);
		const prefix = "A short note\n";
		const prefixed = ordinaryStopState(
			{
				...reportEvidence,
				receipts: prefix + reportReceipt,
				receiptSources: reportEvidence.receiptSources!.map((source) => ({
					...source,
					receiptStart: source.receiptStart + prefix.length,
					resultStart: source.resultStart + prefix.length,
					resultEnd: source.resultEnd + prefix.length,
				})),
			},
			(text) => text.replace("A short note", "A substantially expanded redacted note"),
		)!;
		expect(quote("Report title", prefixed)).toEqual({ missing: "Title", next: "Report title" });
		const redacted = ordinaryStopState(reportEvidence, (text) => text.replace("Report title", "[REDACTED_SECRET]"))!;
		expect(redacted.receipts).toContain("[REDACTED_SECRET]");
		expect(quote("[REDACTED_SECRET]", redacted)).toBe("reviewer_invalid_response");
		expect(quote("Report title", redacted)).toBe("reviewer_invalid_response");
		const crossed = ordinaryStopState(reportEvidence, (text) => text.replace("] Report", "[REDACTED_SECRET]"))!;
		expect(crossed.receipts).toBe(reportReceipt.replace("] Report", "[REDACTED_SECRET]"));
		expect(crossed.receiptCalls).toEqual([]);
		expect(quote("Report title", crossed)).toBe("reviewer_invalid_response");
		const masked = reportReceipt.replace("Report title", "[REDACTED]");
		const alreadyRedacted = ordinaryStopState(
			{
				...reportEvidence,
				receipts: masked,
				receiptSources: [{ ...reportEvidence.receiptSources![0]!, resultEnd: masked.length }],
			},
			(text) => text,
		)!;
		expect(quote("[REDACTED]", alreadyRedacted)).toBe("reviewer_invalid_response");
		expect(quote("Report title", ordinaryStopState({ ...reportEvidence, receiptSources: [] }, (text) => text)!)).toBe(
			"reviewer_invalid_response",
		);
		const empty = reportReceipt.slice(0, reportReceipt.indexOf("Report title"));
		expect(
			quote(
				"",
				ordinaryStopState(
					{
						...reportEvidence,
						receipts: empty,
						receiptSources: [{ ...reportEvidence.receiptSources![0]!, resultEnd: empty.length }],
					},
					(text) => text,
				)!,
			),
		).toBe("reviewer_invalid_response");
	});

	it.each([
		{ ...reportEvidence, hostFacts: { ...reportEvidence.hostFacts, interrupted: false } },
		{ ...reportEvidence, answer: "Already delivered" },
		{ ...reportEvidence, hostFacts: { ...reportEvidence.hostFacts, finalAnswerPresent: true } },
		{ ...reportEvidence, hasCompleteReceipt: false },
		{
			...reportEvidence,
			hostFacts: { ...reportEvidence.hostFacts, foregroundReceipts: { recorded: 0, included: 0 } },
		},
		{
			...reportEvidence,
			hostFacts: { ...reportEvidence.hostFacts, foregroundReceipts: { recorded: 2, included: 1 } },
		},
		{
			...reportEvidence,
			hostFacts: { ...reportEvidence.hostFacts, backgroundReports: { recorded: 1, included: 0 } },
		},
	])("does not grant answer-only authority outside the fully represented interrupted frontier %#", (record) => {
		expect(ordinaryReportEligible(record)).toBe(false);
		expect(readOrdinaryStopJudgment(reportAnswers, record)).toBe("unverified");
	});

	it.each([
		[0.8, 0.86, "report_review_needed"],
		[0.21, 0.85, "report_review_needed"],
		[0.8, 0.84, "unverified"],
		[0.2, 0.86, "unverified"],
		[undefined, 0.86, "unverified"],
		[0.8, undefined, "unverified"],
		[0.8, 0.93, "actionable"],
	] as const)("routes report readiness %s and evidence %s to %s", (readiness, sufficiency, expected) => {
		const answers = {
			...reportAnswers,
			report_ready: { noul: readiness },
			evidence_sufficient: { noul: sufficiency },
		};
		expect(readOrdinaryStopJudgment(answers, reportEvidence)).toBe(expected);
	});

	it("requires a citable result, independent assent and remaining budget for provisional reporting", async () => {
		const justification = { missing: "The title", next: "Return the title" };
		const reply = JSON.stringify({
			decision: "continue",
			...justification,
			citation: { callId: "read-report", quote: "Report title" },
		});
		const allowed = stopJudge(reply, "report_review_needed");
		expect(await allowed.judges.decideOrdinaryWorkStop(reportEvidence, 0, signal)).toEqual({
			...justification,
			responseMode: "answer_only",
		});
		expect(await allowed.judges.decideOrdinaryWorkStop(reportEvidence, 3, signal)).toBe("limited");
		expect(allowed.consult).toHaveBeenCalledTimes(1);
		const veto = stopJudge('{"decision":"hold"}', "report_review_needed");
		expect(await veto.judges.decideOrdinaryWorkStop(reportEvidence, 0, signal)).toBe("held");
		const uncitable = stopJudge(reply, "report_review_needed", { ...reportEvidence, receiptSources: [] });
		expect(await uncitable.judges.decideOrdinaryWorkStop(reportEvidence, 0, signal)).toBe("unverified");
		expect(uncitable.consult).not.toHaveBeenCalled();
	});

	it("keeps the general high-confidence path for an interrupted read before a requested edit", () => {
		const edit = { ...reportEvidence, request: "Read report.txt and change its title to Updated" };
		expect(
			readOrdinaryStopJudgment(
				{ ...reportAnswers, report_ready: { noul: 0.04 }, evidence_sufficient: { noul: 0.99 } },
				edit,
			),
		).toBe("actionable");
		expect(readOrdinaryStopJudgment({ ...reportAnswers, report_ready: { noul: 0.04 } }, edit)).toBe("unverified");
		expect(
			readOrdinaryStopJudgment(
				{ ...reportAnswers, report_ready: { noul: 0.04 }, evidence_sufficient: { noul: 0.87 } },
				edit,
			),
		).toBe("unverified");
	});

	it.each([
		[0.84, "unverified"],
		[0.85, "report_ready"],
		[0.92, "report_ready"],
		[0.93, "report_ready"],
	] as const)("uses the existing decisive Noul boundary for a ready report at %s", (probability, result) => {
		expect(readOrdinaryStopJudgment({ ...reportAnswers, report_ready: { noul: probability } }, reportEvidence)).toBe(
			result,
		);
	});

	it.each(["waiting", "owner_needed", "unverified", "fulfilled"] as const)(
		"preserves %s semantics when report_ready is independently high",
		(selected) => {
			expect(
				readOrdinaryStopJudgment(
					{
						...reportAnswers,
						disposition: { choice: selected, distribution: { [selected]: 0.99, actionable: 0.01 } },
						evidence_sufficient: { noul: 0.99 },
					},
					reportEvidence,
				),
			).toBe(selected);
		},
	);

	it("prefers answer-only when both gates pass and never promotes a reviewer veto to tool execution", async () => {
		expect(readOrdinaryStopJudgment({ ...reportAnswers, evidence_sufficient: { noul: 0.99 } }, reportEvidence)).toBe(
			"report_ready",
		);
		const { judges, consult } = stopJudge('{"decision":"hold"}', "report_ready");
		expect(await judges.decideOrdinaryWorkStop(reportEvidence, 0, signal)).toBe("held");
		expect(consult).toHaveBeenCalledTimes(1);
	});

	it("retains the lifetime cap for answer-only delivery", async () => {
		const { judges, consult } = stopJudge(
			'{"decision":"continue","missing":"Title","next":"Report title"}',
			"report_ready",
		);
		expect(await judges.decideOrdinaryWorkStop(reportEvidence, ORDINARY_WORK_MAX_CONTINUATIONS, signal)).toBe(
			"limited",
		);
		expect(consult).not.toHaveBeenCalled();
	});

	it("keeps a tool-seeking report review restricted and ignores model-supplied response modes", async () => {
		const reply =
			'{"decision":"continue","missing":"Title","next":"Run read again","responseMode":"general","citation":{"callId":"read-report","quote":"Report title"}}';
		const report = stopJudge(reply, "report_ready");
		expect(await report.judges.decideOrdinaryWorkStop(reportEvidence, 0, signal)).toEqual({
			missing: "Title",
			next: "Run read again",
			responseMode: "answer_only",
		});
		const ordinary = stopJudge(reply);
		expect(await ordinary.judges.decideOrdinaryWorkStop(evidence, 0, signal)).toEqual({
			missing: "Title",
			next: "Run read again",
		});
	});
	it("preserves host interruption and incomplete coverage facts through redacted semantic projection", () => {
		const interrupted: OrdinaryWorkStopEvidence = {
			...evidence,
			answer: "",
			receipts: "[read] Report content",
			hasCompleteReceipt: true,
			hostFacts: {
				...evidence.hostFacts,
				interrupted: true,
				terminalStopReason: "aborted",
				finalAnswerPresent: false,
				foregroundReceipts: { recorded: 2, included: 1 },
				backgroundReports: { recorded: 1, included: 0 },
			},
		};
		expect(ordinaryStopState(interrupted, (text) => text.replaceAll("Report", "[redacted]"))).toEqual({
			...interrupted,
			receipts: "[read] [redacted] content",
			receiptCalls: [],
		});
	});

	it.each(["aborted", "error", "length", "toolUse"] as const)(
		"discards apparent reviewer assent from a completion ending in %s",
		async (stopReason) => {
			const model = getModel("xai", "grok-4.7-build-fast")!;
			const judges = new SettlementJudges({
				getSystemOneController: () =>
					({
						evaluateOrdinaryWorkStop: async () => ({
							judgment: "report_review_needed",
							state: ordinaryStopState(reportEvidence, (text) => text),
						}),
					}) as unknown as SystemOneController,
				resolveExpensiveModel: () => ({ model, ref: "fixture/reviewer", selection: "manual" }),
				runIsolatedCompletion: async () => ({
					text: JSON.stringify({
						decision: "continue",
						missing: "Title",
						next: "Report the title",
						citation: { callId: "read-report", quote: "Report title" },
					}),
					stopReason,
					usage: createEmptyUsage(),
				}),
				warn: () => {},
			});
			expect(await judges.decideOrdinaryWorkStop(reportEvidence, 0, signal)).toBe("reviewer_unavailable");
		},
	);

	it("carries an independent reviewer's concrete correction", async () => {
		const delta = { missing: "Comparison of the reports", next: "Read the second report" };
		const { judges } = stopJudge(JSON.stringify({ decision: "continue", ...delta }));
		expect(await judges.decideOrdinaryWorkStop(evidence, 0, signal)).toEqual(delta);
	});

	it.each([
		['{"decision":"hold"}', "held"],
		['{"decision":"continue"}', "reviewer_invalid_response"],
		["CONTINUE", "reviewer_invalid_response"],
		[undefined, "reviewer_no_eligible_model"],
	])("holds an actionable Jev finding for reviewer response %s", async (reply, result) => {
		const { judges } = stopJudge(reply);
		expect(await judges.decideOrdinaryWorkStop(evidence, 1, signal)).toBe(result);
	});

	it("requires receipts for work outside the answer, even when Jev selects fulfilled", () => {
		const answers = {
			disposition: { choice: "fulfilled", distribution: { fulfilled: 0.99, actionable: 0.01 } },
			evidence_sufficient: { band: "hard_pass" },
			delivered_in_answer: { band: "hard_fail" },
		};
		expect(readOrdinaryStopJudgment(answers, evidence)).toBe("unverified");
		expect(readOrdinaryStopJudgment({ ...answers, delivered_in_answer: { band: "hard_pass" } }, evidence)).toBe(
			"fulfilled",
		);
	});

	it("holds a low-confidence actionable winner with a retained receipt", () => {
		expect(
			readOrdinaryStopJudgment(
				{
					disposition: {
						choice: "actionable",
						distribution: { actionable: 0.36, fulfilled: 0.27, waiting: 0.27, unverified: 0.1 },
					},
					evidence_sufficient: { band: "hard_pass" },
					report_ready: { noul: 0.99 },
				},
				reportEvidence,
			),
		).toBe("unverified");
	});

	it("skips the reviewer at the persisted limit", async () => {
		const { judges, consult } = stopJudge('{"decision":"continue","missing":"Diff","next":"Compare"}');
		expect(await judges.decideOrdinaryWorkStop(evidence, ORDINARY_WORK_MAX_CONTINUATIONS, signal)).toBe("limited");
		expect(consult).not.toHaveBeenCalled();
	});
});

describe("ordinary stop canonical host evidence", () => {
	it.each(["complete", "prefix", "legacy"] as const)("exposes quote authority from a %s owner source", (kind) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-ordinary-owner-proof-"));
		const ledger = new DecisionLedgerStore({ databasePath: join(dir, "decisions.sqlite") });
		try {
			const manager = SessionManager.create(dir, ownerSessionStorageRoots(dir));
			const work = new OrdinaryWorkController({
				getSessionManager: () => manager,
				getStore: () => ledger.ordinaryWork,
				isEnabled: () => true,
			});
			const text = "Omit the filename.";
			const message = { role: "user" as const, content: text, timestamp: 1 };
			const id = "prompt:owner-proof" as OwnerInputId;
			stampOwnerInput(message, id);
			const entryId = manager.appendMessage(message);
			const opening = work.noteOwnerInput({ id, message, entryId })!;
			const sessionId = manager.getSessionId();
			const sourceId = kind === "legacy" ? "old-session-prefix" : `${sessionId}/${entryId}`;
			manager.appendCustomEntry(OWNER_EVIDENCE_CUSTOM_TYPE, {
				version: 1,
				evidence: {
					entryId,
					sourceId,
					...(kind === "legacy" ? {} : { sessionId }),
					text,
					chars: text.length + (kind === "prefix" ? 16 : 0),
					digest: createHash("sha256").update(text).digest("hex").slice(0, 16),
					createdAt: new Date(0).toISOString(),
				},
			});
			const input = work.evidence(opening)?.ownerInputs[0];
			expect(input?.words.text).toBe(text);
			expect(input?.sourceId).toBe(kind === "complete" ? sourceId : undefined);
		} finally {
			ledger.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.each(["interrupted", "delivered", "omitted", "background", "ambiguous", "report"] as const)(
		"projects the %s receipt frontier without inventing background ownership",
		async (scenario) => {
			const dir = mkdtempSync(join(tmpdir(), "pi-ordinary-stop-evidence-"));
			const ledger = new DecisionLedgerStore({ databasePath: join(dir, "decisions.sqlite") });
			try {
				const manager = SessionManager.create(dir, ownerSessionStorageRoots(dir));
				const work = new OrdinaryWorkController({
					getSessionManager: () => manager,
					getStore: () => ledger.ordinaryWork,
					isEnabled: () => true,
				});
				const message = { role: "user", content: "Read the report and give me its title", timestamp: 1 } as const;
				const id = "prompt:read-report" as OwnerInputId;
				stampOwnerInput(message, id);
				const opening = work.noteOwnerInput({ id, message, entryId: manager.appendMessage(message) })!;
				const assistant: AssistantMessage = {
					role: "assistant",
					api: "openai-completions",
					provider: "fixture",
					model: "fixture",
					content: [{ type: "toolCall", id: "read-report", name: "read", arguments: { path: "report.txt" } }],
					stopReason: "toolUse",
					usage: createEmptyUsage(),
					timestamp: 2,
				};
				const assistantEntry = manager.appendMessage(assistant);
				if (scenario === "ambiguous")
					manager.appendForegroundToolStart("read-request", assistantEntry, "read-report", "read");
				if (scenario !== "ambiguous") {
					manager.appendMessage({
						role: "toolResult",
						toolName: "read",
						toolCallId: "read-report",
						content: [{ type: "text", text: scenario === "omitted" ? "x".repeat(13_000) : "Report title" }],
						isError: false,
						timestamp: 3,
					});
				}
				manager.appendMessage({
					...assistant,
					content: scenario === "delivered" ? [{ type: "text", text: "Report title" }] : [],
					stopReason: scenario === "delivered" ? "stop" : "aborted",
					timestamp: 4,
				});
				if (scenario === "background") {
					manager.appendCustomMessageEntry(PLAN_UPDATE_CUSTOM_TYPE, "Matching plan settled", false, {
						kind: "settled",
						served: { sessionId: manager.getSessionId(), leafId: opening.openingEntryId },
					});
				}
				const expected = work.checkpoint(opening, { status: "unverified", reason: "process_interrupted" })!;
				const decide = vi.fn(async (_projection: OrdinaryWorkStopEvidence) =>
					scenario === "report"
						? {
								missing: "The requested title",
								next: "Report the recorded title",
								responseMode: "answer_only" as const,
							}
						: ("unverified" as const),
				);
				const continuation = await reviewOrdinaryWork(
					work,
					{ decideOrdinaryWorkStop: decide },
					{
						expected,
						signal,
						mayDispatch: () => true,
						warn: () => {},
					},
				);
				if (scenario === "ambiguous") {
					expect(decide).not.toHaveBeenCalled();
					expect(work.current()?.reason).toBe("ambiguous_execution_receipt");
				} else {
					expect(decide).toHaveBeenCalledTimes(1);
					const projection = decide.mock.calls[0]![0];
					expect(projection.hostFacts).toEqual({
						interrupted: true,
						terminalStopReason: scenario === "delivered" ? "stop" : "aborted",
						finalAnswerPresent: scenario === "delivered",
						foregroundCallsSettled: true,
						foregroundReceipts: { recorded: 1, included: scenario === "omitted" ? 0 : 1 },
						backgroundReports: {
							recorded: scenario === "background" ? 1 : 0,
							included: scenario === "background" ? 1 : 0,
						},
						pendingBackgroundWork: "not_checked",
					});
					expect(projection.hasCompleteReceipt).toBe(scenario !== "omitted");
					expect(work.current()?.continuationCount).toBe(scenario === "report" ? 1 : 0);
					if (scenario !== "report") expect(work.recover()).toBeUndefined();
					if (scenario === "report") {
						expect(continuation).toMatchObject({ role: "custom", details: { responseMode: "answer_only" } });
						if (continuation?.role !== "custom") throw new Error("Expected reserved report continuation");
						expect(continuation.content).not.toContain("ordinary-work-review");
						expect(() => assertOrdinaryDispatch(continuation, work.current())).not.toThrow();
						const { responseMode, ...withoutMode } = continuation.details as Record<string, unknown>;
						expect(responseMode).toBe("answer_only");
						expect(() =>
							assertOrdinaryDispatch({ ...continuation, details: withoutMode }, work.current()),
						).toThrow("reserved generation");
						expect(() =>
							assertOrdinaryDispatch(
								{
									...continuation,
									details: { ...(continuation.details as Record<string, unknown>), responseMode: "general" },
								},
								work.current(),
							),
						).toThrow("reserved generation");
						const successor = work.reserveContinuation(work.beginReview(work.current()!)!, "answer_only")!;
						expect(successor.generation).toBeGreaterThan(
							(continuation.details as { generation: number }).generation,
						);
						expect(() => assertOrdinaryDispatch(continuation, successor)).toThrow("reserved generation");
					}
				}
			} finally {
				ledger.close();
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});

describe("owner-confirmed reporting requirements", () => {
	const requirement = {
		id: "private-rule-id",
		text: "When reporting a retry setting, use the label retry ceiling and name its source file.",
	};
	const stated = "What is the retry setting in settings.ts?";
	const answered = "The retry setting is 7.";
	const snapshot = { requirements: [requirement], complete: true, isCurrent: () => true };
	const corrected = "The retry ceiling in settings.ts is 7.";
	it.each(["confirmed", "negative", "unrelated", "pending"] as const)(
		"settles the accepted empty reporting snapshot when a classification is %s during review",
		async (outcome) => {
			const dir = mkdtempSync(join(tmpdir(), "pi-reporting-review-race-"));
			const ledger = new DecisionLedgerStore({ databasePath: join(dir, "decisions.sqlite") });
			try {
				const manager = SessionManager.create(dir, ownerSessionStorageRoots(dir));
				const digest = createHash("sha256").update(requirement.text).digest("hex");
				const proofs = ledger.ownerPreferences;
				const lease = proofs.reserveClassification(digest)!;
				const captured = proofs.captureReportingProofs({ knowledge: [digest] });
				expect(captured.confirmed.size).toBe(0);
				const work = new OrdinaryWorkController({
					getSessionManager: () => manager,
					getStore: () => ledger.ordinaryWork,
					isEnabled: () => true,
					reportingRequirements: () => ({ requirements: [], complete: true, isCurrent: captured.isCurrent }),
				});
				const message = { role: "user" as const, content: stated, timestamp: 1 };
				const id = "prompt:reporting-review-race" as OwnerInputId;
				stampOwnerInput(message, id);
				const opening = work.noteOwnerInput({ id, message, entryId: manager.appendMessage(message) })!;
				manager.appendMessage({
					role: "assistant",
					api: "openai-completions",
					provider: "fixture",
					model: "fixture",
					content: [{ type: "text", text: answered }],
					stopReason: "stop",
					usage: createEmptyUsage(),
					timestamp: 2,
				});
				const decideOrdinaryWorkStop = vi.fn(async (projection: OrdinaryWorkStopEvidence) => {
					expect(projection.reporting).toBeUndefined();
					if (outcome === "confirmed" || outcome === "negative")
						proofs.classify(digest, outcome === "confirmed", lease);
					if (outcome === "unrelated") proofs.classify(createHash("sha256").update("other").digest("hex"), true);
					return "fulfilled" as const;
				});
				const result = await reviewOrdinaryWork(
					work,
					{ decideOrdinaryWorkStop },
					{
						expected: opening,
						signal,
						mayDispatch: () => true,
						warn: () => {},
					},
				);
				expect(result).toBeUndefined();
				expect(decideOrdinaryWorkStop).toHaveBeenCalledOnce();
				expect(ledger.ordinaryWork.get(opening.sessionId, opening.openingEntryId)).toMatchObject({
					status: outcome === "confirmed" ? "unverified" : "fulfilled",
					reason: outcome === "confirmed" ? "reporting_changed" : "fulfilled",
					continuationCount: 0,
				});
			} finally {
				ledger.close();
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);

	const verdict = (value: string, quote: string) =>
		JSON.stringify({
			checks: [
				{
					ref: 1,
					verdict: value,
					quote,
					...(value === "met"
						? {
								support: [
									{ rulePart: "label retry ceiling", answerPart: "retry ceiling", literal: "retry ceiling" },
									{ rulePart: "name its source file", answerPart: "settings.ts", literal: "" },
								],
							}
						: {}),
				},
			],
		});

	function fulfilledJudge(reply: string, evidenceProbability = 1, restriction: number | null = 0.09) {
		const stop = new OrdinaryWorkStopJudge({
			redact: (text) => text,
			evaluate: async (_stage, _state, omit) => ({
				answers: {
					...(!omit.includes("restricted_presentation") && restriction !== null
						? { restricted_presentation: { noul: restriction } }
						: {}),
					disposition: { choice: "fulfilled", distribution: { fulfilled: 1 } },
					delivered_in_answer: { noul: 1 },
					evidence_sufficient: { noul: evidenceProbability },
				},
				seal: () => {},
			}),
		});
		const judges = new SettlementJudges({
			getSystemOneController: () =>
				({ evaluateOrdinaryWorkStop: stop.assess.bind(stop) }) as unknown as SystemOneController,
			resolveExpensiveModel: () => ({ skip: "fixture route" }),
			runIsolatedCompletion: async () => {
				throw Error("unexpected remote call");
			},
			warn: () => {},
		});
		const consult = vi.spyOn(judges, "consultExpensiveModel").mockResolvedValue({ text: reply, ref: "independent" });
		return { judges, consult };
	}

	it.each([
		["What is the retry setting instead?", false, "reporting_unverified"],
		["Use the earlier subject: “weather forecast”.", false, "reporting_unverified"],
		["Here is the previous request: weather forecast", true, "reporting_unverified"],
		["Keep going.", false, "reporting_unverified"],
		["Please give the weather forecast for tomorrow.", false, "fulfilled"],
	] as const)("checks a claimed exemption after steering to %s", async (latest, pasted, reason) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-reporting-steer-"));
		const ledger = new DecisionLedgerStore({ databasePath: join(dir, "decisions.sqlite") });
		try {
			const manager = SessionManager.create(dir, ownerSessionStorageRoots(dir));
			const deps = { getSessionManager: () => manager, warn: (text: string) => expect.unreachable(text) };
			const sources = new OwnerEvidenceLedger(deps);
			const work = new OrdinaryWorkController({
				...deps,
				isEnabled: () => true,
				getStore: () => ledger.ordinaryWork,
				reportingRequirements: () => snapshot,
			});
			const subject = "weather forecast";
			const earlier = `Give me the ${subject}.`;
			const enroll = (text: string, id: OwnerInputId, fromPaste = false) => {
				const message = { role: "user" as const, content: text, timestamp: Date.now() };
				stampOwnerInput(message, id);
				sources.markOwnerInput(
					message,
					text,
					fromPaste ? [{ start: text.indexOf(subject), end: text.length }] : [],
				);
				const entryId = manager.appendMessage(message);
				sources.noteOwnerInputPersisted(message, entryId);
				return work.noteOwnerInput({ id, entryId, message })!;
			};
			const first = enroll(earlier, "prompt:earlier" as OwnerInputId);
			const current = enroll(latest, "steer:latest" as OwnerInputId, pasted);
			expect(current.openingEntryId).toBe(first.openingEntryId);
			manager.appendMessage({
				role: "assistant",
				api: "openai-completions",
				provider: "fixture",
				model: "fixture",
				content: [{ type: "text", text: "12" }],
				timestamp: Date.now(),
				stopReason: "stop",
				usage: createEmptyUsage(),
			});
			const { judges, consult } = fulfilledJudge(verdict("outside", subject));
			await reviewOrdinaryWork(work, judges, {
				expected: current,
				signal,
				mayDispatch: () => true,
				warn: deps.warn,
			});
			expect(consult).toHaveBeenCalledOnce();
			const payload = JSON.parse(consult.mock.calls[0]![0].message);
			expect(payload.earlierOwnerInputs).toBe(earlier);
			if (pasted) expect(payload.request).toContain("owner-paste");
			else expect(payload.request).toBe(latest);
			expect(ledger.ordinaryWork.get(first.sessionId, first.openingEntryId)).toMatchObject({
				reason,
				continuationCount: 0,
				status: reason === "fulfilled" ? "fulfilled" : "unverified",
			});
		} finally {
			ledger.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.each([
		["missing", answered, 0, "correction"],
		["missing", answered, ORDINARY_WORK_MAX_CONTINUATIONS, "limited"],
		["met", corrected, ORDINARY_WORK_MAX_CONTINUATIONS, "fulfilled"],
		["outside", stated, 0, "reporting_unverified"],
		["outside", "unrelated invented quote", 0, "reporting_review_invalid"],
		["overridden", stated, 0, "reporting_unverified"],
		["met", "fabricated", 0, "reporting_review_invalid"],
		["uncertain", "", 0, "reporting_unverified"],
	] as const)("handles a %s verdict with quote %s at continuation count %i", async (status, quote, count, outcome) => {
		const { judges, consult } = fulfilledJudge(verdict(status, quote));
		const result = await judges.decideOrdinaryWorkStop(
			{
				...evidence,
				request: stated,
				answer: status === "met" && quote === corrected ? corrected : answered,
				reporting: snapshot,
				isCurrentOwnerQuote: () => false,
			},
			count,
			signal,
		);
		if (outcome === "correction")
			expect(result).toMatchObject({ responseMode: "answer_only", missingReportingIds: [requirement.id] });
		else expect(result).toBe(outcome);
		expect(consult.mock.calls[0]?.[0].message).not.toContain(requirement.id);
	});

	it.each([
		[0.93, "reporting_override_unverified"],
		[0.82, "correction"],
		[0.09, "correction"],
		[null, "reporting_unverified"],
	] as const)("bounds a reviewer's proposed correction at restriction score %s", async (restriction, expected) => {
		const { judges } = fulfilledJudge(verdict("missing", ""), 1, restriction);
		const result = await judges.decideOrdinaryWorkStop({ ...evidence, reporting: snapshot }, 0, signal);
		if (expected === "correction") expect(result).toMatchObject({ responseMode: "answer_only" });
		else expect(result).toBe(expected);
	});

	it("can repair reporting on a provisionally supported normal stop without certifying the substantive answer", async () => {
		const base: OrdinaryWorkStopEvidence = {
			...reportEvidence,
			answer: answered,
			reporting: snapshot,
			hostFacts: {
				...reportEvidence.hostFacts,
				interrupted: false,
				terminalStopReason: "stop",
				finalAnswerPresent: true,
			},
		};
		const { judges, consult } = fulfilledJudge(verdict("missing", answered), 0.91);
		expect(await judges.decideOrdinaryWorkStop(base, 0, signal)).toMatchObject({ responseMode: "answer_only" });
		expect(await judges.decideOrdinaryWorkStop(base, ORDINARY_WORK_MAX_CONTINUATIONS, signal)).toBe("limited");
		expect(
			await fulfilledJudge(verdict("met", corrected), 0.92).judges.decideOrdinaryWorkStop(
				{ ...base, answer: corrected },
				0,
				signal,
			),
		).toBe("unverified");
		consult.mockClear();
		expect(await judges.decideOrdinaryWorkStop({ ...base, receiptSources: [] }, 0, signal)).toBe("unverified");
		expect(consult).not.toHaveBeenCalled();
		const insufficient = fulfilledJudge(verdict("missing", answered), 0.51);
		expect(await insufficient.judges.decideOrdinaryWorkStop(base, 0, signal)).toBe("unverified");
		expect(insufficient.consult).not.toHaveBeenCalled();
	});

	it("requires current owner words to establish that a request falls outside a rule", async () => {
		const subject = "weather forecast";
		const quotation = `The sample says “${subject}”.`;
		const pasted = `${stated} Pasted sample: ${subject}`;
		const inline = "Give the forecast for `London`.";
		for (const [request, quote, pasteStart, expected] of [
			[`${stated} ${quotation}`, subject, -1, "reporting_unverified"],
			[pasted, subject, pasted.indexOf(subject), "reporting_unverified"],
			[`${quotation} Give me the ${subject}.`, subject, -1, "fulfilled"],
			[inline, "London", -1, "reporting_unverified"],
			[inline, "forecast for `London`", -1, "fulfilled"],
		] as const) {
			const { judges } = fulfilledJudge(verdict("outside", quote));
			const words = { text: request, pasted: pasteStart < 0 ? [] : [{ start: pasteStart, end: pasted.length }] };
			expect(
				await judges.decideOrdinaryWorkStop(
					{
						...evidence,
						request,
						answer: "Rain.",
						reporting: snapshot,
						isCurrentOwnerQuote: (quote) => containsStatedOwnerQuote(words, quote),
					},
					0,
					signal,
				),
			).toBe(expected);
		}
	});

	it("requires exact coverage and checks an override against stated current-owner words", () => {
		const override = "For this answer omit the filename.";
		const quoted = `The manual says “${override}”`;
		expect(containsStatedOwnerQuote({ text: quoted }, override)).toBe(false);
		expect(containsStatedOwnerQuote({ text: `${quoted} ${override}` }, override)).toBe(true);
		expect(containsStatedOwnerQuote({ text: override, pasted: [{ start: 0, end: override.length }] }, override)).toBe(
			false,
		);
		expect(
			reportingVerdict(verdict("overridden", override), snapshot, override, answered, (q) => q === override),
		).toBe("reporting_override_unverified");
		const rules = { ...snapshot, requirements: [requirement, { id: "source", text: "Name the source." }] };
		for (const [first, second] of [
			["missing", "overridden"],
			["overridden", "missing"],
		]) {
			const checks = [first, second].map((status, index) => ({
				ref: index + 1,
				verdict: status,
				...(status === "overridden" ? { quote: override } : {}),
			}));
			expect(reportingVerdict(JSON.stringify({ checks }), rules, override, answered, (q) => q === override)).toBe(
				"reporting_override_unverified",
			);
		}
		for (const checks of [
			[],
			[{ ref: 2, verdict: "met", quote: answered }],
			Array(2).fill({ ref: 1, verdict: "met", quote: answered }),
		])
			expect(reportingVerdict(JSON.stringify({ checks }), snapshot, stated, answered, undefined)).toBe(
				"reviewer_invalid_response",
			);
		expect(
			reportingVerdict(
				JSON.stringify({ checks: [{ ref: 1, verdict: "met", quote: answered }] }),
				snapshot,
				stated,
				answered,
				undefined,
			),
		).toBe("reviewer_invalid_response");
		expect(projectReportingRequirements(snapshot, () => "[REDACTED]")).toBeUndefined();
	});

	it.each(["graceful", "crash"] as const)(
		"fences reporting at dispatch and through a %s restart without journaling private words",
		async (shutdown) => {
			const dir = mkdtempSync(join(tmpdir(), "pi-reporting-revision-"));
			const store = new DecisionLedgerStore({ databasePath: join(dir, "decisions.sqlite") });
			try {
				const manager = SessionManager.create(dir, ownerSessionStorageRoots(dir));
				let current = true;
				const work = new OrdinaryWorkController({
					getSessionManager: () => manager,
					getStore: () => store.ordinaryWork,
					isEnabled: () => true,
					reportingRequirements: () => ({ ...snapshot, isCurrent: () => current }),
				});
				const input = { role: "user" as const, content: stated, timestamp: 1 };
				const id = "prompt:format-reply" as OwnerInputId;
				stampOwnerInput(input, id);
				const opening = work.noteOwnerInput({ id, message: input, entryId: manager.appendMessage(input) })!;
				const answer: AssistantMessage = {
					role: "assistant",
					api: "openai-completions",
					provider: "fixture",
					model: "fixture",
					content: [{ type: "text", text: answered }],
					stopReason: "stop",
					usage: createEmptyUsage(),
					timestamp: 2,
				};
				manager.appendMessage(answer);
				const { judges } = fulfilledJudge(verdict("missing", answered));
				const follow = await reviewOrdinaryWork(work, judges, {
					expected: opening,
					answer,
					signal,
					mayDispatch: () => true,
					warn: () => {},
				});
				expect(follow).toMatchObject({ details: { reportingRevision: true, responseMode: "answer_only" } });
				expect(JSON.stringify(follow)).not.toContain(requirement.text);
				const record = work.current();
				expect(record?.continuationCount).toBe(1);
				expect(work.reportingRevision(record)).toContain(requirement.text);
				const dispatch = () => assertOrdinaryDispatch(follow, record, () => !!work.reportingRevision(record));
				expect(dispatch).not.toThrow();
				const agent = new Agent();
				const runtime = new ProviderRequestRuntimeController({
					agent,
					ordinaryWork: work,
					context: { plan: async (messages) => ({ messages }) },
					compaction: {
						admitProviderRequest: async () => ({ action: "send" }),
						measureLiveContextTokens: () => 0,
					},
					parentInputs: manager,
					getSubmissionEpoch: () => undefined,
					admitGoalRequest: () => undefined,
					maxOutputTokens: () => 128,
					shouldStopGoalExecutionAfterTurn: () => false,
				});
				runtime.install();
				const planned = await agent.planContext!({
					messages: [input, answer],
					requestOpening: follow,
					attempt: 0,
					sentPrefixCount: 0,
				});
				expect(planned.transientSystemPrompt).toContain(requirement.text);
				expect(planned.isDispatchCurrent?.()).toBe(true);
				current = false;
				expect(planned.isDispatchCurrent?.()).toBe(false);
				expect(planned.prepareCommit?.()).toBe(false);
				expect(dispatch).toThrow("reserved generation");
				runtime.dispose();
				if (shutdown === "graceful") work.release();
				else {
					const database = new DatabaseSync(join(dir, "decisions.sqlite"));
					try {
						database
							.prepare("UPDATE ordinary_work SET lease_pid = ? WHERE lease_id = ?")
							.run(2147483647, record!.leaseId!);
					} finally {
						database.close();
					}
				}
				const reopened = new OrdinaryWorkController({
					getSessionManager: () => manager,
					getStore: () => store.ordinaryWork,
					isEnabled: () => true,
				});
				expect(reopened.recover()).toBeUndefined();
				expect(reopened.current()).toMatchObject({
					status: "unverified",
					reason: "reporting_unverified",
					continuationCount: 1,
				});
			} finally {
				store.close();
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);

	it("does not consult on ordinary fulfillment without confirmed requirements or authorize stale revisions", async () => {
		const { judges, consult } = fulfilledJudge(verdict("missing", answered));
		const base = { ...evidence, request: stated, answer: answered };
		expect(await judges.decideOrdinaryWorkStop(base, 0, signal)).toBe("fulfilled");
		expect(
			await judges.decideOrdinaryWorkStop({ ...base, reporting: { ...snapshot, complete: false } }, 0, signal),
		).toBe("reporting_unverified");
		expect(
			await judges.decideOrdinaryWorkStop(
				{ ...base, reporting: { ...snapshot, isCurrent: () => false } },
				0,
				signal,
			),
		).toBe("reporting_changed");
		expect(
			await judges.decideOrdinaryWorkStop(
				{ ...base, reporting: { requirements: [], complete: false, isCurrent: () => false } },
				0,
				signal,
			),
		).toBe("reporting_unverified");
		expect(consult).not.toHaveBeenCalled();
	});
});
