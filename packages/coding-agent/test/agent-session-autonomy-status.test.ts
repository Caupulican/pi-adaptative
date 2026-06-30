import type { AgentTool } from "@caupulican/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type Usage } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ModelRouterDecisionStatus } from "../src/core/model-router/status.ts";
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
			_lastModelRouterDecision: ModelRouterDecisionStatus;
		};
		sessionWithInternals._lastModelRouterDecision = mockDecision;

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
});
