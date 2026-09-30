import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openSqliteDatabase } from "../src/core/context/sqlite-database.ts";
import { DecisionLedgerStore } from "../src/core/operator-projection/decision-ledger-store.ts";
import { tempDir } from "./temp-dir.ts";

describe("semantic evaluation restoration rows", () => {
	it("migrates legacy rows and returns the complete ordered session history", () => {
		const databasePath = join(tempDir("pi-semantic-ledger-"), "decision-ledger.sqlite");
		const legacy = openSqliteDatabase({ databasePath });
		legacy.exec(`
			CREATE TABLE semantic_evaluations (
				evaluation_id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				cwd TEXT NOT NULL,
				program_id TEXT NOT NULL,
				label TEXT NOT NULL,
				consequence TEXT,
				started_at INTEGER NOT NULL,
				ended_at INTEGER,
				outcome TEXT,
				verdict TEXT,
				reasons TEXT,
				model TEXT
			);
		`);
		legacy
			.prepare(
				`INSERT INTO semantic_evaluations
				 (evaluation_id, session_id, cwd, program_id, label, started_at, ended_at, outcome, reasons)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				"legacy",
				"session",
				"/project",
				"rule_program_1",
				"project rules",
				1,
				2,
				"ok",
				'["unsure: old question"]',
			);
		legacy[Symbol.dispose]();

		const store = new DecisionLedgerStore({ databasePath });
		for (let index = 0; index < 40; index++) {
			store.startSemanticEvaluation({
				evaluationId: `evaluation-${index}`,
				sessionId: "session",
				cwd: "/project",
				programId: `rule_program_${index}`,
				label: "project rules",
				startedAt: 10,
				evaluationScope: { kind: "worker-task", id: '["objective","task"]' },
				questionNamespace: "project-rules",
			});
		}

		const evaluations = store.semanticEvaluations("session");
		expect(evaluations).toHaveLength(41);
		expect(evaluations[0]).toMatchObject({ evaluationId: "legacy" });
		expect(evaluations[0]).not.toHaveProperty("questionNamespace");
		expect(evaluations[0]).not.toHaveProperty("evaluationScope");
		expect(evaluations[1]).toMatchObject({
			evaluationId: "evaluation-0",
			evaluationScope: { kind: "worker-task", id: '["objective","task"]' },
			questionNamespace: "project-rules",
		});
		expect(store.recentSemanticEvaluations("session", 2)).toHaveLength(2);
		store.close();
	});

	it("persists advisory decisions by session and replays exact evidence without rewriting judgments", () => {
		const databasePath = join(tempDir("pi-semantic-advisory-"), "decision-ledger.sqlite");
		const store = new DecisionLedgerStore({ databasePath });
		const decision = {
			evaluationId: "evaluation-a",
			question: "worker_stuck",
			disposition: "conservative_path" as const,
			reason: "The semantic result was uncertain, so proceed with the safer bounded plan.",
			evidence: "Observed 4 tool calls and 10 seconds without changed files.",
			decidedAt: 100,
		};
		store.recordSemanticDoubtDecision("session-a", decision);
		store.recordSemanticDoubtDecision("session-a", decision);
		store.recordSemanticDoubtDecision("session-b", { ...decision, reason: "Separate session decision." });

		expect(store.semanticDoubtDecisions("session-a")).toEqual([decision]);
		expect(store.semanticDoubtDecisions("session-b")).toEqual([
			{ ...decision, reason: "Separate session decision." },
		]);
		expect(() =>
			store.recordSemanticDoubtDecision("session-a", { ...decision, reason: "Conflicting durable explanation." }),
		).toThrow(/conflicting semantic doubt decision/i);
		expect(store.semanticEvaluations("session-a")).toEqual([]);
		store.close();
	});

	it("round-trips full question identities and distinguishes an authoritative empty state from legacy absence", () => {
		const databasePath = join(tempDir("pi-semantic-question-state-"), "decision-ledger.sqlite");
		const store = new DecisionLedgerStore({ databasePath });
		const longQuestion = `question_${"x".repeat(180)}_exact-suffix`;
		for (const evaluationId of ["full-state", "empty-state", "legacy-state"]) {
			store.startSemanticEvaluation({
				evaluationId,
				sessionId: "session",
				cwd: "/project",
				programId: "check",
				label: "check",
				startedAt: evaluationId === "full-state" ? 1 : evaluationId === "empty-state" ? 2 : 3,
			});
		}
		store.settleSemanticEvaluation("full-state", {
			endedAt: 4,
			outcome: "ok",
			questionStates: [{ question: longQuestion, uncertain: true, text: `${longQuestion.slice(0, 119)}…` }],
		});
		store.noteSemanticVerdict(
			"full-state",
			"policy-reviewed",
			["policy recheck"],
			[{ question: longQuestion, uncertain: false }],
		);
		store.settleSemanticEvaluation("empty-state", {
			endedAt: 5,
			outcome: "ok",
			questionStates: [],
		});
		store.settleSemanticEvaluation("legacy-state", { endedAt: 6, outcome: "ok", reasons: ["unsure: old"] });

		store.close();
		const reopened = new DecisionLedgerStore({ databasePath });
		const rows = reopened.semanticEvaluations("session");
		expect(rows[0]).toMatchObject({ verdict: "policy-reviewed", reasons: ["policy recheck"] });
		expect(rows[0]?.questionStates).toEqual([{ question: longQuestion, uncertain: false }]);
		expect(rows[1]?.questionStates).toEqual([]);
		expect(rows[2]).not.toHaveProperty("questionStates");
		reopened.close();
	});
});
