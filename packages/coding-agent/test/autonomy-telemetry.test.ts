import { fauxAssistantMessage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { AUTONOMY_TELEMETRY_EVENT_TYPES } from "../src/core/autonomy/telemetry-events.ts";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const RESEARCH_JSON = '{"findings":[{"summary":"Reuse the evidence-bundle helper","confidence":0.9}]}';
const WORKER_JSON = '{"summary":"Validator blocks out-of-scope changes.","findings":[]}';
const JUDGE_MEDIUM = '{"tier":"medium","risk":"read-only","trivial":false,"reason":"non-trivial planning"}';

interface StoredTelemetry {
	version: number;
	type: string;
	timestamp: string;
	payload: Record<string, unknown>;
}

function telemetryEvents(harness: Harness): StoredTelemetry[] {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === "autonomy-telemetry")
		.map((entry) => (entry as unknown as { data: StoredTelemetry }).data);
}

function seedActiveGoal(harness: Harness): void {
	let state = createGoalState({ goalId: "g1", userGoal: "Ship the lane", now: "T0" });
	state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Gather evidence", now: "T0" });
	appendGoalStateSnapshot(harness.sessionManager, state);
}

describe("autonomy telemetry emission (G3)", () => {
	it("a routed turn emits a route_decision event with the completed route's codes", async () => {
		const harness = await createHarness({
			models: [{ id: "cheap" }, { id: "medium" }],
			settings: { modelRouter: { enabled: true, cheapModel: "faux/cheap", mediumModel: "faux/medium" } },
		});
		try {
			harness.setResponses([fauxAssistantMessage(JUDGE_MEDIUM), fauxAssistantMessage("answered on medium")]);

			await harness.session.prompt("what's the cleanest structure for the cache invalidation subsystem?");

			const routes = telemetryEvents(harness).filter(
				(event) => event.type === AUTONOMY_TELEMETRY_EVENT_TYPES.routeDecision,
			);
			expect(routes).toHaveLength(1);
			const [route] = routes;
			expect(route.version).toBe(1);
			expect(typeof route.timestamp).toBe("string");
			expect(route.timestamp.length).toBeGreaterThan(0);
			expect(route.payload.tier).toBe("medium");
			expect(route.payload.outcome).toBe("routed");
			expect(typeof route.payload.reasonCode).toBe("string");
			expect(typeof route.payload.confidence).toBe("number");
			// The sink stores codes/numbers only — never the prompt text.
			expect(JSON.stringify(route.payload)).not.toContain("cache invalidation");
		} finally {
			harness.cleanup();
		}
	});

	it("redacts secret-shaped fields through the taxonomy contract before storing", async () => {
		const harness = await createHarness();
		try {
			(harness.session as unknown as { _emitAutonomyTelemetry(event: unknown): void })._emitAutonomyTelemetry({
				type: AUTONOMY_TELEMETRY_EVENT_TYPES.routeDecision,
				timestamp: "2026-07-02T00:00:00.000Z",
				payload: {
					tier: "cheap",
					reasonCode: "safe_code",
					token: "supersecret",
					note: "Bearer abc.def.ghi",
					example: "sk-live-1234",
				},
			});

			const [event] = telemetryEvents(harness);
			expect(event.payload.tier).toBe("cheap");
			expect(event.payload.reasonCode).toBe("safe_code");
			expect(event.payload.token).toBe("[REDACTED]");
			expect(event.payload.note).toBe("[REDACTED BEARER TOKEN]");
			expect(event.payload.example).toBe("[REDACTED API KEY]");
		} finally {
			harness.cleanup();
		}
	});

	it("a research lane run emits an evidence_bundle event with the lane outcome", async () => {
		const harness = await createHarness();
		try {
			seedActiveGoal(harness);
			harness.setResponses([fauxAssistantMessage(RESEARCH_JSON)]);

			const outcome = await harness.session.runResearchLaneOnce();
			expect(outcome.record?.status).toBe("succeeded");

			const events = telemetryEvents(harness).filter(
				(event) => event.type === AUTONOMY_TELEMETRY_EVENT_TYPES.evidenceBundle,
			);
			expect(events).toHaveLength(1);
			const [event] = events;
			expect(event.version).toBe(1);
			expect(event.payload.laneType).toBe("research");
			expect(event.payload.laneId).toBe("research-1");
			expect(event.payload.status).toBe("succeeded");
			expect(event.payload.reasonCode).toBe("research_completed");
			expect(event.payload.hasEvidence).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("a failed research lane still emits an evidence_bundle event", async () => {
		const harness = await createHarness();
		try {
			seedActiveGoal(harness);
			harness.setResponses([fauxAssistantMessage("no JSON here, sorry")]);

			await harness.session.runResearchLaneOnce();

			const events = telemetryEvents(harness).filter(
				(event) => event.type === AUTONOMY_TELEMETRY_EVENT_TYPES.evidenceBundle,
			);
			expect(events).toHaveLength(1);
			expect(events[0].payload.status).toBe("failed");
			expect(events[0].payload.reasonCode).toBe("unparseable_output");
			expect(events[0].payload.hasEvidence).toBe(false);
		} finally {
			harness.cleanup();
		}
	});

	it("a worker delegation emits a worker_result event with the lane outcome", async () => {
		const harness = await createHarness({ settings: { workerDelegation: { enabled: true } } });
		try {
			harness.setResponses([fauxAssistantMessage(WORKER_JSON)]);

			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Summarize the validation rules" });
			expect(run.record?.status).toBe("succeeded");

			const events = telemetryEvents(harness).filter(
				(event) => event.type === AUTONOMY_TELEMETRY_EVENT_TYPES.workerResult,
			);
			expect(events).toHaveLength(1);
			const [event] = events;
			expect(event.payload.laneType).toBe("worker");
			expect(event.payload.status).toBe("succeeded");
			expect(event.payload.reasonCode).toBe("worker_completed");
		} finally {
			harness.cleanup();
		}
	});

	it("a learning decision emits a learning_decision event with kind/reasonCode/layer", async () => {
		const harness = await createHarness();
		try {
			const reflectionReply = JSON.stringify({
				rationale: "learned something",
				writes: [{ kind: "memory_add", section: "MEMORY", text: "Always run npm run check" }],
			});
			harness.setResponses([fauxAssistantMessage(reflectionReply)]);

			await harness.session.runReflectionPass({
				signals: {
					trigger: "corrective",
					toolCallCount: 0,
					hadCorrection: true,
					contextHeadroomPct: 90,
					usefulLately: 0,
				},
				recentTurnText: "user: remember to run checks",
				reportId: "turn-1",
			});

			const events = telemetryEvents(harness).filter(
				(event) => event.type === AUTONOMY_TELEMETRY_EVENT_TYPES.learningDecision,
			);
			expect(events).toHaveLength(1);
			const [event] = events;
			expect(event.payload.kind).toBe("apply");
			expect(event.payload.reasonCode).toBe("learning_policy_disabled_legacy_apply");
			expect(event.payload.layer).toBe("memory");
			// No proposal summary / memory text in the payload.
			expect(JSON.stringify(event.payload)).not.toContain("npm run check");
		} finally {
			harness.cleanup();
		}
	});
});
