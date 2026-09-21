import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DecisionLedgerStore } from "../src/core/operator-projection/decision-ledger-store.ts";
import {
	DecisionStageLog,
	type DecisionStageSink,
	type DecisionStageStoredEntry,
	deriveDecisionStage,
	isIdleProjection,
} from "../src/core/operator-projection/decision-stage-log.ts";
import type {
	ActiveActor,
	OperatorControlProjection,
	OperatorPhase,
	OperatorProjection,
} from "../src/core/operator-projection/types.ts";

function projection(overrides: {
	phase?: OperatorPhase;
	control?: Partial<OperatorControlProjection>;
	actors?: readonly ActiveActor[];
	action?: string;
	objectiveId?: string;
}): OperatorProjection {
	return {
		schema_version: "1.0",
		objective_id: overrides.objectiveId ?? "goal-1",
		title: "orbit",
		phase: overrides.phase ?? "build",
		phase_index: 3,
		phase_count: 6,
		current_action: overrides.action ?? "Implementing",
		why: "Advancing the objective",
		next_action: null,
		health: "normal",
		control: { owner: "system_one", state: "deciding", reasonCode: "goal_active", ...overrides.control },
		active_actors: overrides.actors ?? [{ id: "root", kind: "root", label: "Root orchestrator" }],
		adaptation: null,
		proof: { satisfied: 0, total: 0, failing: 0, pending: 0 },
		context: null,
	};
}

/** A sink that keeps rows in memory, so the log's contract is tested without a database. */
function memorySink(): DecisionStageSink & { rows: DecisionStageStoredEntry[] } {
	const rows: DecisionStageStoredEntry[] = [];
	return {
		rows,
		open(entry) {
			const rowId = rows.length + 1;
			rows.push({ ...entry, rowId });
			return rowId;
		},
		close(rowId, endedAt) {
			const index = rows.findIndex((row) => row.rowId === rowId);
			if (index >= 0) rows[index] = { ...rows[index]!, endedAt };
		},
		load: () => rows,
	};
}

describe("deriveDecisionStage", () => {
	it("maps every rule of the table in order", () => {
		expect(deriveDecisionStage(projection({ phase: "done" }))).toBe("done");
		expect(deriveDecisionStage(projection({ control: { owner: "user", state: "awaiting_user" } }))).toBe("clarify");
		expect(
			deriveDecisionStage(
				projection({ control: { state: "observing", reasonCode: "acceptance_evidence_required" } }),
			),
		).toBe("observe");
		expect(
			deriveDecisionStage(
				projection({ control: { reasonCode: "verification_repair_required", state: "verifying" } }),
			),
		).toBe("repair");
		expect(deriveDecisionStage(projection({ phase: "blocked" }))).toBe("repair");
		expect(deriveDecisionStage(projection({ phase: "deliver" }))).toBe("deliver");
		expect(deriveDecisionStage(projection({ phase: "verify" }))).toBe("verify");
		expect(
			deriveDecisionStage(projection({ control: { state: "verifying", reasonCode: "goal_completion_required" } })),
		).toBe("verify");
		expect(deriveDecisionStage(projection({ actors: [{ id: "lane-1", kind: "worker", label: "tester" }] }))).toBe(
			"dispatch",
		);
		expect(deriveDecisionStage(projection({ phase: "plan" }))).toBe("plan");
		expect(deriveDecisionStage(projection({ phase: "understand" }))).toBe("understand");
		expect(deriveDecisionStage(projection({ phase: "adapt" }))).toBe("build");
		expect(deriveDecisionStage(projection({}))).toBe("build");
	});

	it("keeps a running worker in repair while a red obligation is open; a stall stop is not repair", () => {
		expect(
			deriveDecisionStage(
				projection({
					control: { reasonCode: "verification_repair_required", state: "verifying" },
					actors: [{ id: "lane-1", kind: "worker", label: "tester" }],
				}),
			),
		).toBe("repair");
		expect(deriveDecisionStage(projection({ control: { reasonCode: "stall_limit_reached" } }))).toBe("build");
	});
});

describe("DecisionStageLog", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("opens nothing for an idle projection and closes the open entry when the session goes idle", () => {
		const idle = projection({
			phase: "understand",
			control: { owner: "root", state: "deciding", reasonCode: "no_objective" },
		});
		expect(isIdleProjection(idle)).toBe(true);
		expect(
			isIdleProjection(projection({ control: { owner: "root", state: "executing", reasonCode: "no_objective" } })),
		).toBe(false);
		const log = new DecisionStageLog();
		expect(log.observe(idle, 1000)).toBe(false);
		expect(log.view(2000).entries).toEqual([]);
		expect(log.view(2000).open).toBeUndefined();
		expect(
			log.observe(projection({ control: { owner: "root", state: "executing", reasonCode: "no_objective" } }), 3000),
		).toBe(true);
		expect(log.view(3500).open?.stage).toBe("build");
		expect(log.observe(idle, 4000)).toBe(false);
		const view = log.view(9000);
		expect(view.open).toBeUndefined();
		expect(view.entries).toHaveLength(1);
		expect(view.totals.build).toEqual({ elapsedMs: 1000, passes: 1 });
	});

	it("records transitions with accumulated totals, pass counts and the loop counter", () => {
		const log = new DecisionStageLog();
		expect(log.observe(projection({ phase: "understand" }), 1000)).toBe(true);
		expect(log.observe(projection({ phase: "understand" }), 1500)).toBe(false);
		expect(log.observe(projection({ phase: "plan" }), 3000)).toBe(true);
		expect(log.observe(projection({}), 4000)).toBe(true);
		expect(log.observe(projection({ phase: "verify" }), 9000)).toBe(true);
		expect(
			log.observe(
				projection({ control: { reasonCode: "verification_repair_required", state: "verifying" } }),
				10000,
			),
		).toBe(true);
		expect(
			log.observe(
				projection({ control: { reasonCode: "verification_repair_required", state: "verifying" } }),
				10500,
			),
		).toBe(false);
		expect(log.observe(projection({ phase: "verify" }), 12000)).toBe(true);
		const view = log.view(13000);
		expect(view.loop).toBe(2);
		expect(view.open?.stage).toBe("verify");
		expect(view.open?.loop).toBe(2);
		expect(view.totals.understand).toEqual({ elapsedMs: 2000, passes: 1 });
		expect(view.totals.build).toEqual({ elapsedMs: 5000, passes: 1 });
		expect(view.totals.repair).toEqual({ elapsedMs: 2000, passes: 1 });
		expect(view.totals.verify).toEqual({ elapsedMs: 2000, passes: 2 });
		expect(view.entries.map((entry) => entry.stage)).toEqual([
			"understand",
			"plan",
			"build",
			"verify",
			"repair",
			"verify",
		]);
	});

	it("increments the loop only on entry to repair and keeps totals complete after eviction", () => {
		const log = new DecisionStageLog();
		log.observe(projection({}), 0);
		log.observe(projection({ control: { reasonCode: "verification_repair_required" } }), 1000);
		log.observe(projection({ control: { reasonCode: "blocked_requirements_present" } }), 2000);
		expect(log.view(3000).loop).toBe(2);

		const bounded = new DecisionStageLog();
		let now = 0;
		for (let i = 0; i < 300; i++) {
			bounded.observe(projection({ phase: i % 2 === 0 ? "build" : "verify" }), now);
			now += 10;
		}
		const view = bounded.view(now);
		expect(view.entries.length).toBe(256);
		expect(view.totals.build.elapsedMs + view.totals.verify.elapsedMs).toBe(300 * 10);
		expect(view.totals.build.passes + view.totals.verify.passes).toBe(300);
	});

	it("writes through the sink and rehydrates timers, loop and the open stage from it", () => {
		const sink = memorySink();
		const first = new DecisionStageLog({ sink });
		first.observe(projection({ phase: "understand", action: "Framing the request" }), 1000);
		first.observe(projection({}), 3000);
		first.observe(projection({ control: { reasonCode: "verification_repair_required" } }), 6000);
		expect(sink.rows).toHaveLength(3);
		expect(sink.rows[0]).toMatchObject({
			stage: "understand",
			enteredAt: 1000,
			endedAt: 3000,
			objectiveId: "goal-1",
		});

		const resumed = new DecisionStageLog({ sink });
		const view = resumed.view(8000);
		expect(view.loop).toBe(2);
		expect(view.open?.stage).toBe("repair");
		expect(view.open?.enteredAt).toBe(6000);
		expect(view.totals.understand).toEqual({ elapsedMs: 2000, passes: 1 });
		expect(view.totals.build).toEqual({ elapsedMs: 3000, passes: 1 });
		expect(view.totals.repair).toEqual({ elapsedMs: 2000, passes: 1 });
		expect(view.entries[0]?.note).toBe("Framing the request");
		expect(resumed.observe(projection({ control: { reasonCode: "verification_repair_required" } }), 9000)).toBe(
			false,
		);
		expect(resumed.view(9000).open?.enteredAt).toBe(6000);
		// The resumed log settles the row it inherited, not a new one.
		resumed.observe(projection({ phase: "verify" }), 9500);
		expect(sink.rows[2]?.endedAt).toBe(9500);
		expect(sink.rows).toHaveLength(4);
	});

	it("starts a new loop on an objective change while the sink keeps every row", () => {
		const sink = memorySink();
		const log = new DecisionStageLog({ sink });
		log.observe(projection({}), 1000);
		log.observe(projection({ control: { reasonCode: "verification_repair_required" } }), 2000);
		log.observe(projection({ phase: "understand", objectiveId: "goal-2" }), 4000);
		expect(log.view(5000).loop).toBe(1);
		expect(log.view(5000).entries.map((entry) => entry.stage)).toEqual(["understand"]);
		expect(sink.rows).toHaveLength(3);
		expect(sink.rows[1]?.endedAt).toBe(4000);
		const resumed = new DecisionStageLog({ sink });
		expect(resumed.view(6000).entries.map((entry) => entry.stage)).toEqual(["understand"]);
		expect(resumed.view(6000).totals.build).toEqual({ elapsedMs: 0, passes: 0 });
	});

	it("persists into the SQLite decision ledger, keyed by session, and reads back per session", () => {
		const dir = mkdtempSync(join(tmpdir(), "decision-ledger-"));
		dirs.push(dir);
		const store = new DecisionLedgerStore({ databasePath: join(dir, "state", "decision-ledger.sqlite") });
		const a = new DecisionStageLog({ sink: store.stageSink("session-a", "/repo") });
		const b = new DecisionStageLog({ sink: store.stageSink("session-b", "/repo") });
		a.observe(projection({ phase: "understand" }), 1000);
		a.observe(projection({}), 2000);
		b.observe(projection({ phase: "plan" }), 1500);
		expect(store.loadStages("session-a").map((row) => [row.stage, row.endedAt])).toEqual([
			["understand", 2000],
			["build", undefined],
		]);
		expect(store.loadStages("session-b").map((row) => row.stage)).toEqual(["plan"]);
		store.close();

		const reopened = new DecisionLedgerStore({ databasePath: join(dir, "state", "decision-ledger.sqlite") });
		const resumedA = new DecisionStageLog({ sink: reopened.stageSink("session-a", "/repo") });
		expect(resumedA.view(5000).open?.stage).toBe("build");
		expect(resumedA.view(5000).totals.understand).toEqual({ elapsedMs: 1000, passes: 1 });
		reopened.startSemanticEvaluation({
			evaluationId: "e1",
			sessionId: "session-a",
			cwd: "/repo",
			programId: "pi:steering:program:JEV-001:1.0",
			label: "objective intake",
			startedAt: 100,
		});
		reopened.settleSemanticEvaluation("e1", {
			endedAt: 1600,
			outcome: "ok",
			verdict: "pass",
			reasons: ["sufficient"],
		});
		expect(reopened.recentSemanticEvaluations("session-a", 5)).toMatchObject([
			{ evaluationId: "e1", outcome: "ok", verdict: "pass", reasons: ["sufficient"], endedAt: 1600 },
		]);
		reopened.close();
	});
});
