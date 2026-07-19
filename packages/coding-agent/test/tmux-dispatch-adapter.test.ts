import type { SessionManager } from "@caupulican/pi-agent-core/node";
import { SessionManager as InMemorySessionManager } from "@caupulican/pi-agent-core/node";
import { describe, expect, it } from "vitest";
import { BackgroundLaneController, type BackgroundLaneControllerDeps } from "../src/core/background-lane-controller.ts";
import type { ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { buildGoalRuntimeSnapshot } from "../src/core/goals/goal-runtime-snapshot.ts";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import { classifyDispatchError, dispatchTmuxWorker, type TmuxDispatchDeps } from "../src/core/tools/tmux-dispatch.ts";

/**
 * SPIKE/REPRO-FIRST: proves the WHOLE goal->tmux dispatch loop end-to-end with a
 * FAUX `tmux_agent_manager` tool (no real tmux) driving a REAL `BackgroundLaneController` -- the
 * adapter's correlation (`resolveManagedLaneId`), the goal reducer's binding, and the existing
 * "waiting"/resume continuation machinery are all exercised for real, only the extension's tmux
 * side effects (panes, sessions, grants) are faked.
 */

function buildLaneControllerDeps(overrides: Partial<BackgroundLaneControllerDeps> = {}): BackgroundLaneControllerDeps {
	const sessionManager =
		(overrides.getSessionManager?.() as SessionManager | undefined) ?? InMemorySessionManager.inMemory();
	return {
		isDisposed: () => false,
		getSessionId: () => "test-session",
		getCwd: () => "/repo",
		getAgentDir: () => "/tmp/pi-test-tmux-dispatch-adapter",
		getSessionManager: () => sessionManager,
		getGoalStateSnapshot: () => undefined,
		getCapabilityEnvelope: () => undefined,
		saveWorkerResultSnapshot: () => "worker-result-entry",
		...overrides,
	} as unknown as BackgroundLaneControllerDeps;
}

const fauxCtx = { signal: undefined } as unknown as ExtensionContext;

function fauxTmuxTool(execute: ToolDefinition["execute"]): ToolDefinition {
	return {
		name: "tmux_agent_manager",
		label: "tmux_agent_manager",
		description: "faux tmux_agent_manager for the dispatch-adapter spike",
		parameters: {} as ToolDefinition["parameters"],
		execute,
	};
}

describe("dispatchTmuxWorker (faux tmux tool end-to-end, real BackgroundLaneController)", () => {
	it("granted dispatch: single pi agent, boundLaneId is the real minted internal id; goal waits then resumes on terminal", async () => {
		const sessionManager = InMemorySessionManager.inMemory();
		const blc = new BackgroundLaneController(buildLaneControllerDeps({ getSessionManager: () => sessionManager }));

		let capturedParams: unknown;
		const toolDef = fauxTmuxTool(async (_toolCallId, params) => {
			capturedParams = params;
			// The REAL bridge mechanism: the extension reports its dispatch under ITS OWN
			// caller-chosen laneId (tmux:<jobId>:<agentId>), which mints a genuine tmux-worker lane.
			blc.recordManagedLane({ laneId: "tmux:job1:goal-worker-1", phase: "dispatch", goalId: "g1" });
			return {
				content: [{ type: "text" as const, text: "launched" }],
				details: { job: { id: "job1", agents: [{ id: "goal-worker-1" }] } },
			};
		});

		const deps: TmuxDispatchDeps = {
			getToolDefinition: (name) => (name === "tmux_agent_manager" ? toolDef : undefined),
			createExtensionContext: () => fauxCtx,
			resolveManagedLaneId: (id) => blc.resolveManagedLaneId(id),
			getGoalId: () => "g1",
		};

		const outcome = await dispatchTmuxWorker(deps, { requirementId: "req-1", instructions: "do it" });
		expect(outcome.skipReason).toBeUndefined();
		expect(outcome.laneId).toBe("tmux-worker-1");

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
		expect(goalState.requirements.find((r) => r.id === "req-1")?.boundLaneId).toBe("tmux-worker-1");
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

	it("ungranted refusal: a no-standing-grant throw surfaces as an honest skip, never a crash and never a fake laneId", async () => {
		const toolDef = fauxTmuxTool(async () => {
			throw new Error(
				"no standing grant for tmux dispatch; run grant_dispatch first: fire_task launch of job job1 (primary agent goal-worker). Refusing to launch without a grant or interactive approval.",
			);
		});
		const deps: TmuxDispatchDeps = {
			getToolDefinition: () => toolDef,
			createExtensionContext: () => fauxCtx,
			resolveManagedLaneId: () => undefined,
			getGoalId: () => "g1",
		};

		const outcome = await dispatchTmuxWorker(deps, { requirementId: "req-1", instructions: "do it" });
		expect(outcome.laneId).toBeUndefined();
		expect(outcome.skipReason).toBe("no_standing_grant");
	});

	it("extension-not-loaded: getToolDefinition undefined -> honest skip, no crash", async () => {
		const deps: TmuxDispatchDeps = {
			getToolDefinition: () => undefined,
			createExtensionContext: () => fauxCtx,
			resolveManagedLaneId: () => undefined,
			getGoalId: () => "g1",
		};

		const outcome = await dispatchTmuxWorker(deps, { requirementId: "req-1", instructions: "do it" });
		expect(outcome.skipReason).toBe("tmux_extension_not_loaded");
		expect(outcome.laneId).toBeUndefined();
	});

	it("a non-grant launch failure classifies as tmux_dispatch_failed -- still an honest surfaced skip, never a crash", async () => {
		const toolDef = fauxTmuxTool(async () => {
			throw new Error("tmux session already exists: pi-agents-x. Use stop_job/stop_session first.");
		});
		const deps: TmuxDispatchDeps = {
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
			getToolDefinition: () => toolDef,
			createExtensionContext: () => fauxCtx,
			resolveManagedLaneId: () => undefined,
			getGoalId: () => "g1",
		};

		const outcome = await dispatchTmuxWorker(deps, { requirementId: "req-1", instructions: "do it" });
		expect(outcome.skipReason).toBe("tmux_dispatch_incomplete");
	});

	it("lane_correlation_failed when the dispatch cannot be resolved to an internal lane id", async () => {
		const toolDef = fauxTmuxTool(async () => ({
			content: [],
			details: { job: { id: "job1", agents: [{ id: "goal-worker-1" }] } },
		}));
		const deps: TmuxDispatchDeps = {
			getToolDefinition: () => toolDef,
			createExtensionContext: () => fauxCtx,
			// Never actually dispatched via recordManagedLane -- nothing to correlate.
			resolveManagedLaneId: () => undefined,
			getGoalId: () => "g1",
		};

		const outcome = await dispatchTmuxWorker(deps, { requirementId: "req-1", instructions: "do it" });
		expect(outcome.skipReason).toBe("lane_correlation_failed");
	});

	it("classifyDispatchError maps the stable no-standing-grant substring; every other failure is tmux_dispatch_failed", () => {
		expect(classifyDispatchError(new Error("no standing grant for tmux dispatch; run grant_dispatch first"))).toBe(
			"no_standing_grant",
		);
		expect(classifyDispatchError(new Error("some other failure"))).toBe("tmux_dispatch_failed");
		expect(classifyDispatchError("a non-Error throw")).toBe("tmux_dispatch_failed");
	});
});
