import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { projectEarlyCompactionEconomics } from "../../src/core/compaction/early-compaction-economics.ts";
import { TypeSafeSystemOneDecisionEngine } from "../../src/core/decision/engines/typesafe-system-one-engine.ts";
import { ObjectiveExecutionController } from "../../src/core/objective-execution/objective-execution-controller.ts";
import { composeObjectiveRoute } from "../../src/core/objective-execution/objective-route-policy.ts";
import { DecisionStageLog } from "../../src/core/operator-projection/decision-stage-log.ts";
import type { OperatorProjection } from "../../src/core/operator-projection/types.ts";
import type { TaskRuntimeProjection } from "../../src/core/orchestration/task-runtime.ts";
import { serializeEvaluation } from "../../src/core/review/typesafe-contract.ts";
import { compileDecisionProgramForCheckpoint } from "../../src/core/steering/programs.ts";
import { WorkerSemanticSupervisor } from "../../src/core/supervision/worker-semantic-supervisor.ts";
import { WorkerSupervisionCoordinator } from "../../src/core/supervision/worker-supervision-coordinator.ts";
import { classifyJevFailure, JevAdapterFailure, SystemOneJevAdapter } from "../../src/core/system-one/adapter.ts";
import { DEFAULT_SYSTEM_ONE_CONFIG } from "../../src/core/system-one/config.ts";
import {
	buildDecisionGraphModel,
	type DecisionCheckStatus,
} from "../../src/modes/interactive/components/decision-graph-model.ts";
import {
	composeDecisionDiagram,
	renderDecisionDiagram,
	renderDecisionList,
} from "../../src/modes/interactive/components/decision-graph-render.ts";
import { WorkbenchPane } from "../../src/modes/interactive/components/workbench-pane.ts";
import { graphChecksFromVerificationObligations } from "../../src/modes/interactive/interactive-layout.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

const SEVEN = [
	"meaningful_progress",
	"worker_stuck",
	"work_off_track",
	"strategy_repetition",
	"needs_independent_verification",
	"specialist_gap_present",
	"capability_gap_present",
	"external_block_present",
] as const;

beforeAll(() => initTheme("dark"));

function noulAnswers(overrides: Record<string, number> = {}): Record<string, { type: string; noul: number }> {
	const answers: Record<string, { type: string; noul: number }> = {};
	for (const id of SEVEN) answers[id] = { type: "noul", noul: overrides[id] ?? 0.1 };
	if (overrides.meaningful_progress === undefined) answers.meaningful_progress = { type: "noul", noul: 0.9 };
	return answers;
}

type HardeningFixture = {
	workerSupervision: { sevenQuestions: string[]; incompleteAnswers: Record<string, unknown> };
	graph: {
		proof: { satisfied: number; total: number; pending: number };
		next: string;
		checks: Array<{ text: string; status: DecisionCheckStatus }>;
	};
	compaction: {
		hotCache: {
			currentTokens: number;
			compactableTokens: number;
			recentCacheReadTokens: number;
			recentCacheWriteTokens: number;
			cacheReadUsdPerMillion: number;
			cacheWriteUsdPerMillion: number;
			inputUsdPerMillion: number;
			estimatedSummaryTokens: number;
			horizonTurns: number;
			hysteresisTokens: number;
			minSavingsUsd: number;
		};
	};
};

function loadHardeningFixture(): HardeningFixture {
	const fixturePath = join(
		dirname(fileURLToPath(import.meta.url)),
		"../fixtures/system-one/latest-session-hardening.json",
	);
	return JSON.parse(readFileSync(fixturePath, "utf8")) as HardeningFixture;
}

function pendingGraphProjection(fixture: HardeningFixture): OperatorProjection {
	return {
		schema_version: "1.0",
		objective_id: "g",
		title: "t",
		phase: "build",
		phase_index: 3,
		phase_count: 6,
		current_action: "implement",
		why: "w",
		next_action: fixture.graph.next,
		health: "normal",
		control: { owner: "system_one", state: "deciding", reasonCode: "goal_active" },
		active_actors: [{ id: "root", kind: "root", label: "Root" }],
		adaptation: null,
		proof: { ...fixture.graph.proof, failing: 0 },
		context: null,
	};
}

describe("next-release hardening", () => {
	it("replays the sanitized latest-session fixture against shipped adapter, diagram, and economics", async () => {
		const fixture = loadHardeningFixture();
		const program = compileDecisionProgramForCheckpoint("JEV-WORKER-SUPERVISION", {});
		expect(program.decisions.map((d) => d.id)).toEqual(fixture.workerSupervision.sevenQuestions);
		expect(Object.keys(fixture.workerSupervision.incompleteAnswers)).toEqual([]);

		const adapter = new SystemOneJevAdapter(
			{
				evaluate: async () => ({
					request: { model: "jev-1.13.0" },
					response: { model: "jev-1.13.0", answers: fixture.workerSupervision.incompleteAnswers },
					elapsedMs: 1,
				}),
			},
			DEFAULT_SYSTEM_ONE_CONFIG,
			{ getApiKey: () => "test-key", sleep: async () => {} },
		);
		const questions = Object.fromEntries(
			fixture.workerSupervision.sevenQuestions.map((id) => [id, { type: "noul" }]),
		);
		try {
			await adapter.evaluate({ state: {}, questions });
			expect.fail("expected JevAdapterFailure");
		} catch (error) {
			expect(error).toBeInstanceOf(JevAdapterFailure);
			expect((error as JevAdapterFailure).kind).toBe("invalid_response");
			expect((error as JevAdapterFailure).originalMessage).toContain("meaningful_progress");
		}

		const log = new DecisionStageLog();
		const projection = pendingGraphProjection(fixture);
		log.observe(projection, Date.parse("2026-09-21T00:00:00.000Z"));
		const model = buildDecisionGraphModel({
			projection,
			stageLog: log.view(Date.parse("2026-09-21T00:00:10.000Z")),
			health: { state: "ok" },
			evaluations: [],
			route: {
				rootModel: "m",
				activeModel: "m",
				source: "direct",
				tier: null,
				risk: null,
				reasonCode: null,
				switched: false,
			},
			lanes: [],
			plan: [{ title: "step", status: "active" }],
			checks: fixture.graph.checks,
			receipts: { actions: 1, fileEffects: 0, failures: 0 },
			backgroundTools: [],
			nowMs: Date.parse("2026-09-21T00:00:10.000Z"),
		});
		const branch = composeDecisionDiagram(model).find((level) => level.kind === "branch");
		expect(branch && branch.kind === "branch" ? branch.yes.lit : true).toBe(false);
		expect(renderDecisionDiagram(model, 80).rows.map(stripAnsi).join("\n")).not.toContain("DELIVER");
		expect(renderDecisionList(model, 80).rows.map(stripAnsi).join("\n")).toMatch(/not closed · 3 open/);

		const hot = projectEarlyCompactionEconomics(fixture.compaction.hotCache);
		expect(hot.proceed).toBe(false);
		if (!hot.proceed) expect(hot.reason).toBe("hot_cache");
	});

	it("unpinned {row,key} follow recenters when the key changes", () => {
		const pane = new WorkbenchPane();
		const lines = Array.from({ length: 40 }, (_, i) => `row-${i}`);
		const first = (follow: { row: number; key: string }) =>
			stripAnsi(pane.render("Decision graph", "", lines, 0, 0, 48, 8, follow)[1] ?? "").trim();
		expect(first({ row: 10, key: "stage:build/eval:" })).toContain("row-7");
		expect(first({ row: 20, key: "stage:build/eval:Jev" })).toContain("row-17");
	});

	it("wheel and page to the diagram end pin {row,key} follow so a later key change keeps offset and shows new", () => {
		const pane = new WorkbenchPane();
		const lines = Array.from({ length: 40 }, (_, i) => `row-${i}`);
		const draw = (key: string) => pane.render("Decision graph", "", lines, 0, 0, 48, 8, { row: 10, key });
		draw("stage:build/eval:");
		expect(pane.pageBy(1)).toBe(true);
		for (let i = 0; i < 8; i++) expect(pane.scrollBy(40)).toBe(true);
		const pinned = draw("stage:build/eval:");
		const pinnedFirst = stripAnsi(pinned[1] ?? "").trim();
		expect(pinnedFirst).toContain("row-33");
		expect(stripAnsi(pinned[0] ?? "")).not.toMatch(/\bnew\b/);
		const after = draw("stage:build/eval:Jev");
		expect(stripAnsi(after[1] ?? "").trim()).toBe(pinnedFirst);
		expect(stripAnsi(after[0] ?? "")).toMatch(/\bnew\b/);
	});

	it("registers seven first-class JEV-WORKER-SUPERVISION decisions, not generic approved", () => {
		const program = compileDecisionProgramForCheckpoint("JEV-WORKER-SUPERVISION", {});
		expect(program.decisions.map((d) => d.id)).toEqual([...SEVEN]);
		expect(program.decisions.some((d) => d.id === "approved")).toBe(false);
	});

	it("does not turn a reviewer coverage failure into empty successful answers", async () => {
		const adapter = new SystemOneJevAdapter(
			{
				evaluate: async () => {
					throw new Error("Missing answer for boolean decision 'meaningful_progress'");
				},
			},
			{
				...DEFAULT_SYSTEM_ONE_CONFIG,
				failure_policy: {
					...DEFAULT_SYSTEM_ONE_CONFIG.failure_policy,
					jev_unavailable_read_only: "allow_with_audit",
				},
			},
			{ getApiKey: () => "test-key", sleep: async () => {} },
		);
		await expect(adapter.evaluate({ state: {}, questions: { meaningful_progress: {} } })).rejects.toBeInstanceOf(
			JevAdapterFailure,
		);
		try {
			await adapter.evaluate({ state: {}, questions: { meaningful_progress: {} } });
		} catch (error) {
			expect(error).toBeInstanceOf(JevAdapterFailure);
			expect((error as JevAdapterFailure).kind).toBe("invalid_response");
			expect((error as JevAdapterFailure).originalMessage).toContain("meaningful_progress");
		}
	});

	it("classifies rate-limit, timeout, cancel, and drift distinctly", () => {
		expect(classifyJevFailure(new Error("429 rate limit"), false)).toBe("rate_limit");
		expect(classifyJevFailure(new Error("timeout ETIMEDOUT"), false)).toBe("timeout");
		expect(classifyJevFailure(new Error("aborted"), true)).toBe("cancelled");
		expect(classifyJevFailure(new Error("Model drift detected: requested pinned model"), false)).toBe("model_drift");
		expect(classifyJevFailure(new Error("503 unavailable"), false)).toBe("unavailable");
	});

	it("maps valid adverse Jev answers to steer_now without treating them as protocol failure", async () => {
		const supervisor = new WorkerSemanticSupervisor({
			debounceMs: 0,
			minToolCalls: 0,
			minElapsedMs: 0,
			steering: {
				requireCertificate: async () => ({
					certificate_id: "cert-off-track",
					answers: noulAnswers({ work_off_track: 0.95, meaningful_progress: 0.2 }),
				}),
			},
		});
		const signal = await supervisor.observe({
			objectiveId: "o",
			taskId: "t",
			attemptId: "a1",
			role: "worker",
			mission: "fix parser",
			elapsedMs: 10_000,
			toolCalls: 4,
			isStalled: false,
			isRepeating: false,
		});
		expect(signal?.action).toBe("steer_now");
		expect(signal?.reason_codes).toContain("worker_off_track_steer_now");
	});

	it("keeps the worker running when assessment fails and debounces identical errors", async () => {
		const errors: string[] = [];
		const supervisor = new WorkerSemanticSupervisor({ debounceMs: 0, minToolCalls: 0, minElapsedMs: 0 });
		supervisor.observe = async () => {
			throw new Error("Missing answer for boolean decision 'meaningful_progress'");
		};
		const coordinator = new WorkerSupervisionCoordinator({
			supervisor,
			control: {
				steerWorker: () => {
					throw new Error("must not steer");
				},
				cancelWorker: () => {
					throw new Error("must not cancel");
				},
			},
			onSupervisionError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
		});
		const observation = {
			agentId: "w1",
			objectiveId: "o",
			taskId: "t",
			attemptId: "a1",
			role: "worker",
			mission: "fix",
			elapsedMs: 9000,
			toolCalls: 3,
			isStalled: false,
			isRepeating: false,
			evidenceRevision: 1,
		};
		await expect(coordinator.observe(observation)).resolves.toBeUndefined();
		await expect(coordinator.observe(observation)).resolves.toBeUndefined();
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("meaningful_progress");
	});

	it("rejects a successful reviewer payload with empty answers as invalid_response", async () => {
		const adapter = new SystemOneJevAdapter(
			{
				evaluate: async () => ({
					request: { model: "jev-1.13.0" },
					response: { model: "jev-1.13.0", answers: {} },
					elapsedMs: 1,
				}),
			},
			DEFAULT_SYSTEM_ONE_CONFIG,
			{ getApiKey: () => "test-key", sleep: async () => {} },
		);
		try {
			await adapter.evaluate({
				state: {},
				questions: { meaningful_progress: { type: "noul" }, worker_stuck: { type: "noul" } },
			});
			expect.fail("expected JevAdapterFailure");
		} catch (error) {
			expect(error).toBeInstanceOf(JevAdapterFailure);
			expect((error as JevAdapterFailure).kind).toBe("invalid_response");
			expect((error as JevAdapterFailure).originalMessage).toContain("meaningful_progress");
		}
	});

	it("does not treat empty steering answers as a silent continue", async () => {
		const supervisor = new WorkerSemanticSupervisor({
			debounceMs: 0,
			minToolCalls: 0,
			minElapsedMs: 0,
			steering: {
				requireCertificate: async () => ({ certificate_id: "cert-empty", answers: {} }),
			},
		});
		await expect(
			supervisor.observe({
				objectiveId: "o",
				taskId: "t",
				attemptId: "a-empty",
				role: "worker",
				mission: "fix",
				elapsedMs: 9000,
				toolCalls: 4,
			}),
		).rejects.toThrow("Missing answer for boolean decision 'meaningful_progress'");
	});

	it("fails closed on an unrecognized steering checkpoint instead of compiling approved", () => {
		expect(() => compileDecisionProgramForCheckpoint("JEV-NOT-A-CHECKPOINT", {})).toThrow(
			"Unrecognized steering checkpoint 'JEV-NOT-A-CHECKPOINT'",
		);
	});

	it("anti-oscillates validation churn: first steer, repeated churn reroutes", async () => {
		const steered: string[] = [];
		const cancelled: string[] = [];
		const coordinator = new WorkerSupervisionCoordinator({
			supervisor: new WorkerSemanticSupervisor({ debounceMs: 0, minToolCalls: 0, minElapsedMs: 0 }),
			control: {
				steerWorker: (agentId) => {
					steered.push(agentId);
				},
				cancelWorker: (agentId) => {
					cancelled.push(agentId);
				},
			},
		});
		const churn = {
			agentId: "w1",
			objectiveId: "o",
			taskId: "t",
			attemptId: "a-churn",
			role: "worker",
			mission: "fix",
			elapsedMs: 9000,
			toolCalls: 4,
			recentToolNames: ["bash", "bash", "bash"] as const,
			changedFileCountAtWindowStart: 1,
			changedFileCount: 1,
		};
		const first = await coordinator.observe(churn);
		expect(first?.action).toBe("steer_once");
		expect(steered).toEqual(["w1"]);
		const second = await coordinator.observe(churn);
		expect(second?.action).toBe("stop_and_reroute");
		expect(cancelled).toEqual(["w1"]);
	});

	it("composes a pending specialist request into escalate_capability after workers are not in flight", () => {
		const waiting = composeObjectiveRoute({
			cycleId: "c1",
			objectiveId: "o",
			requiredWorkerInFlight: true,
			supervisionRequest: {
				action: "request_specialist",
				reasonCodes: ["specialist_gap_detected"],
			},
		});
		expect(waiting.route).toBe("wait_for_worker");
		const ready = composeObjectiveRoute({
			cycleId: "c2",
			objectiveId: "o",
			supervisionRequest: {
				action: "request_specialist",
				reasonCodes: ["specialist_gap_detected"],
			},
		});
		expect(ready.route).toBe("escalate_capability");
		expect(ready.reason_codes).toContain("specialist_gap_detected");
		const owner = composeObjectiveRoute({
			cycleId: "c3",
			objectiveId: "o",
			ownerRequired: true,
			supervisionRequest: {
				action: "request_specialist",
				reasonCodes: ["specialist_gap_detected"],
			},
		});
		expect(owner.route).toBe("owner_required");
		expect(owner.reason_codes).not.toContain("specialist_gap_detected");
	});

	it("does not consume a pending specialist request while owner_required wins", async () => {
		const pending = [
			{
				signal_id: "sig-spec-1",
				action: "request_specialist" as const,
				reason_codes: ["specialist_gap_detected"],
			},
		];
		const consumed: string[] = [];
		let ownerRequired = true;
		const controller = new ObjectiveExecutionController({
			mode: "objective_primary",
			runtime: {
				reconcileObjective: async () =>
					({
						lastOrdinal: 0,
						agents: {},
						objectives: {},
						tasks: {},
						attempts: {},
						checkpoints: {},
						approvals: {},
						notifications: {},
					}) as TaskRuntimeProjection,
			},
			ownerRequired: () => ownerRequired,
			pendingSupervisionRequests: () => pending.filter((item) => !consumed.includes(item.signal_id)),
			consumePendingSupervisionRequest: (signalId) => {
				consumed.push(signalId);
			},
		});
		const blocked = await controller.evaluateRouteOnce("o");
		expect(blocked.route).toBe("owner_required");
		expect(consumed).toEqual([]);
		ownerRequired = false;
		const escalated = await controller.evaluateRouteOnce("o");
		expect(escalated.route).toBe("escalate_capability");
		expect(consumed).toEqual(["sig-spec-1"]);
	});

	it("consumes mark_external_block once when the composed route is blocked_external", async () => {
		const pending = [
			{
				signal_id: "sig-ext-1",
				action: "mark_external_block" as const,
				reason_codes: ["external_block_detected"],
			},
		];
		const consumed: string[] = [];
		const controller = new ObjectiveExecutionController({
			mode: "objective_primary",
			runtime: {
				reconcileObjective: async () =>
					({
						lastOrdinal: 0,
						agents: {},
						objectives: {},
						tasks: {},
						attempts: {},
						checkpoints: {},
						approvals: {},
						notifications: {},
					}) as TaskRuntimeProjection,
			},
			pendingSupervisionRequests: () => pending.filter((item) => !consumed.includes(item.signal_id)),
			consumePendingSupervisionRequest: (signalId) => {
				consumed.push(signalId);
			},
		});
		const blocked = await controller.evaluateRouteOnce("o");
		expect(blocked.route).toBe("blocked_external");
		expect(blocked.reason_codes).toContain("external_dependency_unavailable");
		expect(consumed).toEqual(["sig-ext-1"]);
		const again = await controller.evaluateRouteOnce("o");
		expect(again.route).not.toBe("blocked_external");
		expect(consumed).toEqual(["sig-ext-1"]);
	});

	it("does not draw an affirmative DELIVER branch while proof is still open", () => {
		const log = new DecisionStageLog();
		log.observe(
			{
				schema_version: "1.0",
				objective_id: "g",
				title: "t",
				phase: "build",
				phase_index: 3,
				phase_count: 6,
				current_action: "implement",
				why: "w",
				next_action: "verify 3 open criteria",
				health: "normal",
				control: { owner: "system_one", state: "deciding", reasonCode: "goal_active" },
				active_actors: [{ id: "root", kind: "root", label: "Root" }],
				adaptation: null,
				proof: { satisfied: 1, total: 4, failing: 0, pending: 3 },
				context: null,
			} satisfies OperatorProjection,
			Date.parse("2026-09-21T00:00:00.000Z"),
		);
		const model = buildDecisionGraphModel({
			projection: {
				schema_version: "1.0",
				objective_id: "g",
				title: "t",
				phase: "build",
				phase_index: 3,
				phase_count: 6,
				current_action: "implement",
				why: "w",
				next_action: "verify 3 open criteria",
				health: "normal",
				control: { owner: "system_one", state: "deciding", reasonCode: "goal_active" },
				active_actors: [{ id: "root", kind: "root", label: "Root" }],
				adaptation: null,
				proof: { satisfied: 1, total: 4, failing: 0, pending: 3 },
				context: null,
			},
			stageLog: log.view(Date.parse("2026-09-21T00:00:10.000Z")),
			health: { state: "ok" },
			evaluations: [],
			route: {
				rootModel: "m",
				activeModel: "m",
				source: "direct",
				tier: null,
				risk: null,
				reasonCode: null,
				switched: false,
			},
			lanes: [],
			plan: [{ title: "step", status: "active" }],
			checks: [
				{ text: "a", status: "satisfied" },
				{ text: "b", status: "pending" },
				{ text: "c", status: "pending" },
				{ text: "d", status: "pending" },
			],
			receipts: { actions: 1, fileEffects: 0, failures: 0 },
			backgroundTools: [],
			nowMs: Date.parse("2026-09-21T00:00:10.000Z"),
		});
		expect(model.goal.branch).toBe("pending");
		const diagram = renderDecisionDiagram(model, 80).rows.map(stripAnsi).join("\n");
		expect(diagram).toMatch(/not closed · 3 open/);
		expect(diagram).not.toMatch(/yes → DELIVER/);
		expect(diagram).not.toContain("DELIVER");
		const levels = composeDecisionDiagram(model);
		const branch = levels.find((level) => level.kind === "branch");
		expect(branch && branch.kind === "branch" ? branch.yes.lit : true).toBe(false);
	});

	it("does not light DELIVER when the stage is deliver but checks are still open", () => {
		const log = new DecisionStageLog();
		const projection: OperatorProjection = {
			schema_version: "1.0",
			objective_id: "g",
			title: "t",
			phase: "deliver",
			phase_index: 5,
			phase_count: 6,
			current_action: "publish",
			why: "w",
			next_action: "verify 3 open criteria",
			health: "normal",
			control: { owner: "system_one", state: "verifying", reasonCode: "goal_completion_required" },
			active_actors: [{ id: "root", kind: "root", label: "Root" }],
			adaptation: null,
			proof: { satisfied: 1, total: 4, failing: 0, pending: 3 },
			context: null,
		};
		log.observe(projection, Date.parse("2026-09-21T00:00:00.000Z"));
		const model = buildDecisionGraphModel({
			projection,
			stageLog: log.view(Date.parse("2026-09-21T00:00:10.000Z")),
			health: { state: "ok" },
			evaluations: [],
			route: {
				rootModel: "m",
				activeModel: "m",
				source: "direct",
				tier: null,
				risk: null,
				reasonCode: null,
				switched: false,
			},
			lanes: [],
			plan: [{ title: "step", status: "active" }],
			checks: [
				{ text: "a", status: "satisfied" },
				{ text: "b", status: "pending" },
				{ text: "c", status: "pending" },
				{ text: "d", status: "pending" },
			],
			receipts: { actions: 1, fileEffects: 0, failures: 0 },
			backgroundTools: [],
			nowMs: Date.parse("2026-09-21T00:00:10.000Z"),
		});
		const branch = composeDecisionDiagram(model).find((level) => level.kind === "branch");
		expect(branch && branch.kind === "branch" ? branch.yes.lit : true).toBe(false);
		expect(branch && branch.kind === "branch" ? Boolean(branch.yes.current) : true).toBe(false);
		expect(renderDecisionDiagram(model, 80).rows.map(stripAnsi).join("\n")).not.toContain("DELIVER");
		const list = renderDecisionList(model, 80).rows.map(stripAnsi).join("\n");
		expect(list).not.toMatch(/yes → deliver/i);
		expect(list).toMatch(/not closed · 3 open/);
		const diagram = renderDecisionDiagram(model, 80);
		expect(diagram.currentRow).toBeGreaterThan(0);
	});

	it("defers early compaction when the cache is hot or prices are missing", () => {
		const hot = projectEarlyCompactionEconomics({
			currentTokens: 80_000,
			compactableTokens: 40_000,
			recentCacheReadTokens: 90_000,
			recentCacheWriteTokens: 1_000,
			cacheReadUsdPerMillion: 0.3,
			cacheWriteUsdPerMillion: 3.75,
			inputUsdPerMillion: 3,
			estimatedSummaryTokens: 2000,
			horizonTurns: 8,
			hysteresisTokens: 2000,
			minSavingsUsd: 0.001,
		});
		expect(hot.proceed).toBe(false);
		if (!hot.proceed) expect(hot.reason).toBe("hot_cache");
		const noPrice = projectEarlyCompactionEconomics({
			currentTokens: 80_000,
			compactableTokens: 40_000,
			recentCacheReadTokens: 0,
			recentCacheWriteTokens: 0,
			estimatedSummaryTokens: 2000,
			horizonTurns: 8,
			hysteresisTokens: 2000,
			minSavingsUsd: 0.001,
		});
		expect(noPrice.proceed).toBe(false);
		if (!noPrice.proceed) expect(noPrice.reason).toBe("insufficient_evidence");
		const hysteresis = projectEarlyCompactionEconomics({
			currentTokens: 81_000,
			compactableTokens: 40_000,
			recentCacheReadTokens: 100,
			recentCacheWriteTokens: 50_000,
			cacheReadUsdPerMillion: 0.3,
			cacheWriteUsdPerMillion: 0.01,
			inputUsdPerMillion: 0.01,
			estimatedSummaryTokens: 100,
			horizonTurns: 20,
			lastEarlyDecisionAtTokens: 80_000,
			hysteresisTokens: 2000,
			minSavingsUsd: 0.0000001,
		});
		expect(hysteresis.proceed).toBe(false);
		if (!hysteresis.proceed) expect(hysteresis.reason).toBe("hysteresis");
		const afterSwitch = projectEarlyCompactionEconomics({
			currentTokens: 81_000,
			compactableTokens: 40_000,
			recentCacheReadTokens: 100,
			recentCacheWriteTokens: 50_000,
			cacheReadUsdPerMillion: 0.3,
			cacheWriteUsdPerMillion: 0.01,
			inputUsdPerMillion: 0.01,
			estimatedSummaryTokens: 100,
			horizonTurns: 20,
			lastEarlyDecisionAtTokens: 80_000,
			hysteresisTokens: 2000,
			minSavingsUsd: 0.0000001,
			modelSwitched: true,
			cacheInvalidated: true,
		});
		expect(afterSwitch.proceed).toBe(true);
	});

	it("keeps diagram rows within width across the adversarial width matrix while proof is pending", () => {
		const log = new DecisionStageLog();
		const projection: OperatorProjection = {
			schema_version: "1.0",
			objective_id: "g",
			title: "t",
			phase: "build",
			phase_index: 3,
			phase_count: 6,
			current_action: "implement",
			why: "w",
			next_action: "verify 3 open criteria",
			health: "normal",
			control: { owner: "system_one", state: "deciding", reasonCode: "goal_active" },
			active_actors: [{ id: "root", kind: "root", label: "Root" }],
			adaptation: null,
			proof: { satisfied: 1, total: 4, failing: 0, pending: 3 },
			context: null,
		};
		log.observe(projection, Date.parse("2026-09-21T00:00:00.000Z"));
		const model = buildDecisionGraphModel({
			projection,
			stageLog: log.view(Date.parse("2026-09-21T00:00:10.000Z")),
			health: { state: "ok" },
			evaluations: [],
			route: {
				rootModel: "m",
				activeModel: "m",
				source: "direct",
				tier: null,
				risk: null,
				reasonCode: null,
				switched: false,
			},
			lanes: [],
			plan: [{ title: "step", status: "active" }],
			checks: [
				{ text: "a", status: "satisfied" },
				{ text: "b", status: "pending" },
				{ text: "c", status: "pending" },
				{ text: "d", status: "pending" },
			],
			receipts: { actions: 1, fileEffects: 0, failures: 0 },
			backgroundTools: [],
			nowMs: Date.parse("2026-09-21T00:00:10.000Z"),
		});
		for (const width of [48, 60, 80, 100, 140, 200]) {
			const rendered = renderDecisionDiagram(model, width);
			expect(rendered.focusKey).toContain("branch:pending");
			for (const row of rendered.rows) {
				expect(stripAnsi(row).length, `width ${width}`).toBeLessThanOrEqual(width);
			}
		}
	});

	it("chooses early compaction when hit ratio is poor and projected savings clear the margin", () => {
		const chosen = projectEarlyCompactionEconomics({
			currentTokens: 100_000,
			compactableTokens: 80_000,
			recentCacheReadTokens: 100,
			recentCacheWriteTokens: 50_000,
			cacheReadUsdPerMillion: 0.3,
			cacheWriteUsdPerMillion: 0.01,
			inputUsdPerMillion: 0.01,
			estimatedSummaryTokens: 100,
			horizonTurns: 20,
			hysteresisTokens: 2000,
			minSavingsUsd: 0.0000001,
		});
		expect(chosen.proceed).toBe(true);
	});

	it("omits undefined noul criteria so TypeSafe can serialize JEV-WORKER-SUPERVISION questions", async () => {
		let captured: { state?: unknown; questions?: Record<string, unknown> } | undefined;
		const engine = new TypeSafeSystemOneDecisionEngine({
			evaluate: async (input) => {
				captured = input;
				return { model: "jev-1.13.0", answers: noulAnswers(), latency_ms: 1 };
			},
		});
		await engine.evaluate(compileDecisionProgramForCheckpoint("JEV-WORKER-SUPERVISION", {}), {
			objectiveId: "o",
			mission: "write hello",
		});
		expect(captured?.questions).toBeDefined();
		for (const question of Object.values(captured?.questions ?? {})) {
			expect(question).not.toHaveProperty("criteria");
		}
		expect(() =>
			serializeEvaluation({
				model: "jev-1.13.0",
				state: captured?.state,
				questions: captured?.questions,
			}),
		).not.toThrow();
	});

	it("maps active verification obligations as pending graph checks, not failed", () => {
		const checks = graphChecksFromVerificationObligations([
			{ id: "verify-1", command: "npm test" },
			{ id: "verify-2" },
		]);
		expect(checks).toEqual([
			{ text: "npm test", status: "pending" },
			{ text: "verify-2", status: "pending" },
		]);
		expect(checks.every((check) => check.status !== "failed")).toBe(true);
	});
});

describe("Jev request integrity and bounds", () => {
	it("names the JSON path of non-JSON evidence and never retries a request the harness built wrong", async () => {
		expect(() => serializeEvaluation({ state: { changedFiles: ["a", undefined] } })).toThrow(
			/got undefined\) at \$\.state\.changedFiles\[1\]/,
		);
		let calls = 0;
		const adapter = new SystemOneJevAdapter(
			{
				evaluate: async (input) => {
					calls += 1;
					serializeEvaluation(input);
					throw new Error("unreachable");
				},
			},
			DEFAULT_SYSTEM_ONE_CONFIG,
			{ getApiKey: () => "test-key", sleep: async () => {} },
		);
		const failure = await adapter
			.evaluate({ state: { elapsedMs: Number.NaN }, questions: { q: { type: "noul" } } })
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(JevAdapterFailure);
		expect((failure as JevAdapterFailure).kind).toBe("invalid_request");
		expect((failure as JevAdapterFailure).originalMessage).toContain("$.state.elapsedMs");
		expect(calls).toBe(1);
	});

	it("bounds the whole evaluation, retries included, by timeoutMs", async () => {
		const adapter = new SystemOneJevAdapter(
			{
				evaluate: (_input, signal) =>
					new Promise((_resolve, reject) => {
						signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
					}),
			},
			DEFAULT_SYSTEM_ONE_CONFIG,
			{ getApiKey: () => "test-key", sleep: async () => {} },
		);
		const started = Date.now();
		const failure = await adapter
			.evaluate({ state: {}, questions: { q: { type: "noul" } } }, { timeoutMs: 50 })
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(JevAdapterFailure);
		expect((failure as JevAdapterFailure).kind).toBe("timeout");
		expect(Date.now() - started).toBeLessThan(2_000);
	});
});
