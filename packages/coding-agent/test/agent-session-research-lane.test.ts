import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLaneRecordSnapshots } from "../src/core/autonomy/session-lane-record.ts";
import { applyGoalEvent, createGoalState, type GoalState } from "../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const RESEARCH_JSON = '{"findings":[{"summary":"Reuse the existing evidence-bundle helper","confidence":0.9}]}';

function seedActiveGoal(harness: Harness, requirementId = "req-1"): GoalState {
	let state = createGoalState({ goalId: "g1", userGoal: "Ship the research lane", now: "T0" });
	state = applyGoalEvent(state, {
		type: "add_requirement",
		id: requirementId,
		text: "Gather evidence for the implementation",
		now: "T0",
	});
	appendGoalStateSnapshot(harness.sessionManager, state);
	return state;
}

function researchLaneRecords(harness: Harness) {
	return getLaneRecordSnapshots(harness.sessionManager.getEntries()).filter((record) => record.type === "research");
}

describe("AgentSession research lane (explicit runs)", () => {
	it("runs a research pass end to end: bundle, lane record, live lane count", async () => {
		const harness = await createHarness();
		try {
			seedActiveGoal(harness);

			let activeLaneCountDuringRun: number | undefined;
			harness.setResponses([
				() => {
					activeLaneCountDuringRun = harness.session.getAutonomyStatusSnapshot().activeLaneCount;
					return fauxAssistantMessage(RESEARCH_JSON);
				},
			]);

			const outcome = await harness.session.runResearchLaneOnce();

			expect(outcome.started).toBe(true);
			expect(outcome.record?.status).toBe("succeeded");
			expect(outcome.record?.laneId).toBe("research-1");
			expect(outcome.result?.reasonCode).toBe("research_completed");

			// The lane count was genuinely live while the model ran, and returns to idle after.
			expect(activeLaneCountDuringRun).toBe(1);
			expect(harness.session.getAutonomyStatusSnapshot().activeLaneCount).toBeUndefined();

			const bundle = harness.session.getEvidenceBundleSnapshot();
			expect(bundle?.query).toBe("goal:g1 requirements:req-1");
			expect(bundle?.findings[0]?.summary).toBe("Reuse the existing evidence-bundle helper");
			expect(bundle?.sources.some((source) => source.kind === "tool" && source.trusted === false)).toBe(true);

			const records = researchLaneRecords(harness);
			expect(records).toHaveLength(1);
			expect(records[0]?.status).toBe("succeeded");
			expect(records[0]?.goalId).toBe("g1");
			expect(records[0]?.evidenceEntryId).toBeTruthy();

			const diagnostics = harness.session.getAutonomyDiagnosticSnapshot();
			expect(diagnostics.research?.some((entry) => entry.title.startsWith("Lane research-1"))).toBe(true);
			expect(diagnostics.research?.some((entry) => entry.title.startsWith("Research: goal:g1"))).toBe(true);

			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			harness.cleanup();
		}
	});

	it("skips without an active goal and reports the reason", async () => {
		const harness = await createHarness();
		try {
			const outcome = await harness.session.runResearchLaneOnce();
			expect(outcome.started).toBe(false);
			expect(outcome.skipReason).toBe("no_active_goal");
			expect(researchLaneRecords(harness)).toHaveLength(0);
		} finally {
			harness.cleanup();
		}
	});

	it("gives the research lane a stable synthetic cache-affinity key across runs", async () => {
		const harness = await createHarness();
		try {
			seedActiveGoal(harness);
			const seenSessionIds: (string | undefined)[] = [];
			harness.setResponses([
				(_context, options) => {
					seenSessionIds.push(options?.sessionId);
					return fauxAssistantMessage(RESEARCH_JSON);
				},
			]);
			const first = await harness.session.runResearchLaneOnce();
			expect(first.record?.status).toBe("succeeded");
			expect(seenSessionIds[0]).toMatch(/^lane:research:/);
			// Never the real session id -- isolation invariant preserved.
			expect(seenSessionIds[0]).not.toBe(harness.session.sessionId);

			// Widen the open requirement set so the second run isn't skipped by evidence dedup, while
			// the lane's (kind, model, systemPrompt) stays identical -- same synthetic affinity key.
			const goal = harness.session.getGoalStateSnapshot();
			if (!goal) throw new Error("Expected goal state");
			const widened = applyGoalEvent(goal, {
				type: "add_requirement",
				id: "req-2",
				text: "Gather more evidence",
				now: "T1",
			});
			appendGoalStateSnapshot(harness.sessionManager, widened);

			harness.appendResponses([
				(_context, options) => {
					seenSessionIds.push(options?.sessionId);
					return fauxAssistantMessage(RESEARCH_JSON);
				},
			]);
			const second = await harness.session.runResearchLaneOnce();
			expect(second.record?.status).toBe("succeeded");

			expect(seenSessionIds[1]).toBe(seenSessionIds[0]);

			const records = researchLaneRecords(harness);
			expect(records).toHaveLength(2);
		} finally {
			harness.cleanup();
		}
	});

	it("deduplicates against recent evidence for the same requirement set", async () => {
		const harness = await createHarness();
		try {
			seedActiveGoal(harness);
			harness.setResponses([fauxAssistantMessage(RESEARCH_JSON)]);

			const first = await harness.session.runResearchLaneOnce();
			expect(first.record?.status).toBe("succeeded");

			const second = await harness.session.runResearchLaneOnce();
			expect(second.started).toBe(false);
			expect(second.skipReason).toBe("recent_evidence_sufficient");
			expect(researchLaneRecords(harness)).toHaveLength(1);
		} finally {
			harness.cleanup();
		}
	});

	it("records a failed lane on unparseable model output without persisting a bundle", async () => {
		const harness = await createHarness();
		try {
			seedActiveGoal(harness);
			harness.setResponses([fauxAssistantMessage("I could not produce JSON, sorry.")]);

			const outcome = await harness.session.runResearchLaneOnce();

			expect(outcome.started).toBe(true);
			expect(outcome.record?.status).toBe("failed");
			expect(outcome.record?.reasonCode).toBe("unparseable_output");
			expect(harness.session.getEvidenceBundleSnapshot()).toBeUndefined();

			const records = researchLaneRecords(harness);
			expect(records).toHaveLength(1);
			expect(records[0]?.status).toBe("failed");
		} finally {
			harness.cleanup();
		}
	});

	it("uses the materialized read-only tool loop without leaking recursive or write authority", async () => {
		const harness = await createHarness();
		try {
			seedActiveGoal(harness);
			writeFileSync(join(harness.tempDir, "evidence.txt"), "verified research evidence\n", "utf-8");
			let firstTurnTools: string[] = [];
			harness.setResponses([
				(context) => {
					firstTurnTools = context.tools?.map((tool) => tool.name) ?? [];
					return fauxAssistantMessage([fauxToolCall("read", { path: "evidence.txt" })], {
						stopReason: "toolUse",
					});
				},
				(context) => {
					expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
					return fauxAssistantMessage(RESEARCH_JSON);
				},
			]);

			const outcome = await harness.session.runResearchLaneOnce();

			expect(outcome.record?.status).toBe("succeeded");
			expect(firstTurnTools).toEqual(["read", "grep", "find", "ls"]);
			expect(firstTurnTools).not.toContain("write");
			expect(firstTurnTools).not.toContain("delegate");
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			harness.cleanup();
		}
	});

	it("gates an explicit run against the configured research model", async () => {
		const harness = await createHarness({
			models: [
				{ id: "foreground", contextWindow: 200_000 },
				{ id: "tiny-research", contextWindow: 4_096 },
			],
			settings: { researchLane: { enabled: true, model: "faux/tiny-research" } },
		});
		try {
			seedActiveGoal(harness);

			const outcome = await harness.session.runResearchLaneOnce();

			expect(outcome).toEqual({ started: false, skipReason: "model_research_unsupported" });
			expect(researchLaneRecords(harness)).toHaveLength(0);
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			harness.cleanup();
		}
	});
});

describe("AgentSession research lane (idle trigger)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("auto-runs research after an idle turn when enabled and autonomy mode is on", async () => {
		const harness = await createHarness({
			settings: {
				researchLane: { enabled: true },
				autonomy: { mode: "balanced", goalAutoContinue: false },
			},
		});
		try {
			seedActiveGoal(harness);
			harness.setResponses([fauxAssistantMessage("turn done"), fauxAssistantMessage(RESEARCH_JSON)]);

			await harness.session.prompt("please work on the goal");
			await vi.runAllTimersAsync();

			const bundle = harness.session.getEvidenceBundleSnapshot();
			expect(bundle?.query).toBe("goal:g1 requirements:req-1");
			expect(researchLaneRecords(harness)).toHaveLength(1);
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			harness.cleanup();
		}
	});

	it("auto-runs on a capable configured lane model even when the foreground model is tiny", async () => {
		const harness = await createHarness({
			models: [
				{ id: "tiny-foreground", contextWindow: 4_096 },
				{ id: "research-model", contextWindow: 200_000 },
			],
			settings: {
				researchLane: { enabled: true, model: "faux/research-model" },
				autonomy: { mode: "balanced", goalAutoContinue: false },
			},
		});
		try {
			seedActiveGoal(harness);
			let laneModelId: string | undefined;
			harness.setResponses([
				fauxAssistantMessage("turn done"),
				(_context, _options, _state, model) => {
					laneModelId = model.id;
					return fauxAssistantMessage(RESEARCH_JSON);
				},
			]);

			await harness.session.prompt("please work on the goal");
			await vi.runAllTimersAsync();

			expect(laneModelId).toBe("research-model");
			expect(researchLaneRecords(harness)).toHaveLength(1);
			expect(harness.session.getEvidenceBundleSnapshot()?.query).toBe("goal:g1 requirements:req-1");
		} finally {
			harness.cleanup();
		}
	});

	it("does not run when the research lane setting is disabled", async () => {
		const harness = await createHarness({
			settings: { autonomy: { mode: "balanced", goalAutoContinue: false } },
		});
		try {
			seedActiveGoal(harness);
			harness.setResponses([fauxAssistantMessage("turn done")]);

			await harness.session.prompt("please work on the goal");
			await vi.runAllTimersAsync();

			expect(researchLaneRecords(harness)).toHaveLength(0);
			expect(harness.session.getEvidenceBundleSnapshot()).toBeUndefined();
			const diagnostics = harness.session.getAutonomyDiagnosticSnapshot();
			expect(diagnostics.research?.some((entry) => entry.reasonCode === "research_lane_disabled")).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("does not run when autonomy mode is off even if the lane is enabled", async () => {
		const harness = await createHarness({
			settings: {
				researchLane: { enabled: true },
				autonomy: { mode: "off", goalAutoContinue: false },
			},
		});
		try {
			seedActiveGoal(harness);
			harness.setResponses([fauxAssistantMessage("turn done")]);

			await harness.session.prompt("please work on the goal");
			await vi.runAllTimersAsync();

			expect(researchLaneRecords(harness)).toHaveLength(0);
			const diagnostics = harness.session.getAutonomyDiagnosticSnapshot();
			expect(diagnostics.research?.some((entry) => entry.reasonCode === "autonomy_mode_off")).toBe(true);
		} finally {
			harness.cleanup();
		}
	});
});
