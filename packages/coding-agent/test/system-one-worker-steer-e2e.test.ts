import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import { describe, expect, it, vi } from "vitest";
import { ORCHESTRATION_SCHEMA_VERSION, type OrchestrationProfile } from "../src/core/orchestration/contracts.ts";
import { setConcurrentResponses } from "./suite/concurrent-responses.ts";
import { createHarness } from "./suite/harness.ts";

function shellWorkerProfile(): OrchestrationProfile {
	const now = new Date().toISOString();
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		profileId: "shell-worker",
		description: "Worker that may run shell commands",
		role: "implementer",
		modelPolicy: { mode: "fixed", candidates: [{ provider: "faux", modelId: "faux-1", thinkingLevel: "off" }] },
		capabilityCeiling: ["filesystem.read", "process.exec"],
		toolNames: ["read", "bash"],
		resourceProfileNames: [],
		dispatchProfileIds: [],
		budget: { maxCostUsd: 1, maxTokens: 8_192, maxToolCalls: 4, maxWallClockMs: 60_000 },
		maxConcurrent: 1,
		leaseTtlMs: 90_000,
		requireIndependentVerification: false,
		createdAt: now,
		updatedAt: now,
	};
}

/**
 * A real worker on the faux transport with the session's real tools: System One steers it "now"
 * while its first turn sits inside a bash call that would run for a long time. The attempt is
 * interrupted (the shell is killed with the lane), the directive is queued, the attempt resumes,
 * and the worker's next turn opens on the directive. Worker requests carry the `lane:worker:`
 * affinity key, which the shared script router keys on.
 */
describe("System One steers a running worker now", () => {
	it("interrupts the worker's turn, resumes it, and the directive is in the worker's transcript", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 128_000 }],
			workerOrchestrationProfile: shellWorkerProfile(),
			settings: { workerDelegation: { enabled: true } },
		});
		try {
			setConcurrentResponses(harness, [
				fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30" })], { stopReason: "toolUse" }),
				fauxAssistantMessage('{"summary":"stopped and reported","status":"completed"}'),
			]);

			const run = harness.session.runWorkerDelegationOnce({ instructions: "Validate the parser, slowly." });
			const lanes = () =>
				harness.session.backgroundLanes.getLaneRecords().filter((record) => record.type === "worker");
			const running = await vi.waitFor(
				() => {
					const record = lanes().find((record) => record.status === "running" && record.agentId);
					expect(record).toBeDefined();
					expect(
						JSON.stringify(harness.session.backgroundLanes.readWorkerAgentTranscript(record!.agentId!).messages),
					).toContain("sleep 30");
					return record!;
				},
				{ timeout: 20_000, interval: 25 },
			);
			const agentId = running.agentId!;
			harness.session.systemOneWorkerControl.steerWorker(
				agentId,
				"System One: stop and report what you have.",
				"now",
			);
			const result = await run;
			expect(result.started).toBe(true);
			await vi.waitFor(
				() => {
					expect(lanes().every((record) => record.status !== "running" && record.status !== "queued")).toBe(true);
				},
				{ timeout: 30_000, interval: 50 },
			);
			const messages = harness.session.backgroundLanes.readWorkerAgentTranscript(agentId, {
				maxMessages: 64,
			}).messages;
			const texts = messages.map((message) => JSON.stringify(message.content));
			const toolCallIndex = texts.findIndex((text) => text.includes("sleep 30"));
			const interruptedIndex = texts.findIndex((text) => text.includes("interrupted before a durable tool result"));
			const directiveIndex = texts.findIndex((text) => text.includes("System One: stop and report what you have."));
			const reportIndex = texts.findIndex((text) => text.includes("stopped and reported"));
			// The interrupted attempt's tool result, then the directive, then the resumed turn's answer.
			expect(toolCallIndex).toBeGreaterThanOrEqual(0);
			expect(interruptedIndex).toBeGreaterThan(toolCallIndex);
			expect(directiveIndex).toBeGreaterThan(interruptedIndex);
			expect(reportIndex).toBeGreaterThan(directiveIndex);
			expect(messages[directiveIndex]?.role).toBe("user");
			const directives = harness.session.operatorProjection
				.getVisibleEvents()
				.filter((event) => event.title === `Worker steered · ${agentId}`)
				.map((event) => event.detail);
			expect(directives).toEqual(["steer (now): System One: stop and report what you have."]);
		} finally {
			await harness.cleanup();
		}
	}, 60_000);
});
