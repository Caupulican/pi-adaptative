import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { TaskBrief } from "../comms/comms-records.ts";
import type { WorkerDelegationTaskContext } from "../delegation/worker-delegation-request.ts";
import { deriveWorkerTaskLabel } from "../delegation/worker-task-label.ts";
import {
	type HostEventSubscriptionInput,
	hostEventArray,
	MAX_HOST_EVENT_SUBSCRIPTIONS_PER_TASK,
	parseHostEventSubscriptionInput,
} from "../events/host-event-contract.ts";
import { getGoalCompletionRefusal, hasGoalAcceptanceOverride } from "../goals/goal-acceptance.ts";
import type { GoalState } from "../goals/goal-state.ts";
import { type KnowledgeGrantReference, parseKnowledgeGrantReferences } from "../memory/knowledge-grant.ts";
import { agentBasisTurnOrigin, agentNativeTurnCount, agentTurnBasis } from "./agent-turn-basis.ts";
import { nativeAgentIdForAttempt } from "./attempt-agent-identity.ts";
import { projectAttemptUsage } from "./attempt-usage.ts";
import type {
	AttemptUsageSnapshot,
	HarnessCapability,
	OrchestrationDispatchRequest,
	RiskBudget,
	WorkerExecutionContract,
	WorkerModelRouteSource,
	WorkerRole,
} from "./contracts.ts";
import {
	MAX_ORCHESTRATION_DESCRIPTION_LENGTH,
	MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
	objectiveTakesNewWork,
} from "./contracts.ts";
import { OrchestrationEventStore } from "./event-store.ts";
import {
	type AttemptRuntimeState,
	DurableTaskRuntime,
	DurableTaskRuntimeError,
	validateTaskDependencyIds,
} from "./task-runtime.ts";
import { assertTaskAttemptBudgetForState } from "./task-runtime-reducer.ts";
import { goalObjectiveId, projectGoalAcceptanceEvidence, projectGoalObjective } from "./work-state-projection.ts";
import {
	normalizeWorkerContextForkReference,
	type WorkerContextForkReference,
} from "./worker-context-fork-reference.ts";
import { assertWorkerReceiptAdmission } from "./worker-receipt-origin.ts";

/**
 * The closed reasons a rung refusal carries. The ledger produces `identity_mismatch`, `acceptance_criteria_mismatch`,
 * `source_state_changed` and `attempt_ceiling`; the fleet start produces `authority_digest_mismatch`; `capacity` and
 * `other` are the transient refusals the ladder logs and retries.
 */
export const RUNG_REFUSAL_REASONS = [
	"identity_mismatch",
	"authority_digest_mismatch",
	"acceptance_criteria_mismatch",
	"source_state_changed",
	"attempt_ceiling",
	"capacity",
	"other",
] as const;
export type RungRefusalReason = (typeof RUNG_REFUSAL_REASONS)[number];

/**
 * A rung the ledger refused under its source task's identity. The message begins with the closed token
 * `rung_refused:<reason>`, which carries the reason across the start's skip-reason channel to the escalation ladder.
 */
export class RungRefusedError extends DurableTaskRuntimeError {
	readonly reason: RungRefusalReason;

	constructor(reason: RungRefusalReason, detail: string) {
		super(`rung_refused:${reason}: ${detail}`);
		this.name = "RungRefusedError";
		this.reason = reason;
	}
}

/** The start's skip reason for a ledger error raised while persisting a dispatch: a rung refusal keeps its own token. */
export function ledgerSkip(error: unknown): string {
	return error instanceof RungRefusedError ? error.message : "orchestration_ledger_error";
}

export interface DelegationLedgerOptions {
	agentDir: string;
	sessionId: string;
	now?: () => number;
	store?: OrchestrationEventStore;
}

export interface PrepareDelegationInput {
	knowledgeReferences?: readonly KnowledgeGrantReference[];
	subscriptions?: readonly HostEventSubscriptionInput[];
	receiptOrigin?: OrchestrationDispatchRequest["receiptOrigin"];
	turnOrigin?: OrchestrationDispatchRequest["turnOrigin"];
	laneId: string;
	instructions: string;
	/** The structured task `instructions` was rendered from, when the root used fields. */
	brief?: TaskBrief;
	/** Durable identity of the caller turn that admitted this dispatch; replays resolve back to it. */
	controlMessageId?: string;
	controlForkMode?: string;
	parentAgentId?: string;
	executionContract: WorkerExecutionContract;
	requiredCapabilities: readonly HarnessCapability[];
	goal?: GoalState;
	/** A delegation's objective (`delegation-…`) the turn's work belongs to; absent files the work under the session. */
	delegationObjectiveId?: string;
	verificationOfTaskId?: string;
	verificationOfAttemptId?: string;
	/** Set when this dispatch is a new attempt of its own task (an escalation rung): `laneId` must be that task. */
	attemptOfTaskId?: string;
	taskContext?: WorkerDelegationTaskContext;
	birthContextForkReference?: WorkerContextForkReference;
	/** Provenance of the admitted model; recorded on the dispatch, never compared as identity. */
	modelRouteSource?: WorkerModelRouteSource;
	modelPinSource?: string;
}

export interface PrepareManagedDelegationInput {
	laneId: string;
	dispatchSequence: number;
	instructions: string;
	profileId: string;
	provider: string;
	authorizationId: string;
	role: WorkerRole;
	riskBudget: RiskBudget;
	goal?: GoalState;
	goalId?: string;
	worktreeLaneKey?: string;
	worktreeLanePath?: string;
	/** Exact granted knowledge versions of this turn's task; never their values. */
	knowledgeReferences?: readonly KnowledgeGrantReference[];
	/** A third party's words the run that dispatched this turn carried; an earlier tainted turn of the lane taints it too. */
	turnOrigin?: OrchestrationDispatchRequest["turnOrigin"];
}

export interface StartedDelegationAttempt {
	objectiveId: string;
	taskId: string;
	attemptId: string;
	leaseId: string;
	fencingToken: number;
	expiresAt: string;
}

export interface PrepareAgentTurnInput {
	/** A new task starts empty; only an explicit current selection grants knowledge. */
	knowledgeReferences?: readonly KnowledgeGrantReference[];
	subscriptions?: readonly HostEventSubscriptionInput[];
	receiptOrigin?: OrchestrationDispatchRequest["receiptOrigin"];
	/** A third party's words the turn's message carries (its sender read them); the agent's own taint is kept anyway. */
	turnOrigin?: OrchestrationDispatchRequest["turnOrigin"];
	agentId: string;
	instructions: string;
	controlMessageId?: string;
	controlForkMode?: string;
	dependsOnTaskIds?: readonly string[];
	/**
	 * Goal this turn's work belongs to. Supplying it (or `taskContext`) declares NEW work: the caller
	 * owns the whole correlation and nothing is inherited from the task this specialist happened to
	 * run before. Omitting both declares an intentional continuation of the prior task's work.
	 */
	goal?: GoalState;
	/**
	 * Goal this turn's work belongs to when the caller carries only its identity -- a recovered
	 * mailbox turn, whose goal objective was admitted durably before the message was enqueued.
	 * Declares new work exactly like `goal` does.
	 */
	goalId?: string;
	/**
	 * The delegation objective (`delegation-…`) this turn's work belongs to. Declares new work like `goal` does: a
	 * leader's turn is filed under its delegation, so its outcome is that delegation's and no time window guesses it.
	 */
	delegationObjectiveId?: string;
	/** The runtime agent that wrote the mailbox message this turn runs, when a bot wrote it; provenance only. */
	senderAgentId?: string;
	/**
	 * Requirements, acceptance criteria, resources and dependencies of this turn's own work. Any
	 * field left out of a new-work turn is empty, never refilled from the prior task -- a reused
	 * specialist must not drag its first goal along forever.
	 */
	taskContext?: Partial<WorkerDelegationTaskContext>;
}

/** The objective id prefix of a delegation to a leader; work filed under it is that delegation's. */
export const LEADER_DELEGATION_OBJECTIVE_PREFIX = "delegation-";

export function isLeaderDelegationObjectiveId(objectiveId: string): boolean {
	return objectiveId.startsWith(LEADER_DELEGATION_OBJECTIVE_PREFIX);
}

function activeAttempt(attempt: AttemptRuntimeState): boolean {
	return attempt.status === "queued" || attempt.status === "leased" || attempt.status === "running";
}

/**
 * The durable task description is a BOUNDED PROJECTION of the authoritative brief. A task contract
 * bounds `description` at `MAX_ORCHESTRATION_DESCRIPTION_LENGTH`; a dispatched brief may be as long
 * as `MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH`. The brief itself is never shortened -- it is
 * persisted verbatim on `dispatch.instructions`, which is what the worker actually receives -- and
 * the projection says so explicitly instead of ending mid-sentence.
 */
const TASK_DESCRIPTION_ELISION = "\n[bounded task description; the complete brief is on this task's dispatch]";

export function projectTaskDescription(instructions: string): string {
	if (instructions.length <= MAX_ORCHESTRATION_DESCRIPTION_LENGTH) return instructions;
	return `${instructions.slice(0, MAX_ORCHESTRATION_DESCRIPTION_LENGTH - TASK_DESCRIPTION_ELISION.length)}${TASK_DESCRIPTION_ELISION}`;
}

function workerTurnTaskId(agentId: string, identity: { controlMessageId: string } | { sequence: number }): string {
	const correlated = "controlMessageId" in identity;
	return `${correlated ? "mailbox-turn" : "native-turn"}-${createHash("sha256")
		.update(correlated ? "pi-worker-agent-mailbox-turn-v1" : "pi-worker-agent-turn-v1")
		.update("\0")
		.update(agentId)
		.update("\0")
		.update(correlated ? identity.controlMessageId : String(identity.sequence))
		.digest("hex")}`;
}

/**
 * Durable adapter for in-process delegated completions. It records the dispatch before execution,
 * fences interrupted completions on restart, and returns queued work for event-driven re-dispatch.
 * It deliberately does not pretend an isolated completion has a resumable model transcript.
 */
function withoutRouteProvenance(
	dispatch: OrchestrationDispatchRequest,
): Omit<OrchestrationDispatchRequest, "modelRouteSource" | "modelPinSource"> {
	const { modelRouteSource: _route, modelPinSource: _pin, ...identity } = dispatch;
	return identity;
}

function dispatchEvidence(
	input: Pick<PrepareDelegationInput, "knowledgeReferences" | "subscriptions" | "receiptOrigin" | "turnOrigin">,
): Pick<OrchestrationDispatchRequest, "knowledgeReferences" | "subscriptions" | "receiptOrigin" | "turnOrigin"> {
	const knowledgeReferences = parseKnowledgeGrantReferences(input.knowledgeReferences ?? []);
	const subscriptions = hostEventArray(
		input.subscriptions ?? [],
		MAX_HOST_EVENT_SUBSCRIPTIONS_PER_TASK,
		parseHostEventSubscriptionInput,
		"task subscriptions",
	);
	return {
		...(knowledgeReferences.length ? { knowledgeReferences } : {}),
		...(subscriptions.length ? { subscriptions } : {}),
		...(input.receiptOrigin ? { receiptOrigin: input.receiptOrigin } : {}),
		...(input.turnOrigin ? { turnOrigin: input.turnOrigin } : {}),
	};
}

export class DelegationOrchestrationLedger {
	readonly runtime: DurableTaskRuntime;
	private readonly sessionId: string;

	constructor(options: DelegationLedgerOptions) {
		this.sessionId = options.sessionId;
		this.runtime = new DurableTaskRuntime({
			store:
				options.store ??
				new OrchestrationEventStore({
					agentDir: options.agentDir,
					sessionId: options.sessionId,
					...(options.now ? { now: () => new Date(options.now?.() ?? Date.now()).toISOString() } : {}),
				}),
			now: options.now,
		});
	}

	prepare(input: PrepareDelegationInput): AttemptRuntimeState {
		const profile = input.executionContract.worker.profile;
		const evidence = dispatchEvidence(input);
		return this.prepareNormalized({
			laneId: input.laneId,
			instructions: input.instructions,
			profileId: profile.profileId,
			role: profile.role,
			requiredCapabilities: input.requiredCapabilities,
			riskBudget: profile.budget,
			...(input.parentAgentId ? { parentAgentId: input.parentAgentId } : {}),
			executionContract: input.executionContract,
			...(input.goal ? { goal: input.goal } : {}),
			...(input.delegationObjectiveId ? { delegationObjectiveId: input.delegationObjectiveId } : {}),
			...(input.verificationOfTaskId
				? {
						verificationOfTaskId: input.verificationOfTaskId,
						verificationOfAttemptId: input.verificationOfAttemptId,
					}
				: {}),
			...(input.attemptOfTaskId !== undefined ? { attemptOfTaskId: input.attemptOfTaskId } : {}),
			...(input.taskContext ? { taskContext: input.taskContext } : {}),
			dispatchMetadata: {
				...evidence,
				logicalLaneId: input.laneId,
				...(input.controlMessageId ? { controlMessageId: input.controlMessageId } : {}),
				...(input.controlForkMode ? { controlForkMode: input.controlForkMode } : {}),
				...(input.brief ? { brief: input.brief } : {}),
				...(input.birthContextForkReference ? { birthContextForkReference: input.birthContextForkReference } : {}),
				...(input.modelRouteSource ? { modelRouteSource: input.modelRouteSource } : {}),
				...(input.modelPinSource ? { modelPinSource: input.modelPinSource } : {}),
			},
		});
	}

	prepareManaged(input: PrepareManagedDelegationInput): AttemptRuntimeState {
		if (!Number.isSafeInteger(input.dispatchSequence) || input.dispatchSequence < 1) {
			throw new DurableTaskRuntimeError("Managed dispatch sequence must be a positive integer.");
		}
		const taskId = `${input.laneId}:turn:${input.dispatchSequence}`;
		// The external process keeps every word an earlier turn read, so a turn after a tainted one carries the taint.
		const turnOrigin = input.turnOrigin?.thirdParty
			? input.turnOrigin
			: Object.values(this.runtime.getSnapshot().attempts).find(
					(attempt) =>
						attempt.dispatch.executionKind === "managed-process" &&
						attempt.dispatch.logicalLaneId === input.laneId &&
						attempt.dispatch.turnOrigin?.thirdParty,
				)?.dispatch.turnOrigin;
		return this.prepareNormalized({
			laneId: taskId,
			instructions: input.instructions,
			profileId: input.profileId,
			role: input.role,
			requiredCapabilities: [],
			riskBudget: input.riskBudget,
			...(input.goal ? { goal: input.goal } : {}),
			...(input.goalId ? { goalId: input.goalId } : {}),
			dispatchMetadata: {
				executionKind: "managed-process",
				logicalLaneId: input.laneId,
				dispatchSequence: input.dispatchSequence,
				provider: input.provider,
				authorizationId: input.authorizationId,
				...(input.worktreeLaneKey ? { worktreeLaneKey: input.worktreeLaneKey } : {}),
				...(input.worktreeLanePath ? { worktreeLanePath: input.worktreeLanePath } : {}),
				...dispatchEvidence({ knowledgeReferences: input.knowledgeReferences, turnOrigin }),
			},
		});
	}

	/**
	 * Queue one new turn for an existing logical agent. The agent identity and its immutable
	 * execution contract are inherited from the last bound turn. Each distinct control message owns
	 * one deterministic task/attempt identity; exact retries adopt it instead of minting new work.
	 */
	prepareAgentTurn(input: PrepareAgentTurnInput): { attempt: AttemptRuntimeState; created: boolean } {
		const agentId = input.agentId.trim();
		// Validated on the trimmed view, persisted verbatim: a brief is the worker's actual task text,
		// and the durable dispatch must carry exactly what the caller sent.
		const instructions = input.instructions;
		const controlMessageId = input.controlMessageId?.trim();
		if (!agentId) throw new DurableTaskRuntimeError("Logical worker agent id is required.");
		if (!instructions.trim()) throw new DurableTaskRuntimeError("Worker follow-up instructions are required.");
		if (
			input.controlMessageId !== undefined &&
			(!controlMessageId || controlMessageId.length > MAX_ORCHESTRATION_IDENTIFIER_LENGTH)
		) {
			throw new DurableTaskRuntimeError("Worker control message id is invalid.");
		}
		const snapshot = this.runtime.getSnapshot();
		const agent = snapshot.agents[agentId];
		if (!agent) throw new DurableTaskRuntimeError(`Unknown logical worker agent '${agentId}'.`);
		const sequence = agentNativeTurnCount(snapshot, agentId) + 1;
		const taskId = workerTurnTaskId(agentId, controlMessageId ? { controlMessageId } : { sequence });
		const existingTask = snapshot.tasks[taskId]?.task;
		const basis = agentTurnBasis(snapshot, agent.agentId);
		const contract = basis?.dispatch.executionContract;
		if (!basis || !contract) {
			throw new DurableTaskRuntimeError(`Logical worker agent '${agentId}' has no immutable execution contract.`);
		}
		if (basis.live && !snapshot.tasks[basis.taskId]) {
			throw new DurableTaskRuntimeError(`Logical worker agent '${agentId}' has no prior durable task.`);
		}
		// A delegation that has ended or paused takes no new turn: the runtime refuses one filed under it, so a turn not yet
		// admitted runs as session work. A turn already admitted keeps the objective it was filed under.
		const delegationObjectiveId =
			input.delegationObjectiveId !== undefined &&
			(existingTask !== undefined ||
				objectiveTakesNewWork(snapshot.objectives[input.delegationObjectiveId]?.objective))
				? input.delegationObjectiveId
				: undefined;
		// New work owns its own correlation; a continuation inherits the prior task's. The
		// discriminator is explicit so an omitted field means "this work has none", not "reuse the
		// last one" -- and so a `follow_up` is never silently reclassified as new work.
		const declaresNewWork = input.goal !== undefined || input.goalId !== undefined || input.taskContext !== undefined;
		// A turn that declares no delegation does not continue one: an owner's chat with a leader is session work, so
		// the prior delegation's correlation is not inherited. A turn of a delegation declares it explicitly.
		// A continuation of a released objective (its basis carries none) files as session work.
		const leavesDelegation =
			!declaresNewWork &&
			delegationObjectiveId === undefined &&
			(basis.objectiveId === undefined || isLeaderDelegationObjectiveId(basis.objectiveId));
		const newWork = declaresNewWork || leavesDelegation || delegationObjectiveId !== undefined;
		const goalId = input.goal?.goalId ?? input.goalId;
		const objectiveId = delegationObjectiveId
			? delegationObjectiveId
			: newWork
				? goalId
					? goalObjectiveId(goalId)
					: `session:${this.sessionId}`
				: basis.objectiveId!;
		const requirementIds = newWork
			? (input.taskContext?.requirementIds ?? [])
			: (basis.dispatch.requirementIds ?? []);
		const acceptanceCriterionIds = newWork
			? (input.taskContext?.acceptanceCriterionIds ?? [])
			: basis.acceptanceCriterionIds;
		const resourcePointerIds = newWork
			? (input.taskContext?.resourcePointerIds ?? [])
			: basis.dispatch.resourcePointerIds;
		const evidence = dispatchEvidence(input);
		const priorTurnOrigin = agentBasisTurnOrigin(snapshot, agent.agentId, basis);
		const dependencyTaskIds = validateTaskDependencyIds(
			snapshot.tasks,
			existingTask?.objectiveId ?? objectiveId,
			newWork ? (input.taskContext?.dependsOnTaskIds ?? input.dependsOnTaskIds) : input.dependsOnTaskIds,
		);
		if (existingTask && controlMessageId) {
			// A receipt is compared against the task IT admitted. Explicitly declared correlation is
			// part of that identity, so re-filing the same instructions under another goal is rejected.
			// A continuation declares none: its inherited correlation was resolved when the task was
			// created, and re-deriving it from whatever this specialist has done since would turn a
			// later unrelated task into a false conflict with this receipt's own work.
			if (
				existingTask.description !== projectTaskDescription(instructions) ||
				existingTask.role !== agent.role ||
				(newWork && existingTask.objectiveId !== objectiveId) ||
				(newWork && !isDeepStrictEqual([...existingTask.acceptanceCriterionIds], [...acceptanceCriterionIds])) ||
				existingTask.dependsOn.length !== dependencyTaskIds.length ||
				existingTask.dependsOn.some((dependencyId, index) => dependencyId !== dependencyTaskIds[index])
			) {
				throw new DurableTaskRuntimeError(
					`Worker control message '${controlMessageId}' has conflicting task identity.`,
				);
			}
			// A rung is a second attempt under its own control message id, so only this message's attempts are compared.
			const existingAttempts = (snapshot.tasks[taskId]?.attemptIds ?? [])
				.map((attemptId) => snapshot.attempts[attemptId])
				.filter((attempt) => !attempt || attempt.dispatch.controlMessageId === controlMessageId);
			for (const attempt of existingAttempts) {
				if (
					!attempt ||
					attempt.dispatch.logicalLaneId !== agentId ||
					attempt.dispatch.instructions !== instructions ||
					attempt.dispatch.controlForkMode !== input.controlForkMode ||
					!isDeepStrictEqual(attempt.dispatch.knowledgeReferences ?? [], evidence.knowledgeReferences ?? []) ||
					!isDeepStrictEqual(attempt.dispatch.subscriptions ?? [], evidence.subscriptions ?? []) ||
					(newWork && !isDeepStrictEqual([...(attempt.dispatch.requirementIds ?? [])], [...requirementIds])) ||
					(newWork && !isDeepStrictEqual([...attempt.dispatch.resourcePointerIds], [...resourcePointerIds]))
				) {
					throw new DurableTaskRuntimeError(
						`Worker control message '${controlMessageId}' has conflicting dispatch evidence.`,
					);
				}
			}
			const existingAttempt = existingAttempts.at(-1);
			// This IS the decision point: a replayed controlMessageId hands back an attempt that
			// already existed -- possibly minted in a prior process, before a resume -- shape-identical
			// to a fresh one otherwise. `created: false` is the only reliable signal a caller has that
			// this was NOT just dispatched; do not let it be reconstructed from the outside (e.g. via a
			// before/after snapshot diff keyed on the private turn-task identity) once this
			// method already knows the answer with certainty.
			if (!existingAttempt) throw new DurableTaskRuntimeError("Worker control message has no admitted attempt.");
			return { attempt: existingAttempt, created: false };
		}
		if (agent.status !== "registered") {
			throw new DurableTaskRuntimeError(`Logical worker agent '${agentId}' is not idle.`);
		}
		if (existingTask && !controlMessageId) {
			throw new DurableTaskRuntimeError(`Logical worker agent '${agentId}' already has turn ${sequence}.`);
		}
		return {
			attempt: this.prepareNormalized({
				laneId: taskId,
				instructions,
				profileId: contract.worker.profile.profileId,
				role: agent.role,
				requiredCapabilities: contract.worker.authority.capabilities,
				riskBudget: contract.worker.profile.budget,
				...(declaresNewWork && input.goal ? { goal: input.goal } : {}),
				...(objectiveId.startsWith("goal:") ? { goalId: objectiveId.slice("goal:".length) } : {}),
				...(delegationObjectiveId ? { delegationObjectiveId } : {}),
				taskContext: {
					requirementIds,
					dependsOnTaskIds: dependencyTaskIds,
					acceptanceCriterionIds,
					resourcePointerIds,
				},
				executionContract: contract,
				dispatchMetadata: {
					...evidence,
					// The conversation keeps every word an earlier turn read, so a turn after one that carried a third
					// party's words carries them too.
					...(evidence.turnOrigin === undefined && priorTurnOrigin ? { turnOrigin: priorTurnOrigin } : {}),
					logicalLaneId: agentId,
					dispatchSequence: sequence,
					...(controlMessageId ? { controlMessageId } : {}),
					...(input.controlForkMode ? { controlForkMode: input.controlForkMode } : {}),
					...(input.senderAgentId ? { senderAgentId: input.senderAgentId } : {}),
					...(basis.dispatch.birthContextForkReference
						? { birthContextForkReference: basis.dispatch.birthContextForkReference }
						: {}),
				},
			}),
			created: true,
		};
	}

	private prepareNormalized(input: {
		laneId: string;
		instructions: string;
		profileId: string;
		role: WorkerRole;
		requiredCapabilities: readonly HarnessCapability[];
		riskBudget: RiskBudget;
		parentAgentId?: string;
		goal?: GoalState;
		goalId?: string;
		/** The delegation objective this work is filed under; it takes precedence over the goal-derived objective. */
		delegationObjectiveId?: string;
		verificationOfTaskId?: string;
		verificationOfAttemptId?: string;
		attemptOfTaskId?: string;
		taskContext?: WorkerDelegationTaskContext;
		executionContract?: WorkerExecutionContract;
		dispatchMetadata?: Pick<
			OrchestrationDispatchRequest,
			| "receiptOrigin"
			| "turnOrigin"
			| "executionKind"
			| "logicalLaneId"
			| "dispatchSequence"
			| "controlMessageId"
			| "controlForkMode"
			| "brief"
			| "provider"
			| "authorizationId"
			| "worktreeLaneKey"
			| "worktreeLanePath"
			| "birthContextForkReference"
			| "modelRouteSource"
			| "modelPinSource"
			| "senderAgentId"
			| "knowledgeReferences"
			| "subscriptions"
		>;
	}): AttemptRuntimeState {
		let birthContextForkReference: WorkerContextForkReference | undefined;
		try {
			dispatchEvidence(input.dispatchMetadata ?? {});
			assertWorkerReceiptAdmission(input.dispatchMetadata?.receiptOrigin);
			birthContextForkReference =
				input.dispatchMetadata?.birthContextForkReference === undefined
					? undefined
					: normalizeWorkerContextForkReference(input.dispatchMetadata.birthContextForkReference);
		} catch (error) {
			throw new DurableTaskRuntimeError(error instanceof Error ? error.message : String(error));
		}
		let snapshot = this.runtime.getSnapshot();
		const existingVerificationSubject = input.verificationOfTaskId
			? snapshot.tasks[input.verificationOfTaskId]
			: undefined;
		if (input.verificationOfTaskId && !existingVerificationSubject) {
			throw new DurableTaskRuntimeError(`Unknown verification subject '${input.verificationOfTaskId}'.`);
		}
		const existingTask = snapshot.tasks[input.laneId]?.task;
		// A rung is a new attempt of its source task: it keeps that task's objective and dependencies, and restates neither
		// the goal nor the title or description, which the narrowed rerun instructions change.
		const rungSource = input.attemptOfTaskId === undefined ? undefined : existingTask;
		if (input.attemptOfTaskId !== undefined && (!rungSource || input.attemptOfTaskId !== input.laneId))
			throw new RungRefusedError(
				rungSource ? "identity_mismatch" : "source_state_changed",
				`Task '${input.laneId}' is not the rung's source.`,
			);
		// A rung refuses with a typed reason; any other start keeps the generic conflict it has always raised.
		const identityConflict = (message: string, reason: RungRefusalReason = "identity_mismatch") =>
			rungSource ? new RungRefusedError(reason, message) : new DurableTaskRuntimeError(message);
		const projectedGoal = input.goal && !rungSource ? projectGoalObjective(input.goal) : undefined;
		const objectiveId =
			rungSource?.objectiveId ??
			existingVerificationSubject?.task.objectiveId ??
			projectedGoal?.objectiveId ??
			input.delegationObjectiveId ??
			(input.goalId ? goalObjectiveId(input.goalId) : `session:${this.sessionId}`);
		const dependencyTaskIds = rungSource
			? [...rungSource.dependsOn]
			: validateTaskDependencyIds(snapshot.tasks, objectiveId, input.taskContext?.dependsOnTaskIds);
		if (
			existingTask &&
			(existingTask.objectiveId !== objectiveId ||
				(rungSource === undefined && existingTask.description !== projectTaskDescription(input.instructions)) ||
				existingTask.role !== input.role ||
				existingTask.dependsOn.length !== dependencyTaskIds.length ||
				existingTask.dependsOn.some((dependencyId, index) => dependencyId !== dependencyTaskIds[index]))
		) {
			throw identityConflict(`Task '${input.laneId}' has conflicting durable dispatch identity.`);
		}
		const taskStateBeforeWrites = snapshot.tasks[input.laneId];
		const activeAttemptBeforeWrites = taskStateBeforeWrites?.attemptIds
			.map((attemptId) => snapshot.attempts[attemptId])
			.find((attempt): attempt is AttemptRuntimeState => attempt !== undefined && activeAttempt(attempt));
		for (const attemptId of taskStateBeforeWrites?.attemptIds ?? []) {
			const durableReference = snapshot.attempts[attemptId]?.dispatch.birthContextForkReference;
			if (!isDeepStrictEqual(durableReference, birthContextForkReference)) {
				throw identityConflict(`Task '${input.laneId}' has a conflicting birth context fork reference.`);
			}
			if (
				!isDeepStrictEqual(
					snapshot.attempts[attemptId]?.dispatch.subscriptions ?? [],
					input.dispatchMetadata?.subscriptions ?? [],
				)
			)
				throw identityConflict(`Task '${input.laneId}' has conflicting initial event subscriptions.`);
		}
		const projectedEvidence =
			input.goal && objectiveId === projectedGoal?.objectiveId ? projectGoalAcceptanceEvidence(input.goal) : [];
		if (projectedGoal) this.runtime.assertObjectiveSynchronizationHeadroom(projectedGoal, projectedEvidence);
		this.runtime.assertProjectionHeadroom({
			objectives: snapshot.objectives[objectiveId] ? 0 : 1,
			tasks: taskStateBeforeWrites ? 0 : 1,
			attempts: activeAttemptBeforeWrites ? 0 : 1,
			threadSubscriptions: taskStateBeforeWrites ? 0 : (input.dispatchMetadata?.subscriptions?.length ?? 0),
		});
		if (input.goal && objectiveId === projectedGoal?.objectiveId) {
			this.synchronizeGoalState(input.goal);
			snapshot = this.runtime.getSnapshot();
		} else if (!rungSource && !snapshot.objectives[objectiveId]) {
			this.runtime.createObjective({
				objectiveId,
				title: input.goalId ? `Goal ${input.goalId}` : `Session ${this.sessionId}`,
				description: input.goalId ? "Externally managed goal work" : "Session-scoped delegated work",
			});
			snapshot = this.runtime.getSnapshot();
		}

		const verificationSubject = input.verificationOfTaskId ? snapshot.tasks[input.verificationOfTaskId] : undefined;
		const taskInput = {
			taskId: input.laneId,
			objectiveId,
			title: deriveWorkerTaskLabel(input.instructions, `Delegated ${input.role} work`),
			description: projectTaskDescription(input.instructions),
			role: input.role,
			dependsOn: dependencyTaskIds,
			requiredCapabilities: input.requiredCapabilities,
			acceptanceCriterionIds: input.taskContext?.acceptanceCriterionIds ?? [],
			riskBudget: input.riskBudget,
			...(input.dispatchMetadata?.subscriptions ? { subscriptions: input.dispatchMetadata.subscriptions } : {}),
			...(input.verificationOfTaskId
				? {
						verificationOfTaskId: input.verificationOfTaskId,
						verificationOfAttemptId: input.verificationOfAttemptId,
						acceptanceCriterionIds: verificationSubject?.task.acceptanceCriterionIds ?? [],
					}
				: {}),
		} as const;
		// A rung runs in its source agent's conversation. The source task may be a native turn whose logical lane is the agent,
		// so the rung's attempt is bound to the agent that owns the source's last attempt; the start resumes that conversation.
		// When that attempt has no agent, the dispatch keeps the lane it was given.
		const sourceLastAttempt = rungSource
			? snapshot.attempts[snapshot.tasks[input.laneId]?.attemptIds.at(-1) ?? ""]
			: undefined;
		const rungAgentId = sourceLastAttempt ? nativeAgentIdForAttempt(sourceLastAttempt) : undefined;
		const dispatch = {
			taskId: input.laneId,
			profileId: input.profileId,
			instructions: input.instructions,
			resourcePointerIds: input.taskContext?.resourcePointerIds ?? [],
			...(input.parentAgentId ? { parentAgentId: input.parentAgentId } : {}),
			requirementIds: input.taskContext?.requirementIds ?? [],
			...(input.executionContract ? { executionContract: input.executionContract } : {}),
			...input.dispatchMetadata,
			...(rungAgentId !== undefined ? { logicalLaneId: rungAgentId } : {}),
			...(birthContextForkReference ? { birthContextForkReference } : {}),
		} as const;
		if (
			existingTask &&
			((rungSource === undefined && existingTask.title !== taskInput.title) ||
				existingTask.verificationOfTaskId !== taskInput.verificationOfTaskId ||
				existingTask.verificationOfAttemptId !== taskInput.verificationOfAttemptId ||
				!isDeepStrictEqual(existingTask.requiredCapabilities, [...new Set(taskInput.requiredCapabilities)]) ||
				!isDeepStrictEqual(existingTask.riskBudget, taskInput.riskBudget))
		) {
			throw identityConflict(`Task '${input.laneId}' has conflicting durable task identity.`);
		}
		if (
			existingTask &&
			!isDeepStrictEqual(existingTask.acceptanceCriterionIds, [...new Set(taskInput.acceptanceCriterionIds)])
		) {
			throw identityConflict(
				`Task '${input.laneId}' has conflicting durable task identity.`,
				"acceptance_criteria_mismatch",
			);
		}
		// Route provenance is recorded, not identity: a replay from before it existed, or one whose
		// provenance differs, adopts the active attempt like any other exact replay.
		if (
			activeAttemptBeforeWrites &&
			!isDeepStrictEqual(
				withoutRouteProvenance(activeAttemptBeforeWrites.dispatch),
				withoutRouteProvenance(dispatch),
			)
		) {
			throw identityConflict(`Task '${input.laneId}' has conflicting durable dispatch identity.`);
		}
		if (!snapshot.tasks[input.laneId]) {
			return this.runtime.prepareTaskAttempt(
				{
					...taskInput,
				},
				dispatch,
			).attempt;
		}

		const task = snapshot.tasks[input.laneId];
		if (!task) throw new DurableTaskRuntimeError(`Failed to create task '${input.laneId}'.`);
		if (activeAttemptBeforeWrites) return activeAttemptBeforeWrites;
		if (rungSource) {
			// A rung runs only while its source is still failed or blocked, the state its escalation was decided under.
			if (task.task.status !== "failed" && task.task.status !== "blocked")
				throw new RungRefusedError(
					"source_state_changed",
					`Task '${input.laneId}' is ${task.task.status}, not failed or blocked.`,
				);
			// The attempt ceiling is the reducer's own rule; its refusal is reported as the typed reason, nothing else.
			try {
				assertTaskAttemptBudgetForState(task, snapshot.objectives[task.task.objectiveId]!.objective);
			} catch (error) {
				if (error instanceof DurableTaskRuntimeError) throw new RungRefusedError("attempt_ceiling", error.message);
				throw error;
			}
		}
		return this.runtime.queueAttempt(input.laneId, dispatch);
	}

	synchronizeGoalState(goal: GoalState): void {
		const objective = projectGoalObjective(goal);
		const evidence = projectGoalAcceptanceEvidence(goal);
		this.runtime.assertObjectiveSynchronizationHeadroom(objective, evidence);
		this.runtime.ensureObjective(objective);
		for (const item of evidence) {
			this.runtime.recordObjectiveEvidence(objective.objectiveId, item);
		}
		const status = this.runtime.getSnapshot().objectives[goalObjectiveId(goal.goalId)]?.objective.status;
		switch (goal.status) {
			case "active":
				if (status === "paused") this.runtime.resumeObjective(objective.objectiveId);
				break;
			case "paused":
			case "blocked":
			case "usage_limited":
			case "budget_limited":
				if (status === "active") this.runtime.pauseObjective(objective.objectiveId, "kernel");
				break;
			// A settled objective (completed or cancelled) is terminal: the goal's move toward the other terminal status
			// has nothing left to apply, so it is skipped rather than thrown.
			case "cancelled":
				if (status !== "cancelled" && status !== "completed") this.runtime.cancelObjective(objective.objectiveId);
				break;
			case "completed":
				// A completion the trusted evidence does not support is not applied here: the goal layer reopens the goal
				// as active on the same predicate, and the objective stays open until the evidence exists.
				if (status !== "completed" && status !== "cancelled" && getGoalCompletionRefusal(goal) === undefined) {
					this.runtime.completeObjectiveFromOwner(objective.objectiveId, hasGoalAcceptanceOverride(goal));
				}
				break;
		}
	}

	start(
		attemptId: string,
		leaseTtlMs: number,
		ownerId = `in-process:${this.sessionId}`,
		agentId?: string,
	): StartedDelegationAttempt {
		const snapshot = this.runtime.getSnapshot();
		const attempt = snapshot.attempts[attemptId];
		if (!attempt) throw new DurableTaskRuntimeError(`Unknown attempt '${attemptId}'.`);
		const task = snapshot.tasks[attempt.taskId];
		if (!task) throw new DurableTaskRuntimeError(`Unknown task '${attempt.taskId}'.`);
		const lease = this.runtime.leaseAttempt(attemptId, ownerId, leaseTtlMs, agentId);
		this.runtime.startAttempt(attemptId, lease.leaseId, lease.fencingToken);
		return {
			objectiveId: task.task.objectiveId,
			taskId: task.task.taskId,
			attemptId,
			leaseId: lease.leaseId,
			fencingToken: lease.fencingToken,
			expiresAt: lease.expiresAt,
		};
	}

	cancel(attemptId: string, reasonCode: string, reasonDetail?: string): void {
		this.runtime.cancelAttempt(attemptId, reasonCode, undefined, reasonDetail);
	}

	/** Durable accounting total, or the latest checkpoint for an attempt predating accounting. */
	getAttemptUsage(attemptId: string): AttemptUsageSnapshot | undefined {
		const snapshot = this.runtime.getSnapshot();
		const attempt = snapshot.attempts[attemptId];
		if (!attempt) throw new DurableTaskRuntimeError(`Unknown attempt '${attemptId}'.`);
		return projectAttemptUsage(attempt, snapshot.checkpoints);
	}

	/**
	 * Fence interrupted isolated completions whose lease owner `isOwnerGone` proves gone, and queue one replacement
	 * attempt per task.
	 */
	recoverQueuedDispatches(isOwnerGone: (ownerId: string) => boolean): AttemptRuntimeState[] {
		this.runtime.recoverInterruptedUnboundAttempts(
			(attempt) => attempt.dispatch.executionKind !== "managed-process",
			isOwnerGone,
		);
		let snapshot = this.runtime.getSnapshot();
		for (const task of Object.values(snapshot.tasks)) {
			const attempts = task.attemptIds.map((attemptId) => snapshot.attempts[attemptId]).filter(Boolean);
			if (attempts.some((attempt) => attempt && activeAttempt(attempt))) continue;
			const interrupted = [...attempts].reverse().find((attempt) => attempt?.status === "expired");
			if (!interrupted || task.task.status !== "ready") continue;
			const maxAttempts = task.task.riskBudget.maxAttempts;
			if (maxAttempts !== undefined && task.attemptIds.length >= maxAttempts) {
				this.runtime.failTask(task.task.taskId, "attempt_budget_exhausted");
				snapshot = this.runtime.getSnapshot();
				continue;
			}
			this.runtime.queueAttempt(task.task.taskId, interrupted.dispatch);
			snapshot = this.runtime.getSnapshot();
		}
		return Object.values(snapshot.attempts).filter(
			(attempt) => attempt.status === "queued" && attempt.dispatch.executionKind !== "managed-process",
		);
	}
}
