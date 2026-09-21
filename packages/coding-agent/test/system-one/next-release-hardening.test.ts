import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { projectEarlyCompactionEconomics } from "../../src/core/compaction/early-compaction-economics.ts";
import { DecisionStageLog } from "../../src/core/operator-projection/decision-stage-log.ts";
import type { OperatorProjection } from "../../src/core/operator-projection/types.ts";
import { compileDecisionProgramForCheckpoint } from "../../src/core/steering/programs.ts";
import { WorkerSemanticSupervisor } from "../../src/core/supervision/worker-semantic-supervisor.ts";
import { WorkerSupervisionCoordinator } from "../../src/core/supervision/worker-supervision-coordinator.ts";
import { classifyJevFailure, JevAdapterFailure, SystemOneJevAdapter } from "../../src/core/system-one/adapter.ts";
import { DEFAULT_SYSTEM_ONE_CONFIG } from "../../src/core/system-one/config.ts";
import { buildDecisionGraphModel } from "../../src/modes/interactive/components/decision-graph-model.ts";
import {
	composeDecisionDiagram,
	renderDecisionDiagram,
} from "../../src/modes/interactive/components/decision-graph-render.ts";
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
] as const;

beforeAll(() => initTheme("dark"));

function noulAnswers(overrides: Record<string, number> = {}): Record<string, { type: string; noul: number }> {
	const answers: Record<string, { type: string; noul: number }> = {};
	for (const id of SEVEN) answers[id] = { type: "noul", noul: overrides[id] ?? 0.1 };
	if (overrides.meaningful_progress === undefined) answers.meaningful_progress = { type: "noul", noul: 0.9 };
	return answers;
}

describe("next-release hardening", () => {
	it("replays the sanitized latest-session fixture against the shipped checkpoint compiler", () => {
		const fixturePath = join(
			dirname(fileURLToPath(import.meta.url)),
			"../fixtures/system-one/latest-session-hardening.json",
		);
		const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
			workerSupervision: { sevenQuestions: string[]; incompleteAnswers: Record<string, unknown> };
		};
		const program = compileDecisionProgramForCheckpoint("JEV-WORKER-SUPERVISION", {});
		expect(program.decisions.map((d) => d.id)).toEqual(fixture.workerSupervision.sevenQuestions);
		expect(Object.keys(fixture.workerSupervision.incompleteAnswers)).toEqual([]);
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
		expect(diagram).toMatch(/pending/);
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
		expect(renderDecisionDiagram(model, 80).rows.map(stripAnsi).join("\n")).not.toContain("DELIVER");
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
});
