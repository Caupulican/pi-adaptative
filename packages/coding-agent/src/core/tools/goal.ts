import { createHash, randomUUID } from "node:crypto";
import { stat as fsStat } from "node:fs/promises";
import { type Static, Type } from "typebox";
import type { WorkerClaim } from "../autonomy/contracts.ts";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import type { BackgroundToolTaskRef } from "../background-tool-task-controller.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { type GoalStateRevision, getGoalStateRevision } from "../goals/goal-lifecycle.ts";
import { type GoalEvidenceKind, type GoalState, type GoalStatus, isGoalExecutionActive } from "../goals/goal-state.ts";
import {
	applyGoalAction,
	type GoalAction,
	type GoalActionName,
	type OpenTaskStepRef,
	summarizeGoalState,
} from "../goals/goal-tool-core.ts";
import { GOAL_LIFECYCLE_TOOL_NAMES, LEGACY_GOAL_TOOL_NAME } from "../goals/goal-tool-names.ts";
import {
	emptyOrchestrationCall,
	goalEvidencePanelRow,
	goalRequirementPanelRow,
	type OrchestrationPanelModel,
	renderOrchestrationToolResult,
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
				Type.Literal("increment"),
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
				description: "Requirement id for requirement actions. Omit on add_requirement for a stable host id.",
			}),
		),
		text: Type.Optional(Type.String({ description: "Requirement text. Required for add_requirement." })),
		dependencies: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Optional IDs of requirements that must be satisfied before this one. Valid for add_requirement.",
			}),
		),
		instructions: Type.Optional(Type.String({ description: "Worker instructions. Required for dispatch_worker." })),
		evidenceId: Type.Optional(
			Type.String({ description: "Evidence id. Omit on add_evidence for a stable host id." }),
		),
		evidenceIds: Type.Optional(
			Type.Array(Type.String(), {
				description: "Existing evidence ids for satisfy_requirement.",
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
					"Evidence locator that verifies it: file -> a path under cwd; tool or test -> the toolCallId of the call that produced it; worker -> a laneId. Only verified or user evidence can satisfy a requirement; finding never verifies.",
			}),
		),
		reason: Type.Optional(Type.String({ description: "Reason for block_requirement or block_goal." })),
		dispatchTarget: Type.Optional(
			Type.Union([Type.Literal("in_process"), Type.Literal("tmux")], {
				description: "Legacy target. Native is default; use tmux when the task benefits from a persistent pane.",
			}),
		),
	},
	{ additionalProperties: false },
);

const createGoalSchema = Type.Object(
	{
		objective: Type.String({ description: "Required. The concrete objective to start pursuing." }),
		requirements: Type.Optional(
			Type.Array(Type.String({ minLength: 1 }), {
				minItems: 1,
				maxItems: 20,
				description:
					"Every requirement the goal must satisfy, recorded in this same call with stable host ids. Prefer this over adding them one call at a time afterwards.",
			}),
		),
		token_budget: Type.Optional(
			Type.Integer({ minimum: 1, description: "Positive token budget. Omit unless explicitly requested." }),
		),
	},
	{ additionalProperties: false },
);

const getGoalSchema = Type.Object({}, { additionalProperties: false });

const updateGoalSchema = Type.Object(
	{
		status: Type.Union([Type.Literal("active"), Type.Literal("complete"), Type.Literal("blocked")], {
			description:
				"Set active after concrete progress, complete after an evidence audit, or blocked after the same blocker persists for three turns.",
		}),
		reason: Type.Optional(
			Type.String({ minLength: 1, description: "Required for blocked: the recurring external blocker." }),
		),
	},
	{ additionalProperties: false },
);

export type GoalToolInput = Static<typeof goalSchema>;
export type GoalToolDefinition = ToolDefinition;

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
	 * (the `uri` is a laneId) at add_evidence time and refusing completion while goal-owned work is
	 * queued or running. Read-defensive: when not wired -- exactly like `hasToolCallId` -- a "worker"
	 * ref cannot be proven and is recorded as `verified: false` rather than assumed true.
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
	/** Live background tool_task records for kind:"tool" evidence and complete-time re-check. */
	getBackgroundToolTasks?: () => readonly BackgroundToolTaskRef[];
	/** Active ICM pipeline run for the complete/increment join. */
	getActivePipeline?: () => { runId: string; pipelineName: string; goalId?: string; status: string } | undefined;
	/** Model-facing budget normalization for the current foreground turn. Omitted by direct owner/test callers. */
	authorizeStart?: (input: Pick<GoalToolInput, "userGoal" | "tokenBudget">) => string | number | null | undefined;
	/**
	 * Trusted verification obligations reconstructed from the active session context. A model-facing
	 * transition to completed is refused while any remain; ordinary goal and tool actions do not
	 * consult this gate.
	 */
	getActiveVerificationIds?: () => readonly string[];
	/**
	 * Live tool-evidence check. When wired, kind:"tool" uses this instead of {@link hasToolCallId}
	 * so a still-running background handoff cannot verify as done.
	 */
	resolveToolEvidence?: (uri: string) => boolean | { verified: boolean; toolCallId?: string };
}

function allowsNativeTmuxFallback(reason: string | undefined): boolean {
	return reason === "tmux_unavailable" || reason === "tmux_extension_not_loaded";
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
): Promise<{ verified: boolean | undefined; uri?: string }> {
	const trimmedUri = uri?.trim();
	if (!trimmedUri) return { verified: undefined };
	// A test run is proven by the tool call that ran it, exactly like any other tool evidence.
	// Measured live: a model recorded its passing test run as kind "test" with a command string as
	// the locator, which could never verify, then failed satisfy_requirement, complete and increment
	// in a row without being told why. A locator that is the command text rather than the call id
	// resolves to the call that ran it, and the record then carries the real id.
	if (kind === "tool" || kind === "test") {
		if (deps.resolveToolEvidence) {
			const resolved = deps.resolveToolEvidence(trimmedUri);
			if (typeof resolved === "boolean") return { verified: resolved };
			return { verified: resolved.verified, ...(resolved.toolCallId ? { uri: resolved.toolCallId } : {}) };
		}
		return { verified: deps.hasToolCallId ? deps.hasToolCallId(trimmedUri) : false };
	}
	if (kind === "file") {
		const cwd = deps.cwd?.() ?? process.cwd();
		try {
			const stats = await fsStat(resolveToCwd(trimmedUri, cwd));
			return { verified: stats.isFile() };
		} catch {
			return { verified: false };
		}
	}
	if (kind === "worker") {
		if (!deps.getLaneRecords || !deps.getWorkerClaimSnapshots) return { verified: false };
		const laneId = trimmedUri;
		const record = deps.getLaneRecords().find((candidate) => candidate.laneId === laneId);
		if (!record) return { verified: false };
		const claim = deps.getWorkerClaimSnapshots().find((candidate) => candidate.requestId === laneId);
		if (!claim) return { verified: false };
		// An unreviewed mutation (parentReviewRequired && no parentReviewedAt) can never verify true --
		// this is what stops an unreviewed worker completion from ungating goal completion through
		// the existing verified/complete gate (goal-tool-core's isVerifiedOrUserEvidence/complete).
		if (claim.parentReviewRequired === true && claim.parentReviewedAt === undefined) return { verified: false };
		return { verified: claim.status === "completed" };
	}
	return { verified: undefined };
}

/**
 * Why a recorded evidence entry did not verify, and what would. An unverified entry cannot satisfy
 * a requirement, so saying only "unverified" left the model to guess (measured live: three failed
 * goal calls in a row after a test run recorded with a command string as its locator).
 */
function unverifiedEvidenceReason(kind: GoalEvidenceKind): string {
	switch (kind) {
		case "tool":
		case "test":
			return `it cannot satisfy a requirement; set uri to the toolCallId of the call that produced it`;
		case "file":
			return "it cannot satisfy a requirement; set uri to a path under cwd that exists";
		case "worker":
			return "it cannot satisfy a requirement; set uri to a completed, reviewed worker laneId";
		default:
			return "a finding never verifies and cannot satisfy a requirement; cite tool, test, file, or worker evidence instead";
	}
}

function generatedGoalRecordId(prefix: "req" | "ev", value: unknown): string {
	return `${prefix}-${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16)}`;
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
			return {
				action: "add_requirement",
				requirementId:
					input.requirementId ??
					generatedGoalRecordId("req", {
						text: input.text?.trim() ?? "",
						dependencies: [...(input.dependencies ?? [])].map((value) => value.trim()).sort(),
					}),
				text: input.text ?? "",
				dependencies: input.dependencies,
			};
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
				evidenceId:
					input.evidenceId ??
					generatedGoalRecordId("ev", {
						kind,
						summary: input.summary?.trim() ?? "",
						uri: input.uri?.trim() ?? "",
					}),
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
		case "increment":
			return { action: "increment" };
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
		description: state.userGoal,
		wrapRows: true,
		rows: [...state.requirements.map(goalRequirementPanelRow), ...state.evidence.map(goalEvidencePanelRow)],
		notices: [
			...(details.dispatchSkipReason
				? [{ status: "warning" as const, text: `Worker dispatch skipped: ${details.dispatchSkipReason}` }]
				: []),
			...(state.blockedReason ? [{ status: "warning" as const, text: state.blockedReason }] : []),
		],
		emptyText: "No requirements recorded.",
	};
}

function goalExecutionError(
	action: GoalToolDetails["action"],
	message: string,
	state: GoalState | undefined,
): { content: Array<{ type: "text"; text: string }>; details: GoalToolDetails; isError: true } {
	return {
		content: [{ type: "text", text: `goal ${action} failed: ${message}` }],
		details: { action, applied: false, error: message, state },
		isError: true,
	};
}

export function createGoalToolDefinition(deps: GoalToolDependencies): GoalToolDefinition {
	const now = deps.now ?? (() => new Date().toISOString());
	return {
		name: LEGACY_GOAL_TOOL_NAME,
		label: "goal",
		description:
			"Read or update the durable goal for work that benefits from persistent autonomous continuation. The agent may start one at its discretion or on explicit user/system request; only the owner or system may set a token budget.",
		promptSnippet: "Read or update the durable goal.",
		promptGuidelines: [
			"Start when persistent continuation materially benefits current work or the user/system requests it. Skip routine one-turn tasks; get if uncertain; never replace unfinished goal; tokenBudget only if requested.",
			"After bounded read-only survey, make the project-relative delivery contract explicit in the goal requirements: POC/MVP proves the requested capability; complete means full integration across affected project surfaces.",
			"Plans: task_steps. Workers: delegate. Background tools: tool_task wait once; cite taskId as kind=tool evidence.",
			"increment satisfies the current open requirement from unused evidence, or completes when none remain.",
			"complete needs current authoritative evidence, no remaining work, no active goal-owned lanes, no open task_steps, no goal-owned or cited running tool_task, and no active pipeline. Failed or canceled tool_task results are terminal and stop blocking liveness, but never become verified evidence automatically. block_requirement/block_goal only when the same verified owner/approval boundary or capability impossibility persists for 3 consecutive no-progress goal turns despite distinct recovery approaches, and no meaningful progress is possible without owner input or external change; otherwise keep working.",
		],
		parameters: goalSchema,
		renderShell: "self",
		renderCall() {
			return emptyOrchestrationCall();
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as GoalToolDetails | undefined;
			return renderOrchestrationToolResult(theme, goalPanelModel(details), {
				isPartial,
				collapse: !expanded && details?.applied === true,
				expanded,
			});
		},
		async execute(
			_toolCallId,
			input: GoalToolInput,
		): Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: GoalToolDetails;
			isError?: boolean;
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
			let normalizedInput = input;
			if (input.action === "start" && deps.authorizeStart) {
				const authority = deps.authorizeStart(input);
				if (typeof authority === "string") {
					return {
						content: [{ type: "text", text: `goal start failed: ${authority}` }],
						details: { action: "start", applied: false, error: authority },
						isError: true,
					};
				}
				normalizedInput = {
					...input,
					...(typeof authority === "number" ? { tokenBudget: authority } : {}),
				};
				if (authority === null) delete normalizedInput.tokenBudget;
			}
			const mapped = toGoalAction(normalizedInput);
			if ("error" in mapped) {
				return {
					content: [{ type: "text" as const, text: `goal ${input.action} failed: ${mapped.error}` }],
					details: { action: input.action, applied: false, error: mapped.error },
					isError: true,
				};
			}

			let action: GoalAction = mapped;
			if (action.action === "add_evidence") {
				const resolved = await resolveEvidenceVerified(action.kind, action.uri, deps);
				action = { ...action, verified: resolved.verified, ...(resolved.uri ? { uri: resolved.uri } : {}) };
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
				const tmuxRequested = input.dispatchTarget === "tmux";
				let useTmux = tmuxRequested && deps.dispatchTmuxWorker !== undefined;
				let tmuxFallbackReason: string | undefined;
				let dispatched: { laneId?: string; skipReason?: string } | undefined;
				if (useTmux) {
					dispatched = await deps.dispatchTmuxWorker?.({
						requirementId: action.requirementId,
						instructions: action.instructions,
					});
					if (
						!dispatched?.laneId &&
						allowsNativeTmuxFallback(dispatched?.skipReason) &&
						deps.startWorkerDelegation
					) {
						tmuxFallbackReason = dispatched?.skipReason;
						useTmux = false;
						dispatched = deps.startWorkerDelegation({
							requirementId: action.requirementId,
							instructions: action.instructions,
						});
					}
				} else {
					if (tmuxRequested) tmuxFallbackReason = "tmux_extension_not_loaded";
					dispatched = deps.startWorkerDelegation?.({
						requirementId: action.requirementId,
						instructions: action.instructions,
					});
				}
				action = { ...action, laneId: dispatched?.laneId };
				if (dispatched?.laneId) {
					dispatchNote = tmuxFallbackReason
						? `Tmux route returned ${tmuxFallbackReason}; dispatched native fallback worker lane '${dispatched.laneId}' for requirement '${action.requirementId}'.`
						: useTmux
							? `Dispatched tmux worker lane '${dispatched.laneId}' for requirement '${action.requirementId}'.`
							: `Dispatched in-process worker lane '${dispatched.laneId}' for requirement '${action.requirementId}' (native default).`;
				} else {
					const wired = useTmux ? deps.dispatchTmuxWorker : deps.startWorkerDelegation;
					dispatchSkipReason = dispatched?.skipReason ?? (wired ? "declined" : "dependency_unwired");
					dispatchNote = `${tmuxFallbackReason ? `Tmux route returned ${tmuxFallbackReason}; ` : ""}No worker was dispatched (${dispatchSkipReason}); requirement '${action.requirementId}' is recorded but not bound to a lane.`;
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
				let activePipeline: ReturnType<NonNullable<GoalToolDependencies["getActivePipeline"]>>;
				let activeGoalLaneIds: string[] | undefined;
				if (
					current &&
					isGoalExecutionActive(current.status) &&
					(action.action === "complete" || action.action === "increment")
				) {
					try {
						const boundLaneIds = new Set(
							current.requirements.flatMap((requirement) =>
								requirement.boundLaneId ? [requirement.boundLaneId] : [],
							),
						);
						activeGoalLaneIds = deps
							.getLaneRecords?.()
							.filter(
								(record) =>
									(record.status === "queued" || record.status === "running") &&
									(record.goalId === current.goalId || boundLaneIds.has(record.laneId)),
							)
							.map((record) => record.laneId);
					} catch (error) {
						const message = `Cannot verify active goal-owned lane state: ${error instanceof Error ? error.message : String(error)}`;
						return goalExecutionError(input.action, message, current);
					}
					try {
						activePipeline = deps.getActivePipeline?.();
					} catch (error) {
						const message = `Cannot verify active pipeline state: ${error instanceof Error ? error.message : String(error)}`;
						return goalExecutionError(input.action, message, current);
					}
				}
				const result = applyGoalAction(current, action, now(), {
					requireVerifiedEvidenceForCompletion: deps.requireVerifiedEvidenceForCompletion?.() ?? true,
					openTaskSteps: deps.getOpenTaskSteps?.(),
					backgroundToolTasks: deps.getBackgroundToolTasks?.(),
					activePipeline,
					activeGoalLaneIds,
				});
				if (!result.ok) {
					return {
						content: [{ type: "text" as const, text: `goal ${input.action} failed: ${result.error}` }],
						details: { action: input.action, applied: false, error: result.error, state: current },
						isError: true,
					};
				}
				if (result.state.status === "completed") {
					let activeVerificationIds: readonly string[];
					try {
						activeVerificationIds = deps.getActiveVerificationIds?.() ?? [];
					} catch (error) {
						const message = `Cannot verify active verification obligations: ${error instanceof Error ? error.message : String(error)}`;
						return goalExecutionError(input.action, message, current);
					}
					if (activeVerificationIds.length > 0) {
						return goalExecutionError(
							input.action,
							`Cannot transition goal to ${result.state.status}: active verification obligation(s) remain (${activeVerificationIds.join(", ")}). The same verification id must report status passed first.`,
							current,
						);
					}
				}
				deps.saveGoalState(result.state, current ? getGoalStateRevision(current) : undefined);
				nextState = result.state;
			}

			const summary = summarizeGoalState(nextState, { action, openTaskSteps: deps.getOpenTaskSteps?.() });
			const evidenceNote =
				action.action === "add_evidence"
					? `Evidence '${action.evidenceId}' recorded (${action.kind === "user" ? "user-confirmed" : action.verified === true ? `verified${action.uri && action.uri !== input.uri?.trim() ? ` via toolCallId ${action.uri}` : ""}` : `unverified: ${unverifiedEvidenceReason(action.kind)}`}).`
					: "";
			const text = [`goal ${input.action} recorded.`, evidenceNote, summary, dispatchNote]
				.filter((line): line is string => Boolean(line))
				.join("\n");
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

/**
 * Build the compact Codex-compatible lifecycle surface as adapters over the authoritative legacy
 * goal executor. The wrappers own no state and duplicate no validation, persistence, accounting,
 * completion gate, or start-authority rule.
 */
export function createGoalLifecycleToolDefinitions(goalTool: GoalToolDefinition) {
	const createGoal: ToolDefinition = {
		name: GOAL_LIFECYCLE_TOOL_NAMES[0],
		label: GOAL_LIFECYCLE_TOOL_NAMES[0],
		description:
			"Create a durable goal when persistent autonomous continuation materially benefits the current work, or when the user/system explicitly requests one. Use agent discretion; skip routine short tasks. Pass every known requirement in `requirements` so the goal is fully set up in this one call, then record task steps with one task_steps set. Set token_budget only when explicitly requested. Fails if an unfinished goal exists.",
		promptSnippet: "Start durable goal.",
		parameters: createGoalSchema,
		async execute(toolCallId, input: Static<typeof createGoalSchema>, signal, onUpdate, context) {
			const goalId = `goal-${randomUUID()}`;
			const started = await goalTool.execute(
				toolCallId,
				{ action: "start", goalId, userGoal: input.objective, tokenBudget: input.token_budget },
				signal,
				onUpdate,
				context,
			);
			if (started.isError || !input.requirements?.length) return started;
			// Each requirement goes through the same executor in order, so ids, validation and
			// journaling are exactly what one call per requirement produced; the last result renders
			// the whole goal. Before this, setting up a goal cost one provider round trip per requirement.
			let last = started;
			for (const text of input.requirements) {
				last = await goalTool.execute(
					toolCallId,
					{ action: "add_requirement", goalId, text },
					signal,
					onUpdate,
					context,
				);
				if (last.isError) return last;
			}
			return last;
		},
	};

	const getGoal: ToolDefinition = {
		name: GOAL_LIFECYCLE_TOOL_NAMES[1],
		label: GOAL_LIFECYCLE_TOOL_NAMES[1],
		description:
			"Get the current goal for this session, including status, budget, token and elapsed-time usage, requirements, evidence, and progress.",
		promptSnippet: "Inspect durable goal.",
		parameters: getGoalSchema,
		execute(toolCallId, _input, signal, onUpdate, context) {
			return goalTool.execute(toolCallId, { action: "get" }, signal, onUpdate, context);
		},
	};

	const updateGoal: ToolDefinition = {
		name: GOAL_LIFECYCLE_TOOL_NAMES[2],
		label: GOAL_LIFECYCLE_TOOL_NAMES[2],
		description:
			"Update the existing goal. Set active only after concrete, verifiable progress in the current turn. Mark complete only when current evidence proves the full objective is achieved and no required work remains. Mark blocked only when the same verified owner/approval boundary or capability impossibility persists for at least three consecutive no-progress goal turns despite distinct recovery approaches, and no meaningful progress is possible without owner input or external change; include the evidence and attempted approaches in reason. Never use blocked merely because work is hard, slow, uncertain, incomplete, or would benefit from clarification.",
		promptSnippet: "Update goal; complete/block only with evidence.",
		parameters: updateGoalSchema,
		execute(toolCallId, input: Static<typeof updateGoalSchema>, signal, onUpdate, context) {
			const requestedGoalStatus: GoalStatus = input.status === "complete" ? "completed" : input.status;
			const action: GoalToolInput = isGoalExecutionActive(requestedGoalStatus)
				? { action: "progress" }
				: input.status === "complete"
					? { action: "complete" }
					: { action: "block_goal", reason: input.reason ?? "" };
			return goalTool.execute(toolCallId, action, signal, onUpdate, context);
		},
	};

	return [createGoal, getGoal, updateGoal] as const;
}
