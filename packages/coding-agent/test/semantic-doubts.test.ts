import { describe, expect, it } from "vitest";
import { type SemanticDoubtDecision, SemanticDoubtTracker } from "../src/core/system-one/semantic-doubts.ts";
import {
	doubtReason,
	PROGRAM_SETTLED_REASON,
	type SemanticEvaluationRecord,
} from "../src/core/system-one/semantic-evaluation-ledger.ts";
import { SemanticPlaneHealthRecorder, semanticPlaneHealthValue } from "../src/core/system-one/semantic-plane-health.ts";

describe("live semantic doubts", () => {
	it("keeps one question beyond the historical ring and removes it on a decisive recheck", () => {
		const recorder = new SemanticPlaneHealthRecorder(() => 100);
		const unsure = recorder.start({ programId: "check-a" });
		recorder.settleOk(unsure, "evaluated", [doubtReason("predicate: P(yes)=0.50 · unsure")]);
		expect(semanticPlaneHealthValue(recorder.getHealth(true))).toBe("ok · 1 uncertain");
		for (let index = 0; index < 40; index++) {
			const other = recorder.start({ programId: "other" });
			recorder.settleOk(other, "pass", [PROGRAM_SETTLED_REASON]);
		}
		expect(recorder.getRecentEvaluations().some((record) => record.evaluationId === unsure)).toBe(false);
		expect(recorder.getHealth(true).unresolvedDoubts).toHaveLength(1);
		const repeated = recorder.start({ programId: "check-a" });
		recorder.settleOk(repeated, "evaluated", [doubtReason("predicate: P(yes)=0.51 · unsure")]);
		expect(recorder.getHealth(true).unresolvedDoubts).toHaveLength(1);
		const recheck = recorder.start({ programId: "check-a" });
		recorder.settleOk(recheck, "evaluated", ["predicate: P(yes)=0.99 · pass"]);
		expect(recorder.getHealth(true).unresolvedDoubts).toHaveLength(0);
		expect(semanticPlaneHealthValue(recorder.getHealth(true))).toBe("ok");
	});

	it("does not resolve another question or turn outages and cancellation into resolution", () => {
		const recorder = new SemanticPlaneHealthRecorder(() => 100);
		const unsure = recorder.start({ programId: "check" });
		recorder.settleOk(unsure, "evaluated", [doubtReason("a: unsure"), doubtReason("b: unsure")]);
		const another = recorder.start({ programId: "check" });
		recorder.settleOk(another, "evaluated", ["unrelated: pass"]);
		const failure = recorder.start({ programId: "check" });
		recorder.settleFailed(failure, new Error("evaluator unavailable"));
		const cancelled = recorder.start({ programId: "check" });
		recorder.settleCancelled(cancelled);
		expect(recorder.getHealth(true).unresolvedDoubts).toHaveLength(2);
		const recheck = recorder.start({ programId: "check" });
		recorder.settleOk(recheck, "evaluated", ["a: fail"]);
		expect(recorder.getHealth(true).unresolvedDoubts?.map((doubt) => doubt.question)).toEqual(["b"]);
	});

	it("fences older settlements and policy notes behind newer decisive evidence", () => {
		const recorder = new SemanticPlaneHealthRecorder(() => 100);
		const stale = recorder.start({ programId: "check" });
		const fresh = recorder.start({ programId: "check" });
		recorder.settleOk(fresh, "evaluated", ["predicate: pass"]);
		recorder.settleOk(stale, "evaluated", [doubtReason("predicate: unsure")]);
		recorder.noteVerdict(stale, "needs_revision", [doubtReason("predicate: unsure")]);
		expect(recorder.getHealth(true).unresolvedDoubts).toHaveLength(0);
		const pending = recorder.start({ programId: "check" });
		recorder.settleOk(pending, "evaluated", [doubtReason("predicate: unsure")]);
		const allPass = recorder.start({ programId: "check" });
		recorder.settleOk(allPass, "pass", [PROGRAM_SETTLED_REASON]);
		recorder.noteVerdict(pending, "needs_revision", [doubtReason("predicate: unsure")]);
		expect(recorder.getHealth(true).unresolvedDoubts).toHaveLength(0);
	});

	it("applies a late policy verdict to an unresolved record evicted from recent history", () => {
		const recorder = new SemanticPlaneHealthRecorder(() => 100);
		const unsure = recorder.start({ programId: "check" });
		recorder.settleOk(unsure, "evaluated", [doubtReason("predicate: unsure")]);
		for (let index = 0; index < 40; index++) {
			const other = recorder.start({ programId: "other" });
			recorder.settleOk(other);
		}
		recorder.noteVerdict(unsure, "pass", [PROGRAM_SETTLED_REASON]);
		expect(recorder.getHealth(true).unresolvedDoubts).toHaveLength(0);
	});

	it("releases resolved question fences without evicting a long-lived unresolved question", () => {
		const tracker = new SemanticDoubtTracker();
		for (let index = 0; index < 1000; index++) {
			const id = `evaluation-${index}`;
			tracker.start(id, "check");
			tracker.observe({
				evaluationId: id,
				programId: "check",
				label: "check",
				startedAt: index,
				endedAt: index,
				durationMs: 0,
				outcome: "ok",
				verdict: "evaluated",
				reasons: [index === 0 ? doubtReason("pending: unsure") : `resolved-${index}: pass`],
			});
			tracker.forgetRecent(id);
		}
		expect(tracker.snapshot()).toHaveLength(1);
		const retained = tracker as unknown as { questions: Map<string, unknown> };
		expect(retained.questions.size).toBe(1);
	});

	it("keeps worker-task questions separate and resolves repeated ephemeral program questions", () => {
		const recorder = new SemanticPlaneHealthRecorder(() => 100);
		const workerA = recorder.start({
			programId: "supervision_eval_1",
			evaluationScope: { kind: "worker-task", id: "a" },
		});
		recorder.settleOk(workerA, "evaluated", [doubtReason("progress: unsure")]);
		const workerB = recorder.start({
			programId: "supervision_eval_2",
			evaluationScope: { kind: "worker-task", id: "b" },
		});
		recorder.settleOk(workerB, "pass", [PROGRAM_SETTLED_REASON]);
		expect(recorder.getHealth(true).unresolvedDoubts).toHaveLength(1);
		const recheck = recorder.start({
			programId: "supervision_eval_3",
			evaluationScope: { kind: "worker-task", id: "a" },
		});
		recorder.settleOk(recheck, "evaluated", ["progress: pass"]);
		expect(recorder.getHealth(true).unresolvedDoubts).toHaveLength(0);
	});

	it("rebuilds all live questions on reopen and fences completions from a switched session", () => {
		let sessionId = "session-a";
		const recorder = new SemanticPlaneHealthRecorder(() => 100);
		recorder.bindDurable(
			() => ({
				sessionId,
				readEvaluations: () =>
					sessionId === "session-a"
						? [
								{
									evaluationId: "persisted",
									programId: "check",
									label: "check",
									startedAt: 1,
									endedAt: 2,
									durationMs: 1,
									outcome: "ok" as const,
									reasons: [doubtReason("persisted-question: unsure")],
								},
							]
						: [],
				start: () => {},
				settle: () => {},
				noteVerdict: () => {},
			}),
			() => sessionId,
		);
		expect(recorder.getHealth(true).unresolvedDoubts).toHaveLength(1);
		const old = recorder.start({ programId: "check" });
		sessionId = "session-b";
		expect(recorder.getHealth(true).unresolvedDoubts).toHaveLength(0);
		expect(recorder.getHealth(true).state).toBe("unknown");
		recorder.settleOk(old, "evaluated", [doubtReason("late: unsure")]);
		expect(recorder.getHealth(true).unresolvedDoubts).toHaveLength(0);
		expect(recorder.getHealth(true).state).toBe("unknown");
		sessionId = "session-a";
		expect(recorder.getHealth(true).unresolvedDoubts).toHaveLength(1);
	});

	it("records an advisory decision without rewriting Jev evidence and reopens on a new judgment", () => {
		const records: SemanticEvaluationRecord[] = [];
		const decisions: SemanticDoubtDecision[] = [];
		const sink = {
			sessionId: "root-session",
			readEvaluations: () => records,
			readDoubtDecisions: () => decisions,
			recordDoubtDecision: (decision: SemanticDoubtDecision) => {
				decisions.push(decision);
			},
			start: () => {},
			settle: (record: SemanticEvaluationRecord) => {
				records.push(record);
			},
			noteVerdict: () => {},
		};
		const recorder = new SemanticPlaneHealthRecorder(() => 100);
		recorder.bindDurable(() => sink);
		const id = recorder.start({ programId: "check" });
		recorder.settleOk(id, "evaluated", [doubtReason("predicate: unsure")]);
		const resolution = {
			evaluationId: id,
			question: "predicate",
			disposition: "conservative_path" as const,
			reason: "Retain the current host-approved default.",
			evidence: "The supplied alternatives were inconclusive.",
		};
		expect(recorder.resolveOwnSession(resolution)).toEqual({ resolved: true });
		expect(recorder.listOwnSession()).toHaveLength(0);
		expect(decisions).toHaveLength(1);
		expect(records[0]?.verdict).toBe("evaluated");
		expect(records[0]?.reasons).toEqual([doubtReason("predicate: unsure")]);
		recorder.noteVerdict(id, "evaluated", [doubtReason("predicate: unsure")]);
		expect(recorder.listOwnSession()).toHaveLength(0);
		const reopened = new SemanticPlaneHealthRecorder(() => 100);
		reopened.bindDurable(() => sink);
		expect(reopened.listOwnSession()).toHaveLength(0);
		const fresh = reopened.start({ programId: "check" });
		reopened.settleOk(fresh, "evaluated", [doubtReason("predicate: still unsure")]);
		expect(reopened.resolveOwnSession(resolution)).toEqual({ resolved: false, reason: "stale_question" });
		expect(reopened.listOwnSession()).toHaveLength(1);
		const afterNewJudgment = new SemanticPlaneHealthRecorder(() => 100);
		afterNewJudgment.bindDurable(() => sink);
		expect(afterNewJudgment.listOwnSession()).toHaveLength(1);
	});

	it("lets the owning session disposition an advisory worker question without changing its scope or Jev evidence", () => {
		const record: SemanticEvaluationRecord = {
			evaluationId: "worker-question",
			programId: "supervision_eval_1",
			label: "worker supervision",
			startedAt: 1,
			endedAt: 2,
			durationMs: 1,
			outcome: "ok",
			verdict: "evaluated",
			reasons: [doubtReason("progress: unsure")],
			evaluationScope: { kind: "worker-task", id: JSON.stringify(["objective-1", "task-1"]) },
		};
		const decisions: SemanticDoubtDecision[] = [];
		const recorder = new SemanticPlaneHealthRecorder(() => 100);
		recorder.bindDurable(() => ({
			sessionId: "root-session",
			readEvaluations: () => [record],
			readDoubtDecisions: () => decisions,
			recordDoubtDecision: (decision) => decisions.push(decision),
			start: () => {},
			settle: () => {},
			noteVerdict: () => {},
		}));

		const doubt = recorder.listOwnSession()[0];
		expect(doubt?.evaluationScope).toEqual(record.evaluationScope);
		expect(
			recorder.resolveOwnSession({
				evaluationId: record.evaluationId,
				question: "progress",
				disposition: "evidence_based_decision",
				reason: "Reviewed the worker's report and retained the observed state.",
				evidence: "The worker reproduced the task state and reported the relevant tool results.",
			}),
		).toEqual({ resolved: true });
		expect(recorder.listOwnSession()).toHaveLength(0);
		expect(decisions).toHaveLength(1);
		expect(recorder.getRecentEvaluations()).toEqual([]);
		expect(recorder.getHealth(true).state).toBe("unknown");
		expect(record.verdict).toBe("evaluated");
		expect(record.reasons).toEqual([doubtReason("progress: unsure")]);
	});

	it("preserves legacy unknown scope during hydration while allowing its owning journal to disposition the doubt", () => {
		const legacy: SemanticEvaluationRecord = {
			evaluationId: "legacy-question",
			programId: "check",
			label: "check",
			startedAt: 1,
			endedAt: 2,
			durationMs: 1,
			outcome: "ok",
			verdict: "evaluated",
			reasons: [doubtReason("predicate: unsure")],
		};
		const decisions: SemanticDoubtDecision[] = [];
		const recorder = new SemanticPlaneHealthRecorder(() => 100);
		recorder.bindDurable(() => ({
			sessionId: "root-session",
			readEvaluations: () => [legacy],
			readDoubtDecisions: () => decisions,
			recordDoubtDecision: (decision) => decisions.push(decision),
			start: () => {},
			settle: () => {},
			noteVerdict: () => {},
		}));

		const doubt = recorder.listOwnSession()[0];
		expect(doubt?.evaluationScope).toBeUndefined();
		expect(
			recorder.resolveOwnSession({
				evaluationId: legacy.evaluationId,
				question: "predicate",
				disposition: "conservative_path",
				reason: "Keep the conservative default after reviewing the available evidence.",
				evidence: "The legacy record contains no worker or root evaluation scope.",
			}),
		).toEqual({ resolved: true });
		expect(recorder.listOwnSession()).toHaveLength(0);
		expect(decisions).toHaveLength(1);
	});

	it("retains questions on missing disposition evidence, failed journal writes and foreign root-session decisions", () => {
		const recorder = new SemanticPlaneHealthRecorder(() => 100);
		recorder.bindDurable(() => ({
			sessionId: "root-session",
			readEvaluations: () => [],
			start: () => {},
			settle: () => {},
			noteVerdict: () => {},
			recordDoubtDecision: () => {
				throw new Error("disk unavailable");
			},
		}));
		const id = recorder.start({ programId: "check" });
		recorder.settleOk(id, "evaluated", [doubtReason("predicate: unsure")]);
		const resolution = {
			evaluationId: id,
			question: "predicate",
			disposition: "evidence_based_decision" as const,
			reason: "Checked current evidence.",
			evidence: "Recorded check result.",
		};
		expect(recorder.resolveOwnSession({ ...resolution, evidence: "" })).toEqual({
			resolved: false,
			reason: "invalid_record",
		});
		expect(recorder.resolveOwnSession(resolution)).toEqual({ resolved: false, reason: "storage_unavailable" });
		expect(recorder.listOwnSession()).toHaveLength(1);
		const foreign = recorder.start({
			programId: "check",
			evaluationScope: { kind: "session", id: "foreign-session" },
		});
		recorder.settleOk(foreign, "evaluated", [doubtReason("predicate: unsure")]);
		expect(recorder.resolveOwnSession({ ...resolution, evaluationId: foreign })).toEqual({
			resolved: false,
			reason: "not_owned",
		});
		expect(recorder.listOwnSession()).toHaveLength(2);
	});
});
