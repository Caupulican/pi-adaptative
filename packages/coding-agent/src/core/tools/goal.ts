import { createHash, randomUUID } from "node:crypto";
import { type Static, Type } from "typebox";
import type { WorkerClaim } from "../autonomy/contracts.ts";
import { EDGE_CLASSES, type EdgeClass, isEdgeClass } from "../autonomy/edge-policy.ts";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import type { BackgroundToolTaskRef } from "../background-tool-task-controller.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { type GoalFileEvidenceResolver, resolveNativeGoalFileEvidence } from "../goals/file-evidence.ts";
import {
	type GoalStateRevision,
	getGoalStateRevision,
	resolveGoalEvidenceCommitState,
} from "../goals/goal-lifecycle.ts";
import {
	applyGoalEvent,
	type GoalEvidenceKind,
	type GoalEvidenceOutcome,
	type GoalState,
	type GoalStatus,
	isGoalExecutionActive,
	MAX_GOAL_OBJECTIVE_LENGTH,
	type RequirementCheck,
} from "../goals/goal-state.ts";
import {
	applyGoalAction,
	formatGoalRecoveryCatalogs,
	type GoalAction,
	type GoalActionName,
	type OpenTaskStepRef,
	summarizeGoalState,
} from "../goals/goal-tool-core.ts";
import { GOAL_LIFECYCLE_TOOL_NAMES, LEGACY_GOAL_TOOL_NAME } from "../goals/goal-tool-names.ts";
import { describeRequirementCheckRefusal, proveRequirementChecks } from "../goals/prove-requirement-checks.ts";
import { type RequirementCheckResult, requirementCheckViolation } from "../goals/requirement-checks.ts";
import { awaitPreflight } from "../preflight.ts";
import { requestsBugFix } from "../system-one/bug-fix.ts";
import type { SystemOneController } from "../system-one/controller.ts";
import {
	emptyOrchestrationCall,
	goalEvidencePanelRow,
	goalRequirementPanelRow,
	type OrchestrationPanelModel,
	renderOrchestrationToolResult,
} from "./orchestration-panel.ts";

/** How the harness proves a requirement: an observational command it reruns at completion. */
const requirementCheckSchema = Type.Object(
	{
		command: Type.String({
			minLength: 1,
			description:
				"Read-only shell command that observes the outcome (test, command -v, ss, systemctl is-active, jq, grep, curl GET, a test runner run). It must not change anything.",
		}),
		expectExitCode: Type.Optional(
			Type.Integer({ description: "Exit code that means the requirement holds. Default 0." }),
		),
		outputContains: Type.Optional(Type.String({ description: "Text the output must contain." })),
		outputExcludes: Type.Optional(Type.String({ description: "Text the output must not contain." })),
	},
	{
		additionalProperties: false,
		description:
			"add_requirement / set_requirement_check: how the harness proves this requirement. At completion it reruns the command and a failed check refuses completion; the agent's own account never substitutes for it. Omit on set_requirement_check to remove the check.",
	},
);

const goalSchema = Type.Object(
	{
		action: Type.Union(
			[
				Type.Literal("get"),
				Type.Literal("start"),
				Type.Literal("add_requirement"),
				Type.Literal("set_requirement_check"),
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
				Type.Literal("grant_edge"),
				Type.Literal("amend_goal"),
			],
			{ description: "Goal record action." },
		),
		edgeClass: Type.Optional(
			Type.Union(
				EDGE_CLASSES.map((edgeClass) => Type.Literal(edgeClass)),
				{ description: "grant_edge: authorized operation class." },
			),
		),
		toolkitScript: Type.Optional(
			Type.String({
				description:
					"grant_edge: exact registered canonical script name or unambiguous alias when the operator authorized one concrete toolkit script. Omit for broad class grant.",
			}),
		),
		toolkitArgs: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"grant_edge: exact argv passed to the authorized toolkit script (default []). Requires toolkitScript.",
			}),
		),
		quote: Type.Optional(
			Type.String({
				description:
					"grant_edge / amend_goal: the owner's complete message, verbatim (a paraphrase or part of a message grants and amends nothing).",
			}),
		),
		goalId: Type.Optional(Type.String({ description: "Stable goal id. Required for action 'start'." })),
		userGoal: Type.Optional(
			Type.String({
				description:
					"The goal statement. Required for 'start' and 'amend_goal'; for 'amend_goal', the objective rewritten to include what the owner's quoted message adds or changes.",
			}),
		),
		tokenBudget: Type.Optional(
			Type.Integer({ minimum: 1, description: "Optional positive token budget for action 'start'." }),
		),
		requirementId: Type.Optional(
			Type.String({
				description:
					"Requirement id for requirement actions. Omit on add_requirement for a stable host id. On add_evidence, the requirement this evidence satisfies once it verifies.",
			}),
		),
		requirementIds: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"On add_evidence, every requirement this evidence satisfies once it verifies. On satisfy_requirement, every requirement the cited evidence satisfies (all or none).",
			}),
		),
		text: Type.Optional(Type.String({ description: "Requirement text. Required for add_requirement." })),
		dependencies: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Optional IDs of requirements that must be satisfied before this one. Valid for add_requirement.",
			}),
		),
		check: Type.Optional(requirementCheckSchema),
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
					"Evidence locator: file -> path; tool or test -> producing toolCallId or exact command; worker -> laneId; user -> user-message entry id and summary quoting its complete text. Only host-verified evidence can satisfy a requirement; finding never verifies.",
			}),
		),
		reason: Type.Optional(Type.String({ description: "Reason for block_requirement or block_goal." })),
		dispatchTarget: Type.Optional(
			Type.Union([Type.Literal("in_process"), Type.Literal("collaboration")], {
				description:
					"Native is default; use collaboration when the task benefits from a persistent interactive session.",
			}),
		),
	},
	{ additionalProperties: false },
);

const createGoalSchema = Type.Object(
	{
		objective: Type.String({ description: "Required. The concrete objective to start pursuing." }),
		requirements: Type.Optional(
			Type.Array(
				Type.Union([
					Type.String({ minLength: 1 }),
					Type.Object(
						{ text: Type.String({ minLength: 1 }), check: Type.Optional(requirementCheckSchema) },
						{ additionalProperties: false },
					),
				]),
				{
					minItems: 1,
					maxItems: 20,
					description:
						"Every requirement the goal must satisfy, recorded in this same call with stable host ids. A requirement whose outcome a command can observe should carry `check`: the harness reruns it at completion and a failed check refuses completion.",
				},
			),
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
				"active records progress only; it does not change lifecycle or resume a blocked goal. complete requires an evidence audit; blocked requires the same blocker for three turns.",
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
	action: GoalActionName | "get" | "grant_edge" | "amend_goal";
	applied: boolean;
	error?: string;
	state?: GoalState;
	/** Set on 'grant_edge': the class the operator's words granted, and the message they came from. */
	edgeClass?: EdgeClass;
	messageEntryId?: string;
	/** Set on 'grant_edge' when a narrow toolkit operation scope was resolved and granted. */
	scopeKey?: string;
	/** Set on 'dispatch_worker' when a worker lane actually started; mirrors the requirement's
	 * new `boundLaneId`. The in-process route by default, or a real persistent collaboration lane when
	 * `dispatchTarget:"collaboration"` was selected and routed -- see {@link GoalToolDependencies.dispatchCollaborationWorker}. */
	dispatchedLaneId?: string;
	/** Set on 'dispatch_worker' when no worker was dispatched: a wired dependency declined (e.g. worker
	 * delegation disabled, already at capacity, or an honest collaboration skip reason -- see
	 * {@link GoalToolDependencies.dispatchCollaborationWorker}), or the indeterminate-binding guard refused a
	 * re-dispatch against an already-bound requirement (`requirement_already_bound`/`bound_lane_indeterminate`).
	 * The binding is recorded (or, for a guard refusal, left exactly as it was) with no NEW laneId. */
	dispatchSkipReason?: string;
	/**
	 * Set on a completion that reran requirement checks: how many passed and failed in this call.
	 * A receipt key, so it survives the retention stub that replaces the (large) goal state.
	 */
	piReceipts?: { requirementChecks: GoalCheckRuns };
}

export interface GoalCheckRuns {
	passed: number;
	failed: number;
}

export type GoalToolEvidenceResolution =
	| { verified: true; toolCallId: string; outcome: GoalEvidenceOutcome }
	| { verified: false; reason: string };

export type GoalUserEvidenceResolution =
	| { verified: true; messageEntryId: string }
	| { verified: false; reason: string };

export interface GoalToolDependencies {
	/** Read the latest persisted goal state for the active session. */
	getGoalState: () => GoalState | undefined;
	/** Persist a new goal state snapshot to the active session. */
	saveGoalState: (state: GoalState, expected?: GoalStateRevision) => void;
	/** Clock injection for deterministic tests. */
	now?: () => string;
	/**
	 * Read the session's live worker lane records, for validating kind:"worker" evidence refs
	 * (the `uri` is a laneId) at add_evidence time and refusing completion while goal-owned work is
	 * queued or running. Read-defensive: when not wired, a "worker"
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
	 * (the default) or when {@link dispatchCollaborationWorker} is not wired: dispatches a real in-process
	 * worker lane for the given requirement and returns the resulting laneId to bind onto it. When
	 * the dependency is present but the underlying delegation starter declines (disabled, already at
	 * capacity, etc.), return `{ skipReason }` instead of a laneId -- a real, non-silent skip that
	 * the tool response surfaces, distinct from this dependency being altogether unwired (`undefined`
	 * dep, or the dep returning `undefined`), which records the binding attempt structurally with no
	 * laneId (a no-op).
	 */
	startWorkerDelegation?: (
		args: {
			requirementId: string;
			instructions: string;
		},
		signal?: AbortSignal,
	) =>
		| { laneId?: string; skipReason?: string }
		| undefined
		| Promise<{ laneId?: string; skipReason?: string } | undefined>;
	/**
	 * Tool-layer side effect for a 'dispatch_worker' action when `input.dispatchTarget === "collaboration"`:
	 * dispatches a REAL persistent collaboration worker via the pi_collaboration extension's `fire_task`
	 * action (core invokes the same tool call the model would make; no faked launch or laneId -- see
	 * `collaboration-dispatch.ts`'s `dispatchCollaborationWorker`). Selected ONLY when
	 * BOTH `input.dispatchTarget === "collaboration"` AND this dependency is present; otherwise the EXISTING
	 * {@link startWorkerDelegation} in-process path runs, byte-identical to before this field existed.
	 * The honest skip-reason vocabulary this can return: `collaboration_extension_not_loaded`,
	 * `collaboration_dispatch_failed`, `collaboration_dispatch_incomplete`, `lane_correlation_failed`,
	 * `worktree_create_failed` (worktree-sync is enabled but the lane-first `create_lane` call was
	 * refused -- e.g. max lanes reached -- so no fire_task call was ever attempted),
	 * `worker_capability_insufficient` (the model is sub-full class, has an unknown context window,
	 * does not advertise a native tool-call path, or is graded-demoted to text-protocol/none -- see
	 * `model-capability.ts`'s `evaluateLaneWorkerRefusal`; this is the parent's best-effort check
	 * only, refused before any lane/pane side effect -- the dispatched child still refuses
	 * authoritatively at its own startup regardless).
	 */
	dispatchCollaborationWorker?: (args: {
		requirementId: string;
		instructions: string;
	}) => Promise<{ laneId?: string; skipReason?: string }>;
	/** Working directory for resolving kind:"file" evidence ref paths. Defaults to `process.cwd()`. */
	cwd?: () => string;
	/** Non-native file evidence never falls back to the operator's filesystem or directory. */
	resolveFileEvidence?: GoalFileEvidenceResolver;
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
	 * grant_edge: record that the operator's instructions cover an edge class. Only called after the
	 * quote resolved verbatim to a user message; absent when the host has no edge (tests, SDK).
	 */
	grantEdge?: (grant: { class: EdgeClass; quote: string; messageEntryId: string; scopeKey?: string }) => void;
	/** System One semantic control plane controller for two-stage completion validation. */
	getSystemOneController?: () => SystemOneController | undefined;
	/** Where requirement checks run and are validated: the session's task directory. */
	getCwd?: () => string;
	/**
	 * Rerun one requirement check. Wired by the host to {@link runRequirementCheck}; when absent,
	 * completion cannot prove checked requirements and refuses rather than skipping their checks.
	 */
	runRequirementCheck?: (check: RequirementCheck, signal?: AbortSignal) => Promise<RequirementCheckResult>;
	/** Hand one decision to the owner (the session's owner items); used once per unchanged refusal. */
	deliverToOwner?: (items: readonly string[]) => void;
	/**
	 * Narrow operation scope resolver for toolkit.script grants. Resolves registered script name
	 * and exact argv to an internal scope key using host registry and execution context.
	 */
	resolveToolkitScriptScope?: (script: string, args: readonly string[]) => { scopeKey: string } | { error: string };
	/**
	 * Resolve the producing call and its authoritative outcome on the active branch. Test evidence
	 * additionally requires a trusted passing verification receipt; answered calls alone are not proof.
	 */
	resolveToolEvidence?: (uri: string, kind: "tool" | "test") => GoalToolEvidenceResolution;
	/** Verify an exact user statement against the active branch, never from the model-selected kind. */
	resolveUserEvidence?: (summary: string, uri?: string) => GoalUserEvidenceResolution;
}

/**
 * Validate an evidence ref's `uri` against session records ("tool") or the filesystem ("file").
 * Returns `undefined` for kinds/refs that carry nothing checkable (e.g. "finding",
 * or a missing `uri`) -- absence of a ref is not the same as a ref that failed to verify.
 */
async function resolveEvidenceVerified(
	kind: GoalEvidenceKind,
	uri: string | undefined,
	summary: string,
	deps: GoalToolDependencies,
	signal?: AbortSignal,
): Promise<{ verified: boolean | undefined; uri?: string; reason?: string; outcome?: GoalEvidenceOutcome }> {
	if (kind === "file" && uri) {
		return awaitPreflight(
			() =>
				deps.resolveFileEvidence
					? deps.resolveFileEvidence(uri, signal)
					: resolveNativeGoalFileEvidence(uri, deps.cwd?.() ?? process.cwd(), signal),
			signal,
		);
	}
	if (kind === "user") {
		const resolved = deps.resolveUserEvidence?.(summary, uri);
		if (!resolved) return { verified: false, reason: "user-statement verification is unavailable" };
		return resolved.verified
			? { verified: true, uri: `user-message:${resolved.messageEntryId}` }
			: { verified: false, reason: resolved.reason };
	}
	const trimmedUri = uri?.trim();
	if (!trimmedUri) return { verified: undefined };
	if (kind === "tool" || kind === "test") {
		const resolved = deps.resolveToolEvidence?.(trimmedUri, kind);
		if (!resolved) return { verified: false, reason: "session evidence verification is unavailable" };
		return resolved.verified
			? { verified: true, uri: resolved.toolCallId, outcome: resolved.outcome }
			: { verified: false, reason: resolved.reason };
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
				...(input.check ? { check: input.check } : {}),
			};
		case "set_requirement_check":
			return {
				action: "set_requirement_check",
				requirementId: input.requirementId ?? "",
				...(input.check ? { check: input.check } : {}),
			};
		case "satisfy_requirement":
			return {
				action: "satisfy_requirement",
				// The first requirement named; the rest are satisfied by the same call (requestedRequirementIds).
				requirementId: input.requirementId?.trim() || input.requirementIds?.find((id) => id.trim())?.trim() || "",
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

/** Rerun a goal's requirement checks through the session's host deps and phrase any refusal. */
async function proveGoalRequirementChecks(
	state: GoalState,
	deps: GoalToolDependencies,
	now: () => string,
	signal: AbortSignal | undefined,
): Promise<{ state: GoalState; refusal?: string; runs?: GoalCheckRuns }> {
	const proof = await proveRequirementChecks({
		state,
		runCheck: deps.runRequirementCheck,
		now,
		save: (next, expected) => deps.saveGoalState(next, expected),
		requireVerifiedEvidenceForCompletion: deps.requireVerifiedEvidenceForCompletion?.() ?? true,
		...(signal ? { signal } : {}),
	});
	const refusal = describeRequirementCheckRefusal(proof);
	// Checks that could not run ran nothing: there are no runs to report.
	const ran = proof.checked > 0 && !proof.unrunnable;
	return {
		state: proof.state,
		...(refusal ? { refusal } : {}),
		...(ran ? { runs: { passed: proof.checked - proof.failures.length, failed: proof.failures.length } } : {}),
	};
}

/**
 * Completion was judged to its end and the answer is no. That is the operation's outcome, not a tool
 * failure: the reasons reach the model verbatim (errorKind operation_outcome) instead of a bounded
 * failure record, so the agent sees every failed check or judgment and what would change it.
 */
function goalCompletionRefusal(
	action: GoalToolDetails["action"],
	message: string,
	state: GoalState | undefined,
): {
	content: Array<{ type: "text"; text: string }>;
	details: GoalToolDetails;
	isError: true;
	errorKind: "operation_outcome";
} {
	return { ...goalExecutionError(action, message, state), errorKind: "operation_outcome" };
}

/** System One's completion rejection as one line per failed judgment, then what would change it. */
export function describeCompletionRejection(verdict: {
	verdict: string;
	failed_gates: ReadonlyArray<{ reason: string; required_next_proof?: string }>;
}): string {
	if (verdict.failed_gates.length === 0) return `Completion refused: System One's verdict is '${verdict.verdict}'.`;
	const nextSteps = [...new Set(verdict.failed_gates.map((gate) => gate.required_next_proof).filter(Boolean))];
	return [
		`Completion refused: System One found ${verdict.failed_gates.length} issue(s) (verdict: ${verdict.verdict}).`,
		...verdict.failed_gates.map((gate) => `- ${gate.reason}`),
		...(nextSteps.length > 0 ? ["Next:", ...nextSteps.map((step) => `- ${step}`)] : []),
	].join("\n");
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

/**
 * The model declares that the operator's words grant an edge class. Prose cannot widen authority:
 * the quote must resolve verbatim to a user message on the branch (the provenance check goal
 * evidence uses), and the grant is recorded on the session, where the edge reads it.
 */
/**
 * The owner changed the goal's scope mid-run ("llama-cpp too"). The objective is rewritten only on the
 * owner's own complete message, verified on the active branch, and that message is recorded as the
 * amendment's provenance; completion then judges the amended scope instead of the old one.
 */
function executeAmendGoal(
	input: GoalToolInput,
	deps: GoalToolDependencies,
	now: () => string,
): { content: { type: "text"; text: string }[]; details: GoalToolDetails; isError?: boolean } {
	const fail = (error: string) => ({
		content: [{ type: "text" as const, text: `goal amend_goal failed: ${error}` }],
		details: { action: "amend_goal" as const, applied: false, error },
		isError: true,
	});
	const state = deps.getGoalState();
	if (!state || !isGoalExecutionActive(state.status)) return fail("there is no active goal to amend.");
	const userGoal = input.userGoal?.trim() ?? "";
	if (!userGoal) return fail("userGoal must state the amended objective.");
	if (userGoal.length > MAX_GOAL_OBJECTIVE_LENGTH) {
		return fail(`userGoal must be at most ${MAX_GOAL_OBJECTIVE_LENGTH} characters.`);
	}
	const quote = input.quote?.trim() ?? "";
	if (!quote) return fail("quote the owner's complete message that changes the goal.");
	if (!deps.resolveUserEvidence) return fail("owner messages cannot be verified in this session.");
	const resolved = deps.resolveUserEvidence(quote);
	if (!resolved.verified) {
		return fail(
			`${resolved.reason ?? "the quote did not resolve to a user message"}. Only the owner's own complete message amends a goal; if they have not said it, ask them.`,
		);
	}
	const at = now();
	const evidenceId = generatedGoalRecordId("ev", { amend: quote, entry: resolved.messageEntryId });
	const recorded = applyGoalAction(
		state,
		{
			action: "add_evidence",
			evidenceId,
			kind: "user",
			summary: quote,
			uri: `user-message:${resolved.messageEntryId}`,
			verified: true,
		},
		at,
		{ requireVerifiedEvidenceForCompletion: deps.requireVerifiedEvidenceForCompletion?.() ?? true },
	);
	if (!recorded.ok) return fail(recorded.error);
	const amended = applyGoalEvent(recorded.state, { type: "edit_goal", userGoal, now: at });
	deps.saveGoalState(amended, getGoalStateRevision(state));
	return {
		content: [
			{
				type: "text" as const,
				text: `Goal amended from the owner's message ("${quote}"). Objective: ${userGoal}\nAdd a requirement (with a check where a command can observe it) for each outcome the amendment adds.`,
			},
		],
		details: { action: "amend_goal", applied: true, state: amended },
	};
}

function executeGrantEdge(
	input: GoalToolInput,
	deps: GoalToolDependencies,
): { content: { type: "text"; text: string }[]; details: GoalToolDetails; isError?: boolean } {
	const edgeClass = input.edgeClass;
	const quote = input.quote?.trim() ?? "";
	const fail = (error: string) => ({
		content: [{ type: "text" as const, text: `goal grant_edge failed: ${error}` }],
		details: { action: "grant_edge" as const, applied: false, error },
		isError: true,
	});
	if (!edgeClass || !isEdgeClass(edgeClass)) return fail(`edgeClass must be one of ${EDGE_CLASSES.join(", ")}.`);

	const hasToolkitScript = input.toolkitScript !== undefined;
	const hasToolkitArgs = input.toolkitArgs !== undefined;

	if ((hasToolkitScript || hasToolkitArgs) && edgeClass !== "toolkit.script") {
		return fail("toolkitScript and toolkitArgs selectors are only valid for edgeClass 'toolkit.script'.");
	}

	const trimmedScript = input.toolkitScript?.trim();
	if (hasToolkitScript && (!trimmedScript || trimmedScript.length === 0)) {
		return fail("toolkitScript cannot be empty.");
	}

	if (hasToolkitArgs && !trimmedScript) {
		return fail("toolkitArgs requires toolkitScript to be specified.");
	}

	let scopeKey: string | undefined;
	if (trimmedScript) {
		if (!deps.resolveToolkitScriptScope) {
			return fail(
				"resolveToolkitScriptScope is unavailable in this session; cannot resolve narrow toolkit scope without host port.",
			);
		}
		const resolvedScope = deps.resolveToolkitScriptScope(trimmedScript, input.toolkitArgs ?? []);
		if ("error" in resolvedScope) {
			return fail(resolvedScope.error);
		}
		scopeKey = resolvedScope.scopeKey;
	}

	if (!quote) return fail("quote the operator's complete words that grant it.");
	if (!deps.resolveUserEvidence || !deps.grantEdge) return fail("edge grants are unavailable in this session.");
	const resolved = deps.resolveUserEvidence(quote);
	if (!resolved.verified) {
		return fail(
			`${resolved.reason ?? "the quote did not resolve to a user message"}. A grant rests on the operator's exact words; a paraphrase or a sentence they did not write grants nothing. If they have not said it, ask them or continue without the operation.`,
		);
	}
	deps.grantEdge({
		class: edgeClass,
		quote,
		messageEntryId: resolved.messageEntryId,
		...(scopeKey !== undefined ? { scopeKey } : {}),
	});
	return {
		content: [
			{
				type: "text" as const,
				text:
					scopeKey !== undefined
						? `edge granted: ${edgeClass} [${trimmedScript}] from the operator's words ("${quote}"); it will not ask.`
						: `edge granted: ${edgeClass} from the operator's words ("${quote}"); it will not ask.`,
			},
		],
		details: {
			action: "grant_edge" as const,
			applied: true,
			edgeClass,
			messageEntryId: resolved.messageEntryId,
			...(scopeKey !== undefined ? { scopeKey } : {}),
		},
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
			"When a command can observe a requirement's outcome, give it a check (add_requirement or set_requirement_check): the harness reruns it at completion, so the outcome is proven, not asserted.",
			"When the owner adds to or changes the goal mid-run, amend_goal with their complete message as quote and the rewritten objective as userGoal, then add requirements for what it adds; completion judges the goal as recorded.",
			"grant_edge: record a grant only when the operator's words authorize deleting the repository, the home directory, a filesystem root, a disk, or a toolkit script. Git, publishing, installing, and settings edits run without a grant. A granted class never asks; an ungranted destructive.fs or toolkit.script asks once. When the operator authorized one concrete toolkit script and arguments, specify toolkitScript and toolkitArgs; omit them for a broad class grant only when their instruction covers the class.",
			"complete needs current authoritative evidence, no remaining work, no active goal-owned lanes, no open task_steps, no goal-owned or cited running tool_task, and no active pipeline. Failed or canceled tool_task results are terminal and stop blocking liveness, but never become verified evidence automatically. block_requirement/block_goal only when the same verified owner/approval boundary or capability impossibility persists for 3 consecutive no-progress goal turns despite distinct recovery approaches, and no meaningful progress is possible without owner input or external change; otherwise keep working.",
		],
		parameters: goalSchema,
		failureRecovery: {
			getFailureEvidence: (params) => {
				const state = deps.getGoalState();
				if (!state) return undefined;
				const action = (params as { action?: string }).action;
				if (
					action !== "satisfy_requirement" &&
					action !== "increment" &&
					action !== "block_requirement" &&
					action !== "reopen_requirement"
				) {
					return undefined;
				}
				return formatGoalRecoveryCatalogs(state);
			},
		},
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
			signal,
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
			if (input.action === "grant_edge") return executeGrantEdge(input, deps);
			if (input.action === "amend_goal") return executeAmendGoal(input, deps, now);
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
			if ((action.action === "add_requirement" || action.action === "set_requirement_check") && action.check) {
				const violation = requirementCheckViolation(action.check, deps.getCwd?.() ?? process.cwd());
				if (violation) {
					return {
						content: [{ type: "text" as const, text: `goal ${input.action} failed: ${violation}` }],
						details: { action: input.action, applied: false, error: violation },
						isError: true,
					};
				}
			}
			const evidenceState = action.action === "add_evidence" ? deps.getGoalState() : undefined;
			let evidenceFailureReason: string | undefined;
			// Requirements this add_evidence or satisfy_requirement call satisfies, in citation order and deduplicated.
			const requestedRequirementIds =
				mapped.action === "add_evidence" || mapped.action === "satisfy_requirement"
					? [
							...new Set(
								[input.requirementId, ...(input.requirementIds ?? [])]
									.map((value) => value?.trim() ?? "")
									.filter((value) => value.length > 0),
							),
						]
					: [];
			let satisfyNote: string | undefined;
			if (action.action === "add_evidence") {
				signal?.throwIfAborted();
				const resolved = await resolveEvidenceVerified(action.kind, action.uri, action.summary, deps, signal);
				signal?.throwIfAborted();
				evidenceFailureReason = resolved.reason;
				const uri = resolved.uri ?? action.uri;
				action = {
					...action,
					evidenceId:
						input.evidenceId ??
						generatedGoalRecordId("ev", {
							kind: action.kind,
							summary: action.summary.trim(),
							uri: action.kind === "file" ? (uri ?? "") : (uri?.trim() ?? ""),
						}),
					verified: resolved.verified,
					outcome: resolved.outcome,
					uri,
				};
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
				const collaborationRequested = input.dispatchTarget === "collaboration";
				let useCollaboration = collaborationRequested && deps.dispatchCollaborationWorker !== undefined;
				let collaborationFallbackReason: string | undefined;
				let dispatched: { laneId?: string; skipReason?: string } | undefined;
				if (useCollaboration) {
					dispatched = await deps.dispatchCollaborationWorker?.({
						requirementId: action.requirementId,
						instructions: action.instructions,
					});
					if (
						!dispatched?.laneId &&
						(dispatched?.skipReason === "collaboration_unavailable" ||
							dispatched?.skipReason === "collaboration_extension_not_loaded") &&
						deps.startWorkerDelegation
					) {
						collaborationFallbackReason = dispatched?.skipReason;
						useCollaboration = false;
						dispatched = await deps.startWorkerDelegation(
							{
								requirementId: action.requirementId,
								instructions: action.instructions,
							},
							signal,
						);
					}
				} else {
					if (collaborationRequested) collaborationFallbackReason = "collaboration_extension_not_loaded";
					dispatched = await deps.startWorkerDelegation?.(
						{
							requirementId: action.requirementId,
							instructions: action.instructions,
						},
						signal,
					);
				}
				action = { ...action, laneId: dispatched?.laneId };
				if (dispatched?.laneId) {
					dispatchNote = collaborationFallbackReason
						? `Collaboration route returned ${collaborationFallbackReason}; dispatched native fallback worker lane '${dispatched.laneId}' for requirement '${action.requirementId}'.`
						: useCollaboration
							? `Dispatched collaboration worker lane '${dispatched.laneId}' for requirement '${action.requirementId}'.`
							: `Dispatched in-process worker lane '${dispatched.laneId}' for requirement '${action.requirementId}' (native default).`;
				} else {
					const wired = useCollaboration ? deps.dispatchCollaborationWorker : deps.startWorkerDelegation;
					dispatchSkipReason = dispatched?.skipReason ?? (wired ? "declined" : "dependency_unwired");
					dispatchNote = `${collaborationFallbackReason ? `Collaboration route returned ${collaborationFallbackReason}; ` : ""}No worker was dispatched (${dispatchSkipReason}); requirement '${action.requirementId}' is recorded but not bound to a lane.`;
				}
			}

			// Parallel evidence may extend the same goal while verification waits. Rebase only across
			// those additions; replacements and other transitions still invalidate the observation.
			const latest = deps.getGoalState();
			// Requirement checks the completion below reruns: every outcome of that completion reports them,
			// so the runs are a mechanical receipt the end-of-turn claim check can read.
			let checkRuns: GoalCheckRuns | undefined;
			const withCheckRuns = <T extends { details: GoalToolDetails }>(result: T): T =>
				checkRuns
					? { ...result, details: { ...result.details, piReceipts: { requirementChecks: checkRuns } } }
					: result;
			let current =
				action.action === "add_evidence" ? resolveGoalEvidenceCommitState(evidenceState, latest) : latest;
			let nextState: GoalState;
			// The action the response summarizes: a combined add_evidence + satisfy reads as the
			// satisfy it performed, so the requirement-linked task-step nudge still reaches the model.
			let summaryAction: GoalAction = action;
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
						const activeGoalId = current.goalId;
						activeGoalLaneIds = deps
							.getLaneRecords?.()
							.filter(
								(record) =>
									(record.status === "queued" || record.status === "running") &&
									(record.goalId === activeGoalId || boundLaneIds.has(record.laneId)),
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
				// Checked requirements are proven by the harness rerunning their checks, never by the
				// agent's account: every result is recorded as check evidence before anything is judged.
				if (action.action === "complete" && current && isGoalExecutionActive(current.status)) {
					const proven = await proveGoalRequirementChecks(current, deps, now, signal);
					checkRuns = proven.runs;
					if (proven.refusal)
						return withCheckRuns(goalCompletionRefusal(input.action, proven.refusal, proven.state));
					current = proven.state;
				}
				const result = applyGoalAction(current, action, now(), {
					requireVerifiedEvidenceForCompletion: deps.requireVerifiedEvidenceForCompletion?.() ?? true,
					openTaskSteps: deps.getOpenTaskSteps?.(),
					backgroundToolTasks: deps.getBackgroundToolTasks?.(),
					activePipeline,
					activeGoalLaneIds,
				});
				if (!result.ok) {
					return withCheckRuns({
						content: [{ type: "text" as const, text: `goal ${input.action} failed: ${result.error}` }],
						details: { action: input.action, applied: false, error: result.error, state: current },
						isError: true,
					});
				}
				if (result.state.status === "completed") {
					let activeVerificationIds: readonly string[];
					try {
						activeVerificationIds = deps.getActiveVerificationIds?.() ?? [];
					} catch (error) {
						const message = `Cannot verify active verification obligations: ${error instanceof Error ? error.message : String(error)}`;
						return withCheckRuns(goalExecutionError(input.action, message, current));
					}
					if (activeVerificationIds.length > 0) {
						return withCheckRuns(
							goalExecutionError(
								input.action,
								`Cannot transition goal to ${result.state.status}: active verification obligation(s) remain (${activeVerificationIds.join(", ")}). The same verification id must report status passed first.`,
								current,
							),
						);
					}
					const systemOne = deps.getSystemOneController?.();
					if (systemOne && current) {
						// The same completion view gets the same answer: an unchanged repeat is refused
						// without asking again, and the owner is asked to decide once.
						const fingerprint = createHash("sha256")
							.update(JSON.stringify(systemOne.completionView().view))
							.digest("hex")
							.slice(0, 16);
						const previous = current.lastCompletionRejection;
						if (previous?.fingerprint === fingerprint) {
							const askOwner = previous.ownerAskedAt === undefined;
							const recorded = applyGoalEvent(current, {
								type: "completion_rejected",
								fingerprint,
								reasons: previous.reasons,
								...(askOwner ? { ownerAsked: true } : {}),
								now: now(),
							});
							deps.saveGoalState(recorded, getGoalStateRevision(current));
							if (askOwner) {
								deps.deliverToOwner?.([
									`Goal "${current.userGoal}" cannot complete: System One refused the same completion again with nothing it reads changed (${previous.reasons[0] ?? "no reason given"}). Accept it as done with /goal complete, change it with /goal edit, or tell the agent what is missing.`,
								]);
							}
							return withCheckRuns(
								goalCompletionRefusal(
									input.action,
									[
										`Completion refused again: nothing System One reads has changed since it refused this completion (${recorded.lastCompletionRejection?.count ?? 2} times). Its reasons stand:`,
										...previous.reasons.map((reason) => `- ${reason}`),
										"Change the outcome or its evidence before completing again; the owner has been asked to decide.",
									].join("\n"),
									recorded,
								),
							);
						}
						const completionDecision = await systemOne.executeCompletionTransaction(
							requestsBugFix(result.state.goalId, result.state.userGoal),
							{ persistTerminal: false },
						);
						if (completionDecision.verdict !== "complete") {
							const recorded = applyGoalEvent(current, {
								type: "completion_rejected",
								fingerprint,
								reasons: completionDecision.failed_gates.map((gate) => gate.reason),
								now: now(),
							});
							deps.saveGoalState(recorded, getGoalStateRevision(current));
							return withCheckRuns(
								goalCompletionRefusal(input.action, describeCompletionRejection(completionDecision), recorded),
							);
						}
					}
				}
				let committed = result.state;
				// Every requirement one satisfy_requirement names, or none: the first was applied above.
				if (action.action === "satisfy_requirement") {
					for (const requirementId of requestedRequirementIds.slice(1)) {
						const applied = applyGoalAction(committed, { ...action, requirementId }, now(), {
							requireVerifiedEvidenceForCompletion: deps.requireVerifiedEvidenceForCompletion?.() ?? true,
							openTaskSteps: deps.getOpenTaskSteps?.(),
							backgroundToolTasks: deps.getBackgroundToolTasks?.(),
						});
						if (!applied.ok)
							return goalExecutionError(
								input.action,
								`requirement '${requirementId}': ${applied.error} No requirement was satisfied.`,
								current,
							);
						committed = applied.state;
					}
				}
				// One call, one outcome: evidence that verifies satisfies the requirements it was recorded
				// for, through the same reducer a following satisfy_requirement would drive. Splitting the
				// two cost a whole provider request for every verified evidence entry.
				if (action.action === "add_evidence" && requestedRequirementIds.length > 0) {
					if (action.verified !== true) {
						satisfyNote = `Requirement(s) ${requestedRequirementIds.join(", ")} were not satisfied: this evidence did not verify.`;
					} else {
						const satisfied: string[] = [];
						for (const requirementId of requestedRequirementIds) {
							const satisfyAction: GoalAction = {
								action: "satisfy_requirement",
								requirementId,
								evidenceIds: [action.evidenceId],
							};
							const applied = applyGoalAction(committed, satisfyAction, now(), {
								requireVerifiedEvidenceForCompletion: deps.requireVerifiedEvidenceForCompletion?.() ?? true,
								openTaskSteps: deps.getOpenTaskSteps?.(),
								backgroundToolTasks: deps.getBackgroundToolTasks?.(),
							});
							if (!applied.ok) {
								satisfyNote = `${satisfied.length > 0 ? `Requirement(s) ${satisfied.join(", ")} satisfied by this evidence. ` : ""}Requirement '${requirementId}' was not satisfied: ${applied.error}`;
								break;
							}
							committed = applied.state;
							satisfied.push(requirementId);
							summaryAction = satisfyAction;
						}
						if (!satisfyNote && satisfied.length > 0) {
							satisfyNote = `Requirement(s) ${satisfied.join(", ")} satisfied by this evidence.`;
						}
					}
				}
				deps.saveGoalState(committed, current ? getGoalStateRevision(current) : undefined);
				nextState = committed;
			}

			const summary = summarizeGoalState(nextState, {
				action: summaryAction,
				openTaskSteps: deps.getOpenTaskSteps?.(),
			});
			let evidenceNote = "";
			if (action.action === "add_evidence") {
				let status = `unverified: ${evidenceFailureReason ?? unverifiedEvidenceReason(action.kind)}`;
				if (action.verified === true) {
					status =
						action.kind === "user"
							? `verified user statement via ${action.uri}`
							: `verified${action.uri && action.uri !== input.uri?.trim() ? ` via ${action.kind === "file" ? "file" : "toolCallId"} ${action.uri}` : ""}`;
					if (action.outcome) status += `; operation ${action.outcome}`;
				}
				evidenceNote = `Evidence '${action.evidenceId}' recorded (${status}).`;
			}
			const receipt =
				action.action === "progress"
					? `Progress recorded; lifecycle unchanged (${nextState.status}).${nextState.status === "blocked" ? " Only the owner can resume it with /goal resume." : ""}`
					: `goal ${input.action} recorded.`;
			const text = [receipt, evidenceNote, satisfyNote, summary, dispatchNote]
				.filter((line): line is string => Boolean(line))
				.join("\n");
			return withCheckRuns({
				content: [{ type: "text" as const, text }],
				details: {
					action: input.action,
					applied: true,
					state: nextState,
					...(action.action === "dispatch_worker" && action.laneId ? { dispatchedLaneId: action.laneId } : {}),
					...(action.action === "dispatch_worker" && !action.laneId ? { dispatchSkipReason } : {}),
				},
			});
		},
	};
}

/**
 * Build the compact Codex-compatible lifecycle surface as adapters over the authoritative legacy
 * goal executor. The wrappers own no state and duplicate no validation, persistence, accounting,
 * completion gate, or start-authority rule.
 */
export function createGoalLifecycleToolDefinitions(
	goalTool: GoalToolDefinition,
	options: { getCwd?: () => string } = {},
) {
	const createGoal: ToolDefinition = {
		name: GOAL_LIFECYCLE_TOOL_NAMES[0],
		label: GOAL_LIFECYCLE_TOOL_NAMES[0],
		description:
			"Create a durable goal when persistent autonomous continuation materially benefits the current work, or when the user/system explicitly requests one. Use agent discretion; skip routine short tasks. Pass every known requirement in `requirements` so the goal is fully set up in this one call, then record task steps with one task_steps set. Set token_budget only when explicitly requested. Fails if an unfinished goal exists.",
		promptSnippet: "Start durable goal.",
		parameters: createGoalSchema,
		async execute(toolCallId, input: Static<typeof createGoalSchema>, signal, onUpdate, context) {
			// All or nothing: a check the goal could never run refuses the whole call before the goal
			// exists, instead of leaving a started goal holding only the requirements before it.
			for (const requirement of input.requirements ?? []) {
				if (typeof requirement === "string" || !requirement.check) continue;
				const violation = requirementCheckViolation(requirement.check, options.getCwd?.() ?? process.cwd());
				if (violation) {
					const error = `requirement "${requirement.text}": ${violation} No goal was created.`;
					return {
						content: [{ type: "text" as const, text: `create_goal failed: ${error}` }],
						details: { action: "start" as const, applied: false, error },
						isError: true,
					};
				}
			}
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
			for (const requirement of input.requirements) {
				const text = typeof requirement === "string" ? requirement : requirement.text;
				const check = typeof requirement === "string" ? undefined : requirement.check;
				last = await goalTool.execute(
					toolCallId,
					{ action: "add_requirement", goalId, text, ...(check ? { check } : {}) },
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
			"Update the existing goal. active records progress only after concrete, verifiable progress in the current turn; it never changes lifecycle or resumes a blocked goal. Only the owner can resume it with /goal resume. Mark complete only when current evidence proves the full objective is achieved and no required work remains. Mark blocked only when the same verified owner/approval boundary or capability impossibility persists for at least three consecutive no-progress goal turns despite distinct recovery approaches, and no meaningful progress is possible without owner input or external change; include the evidence and attempted approaches in reason. Never use blocked merely because work is hard, slow, uncertain, incomplete, or would benefit from clarification.",
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
