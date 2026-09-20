import { visibleWidth } from "@caupulican/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { LaneRecord } from "../src/core/autonomy/lane-tracker.ts";
import type { DecisionStageLogView } from "../src/core/operator-projection/decision-stage-log.ts";
import { DecisionStageLog } from "../src/core/operator-projection/decision-stage-log.ts";
import type { OperatorProjection } from "../src/core/operator-projection/types.ts";
import type { SemanticEvaluationRecord } from "../src/core/system-one/semantic-evaluation-ledger.ts";
import {
	buildDecisionGraphModel,
	type DecisionGraphInput,
} from "../src/modes/interactive/components/decision-graph-model.ts";
import {
	renderDecisionDiagram,
	renderDecisionList,
} from "../src/modes/interactive/components/decision-graph-render.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const WIDTHS = [40, 48, 56, 64, 72, 96];

function projection(overrides: Partial<OperatorProjection> = {}): OperatorProjection {
	return {
		schema_version: "1.0",
		objective_id: "goal-1",
		title: "orbit",
		phase: "build",
		phase_index: 3,
		phase_count: 6,
		current_action: "Add flag parsing",
		why: "Add a --dry-run flag",
		next_action: "verify 3 open criteria",
		health: "normal",
		control: { owner: "system_one", state: "deciding", reasonCode: "goal_active" },
		active_actors: [{ id: "root", kind: "root", label: "Root orchestrator" }],
		adaptation: null,
		proof: { satisfied: 0, total: 3, failing: 0, pending: 3 },
		context: null,
		...overrides,
	};
}

function evaluation(label: string, verdict: string, startedAt: number): SemanticEvaluationRecord {
	return {
		evaluationId: `${label}-${startedAt}`,
		programId: "pi:steering:program:JEV-001:1.0",
		label,
		startedAt,
		endedAt: startedAt + 1500,
		durationMs: 1500,
		outcome: "ok",
		verdict,
		reasons: ["criterion 3: exit 1"],
	};
}

const lane = (overrides: Partial<LaneRecord> = {}): LaneRecord => ({
	laneId: "lane-tester",
	type: "worker",
	status: "running",
	label: "write the regression test",
	modelRef: "anthropic/claude-sonnet-4.6",
	profileId: "tester",
	startedAt: "2026-09-20T10:00:16.000Z",
	...overrides,
});

const T0 = Date.parse("2026-09-20T10:00:00.000Z");

/** A stage log driven through the reference run: understand → plan → build → dispatch → observe → verify → repair → clarify → repair → verify → deliver → done. */
function stageLogAt(step: number): DecisionStageLogView {
	const log = new DecisionStageLog();
	const script: [number, Partial<OperatorProjection>][] = [
		[2, { phase: "understand" }],
		[7, { phase: "plan" }],
		[9, { phase: "build" }],
		[16, { phase: "build", active_actors: [{ id: "lane-tester", kind: "worker", label: "tester" }] }],
		[
			24,
			{
				phase: "build",
				control: { owner: "system_one", state: "observing", reasonCode: "acceptance_evidence_required" },
			},
		],
		[
			26,
			{
				phase: "verify",
				control: { owner: "system_one", state: "verifying", reasonCode: "goal_completion_required" },
			},
		],
		[
			30,
			{
				phase: "build",
				control: { owner: "system_one", state: "verifying", reasonCode: "verification_repair_required" },
			},
		],
		[
			35,
			{
				phase: "blocked",
				control: {
					owner: "user",
					state: "awaiting_user",
					reasonCode: "clarification_pending",
					blocker: "Skip the changelog commit?",
				},
			},
		],
		[
			40,
			{
				phase: "build",
				control: { owner: "system_one", state: "verifying", reasonCode: "verification_repair_required" },
			},
		],
		[
			44,
			{
				phase: "verify",
				control: { owner: "system_one", state: "verifying", reasonCode: "goal_completion_required" },
			},
		],
		[49, { phase: "deliver" }],
		[53, { phase: "done" }],
	];
	for (const [at, patch] of script) {
		if (at > step) break;
		log.observe(projection(patch), T0 + at * 1000);
	}
	return log.view(T0 + step * 1000);
}

function inputAt(step: number, overrides: Partial<DecisionGraphInput> = {}): DecisionGraphInput {
	const nowMs = T0 + step * 1000;
	return {
		projection: projection(),
		stageLog: stageLogAt(step),
		health: { state: "unknown" },
		evaluations: [],
		route: {
			rootModel: "xai/grok-4.6",
			activeModel: "xai/grok-4.6",
			source: "direct",
			tier: null,
			risk: null,
			reasonCode: null,
			switched: false,
		},
		lanes: [],
		plan: [
			{ title: "Add flag parsing", status: "done" },
			{ title: "Skip push and tag when dry", status: "active" },
			{ title: "Regression test", status: "pending" },
		],
		checks: [
			{ text: "flag parsed", status: "satisfied" },
			{ text: "regression test passes", status: "pending" },
		],
		receipts: { actions: 3, fileEffects: 2, failures: 0 },
		backgroundTools: [],
		nowMs,
		...overrides,
	};
}

/** Scenarios that must produce different drawings from the same composer (R12). */
const SCENARIOS: Record<string, () => DecisionGraphInput> = {
	rootOnlyBuild: () => inputAt(10),
	workerDispatched: () =>
		inputAt(18, {
			projection: projection({
				active_actors: [{ id: "lane-tester", kind: "worker", label: "tester", elapsedMs: 2000 }],
			}),
			lanes: [lane()],
		}),
	routedReview: () =>
		inputAt(25, {
			projection: projection({
				current_action: "Reviewing worker result: tester",
				control: { owner: "system_one", state: "observing", reasonCode: "acceptance_evidence_required" },
			}),
			route: {
				rootModel: "xai/grok-4.6",
				activeModel: "openai-codex/gpt-5.6-mini",
				source: "model_router",
				tier: "cheap",
				risk: "read-only",
				reasonCode: null,
				switched: true,
			},
			lanes: [lane({ status: "succeeded", completedAt: "2026-09-20T10:00:24.000Z" })],
		}),
	jevVerifying: () =>
		inputAt(29, {
			projection: projection({
				phase: "verify",
				control: { owner: "system_one", state: "verifying", reasonCode: "goal_completion_required" },
			}),
			health: {
				state: "evaluating",
				inFlight: 1,
				inFlightEvaluations: [
					{
						evaluationId: "e1",
						programId: "pi:steering:program:JEV-024:1.0",
						label: "verify criterion 3",
						startedAt: T0 + 28_000,
					},
				],
			},
			evaluations: [evaluation("objective intake", "pass", T0 + 5000)],
			checks: [
				{ text: "flag parsed", status: "satisfied" },
				{ text: "regression test passes", status: "failed" },
			],
			receipts: { actions: 5, fileEffects: 3, failures: 1 },
		}),
	waitingForYou: () =>
		inputAt(37, {
			projection: projection({
				phase: "blocked",
				why: "Skip the changelog commit?",
				control: {
					owner: "user",
					state: "awaiting_user",
					reasonCode: "clarification_pending",
					blocker: "Skip the changelog commit?",
				},
			}),
			evaluations: [
				evaluation("objective intake", "pass", T0 + 5000),
				evaluation("verify criterion 3", "repair", T0 + 28_000),
			],
			humanInput: { question: "Skip the changelog commit?", askedAt: T0 + 35_000, asked: 1, answered: 0 },
		}),
	repairLoop: () =>
		inputAt(42, {
			projection: projection({
				current_action: "Guard the changelog commit",
				control: { owner: "system_one", state: "verifying", reasonCode: "verification_repair_required" },
			}),
			evaluations: [
				evaluation("objective intake", "pass", T0 + 5000),
				evaluation("verify criterion 3", "repair", T0 + 28_000),
			],
			humanInput: { asked: 1, answered: 1 },
		}),
	twoWorkersAndCapability: () =>
		inputAt(18, {
			projection: projection({
				active_actors: [
					{ id: "lane-parser", kind: "worker", label: "parser" },
					{ id: "lane-mapper", kind: "worker", label: "mapper" },
				],
				adaptation: { kind: "capability", label: "pdf-extract", state: "building" },
			}),
			lanes: [
				lane({ laneId: "lane-parser", label: "parse price lists" }),
				lane({
					laneId: "lane-mapper",
					label: "map columns",
					modelRef: "openai-codex/gpt-5.6-mini",
					profileId: "mapper",
				}),
			],
			backgroundTools: [{ name: "vendor sync", startedAt: T0 + 17_000 }],
		}),
	delivered: () =>
		inputAt(55, {
			projection: projection({
				phase: "done",
				current_action: "--dry-run flag added",
				next_action: null,
				control: { owner: "root", state: "deciding", reasonCode: "objective_completed" },
			}),
			evaluations: [evaluation("completion", "pass", T0 + 48_000)],
			plan: [
				{ title: "Add flag parsing", status: "done" },
				{ title: "Skip push and tag when dry", status: "done" },
				{ title: "Regression test", status: "done" },
			],
			checks: [
				{ text: "flag parsed", status: "satisfied" },
				{ text: "regression test passes", status: "satisfied" },
			],
			humanInput: { asked: 1, answered: 1 },
		}),
	idle: () => ({
		...inputAt(0),
		stageLog: new DecisionStageLog().view(T0),
		plan: [],
		checks: [],
		receipts: { actions: 0, fileEffects: 0, failures: 0 },
	}),
};

describe("Decision graph model", () => {
	it("derives stages in order of first entry with accumulated totals, loop, and the goal branch", () => {
		const model = buildDecisionGraphModel(SCENARIOS.repairLoop!());
		expect(model.stages.map((row) => row.stage)).toEqual([
			"understand",
			"plan",
			"build",
			"dispatch",
			"observe",
			"verify",
			"repair",
			"clarify",
		]);
		expect(model.current?.stage).toBe("repair");
		expect(model.loop).toBe(3);
		expect(model.stages.find((row) => row.stage === "verify")?.passes).toBe(1);
		expect(model.stages.find((row) => row.stage === "repair")?.passes).toBe(2);
		expect(model.goal.branch).toBe("repair");
		expect(model.you).toMatchObject({ present: true, waiting: false, asked: 1, answered: 1 });
		expect(model.hasRunningClock).toBe(true);
	});

	it("lights YOU with a waiting clock while the operator owns control, and names the routed root model", () => {
		const waiting = buildDecisionGraphModel(SCENARIOS.waitingForYou!());
		expect(waiting.you).toMatchObject({
			waiting: true,
			waitingSinceMs: T0 + 35_000,
			question: "Skip the changelog commit?",
		});
		expect(waiting.goal.branch).toBe("clarify");
		expect(waiting.decider.doing).toBe("waiting for you");
		const routed = buildDecisionGraphModel(SCENARIOS.routedReview!());
		expect(routed.participants[0]).toMatchObject({
			kind: "root",
			model: "gpt-5.6-mini",
			routeText: "cheap/read-only via model-router",
		});
		expect(routed.routing[0]?.text).toBe("cheap/read-only via model-router → gpt-5.6-mini for root");
		expect(routed.current?.stage).toBe("observe");
	});

	it("composes participants from what the task has: one worker, two workers plus a capability and a tool, or root alone", () => {
		expect(buildDecisionGraphModel(SCENARIOS.rootOnlyBuild!()).participants.map((p) => p.kind)).toEqual(["root"]);
		expect(buildDecisionGraphModel(SCENARIOS.workerDispatched!()).participants.map((p) => p.label)).toEqual([
			"root",
			"write the regression test",
		]);
		const many = buildDecisionGraphModel(SCENARIOS.twoWorkersAndCapability!());
		expect(many.participants.map((p) => p.kind)).toEqual(["root", "worker", "worker", "capability", "tool"]);
		expect(many.routing.map((r) => r.text)).toEqual([
			"profile tester → claude-sonnet-4.6 for parse price lists",
			"profile mapper → gpt-5.6-mini for map columns",
		]);
		const idle = buildDecisionGraphModel(SCENARIOS.idle!());
		expect(idle.stageLogEmpty).toBe(true);
		expect(idle.hasRunningClock).toBe(false);
	});
});

describe("Decision graph rendering", () => {
	beforeAll(() => initTheme("dark"));

	it("renders every scenario at every width with exact row widths, a current row, and a clock on the current node only", () => {
		for (const [name, make] of Object.entries(SCENARIOS)) {
			const model = buildDecisionGraphModel(make());
			for (const width of WIDTHS) {
				for (const [view, rendered] of [
					["list", renderDecisionList(model, width)],
					["diagram", renderDecisionDiagram(model, width)],
				] as const) {
					expect(rendered.rows.length, `${name} ${view} ${width}`).toBeGreaterThan(0);
					expect(rendered.stageAt.length).toBe(rendered.rows.length);
					for (const row of rendered.rows)
						expect(visibleWidth(row), `${name} ${view} ${width}: ${stripAnsi(row)}`).toBeLessThanOrEqual(width);
					expect(rendered.currentRow).toBeGreaterThanOrEqual(0);
					expect(rendered.currentRow).toBeLessThan(rendered.rows.length);
					if (view === "diagram" && model.current && model.current.stage !== "done" && !model.decider.evaluating) {
						const clockPattern = /(^|\s)\d+(\.\d)?s( · loop \d+)?(?=\s|$)/g;
						const clocks = rendered.rows.flatMap((row) => stripAnsi(row).match(clockPattern) ?? []);
						expect(clocks.length, `${name} ${width}`).toBe(1);
						expect(stripAnsi(rendered.rows[rendered.currentRow]!)).toMatch(clockPattern);
					}
				}
			}
		}
	});

	it("draws what the task has: no worker branch for a root-only task, siblings for many participants, the YOU edge only after a question", () => {
		const rootOnly = renderDecisionDiagram(buildDecisionGraphModel(SCENARIOS.rootOnlyBuild!()), 64)
			.rows.map(stripAnsi)
			.join("\n");
		expect(rootOnly).not.toContain("worker");
		expect(rootOnly).not.toContain("YOU");
		expect(rootOnly).toContain("plan 1/3");
		const many = renderDecisionDiagram(buildDecisionGraphModel(SCENARIOS.twoWorkersAndCapability!()), 96).rows.map(
			stripAnsi,
		);
		expect(many.some((row) => row.includes("┌") && row.includes("┐") && row.includes("┬"))).toBe(true);
		expect(many.join("\n")).toMatch(/capability pdf/);
		expect(many.join("\n")).toMatch(/tool vend/);
		const waiting = renderDecisionDiagram(buildDecisionGraphModel(SCENARIOS.waitingForYou!()), 64);
		const text = waiting.rows.map(stripAnsi);
		expect(text[0]).toMatch(/YOU .*· loop 2/);
		expect(text.join("\n")).toContain("waiting for your answer");
		expect(waiting.currentRow).toBe(0);
		const delivered = renderDecisionDiagram(buildDecisionGraphModel(SCENARIOS.delivered!()), 64)
			.rows.map(stripAnsi)
			.join("\n");
		expect(delivered).toContain("DELIVER");
		expect(delivered).not.toContain("next →");
	});

	it("lists only the stages that occurred, expands the selected stage, and keeps the current row on the current stage", () => {
		const model = buildDecisionGraphModel(SCENARIOS.jevVerifying!());
		const list = renderDecisionList(model, 56, "verify");
		const text = list.rows.map(stripAnsi);
		expect(text.some((row) => row.includes("◆ evaluating"))).toBe(true);
		expect(text.some((row) => row.includes("clarify"))).toBe(false);
		expect(text[list.currentRow]).toMatch(/● verify/);
		expect(list.stageAt[list.currentRow]).toBe("verify");
		expect(text.some((row) => row.includes("◆ verify criterion 3"))).toBe(true);
		expect(text.some((row) => row.includes("CHECKS") && row.includes("1/2"))).toBe(true);
	});
});
