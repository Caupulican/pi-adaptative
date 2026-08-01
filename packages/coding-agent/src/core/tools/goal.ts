import { stat as fsStat } from "node:fs/promises";
import { type Static, Type } from "typebox";
import type { WorkerClaim } from "../autonomy/contracts.ts";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { type GoalStateRevision, getGoalStateRevision } from "../goals/goal-lifecycle.ts";
import type { GoalEvidenceKind, GoalState } from "../goals/goal-state.ts";
import {
	applyGoalAction,
	type GoalAction,
	type GoalActionName,
	type OpenTaskStepRef,
	summarizeGoalState,
} from "../goals/goal-tool-core.ts";
import {
	emptyOrchestrationCall,
	OrchestrationPanelComponent,
	type OrchestrationPanelModel,
} from "./orchestration-panel.ts";
import { resolveToCwd } from "./path-utils.ts";

const goalSchema = Type.Object(
	{
		action: Type.Union(
			[
				Type.Literal("get"),
				Type.Literal("start"),
				Type.Literal("add_requirement"),
				Type.Literal("satisfy_requirement"),
				Type.Literal("block_requirement"),
				Type.Literal("reopen_requirement"),
				Type.Literal("dispatch_worker"),
				Type.Literal("add_evidence"),
				Type.Literal("progress"),
				Type.Literal("no_progress"),
				Type.Literal("complete"),
				Type.Literal("block_goal"),
			],
			{ description: "Goal record action." },
		),
		goalId: Type.Optional(Type.String({ description: "Stable goal id. Required for action 'start'." })),
		userGoal: Type.Optional(Type.String({ description: "The goal statement. Required for action 'start'." })),
		tokenBudget: Type.Optional(
			Type.Integer({ minimum: 1, description: "Optional positive token budget for action 'start'." }),
		),
		requirementId: Type.Optional(
			Type.String({
				description:
					"Requirement id for add_requirement/satisfy_requirement/block_requirement/reopen_requirement/dispatch_worker.",
			}),
		),
		text: Type.Optional(Type.String({ description: "Requirement text. Required for add_requirement." })),
		instructions: Type.Optional(Type.String({ description: "Worker instructions. Required for dispatch_worker." })),
		evidenceId: Type.Optional(Type.String({ description: "Evidence id. Required for add_evidence." })),
		evidenceIds: Type.Optional(
			Type.Array(Type.String(), {
				description: "Evidence ids supporting a satisfy_requirement action. Each must already be recorded.",
			}),
		),
		kind: Type.Optional(
			Type.Union(
				[
					Type.Literal("file"),
					Type.Literal("test"),
					Type.Literal("tool"),
					Type.Literal("user"),
					Type.Literal("finding"),
					Type.Literal("worker"),
				],
				{ description: "Evidence kind. Required for add_evidence." },
			),
		),
		summary: Type.Optional(Type.String({ description: "Evidence summary. Required for add_evidence." })),
		uri: Type.Optional(
			Type.String({
				description:
					"Optional evidence locator (path/URL for kind 'file', a toolCallId for kind 'tool', a laneId for kind 'worker').",
			}),
		),
		reason: Type.Optional(Type.String({ description: "Reason for block_requirement or block_goal." })),
		dispatchTarget: Type.Optional(
			Type.Union([Type.Literal("in_process"), Type.Literal("tmux")], {
				description: "Legacy worker target. Prefer the delegate tool for new work.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type GoalToolInput = Static<typeof goalSchema>;

export interface GoalToolDetails {
	action: GoalActionName | "get";
	applied: boolean;
	error?: string;
	state?: GoalState;
	/** Set on 'dispatch_worker' when a worker lane actually started; mirrors the requirement's
	 * new `boundLaneId`. The in-process route by default, or a real persistent tmux lane when
	 * `dispatchTarget:"tmux"` was selected and routed -- see {@link GoalToolDependencies.dispatchTmuxWorker}. */
	dispatchedLaneId?: string;
	/** Set on 'dispatch_worker' when no worker was dispatched: a wired dependency declined (e.g. worker
	 * delegation disabled, already at capacity, or an honest tmux skip reason -- see
	 * {@link GoalToolDependencies.dispatchTmuxWorker}), or the indeterminate-binding guard refused a
	 * re-dispatch against an already-bound requirement (`requirement_already_bound`/`bound_lane_indeterminate`).
	 * The binding is recorded (or, for a guard refusal, left exactly as it was) with no NEW laneId. */
	dispatchSkipReason?: string;
}

export interface GoalToolDependencies {
	/** Read the latest persisted goal state for the active session. */
	getGoalState: () => GoalState | undefined;
	/** Persist a new goal state snapshot to the active session. */
	saveGoalState: (state: GoalState, expected?: GoalStateRevision) => void;
	/** Clock injection for deterministic tests. */
	now?: () => string;
	/**
	 * Check whether `toolCallId` exists in this session's records, for validating kind:"tool"
	 * evidence refs at add_evidence time. When not wired, a "tool" ref cannot be proven and is
	 * recorded as `verified: false` rather than assumed true.
	 */
	hasToolCallId?: (toolCallId: string) => boolean;
	/**
	 * Read the session's live worker lane records, for validating kind:"worker" evidence refs
	 * (the `uri` is a laneId) at add_evidence time. Read-defensive: when not wired -- exactly like
	 * `hasToolCallId` -- a "worker" ref cannot be proven and is recorded as `verified: false` rather
	 * than assumed true. Live wiring is added separately.
	 */
	getLaneRecords?: () => readonly LaneRecord[];
	/**
	 * Read persisted worker claim snapshots (keyed by `WorkerClaim.requestId`, which is the same
	 * id as the dispatching lane's laneId), for validating kind:"worker" evidence refs. See
	 * {@link getLaneRecords}. A matching claim that is `parentReviewRequired && !parentReviewedAt`
	 * verifies `false` -- an unreviewed worker completion must never ungate goal completion through
	 * the existing verified/complete gate.
	 */
	getWorkerClaimSnapshots?: () => readonly WorkerClaim[];
	/**
	 * Tool-layer side effect for a 'dispatch_worker' action when `dispatchTarget` is 'in_process'
	 * (the default) or when {@link dispatchTmuxWorker} is not wired: dispatches a real in-process
	 * worker lane for the given requirement and returns the resulting laneId to bind onto it. When
	 * the dependency is present but the underlying delegation starter declines (disabled, already at
	 * capacity, etc.), return `{ skipReason }` instead of a laneId -- a real, non-silent skip that
	 * the tool response surfaces, distinct from this dependency being altogether unwired (`undefined`
	 * dep, or the dep returning `undefined`), which records the binding attempt structurally with no
	 * laneId (a no-op).
	 */
	startWorkerDelegation?: (args: {
		requirementId: string;
		instructions: string;
	}) => { laneId?: string; skipReason?: string } | undefined;
	/**
	 * Tool-layer side effect for a 'dispatch_worker' action when `input.dispatchTarget === "tmux"`:
	 * dispatches a REAL persistent tmux worker via the tmux_agent_manager extension's `fire_task`
	 * action (core structurally invokes the same tool call the model would make; no extension change,
	 * no faked launch or laneId -- see `tmux-dispatch.ts`'s `dispatchTmuxWorker`). Selected ONLY when
	 * BOTH `input.dispatchTarget === "tmux"` AND this dependency is present; otherwise the EXISTING
	 * {@link startWorkerDelegation} in-process path runs, byte-identical to before this field existed.
	 * The honest skip-reason vocabulary this can return: `tmux_extension_not_loaded`,
	 * `no_standing_grant` (the owner has not authorized unattended tmux dispatch),
	 * `tmux_dispatch_failed`, `tmux_dispatch_incomplete`, `lane_correlation_failed`,
	 * `worktree_create_failed` (worktree-sync is enabled but the lane-first `create_lane` call was
	 * refused -- e.g. max lanes reached -- so no fire_task call was ever attempted),
	 * `worker_capability_insufficient` (the model is sub-full class, has an unknown context window,
	 * does not advertise a native tool-call path, or is graded-demoted to text-protocol/none -- see
	 * `model-capability.ts`'s `evaluateLaneWorkerRefusal`; this is the parent's best-effort check
	 * only, refused before any lane/pane side effect -- the dispatched child still refuses
	 * authoritatively at its own startup regardless).
	 */
	dispatchTmuxWorker?: (args: {
		requirementId: string;
		instructions: string;
	}) => Promise<{ laneId?: string; skipReason?: string }>;
	/** Working directory for resolving kind:"file" evidence ref paths. Defaults to `process.cwd()`. */
	cwd?: () => string;
	/**
	 * Gate agent-facing 'complete' on verified/user evidence backing. Defaults to `true` (on)
	 * when omitted -- the conservative default; set to a function returning `false` to opt out.
	 */
	requireVerifiedEvidenceForCompletion?: () => boolean;
	/**
	 * Read-only open (non-terminal) task_steps steps on the active branch, for the goal⇄task
	 * cross-visibility nudge in the tool response. When omitted, `summarizeGoalState` gets
	 * no task-step context and simply emits no nudge -- goal-tool-core stays pure and never reads
	 * task state itself; this is the only place that supplies it.
	 */
	getOpenTaskSteps?: () => readonly OpenTaskStepRef[];
}

/**
 * Validate an evidence ref's `uri` against session records ("tool") or the filesystem ("file").
 * Returns `undefined` for kinds/refs that carry nothing checkable (e.g. "user"/"finding"/"test",
 * or a missing `uri`) -- absence of a ref is not the same as a ref that failed to verify.
 */
async function resolveEvidenceVerified(
	kind: GoalEvidenceKind,
	uri: string | undefined,
	deps: GoalToolDependencies,
): Promise<boolean | undefined> {
	const trimmedUri = uri?.trim();
	if (!trimmedUri) return undefined;
	if (kind === "tool") {
		return deps.hasToolCallId ? deps.hasToolCallId(trimmedUri) : false;
	}
	if (kind === "file") {
		const cwd = deps.cwd?.() ?? process.cwd();
		try {
			const stats = await fsStat(resolveToCwd(trimmedUri, cwd));
			return stats.isFile();
		} catch {
			return false;
		}
	}
	if (kind === "worker") {
		if (!deps.getLaneRecords || !deps.getWorkerClaimSnapshots) return false;
		const laneId = trimmedUri;
		const record = deps.getLaneRecords().find((candidate) => candidate.laneId === laneId);
		if (!record) return false;
		const claim = deps.getWorkerClaimSnapshots().find((candidate) => candidate.requestId === laneId);
		if (!claim) return false;
		// An unreviewed mutation (parentReviewRequired && no parentReviewedAt) can never verify true --
		// this is what stops an unreviewed worker completion from ungating goal completion through
		// the existing verified/complete gate (goal-tool-core's isVerifiedOrUserEvidence/complete).
		if (claim.parentReviewRequired === true && claim.parentReviewedAt === undefined) return false;
		return claim.status === "completed";
	}
	return undefined;
}

function toGoalAction(input: GoalToolInput): GoalAction | { error: string } {
	switch (input.action) {
		case "start":
			return {
				action: "start",
				goalId: input.goalId ?? "",
				userGoal: input.userGoal ?? "",
				tokenBudget: input.tokenBudget,
			};
		case "add_requirement":
			return { action: "add_requirement", requirementId: input.requirementId ?? "", text: input.text ?? "" };
		case "satisfy_requirement":
			return {
				action: "satisfy_requirement",
				requirementId: input.requirementId ?? "",
				evidenceIds: input.evidenceIds,
			};
		case "block_requirement":
			return {
				action: "block_requirement",
				requirementId: input.requirementId ?? "",
				reason: input.reason ?? "",
			};
		case "reopen_requirement":
			return { action: "reopen_requirement", requirementId: input.requirementId ?? "" };
		case "dispatch_worker":
			return {
				action: "dispatch_worker",
				requirementId: input.requirementId ?? "",
				instructions: input.instructions ?? "",
			};
		case "add_evidence": {
			if (input.kind === undefined) {
				return { error: "add_evidence requires a kind." };
			}
			const kind: GoalEvidenceKind = input.kind;
			return {
				action: "add_evidence",
				evidenceId: input.evidenceId ?? "",
				kind,
				summary: input.summary ?? "",
				uri: input.uri,
			};
		}
		case "progress":
			return { action: "progress" };
		case "no_progress":
			return { action: "no_progress" };
		case "complete":
			return { action: "complete" };
		case "block_goal":
			return { action: "block_goal", reason: input.reason ?? "" };
		case "get":
			return { error: "get is handled as a read-only action." };
		default:
			return { error: "Unknown goal action." };
	}
}

function goalPanelModel(details: GoalToolDetails | undefined): OrchestrationPanelModel {
	const state = details?.state;
	if (!state) {
		return {
			label: "goal",
			action: details?.action,
			status: details?.error ? "error" : "idle",
			emptyText: details?.error ?? "No goal state was returned.",
		};
	}
	const satisfied = state.requirements.filter((requirement) => requirement.status === "satisfied").length;
	return {
		label: "goal",
		action: details.action,
		status:
			state.status === "completed"
				? "success"
				: state.status === "blocked" ||
						state.status === "paused" ||
						state.status === "usage_limited" ||
						state.status === "budget_limited"
					? "warning"
					: state.status === "cancelled"
						? "idle"
						: "running",
		summary: [
			`${satisfied}/${state.requirements.length} requirements`,
			`${state.evidence.length} evidence`,
			...(state.tokenBudget !== undefined ? [`${state.tokensUsed ?? 0}/${state.tokenBudget} tokens`] : []),
		],
		rows: state.requirements.map((requirement) => ({
			status:
				requirement.status === "satisfied"
					? ("completed" as const)
					: requirement.status === "open"
						? ("pending" as const)
						: ("blocked" as const),
			label: requirement.text,
			meta: [
				requirement.id,
				requirement.evidenceIds.length > 0 ? `${requirement.evidenceIds.length} evidence` : undefined,
				requirement.boundLaneId ? `worker ${requirement.boundLaneId}` : undefined,
			].filter((value): value is string => value !== undefined),
			details: requirement.blockedReason ? [`blocked: ${requirement.blockedReason}`] : undefined,
		})),
		notices: [
			...(details.dispatchSkipReason
				? [{ status: "warning" as const, text: `Worker dispatch skipped: ${details.dispatchSkipReason}` }]
				: []),
			...(state.blockedReason ? [{ status: "warning" as const, text: state.blockedReason }] : []),
		],
		emptyText: "No requirements recorded.",
	};
}

export function createGoalToolDefinition(deps: GoalToolDependencies): ToolDefinition {
	const now = deps.now ?? (() => new Date().toISOString());
	return {
		name: "goal",
		label: "goal",
		description:
			"Read or update the compact durable goal record for explicitly requested long-running work. Planning belongs to task_steps, workers to delegate, and evidence to current tools/artifacts. Pause, resume, edit, clear, and budget stops are owner/system controlled.",
		promptSnippet: "Read or update the compact durable goal record.",
		promptGuidelines: [
			"Call action 'start' only when the user or system explicitly requests a persistent goal; that request may be ordinary chat and does not require a slash command. The host may already have admitted high-confidence chat wording, so use 'get' before starting when uncertain. Do not infer a goal from an ordinary multi-step task or replace an unfinished goal implicitly. Set tokenBudget only when the user explicitly requested a token budget.",
			"Use 'get' when the current objective or status is uncertain. Use task_steps for decomposition and delegate for workers; detailed ledger actions exist only for goals that already use the legacy ledger.",
			"Mark 'complete' only after current authoritative evidence proves the full objective and no required work remains. Mark 'block_goal' only after the same genuine impasse persists for three goal turns.",
		],
		parameters: goalSchema,
		renderShell: "self",
		renderCall() {
			return emptyOrchestrationCall();
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return emptyOrchestrationCall();
			const details = result.details as GoalToolDetails | undefined;
			if (!expanded && details?.applied) return emptyOrchestrationCall();
			return new OrchestrationPanelComponent(theme, goalPanelModel(details), true);
		},
		async execute(
			_toolCallId,
			input: GoalToolInput,
		): Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: GoalToolDetails;
		}> {
			if (input.action === "get") {
				const state = deps.getGoalState();
				if (!state) {
					return {
						content: [{ type: "text", text: "No goal exists for this session." }],
						details: { action: "get", applied: false },
					};
				}
				return {
					content: [{ type: "text", text: summarizeGoalState(state) }],
					details: { action: "get", applied: false, state },
				};
			}
			const mapped = toGoalAction(input);
			if ("error" in mapped) {
				return {
					content: [{ type: "text" as const, text: `goal ${input.action} failed: ${mapped.error}` }],
					details: { action: input.action, applied: false, error: mapped.error },
				};
			}

			let action: GoalAction = mapped;
			if (action.action === "add_evidence") {
				const verified = await resolveEvidenceVerified(action.kind, action.uri, deps);
				action = { ...action, verified };
			}
			// Honest dispatch reporting: distinguish "dispatched" (laneId), "declined" (skipReason --
			// the dependency IS wired but the underlying delegation starter refused, e.g. disabled or
			// already at capacity), and "unwired" (no dependency at all) -- never collapse a real
			// decline into a silent no-laneId no-op indistinguishable from the dep being absent.
			let dispatchNote: string | undefined;
			let dispatchSkipReason: string | undefined;
			// Indeterminate-binding dedupe guard: checked BEFORE any dispatch side effect, for BOTH
			// routes. A requirement already bound to a lane that is either still live (a plain
			// duplicate) or whose liveness/outcome cannot be determined at all (for example, a legacy
			// snapshot with no lane record or worker result) must never be
			// re-dispatched silently; only a CONFIRMED terminal outcome allows a legitimate retry.
			let dispatchGuardRefused = false;
			if (action.action === "dispatch_worker") {
				// Captured into a `const` so the "dispatch_worker" narrowing survives into the closures
				// below -- TS does not narrow a `let`-bound outer variable across a callback boundary.
				const dispatchAction = action;
				const boundRequirement = deps
					.getGoalState()
					?.requirements.find((r) => r.id === dispatchAction.requirementId);
				const bound = boundRequirement?.boundLaneId;
				if (bound !== undefined) {
					const boundLaneRecord = deps.getLaneRecords?.().find((record) => record.laneId === bound);
					const isLiveInFlight =
						boundLaneRecord !== undefined &&
						(boundLaneRecord.status === "queued" || boundLaneRecord.status === "running");
					if (isLiveInFlight) {
						dispatchSkipReason = "requirement_already_bound";
					} else {
						// `boundLaneRecord` present here is necessarily terminal (isLiveInFlight was false).
						const hasTerminalOutcome =
							boundLaneRecord !== undefined ||
							(deps.getWorkerClaimSnapshots?.().some((claim) => claim.requestId === bound) ?? false);
						if (!hasTerminalOutcome) dispatchSkipReason = "bound_lane_indeterminate";
					}
					if (dispatchSkipReason) {
						dispatchGuardRefused = true;
						dispatchNote = `No worker was dispatched (${dispatchSkipReason}); requirement '${dispatchAction.requirementId}' remains bound to lane '${bound}'.`;
					}
				}
			}
			if (action.action === "dispatch_worker" && !dispatchGuardRefused) {
				const useTmux = input.dispatchTarget === "tmux" && deps.dispatchTmuxWorker !== undefined;
				const dispatched = useTmux
					? await deps.dispatchTmuxWorker?.({
							requirementId: action.requirementId,
							instructions: action.instructions,
						})
					: deps.startWorkerDelegation?.({
							requirementId: action.requirementId,
							instructions: action.instructions,
						});
				action = { ...action, laneId: dispatched?.laneId };
				if (dispatched?.laneId) {
					dispatchNote = useTmux
						? `Dispatched tmux worker lane '${dispatched.laneId}' for requirement '${action.requirementId}'.`
						: `Dispatched in-process worker lane '${dispatched.laneId}' for requirement '${action.requirementId}' (tmux dispatch is not available from this tool yet).`;
				} else {
					const wired = useTmux ? deps.dispatchTmuxWorker : deps.startWorkerDelegation;
					dispatchSkipReason = dispatched?.skipReason ?? (wired ? "declined" : "dependency_unwired");
					dispatchNote = `No worker was dispatched (${dispatchSkipReason}); requirement '${action.requirementId}' is recorded but not bound to a lane.`;
				}
			}

			const current = deps.getGoalState();
			let nextState: GoalState;
			if (action.action === "dispatch_worker" && dispatchGuardRefused) {
				// Short-circuit: the guard refused before any dispatch attempt -- never call
				// applyGoalAction for this turn, so the requirement's existing `boundLaneId` is
				// preserved exactly as-is rather than clobbered to `undefined` by the reducer's
				// unconditional `boundLaneId: event.laneId` write (goal-state.ts's dispatch_worker case).
				// `current` is guaranteed defined here: the guard only refuses when a requirement with
				// a `boundLaneId` was found on it.
				nextState = current as GoalState;
			} else {
				const result = applyGoalAction(current, action, now(), {
					requireVerifiedEvidenceForCompletion: deps.requireVerifiedEvidenceForCompletion?.() ?? true,
				});
				if (!result.ok) {
					return {
						content: [{ type: "text" as const, text: `goal ${input.action} failed: ${result.error}` }],
						details: { action: input.action, applied: false, error: result.error, state: current },
					};
				}
				deps.saveGoalState(result.state, current ? getGoalStateRevision(current) : undefined);
				nextState = result.state;
			}

			const summary = summarizeGoalState(nextState, { action, openTaskSteps: deps.getOpenTaskSteps?.() });
			const text = dispatchNote
				? `goal ${input.action} recorded.\n${summary}\n${dispatchNote}`
				: `goal ${input.action} recorded.\n${summary}`;
			return {
				content: [{ type: "text" as const, text }],
				details: {
					action: input.action,
					applied: true,
					state: nextState,
					...(action.action === "dispatch_worker" && action.laneId ? { dispatchedLaneId: action.laneId } : {}),
					...(action.action === "dispatch_worker" && !action.laneId ? { dispatchSkipReason } : {}),
				},
			};
		},
	};
}
