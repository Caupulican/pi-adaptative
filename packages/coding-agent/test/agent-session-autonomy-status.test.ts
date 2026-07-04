import type { AgentTool } from "@caupulican/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type Usage } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createGoalState } from "../src/core/goals/goal-state.ts";
import type { ModelRouterDecisionStatus } from "../src/core/model-router/status.ts";
import { createEvidenceBundle } from "../src/core/research/evidence-bundle.ts";
import { createHarness } from "./suite/harness.ts";

function usage(costTotal: number): Usage {
	return {
		input: 100,
		output: 50,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 150,
		cost: { input: costTotal / 2, output: costTotal / 2, cacheRead: 0, cacheWrite: 0, total: costTotal },
	};
}

const bashParameters = Type.Object({ command: Type.String() });
const bashTool: AgentTool<typeof bashParameters> = {
	name: "bash",
	label: "Bash",
	description: "Run a shell command",
	parameters: bashParameters,
	execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
};

describe("AgentSession - Autonomy Status Snapshot", () => {
	it("returns an empty snapshot object when there is no router decision and no active envelope", async () => {
		const harness = await createHarness({ tools: [bashTool] });

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "ls" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done"),
		]);

		await harness.session.prompt("Run ls");

		const snapshot = harness.session.getAutonomyStatusSnapshot();
		expect(snapshot.latestGate).toBeUndefined();
		expect(snapshot.latestRoute).toBeUndefined();

		await harness.cleanup();
	});

	it("includes latestGate with outcome/gate/reasonCode when a capability envelope blocks a tool", async () => {
		let executed = false;
		const blockingTool: AgentTool<typeof bashParameters> = {
			...bashTool,
			execute: async () => {
				executed = true;
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [blockingTool] });

		harness.session.capabilityEnvelope = {
			id: "env-1",
			capabilities: ["read_files"],
			deniedTools: ["bash"],
		};

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "ls" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done"),
		]);

		await harness.session.prompt("Run ls");

		expect(executed).toBe(false);
		const snapshot = harness.session.getAutonomyStatusSnapshot();
		expect(snapshot.latestGate).toBeDefined();
		expect(snapshot.latestGate?.outcome).toBe("block");
		expect(snapshot.latestGate?.gate).toBe("tool_gate");
		expect(snapshot.latestGate?.reasonCode).toBe("tool_denied");

		// Snapshot does not include gate message details
		if (snapshot.latestGate) {
			expect(snapshot.latestGate).not.toHaveProperty("message");
		}

		await harness.cleanup();
	});

	it("records allow/allowed_by_envelope or equivalent stable reason when a tool is allowed under an active envelope", async () => {
		const harness = await createHarness({ tools: [bashTool] });

		harness.session.capabilityEnvelope = {
			id: "env-1",
			capabilities: ["run_shell"],
			allowedTools: ["bash"],
		};

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "ls" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done"),
		]);

		await harness.session.prompt("Run ls");

		const snapshot = harness.session.getAutonomyStatusSnapshot();
		expect(snapshot.latestGate).toBeDefined();
		expect(snapshot.latestGate?.outcome).toBe("allow");
		expect(snapshot.latestGate?.gate).toBe("tool_gate");
		// The exact reasonCode for an allowed tool under capability envelope is 'allowed_by_envelope'.
		expect(snapshot.latestGate?.reasonCode).toBe("allowed_by_envelope");

		await harness.cleanup();
	});

	it("includes cost metrics from existing session facts", async () => {
		const harness = await createHarness({ tools: [bashTool] });
		harness.session.addSpawnedUsage(usage(0.25), { reportId: "status-cost" });

		const snapshot = harness.session.getAutonomyStatusSnapshot();
		expect(snapshot.spawnedCostUsd).toBeCloseTo(0.25, 10);

		await harness.cleanup();
	});

	it("includes currentCostUsd from the session's own assistant-message usage, excluding spawned cost", async () => {
		const harness = await createHarness({ tools: [bashTool] });
		const model = harness.getModel();
		harness.session.agent.state.messages.push({
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: usage(0.75),
			stopReason: "stop",
			timestamp: 1,
		});
		harness.session.addSpawnedUsage(usage(0.5), { reportId: "status-current-cost" });

		const snapshot = harness.session.getAutonomyStatusSnapshot();
		expect(snapshot.currentCostUsd).toBeCloseTo(0.75, 10);
		expect(snapshot.spawnedCostUsd).toBeCloseTo(0.5, 10);

		await harness.cleanup();
	});

	it("includes latestRoute with tier/risk/reasonCode only when a model router decision is present", async () => {
		const harness = await createHarness({ tools: [bashTool] });

		const mockDecision: ModelRouterDecisionStatus = {
			route: {
				tier: "cheap",
				risk: "read-only",
				confidence: 0.9,
				reasonCode: "research_intent",
				reasons: ["Because it's reading files", "No modifying tools"],
			},
			routedModel: "mock-model",
			intent: "research",
			outcome: "routed",
		};

		// We inject the mock decision directly for the pure unit test,
		// as setting up the full model router execution environment is broad.
		const sessionWithInternals = harness.session as unknown as {
			_modelRouter: { _lastModelRouterDecision: ModelRouterDecisionStatus };
		};
		sessionWithInternals._modelRouter._lastModelRouterDecision = mockDecision;

		const snapshot = harness.session.getAutonomyStatusSnapshot();
		expect(snapshot.latestRoute).toBeDefined();
		expect(snapshot.latestRoute?.tier).toBe("cheap");
		expect(snapshot.latestRoute?.risk).toBe("read-only");
		expect(snapshot.latestRoute?.reasonCode).toBe("research_intent");

		// Snapshot does not include route reasons arrays
		if (snapshot.latestRoute) {
			expect(snapshot.latestRoute).not.toHaveProperty("reasons");
		}

		await harness.cleanup();
	});

	it("populates activeGoal from real goal state and never fabricates activeLaneCount", async () => {
		const harness = await createHarness({ tools: [bashTool] });

		const emptySnapshot = harness.session.getAutonomyStatusSnapshot();
		expect(emptySnapshot.activeGoal).toBeUndefined();
		expect(emptySnapshot.activeLaneCount).toBeUndefined();

		const goal = createGoalState({ goalId: "goal-1", userGoal: "Ship the feature", now: "T0" });
		harness.session.saveGoalStateSnapshot(goal);

		const snapshot = harness.session.getAutonomyStatusSnapshot();
		expect(snapshot.activeGoal).toEqual({ goalId: "goal-1", status: "active", openRequirements: 0, stallTurns: 0 });
		expect(snapshot.activeLaneCount).toBeUndefined();

		await harness.cleanup();
	});
});

describe("AgentSession - Autonomy Diagnostic Snapshot", () => {
	it("returns no fabricated families when nothing has happened yet, only real process memory", async () => {
		const harness = await createHarness({ tools: [bashTool] });

		const snapshot = harness.session.getAutonomyDiagnosticSnapshot();
		expect(snapshot.routes).toBeUndefined();
		expect(snapshot.gates).toBeUndefined();
		expect(snapshot.costs).toBeUndefined();
		expect(snapshot.research).toBeUndefined();
		expect(snapshot.delegation).toBeUndefined();
		expect(snapshot.learning).toBeUndefined();
		expect(snapshot.goals).toBeUndefined();
		// processMemory is real (not session-derived) telemetry, so unlike the other families it is
		// always present rather than gated on recorded activity.
		expect(snapshot.processMemory).toEqual([
			{
				title: "process",
				metadata: {
					rssMb: expect.any(Number),
					heapUsedMb: expect.any(Number),
					externalMb: expect.any(Number),
				},
			},
		]);

		await harness.cleanup();
	});

	it("routes family reflects a real recorded model-router decision", async () => {
		const harness = await createHarness({ tools: [bashTool] });

		const mockDecision: ModelRouterDecisionStatus = {
			route: {
				tier: "cheap",
				risk: "read-only",
				confidence: 0.9,
				reasonCode: "research_intent",
				reasons: ["Because it's reading files"],
			},
			routedModel: "mock-model",
			intent: "research",
			outcome: "routed",
		};
		harness.session.sessionManager.appendCustomEntry("model_router_decision", mockDecision);

		const snapshot = harness.session.getAutonomyDiagnosticSnapshot();
		expect(snapshot.routes).toEqual([
			{
				title: "cheap",
				summary: "mock-model",
				reasonCode: "research_intent",
				metadata: { risk: "read-only", outcome: "routed", intent: "research" },
			},
		]);

		await harness.cleanup();
	});

	it("gates family reflects the latest gate outcome when a tool is blocked", async () => {
		let executed = false;
		const blockingTool: AgentTool<typeof bashParameters> = {
			...bashTool,
			execute: async () => {
				executed = true;
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [blockingTool] });
		harness.session.capabilityEnvelope = { id: "env-1", capabilities: ["read_files"], deniedTools: ["bash"] };

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "ls" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done"),
		]);
		await harness.session.prompt("Run ls");
		expect(executed).toBe(false);

		const snapshot = harness.session.getAutonomyDiagnosticSnapshot();
		expect(snapshot.gates).toHaveLength(1);
		expect(snapshot.gates?.[0]?.title).toBe("tool_gate");
		expect(snapshot.gates?.[0]?.reasonCode).toBe("tool_denied");
		expect(snapshot.gates?.[0]?.metadata?.outcome).toBe("block");

		await harness.cleanup();
	});

	it("costs family reflects current (own-session), spawned, and daily cost when non-zero", async () => {
		const harness = await createHarness({ tools: [bashTool] });
		const model = harness.getModel();
		harness.session.agent.state.messages.push({
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: usage(0.75),
			stopReason: "stop",
			timestamp: 1,
		});
		harness.session.addSpawnedUsage(usage(0.5), { reportId: "diag-cost" });
		harness.session.getDailyUsageTotals = () => ({
			ownCost: 0,
			spawnedCost: 0,
			totalCost: 0.25,
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			sessions: 0,
			reports: 0,
		});

		const snapshot = harness.session.getAutonomyDiagnosticSnapshot();
		expect(snapshot.costs?.some((entry) => entry.title === "current" && entry.summary === "$0.7500")).toBe(true);
		expect(snapshot.costs?.some((entry) => entry.title === "spawned" && entry.summary === "$0.5000")).toBe(true);
		expect(snapshot.costs?.some((entry) => entry.title === "daily" && entry.summary === "$0.2500")).toBe(true);

		await harness.cleanup();
	});

	it("research family reflects a saved evidence bundle as counts only, never source/finding text", async () => {
		const harness = await createHarness({ tools: [bashTool] });
		const bundle = createEvidenceBundle({
			query: "investigate the outage",
			sources: [{ id: "s1", kind: "workspace", trusted: true, excerpt: "SECRET-CONTENT" }],
			findings: [{ id: "f1", summary: "root cause found: SECRET-CONTENT", evidenceIds: ["s1"] }],
		});
		harness.session.saveEvidenceBundleSnapshot(bundle);

		const snapshot = harness.session.getAutonomyDiagnosticSnapshot();
		expect(snapshot.research).toEqual([
			{ title: "Research: investigate the outage", metadata: { sourceCount: 1, findingCount: 1 } },
		]);
		expect(JSON.stringify(snapshot.research)).not.toContain("SECRET-CONTENT");

		await harness.cleanup();
	});

	it("delegation family reflects saved worker results, capped at the configured max, with counts only", async () => {
		const harness = await createHarness({ tools: [bashTool] });
		for (let i = 0; i < 15; i++) {
			harness.session.saveWorkerResultSnapshot({
				requestId: `req-${i}`,
				status: "completed",
				summary: `Did work ${i}`,
				changedFiles: ["a.ts", "b.ts"],
				blockers: [],
			});
		}

		const snapshot = harness.session.getAutonomyDiagnosticSnapshot({ maxEntriesPerFamily: 5 });
		expect(snapshot.delegation).toHaveLength(5);
		expect(snapshot.delegation?.[0]?.title).toBe("Worker req-10 (completed)");
		expect(snapshot.delegation?.[0]?.metadata).toEqual({
			changedFileCount: 2,
			blockerCount: 0,
			usageReportId: undefined,
		});

		await harness.cleanup();
	});

	it("learning family reflects saved learning decisions, capped at the configured max", async () => {
		const harness = await createHarness({ tools: [bashTool] });
		for (let i = 0; i < 15; i++) {
			harness.session.saveLearningDecisionSnapshot({
				kind: "proposal",
				reasonCode: "pattern_detected",
				confidence: 0.8,
				summary: `Proposal ${i}`,
				requiresApproval: true,
			});
		}

		const snapshot = harness.session.getAutonomyDiagnosticSnapshot({ maxEntriesPerFamily: 5 });
		expect(snapshot.learning).toHaveLength(5);
		expect(snapshot.learning?.[0]?.title).toBe("Learning (proposal)");
		expect(snapshot.learning?.[0]?.reasonCode).toBe("pattern_detected");

		await harness.cleanup();
	});

	it("goals family reflects a saved goal state snapshot", async () => {
		const harness = await createHarness({ tools: [bashTool] });
		const goal = createGoalState({ goalId: "goal-2", userGoal: "Refactor the module", now: "T0" });
		harness.session.saveGoalStateSnapshot(goal);

		const snapshot = harness.session.getAutonomyDiagnosticSnapshot();
		expect(snapshot.goals).toEqual([
			{
				title: "Goal goal-2",
				summary: "Refactor the module",
				reasonCode: "active",
				metadata: { openRequirementCount: 0, stallTurns: 0, blockedReason: undefined },
			},
		]);

		await harness.cleanup();
	});
});
