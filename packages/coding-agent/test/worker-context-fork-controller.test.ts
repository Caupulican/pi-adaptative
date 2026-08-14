import type { AgentMessage } from "@caupulican/pi-agent-core";
import { fauxAssistantMessage } from "@caupulican/pi-ai/faux";
import { describe, expect, it } from "vitest";
import type { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { ORCHESTRATION_SCHEMA_VERSION, type OrchestrationProfile } from "../src/core/orchestration/contracts.ts";
import { createHarness } from "./suite/harness.ts";

type ContextControls = {
	_getWorkerLifecycle(): WorkerLifecycle;
};

function controlsFor(session: unknown): ContextControls {
	return (session as { _backgroundLanes: ContextControls })._backgroundLanes;
}

function messageText(message: AgentMessage): string {
	if (message.role !== "user" && message.role !== "assistant") return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function workerProfile(modelId: string): OrchestrationProfile {
	const now = new Date().toISOString();
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		profileId: `worker-${modelId}`,
		description: `Pinned ${modelId} context worker`,
		role: "implementer",
		modelPolicy: { mode: "fixed", candidates: [{ provider: "faux", modelId, thinkingLevel: "off" }] },
		capabilityCeiling: ["filesystem.read"],
		toolNames: ["read"],
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

describe("worker controller birth-context integration", () => {
	it("defaults omitted fork to none, and captures last-N and explicit none", async () => {
		const run = async (instructions: string, forkTurns?: string) => {
			const harness = await createHarness({ settings: { workerDelegation: { maxConcurrent: 1 } } });
			let history: AgentMessage[] = [];
			try {
				harness.sessionManager.appendMessage({ role: "user", content: "older parent turn", timestamp: 1 });
				harness.sessionManager.appendMessage(fauxAssistantMessage("older parent answer"));
				harness.sessionManager.appendMessage({ role: "user", content: "latest parent turn", timestamp: 3 });
				harness.sessionManager.appendMessage(fauxAssistantMessage("latest parent answer"));
				harness.setResponses([
					(context) => {
						history = structuredClone(context.messages);
						return fauxAssistantMessage(JSON.stringify({ summary: instructions, status: "completed" }));
					},
				]);
				const outcome = await harness.session.runWorkerDelegationOnce({
					instructions,
					...(forkTurns ? { forkTurns } : {}),
				});
				expect(outcome.started).toBe(true);
				const attempts = Object.values(
					controlsFor(harness.session)._getWorkerLifecycle().getTaskRuntimeSnapshot().attempts,
				);
				return {
					history: history.map(messageText),
					messageCount: attempts[0]?.dispatch.birthContextForkReference?.messageCount,
				};
			} finally {
				harness.cleanup();
			}
		};
		const results = await Promise.all([run("default child"), run("last child", "1"), run("none child", "none")]);

		expect(results.map(({ history }) => history)).toEqual([
			[expect.stringContaining("default child")],
			["latest parent turn", "latest parent answer", expect.stringContaining("last child")],
			[expect.stringContaining("none child")],
		]);
		expect(results.map(({ messageCount }) => messageCount)).toEqual([0, 2, 0]);
	});

	it("defaults a cross-model child to none and rejects explicit context egress before durable admission", async () => {
		const harness = await createHarness({
			models: [
				{ id: "parent-model", contextWindow: 128_000 },
				{ id: "child-model", contextWindow: 128_000 },
			],
			workerOrchestrationProfile: workerProfile("child-model"),
		});
		const histories: AgentMessage[][] = [];
		try {
			expect(harness.session.model?.id).toBe("parent-model");
			harness.sessionManager.appendMessage({ role: "user", content: "must not cross", timestamp: 1 });
			harness.setResponses([
				(context) => {
					histories.push(structuredClone(context.messages));
					return fauxAssistantMessage('{"summary":"cross default","status":"completed"}');
				},
			]);

			const omitted = await harness.session.runWorkerDelegationOnce({ instructions: "cross-model default" });
			expect(omitted.started).toBe(true);
			expect(histories[0]?.map(messageText)).toEqual([expect.stringContaining("cross-model default")]);
			const before = controlsFor(harness.session)._getWorkerLifecycle().getTaskRuntimeSnapshot();
			const explicit = await harness.session.runWorkerDelegationOnce({
				instructions: "forbidden cross-model context",
				forkTurns: "all",
			});
			expect(explicit).toEqual({ started: false, skipReason: "worker_context_inheritance_denied" });
			const after = controlsFor(harness.session)._getWorkerLifecycle().getTaskRuntimeSnapshot();
			expect(Object.keys(after.tasks)).toEqual(Object.keys(before.tasks));
			expect(Object.keys(after.attempts)).toEqual(Object.keys(before.attempts));
			expect(histories).toHaveLength(1);
		} finally {
			harness.cleanup();
		}
	});

	it("defaults nested workers to self-contained context while preserving explicit inheritance", async () => {
		const run = async (forkTurns?: string) => {
			const harness = await createHarness({ settings: { workerDelegation: { maxConcurrent: 1 } } });
			let childHistory: string[] = [];
			try {
				harness.sessionManager.appendMessage({
					role: "user",
					content: "FOREGROUND_GLOBAL_ORCHESTRATION_INSTRUCTION",
					timestamp: 1,
				});
				harness.setResponses([
					fauxAssistantMessage('{"summary":"parent ready","status":"completed"}'),
					(context) => {
						childHistory = context.messages.map(messageText);
						return fauxAssistantMessage('{"summary":"nested verifier complete","status":"completed"}');
					},
				]);
				const parent = await harness.session.runWorkerDelegationOnce({
					instructions: "Own the scoped implementation stream.",
					forkTurns: "all",
				});
				if (!parent.record) throw new Error("Expected parent worker.");
				const child = await harness.session.runWorkerDelegationOnce({
					instructions: "Verify only the assigned seam with the admitted read-only tools.",
					parentAgentId: parent.record.laneId,
					...(forkTurns ? { forkTurns } : {}),
				});
				expect(child.started).toBe(true);
				const childAttempt = Object.values(
					controlsFor(harness.session)._getWorkerLifecycle().getTaskRuntimeSnapshot().attempts,
				).find((attempt) => attempt.dispatch.parentAgentId === parent.record?.laneId);
				return {
					childHistory,
					messageCount: childAttempt?.dispatch.birthContextForkReference?.messageCount,
				};
			} finally {
				harness.cleanup();
			}
		};

		const [implicit, explicit] = await Promise.all([run(), run("all")]);
		expect(implicit.childHistory).toEqual([
			expect.stringContaining("Verify only the assigned seam with the admitted read-only tools."),
		]);
		expect(implicit.messageCount).toBe(0);
		expect(explicit.childHistory).toContain("FOREGROUND_GLOBAL_ORCHESTRATION_INSTRUCTION");
		expect(explicit.messageCount).toBeGreaterThan(0);
	});
});
