import { describe, expect, it } from "vitest";
import { createDelegateToolDefinition } from "../src/core/tools/delegate.ts";

describe("delegate tool description varies by wiring mode", () => {
	it("teaches the synchronous contract when startWorkerDelegation is not wired", () => {
		const definition = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "test" }),
		});

		expect(definition.description).toContain(
			"inherits the foreground model, reasoning, every compatible tool, and machine-wide project access",
		);
		expect(definition.description).toContain("persistent leaf workers");
		expect(definition.description).toContain("start with agentId dispatches a new task onto an existing idle worker");
		expect(definition.description).toContain("list reports every session worker through safe metadata");
		expect(definition.description).toContain("transcript exposes bounded raw-entry pages");
		expect(definition.description).toContain("omittedMessages");
		expect(definition.description).toContain("page may be empty while nextCursor continues");
		expect(definition.description).toContain("wait and wait_many are event-driven");
		expect(definition.description).toContain("inbox_wait observes explicit replies only");
		expect(definition.description).toContain(
			"follow_up starts an idle targeted worker or steers an active targeted worker at a message boundary",
		);
		expect(definition.description).toContain(
			"send/broadcast are non-waking coordination evidence and do not control or complete workers",
		);
		expect(definition.description).not.toMatch(/subtree|descendant|recursive/i);
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
		expect(guidelines.some((line) => line.includes("Optional model/thinkingLevel/path/toolNames only"))).toBe(true);
		expect(guidelines.some((line) => line.includes("leaf specialists"))).toBe(true);
		expect(guidelines.join("\n")).not.toMatch(/depth|descendant|recursive/i);
		expect(guidelines.some((line) => line.includes("64") && line.includes("retry"))).toBe(true);
		expect(guidelines.some((line) => line.includes("Completion: wait/wait_many"))).toBe(true);
		expect(guidelines.some((line) => line.includes("Timeout alone") && line.includes("never interrupt"))).toBe(true);
		expect(guidelines).toContain(
			"CAVEMAN MODE - MANDATORY: fresh=no agentId; reuse=returned agentId; task=instructions; idle=reuse.",
		);
		expect(guidelines.some((line) => line.includes("Host compiles and persists"))).toBe(true);
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
		expect(definition.description).toContain(
			"inherits the foreground model, reasoning, every compatible tool, and machine-wide project access",
		);
		expect(definition.description).toContain("persistent leaf workers");
		expect(definition.description).toContain("start with agentId dispatches a new task onto an existing idle worker");
		expect(definition.description).toContain("returns immediately");
		expect(definition.description).not.toContain("delegate_status");
		expect(definition.description).toContain("does not wait for the worker to finish");
		expect(definition.description).toContain("terminal handoff");
		expect(definition.description).toContain("Do not poll");
		expect(definition.description).toContain("inbox_wait observes explicit replies only");
		expect(definition.description).toContain("timeout alone is never stall evidence");
		expect(definition.description).toContain(
			"follow_up starts an idle targeted worker or steers an active targeted worker at a message boundary",
		);
		expect(definition.description).toContain(
			"send/broadcast are non-waking coordination evidence and do not control or complete workers",
		);

		const guidelines = definition.promptGuidelines ?? [];
		expect(guidelines.some((line) => line.includes("Transcript pages are bounded"))).toBe(true);
		expect(guidelines.some((line) => line.includes("terminal handoff") && line.includes("never poll"))).toBe(true);
		expect(guidelines.some((line) => line.includes("Optional model/thinkingLevel/path/toolNames only"))).toBe(true);
		expect(guidelines.some((line) => line.includes("leaf specialists"))).toBe(true);
		expect(guidelines.join("\n")).not.toMatch(/depth|descendant|recursive/i);
		expect(guidelines.some((line) => line.includes("64") && line.includes("retry"))).toBe(true);
		expect(guidelines.some((line) => line.includes("Completion: wait/wait_many"))).toBe(true);
		expect(guidelines.some((line) => line.includes("Timeout alone") && line.includes("never interrupt"))).toBe(true);
		expect(guidelines).toContain(
			"CAVEMAN MODE - MANDATORY: fresh=no agentId; reuse=returned agentId; task=instructions; idle=reuse.",
		);
		expect(guidelines.some((line) => line.includes("Host compiles and persists"))).toBe(true);
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
				inspectTaskProfileOptions: () => ({ baseProfiles: [], models: [], inheritedToolNames: [] }),
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
			"delegate started (queued) — stable agentId worker-1, task laneId worker-1; the owning parent will receive its terminal handoff, then use delegate status or bounded raw transcript pages\nCAVEMAN MODE - MANDATORY: queued is admitted durable nonterminal state, not stall or harness failure. Host starts it event-driven when dependencies, capacity, or explicit workspace reservations clear. Never poll, interrupt, or cancel a healthy running worker to force the queue. Independent machine-scope workers may run in parallel; an explicit path preserves collision fencing. If you start a fresh narrower replacement, cancel this queued agent after the replacement starts; otherwise both tasks will run.",
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

	it("rejects a misplaced start budget without dropping the task text", async () => {
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
			{ action: "start", instructions: "EXACT TASK TEXT", budget: { maxTokens: 12_345 } } as never,
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
		expect(text).toContain("Ceilings come only from host settings or an owner-authored profileId");
		expect(text).toContain("Retry once now without budget and keep the task unchanged");
		expect(text).toContain("No worker started; nothing was dropped");
		expect(startCalls).toBe(0);
		expect(result.details).toEqual({
			started: false,
			skipReason: "action_field_forbidden",
			action: "start",
		});
	});

	it("rejects a worker caller that bypasses the leaf-only schema to request start", async () => {
		let startCalls = 0;
		const definition = createDelegateToolDefinition({
			caller: { kind: "worker", agentId: "worker-1" },
			startWorkerDelegation: () => {
				startCalls += 1;
				return { started: false, skipReason: "should_not_run" };
			},
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
		});

		const result = await definition.execute(
			"call-worker-start",
			{ action: "start", instructions: "verify the focused regression" },
			new AbortController().signal,
			() => {},
			{} as never,
		);
		const text = result.content
			.filter((content) => content.type === "text")
			.map((content) => content.text)
			.join("\n");

		expect(text).toContain("delegate action is unavailable to this caller: start");
		expect(result.details).toEqual({
			started: false,
			action: "start",
			skipReason: "action_unavailable",
		});
		expect(result.isError).toBe(true);
		expect(startCalls).toBe(0);
	});

	it("distinguishes root worker-session capacity from harness instability", async () => {
		const definition = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			startWorkerDelegation: () => ({ started: false, skipReason: "worker_agent_session_limit_reached" }),
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
		});

		const result = await definition.execute(
			"call-session-cap",
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
		expect(text).toContain("worker_agent_session_limit_reached is expected policy capacity");
		expect(text).toContain("not harness instability");
		expect(text).toContain("Reuse an idle worker returned by delegate list");
		expect(text).toContain("return the constraint to the user");
		expect(result.details).toEqual({
			started: false,
			skipReason: "worker_agent_session_limit_reached",
		});
		expect(result.isError).toBe(true);
	});

	it("treats an unknown optional profile as correctable routing policy, not harness failure", async () => {
		const definition = createDelegateToolDefinition({
			caller: { kind: "session_root" },
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
			caller: { kind: "session_root" },
			startWorkerDelegation: () => ({ started: false, skipReason: "orchestration_model_unavailable" }),
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
		});

		const result = await definition.execute(
			"call-unavailable-model",
			{
				action: "start",
				instructions: "Verify the focused regression",
				model: { provider: "unavailable", modelId: "missing-model" },
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
		expect(text).toContain("Retry once with model omitted");
		expect(text).toContain("never invent model IDs");
		expect(result.details).toEqual({
			started: false,
			skipReason: "orchestration_model_unavailable",
		});
	});

	it("routes a preset with an unavailable model back to adaptive authority", async () => {
		const definition = createDelegateToolDefinition({
			caller: { kind: "session_root" },
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
