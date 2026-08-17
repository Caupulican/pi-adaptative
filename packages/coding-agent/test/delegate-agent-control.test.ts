import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import type { WorkerAgentControlPort } from "../src/core/delegation/worker-agent-control.ts";
import { resolveWorkerContextInheritanceMode } from "../src/core/delegation/worker-context-inheritance-policy.ts";
import { MAX_WORKER_TRANSCRIPT_PAGE_MESSAGES } from "../src/core/delegation/worker-conversation-store.ts";
import type { WorkerDelegationRequest } from "../src/core/delegation/worker-delegation-request.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { MAX_ORCHESTRATION_COLLECTION_LENGTH } from "../src/core/orchestration/contracts.ts";
import {
	createDelegateToolDefinition,
	type DelegateToolDetails,
	type DelegateToolInput,
} from "../src/core/tools/delegate.ts";
import type { DelegateStatusToolDetails } from "../src/core/tools/delegate-status.ts";

const context = {
	sessionManager: {
		getSessionId: () => "session-1",
		getLeafId: () => "leaf-1",
	},
} as unknown as ExtensionContext;

const fixedReplayScope = () => ({ sessionId: "session-1", branchId: "leaf-1" });

function delegateText(result: Awaited<ReturnType<ReturnType<typeof createDelegateToolDefinition>["execute"]>>): string {
	return (
		result.content.find((item): item is Extract<typeof item, { type: "text" }> => item.type === "text")?.text ?? ""
	);
}

function delegateDetails(
	result: Awaited<ReturnType<ReturnType<typeof createDelegateToolDefinition>["execute"]>>,
): DelegateToolDetails {
	const details = result.details;
	if (!details || typeof details !== "object" || Array.isArray(details)) {
		throw new TypeError("Delegate tool result details must be an object.");
	}
	const started = Reflect.get(details, "started");
	if (typeof started !== "boolean") {
		throw new TypeError("Delegate tool result details must include boolean started state.");
	}
	return details as DelegateToolDetails;
}

function workerAgentControl(overrides: Partial<WorkerAgentControlPort>): WorkerAgentControlPort {
	return {
		listWorkerAgents: () => [],
		getWorkerTaskSessionView: () => ({ totalTasks: 0, omittedTaskCount: 0, tasks: [] }),
		getWorkerAgentActivity: () => "unknown",
		readWorkerAgentTranscript: (agentId) => ({
			agentId,
			cursor: 0,
			totalMessages: 0,
			messages: [],
			omittedMessages: 0,
			serializedBytes: 2,
		}),
		sendWorkerAgentMessage: () => ({ messageId: "unused", queued: true }),
		followUpWorkerAgent: () => ({ started: false, steering: false, messageId: "unused" }),
		sendSessionRootWorkerAgentMessage: () => ({ messageId: "unused", queued: true }),
		followUpSessionRootWorkerAgent: () => ({ started: false, steering: false, messageId: "unused" }),
		replyToWorkerAgentMessage: () => ({ destination: "session_root", messageId: "unused" }),
		listSessionRootReplies: () => [],
		waitForSessionRootReplies: async () => ({ replies: [], timedOut: true }),
		acknowledgeSessionRootReply: () => false,
		reconcileSessionRootReplies: () => undefined,
		startWorkerAgentTask: () => ({ started: false, steering: false, messageId: "", skipReason: "unknown_agent" }),
		interruptWorkerAgent: () => ({ interrupted: false }),
		resumeWorkerAgent: () => ({ started: false }),
		cancelWorkerAgent: () => undefined,
		waitForWorkerAgent: async () => ({ status: "unknown", timedOut: false }),
		waitForWorkerAgents: async () => ({ statuses: [], updatedAgentIds: [], timedOut: false }),
		broadcastWorkerAgentMessage: () => ({ results: [] }),
		retireWorkerAgent: (agentId) => ({
			agent: {
				agentId,
				rootAgentId: agentId,
				depth: 0,
				role: "explorer",
				status: "retired",
				activity: "idle",
				controllable: true,
				createdAt: "T0",
				updatedAt: "T1",
			},
			retired: true,
			replayed: false,
		}),
		...overrides,
	};
}

describe("delegate logical-agent controls", () => {
	it("forwards bounded dependency task ids for fresh and reused starts", async () => {
		const startWorkerDelegation = vi.fn(() => ({
			started: true as const,
			record: { laneId: "fresh", type: "worker" as const, status: "queued" as const },
		}));
		const startWorkerAgentTask = vi.fn(() => ({
			started: true,
			steering: false as const,
			messageId: "reuse-message",
			record: { laneId: "reuse-task", type: "worker" as const, status: "queued" as const },
		}));
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			resolveMessageReplayScope: fixedReplayScope,
			startWorkerDelegation,
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({ startWorkerAgentTask }),
		});

		await tool.execute(
			"fresh-call",
			{ action: "start", instructions: "consume both", dependsOn: [" prerequisite-a ", "prerequisite-b"] },
			undefined,
			undefined,
			context,
		);
		await tool.execute(
			"reuse-call",
			{
				action: "start",
				agentId: "worker-1",
				instructions: "consume one",
				dependsOn: ["prerequisite-a"],
			},
			undefined,
			undefined,
			context,
		);

		expect(startWorkerDelegation).toHaveBeenCalledWith({
			instructions: "consume both",
			taskContext: {
				requirementIds: [],
				dependsOnTaskIds: ["prerequisite-a", "prerequisite-b"],
				acceptanceCriterionIds: [],
				resourcePointerIds: [],
			},
		});
		expect(startWorkerAgentTask).toHaveBeenCalledWith(
			"worker-1",
			"consume one",
			expect.objectContaining({
				dependsOnTaskIds: ["prerequisite-a"],
				idempotencyKey: expect.stringMatching(/^delegate-message-[a-f0-9]{64}$/),
			}),
		);
	});

	it("forwards birth-context selection only for a fresh logical worker", async () => {
		const startWorkerDelegation = vi.fn(() => ({
			started: true as const,
			record: { laneId: "fresh", type: "worker" as const, status: "queued" as const },
		}));
		const startWorkerAgentTask = vi.fn(() => ({
			started: true,
			steering: false as const,
			messageId: "must-not-run",
		}));
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			resolveMessageReplayScope: fixedReplayScope,
			startWorkerDelegation,
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({ startWorkerAgentTask }),
		});

		await tool.execute(
			"fresh-context",
			{ action: "start", instructions: "inherit one", forkTurns: "1" },
			undefined,
			undefined,
			context,
		);
		const reuse = await tool.execute(
			"reuse-context",
			{ action: "start", agentId: "worker-1", instructions: "continue", forkTurns: "none" },
			undefined,
			undefined,
			context,
		);

		expect(startWorkerDelegation).toHaveBeenCalledWith({ instructions: "inherit one", forkTurns: "1" });
		expect(reuse.details).toMatchObject({
			started: true,
			agentId: "worker-1",
		});
	});

	it("lets Codex-valid fork turn spellings reach the context policy parser while zero still rejects", async () => {
		const parsedModes: Array<ReturnType<typeof resolveWorkerContextInheritanceMode>> = [];
		const startWorkerDelegation = vi.fn((request: WorkerDelegationRequest) => {
			try {
				parsedModes.push(
					resolveWorkerContextInheritanceMode({
						parent: { provider: "faux", model: "faux-1" },
						worker: { provider: "faux", model: "faux-1" },
						...(request.forkTurns !== undefined ? { mode: request.forkTurns } : {}),
					}),
				);
				return {
					started: true as const,
					record: { laneId: `fresh-${parsedModes.length}`, type: "worker" as const, status: "queued" as const },
				};
			} catch (error) {
				return {
					started: false as const,
					skipReason: `worker_context_inheritance_denied:${error instanceof Error ? error.message : String(error)}`,
				};
			}
		});
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			startWorkerDelegation,
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
		});
		const forkTurns = [" ALL ", "01", "0"] as const;
		for (const value of forkTurns) {
			expect(
				Value.Check(tool.parameters, { action: "start", instructions: "inherit context", forkTurns: value }),
			).toBe(true);
		}

		const results = [];
		for (const [index, value] of forkTurns.entries()) {
			results.push(
				await tool.execute(
					`fork-context-${index}`,
					{ action: "start", instructions: "inherit context", forkTurns: value },
					undefined,
					undefined,
					context,
				),
			);
		}

		expect(parsedModes).toEqual([{ kind: "all" }, { kind: "last_user_turns", count: 1 }]);
		expect(results.map(({ details }) => (details as DelegateToolDetails).started)).toEqual([true, true, false]);
		expect(results[2]?.details).toMatchObject({
			started: false,
			skipReason: expect.stringContaining("positive safe-integer string"),
		});
		expect(startWorkerDelegation.mock.calls.map(([request]) => request.forkTurns)).toEqual(forkTurns);
	});

	it("returns the safe task projection through an exact tasks action", async () => {
		const getWorkerTaskSessionView = vi.fn(() => ({
			totalTasks: 1,
			omittedTaskCount: 0,
			tasks: [
				{
					taskId: "task-1",
					title: "Inspect",
					role: "explorer" as const,
					status: "ready" as const,
					dependsOn: [],
				},
			],
		}));
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({ getWorkerTaskSessionView }),
		});

		const result = await tool.execute("tasks-call", { action: "tasks" }, undefined, undefined, context);
		expect(JSON.parse(delegateText(result))).toEqual(getWorkerTaskSessionView.mock.results[0]?.value);
		expect(result.details).toMatchObject({ started: true, action: "tasks" });
		expect(getWorkerTaskSessionView).toHaveBeenCalledOnce();

		const forbidden = await tool.execute(
			"tasks-forbidden",
			{ action: "tasks", instructions: "must not block execution" },
			undefined,
			undefined,
			context,
		);
		expect(forbidden.details).toMatchObject({ started: true, action: "tasks" });
		expect(getWorkerTaskSessionView).toHaveBeenCalledTimes(2);
	});

	it("projects queued tasks as admitted nonterminal work", async () => {
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({
				getWorkerTaskSessionView: () => ({
					totalTasks: 1,
					omittedTaskCount: 0,
					tasks: [
						{
							taskId: "task-queued",
							title: "Inspect",
							role: "explorer",
							status: "ready",
							dependsOn: [],
							latestAttempt: { agentId: "worker-queued", status: "queued" },
						},
					],
				}),
			}),
		});

		const result = await tool.execute("tasks-queued", { action: "tasks" }, undefined, undefined, context);
		const payload = JSON.parse(delegateText(result)) as Record<string, unknown>;
		expect(payload).toMatchObject({
			queueState: "admitted_nonterminal",
			workerStallProven: false,
			workerHarnessFailureProven: false,
		});
		expect(payload.cavemanDirective).toContain(
			"CAVEMAN MODE - MANDATORY: queued is admitted durable nonterminal state",
		);
	});

	it.each([
		{ dependsOn: ["duplicate", "duplicate"], label: "duplicate" },
		{ dependsOn: [""], label: "empty" },
		{ dependsOn: ["x".repeat(513)], label: "oversized" },
		{ dependsOn: Array.from({ length: 65 }, (_, index) => `task-${index}`), label: "over-count" },
	])("rejects $label dependency ids before dispatch", async ({ dependsOn }) => {
		const startWorkerDelegation = vi.fn();
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			startWorkerDelegation,
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
		});
		const result = await tool.execute(
			"invalid-dependencies",
			{ action: "start", instructions: "invalid", dependsOn },
			undefined,
			undefined,
			context,
		);
		expect(result.details).toMatchObject({ started: false, skipReason: "dependency_ids_invalid" });
		expect(result.isError).toBe(true);
		expect(startWorkerDelegation).not.toHaveBeenCalled();
	});

	it("sanitizes irrelevant start fields so execution proceeds", async () => {
		const startWorkerDelegation = vi.fn(() => ({
			started: true as const,
			record: { laneId: "lane-1", type: "worker" as const, status: "queued" as const },
		}));
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			startWorkerDelegation,
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
		});
		const result = await tool.execute(
			"start-forbidden",
			{ action: "start", instructions: "work", message: "extraneous field sanitized" },
			undefined,
			undefined,
			context,
		);
		expect(result.details).toMatchObject({ started: true });
		expect(startWorkerDelegation).toHaveBeenCalledOnce();
	});

	it.each([
		{ action: "list", input: { action: "list", instructions: "ignored" } },
		{ action: "transcript", input: { action: "transcript", agentId: "agent-1", instructions: "ignored" } },
		{
			action: "send",
			input: { action: "send", agentId: "agent-1", message: "evidence", instructions: "ignored" },
		},
		{
			action: "follow_up",
			input: { action: "follow_up", agentId: "agent-1", message: "continue", instructions: "ignored" },
		},
		{ action: "wait", input: { action: "wait", agentId: "agent-1", instructions: "ignored" } },
		{ action: "interrupt", input: { action: "interrupt", agentId: "agent-1", instructions: "ignored" } },
		{ action: "resume", input: { action: "resume", agentId: "agent-1", instructions: "ignored" } },
		{ action: "cancel", input: { action: "cancel", agentId: "agent-1", instructions: "ignored" } },
	] satisfies Array<{ action: string; input: DelegateToolInput }>)(
		"sanitizes irrelevant fields for exact $action commands so execution proceeds",
		async ({ action, input }) => {
			const tool = createDelegateToolDefinition({
				caller: { kind: "session_root" },
				resolveMessageReplayScope: fixedReplayScope,
				runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
				workerAgentControl: workerAgentControl({}),
			});

			const sanitized = await tool.execute(`${action}-sanitized`, input, undefined, undefined, context);
			const sanitizedDetails = delegateDetails(sanitized);

			expect(sanitizedDetails.action).toBe(action);
			expect(sanitizedDetails.skipReason).not.toBe(`${action}_fields_forbidden`);
		},
	);

	it("uses one flat action schema and returns the stable agent id with the initial task lane", async () => {
		const startWorkerDelegation = vi.fn(() => ({
			started: true as const,
			record: { laneId: "lane-1", type: "worker" as const, status: "queued" as const },
		}));
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			startWorkerDelegation,
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
		});

		const result = await tool.execute("call", { instructions: "Inspect the failure" }, undefined, undefined, context);
		expect(startWorkerDelegation).toHaveBeenCalledWith({ instructions: "Inspect the failure" });
		expect(result.details).toMatchObject({ started: true, agentId: "lane-1", laneId: "lane-1" });
		expect(JSON.stringify(tool.parameters)).not.toContain("oneOf");
	});

	it("forwards a model-authored capability specification instead of requiring a profile cage", async () => {
		const startWorkerDelegation = vi.fn(() => ({
			started: true as const,
			record: { laneId: "lane-free", type: "worker" as const, status: "queued" as const },
		}));
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			startWorkerDelegation,
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
		});
		const authority = {
			role: "operator" as const,
			model: { provider: "faux", modelId: "selected" },
			thinkingLevel: "high" as const,
			capabilities: ["filesystem.read" as const, "process.exec" as const, "workflow.delegate" as const],
			toolNames: ["read", "bash", "delegate"],
			readPaths: ["."],
		};

		await tool.execute(
			"call",
			{ instructions: "Use the strongest useful local tools.", authority },
			undefined,
			undefined,
			context,
		);

		expect(startWorkerDelegation).toHaveBeenCalledWith({
			instructions: "Use the strongest useful local tools.",
			authority,
		});
	});

	it("bounds the owner profile catalog injected into the model prompt while retaining its total", () => {
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			orchestrationProfiles: Array.from({ length: 40 }, (_, index) => ({
				profileId: `profile-${index}-${"p".repeat(512)}`,
				role: `role-${"r".repeat(512)}`,
				description: `description-${index}-${"d".repeat(8_192)}`,
			})),
		});

		const guidelines = tool.promptGuidelines ?? [];
		expect(guidelines.every((guideline) => guideline.length <= 140)).toBe(true);
		expect(guidelines.reduce((total, guideline) => total + guideline.length, 0)).toBeLessThanOrEqual(1_200);
		expect(guidelines.join("\n")).toContain("Owner profiles: 40");
		expect(guidelines.join("\n")).toContain("39 omitted");
	});

	it("validates action-specific fields before routing worker controls", async () => {
		const sendWorkerAgentMessage = vi.fn(() => ({ messageId: "message-1", queued: true as const }));
		const tool = createDelegateToolDefinition({
			caller: { kind: "worker", agentId: "agent-sender" },
			resolveMessageReplayScope: fixedReplayScope,
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({ sendWorkerAgentMessage }),
		});

		const missing = await tool.execute("call", { action: "send", agentId: "agent-1" }, undefined, undefined, context);
		expect(missing.content).toEqual([{ type: "text", text: "delegate send requires message" }]);
		expect(sendWorkerAgentMessage).not.toHaveBeenCalled();

		const sent = await tool.execute(
			"call",
			{ action: "send", agentId: "agent-1", message: "Check the focused test" },
			undefined,
			undefined,
			context,
		);
		expect(sendWorkerAgentMessage).toHaveBeenCalledWith("agent-1", "Check the focused test", {
			senderAgentId: "agent-sender",
			idempotencyKey: expect.stringMatching(/^delegate-message-[a-f0-9]{64}$/),
		});
		expect(sent.details).toMatchObject({ action: "send", agentId: "agent-1", queued: true });
	});

	it("lets an agent list peers, read exact transcript pages, and send threaded reply-expected messages", async () => {
		const listWorkerAgents = vi.fn(() => [
			{
				agentId: "agent-2",
				parentAgentId: "agent-1",
				rootAgentId: "agent-1",
				depth: 1,
				role: "explorer" as const,
				status: "registered" as const,
				activity: "idle" as const,
				controllable: true,
				createdAt: "2026-08-04T00:00:00.000Z",
				updatedAt: "2026-08-04T00:00:00.000Z",
			},
		]);
		const readWorkerAgentTranscript = vi.fn(() => ({
			agentId: "agent-2",
			cursor: 1,
			totalMessages: 3,
			messages: [{ role: "user" as const, content: "EXACT_PEER_MESSAGE", timestamp: 1 }],
			nextCursor: 2,
			omittedMessages: 0,
			serializedBytes: 80,
		}));
		const sendWorkerAgentMessage = vi.fn(() => ({ messageId: "message-2", queued: true as const }));
		const tool = createDelegateToolDefinition({
			caller: { kind: "worker", agentId: "agent-1" },
			resolveMessageReplayScope: fixedReplayScope,
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({
				listWorkerAgents,
				readWorkerAgentTranscript,
				sendWorkerAgentMessage,
			}),
		});

		const listed = await tool.execute("call", { action: "list" }, undefined, undefined, context);
		const transcript = await tool.execute(
			"call",
			{ action: "transcript", agentId: "agent-2", cursor: 1, maxMessages: 1 },
			undefined,
			undefined,
			context,
		);
		await tool.execute(
			"call",
			{
				action: "send",
				agentId: "agent-2",
				message: "Please reply with evidence.",
				threadId: "thread-1",
				expectReply: true,
			},
			undefined,
			undefined,
			context,
		);

		expect(JSON.stringify(listed.content)).toContain("agent-2");
		expect(JSON.stringify(listed.content)).not.toContain("resumeContext");
		expect(JSON.stringify(transcript.content)).toContain("EXACT_PEER_MESSAGE");
		expect(listWorkerAgents).toHaveBeenCalledWith({ callerAgentId: "agent-1" });
		expect(readWorkerAgentTranscript).toHaveBeenCalledWith("agent-2", {
			cursor: 1,
			maxMessages: 1,
			maxBytes: 12 * 1024,
			callerAgentId: "agent-1",
		});
		expect(sendWorkerAgentMessage).toHaveBeenCalledWith("agent-2", "Please reply with evidence.", {
			senderAgentId: "agent-1",
			threadId: "thread-1",
			expectReply: true,
			idempotencyKey: expect.stringMatching(/^delegate-message-[a-f0-9]{64}$/),
		});
	});

	it("routes public wait and wait_many actions through their event-driven control primitives", async () => {
		const waitForWorkerAgent = vi.fn(async () => ({ status: "idle" as const, timedOut: false }));
		const waitForWorkerAgents = vi.fn(async () => ({
			statuses: [
				{ agentId: "agent-a", status: "active" as const },
				{ agentId: "agent-b", status: "idle" as const },
			],
			updatedAgentIds: ["agent-b"],
			timedOut: false,
		}));
		const tool = createDelegateToolDefinition({
			caller: { kind: "worker", agentId: "caller" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({ waitForWorkerAgent, waitForWorkerAgents }),
		});

		await tool.execute(
			"wait-one",
			{ action: "wait", agentId: "agent-a", timeoutMs: 500 },
			undefined,
			undefined,
			context,
		);
		const many = await tool.execute(
			"wait-many",
			{ action: "wait_many", agentIds: ["agent-a", "agent-b"], mode: "any", timeoutMs: 1_000 },
			undefined,
			undefined,
			context,
		);

		expect(waitForWorkerAgent).toHaveBeenCalledWith("agent-a", 500, { callerAgentId: "caller" });
		expect(waitForWorkerAgents).toHaveBeenCalledWith(["agent-a", "agent-b"], "any", 1_000, {
			callerAgentId: "caller",
		});
		expect(JSON.parse(delegateText(many))).toEqual({
			statuses: [
				{ agentId: "agent-a", status: "active" },
				{ agentId: "agent-b", status: "idle" },
			],
			updatedAgentIds: ["agent-b"],
			timedOut: false,
		});
		expect(JSON.stringify(tool.parameters)).toContain("wait_many");
		expect(JSON.stringify(tool.parameters)).toContain("agentIds");
	});

	it("retains bounded worker-wait timeouts as nonterminal evidence without implying a stall", async () => {
		const waitForWorkerAgent = vi.fn(async () => ({ status: "active" as const, timedOut: true }));
		const waitForWorkerAgents = vi.fn(async () => ({
			statuses: [
				{ agentId: "agent-a", status: "active" as const },
				{ agentId: "agent-b", status: "active" as const },
			],
			updatedAgentIds: [],
			timedOut: true,
		}));
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({ waitForWorkerAgent, waitForWorkerAgents }),
		});

		const one = await tool.execute(
			"wait-one-timeout",
			{ action: "wait", agentId: "agent-a", timeoutMs: 300_000 },
			undefined,
			undefined,
			context,
		);
		const many = await tool.execute(
			"wait-many-timeout",
			{ action: "wait_many", agentIds: ["agent-a", "agent-b"], mode: "all", timeoutMs: 300_000 },
			undefined,
			undefined,
			context,
		);
		const onePayload = JSON.parse(delegateText(one)) as Record<string, unknown>;
		const manyPayload = JSON.parse(delegateText(many)) as Record<string, unknown>;

		for (const payload of [onePayload, manyPayload]) {
			expect(payload).toMatchObject({
				timedOut: true,
				waitState: "nonterminal",
				workerStallProven: false,
				reasonCode: "bounded_wait_elapsed",
			});
			expect(payload.nextAction).toContain("Never interrupt solely");
			expect(payload.cavemanDirective).toBe(
				"CAVEMAN MODE - MANDATORY: timeout is not failure. idle means finished/reusable; read transcript. active means continue or wait again. inbox never reports completion. Never claim stall, lost state, or missed completion from this result.",
			);
		}
		expect(one.details).toMatchObject({ action: "wait", timedOut: true });
		expect(many.details).toMatchObject({ action: "wait_many", timedOut: true });
	});

	it("reports an idle worker as completed after the deadline instead of still active", async () => {
		const waitForWorkerAgent = vi.fn(async () => ({ status: "idle" as const, timedOut: true }));
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({ waitForWorkerAgent }),
		});

		const result = await tool.execute(
			"wait-idle-after-timeout",
			{ action: "wait", agentId: "agent-a", timeoutMs: 300_000 },
			undefined,
			undefined,
			context,
		);
		const payload = JSON.parse(delegateText(result)) as Record<string, unknown>;

		expect(payload).toMatchObject({
			status: "idle",
			timedOut: true,
			waitState: "completed_after_timeout",
			workerStallProven: false,
			reasonCode: "bounded_wait_elapsed",
		});
		expect(payload.nextAction).toContain("now idle");
		expect(payload.nextAction).not.toContain("still running");
		expect(payload.cavemanDirective).toContain("idle means finished/reusable");
	});

	it("projects a non-timeout idle wait as terminal activity with mandatory claim retrieval", async () => {
		const waitForWorkerAgent = vi.fn(async () => ({ status: "idle" as const, timedOut: false }));
		const waitForWorkerAgents = vi.fn(async () => ({
			statuses: [
				{ agentId: "agent-a", status: "idle" as const },
				{ agentId: "agent-b", status: "idle" as const },
			],
			updatedAgentIds: ["agent-a", "agent-b"],
			timedOut: false,
		}));
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({ waitForWorkerAgent, waitForWorkerAgents }),
		});

		const one = await tool.execute(
			"wait-idle",
			{ action: "wait", agentId: "agent-a", timeoutMs: 300_000 },
			undefined,
			undefined,
			context,
		);
		const many = await tool.execute(
			"wait-many-idle",
			{ action: "wait_many", agentIds: ["agent-a", "agent-b"], mode: "all", timeoutMs: 300_000 },
			undefined,
			undefined,
			context,
		);

		for (const result of [one, many]) {
			const payload = JSON.parse(delegateText(result)) as Record<string, unknown>;
			expect(payload).toMatchObject({
				timedOut: false,
				waitState: "completed",
				workerStallProven: false,
				workerCompletionMissed: false,
				workerHarnessFailureProven: false,
				reasonCode: "worker_idle",
			});
			expect(payload.nextAction).toContain("every bounded transcript page");
			expect(payload.nextAction).toContain("delegate status");
			expect(payload.cavemanDirective).toContain("idle means task terminal and worker reusable");
			expect(payload.cavemanDirective).toContain("idle is activity, not the task outcome");
			expect(payload.cavemanDirective).toContain("status/transcript");
			expect(payload.cavemanDirective).toContain("not inbox");
			expect(payload.cavemanDirective).toContain(
				"Never claim missing completion, lost state, or harness failure from idle",
			);
		}
	});

	it("makes a mixed idle/active timeout impossible to promote into missed-completion evidence", async () => {
		const waitForWorkerAgents = vi.fn(async () => ({
			statuses: [
				{ agentId: "agent-a", status: "idle" as const },
				{ agentId: "agent-b", status: "active" as const },
			],
			updatedAgentIds: ["agent-a"],
			timedOut: true,
		}));
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({ waitForWorkerAgents }),
		});

		const result = await tool.execute(
			"wait-mixed-timeout",
			{ action: "wait_many", agentIds: ["agent-a", "agent-b"], mode: "all", timeoutMs: 300_000 },
			undefined,
			undefined,
			context,
		);
		const payload = JSON.parse(delegateText(result)) as Record<string, unknown>;

		expect(payload).toMatchObject({
			timedOut: true,
			waitState: "nonterminal",
			workerStallProven: false,
			updatedAgentIds: ["agent-a"],
		});
		expect(payload.cavemanDirective).toContain("idle means finished/reusable");
		expect(payload.cavemanDirective).toContain("active means continue or wait again");
		expect(payload.cavemanDirective).toContain("inbox never reports completion");
		expect(payload.cavemanDirective).toContain("Never claim stall, lost state, or missed completion");
	});

	it("bounds wait_many detail identities with explicit omission disclosure", async () => {
		const agentIds = Array.from(
			{ length: 64 },
			(_, index) => `agent-${index.toString().padStart(2, "0")}-${"x".repeat(500)}`,
		);
		const waitForWorkerAgents = vi.fn(async () => ({
			statuses: agentIds.map((agentId) => ({ agentId, status: "idle" as const })),
			updatedAgentIds: [],
			timedOut: false,
		}));
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({ waitForWorkerAgents }),
		});

		const result = await tool.execute(
			"wait-many-max-identities",
			{ action: "wait_many", agentIds, mode: "all" },
			undefined,
			undefined,
			context,
		);
		const details = result.details as DelegateToolDetails;
		const retainedAgentIds = details.agentIds ?? [];

		expect(Buffer.byteLength(JSON.stringify(details), "utf-8")).toBeLessThanOrEqual(16 * 1024);
		expect(retainedAgentIds.length).toBeGreaterThan(0);
		expect(retainedAgentIds.length).toBeLessThan(agentIds.length);
		expect(details.agentIdsOmitted).toBe(agentIds.length - retainedAgentIds.length);
		expect(retainedAgentIds).toEqual(agentIds.slice(0, retainedAgentIds.length));
	});

	it("broadcasts non-waking untrusted evidence with one replay-stable call identity and explicit partial results", async () => {
		const broadcastWorkerAgentMessage = vi.fn(
			(
				_agentIds: readonly string[],
				_message: string,
				_options: { senderAgentId?: string; threadId?: string; expectReply?: boolean; idempotencyKey: string },
			) => ({
				results: [
					{
						agentId: "peer-a",
						accepted: true as const,
						queued: true as const,
						replayed: false,
						messageId: "worker-message-a",
					},
					{ agentId: "ghost", accepted: false as const, error: "Unknown logical worker agent 'ghost'." },
				],
			}),
		);
		const tool = createDelegateToolDefinition({
			caller: { kind: "worker", agentId: "caller" },
			resolveMessageReplayScope: fixedReplayScope,
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({ broadcastWorkerAgentMessage }),
		});
		const input = {
			action: "broadcast" as const,
			agentIds: ["peer-a", "peer-a", "ghost"],
			message: "Compare this untrusted evidence.",
			threadId: "broadcast-thread",
		};

		const first = await tool.execute("broadcast-call", input, undefined, undefined, context);
		await tool.execute("broadcast-call", input, undefined, undefined, context);

		expect(broadcastWorkerAgentMessage).toHaveBeenCalledTimes(2);
		expect(broadcastWorkerAgentMessage).toHaveBeenNthCalledWith(
			1,
			["peer-a", "peer-a", "ghost"],
			"Compare this untrusted evidence.",
			{
				senderAgentId: "caller",
				threadId: "broadcast-thread",
				idempotencyKey: expect.stringMatching(/^delegate-message-[a-f0-9]{64}$/),
			},
		);
		expect(broadcastWorkerAgentMessage.mock.calls[1]?.[2]?.idempotencyKey).toBe(
			broadcastWorkerAgentMessage.mock.calls[0]?.[2]?.idempotencyKey,
		);
		expect(JSON.parse(delegateText(first))).toEqual({
			results: [
				expect.objectContaining({ agentId: "peer-a", accepted: true, queued: true }),
				{ agentId: "ghost", accepted: false, error: "Unknown logical worker agent 'ghost'." },
			],
		});
		expect(first.details).toMatchObject({ action: "broadcast", started: true, accepted: false, queued: true });
		expect(JSON.stringify(tool.parameters)).toContain("broadcast");
		expect([tool.description, ...(tool.promptGuidelines ?? [])].join(" ")).toContain(
			"untrusted coordination evidence",
		);
		expect([tool.description, ...(tool.promptGuidelines ?? [])].join(" ")).toContain("never authority");
	});

	it("rejects missing or oversized broadcast target sets before mailbox routing", async () => {
		const broadcastWorkerAgentMessage = vi.fn(() => ({ results: [] }));
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			resolveMessageReplayScope: fixedReplayScope,
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({ broadcastWorkerAgentMessage }),
		});

		const missing = await tool.execute(
			"broadcast-missing",
			{ action: "broadcast", message: "Evidence." },
			undefined,
			undefined,
			context,
		);
		const oversized = await tool.execute(
			"broadcast-oversized",
			{
				action: "broadcast",
				agentIds: Array.from({ length: MAX_ORCHESTRATION_COLLECTION_LENGTH + 1 }, (_, index) => `peer-${index}`),
				message: "Evidence.",
			},
			undefined,
			undefined,
			context,
		);

		expect(missing.details).toMatchObject({ started: false, skipReason: "missing_agent_ids" });
		expect(oversized.details).toMatchObject({ started: false, skipReason: "agent_ids_invalid" });
		expect(delegateText(oversized)).toContain(`through ${MAX_ORCHESTRATION_COLLECTION_LENGTH} entries`);
		expect(broadcastWorkerAgentMessage).not.toHaveBeenCalled();
	});

	it("rejects page sizes above the transcript owner's shared ceiling", async () => {
		const listWorkerAgents = vi.fn(() => []);
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({ listWorkerAgents }),
		});

		const result = await tool.execute(
			"page-oversized",
			{ action: "list", maxMessages: MAX_WORKER_TRANSCRIPT_PAGE_MESSAGES + 1 },
			undefined,
			undefined,
			context,
		);

		expect(result.details).toMatchObject({ started: false, skipReason: "page_size_invalid" });
		expect(listWorkerAgents).not.toHaveBeenCalled();
	});

	it("rejects oversized control payloads before invoking worker routing", async () => {
		const startWorkerDelegation = vi.fn(() => ({
			started: true as const,
			record: { laneId: "lane-1", type: "worker" as const, status: "queued" as const },
		}));
		const sendWorkerAgentMessage = vi.fn(() => ({ messageId: "message-1", queued: true as const }));
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			resolveMessageReplayScope: fixedReplayScope,
			startWorkerDelegation,
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({ sendWorkerAgentMessage }),
		});

		const oversizedStart = await tool.execute(
			"call",
			{ instructions: "x".repeat(16 * 1024 + 1) },
			undefined,
			undefined,
			context,
		);
		const oversizedSend = await tool.execute(
			"call",
			{ action: "send", agentId: "agent-1", message: "x".repeat(4_096 + 1) },
			undefined,
			undefined,
			context,
		);
		const oversizedAction = await tool.execute(
			"call",
			{ action: "x".repeat(17) as "start", instructions: "unused" },
			undefined,
			undefined,
			context,
		);

		expect(oversizedStart.details).toMatchObject({ started: false, skipReason: "instructions_too_long" });
		expect(oversizedSend.details).toMatchObject({ started: false, skipReason: "message_too_long" });
		expect(oversizedAction.details).toMatchObject({ started: false, skipReason: "invalid_action" });
		expect(startWorkerDelegation).not.toHaveBeenCalled();
		expect(sendWorkerAgentMessage).not.toHaveBeenCalled();
	});

	it("routes follow-up, interruption, resume, and terminal cancellation through the existing callbacks", async () => {
		const followUpSessionRootWorkerAgent = vi.fn(() => ({
			started: true,
			steering: true,
			messageId: "message-2",
		}));
		const interruptWorkerAgent = vi.fn(() => ({ interrupted: true }));
		const resumeWorkerAgent = vi.fn(() => ({ started: true }));
		const cancelWorkerAgent = vi.fn(() => ({
			laneId: "lane-1",
			type: "worker" as const,
			status: "canceled" as const,
		}));
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			resolveMessageReplayScope: fixedReplayScope,
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({
				followUpSessionRootWorkerAgent,
				interruptWorkerAgent,
				resumeWorkerAgent,
				cancelWorkerAgent,
			}),
		});

		await tool.execute(
			"call",
			{ action: "follow_up", agentId: "agent-1", message: "Continue" },
			undefined,
			undefined,
			context,
		);
		await tool.execute("call", { action: "interrupt", agentId: "agent-1" }, undefined, undefined, context);
		await tool.execute("call", { action: "resume", agentId: "agent-1" }, undefined, undefined, context);
		const cancelled = await tool.execute(
			"call",
			{ action: "cancel", agentId: "agent-1" },
			undefined,
			undefined,
			context,
		);

		expect(followUpSessionRootWorkerAgent).toHaveBeenCalledWith("agent-1", "Continue", {
			idempotencyKey: expect.stringMatching(/^delegate-message-[a-f0-9]{64}$/),
		});
		expect(interruptWorkerAgent).toHaveBeenCalledWith("agent-1");
		expect(resumeWorkerAgent).toHaveBeenCalledWith("agent-1");
		expect(cancelWorkerAgent).toHaveBeenCalledWith("agent-1");
		expect(cancelled.details).toMatchObject({ action: "cancel", agentId: "agent-1", status: "canceled" });
	});

	it("retires an eligible worker through caller-scoped durable control", async () => {
		const retireWorkerAgent = vi.fn(() => ({
			agent: {
				agentId: "agent-2",
				parentAgentId: "agent-1",
				rootAgentId: "agent-1",
				depth: 1,
				role: "explorer" as const,
				status: "retired" as const,
				activity: "idle" as const,
				controllable: true,
				createdAt: "T0",
				updatedAt: "T1",
			},
			retired: true as const,
			replayed: false,
		}));
		const tool = createDelegateToolDefinition({
			caller: { kind: "worker", agentId: "agent-1" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({ retireWorkerAgent }),
		});

		const retired = await tool.execute(
			"retire-call",
			{ action: "retire", agentId: "agent-2" },
			undefined,
			undefined,
			context,
		);

		expect(retireWorkerAgent).toHaveBeenCalledWith("agent-2", { callerAgentId: "agent-1" });
		expect(delegateText(retired)).toContain("binding and transcript retained");
		expect(retired.details).toMatchObject({
			started: true,
			action: "retire",
			agentId: "agent-2",
			accepted: true,
			replayed: false,
		});
		expect(JSON.stringify(tool.parameters)).toContain("retire");
	});

	it("turns a thrown control callback into a bounded typed tool result", async () => {
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			resolveMessageReplayScope: fixedReplayScope,
			startWorkerDelegation: () => {
				throw new Error(`synthetic failure ${"x".repeat(32_000)}`);
			},
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
		});

		const result = await tool.execute("call", { instructions: "Inspect" }, undefined, undefined, context);
		const content = result.content.find(
			(item): item is Extract<(typeof result.content)[number], { type: "text" }> => item.type === "text",
		);

		expect(result.details).toMatchObject({
			started: false,
			action: "start",
			skipReason: "worker_agent_control_error",
		});
		expect(content?.text.length).toBeLessThanOrEqual(2_048);
		expect(content?.text).toContain("synthetic failure");
	});

	it("bounds synchronous worker claims before returning them to model context", async () => {
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: async () => ({
				started: true,
				record: { laneId: "lane-1", type: "worker", status: "succeeded" },
				outcome: {
					claim: {
						requestId: "lane-1",
						status: "completed",
						summary: `bounded marker ${"s".repeat(64_000)}`,
						changedFiles: [],
						blockers: Array.from({ length: 100 }, (_, index) => `blocker-${index}-${"b".repeat(1_000)}`),
						evidence: {
							query: "worker:lane-1",
							sources: [],
							findings: Array.from({ length: 100 }, (_, index) => ({
								id: `finding-${index}`,
								summary: `finding-${index}-${"f".repeat(1_000)}`,
								evidenceIds: [],
							})),
						},
					},
					acceptance: { outcome: "allow", gate: "test", reasonCode: "accepted" },
					accepted: true,
					laneStatus: "succeeded",
					reasonCode: "completed",
					costUsd: 0,
				},
			}),
		});

		const result = await tool.execute("call", { instructions: "Inspect" }, undefined, undefined, context);
		const content = result.content.find(
			(item): item is Extract<(typeof result.content)[number], { type: "text" }> => item.type === "text",
		);
		const details = result.details as DelegateToolDetails;

		expect(content?.text.length).toBeLessThanOrEqual(16 * 1024);
		expect(content?.text).toContain("bounded marker");
		expect(details.summary?.length).toBeLessThanOrEqual(8_000);
		expect(details.blockers?.length).toBeLessThanOrEqual(16);
	});
});

describe("delegate wait and status", () => {
	it("requires a logical agent id and waits through the event-driven callback without polling", async () => {
		const waitForWorkerAgent = vi.fn(async () => ({ status: "idle" as const, timedOut: false }));
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({ waitForWorkerAgent }),
		});

		const missing = await tool.execute("call", { action: "wait" }, undefined, undefined, context);
		expect(missing.content).toEqual([{ type: "text", text: "delegate wait requires agentId" }]);
		expect(waitForWorkerAgent).not.toHaveBeenCalled();

		const result = await tool.execute(
			"call",
			{ action: "wait", agentId: "agent-1", timeoutMs: 1_000 },
			undefined,
			undefined,
			context,
		);
		expect(waitForWorkerAgent).toHaveBeenCalledWith("agent-1", 1_000);
		expect(result.details).toMatchObject({ started: true, action: "wait", agentId: "agent-1" });
		expect(tool.description).toContain("event-driven");
		expect(tool.description).toContain("Do not poll");
	});

	it("rejects oversized control identities before waiting or rendering them", async () => {
		const waitForWorkerAgent = vi.fn(async () => ({ status: "idle" as const, timedOut: false }));
		const acknowledgeWorkerReview = vi.fn(() => ({
			ok: true as const,
			requestId: "unused",
			reviewedAt: "2026-07-27T00:00:00.000Z",
		}));
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({ waitForWorkerAgent }),
			status: {
				getLaneRecords: () => [],
				getWorkerClaimSnapshots: () => [],
				acknowledgeWorkerReview,
			},
		});

		const oversizedAgentId = "a".repeat(513);
		const oversizedLaneId = "l".repeat(513);
		const wait = await tool.execute(
			"call",
			{ action: "wait", agentId: oversizedAgentId },
			undefined,
			undefined,
			context,
		);
		const review = await tool.execute(
			"call",
			{ action: "review", laneId: oversizedLaneId },
			undefined,
			undefined,
			context,
		);

		expect(wait.details).toMatchObject({ started: false, action: "wait", skipReason: "agent_id_too_long" });
		expect(review.details).toMatchObject({ kind: "review", reviewed: false, reason: "invalid_lane_id" });
		expect(waitForWorkerAgent).not.toHaveBeenCalled();
		expect(acknowledgeWorkerReview).not.toHaveBeenCalled();
	});

	it("bounds sticky unreviewed identities and rendered history for long sessions", async () => {
		const records = Array.from({ length: 200 }, (_, index) => ({
			laneId: `lane-${index}`,
			type: "worker" as const,
			status: "succeeded" as const,
		}));
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			status: {
				getLaneRecords: () => records,
				getWorkerClaimSnapshots: () =>
					records.map((record) => ({
						requestId: record.laneId,
						status: "completed" as const,
						summary: `claim-${record.laneId}-${"x".repeat(8_000)}`,
						changedFiles: [],
						parentReviewRequired: true,
					})),
			},
		});

		const result = await tool.execute("call", { action: "status" }, undefined, undefined, context);
		const content = result.content.find(
			(item): item is Extract<(typeof result.content)[number], { type: "text" }> => item.type === "text",
		);
		const details = result.details as DelegateStatusToolDetails;

		expect(content?.text.length).toBeLessThanOrEqual(16 * 1024);
		expect(details.unreviewedCount).toBe(200);
		expect(details.unreviewedLaneIds?.length).toBeLessThanOrEqual(64);
		expect(details.lanes?.length).toBeLessThanOrEqual(20);
	});

	it("forwards bounded recursive action start for an admitted worker", async () => {
		const startWorkerDelegation = vi.fn(() => ({
			started: true as const,
			record: { laneId: "nested-lane", type: "worker" as const, status: "queued" as const },
		}));
		const tool = createDelegateToolDefinition({
			caller: { kind: "worker", agentId: "worker-1" },
			startWorkerDelegation,
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
		});

		const result = await tool.execute(
			"call",
			{ action: "start", instructions: "Nested delegation" },
			undefined,
			undefined,
			context,
		);
		expect(startWorkerDelegation).toHaveBeenCalledOnce();
		expect(startWorkerDelegation).toHaveBeenCalledWith({ instructions: "Nested delegation" });
		expect(result.details).toMatchObject({ started: true, agentId: "nested-lane", status: "queued" });
	});
});

describe("delegate persistent worker reuse", () => {
	it("uses one leaf-scoped host key for exact start replay and a distinct key on a new leaf", async () => {
		let leafId = "leaf-a";
		const replayContext = {
			sessionManager: {
				getSessionId: () => "session-1",
				getLeafId: () => leafId,
			},
		} as unknown as ExtensionContext;
		const admitted = new Map<
			string,
			{
				started: true;
				steering: false;
				messageId: string;
				record: { laneId: string; type: "worker"; status: "queued" };
			}
		>();
		const startWorkerAgentTask = vi.fn(
			(_agentId: string, _message: string, options?: { idempotencyKey?: string }) => {
				const idempotencyKey = options?.idempotencyKey;
				if (!idempotencyKey) {
					return {
						started: false as const,
						steering: false as const,
						messageId: "",
						skipReason: "missing_idempotency_key",
					};
				}
				const replay = admitted.get(idempotencyKey);
				if (replay) return replay;
				const sequence = admitted.size + 1;
				const accepted = {
					started: true as const,
					steering: false as const,
					messageId: `message-${sequence}`,
					record: { laneId: `task-${sequence}`, type: "worker" as const, status: "queued" as const },
				};
				admitted.set(idempotencyKey, accepted);
				return accepted;
			},
		);
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			resolveMessageReplayScope: () => ({ sessionId: "session-1", branchId: leafId }),
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({ startWorkerAgentTask }),
		});
		const input = { action: "start" as const, agentId: "worker-1", instructions: "Audit replay" };

		const first = await tool.execute("reused-tool-call", input, undefined, undefined, replayContext);
		const replay = await tool.execute("reused-tool-call", input, undefined, undefined, replayContext);
		leafId = "leaf-b";
		const nextLeaf = await tool.execute("reused-tool-call", input, undefined, undefined, replayContext);

		expect(first.details).toMatchObject({ started: true, laneId: "task-1" });
		expect(replay.details).toMatchObject({ started: true, laneId: "task-1" });
		expect(nextLeaf.details).toMatchObject({ started: true, laneId: "task-2" });
		const firstKey = startWorkerAgentTask.mock.calls[0]?.[2]?.idempotencyKey;
		const replayKey = startWorkerAgentTask.mock.calls[1]?.[2]?.idempotencyKey;
		const nextLeafKey = startWorkerAgentTask.mock.calls[2]?.[2]?.idempotencyKey;
		expect(firstKey).toMatch(/^delegate-message-[a-f0-9]{64}$/);
		expect(replayKey).toBe(firstKey);
		expect(nextLeafKey).not.toBe(firstKey);
	});

	it("dispatches a new task onto an idle worker's persistent context instead of minting a fresh agent", async () => {
		const startWorkerDelegation = vi.fn(() => ({
			started: true as const,
			record: { laneId: "fresh-lane", type: "worker" as const, status: "queued" as const },
		}));
		const startWorkerAgentTask = vi.fn(() => ({
			started: true,
			steering: false as const,
			messageId: "m1",
			record: { laneId: "task-2", type: "worker" as const, status: "queued" as const },
		}));
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			resolveMessageReplayScope: fixedReplayScope,
			startWorkerDelegation,
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({
				startWorkerAgentTask,
			}),
		});

		const result = await tool.execute(
			"call",
			{ action: "start", agentId: "worker-1", instructions: "Now audit SysMain too" },
			undefined,
			undefined,
			context,
		);
		expect(startWorkerAgentTask).toHaveBeenCalledWith(
			"worker-1",
			"Now audit SysMain too",
			expect.objectContaining({ idempotencyKey: expect.stringMatching(/^delegate-message-[a-f0-9]{64}$/) }),
		);
		expect(startWorkerDelegation).not.toHaveBeenCalled();
		expect(result.details).toMatchObject({
			started: true,
			action: "start",
			agentId: "worker-1",
			laneId: "task-2",
			queued: true,
		});
	});

	it("surfaces durable retirement as exact agent_retired while an idle identity remains reusable", async () => {
		const startWorkerDelegation = vi.fn(() => ({
			started: true as const,
			record: { laneId: "fresh-lane", type: "worker" as const, status: "queued" as const },
		}));
		const runWorkerDelegation = vi.fn(async () => ({ started: false as const, skipReason: "provider_must_not_run" }));
		const startWorkerAgentTask = vi.fn((agentId: string) => {
			if (agentId === "retired-worker") {
				return {
					started: false as const,
					steering: false as const,
					messageId: "",
					skipReason: "agent_retired",
				};
			}
			return {
				started: true as const,
				steering: false as const,
				messageId: "idle-message",
				record: { laneId: "idle-task", type: "worker" as const, status: "queued" as const },
			};
		});
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			resolveMessageReplayScope: fixedReplayScope,
			startWorkerDelegation,
			runWorkerDelegation,
			workerAgentControl: workerAgentControl({ startWorkerAgentTask }),
		});

		const retired = await tool.execute(
			"retired-start",
			{ action: "start", agentId: "retired-worker", instructions: "Must not restart" },
			undefined,
			undefined,
			context,
		);

		expect(retired.details).toEqual({
			started: false,
			action: "start",
			agentId: "retired-worker",
			skipReason: "agent_retired",
		});
		expect(delegateText(retired)).toBe("delegate start could not reuse worker retired-worker: agent_retired");
		expect(startWorkerAgentTask).toHaveBeenCalledOnce();
		expect(startWorkerDelegation).not.toHaveBeenCalled();
		expect(runWorkerDelegation).not.toHaveBeenCalled();

		const idle = await tool.execute(
			"idle-start",
			{ action: "start", agentId: "idle-worker", instructions: "Continue" },
			undefined,
			undefined,
			context,
		);

		expect(idle.details).toMatchObject({
			started: true,
			action: "start",
			agentId: "idle-worker",
			laneId: "idle-task",
			accepted: true,
		});
		expect(startWorkerAgentTask).toHaveBeenCalledTimes(2);
		expect(startWorkerDelegation).not.toHaveBeenCalled();
		expect(runWorkerDelegation).not.toHaveBeenCalled();
	});

	it("reports terminal replay and wake-pending reuse as durable acceptance", async () => {
		const cases = [
			{
				name: "terminal replay",
				outcome: {
					started: false,
					steering: false as const,
					messageId: "message-terminal",
					record: { laneId: "task-terminal", type: "worker" as const, status: "succeeded" as const },
					skipReason: "worker_task_terminal_completed",
				},
				queued: false,
			},
			{
				name: "wake pending",
				outcome: {
					started: false,
					steering: false as const,
					messageId: "message-pending",
					skipReason: "worker_task_waiting_for_older_message",
				},
				queued: true,
			},
		] as const;

		for (const entry of cases) {
			const tool = createDelegateToolDefinition({
				caller: { kind: "session_root" },
				resolveMessageReplayScope: fixedReplayScope,
				runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
				workerAgentControl: workerAgentControl({ startWorkerAgentTask: () => entry.outcome }),
			});
			const result = await tool.execute(
				`call-${entry.name}`,
				{ action: "start", agentId: "worker-1", instructions: "replayed task" },
				undefined,
				undefined,
				context,
			);

			expect(result.details).toMatchObject({
				started: true,
				accepted: true,
				messageId: entry.outcome.messageId,
				skipReason: entry.outcome.skipReason,
				queued: entry.queued,
			});
			expect(result.content).toEqual([
				expect.objectContaining({ type: "text", text: expect.stringContaining(entry.outcome.skipReason) }),
			]);
		}
	});

	it("rejects reuse of a busy or unknown worker with an explicit reason", async () => {
		let reuseCalls = 0;
		const startWorkerDelegation = vi.fn(() => ({
			started: true as const,
			record: { laneId: "fresh", type: "worker" as const, status: "queued" as const },
		}));
		const makeTool = (status: "active" | "suspended" | "unknown") =>
			createDelegateToolDefinition({
				caller: { kind: "session_root" },
				resolveMessageReplayScope: fixedReplayScope,
				startWorkerDelegation,
				runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
				workerAgentControl: workerAgentControl({
					startWorkerAgentTask: () => {
						reuseCalls += 1;
						return {
							started: false,
							steering: false,
							messageId: "",
							skipReason: status === "unknown" ? "unknown_agent" : `worker_${status}`,
						};
					},
				}),
			});

		const busy = await makeTool("active").execute(
			"call",
			{ action: "start", agentId: "worker-1", instructions: "task" },
			undefined,
			undefined,
			context,
		);
		expect(busy.details).toMatchObject({ started: false, skipReason: "worker_active" });

		const unknown = await makeTool("unknown").execute(
			"call",
			{ action: "start", agentId: "ghost", instructions: "task" },
			undefined,
			undefined,
			context,
		);
		expect(unknown.details).toMatchObject({ started: false, skipReason: "unknown_agent" });
		const unknownText = delegateText(unknown);
		expect(unknownText).toContain("CAVEMAN MODE - MANDATORY");
		expect(unknownText).toContain("unknown_agent means no reusable worker was found");
		expect(unknownText).toContain("not lost worker state or harness failure");
		expect(unknownText).toContain("No worker started; nothing was dropped");
		expect(unknownText).toContain("Retry once now without agentId");
		expect(unknownText).toContain("keep instructions unchanged");
		expect(unknownText).toContain("authority/profileId only on that fresh start");
		expect(unknownText).toContain("use an exact returned agentId; never invent one");
		expect(reuseCalls).toBe(2);
		expect(startWorkerDelegation).not.toHaveBeenCalled();
	});

	it("atomically admits only one of two concurrent starts for the same idle agent", async () => {
		let active = false;
		const startWorkerAgentTask = vi.fn(() => {
			if (active) {
				return { started: false, steering: false as const, messageId: "", skipReason: "worker_active" };
			}
			active = true;
			return {
				started: true,
				steering: false as const,
				messageId: "message-first",
				record: { laneId: "task-first", type: "worker" as const, status: "queued" as const },
			};
		});
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			resolveMessageReplayScope: fixedReplayScope,
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({ startWorkerAgentTask }),
		});

		const [first, second] = await Promise.all([
			tool.execute(
				"call",
				{ action: "start", agentId: "worker-1", instructions: "first task" },
				undefined,
				undefined,
				context,
			),
			tool.execute(
				"call",
				{ action: "start", agentId: "worker-1", instructions: "second task" },
				undefined,
				undefined,
				context,
			),
		]);

		expect(first.details).toMatchObject({ started: true, laneId: "task-first" });
		expect(second.details).toMatchObject({ started: false, skipReason: "worker_active" });
		expect(startWorkerAgentTask).toHaveBeenCalledTimes(2);
	});

	it("auto-sanitizes redundant authority/profileId parameters on delegate start with agentId reuse", async () => {
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			resolveMessageReplayScope: fixedReplayScope,
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({
				startWorkerAgentTask: () => ({
					started: true,
					steering: false,
					messageId: "msg",
					record: { laneId: "lane", type: "worker", status: "queued" },
				}),
			}),
		});
		const result = await tool.execute(
			"call",
			{
				action: "start",
				agentId: "worker-1",
				instructions: "task",
				authority: { role: "implementer" },
			},
			undefined,
			undefined,
			context,
		);
		expect(result.details).toMatchObject({ started: true, agentId: "worker-1" });
	});

	it("rejects a bypassed model-authored budget before persistent-agent reuse", async () => {
		const startWorkerAgentTask = vi.fn(() => ({
			started: true,
			steering: false as const,
			messageId: "msg",
			record: { laneId: "lane", type: "worker" as const, status: "queued" as const },
		}));
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			resolveMessageReplayScope: fixedReplayScope,
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({ startWorkerAgentTask }),
		});
		const result = await tool.execute(
			"call",
			{
				action: "start",
				agentId: "worker-1",
				instructions: "task",
				authority: { budget: { maxTokens: 8_000 } },
			} as never,
			undefined,
			undefined,
			context,
		);

		expect(result.details).toMatchObject({ started: false, skipReason: "authority_budget_forbidden" });
		expect(startWorkerAgentTask).not.toHaveBeenCalled();
	});

	it("reports live activity per agent in list so idle workers are discoverable", async () => {
		const waitForWorkerAgent = vi.fn(async () => ({ status: "active" as const, timedOut: false }));
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerAgentControl({
				listWorkerAgents: () => [
					{
						agentId: "worker-1",
						rootAgentId: "worker-1",
						depth: 0,
						role: "implementer",
						status: "registered",
						activity: "idle",
						controllable: true,
						createdAt: "T0",
						updatedAt: "T0",
					},
					{
						agentId: "worker-2",
						rootAgentId: "worker-2",
						depth: 0,
						role: "explorer",
						status: "active",
						activity: "active",
						controllable: true,
						createdAt: "T1",
						updatedAt: "T1",
					},
				],
				waitForWorkerAgent,
			}),
		});
		const result = await tool.execute("call", { action: "list" }, undefined, undefined, context);
		const textItem = result.content.find(
			(item): item is Extract<typeof item, { type: "text" }> => item.type === "text",
		);
		const payload = JSON.parse(textItem?.text ?? "{}");
		expect(payload.agents).toEqual([
			expect.objectContaining({ agentId: "worker-1", activity: "idle" }),
			expect.objectContaining({ agentId: "worker-2", activity: "active" }),
		]);
		expect(waitForWorkerAgent).not.toHaveBeenCalled();
	});

	it("bounds every collection-shaped worker control response by UTF-8 bytes with explicit omissions", async () => {
		const agentIds = Array.from(
			{ length: 64 },
			(_, index) => `agent-${index.toString().padStart(2, "0")}-${"界".repeat(160)}`,
		);
		const agents = agentIds.map((agentId, index) => ({
			agentId,
			rootAgentId: agentId,
			depth: 0,
			role: "explorer" as const,
			status: "registered" as const,
			activity: "idle" as const,
			controllable: true,
			createdAt: `T${index}`,
			updatedAt: `T${index}`,
		}));
		const tasks = Array.from({ length: 64 }, (_, index) => ({
			taskId: `task-${index}`,
			title: "界".repeat(1_000),
			role: "explorer" as const,
			status: "ready" as const,
			dependsOn: [] as const,
		}));
		const workerControl = workerAgentControl({
			listWorkerAgents: () => agents,
			getWorkerTaskSessionView: () => ({ totalTasks: 100, omittedTaskCount: 36, tasks }),
			waitForWorkerAgents: async () => ({
				statuses: agentIds.map((agentId) => ({ agentId, status: "idle" as const })),
				updatedAgentIds: agentIds,
				timedOut: false,
			}),
			broadcastWorkerAgentMessage: () => ({
				results: agentIds.map((agentId) => ({ agentId, accepted: false as const, error: "界".repeat(160) })),
			}),
		});
		const tool = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			resolveMessageReplayScope: fixedReplayScope,
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
			workerAgentControl: workerControl,
		});

		const results = [
			await tool.execute("tasks-bound", { action: "tasks" }, undefined, undefined, context),
			await tool.execute(
				"list-bound",
				{ action: "list", maxMessages: MAX_WORKER_TRANSCRIPT_PAGE_MESSAGES },
				undefined,
				undefined,
				context,
			),
			await tool.execute(
				"wait-bound",
				{ action: "wait_many", agentIds, mode: "all" },
				undefined,
				undefined,
				context,
			),
			await tool.execute(
				"broadcast-bound",
				{ action: "broadcast", agentIds, message: "bounded evidence" },
				undefined,
				undefined,
				context,
			),
		];

		for (const result of results) {
			const text = delegateText(result);
			expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(16 * 1024);
			const payload = JSON.parse(text) as { omittedCount?: number; omittedTaskCount?: number };
			expect(payload.omittedCount ?? payload.omittedTaskCount).toBeGreaterThan(0);
		}
	});
});
