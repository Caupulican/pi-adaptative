import type { SessionManager } from "@caupulican/pi-agent-core/node";
import { SessionManager as InMemorySessionManager } from "@caupulican/pi-agent-core/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackgroundLaneController, type BackgroundLaneControllerDeps } from "../src/core/background-lane-controller.ts";
import type { ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { buildGoalRuntimeSnapshot } from "../src/core/goals/goal-runtime-snapshot.ts";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import {
	type CollaborationDispatchDeps,
	dispatchCollaborationWorker,
} from "../src/core/tools/collaboration-dispatch.ts";
import { createTestManagedLaneDispatch } from "./managed-lane-fixture.ts";

/**
 * SPIKE/REPRO-FIRST: proves the WHOLE goal->collaboration dispatch loop end-to-end with a
 * FAUX `pi_collaboration` tool (no real collaboration) driving a REAL `BackgroundLaneController` -- the
 * adapter's correlation (`resolveManagedLaneId`), the goal reducer's binding, and the existing
 * "waiting"/resume continuation machinery are all exercised for real, only the extension's collaboration
 * side effects (panes and sessions) are faked.
 */

function buildLaneControllerDeps(overrides: Partial<BackgroundLaneControllerDeps> = {}): BackgroundLaneControllerDeps {
	const sessionManager =
		(overrides.getSessionManager?.() as SessionManager | undefined) ?? InMemorySessionManager.inMemory();
	return {
		isDisposed: () => false,
		getSessionId: () => sessionManager.getSessionId(),
		getCwd: () => "/repo",
		getAgentDir: () => "/tmp/pi-test-collaboration-dispatch-adapter",
		getSessionManager: () => sessionManager,
		getGoalStateSnapshot: () => undefined,
		getCapabilityEnvelope: () => undefined,
		saveWorkerClaimSnapshot: () => "worker-claim-entry",
		...overrides,
	} as unknown as BackgroundLaneControllerDeps;
}

const fauxCtx = { signal: undefined } as unknown as ExtensionContext;
afterEach(() => vi.unstubAllGlobals());

function fauxCollaborationTool(
	execute: ToolDefinition["execute"],
	guard: { allowed: boolean; isError?: boolean; onCall?: () => void } = { allowed: true },
): ToolDefinition {
	return {
		name: "pi_collaboration",
		label: "pi_collaboration",
		description: "faux pi_collaboration for the dispatch-adapter spike",
		parameters: {} as ToolDefinition["parameters"],
		execute(toolCallId, params, signal, onUpdate, ctx) {
			if ((params as { action?: string }).action === "guard") {
				guard.onCall?.();
				return Promise.resolve({
					content: [
						{
							type: "text" as const,
							text: guard.allowed ? "collaboration is available" : "collaboration is unavailable",
						},
					],
					details: { action: "guard", guard: { allowed: guard.allowed } },
					isError: guard.isError,
				});
			}
			return execute(toolCallId, params, signal, onUpdate, ctx);
		},
	};
}

describe("dispatchCollaborationWorker (faux collaboration tool end-to-end, real BackgroundLaneController)", () => {
	it("autonomous profiled dispatch: single pi agent, boundLaneId is the caller-stable durable id; goal waits then resumes on terminal", async () => {
		const sessionManager = InMemorySessionManager.inMemory();
		const blc = new BackgroundLaneController(buildLaneControllerDeps({ getSessionManager: () => sessionManager }));

		let capturedParams: unknown;
		const toolDef = fauxCollaborationTool(async (_toolCallId, params) => {
			capturedParams = params;
			// The REAL bridge mechanism: the extension reports its dispatch under ITS OWN
			// caller-chosen laneId (collaboration:<jobId>:<agentId>), which mints a genuine collaboration-worker lane.
			blc.recordManagedLane({
				laneId: "collaboration:job1:goal-worker-1",
				phase: "dispatch",
				goalId: "g1",
				dispatch: createTestManagedLaneDispatch(),
			});
			return {
				content: [{ type: "text" as const, text: "launched" }],
				details: { job: { id: "job1", agents: [{ id: "goal-worker-1" }] } },
			};
		});

		const deps: CollaborationDispatchDeps = {
			getToolDefinition: (name) => (name === "pi_collaboration" ? toolDef : undefined),
			createExtensionContext: () => fauxCtx,
			resolveManagedLaneId: (id) => blc.resolveManagedLaneId(id),
			getGoalId: () => "g1",
		};

		const outcome = await dispatchCollaborationWorker(deps, { requirementId: "req-1", instructions: "do it" });
		expect(outcome.skipReason).toBeUndefined();
		expect(outcome.laneId).toBe("collaboration:job1:goal-worker-1");

		// Single-agent params: never the 3-agent DEFAULT_AGENT_PROVIDERS fallback.
		const params = capturedParams as { action: string; agents: Array<{ provider: string; name: string }> };
		expect(params.action).toBe("fire_task");
		expect(params.agents).toHaveLength(1);
		expect(params.agents[0]).toEqual({ provider: "pi", name: "goal-worker" });

		// Drive the goal exactly like goal.ts's dispatch_worker branch: merge the adapter's laneId
		// onto the dispatch_worker event.
		let goalState = createGoalState({ goalId: "g1", userGoal: "Ship it", now: "T0" });
		goalState = applyGoalEvent(goalState, { type: "add_requirement", id: "req-1", text: "Do it", now: "T0" });
		goalState = applyGoalEvent(goalState, {
			type: "dispatch_worker",
			id: "req-1",
			instructions: "do it",
			laneId: outcome.laneId,
			now: "T1",
		});
		expect(goalState.requirements.find((r) => r.id === "req-1")?.boundLaneId).toBe(
			"collaboration:job1:goal-worker-1",
		);
		appendGoalStateSnapshot(sessionManager, goalState);

		const whileRunning = buildGoalRuntimeSnapshot({
			sessionManager,
			settings: { maxStallTurns: 20 },
			laneRecords: blc.getLaneRecords(),
		});
		expect(whileRunning.continuation.action).toBe("waiting");
		expect(whileRunning.continuation.reasonCode).toBe("worker_in_flight");

		// The faux terminal handoff.
		blc.recordManagedLane({ laneId: "collaboration:job1:goal-worker-1", phase: "terminal", status: "done" });

		const afterTerminal = buildGoalRuntimeSnapshot({
			sessionManager,
			settings: { maxStallTurns: 20 },
			laneRecords: blc.getLaneRecords(),
		});
		expect(afterTerminal.continuation.action).not.toBe("waiting");
	});

	it("extension-not-loaded: getToolDefinition undefined -> honest skip, no crash", async () => {
		const deps: CollaborationDispatchDeps = {
			getToolDefinition: () => undefined,
			createExtensionContext: () => fauxCtx,
			resolveManagedLaneId: () => undefined,
			getGoalId: () => "g1",
		};

		const outcome = await dispatchCollaborationWorker(deps, { requirementId: "req-1", instructions: "do it" });
		expect(outcome.skipReason).toBe("collaboration_extension_not_loaded");
		expect(outcome.laneId).toBeUndefined();
	});

	it("native Windows reaches the backend guard and dispatches when that backend permits it", async () => {
		let toolLookedUp = false;
		let contextCreated = false;
		let worktreeCreated = false;
		vi.stubGlobal("process", { ...process, platform: "win32" });
		const deps: CollaborationDispatchDeps = {
			getToolDefinition: () => {
				toolLookedUp = true;
				return fauxCollaborationTool(async () => ({
					content: [],
					details: { job: { id: "job1", agents: [{ id: "goal-worker-1" }] } },
				}));
			},
			createExtensionContext: () => {
				contextCreated = true;
				return fauxCtx;
			},
			resolveManagedLaneId: (laneId: string) => laneId,
			getGoalId: () => "g1",
			createLaneWorktree: async () => {
				worktreeCreated = true;
				return { laneKey: "g1-1", worktreePath: "/repo/.worktrees/g1-1" };
			},
		};

		const outcome = await dispatchCollaborationWorker(deps, { requirementId: "req-1", instructions: "do it" });

		expect(outcome).toEqual({ laneId: "collaboration:job1:goal-worker-1" });
		expect(toolLookedUp).toBe(true);
		expect(contextCreated).toBe(true);
		expect(worktreeCreated).toBe(true);
	});

	it("guards collaboration availability before creating a worktree or launching a pane", async () => {
		const actions: string[] = [];
		let worktreeCreated = false;
		const toolDef = fauxCollaborationTool(
			async (_toolCallId, params) => {
				actions.push((params as { action: string }).action);
				return { content: [], details: {} };
			},
			{ allowed: false, onCall: () => actions.push("guard") },
		);
		const deps: CollaborationDispatchDeps = {
			getToolDefinition: () => toolDef,
			createExtensionContext: () => fauxCtx,
			resolveManagedLaneId: () => undefined,
			getGoalId: () => "g1",
			createLaneWorktree: async () => {
				worktreeCreated = true;
				return { laneKey: "g1-1", worktreePath: "/repo/.worktrees/g1-1" };
			},
		};

		const outcome = await dispatchCollaborationWorker(deps, { requirementId: "req-1", instructions: "do it" });

		expect(outcome).toEqual({ skipReason: "collaboration_unavailable" });
		expect(actions).toEqual(["guard"]);
		expect(worktreeCreated).toBe(false);
	});

	it("a launch failure classifies as collaboration_dispatch_failed -- still an honest surfaced skip, never a crash", async () => {
		const toolDef = fauxCollaborationTool(async () => {
			throw new Error("collaboration session already exists: pi-agents-x. Use stop_job/stop_session first.");
		});
		const deps: CollaborationDispatchDeps = {
			getToolDefinition: () => toolDef,
			createExtensionContext: () => fauxCtx,
			resolveManagedLaneId: () => undefined,
			getGoalId: () => "g1",
		};

		const outcome = await dispatchCollaborationWorker(deps, { requirementId: "req-1", instructions: "do it" });
		expect(outcome.skipReason).toBe("collaboration_dispatch_failed");
		expect(outcome.laneId).toBeUndefined();
	});
	it("an errored guard cannot authorize a launch even when its details say allowed", async () => {
		const launch = vi.fn(async () => ({ content: [], details: {} }));
		const createLaneWorktree = vi.fn(async () => ({ laneKey: "g1-1", worktreePath: "/repo/.worktrees/g1-1" }));
		const outcome = await dispatchCollaborationWorker(
			{
				getToolDefinition: () => fauxCollaborationTool(launch, { allowed: true, isError: true }),
				createExtensionContext: () => fauxCtx,
				resolveManagedLaneId: (laneId) => laneId,
				getGoalId: () => "g1",
				createLaneWorktree,
			},
			{ requirementId: "req-1", instructions: "do it" },
		);
		expect(outcome).toEqual({ skipReason: "collaboration_unavailable" });
		expect(launch).not.toHaveBeenCalled();
		expect(createLaneWorktree).not.toHaveBeenCalled();
	});
	it.each([
		{ isError: true, agents: [{ id: "goal-worker-1" }], reason: "collaboration_dispatch_failed" },
		{
			isError: false,
			agents: [{ id: "goal-worker-1" }, { id: "unexpected-worker" }],
			reason: "collaboration_dispatch_incomplete",
		},
	])("rejects an invalid launch projection: $reason", async ({ isError, agents, reason }) => {
		const correlate = vi.fn((laneId: string) => laneId);
		const outcome = await dispatchCollaborationWorker(
			{
				getToolDefinition: () =>
					fauxCollaborationTool(async () => ({ content: [], isError, details: { job: { id: "job1", agents } } })),
				createExtensionContext: () => fauxCtx,
				resolveManagedLaneId: correlate,
				getGoalId: () => "g1",
			},
			{ requirementId: "req-1", instructions: "do it" },
		);
		expect(outcome).toEqual({ skipReason: reason });
		expect(correlate).not.toHaveBeenCalled();
	});

	it("collaboration_dispatch_incomplete when the result carries no job/agents", async () => {
		const toolDef = fauxCollaborationTool(async () => ({ content: [], details: {} }));
		const deps: CollaborationDispatchDeps = {
			getToolDefinition: () => toolDef,
			createExtensionContext: () => fauxCtx,
			resolveManagedLaneId: () => undefined,
			getGoalId: () => "g1",
		};

		const outcome = await dispatchCollaborationWorker(deps, { requirementId: "req-1", instructions: "do it" });
		expect(outcome.skipReason).toBe("collaboration_dispatch_incomplete");
	});

	it("lane_correlation_failed when the dispatch was not registered under its stable lane id", async () => {
		const toolDef = fauxCollaborationTool(async () => ({
			content: [],
			details: { job: { id: "job1", agents: [{ id: "goal-worker-1" }] } },
		}));
		const deps: CollaborationDispatchDeps = {
			getToolDefinition: () => toolDef,
			createExtensionContext: () => fauxCtx,
			// Never actually dispatched via recordManagedLane -- nothing to correlate.
			resolveManagedLaneId: () => undefined,
			getGoalId: () => "g1",
		};

		const outcome = await dispatchCollaborationWorker(deps, { requirementId: "req-1", instructions: "do it" });
		expect(outcome.skipReason).toBe("lane_correlation_failed");
	});

	it("lane-first dispatch: createLaneWorktree runs BEFORE fire_task, and the new lane's cwd/worktreeLane are threaded into the fire_task agents param", async () => {
		const callOrder: string[] = [];
		let capturedParams: unknown;
		const toolDef = fauxCollaborationTool(async (_toolCallId, params) => {
			callOrder.push("fire_task");
			capturedParams = params;
			return {
				content: [{ type: "text" as const, text: "launched" }],
				details: { job: { id: "job1", agents: [{ id: "goal-worker-1" }] } },
			};
		});

		const deps: CollaborationDispatchDeps = {
			getToolDefinition: (name) => (name === "pi_collaboration" ? toolDef : undefined),
			createExtensionContext: () => fauxCtx,
			resolveManagedLaneId: (laneId) => laneId,
			getGoalId: () => "g1",
			createLaneWorktree: async (args) => {
				callOrder.push("createLaneWorktree");
				expect(args).toEqual({ goalId: "g1", requirementId: "req-1" });
				return { laneKey: "g1-1", worktreePath: "/repo/.worktrees/g1-1" };
			},
		};

		const outcome = await dispatchCollaborationWorker(deps, { requirementId: "req-1", instructions: "do it" });
		expect(outcome.skipReason).toBeUndefined();
		expect(outcome.laneId).toBe("collaboration:job1:goal-worker-1");

		// Lane creation strictly precedes the fire_task call -- never the other way around.
		expect(callOrder).toEqual(["createLaneWorktree", "fire_task"]);

		const params = capturedParams as {
			agents: Array<{ provider: string; name: string; cwd?: string; worktreeLane?: string }>;
		};
		expect(params.agents).toHaveLength(1);
		expect(params.agents[0]).toEqual({
			provider: "pi",
			name: "goal-worker",
			cwd: "/repo/.worktrees/g1-1",
			worktreeLane: "g1-1",
		});
	});

	it("worktree_create_failed: a lane-creation refusal aborts BEFORE any fire_task call -- never a half-made launch", async () => {
		let toolExecuted = false;
		const toolDef = fauxCollaborationTool(async () => {
			toolExecuted = true;
			return { content: [], details: {} };
		});

		const deps: CollaborationDispatchDeps = {
			getToolDefinition: (name) => (name === "pi_collaboration" ? toolDef : undefined),
			createExtensionContext: () => fauxCtx,
			resolveManagedLaneId: () => undefined,
			getGoalId: () => "g1",
			createLaneWorktree: async () => ({ skipReason: "max_lanes_reached" }),
		};

		const outcome = await dispatchCollaborationWorker(deps, { requirementId: "req-1", instructions: "do it" });
		expect(outcome.laneId).toBeUndefined();
		expect(outcome.skipReason).toBe("worktree_create_failed");
		expect(toolExecuted).toBe(false);
	});

	it("without a createLaneWorktree dep, fire_task params stay byte-identical (no cwd/worktreeLane)", async () => {
		let capturedParams: unknown;
		const toolDef = fauxCollaborationTool(async (_toolCallId, params) => {
			capturedParams = params;
			return {
				content: [{ type: "text" as const, text: "launched" }],
				details: { job: { id: "job1", agents: [{ id: "goal-worker-1" }] } },
			};
		});

		const deps: CollaborationDispatchDeps = {
			getToolDefinition: (name) => (name === "pi_collaboration" ? toolDef : undefined),
			createExtensionContext: () => fauxCtx,
			resolveManagedLaneId: (laneId) => laneId,
			getGoalId: () => "g1",
		};

		const outcome = await dispatchCollaborationWorker(deps, { requirementId: "req-1", instructions: "do it" });
		expect(outcome.laneId).toBe("collaboration:job1:goal-worker-1");
		const params = capturedParams as { agents: Array<Record<string, unknown>> };
		expect(params.agents[0]).toEqual({ provider: "pi", name: "goal-worker" });
	});

	it("worker_capability_insufficient: an eligibility refusal skips BEFORE createLaneWorktree -- zero lane/pane/tool side effect", async () => {
		let toolExecuted = false;
		let createLaneWorktreeCalled = false;
		const toolDef = fauxCollaborationTool(async () => {
			toolExecuted = true;
			return { content: [], details: {} };
		});

		const deps: CollaborationDispatchDeps = {
			getToolDefinition: (name) => (name === "pi_collaboration" ? toolDef : undefined),
			createExtensionContext: () => fauxCtx,
			resolveManagedLaneId: () => undefined,
			getGoalId: () => "g1",
			createLaneWorktree: async () => {
				createLaneWorktreeCalled = true;
				return { laneKey: "g1-1", worktreePath: "/repo/.worktrees/g1-1" };
			},
			evaluateWorkerLaneRefusal: () => ({
				reason: "capability_class_below_full",
				capabilityClass: "lean",
				contextWindow: 16_384,
			}),
		};

		const outcome = await dispatchCollaborationWorker(deps, { requirementId: "req-1", instructions: "do it" });
		expect(outcome.laneId).toBeUndefined();
		expect(outcome.skipReason).toBe("worker_capability_insufficient");
		expect(createLaneWorktreeCalled).toBe(false);
		expect(toolExecuted).toBe(false);
	});

	it("evaluateWorkerLaneRefusal returning undefined (eligible) proceeds exactly as today", async () => {
		let capturedParams: unknown;
		const toolDef = fauxCollaborationTool(async (_toolCallId, params) => {
			capturedParams = params;
			return {
				content: [{ type: "text" as const, text: "launched" }],
				details: { job: { id: "job1", agents: [{ id: "goal-worker-1" }] } },
			};
		});

		const deps: CollaborationDispatchDeps = {
			getToolDefinition: (name) => (name === "pi_collaboration" ? toolDef : undefined),
			createExtensionContext: () => fauxCtx,
			resolveManagedLaneId: (laneId) => laneId,
			getGoalId: () => "g1",
			evaluateWorkerLaneRefusal: () => undefined,
		};

		const outcome = await dispatchCollaborationWorker(deps, { requirementId: "req-1", instructions: "do it" });
		expect(outcome.skipReason).toBeUndefined();
		expect(outcome.laneId).toBe("collaboration:job1:goal-worker-1");
		const params = capturedParams as { agents: Array<Record<string, unknown>> };
		expect(params.agents[0]).toEqual({ provider: "pi", name: "goal-worker" });
	});
});
