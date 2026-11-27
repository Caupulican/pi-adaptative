import { createHash, randomUUID } from "node:crypto";
import { type Static, Type } from "typebox";
import { RULE_IDS_DETAIL_KEY } from "../../kernel/session/message-retention.ts";
import type { WorkerClaim } from "../autonomy/contracts.ts";
import { EDGE_CLASSES, type EdgeClass, isEdgeClass } from "../autonomy/edge-policy.ts";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import type { BackgroundToolTaskRef } from "../background-tool-task-controller.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { GoalFileEvidenceResolver } from "../goals/file-evidence.ts";
import { decideGoalCompletion, goalCompletionKey } from "../goals/goal-completion-admission.ts";
import { completionGateSet, type GoalCompletionEvidence } from "../goals/goal-completion-record.ts";
import {
	type GoalStateRevision,
	getGoalStateRevision,
	resolveGoalEvidenceCommitState,
} from "../goals/goal-lifecycle.ts";
import {
	applyGoalEvent,
	type GoalEvidenceKind,
	type GoalEvidenceOutcome,
	type GoalEvidenceRef,
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
	type GoalStartGrant,
	goalRequirementId,
	nextRequirementToSatisfy,
	type OpenTaskStepRef,
	summarizeGoalState,
	unusedGoalEvidenceIds,
} from "../goals/goal-tool-core.ts";
import { GOAL_LIFECYCLE_TOOL_NAMES, LEGACY_GOAL_TOOL_NAME } from "../goals/goal-tool-names.ts";
import { type GoalWorkProposal, preservesGoalObjective } from "../goals/goal-work-admission.ts";
import { describeRequirementCheckRefusal, proveRequirementChecks } from "../goals/prove-requirement-checks.ts";
import type { RequirementCheckResult } from "../goals/requirement-checks.ts";
import {
	type RequirementCoveragePort,
	resolvedGoalEvidenceObservation,
	reviewGoalCoverage,
} from "../goals/requirement-coverage.ts";
import { requirementCoverageProbe } from "../goals/requirement-dependencies.ts";
import { resolveEvidenceVerified } from "../goals/session-goal-evidence.ts";
import { laneWorkerRefusalSkipRemedy, WORKER_CAPABILITY_INSUFFICIENT_SKIP_REASON } from "../model-capability.ts";
import {
	type GoalCompletionPresentation,
	objectiveExecutionSignal,
	sameGoalExecution,
} from "../objective-execution/current-objective-execution.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { goalObjectiveId } from "../orchestration/work-state-projection.ts";
import { PROOF_SHEET_DETAILS_KEY, type ProofSheetRecord } from "../proof/proof-sheet.ts";
import { TYPESAFE_API_CREDENTIAL } from "../review/typesafe-contract.ts";
import type { RuleHookRefusal } from "../rule-hooks/rule-hook-delivery.ts";
import { requestsBugFix } from "../system-one/bug-fix.ts";
import {
	COMPLETION_ACCOUNT_GUIDANCE,
	COMPLETION_ACCOUNT_SHAPE,
	type CompletionAccount,
	completionAccountInputSchema,
	parseCompletionAccount,
} from "../system-one/completion-account.ts";
import { completionRemedies, completionRemedy, renderCompletionRemedies } from "../system-one/completion-remedies.ts";
import type { SystemOneController } from "../system-one/controller.ts";
import type { FinalCompletionVerdict } from "../system-one/policy.ts";
import {
	type GoalProofSheetBuilder,
	goalCompletionReceipt,
	goalReportHandoff,
	goalReportInstruction,
} from "./goal-completion-result.ts";
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
				"Read-only shell command that observes the outcome (test, command -v, systemctl is-active, jq, grep, curl GET, a test runner run).",
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
			"How the harness proves a requirement: it reruns the command at completion and a failed check refuses completion. Give one whenever a command can observe the outcome. Omit on set_requirement_check to remove it.",
	},
);

const goalSchema = Type.Object(
	{
		action: Type.Union([
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
		]),
		edgeClass: Type.Optional(
			Type.Union(
				EDGE_CLASSES.map((edgeClass) => Type.Literal(edgeClass)),
				{
					description:
						"grant_edge: record a grant only when the operator's words authorize deleting the repository, the home directory, a filesystem root, a disk, or a toolkit script. Git, publishing, installing and settings edits need no grant, except when the operator's words let actions a peer or another channel asks for run. A granted class is not asked again.",
				},
			),
		),
		toolkitScript: Type.Optional(
			Type.String({
				description:
					"grant_edge: the one toolkit script the operator authorized (registered name or unambiguous alias). Omit for a class grant.",
			}),
		),
		toolkitArgs: Type.Optional(
			Type.Array(Type.String(), {
				description: "grant_edge: exact argv of the authorized script (default []); requires toolkitScript.",
			}),
		),
		quote: Type.Optional(
			Type.String({
				description:
					"grant_edge / amend_goal: the owner's complete message, verbatim; a paraphrase or part of a message grants and amends nothing.",
			}),
		),
		goalId: Type.Optional(Type.String({ description: "Required for start." })),
		userGoal: Type.Optional(
			Type.String({
				description:
					"Required for start/amend_goal. An amendment keeps the current objective text and appends only same-objective changes.",
			}),
		),
		tokenBudget: Type.Optional(
			Type.Integer({ minimum: 1, description: "Owner-requested only; the host ignores other values." }),
		),
		requirementId: Type.Optional(
			Type.String({
				description:
					"Omit on add_requirement for a host id. On add_evidence, the requirement the evidence satisfies once verified.",
			}),
		),
		requirementIds: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"add_evidence: every requirement the evidence satisfies once verified. satisfy_requirement: every requirement the cited evidence satisfies (all or none).",
			}),
		),
		text: Type.Optional(Type.String({ description: "Required for add_requirement." })),
		dependencies: Type.Optional(
			Type.Array(Type.String(), {
				description: "add_requirement: ids of requirements that must be satisfied first.",
			}),
		),
		check: Type.Optional(requirementCheckSchema),
		instructions: Type.Optional(Type.String({ description: "Required for dispatch_worker." })),
		evidenceId: Type.Optional(Type.String({ description: "Omit on add_evidence for a host id." })),
		evidenceIds: Type.Optional(
			Type.Array(Type.String(), { description: "satisfy_requirement: existing evidence ids." }),
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
				{ description: "Required for add_evidence." },
			),
		),
		summary: Type.Optional(Type.String({ description: "add_evidence requires a non-empty summary." })),
		uri: Type.Optional(
			Type.String({
				description:
					"Evidence locator: file path; tool/test toolCallId or exact command; background tool_task taskId (kind=tool; a failed or canceled task is terminal but never verified evidence); worker laneId; user message entry id (summary quotes its full text). Only host-verified evidence satisfies a requirement; finding never does.",
			}),
		),
		reason: Type.Optional(Type.String({ description: "Required for block_requirement and block_goal." })),
		dispatchTarget: Type.Optional(
			Type.Union([Type.Literal("in_process"), Type.Literal("collaboration")], {
				description: "Native by default; collaboration for a persistent interactive session.",
			}),
		),
		account: Type.Optional(completionAccountInputSchema(COMPLETION_ACCOUNT_GUIDANCE)),
	},
	{ additionalProperties: false },
);

const createGoalSchema = Type.Object(
	{
		objective: Type.String({ description: "The concrete objective." }),
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
					description: "Every requirement the goal must satisfy, recorded in this call.",
				},
			),
		),
		token_budget: Type.Optional(
			Type.Integer({ minimum: 1, description: "Owner-requested only; the host ignores other values." }),
		),
	},
	{ additionalProperties: false },
);

const getGoalSchema = Type.Object({}, { additionalProperties: false });

const updateGoalSchema = Type.Object(
	{
		status: Type.Union([
			Type.Literal("active"),
			Type.Literal("complete"),
			Type.Literal("blocked"),
			Type.Literal("paused"),
		]),
		reason: Type.Optional(Type.String({ minLength: 1, description: "Required for blocked." })),
		account: Type.Optional(completionAccountInputSchema("complete: same shape as the goal tool's account.")),
	},
	{ additionalProperties: false },
);

type GoalToolSchemaInput = Static<typeof goalSchema>;
/** Internal lifecycle wrappers may use actions that are intentionally absent from the legacy model schema. */
export type GoalToolInput = Omit<GoalToolSchemaInput, "action"> & {
	action: GoalToolSchemaInput["action"] | "pause_goal";
	initialRequirements?: readonly { text: string; check?: RequirementCheck }[];
};
export type GoalToolDefinition = ToolDefinition;

export interface GoalToolDetails {
	action: GoalActionName | "get" | "grant_edge" | "amend_goal";
	applied: boolean;
	completionAdvisories?: FinalCompletionVerdict["advisories"];
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
	/** Set on the call that completed the goal: the code-rendered proof sheet shown before the model's summary. */
	[PROOF_SHEET_DETAILS_KEY]?: ProofSheetRecord;
	/** Set on a completion refused with the noticed-items rule: the ids of the rules the refusal text delivers. */
	[RULE_IDS_DETAIL_KEY]?: readonly string[];
}

export interface GoalCheckRuns {
	passed: number;
	failed: number;
}

export type GoalToolEvidenceResolution =
	| { verified: true; toolCallId: string; outcome: GoalEvidenceOutcome; observation?: string }
	| { verified: false; reason: string };

export type GoalUserEvidenceResolution =
	| { verified: true; messageEntryId: string }
	| { verified: false; reason: string };

export interface GoalToolDependencies {
	executionSignal?(objectiveId: string, activeOnly?: boolean): AbortSignal | undefined;
	/**
	 * The proof sheet of the goal this call completed, from the goal record, the account and the changed files the
	 * completion read. Absent, the completion carries no sheet; a sheet never decides whether the goal completes.
	 */
	buildCompletionProofSheet?: GoalProofSheetBuilder;
	/** Full rejected judgment retained by the existing System One evidence paging owner. */
	retainCompletionEvidence?: (toolCallId: string, decision: FinalCompletionVerdict) => GoalCompletionEvidence;
	/** Read the latest persisted goal state for the active session. */
	getGoalState: () => GoalState | undefined;
	/** Why automatic continuation is stopped for a lasting reason, as the one sentence the goal context carries too. */
	getAutoContinueNote?: () => string | undefined;
	/** Persist a new goal state snapshot to the active session. */
	saveGoalState: (state: GoalState, expected?: GoalStateRevision, presentation?: GoalCompletionPresentation) => void;
	prepareCompletionPresentation?(
		toolCallId: string,
		goal: GoalState,
		signal?: AbortSignal,
	): GoalCompletionPresentation | undefined;
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
	 * The durable task runtime, read with {@link getWorkerClaimSnapshots} to decide whether an accepted, reviewed
	 * worker result covers a requirement, so `dispatch_worker` counts a covered dependency as met.
	 */
	getTaskRuntimeSnapshot?: () => TaskRuntimeProjection | undefined;
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
	 * `worker_capability_insufficient:reason=...;class=...;contextWindow=...` (the model the child will
	 * resolve is sub-full class, has an undeclared context window, does not declare or prove a native
	 * tool-call path, or is demoted off it -- see `model-capability.ts`'s `evaluateLaneWorkerModelRefusal`;
	 * the goal result is then a blocked outcome, never a success. This is the parent's best-effort check,
	 * refused before any lane/pane side effect -- the dispatched child still refuses authoritatively at
	 * its own startup regardless, and reports that refusal as a blocked turn).
	 */
	dispatchCollaborationWorker?: (
		args: {
			requirementId: string;
			instructions: string;
		},
		signal?: AbortSignal,
	) => Promise<{ laneId?: string; skipReason?: string }>;
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
	/** What the current foreground turn grants a model's start, or why it refuses it. Omitted by direct owner/test callers. */
	admitWork?: (proposal: GoalWorkProposal, signal?: AbortSignal) => Promise<string | undefined>;
	authorizeStart?: (input: Pick<GoalToolInput, "userGoal" | "tokenBudget">) => string | GoalStartGrant;
	/**
	 * Trusted verification obligations reconstructed from the active session context. A model-facing
	 * transition to completed is refused while any remain; ordinary goal and tool actions do not
	 * consult this gate.
	 */
	getActiveVerificationIds?: () => readonly string[];
	/**
	 * Completion preflight: the refusal a model-driven completion gets while the host's noticed-items rule is not in
	 * the context (the text starts with the rule's `RULE <id>` line; the refused result lists the id in its details),
	 * or undefined when the completion may proceed.
	 * Called once the deterministic completion checks have passed, before the System One judgments.
	 */
	getCompletionRuleRefusal?: (toolCallId: string) => RuleHookRefusal | undefined;
	/**
	 * grant_edge: record that the operator's instructions cover an edge class. Only called after the
	 * quote resolved verbatim to a user message; absent when the host has no edge (tests, SDK).
	 */
	grantEdge?: (grant: { class: EdgeClass; quote: string; messageEntryId: string; scopeKey?: string }) => void;
	/** System One semantic evaluator for goal completion. */
	getSystemOneController?: () =>
		| (Pick<SystemOneController, "completionView" | "executeCompletionTransaction"> &
				Partial<Pick<SystemOneController, "noteCompletionAccount">>)
		| undefined;
	/** Why the session would not run a check (`sessionRequirementCheckViolation`): a check attaches only if it would run. */
	admitRequirementCheck: (check: RequirementCheck) => string | undefined;
	/**
	 * Rerun one requirement check. Wired by the host to {@link runRequirementCheck}; when absent,
	 * completion cannot prove checked requirements and refuses rather than skipping their checks.
	 */
	runRequirementCheck?: (check: RequirementCheck, signal?: AbortSignal) => Promise<RequirementCheckResult>;
	/**
	 * Narrow operation scope resolver for toolkit.script grants. Resolves registered script name
	 * and exact argv to an internal scope key using host registry and execution context.
	 */
	resolveToolkitScriptScope?: (script: string, args: readonly string[]) => { scopeKey: string } | { error: string };
	/**
	 * Resolve the producing call and its authoritative outcome on the active branch. Test evidence
	 * additionally requires a trusted passing verification receipt; answered calls alone are not proof.
	 */
	resolveToolEvidence?: (uri: string, kind: "tool" | "test", observe?: boolean) => GoalToolEvidenceResolution;
	/** Verify an exact user statement against the active branch, never from the model-selected kind. */
	resolveUserEvidence?: (summary: string, uri?: string) => GoalUserEvidenceResolution;
	requirementCoverageEngine?: RequirementCoveragePort["engine"];
	/** Host authority for an exact owner-specified or built-in check contract. */
	isCheckCoverageEstablished?: (requirement: GoalState["requirements"][number]) => boolean;
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

/** The ledger action a goal tool call asks for; a start records `ownerSourceId`, granted by the host, never the model. */
function toGoalAction(input: GoalToolInput, ownerSourceId?: string): GoalAction | { error: string } {
	switch (input.action) {
		case "start":
			return {
				action: "start",
				goalId: input.goalId ?? "",
				userGoal: input.userGoal ?? "",
				tokenBudget: input.tokenBudget,
				...(ownerSourceId === undefined ? {} : { ownerSourceId }),
				...(input.initialRequirements ? { requirements: input.initialRequirements } : {}),
			};
		case "add_requirement":
			return {
				action: "add_requirement",
				requirementId: input.requirementId ?? goalRequirementId(input.text ?? "", input.dependencies),
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
		case "pause_goal":
			return { action: "pause_goal" };
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

function goalCoverageObserver(deps: GoalToolDependencies) {
	return (item: GoalEvidenceRef) =>
		resolvedGoalEvidenceObservation(item, (locator, kind, observe) =>
			deps.resolveToolEvidence?.(locator, kind, observe),
		);
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
		observeEvidence: goalCoverageObserver(deps),
		coverageEngine: deps.requirementCoverageEngine,
		isCheckCoverageEstablished: deps.isCheckCoverageEstablished,
		now,
		save: (next, expected) => deps.saveGoalState(next, expected),
		requireVerifiedEvidenceForCompletion: deps.requireVerifiedEvidenceForCompletion?.() ?? true,
		...(signal ? { signal } : {}),
	});
	const described = describeRequirementCheckRefusal(proof);
	const remedies = proof.unrunnable
		? [
				completionRemedy(
					"requirement_check",
					"This session cannot run the requirement checks: ask the owner to run them here or to change the check.",
					{ kind: "ask_owner" },
				),
			]
		: proof.failures.map((failure) =>
				completionRemedy(
					"requirement_check",
					"Fix the outcome this check reads, then call complete; the harness reruns the check.",
					{ kind: "fix_work", requirementId: failure.requirementId },
				),
			);
	const refusal = described ? [described, ...renderCompletionRemedies(remedies)].join("\n") : undefined;
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

/**
 * A completion rejection as one line per failed gate, then what would change it, then the same as structured remedies
 * (`r`, one per gate: its kind from the closed table in `completion-remedies.ts` and its next step). A replayed
 * verdict says System One was not asked again, and `count` above one says how many refusals in a row failed the same
 * gates.
 */
export function describeCompletionRejection(
	verdict: Pick<FinalCompletionVerdict, "verdict" | "failed_gates" | "replayed">,
	count = 1,
): string {
	if (verdict.failed_gates.length === 0) return `Completion refused: System One's verdict is '${verdict.verdict}'.`;
	const nextSteps = [...new Set(verdict.failed_gates.map((gate) => gate.required_next_proof).filter(Boolean))];
	return [
		`Completion refused: System One found ${verdict.failed_gates.length} issue(s) (verdict: ${verdict.verdict}).`,
		...(verdict.replayed
			? [
					"Nothing System One reads changed since it refused this completion, so it was not asked again: change the work, the evidence or the account before completing.",
				]
			: []),
		...(count > 1 ? [`This is refusal ${count} in a row over the same failed gates.`] : []),
		...verdict.failed_gates.map((gate) => `- ${gate.reason}`),
		...(nextSteps.length > 0 ? ["Next:", ...nextSteps.map((step) => `- ${step}`)] : []),
		...renderCompletionRemedies(completionRemedies(verdict.failed_gates)),
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
 * The owner extended the goal's scope mid-run ("llama-cpp too"). The objective is extended only on the
 * owner's own complete message, verified on the active branch, and that message is recorded as the
 * amendment's provenance; completion then judges the amended scope instead of the old one.
 */
async function executeAmendGoal(
	input: GoalToolInput,
	deps: GoalToolDependencies,
	now: () => string,
	signal?: AbortSignal,
): Promise<{ content: { type: "text"; text: string }[]; details: GoalToolDetails; isError?: boolean }> {
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
	if (!preservesGoalObjective(state.userGoal, userGoal)) {
		return fail(
			"an amendment may extend the current goal but cannot replace its existing objective. Preserve the existing objective text and append same-scope changes; handle unrelated work separately without changing this goal or its workers.",
		);
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
	signal = objectiveExecutionSignal(deps, goalObjectiveId(state.goalId), signal, true);
	const admission = await deps.admitWork?.({ objective: userGoal, currentObjective: state.userGoal, quote }, signal);
	if (admission) return fail(admission);
	signal?.throwIfAborted();
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
	const amended = applyGoalEvent(recorded.state, {
		type: "edit_goal",
		userGoal,
		admittedOwnerEntryId: resolved.messageEntryId,
		now: at,
	});
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

function workerDependencyCoverage(deps: GoalToolDependencies, goal: GoalState | undefined) {
	return goal && deps.getWorkerClaimSnapshots
		? requirementCoverageProbe({
				goal,
				snapshot: () => deps.getTaskRuntimeSnapshot?.(),
				claims: () => deps.getWorkerClaimSnapshots?.() ?? [],
			})
		: undefined;
}

export function createGoalToolDefinition(deps: GoalToolDependencies): GoalToolDefinition {
	const now = deps.now ?? (() => new Date().toISOString());
	return {
		name: LEGACY_GOAL_TOOL_NAME,
		label: "goal",
		description:
			"Durable goal record: requirements and their checks, evidence, worker dispatch, progress, completion, owner grants and amendments. If the active goal is unknown, call get_goal before updating it. Use create_goal if the owner wants a goal and none exists. For add_evidence send kind, summary and the matching uri where applicable. Record the delivery contract (work-lifecycle rule) as requirements. increment satisfies the current open requirement from unused evidence, or completes when none remain. block_requirement only at the bar update_goal sets for blocked; otherwise keep working.",
		promptSnippet: "Manage the durable goal record",
		neverDefer: true,
		executionMode: (args) =>
			args?.action === "complete" || args?.action === "increment" ? "foreground_barrier" : "parallel",
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
			toolCallId,
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
				const autoContinueNote = isGoalExecutionActive(state.status) ? deps.getAutoContinueNote?.() : undefined;
				return {
					content: [
						{
							type: "text",
							text: [summarizeGoalState(state), autoContinueNote]
								.filter((line) => line !== undefined)
								.join("\n"),
						},
					],
					details: { action: "get", applied: false, state },
				};
			}
			if (input.action === "grant_edge") return executeGrantEdge(input, deps);
			if (input.action === "amend_goal") return executeAmendGoal(input, deps, now, signal);
			if (input.action === "start") {
				const refusal = await deps.admitWork?.(
					{
						objective: input.userGoal ?? "",
						outcomes: input.initialRequirements?.map((requirement) => requirement.text),
					},
					signal,
				);
				if (refusal) return goalExecutionError(input.action, refusal, deps.getGoalState());
				signal?.throwIfAborted();
			}
			// A start carries what the turn grants it: the owner's token budget (null drops the model's) and owner source.
			const grant = input.action === "start" ? deps.authorizeStart?.(input) : undefined;
			if (typeof grant === "string") {
				return {
					content: [{ type: "text", text: `goal start failed: ${grant}` }],
					details: { action: "start", applied: false, error: grant },
					isError: true,
				};
			}
			const normalizedInput =
				typeof grant?.tokenBudget === "number" ? { ...input, tokenBudget: grant.tokenBudget } : { ...input };
			if (grant?.tokenBudget === null) delete normalizedInput.tokenBudget;
			const mapped = toGoalAction(normalizedInput, grant?.ownerSourceId);
			if ("error" in mapped) {
				return {
					content: [{ type: "text" as const, text: `goal ${input.action} failed: ${mapped.error}` }],
					details: { action: input.action, applied: false, error: mapped.error },
					isError: true,
				};
			}

			if (mapped.action === "add_requirement") {
				const standing = deps.getGoalState();
				if (standing) {
					signal = objectiveExecutionSignal(deps, goalObjectiveId(standing.goalId), signal);
					signal?.throwIfAborted();
					const refusal = await deps.admitWork?.(
						{ objective: mapped.text, standingObjective: standing.userGoal },
						signal,
					);
					if (refusal) return goalExecutionError(input.action, refusal, standing);
					const latest = deps.getGoalState();
					signal?.throwIfAborted();
					if (!sameGoalExecution(standing, latest) || latest?.userGoal !== standing.userGoal)
						return goalExecutionError(
							input.action,
							"The standing goal changed while the requirement scope was reviewed. Retry against its current definition.",
							latest,
						);
				}
			}

			let action: GoalAction = mapped;
			if ((action.action === "add_requirement" || action.action === "set_requirement_check") && action.check) {
				const violation = deps.admitRequirementCheck(action.check);
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
				const admitted = deps.getGoalState();
				if (!admitted) return goalExecutionError(input.action, "No active goal for worker dispatch.", admitted);
				signal = objectiveExecutionSignal(deps, goalObjectiveId(admitted.goalId), signal, true);
				const dispatchAction = action;
				const preflight = () => {
					signal?.throwIfAborted();
					const live = deps.getGoalState();
					if (!sameGoalExecution(admitted, live)) return "The goal changed before worker dispatch.";
					const check = applyGoalAction(live, dispatchAction, now(), {
						dependencyCovered: workerDependencyCoverage(deps, live),
					});
					return check.ok ? undefined : check.error;
				};
				const refusal = preflight();
				if (refusal) return goalExecutionError(input.action, refusal, admitted);
				const assignment = { requirementId: action.requirementId, instructions: action.instructions };
				const collaborationRequested = input.dispatchTarget === "collaboration";
				let useCollaboration = collaborationRequested && deps.dispatchCollaborationWorker !== undefined;
				let collaborationFallbackReason: string | undefined;
				let dispatched: { laneId?: string; skipReason?: string } | undefined;
				if (useCollaboration) {
					dispatched = await deps.dispatchCollaborationWorker?.(assignment, signal);
					if (
						!dispatched?.laneId &&
						(dispatched?.skipReason === "collaboration_unavailable" ||
							dispatched?.skipReason === "collaboration_extension_not_loaded") &&
						deps.startWorkerDelegation
					) {
						const fallbackRefusal = preflight();
						if (fallbackRefusal) return goalExecutionError(input.action, fallbackRefusal, deps.getGoalState());
						collaborationFallbackReason = dispatched?.skipReason;
						useCollaboration = false;
						dispatched = await deps.startWorkerDelegation(assignment, signal);
					}
				} else {
					if (collaborationRequested) collaborationFallbackReason = "collaboration_extension_not_loaded";
					dispatched = await deps.startWorkerDelegation?.(assignment, signal);
				}
				signal?.throwIfAborted();
				if (!sameGoalExecution(admitted, deps.getGoalState()))
					return goalExecutionError(
						input.action,
						"The goal changed during dispatch. Its successor cannot receive this worker binding.",
						deps.getGoalState(),
					);
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
					const capabilityRemedy = laneWorkerRefusalSkipRemedy(dispatchSkipReason);
					dispatchNote = `${collaborationFallbackReason ? `Collaboration route returned ${collaborationFallbackReason}; ` : ""}No worker was dispatched (${dispatchSkipReason}); requirement '${action.requirementId}' is recorded but not bound to a lane.${capabilityRemedy ? ` ${capabilityRemedy}` : ""}`;
				}
			}

			// Parallel evidence may extend the same goal while verification waits. Rebase only across
			// those additions; replacements and other transitions still invalidate the observation.
			const latest = deps.getGoalState();
			// Requirement checks the completion below reruns: every outcome of that completion reports them,
			// so the runs are a mechanical receipt the end-of-turn claim check can read.
			let checkRuns: GoalCheckRuns | undefined;
			let completionAdvisories: FinalCompletionVerdict["advisories"];
			// What the proof sheet of a completion this call makes reads: the account and the files the completion saw.
			let completionAccount: CompletionAccount | undefined;
			let completionChangedFiles: readonly string[] | undefined;
			const withCheckRuns = <T extends { details: GoalToolDetails }>(result: T): T =>
				checkRuns
					? { ...result, details: { ...result.details, piReceipts: { requirementChecks: checkRuns } } }
					: result;
			let current =
				action.action === "add_evidence" ? resolveGoalEvidenceCommitState(evidenceState, latest) : latest;
			const actionAt = now();
			const proofRequired = deps.requireVerifiedEvidenceForCompletion?.() !== false;
			if (current && action.action === "increment" && !nextRequirementToSatisfy(current, proofRequired))
				action = { action: "complete" };
			if (proofRequired && current && action.action === "satisfy_requirement" && !action.evidenceIds?.length)
				action = { ...action, evidenceIds: unusedGoalEvidenceIds(current, true) };
			const presentation =
				action.action === "complete" && current && isGoalExecutionActive(current.status)
					? deps.prepareCompletionPresentation?.(toolCallId, current, signal)
					: undefined;
			let completedHere = false;
			const coverageProofs =
				proofRequired && deps.requirementCoverageEngine
					? await reviewGoalCoverage(
							current,
							action,
							requestedRequirementIds,
							actionAt,
							{
								engine: deps.requirementCoverageEngine,
								observe: goalCoverageObserver(deps),
							},
							signal,
						)
					: undefined;
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
				// Checked requirements are proven by the harness rerunning their checks, never by the
				// agent's account: every result is recorded as check evidence before anything is judged.
				if (action.action === "complete" && current && isGoalExecutionActive(current.status)) {
					const proven = await proveGoalRequirementChecks(current, deps, now, signal);
					checkRuns = proven.runs;
					if (proven.refusal)
						return withCheckRuns(goalCompletionRefusal(input.action, proven.refusal, proven.state));
					current = proven.state;
				}
				const result =
					action.action === "complete"
						? decideGoalCompletion(current, deps, now())
						: applyGoalAction(current, action, actionAt, {
								coverageProofs,
								requireVerifiedEvidenceForCompletion: deps.requireVerifiedEvidenceForCompletion?.() ?? true,
								openTaskSteps: deps.getOpenTaskSteps?.(),
								backgroundToolTasks: deps.getBackgroundToolTasks?.(),
								dependencyCovered: workerDependencyCoverage(deps, current),
							});
				if (!result.ok) {
					const refusal = action.action === "complete" ? goalCompletionRefusal : goalExecutionError;
					return withCheckRuns(refusal(input.action, result.error, current));
				}
				if (result.state.status === "completed") {
					// One place for every model-driven completion: goal `complete`, `increment` with nothing left to
					// satisfy and update_goal `complete` all end here. The refusal returns before saveGoalState, so the
					// goal (an increment included) stays exactly as it was, and the repeated call is admitted at once.
					const ruleRefusal = deps.getCompletionRuleRefusal?.(toolCallId);
					if (ruleRefusal) {
						return withCheckRuns({
							content: [
								{
									type: "text" as const,
									text: `${ruleRefusal.text}\n\nReview your proof output for relevant noticed items; resolve them, then call complete again.`,
								},
							],
							details: {
								action: input.action,
								applied: false,
								error: "Completion is held until the noticed-items rule is in context.",
								state: current,
								[RULE_IDS_DETAIL_KEY]: ruleRefusal.ruleIds,
							},
							isError: true as const,
							errorKind: "operation_outcome" as const,
							retryAdmitted: true as const,
						});
					}
					const systemOne = deps.getSystemOneController?.();
					if (systemOne && current) {
						// The model's account of the change, which completion reads whoever asks for it.
						if (input.account) {
							const parsed = parseCompletionAccount(input.account);
							if ("errors" in parsed)
								return withCheckRuns(
									goalCompletionRefusal(
										input.action,
										[
											`The completion account is malformed at ${parsed.total} location(s); nothing was judged.`,
											...parsed.errors.map((error) => `- ${error}`),
											...(parsed.total > parsed.errors.length
												? [`- and ${parsed.total - parsed.errors.length} more`]
												: []),
											`s ${COMPLETION_ACCOUNT_SHAPE}`,
										].join("\n"),
										current,
									),
								);
							systemOne.noteCompletionAccount?.(parsed.account);
							completionAccount = parsed.account;
						}
						const completionView = await systemOne.completionView(signal);
						completionChangedFiles = completionView.changedFiles;
						const completionDecision = await systemOne.executeCompletionTransaction(
							requestsBugFix(result.state.goalId, result.state.userGoal),
							{ persistTerminal: false, signal },
						);
						completionAdvisories = completionDecision.advisories;
						if (completionDecision.verdict !== "complete") {
							// A judged verdict names what it read; a code-only refusal is keyed by the view.
							const fingerprint =
								completionDecision.inputDigest ??
								createHash("sha256").update(JSON.stringify(completionView.view)).digest("hex").slice(0, 16);
							let evidence: GoalCompletionEvidence | undefined;
							let evidenceUnavailable: string | undefined;
							try {
								// A replay is retained too (no System One cost): a code-only refusal between the judgment and
								// its replay changes the fingerprint, and nothing would carry the earlier retention forward.
								evidence = deps.retainCompletionEvidence?.(toolCallId, completionDecision);
							} catch (error) {
								evidenceUnavailable =
									error instanceof Error
										? error.message
												.replace(new RegExp(TYPESAFE_API_CREDENTIAL.source, "g"), "[redacted]")
												.slice(0, 500)
										: "Evidence retention failed";
							}
							const recorded = applyGoalEvent(current, {
								type: "completion_rejected",
								fingerprint,
								reasons: completionDecision.failed_gates.map((gate) => gate.reason),
								gateSet: completionGateSet(completionDecision.failed_gates),
								findings: completionDecision.failed_gates,
								...(evidence ? { evidence } : {}),
								...(evidenceUnavailable ? { evidenceUnavailable } : {}),
								now: now(),
							});
							deps.saveGoalState(recorded, getGoalStateRevision(current));
							return withCheckRuns(
								goalCompletionRefusal(
									input.action,
									describeCompletionRejection(completionDecision, recorded.lastCompletionRejection?.count),
									recorded,
								),
							);
						}
					}
				}
				let committed = result.state;
				if (current && action.action === "complete") {
					signal?.throwIfAborted();
					const live = deps.getGoalState();
					if (!live || goalCompletionKey(live) !== goalCompletionKey(current))
						return withCheckRuns(
							goalExecutionError(
								input.action,
								"The goal or its proof changed during review. Retry against its current requirements.",
								live,
							),
						);
					const final = decideGoalCompletion(live, deps, now());
					if (!final.ok) return withCheckRuns(goalCompletionRefusal(input.action, final.error, live));
					current = live;
					committed = final.state;
				}
				// Every requirement one satisfy_requirement names, or none: the first was applied above.
				if (action.action === "satisfy_requirement") {
					for (const requirementId of requestedRequirementIds.slice(1)) {
						const applied = applyGoalAction(committed, { ...action, requirementId }, now(), {
							coverageProofs,
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
				// Keep each coverage decision independent while recording the citation in the same transaction.
				if (action.action === "add_evidence" && requestedRequirementIds.length > 0) {
					if (action.verified !== true) {
						satisfyNote = `Requirement(s) ${requestedRequirementIds.join(", ")} were not satisfied: this evidence did not verify.`;
					} else {
						const satisfied: string[] = [];
						const refusals: string[] = [];
						for (const requirementId of requestedRequirementIds) {
							const satisfyAction: GoalAction = {
								action: "satisfy_requirement",
								requirementId,
								evidenceIds: [action.evidenceId],
							};
							const applied = applyGoalAction(committed, satisfyAction, now(), {
								coverageProofs,
								requireVerifiedEvidenceForCompletion: deps.requireVerifiedEvidenceForCompletion?.() ?? true,
								openTaskSteps: deps.getOpenTaskSteps?.(),
								backgroundToolTasks: deps.getBackgroundToolTasks?.(),
							});
							if (!applied.ok) {
								refusals.push(applied.error);
								continue;
							}
							committed = applied.state;
							satisfied.push(requirementId);
							summaryAction = satisfyAction;
						}
						satisfyNote = [
							satisfied.length > 0 ? `Requirement(s) ${satisfied.join(", ")} satisfied by this evidence.` : "",
							...refusals,
						]
							.filter(Boolean)
							.join("\n");
					}
				}
				if (action.action === "start" || action.action === "add_requirement") signal?.throwIfAborted();
				completedHere =
					action.action === "complete" &&
					!!current &&
					isGoalExecutionActive(current.status) &&
					committed.status === "completed";
				deps.saveGoalState(
					committed,
					current ? getGoalStateRevision(current) : undefined,
					completedHere ? presentation : undefined,
				);
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
			const advice = completionAdvisories?.map((item) => `Completion advice: ${item.reason}`).join("\n");
			const proof =
				completedHere && deps.buildCompletionProofSheet
					? goalCompletionReceipt(
							deps.buildCompletionProofSheet,
							nextState,
							completionAccount,
							input.account,
							completionChangedFiles,
						)
					: undefined;
			const report = completedHere && (!deps.prepareCompletionPresentation || presentation?.committed);
			const instruction = report ? goalReportInstruction : undefined;
			const text = [proof?.text, receipt, evidenceNote, satisfyNote, summary, dispatchNote, advice, instruction]
				.filter((line): line is string => Boolean(line))
				.join("\n");
			return withCheckRuns({
				...(report ? goalReportHandoff(presentation) : {}),
				content: [{ type: "text" as const, text }],
				details: {
					action: input.action,
					applied: true,
					state: nextState,
					...(proof?.record ? { [PROOF_SHEET_DETAILS_KEY]: proof.record } : {}),
					...(completionAdvisories?.length ? { completionAdvisories } : {}),
					...(action.action === "dispatch_worker" && action.laneId ? { dispatchedLaneId: action.laneId } : {}),
					...(action.action === "dispatch_worker" && !action.laneId ? { dispatchSkipReason } : {}),
				},
				// A worker refused for its model's capability is a blocked outcome, never a success: the
				// requirement stays unbound and the granular reason reaches the model verbatim.
				...(dispatchSkipReason?.startsWith(WORKER_CAPABILITY_INSUFFICIENT_SKIP_REASON)
					? { isError: true as const, errorKind: "operation_outcome" as const }
					: {}),
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
	options: { admitRequirementCheck: (check: RequirementCheck) => string | undefined },
) {
	const createGoal: ToolDefinition = {
		name: GOAL_LIFECYCLE_TOOL_NAMES[0],
		label: GOAL_LIFECYCLE_TOOL_NAMES[0],
		description:
			"Start a durable goal when persistent autonomous continuation materially benefits the work, or when the user/system explicitly asks; skip routine short tasks. Pass every known requirement in `requirements` so the goal is set up in one call, then record the plan with one task_steps set.",
		promptSnippet: "Start a durable goal",
		neverDefer: true,
		parameters: createGoalSchema,
		async execute(toolCallId, input: Static<typeof createGoalSchema>, signal, onUpdate, context) {
			// All or nothing: a check the goal could never run refuses the whole call before the goal
			// exists, instead of leaving a started goal holding only the requirements before it.
			for (const requirement of input.requirements ?? []) {
				if (typeof requirement === "string" || !requirement.check) continue;
				const violation = options.admitRequirementCheck(requirement.check);
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
			return goalTool.execute(
				toolCallId,
				{
					action: "start",
					goalId,
					userGoal: input.objective,
					tokenBudget: input.token_budget,
					initialRequirements: input.requirements?.map((requirement) =>
						typeof requirement === "string" ? { text: requirement } : requirement,
					),
				},
				signal,
				onUpdate,
				context,
			);
		},
	};

	const getGoal: ToolDefinition = {
		name: GOAL_LIFECYCLE_TOOL_NAMES[1],
		label: GOAL_LIFECYCLE_TOOL_NAMES[1],
		description: "Read the current goal: status, budget, requirements, evidence, progress.",
		promptSnippet: "Read the durable goal",
		neverDefer: true,
		parameters: getGoalSchema,
		execute(toolCallId, _input, signal, onUpdate, context) {
			return goalTool.execute(toolCallId, { action: "get" }, signal, onUpdate, context);
		},
	};

	const updateGoal: ToolDefinition = {
		name: GOAL_LIFECYCLE_TOOL_NAMES[2],
		label: GOAL_LIFECYCLE_TOOL_NAMES[2],
		description:
			"Update the goal's status. active records progress after verifiable progress in the current turn; it never resumes a stopped goal. complete needs current evidence that proves the full objective, with no required work remaining. blocked needs the same verified owner/approval boundary or capability impossibility for three consecutive no-progress goal turns despite distinct recovery approaches, and no meaningful progress possible without owner input or external change; put the evidence and attempted approaches in reason; never use it because work is hard, slow, uncertain or would benefit from clarification. paused only when the owner explicitly asks to stop or pause this goal; then stop goal work (only the owner resumes it, with /goal resume).",
		promptSnippet: "Update goal status",
		neverDefer: true,
		executionMode: (args) => (args?.status === "complete" ? "foreground_barrier" : "parallel"),
		parameters: updateGoalSchema,
		execute(toolCallId, input: Static<typeof updateGoalSchema>, signal, onUpdate, context) {
			const requestedGoalStatus: GoalStatus = input.status === "complete" ? "completed" : input.status;
			const action: GoalToolInput =
				input.status === "paused"
					? { action: "pause_goal" }
					: isGoalExecutionActive(requestedGoalStatus)
						? { action: "progress" }
						: input.status === "complete"
							? { action: "complete", ...(input.account ? { account: input.account } : {}) }
							: { action: "block_goal", reason: input.reason ?? "" };
			return goalTool.execute(toolCallId, action, signal, onUpdate, context);
		},
	};

	return [createGoal, getGoal, updateGoal] as const;
}
