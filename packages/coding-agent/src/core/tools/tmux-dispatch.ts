import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";

/**
 * Dependencies for {@link dispatchTmuxWorker}, injected from the construction site
 * (`RuntimeBuilder`) so the adapter itself stays a small, unit-testable, faux-tool-driven module
 * with no direct dependency on `AgentSession`/`ExtensionRunner`/`BackgroundLaneController`.
 */
export interface TmuxDispatchDeps {
	/** Look up a registered tool by name -- the SAME seam the model's own tool calls resolve
	 * through (`AgentSession.getToolDefinition` -> `RuntimeBuilder.getToolDefinition`). `undefined`
	 * when the tmux extension is not loaded in this session -- an honest, non-fatal skip, not a
	 * crash and not a silent no-op. */
	getToolDefinition: (name: string) => ToolDefinition | undefined;
	/** Build a fresh, non-turn-bound `ExtensionContext` for this call
	 * (`ExtensionRunner.createContext()`) -- safe to invoke from the goal/idle path, outside any
	 * live model turn. */
	createExtensionContext: () => ExtensionContext;
	/**
	 * Resolve the tmux extension's own caller-chosen lane id (reconstructed below from the
	 * `fire_task` result's `details.job`) to the host's internal `LaneTracker` id -- the id
	 * `Requirement.boundLaneId` / `inFlightGoalLaneIds` actually match
	 * (`BackgroundLaneController.resolveManagedLaneId`). A deterministic keyed lookup against the
	 * dispatch this same call just minted, NOT a racy `getLaneRecords()` diff.
	 */
	resolveManagedLaneId: (callerLaneId: string) => string | undefined;
	/** Active goal id, threaded onto the `fire_task` call so the dispatched lane is goal-tagged
	 * (`ManagedLaneEvent.goalId`) -- `undefined` when no goal is active (dispatch still proceeds;
	 * the resulting lane is simply untagged). */
	getGoalId: () => string | undefined;
}

/**
 * Classify a `fire_task` launch failure into an honest, stable skip reason. For an UNATTENDED
 * caller (`ctx.hasUI === false`, always true from the goal/idle path) `authorizeLaunch`'s ONLY
 * refusal throw is the no-standing-grant error (`tmux-agent-manager/index.ts`'s `authorizeLaunch`,
 * message containing the stable phrase "no standing grant") -- matched here by substring since the
 * extension throws a plain `Error`, not a tagged error code (documented follow-up hardening, not
 * blocking). Every other thrown error (a bad jobId, a live session-name collision,
 * an environment failure) maps onto the generic `"tmux_dispatch_failed"` -- still surfaced through
 * the existing `dispatchSkipReason` contract, never a crash and never a silently-ignored failure.
 */
export function classifyDispatchError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("no standing grant") ? "no_standing_grant" : "tmux_dispatch_failed";
}

interface FireTaskResultDetails {
	job?: {
		id?: string;
		agents?: ReadonlyArray<{ id?: string }>;
	};
}

/**
 * Structurally dispatch ONE persistent tmux worker agent for a single goal requirement, by
 * invoking the SAME `tmux_agent_manager` `fire_task` tool call the model itself would make. Core
 * -- not model discretion -- decides WHEN this fires (the goal tool's `dispatchTarget:"tmux"`
 * routing gates the call); the launch itself always still goes through the extension's own
 * grant-gated `authorizeLaunch`, so an ungranted unattended call is honestly refused here (never a
 * silent launch, never a fabricated laneId) and the refusal is surfaced through the existing
 * `dispatchSkipReason` contract on the goal tool's response.
 */
export async function dispatchTmuxWorker(
	deps: TmuxDispatchDeps,
	args: { requirementId: string; instructions: string },
): Promise<{ laneId?: string; skipReason?: string }> {
	const toolDef = deps.getToolDefinition("tmux_agent_manager");
	if (!toolDef) return { skipReason: "tmux_extension_not_loaded" };

	const goalId = deps.getGoalId();
	const ctx = deps.createExtensionContext();
	// Single-agent 1:1 mapping: a bare fire_task with no `agents` defaults to a THREE-agent
	// team (pi/agy/codex -- `DEFAULT_AGENT_PROVIDERS`), which would mint three lanes for one
	// requirement. A goal-bound dispatch must map to exactly one lane, so `agents` is always
	// passed explicitly here.
	const params = {
		action: "fire_task",
		task: args.instructions,
		goalId,
		agents: [{ provider: "pi", name: "goal-worker" }],
	};
	const toolCallId = `goal-dispatch:${goalId ?? "?"}:${args.requirementId}`;

	let result: Awaited<ReturnType<ToolDefinition["execute"]>>;
	try {
		result = await toolDef.execute(toolCallId, params, ctx.signal, undefined, ctx);
	} catch (error) {
		return { skipReason: classifyDispatchError(error) };
	}

	// Correlate: the extension reports its dispatch under its OWN caller-chosen laneId
	// (`tmux:${job.id}:${agent.id}`, reconstructed here from the tool result's `details.job` --
	// the same format `agentLaneId` builds extension-side) which the host's `recordManagedLane`
	// bridge keys `_managedLaneDispatches` by; `resolveManagedLaneId` reads that keyed map for the
	// internal id the reducer/continuation machinery actually match on.
	const job = (result.details as FireTaskResultDetails | undefined)?.job;
	const primary = job?.agents?.[0];
	if (!job?.id || !primary?.id) return { skipReason: "tmux_dispatch_incomplete" };

	const callerLaneId = `tmux:${job.id}:${primary.id}`;
	const laneId = deps.resolveManagedLaneId(callerLaneId);
	return laneId ? { laneId } : { skipReason: "lane_correlation_failed" };
}
