import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DecisionLedgerStore } from "../src/core/operator-projection/decision-ledger-store.ts";
import { systemOneFailureReasons } from "../src/core/review/system-one-failure-diagnostics.ts";
import { SystemOneReviewError } from "../src/core/review/system-one-review-port.ts";
import { SystemOneReviewer } from "../src/core/review/typesafe-reviewer.ts";
import { SystemOneJevAdapter } from "../src/core/system-one/adapter.ts";
import type { SemanticEvaluationRecord } from "../src/core/system-one/semantic-evaluation-ledger.ts";
import { SemanticPlaneHealthRecorder } from "../src/core/system-one/semantic-plane-health.ts";
import { formatEvaluationRows } from "../src/core/tools/decision-ledger-read.ts";
import { tempDir } from "./temp-dir.ts";

describe("System One failure observability", () => {
	it("accepts later verdicts for restored previews and ignores records outside the retained bound", () => {
		const records: SemanticEvaluationRecord[] = Array.from({ length: 40 }, (_, index) => ({
			evaluationId: String(index),
			programId: `check-${index}`,
			label: "check",
			startedAt: index,
			endedAt: index + 1,
			durationMs: 1,
			outcome: "ok",
			questionStates: [],
		}));
		const noteVerdict = vi.fn();
		const recorder = new SemanticPlaneHealthRecorder();
		recorder.bindDurable(() => ({
			sessionId: "session",
			readEvaluations: () => records,
			start() {},
			settle() {},
			noteVerdict,
		}));
		expect(recorder.listOwnSession()).toEqual([]);
		recorder.noteVerdict("39", "uncertain", [], [{ question: "late question", uncertain: true }]);
		expect(recorder.listOwnSession()).toMatchObject([{ evaluationId: "39", question: "late question" }]);
		recorder.noteVerdict("0", "uncertain", [], [{ question: "expired question", uncertain: true }]);
		expect(noteVerdict).toHaveBeenCalledTimes(1);
		recorder.noteVerdict("39", "settled", [], [{ question: "late question", uncertain: false }]);
		expect(recorder.listOwnSession()).toEqual([]);
	});

	it("persists bounded rejection diagnostics and restores failed health without replaying settlements", async () => {
		const databasePath = join(tempDir("pi-semantic-failure-"), "ledger.sqlite");
		let store = new DecisionLedgerStore({ databasePath });
		const records = () =>
			store.semanticEvaluations("session").flatMap((row): SemanticEvaluationRecord[] =>
				row.endedAt === undefined || row.outcome === undefined
					? []
					: [
							{
								evaluationId: row.evaluationId,
								programId: row.programId,
								label: row.label,
								startedAt: row.startedAt,
								reasons: row.reasons,
								questionStates: row.questionStates,
								evaluationScope: row.evaluationScope,
								questionNamespace: row.questionNamespace,
								endedAt: row.endedAt,
								outcome: row.outcome,
								durationMs: row.endedAt - row.startedAt,
							},
						],
			);
		const sink = () => ({
			sessionId: "session",
			readEvaluations: records,
			start: (
				record: Parameters<SemanticPlaneHealthRecorder["start"]>[0] & {
					evaluationId: string;
					label: string;
					startedAt: number;
				},
			) => store.startSemanticEvaluation({ ...record, sessionId: "session", cwd: "/project" }),
			settle: (record: SemanticEvaluationRecord) => store.settleSemanticEvaluation(record.evaluationId, record),
			noteVerdict: () => {},
		});
		const recorder = new SemanticPlaneHealthRecorder();
		recorder.bindDurable(sink);
		const id = recorder.start({ programId: "system-one:route_choice", model: "jev-1.13.0" });
		const response = {
			detail: [
				{
					type: "literal_error",
					loc: ["body", "questions", "private-question", "type"],
					msg: "private-message apikey_private_fixture",
					input: "private-input",
					ctx: { secret: "private-context" },
				},
			],
			arbitrary: "private-response",
		};
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response(JSON.stringify(response), { status: 400 }));
		const reviewer = new SystemOneReviewer({ getApiKey: async () => "test-user-key", fetch: fetchMock });
		const adapter = new SystemOneJevAdapter(reviewer, undefined, { getApiKey: () => "test-user-key" });
		try {
			await adapter.evaluate({
				state: { text: "private-state" },
				questions: { check: { type: "noul", instructions: "private-instructions" } },
			});
			throw new Error("Expected provider rejection");
		} catch (error) {
			recorder.settleFailed(id, error);
		}
		store.close();
		store = new DecisionLedgerStore({ databasePath });
		try {
			const rows = store.semanticEvaluations("session");
			const text = formatEvaluationRows(rows);
			expect(text).toContain("HTTP 400");
			expect(text).toContain("invalid_request");
			expect(text).toMatch(/request sha256=[a-f0-9]{64}/);
			expect(text).toContain("attempts=1");
			expect(text).toContain("literal_error at body/questions/*/type");
			expect(text).not.toMatch(/private-|apikey_|test-user-key/);
			expect(rows[0]?.reasons?.length).toBeLessThanOrEqual(6);
			expect(rows[0]?.reasons?.every((line) => line.length <= 120)).toBe(true);
			const restored = new SemanticPlaneHealthRecorder();
			const notify = vi.fn();
			restored.subscribe(notify);
			restored.bindDurable(sink);
			expect(restored.getRecentEvaluations()).toHaveLength(1);
			expect(restored.getHealth(true)).toMatchObject({
				state: "degraded",
				lastFailedLabel: "model routing",
				lastFailureKind: "invalid_request",
			});
			expect(notify).not.toHaveBeenCalled();
			expect(store.semanticEvaluations("session")).toHaveLength(1);
		} finally {
			store.close();
		}
	});

	it("bounds malformed provider diagnostics and conceals dynamic keys even when they match schema names", () => {
		const request = {
			model: "jev-1.13.0",
			state: {},
			questions: { check: { type: "noul" as const, instructions: "Check" } },
		};
		for (const response of [
			{ detail: "private-body" },
			{
				detail: Array.from({ length: 40 }, () => ({
					type: "private-code",
					loc: ["body", "questions", "model", "criteria", "state", "private-field"],
					msg: "private-message",
					input: "private-input",
				})),
			},
		]) {
			const reasons = systemOneFailureReasons(
				new SystemOneReviewError("TypeSafe HTTP 400", "a".repeat(64), request, response, [
					{ attempt: 1, status: 400 },
				]),
			);
			expect(reasons.length).toBeLessThanOrEqual(6);
			expect(reasons.every((line) => line.length <= 120)).toBe(true);
			expect(reasons.join("\n")).not.toMatch(/private-|questions\/model|criteria\/state/);
		}
	});

	it("keeps late failures with their originating session after a session switch", () => {
		let sessionId = "first";
		const histories = new Map<string, SemanticEvaluationRecord[]>();
		const recorder = new SemanticPlaneHealthRecorder();
		recorder.bindDurable(() => {
			const owner = sessionId;
			return {
				sessionId: owner,
				readEvaluations: () => histories.get(owner) ?? [],
				start() {},
				settle(record: SemanticEvaluationRecord) {
					const rows = histories.get(owner) ?? [];
					rows.push(record);
					histories.set(owner, rows);
				},
				noteVerdict() {},
			};
		});
		const first = recorder.start({ programId: "system-one:route_choice" });
		sessionId = "second";
		const second = recorder.start({ programId: "system-one:preflight" });
		recorder.settleOk(second);
		recorder.settleFailed(first, new Error("TypeSafe HTTP 400"));
		expect(histories.get("first")).toMatchObject([{ outcome: "failed" }]);
		expect(recorder.getRecentEvaluations()).toMatchObject([{ evaluationId: second, outcome: "ok" }]);
		expect(recorder.getHealth(true).state).toBe("ok");
	});

	it("restores completion order and cancellation while retaining older unresolved doubts beyond the preview bound", () => {
		const records: SemanticEvaluationRecord[] = Array.from({ length: 40 }, (_, index) => ({
			evaluationId: String(index),
			programId: `check-${index}`,
			label: "check",
			startedAt: index,
			endedAt: index + 1,
			durationMs: 1,
			outcome: "ok",
			...(index === 0 ? { reasons: ["unsure: old question"] } : {}),
		}));
		records[1] = { ...records[1], outcome: "failed", endedAt: 100, reasons: ["HTTP 400"] };
		records.push({ ...records[39], evaluationId: "cancelled", startedAt: 99, endedAt: 101, outcome: "cancelled" });
		const recorder = new SemanticPlaneHealthRecorder();
		recorder.bindDurable(() => ({
			sessionId: "session",
			readEvaluations: () => records,
			start() {},
			settle() {},
			noteVerdict() {},
		}));
		expect(recorder.getRecentEvaluations()).toHaveLength(32);
		expect(recorder.getLastEvaluation()?.outcome).toBe("cancelled");
		expect(recorder.getHealth(true)).toMatchObject({ state: "degraded", lastOutcomeAt: new Date(100).toISOString() });
		expect(recorder.listOwnSession()).toMatchObject([{ question: "old question" }]);
		const cancelled = Array.from({ length: 40 }, (_, index) => ({
			...records.at(-1)!,
			evaluationId: `cancel-${index}`,
			startedAt: 200 + index,
			endedAt: 201 + index,
		}));
		const afterCancellation = new SemanticPlaneHealthRecorder();
		afterCancellation.bindDurable(() => ({
			sessionId: "session",
			readEvaluations: () => [...records, ...cancelled],
			start() {},
			settle() {},
			noteVerdict() {},
		}));
		expect(afterCancellation.getRecentEvaluations().every((record) => record.outcome === "cancelled")).toBe(true);
		expect(afterCancellation.getHealth(true).state).toBe("degraded");
	});
});
