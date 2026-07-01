import { fauxAssistantMessage } from "@caupulican/pi-ai";
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
