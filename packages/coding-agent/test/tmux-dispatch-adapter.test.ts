import type { SessionManager } from "@caupulican/pi-agent-core/node";
import { SessionManager as InMemorySessionManager } from "@caupulican/pi-agent-core/node";
import { describe, expect, it } from "vitest";
import { BackgroundLaneController, type BackgroundLaneControllerDeps } from "../src/core/background-lane-controller.ts";
import type { ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { buildGoalRuntimeSnapshot } from "../src/core/goals/goal-runtime-snapshot.ts";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import { dispatchTmuxWorker, type TmuxDispatchDeps } from "../src/core/tools/tmux-dispatch.ts";
import { createTestManagedLaneDispatch } from "./managed-lane-fixture.ts";

/**
 * SPIKE/REPRO-FIRST: proves the WHOLE goal->tmux dispatch loop end-to-end with a
 * FAUX `tmux_agent_manager` tool (no real tmux) driving a REAL `BackgroundLaneController` -- the
 * adapter's correlation (`resolveManagedLaneId`), the goal reducer's binding, and the existing
 * "waiting"/resume continuation machinery are all exercised for real, only the extension's tmux
 * side effects (panes and sessions) are faked.
 */

function buildLaneControllerDeps(overrides: Partial<BackgroundLaneControllerDeps> = {}): BackgroundLaneControllerDeps {
	const sessionManager =
		(overrides.getSessionManager?.() as SessionManager | undefined) ?? InMemorySessionManager.inMemory();
	return {
		isDisposed: () => false,
		getSessionId: () => sessionManager.getSessionId(),
		getCwd: () => "/repo",
		getAgentDir: () => "/tmp/pi-test-tmux-dispatch-adapter",
		getSessionManager: () => sessionManager,
		getGoalStateSnapshot: () => undefined,
		getCapabilityEnvelope: () => undefined,
		saveWorkerClaimSnapshot: () => "worker-claim-entry",
		...overrides,
	} as unknown as BackgroundLaneControllerDeps;
}

const fauxCtx = { signal: undefined } as unknown as ExtensionContext;
const fauxTmuxPlatform: NodeJS.Platform = "linux";

function fauxTmuxTool(
	execute: ToolDefinition["execute"],
	guard: { allowed: boolean; onCall?: () => void } = { allowed: true },
): ToolDefinition {
	return {
		name: "tmux_agent_manager",
		label: "tmux_agent_manager",
		description: "faux tmux_agent_manager for the dispatch-adapter spike",
		parameters: {} as ToolDefinition["parameters"],
		execute(toolCallId, params, signal, onUpdate, ctx) {
			if ((params as { action?: string }).action === "guard") {
				guard.onCall?.();
				return Promise.resolve({
					content: [{ type: "text" as const, text: guard.allowed ? "tmux is available" : "tmux is unavailable" }],
					details: { action: "guard", guard: { allowed: guard.allowed } },
				});
			}
			return execute(toolCallId, params, signal, onUpdate, ctx);
		},
	};
}

describe("dispatchTmuxWorker (faux tmux tool end-to-end, real BackgroundLaneController)", () => {
	it("autonomous profiled dispatch: single pi agent, boundLaneId is the caller-stable durable id; goal waits then resumes on terminal", async () => {
		const sessionManager = InMemorySessionManager.inMemory();
		const blc = new BackgroundLaneController(buildLaneControllerDeps({ getSessionManager: () => sessionManager }));

		let capturedParams: unknown;
		const toolDef = fauxTmuxTool(async (_toolCallId, params) => {
			capturedParams = params;
			// The REAL bridge mechanism: the extension reports its dispatch under ITS OWN
			// caller-chosen laneId (tmux:<jobId>:<agentId>), which mints a genuine tmux-worker lane.
			blc.recordManagedLane({
				laneId: "tmux:job1:goal-worker-1",
				phase: "dispatch",
				goalId: "g1",
				dispatch: createTestManagedLaneDispatch(),
			});
			return {
				content: [{ type: "text" as const, text: "launched" }],
				details: { job: { id: "job1", agents: [{ id: "goal-worker-1" }] } },
			};
		});

		const deps: TmuxDispatchDeps = {
			platform: fauxTmuxPlatform,
			getToolDefinition: (name) => (name === "tmux_agent_manager" ? toolDef : undefined),
			createExtensionContext: () => fauxCtx,
			resolveManagedLaneId: (id) => blc.resolveManagedLaneId(id),
			getGoalId: () => "g1",
		};

		const outcome = await dispatchTmuxWorker(deps, { requirementId: "req-1", instructions: "do it" });
		expect(outcome.skipReason).toBeUndefined();
		expect(outcome.laneId).toBe("tmux:job1:goal-worker-1");

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
		expect(goalState.requirements.find((r) => r.id === "req-1")?.boundLaneId).toBe("tmux:job1:goal-worker-1");
		appendGoalStateSnapshot(sessionManager, goalState);

		const whileRunning = buildGoalRuntimeSnapshot({
			sessionManager,
			settings: { maxStallTurns: 20 },
			laneRecords: blc.getLaneRecords(),
		});
		expect(whileRunning.continuation.action).toBe("waiting");
		expect(whileRunning.continuation.reasonCode).toBe("worker_in_flight");

		// The faux terminal handoff.
		blc.recordManagedLane({ laneId: "tmux:job1:goal-worker-1", phase: "terminal", status: "done" });

		const afterTerminal = buildGoalRuntimeSnapshot({
			sessionManager,
			settings: { maxStallTurns: 20 },
			laneRecords: blc.getLaneRecords(),
		});
		expect(afterTerminal.continuation.action).not.toBe("waiting");
	});

	it("extension-not-loaded: getToolDefinition undefined -> honest skip, no crash", async () => {
		const deps: TmuxDispatchDeps = {
			platform: fauxTmuxPlatform,
			getToolDefinition: () => undefined,
			createExtensionContext: () => fauxCtx,
			resolveManagedLaneId: () => undefined,
			getGoalId: () => "g1",
		};

		const outcome = await dispatchTmuxWorker(deps, { requirementId: "req-1", instructions: "do it" });
		expect(outcome.skipReason).toBe("tmux_extension_not_loaded");
		expect(outcome.laneId).toBeUndefined();
	});

	it("native Windows refuses tmux before extension lookup, context creation, or worktree side effects", async () => {
		let toolLookedUp = false;
		let contextCreated = false;
		let worktreeCreated = false;
		const deps = {
			platform: "win32" as NodeJS.Platform,
			getToolDefinition: () => {
				toolLookedUp = true;
				return fauxTmuxTool(async () => ({ content: [], details: {} }));
			},
			createExtensionContext: () => {
				contextCreated = true;
				return fauxCtx;
			},
			resolveManagedLaneId: () => undefined,
			getGoalId: () => "g1",
			createLaneWorktree: async () => {
				worktreeCreated = true;
				return { laneKey: "g1-1", worktreePath: "/repo/.worktrees/g1-1" };
			},
		} as TmuxDispatchDeps & { platform: NodeJS.Platform };

		const outcome = await dispatchTmuxWorker(deps, { requirementId: "req-1", instructions: "do it" });

		expect(outcome).toEqual({ skipReason: "tmux_unavailable" });
		expect(toolLookedUp).toBe(false);
		expect(contextCreated).toBe(false);
		expect(worktreeCreated).toBe(false);
	});

	it("guards tmux availability before creating a worktree or launching a pane", async () => {
		const actions: string[] = [];
		let worktreeCreated = false;
		const toolDef = fauxTmuxTool(
			async (_toolCallId, params) => {
				actions.push((params as { action: string }).action);
				return { content: [], details: {} };
			},
			{ allowed: false, onCall: () => actions.push("guard") },
		);
		const deps: TmuxDispatchDeps = {
			platform: fauxTmuxPlatform,
			getToolDefinition: () => toolDef,
			createExtensionContext: () => fauxCtx,
			resolveManagedLaneId: () => undefined,
			getGoalId: () => "g1",
			createLaneWorktree: async () => {
				worktreeCreated = true;
				return { laneKey: "g1-1", worktreePath: "/repo/.worktrees/g1-1" };
			},
		};

		const outcome = await dispatchTmuxWorker(deps, { requirementId: "req-1", instructions: "do it" });

		expect(outcome).toEqual({ skipReason: "tmux_unavailable" });
		expect(actions).toEqual(["guard"]);
		expect(worktreeCreated).toBe(false);
	});

	it("a launch failure classifies as tmux_dispatch_failed -- still an honest surfaced skip, never a crash", async () => {
		const toolDef = fauxTmuxTool(async () => {
			throw new Error("tmux session already exists: pi-agents-x. Use stop_job/stop_session first.");
		});
		const deps: TmuxDispatchDeps = {
			platform: fauxTmuxPlatform,
			getToolDefinition: () => toolDef,
			createExtensionContext: () => fauxCtx,
			resolveManagedLaneId: () => undefined,
			getGoalId: () => "g1",
		};

		const outcome = await dispatchTmuxWorker(deps, { requirementId: "req-1", instructions: "do it" });
		expect(outcome.skipReason).toBe("tmux_dispatch_failed");
		expect(outcome.laneId).toBeUndefined();
	});

	it("tmux_dispatch_incomplete when the result carries no job/agents", async () => {
		const toolDef = fauxTmuxTool(async () => ({ content: [], details: {} }));
		const deps: TmuxDispatchDeps = {
			platform: fauxTmuxPlatform,
			getToolDefinition: () => toolDef,
			createExtensionContext: () => fauxCtx,
			resolveManagedLaneId: () => undefined,
			getGoalId: () => "g1",
		};

		const outcome = await dispatchTmuxWorker(deps, { requirementId: "req-1", instructions: "do it" });
		expect(outcome.skipReason).toBe("tmux_dispatch_incomplete");
	});

	it("lane_correlation_failed when the dispatch was not registered under its stable lane id", async () => {
		const toolDef = fauxTmuxTool(async () => ({
			content: [],
			details: { job: { id: "job1", agents: [{ id: "goal-worker-1" }] } },
		}));
		const deps: TmuxDispatchDeps = {
			platform: fauxTmuxPlatform,
			getToolDefinition: () => toolDef,
			createExtensionContext: () => fauxCtx,
			// Never actually dispatched via recordManagedLane -- nothing to correlate.
			resolveManagedLaneId: () => undefined,
			getGoalId: () => "g1",
		};

		const outcome = await dispatchTmuxWorker(deps, { requirementId: "req-1", instructions: "do it" });
		expect(outcome.skipReason).toBe("lane_correlation_failed");
	});

	it("lane-first dispatch: createLaneWorktree runs BEFORE fire_task, and the new lane's cwd/worktreeLane are threaded into the fire_task agents param", async () => {
		const callOrder: string[] = [];
		let capturedParams: unknown;
		const toolDef = fauxTmuxTool(async (_toolCallId, params) => {
			callOrder.push("fire_task");
			capturedParams = params;
			return {
				content: [{ type: "text" as const, text: "launched" }],
				details: { job: { id: "job1", agents: [{ id: "goal-worker-1" }] } },
			};
		});

		const deps: TmuxDispatchDeps = {
			platform: fauxTmuxPlatform,
			getToolDefinition: (name) => (name === "tmux_agent_manager" ? toolDef : undefined),
			createExtensionContext: () => fauxCtx,
			resolveManagedLaneId: (laneId) => laneId,
			getGoalId: () => "g1",
			createLaneWorktree: async (args) => {
				callOrder.push("createLaneWorktree");
				expect(args).toEqual({ goalId: "g1", requirementId: "req-1" });
				return { laneKey: "g1-1", worktreePath: "/repo/.worktrees/g1-1" };
			},
		};

		const outcome = await dispatchTmuxWorker(deps, { requirementId: "req-1", instructions: "do it" });
		expect(outcome.skipReason).toBeUndefined();
		expect(outcome.laneId).toBe("tmux:job1:goal-worker-1");

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
		const toolDef = fauxTmuxTool(async () => {
			toolExecuted = true;
			return { content: [], details: {} };
		});

		const deps: TmuxDispatchDeps = {
			platform: fauxTmuxPlatform,
			getToolDefinition: (name) => (name === "tmux_agent_manager" ? toolDef : undefined),
			createExtensionContext: () => fauxCtx,
			resolveManagedLaneId: () => undefined,
			getGoalId: () => "g1",
			createLaneWorktree: async () => ({ skipReason: "max_lanes_reached" }),
		};

		const outcome = await dispatchTmuxWorker(deps, { requirementId: "req-1", instructions: "do it" });
		expect(outcome.laneId).toBeUndefined();
		expect(outcome.skipReason).toBe("worktree_create_failed");
		expect(toolExecuted).toBe(false);
	});

	it("without a createLaneWorktree dep, fire_task params stay byte-identical (no cwd/worktreeLane)", async () => {
		let capturedParams: unknown;
		const toolDef = fauxTmuxTool(async (_toolCallId, params) => {
			capturedParams = params;
			return {
				content: [{ type: "text" as const, text: "launched" }],
				details: { job: { id: "job1", agents: [{ id: "goal-worker-1" }] } },
			};
		});

		const deps: TmuxDispatchDeps = {
			platform: fauxTmuxPlatform,
			getToolDefinition: (name) => (name === "tmux_agent_manager" ? toolDef : undefined),
			createExtensionContext: () => fauxCtx,
			resolveManagedLaneId: (laneId) => laneId,
			getGoalId: () => "g1",
		};

		const outcome = await dispatchTmuxWorker(deps, { requirementId: "req-1", instructions: "do it" });
		expect(outcome.laneId).toBe("tmux:job1:goal-worker-1");
		const params = capturedParams as { agents: Array<Record<string, unknown>> };
		expect(params.agents[0]).toEqual({ provider: "pi", name: "goal-worker" });
	});

	it("worker_capability_insufficient: an eligibility refusal skips BEFORE createLaneWorktree -- zero lane/pane/tool side effect", async () => {
		let toolExecuted = false;
		let createLaneWorktreeCalled = false;
		const toolDef = fauxTmuxTool(async () => {
			toolExecuted = true;
			return { content: [], details: {} };
		});

		const deps: TmuxDispatchDeps = {
			platform: fauxTmuxPlatform,
			getToolDefinition: (name) => (name === "tmux_agent_manager" ? toolDef : undefined),
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

		const outcome = await dispatchTmuxWorker(deps, { requirementId: "req-1", instructions: "do it" });
		expect(outcome.laneId).toBeUndefined();
		expect(outcome.skipReason).toBe("worker_capability_insufficient");
		expect(createLaneWorktreeCalled).toBe(false);
		expect(toolExecuted).toBe(false);
	});

	it("evaluateWorkerLaneRefusal returning undefined (eligible) proceeds exactly as today", async () => {
		let capturedParams: unknown;
		const toolDef = fauxTmuxTool(async (_toolCallId, params) => {
			capturedParams = params;
			return {
				content: [{ type: "text" as const, text: "launched" }],
				details: { job: { id: "job1", agents: [{ id: "goal-worker-1" }] } },
			};
		});

		const deps: TmuxDispatchDeps = {
			platform: fauxTmuxPlatform,
			getToolDefinition: (name) => (name === "tmux_agent_manager" ? toolDef : undefined),
			createExtensionContext: () => fauxCtx,
			resolveManagedLaneId: (laneId) => laneId,
			getGoalId: () => "g1",
			evaluateWorkerLaneRefusal: () => undefined,
		};

		const outcome = await dispatchTmuxWorker(deps, { requirementId: "req-1", instructions: "do it" });
		expect(outcome.skipReason).toBeUndefined();
		expect(outcome.laneId).toBe("tmux:job1:goal-worker-1");
		const params = capturedParams as { agents: Array<Record<string, unknown>> };
		expect(params.agents[0]).toEqual({ provider: "pi", name: "goal-worker" });
	});
});
