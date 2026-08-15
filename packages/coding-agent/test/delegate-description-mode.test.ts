import { describe, expect, it } from "vitest";
import { createDelegateToolDefinition } from "../src/core/tools/delegate.ts";

describe("delegate tool description varies by wiring mode", () => {
	it("teaches the synchronous contract when startWorkerDelegation is not wired", () => {
		const definition = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "test" }),
		});

		expect(definition.description).toContain("inherits the caller's execution authority by default");
		expect(definition.description).toContain("Workers are persistent specialists");
		expect(definition.description).toContain("start with agentId dispatches a new task onto an existing idle worker");
		expect(definition.description).toContain("list reports every session agent through safe metadata");
		expect(definition.description).toContain("transcript exposes bounded raw-entry pages");
		expect(definition.description).toContain("omittedMessages");
		expect(definition.description).toContain("page may be empty while nextCursor continues");
		expect(definition.description).toContain("wait and wait_many are event-driven");
		expect(definition.description).toContain("inbox_wait observes explicit replies only");
		expect(definition.description).toContain("timeout alone is never stall evidence");
		expect(definition.description).not.toContain("delegate_status");
		expect(definition.description).not.toContain("returns immediately");
		expect(definition.parameters).toMatchObject({
			properties: {
				cursor: { description: expect.stringContaining("opaque transcript raw-entry cursor") },
				maxMessages: { description: expect.stringContaining("may return fewer or zero messages") },
			},
		});

		const guidelines = definition.promptGuidelines ?? [];
		expect(guidelines.some((line) => line.includes("delegate_status"))).toBe(false);
		expect(guidelines.some((line) => line.includes("untrusted evidence"))).toBe(true);
		expect(guidelines.some((line) => line.includes("authority selects model"))).toBe(true);
		expect(guidelines.some((line) => line.includes("bounds depth"))).toBe(true);
		expect(guidelines.some((line) => line.includes("agents/queue"))).toBe(true);
		expect(guidelines.some((line) => line.includes("exact recursive task cycles"))).toBe(false);
		expect(guidelines.some((line) => line.includes("64") && line.includes("retry"))).toBe(true);
		expect(guidelines.some((line) => line.includes("Completion: wait/wait_many"))).toBe(true);
		expect(guidelines.some((line) => line.includes("Timeout alone") && line.includes("never interrupt"))).toBe(true);
		expect(guidelines).toContain(
			"CAVEMAN MODE - MANDATORY: fresh=no agentId; reuse=returned agentId; task=instructions; budget=authority.budget; idle=reuse.",
		);
	});

	it("teaches the async event-driven retrieval contract when startWorkerDelegation is wired", () => {
		const definition = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			startWorkerDelegation: () => ({
				started: true,
				record: { laneId: "worker-1", type: "worker", status: "queued" },
			}),
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
		});

		// Core capability wording is preserved alongside the async addendum.
		expect(definition.description).toContain("inherits the caller's execution authority by default");
		expect(definition.description).toContain("Workers are persistent specialists");
		expect(definition.description).toContain("start with agentId dispatches a new task onto an existing idle worker");
		expect(definition.description).toContain("returns immediately");
		expect(definition.description).not.toContain("delegate_status");
		expect(definition.description).toContain("does not wait for the worker to finish");
		expect(definition.description).toContain("terminal handoff");
		expect(definition.description).toContain("Do not poll");
		expect(definition.description).toContain("inbox_wait observes explicit replies only");
		expect(definition.description).toContain("timeout alone is never stall evidence");

		const guidelines = definition.promptGuidelines ?? [];
		expect(guidelines.some((line) => line.includes("Transcript pages are bounded"))).toBe(true);
		expect(guidelines.some((line) => line.includes("terminal handoff") && line.includes("never poll"))).toBe(true);
		expect(guidelines.some((line) => line.includes("authority selects model"))).toBe(true);
		expect(guidelines.some((line) => line.includes("bounds depth"))).toBe(true);
		expect(guidelines.some((line) => line.includes("agents/queue"))).toBe(true);
		expect(guidelines.some((line) => line.includes("64") && line.includes("retry"))).toBe(true);
		expect(guidelines.some((line) => line.includes("Completion: wait/wait_many"))).toBe(true);
		expect(guidelines.some((line) => line.includes("Timeout alone") && line.includes("never interrupt"))).toBe(true);
		expect(guidelines).toContain(
			"CAVEMAN MODE - MANDATORY: fresh=no agentId; reuse=returned agentId; task=instructions; budget=authority.budget; idle=reuse.",
		);
	});

	it("keeps both descriptions as per-wiring-mode static strings (prompt-cache stable)", () => {
		const unwiredA = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "test" }),
		});
		const unwiredB = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "different-closure-but-same-mode" }),
		});
		expect(unwiredA.description).toBe(unwiredB.description);
		expect(unwiredA.promptGuidelines).toEqual(unwiredB.promptGuidelines);

		const wiredA = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			startWorkerDelegation: () => ({
				started: true,
				record: { laneId: "worker-1", type: "worker", status: "queued" },
			}),
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
		});
		const wiredB = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			startWorkerDelegation: () => ({
				started: true,
				record: { laneId: "worker-2", type: "worker", status: "queued" },
			}),
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
		});
		expect(wiredA.description).toBe(wiredB.description);
		expect(wiredA.promptGuidelines).toEqual(wiredB.promptGuidelines);

		// The two modes must actually differ from each other.
		expect(unwiredA.description).not.toBe(wiredA.description);
	});

	it("keeps the fully wired root delegate guidelines inside the provider startup budget", () => {
		const definition = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			startWorkerDelegation: () => ({
				started: true,
				record: { laneId: "worker-1", type: "worker", status: "queued" },
			}),
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			orchestrationProfiles: Array.from({ length: 40 }, (_entry, index) => ({
				profileId: `profile-${index}-${"p".repeat(40)}`,
				role: `role-${index}-${"r".repeat(40)}`,
				description: `description-${index}-${"d".repeat(40)}`,
			})),
			workerAgentControl: {} as never,
			resolveMessageReplayScope: () => ({ sessionId: "session-1", branchId: "branch-1" }),
			status: {
				getLaneRecords: () => [],
				getWorkerClaimSnapshots: () => [],
				acknowledgeWorkerReview: () => ({
					ok: true,
					requestId: "worker-1",
					reviewedAt: "2026-08-12T00:00:00.000Z",
				}),
			},
			profileWriter: {
				inspectTaskProfileOptions: () => ({ baseProfiles: [], models: [] }),
				createTaskProfile: () => ({
					created: true,
					profileId: "task-1",
					baseProfileId: "base-1",
					changedFields: [],
				}),
			},
		});
		const guidelines = definition.promptGuidelines ?? [];

		expect(guidelines.every((guideline) => guideline.length <= 140)).toBe(true);
		expect(guidelines.reduce((total, guideline) => total + guideline.length, 0)).toBeLessThanOrEqual(1_200);
	});

	it("leaves the execute path unchanged in synchronous mode", async () => {
		const definition = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "budget_exhausted" }),
		});

		const result = await definition.execute(
			"call-1",
			{ instructions: "do the thing" },
			new AbortController().signal,
			() => {},
			{} as never,
		);

		const text = result.content
			.filter((content) => content.type === "text")
			.map((content) => content.text)
			.join("\n");
		expect(text).toBe("delegate skipped: budget_exhausted");
		expect(result.details).toEqual({ started: false, skipReason: "budget_exhausted" });
	});

	it("reports the parent-aware retrieval path in async mode", async () => {
		const definition = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			startWorkerDelegation: () => ({
				started: true,
				record: { laneId: "worker-1", type: "worker", status: "queued" },
			}),
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
		});

		const result = await definition.execute(
			"call-1",
			{ instructions: "do the thing" },
			new AbortController().signal,
			() => {},
			{} as never,
		);

		const text = result.content
			.filter((content) => content.type === "text")
			.map((content) => content.text)
			.join("\n");
		expect(text).toBe(
			"delegate started (queued) — stable agentId worker-1, task laneId worker-1; the owning parent will receive its terminal handoff, then use delegate status or bounded raw transcript pages\nCAVEMAN MODE - MANDATORY: queued is admitted durable nonterminal state, not stall or harness failure. Host starts it event-driven when dependencies, capacity, or safety reservations clear. Never poll, interrupt, or cancel a healthy running worker to force the queue. For genuine parallel read-only work, start a fresh worker whose authority.toolNames omits write and edit; write-capable workers may serialize. If you start a fresh narrower replacement, cancel this queued agent after the replacement starts; otherwise both tasks will run.",
		);
		expect(result.details).toEqual({ started: true, agentId: "worker-1", laneId: "worker-1", status: "queued" });
	});

	it("starts a worker when the brief is only in the shared-schema task field", async () => {
		let startCalls = 0;
		let startedInstructions: string | undefined;
		const definition = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			startWorkerDelegation: (input) => {
				startCalls += 1;
				startedInstructions = input.instructions;
				return {
					started: true,
					record: { laneId: "worker-1", type: "worker", status: "queued" },
				};
			},
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
		});

		const result = await definition.execute(
			"call-misplaced-task",
			{ action: "start", task: "EXACT TASK TEXT" },
			new AbortController().signal,
			() => {},
			{} as never,
		);
		const text = result.content
			.filter((content) => content.type === "text")
			.map((content) => content.text)
			.join("\n");

		expect(startCalls).toBe(1);
		expect(startedInstructions).toBe("EXACT TASK TEXT");
		expect(text).toContain("worker-1");
		expect(result.details).toMatchObject({
			started: true,
			agentId: "worker-1",
			status: "queued",
		});
	});

	it("rejects conflicting task and instructions fields without dispatching a worker", async () => {
		let startCalls = 0;
		const definition = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			startWorkerDelegation: () => {
				startCalls += 1;
				return {
					started: true,
					record: { laneId: "worker-1", type: "worker", status: "queued" },
				};
			},
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
		});

		const result = await definition.execute(
			"call-conflicting-task",
			{ action: "start", task: "TASK FIELD", instructions: "INSTRUCTIONS FIELD" },
			new AbortController().signal,
			() => {},
			{} as never,
		);
		const text = result.content
			.filter((content) => content.type === "text")
			.map((content) => content.text)
			.join("\n");

		expect(startCalls).toBe(0);
		expect(text).toContain("delegate start field task is forbidden");
		expect(result.details).toEqual({
			started: false,
			skipReason: "action_field_forbidden",
			action: "start",
		});
	});

	it("treats a misplaced start budget as correctable input and preserves it for one retry", async () => {
		let startCalls = 0;
		const definition = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			startWorkerDelegation: () => {
				startCalls += 1;
				return {
					started: true,
					record: { laneId: "worker-1", type: "worker", status: "queued" },
				};
			},
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
		});

		const result = await definition.execute(
			"call-misplaced-budget",
			{ action: "start", instructions: "EXACT TASK TEXT", budget: { maxTokens: 12_345 } },
			new AbortController().signal,
			() => {},
			{} as never,
		);
		const text = result.content
			.filter((content) => content.type === "text")
			.map((content) => content.text)
			.join("\n");

		expect(text).toContain("CAVEMAN MODE - MANDATORY");
		expect(text).toContain("expected API correction, not harness failure");
		expect(text).toContain("Retry once now");
		expect(text).toContain("move the budget unchanged into authority.budget");
		expect(text).toContain("No worker started; nothing was dropped");
		expect(startCalls).toBe(0);
		expect(result.details).toEqual({
			started: false,
			skipReason: "action_field_forbidden",
			action: "start",
		});
	});

	it.each([
		"worker_agent_depth_limit_reached",
		"worker_agent_child_limit_reached",
		"worker_agent_nested_session_limit_reached",
		"worker_agent_session_limit_reached",
	])("distinguishes expected policy capacity %s from harness instability", async (skipReason) => {
		const definition = createDelegateToolDefinition({
			caller: { kind: "worker", agentId: "worker-1" },
			startWorkerDelegation: () => ({ started: false, skipReason }),
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
		});

		const result = await definition.execute(
			"call-child-cap",
			{ action: "start", instructions: "verify the focused regression" },
			new AbortController().signal,
			() => {},
			{} as never,
		);
		const text = result.content
			.filter((content) => content.type === "text")
			.map((content) => content.text)
			.join("\n");

		expect(text).toContain("CAVEMAN MODE - MANDATORY");
		expect(text).toContain(`${skipReason} is expected policy capacity`);
		expect(text).toContain("not harness instability");
		expect(text).toContain("Reuse only an idle descendant with controllable=true");
		expect(text).toContain("return the constraint to the parent");
		expect(result.details).toEqual({
			started: false,
			skipReason,
		});
		expect(result.isError).toBe(true);
	});

	it("treats an unknown optional profile as correctable routing policy, not harness failure", async () => {
		const definition = createDelegateToolDefinition({
			caller: { kind: "worker", agentId: "worker-1" },
			startWorkerDelegation: () => ({ started: false, skipReason: "orchestration_profile_not_found" }),
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
		});

		const result = await definition.execute(
			"call-missing-profile",
			{ action: "start", instructions: "Verify the focused regression", profileId: "invented-preset" },
			new AbortController().signal,
			() => {},
			{} as never,
		);
		const text = result.content
			.filter((content) => content.type === "text")
			.map((content) => content.text)
			.join("\n");

		expect(text).toContain("CAVEMAN MODE - MANDATORY");
		expect(text).toContain("orchestration_profile_not_found");
		expect(text).toContain("not harness failure");
		expect(text).toContain("Retry once with profileId omitted");
		expect(text).toContain("never invent profile IDs");
		expect(result.details).toEqual({
			started: false,
			skipReason: "orchestration_profile_not_found",
			profileId: "invented-preset",
		});
		expect(result.isError).toBe(true);
	});

	it("treats an unavailable optional model as correctable routing policy, not harness failure", async () => {
		const definition = createDelegateToolDefinition({
			caller: { kind: "worker", agentId: "worker-1" },
			startWorkerDelegation: () => ({ started: false, skipReason: "orchestration_model_unavailable" }),
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
		});

		const result = await definition.execute(
			"call-unavailable-model",
			{
				action: "start",
				instructions: "Verify the focused regression",
				authority: { model: { provider: "unavailable", modelId: "missing-model" } },
			},
			new AbortController().signal,
			() => {},
			{} as never,
		);
		const text = result.content
			.filter((content) => content.type === "text")
			.map((content) => content.text)
			.join("\n");

		expect(text).toContain("CAVEMAN MODE - MANDATORY");
		expect(text).toContain("orchestration_model_unavailable");
		expect(text).toContain("not harness failure");
		expect(text).toContain("Retry once with authority.model omitted");
		expect(text).toContain("never invent model IDs");
		expect(result.details).toEqual({
			started: false,
			skipReason: "orchestration_model_unavailable",
		});
	});

	it("routes a preset with an unavailable model back to adaptive authority", async () => {
		const definition = createDelegateToolDefinition({
			caller: { kind: "worker", agentId: "worker-1" },
			startWorkerDelegation: () => ({
				started: false,
				skipReason: "orchestration_profile_model_unavailable",
			}),
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
		});

		const result = await definition.execute(
			"call-profile-model-unavailable",
			{ action: "start", instructions: "Verify the focused regression", profileId: "stale-preset" },
			new AbortController().signal,
			() => {},
			{} as never,
		);
		const text = result.content
			.filter((content) => content.type === "text")
			.map((content) => content.text)
			.join("\n");

		expect(text).toContain("CAVEMAN MODE - MANDATORY");
		expect(text).toContain("orchestration_profile_model_unavailable");
		expect(text).toContain("not harness failure");
		expect(text).toContain("Retry once with profileId omitted");
		expect(result.details).toEqual({
			started: false,
			skipReason: "orchestration_profile_model_unavailable",
			profileId: "stale-preset",
		});
	});
});
