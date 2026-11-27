/**
 * Objective Execution Controller.
 * Deterministic loop owner for objective continuation, semantic routing, and completion gating.
 * Conforms to ROUTING_PROGRAM.md, COMPLETION_COORDINATOR.md, HUMAN_EDGE.md, and FINAL_PATCH_SPEC v2.1.
 */

import { createHash, randomUUID } from "node:crypto";
import type {
	AdaptiveCapabilityController,
	AdaptiveResolutionController,
	MaterializedSpecialist,
	SpecialistSynthesisController,
} from "../adaptive/index.ts";
import type { AuthorityEnvelope, ProposedAction } from "../autonomy/authority-envelope.ts";
import {
	compileExecutionCharter,
	DurableAuthorityBlockLedger,
	type ExecutionCharter,
	evaluateCharterAuthority,
} from "../autonomy/execution-charter.ts";
import { DurableHumanEdgeLedger, type HumanEdgeRequest, requiresHumanEdge } from "../autonomy/human-edge.ts";
import { resolveEffectiveCompletionProfile } from "../decision/completion-profile.ts";
import { settledAnswer } from "../decision/noul.ts";
import type { CompletionAssuranceProfile } from "../decision/policy.ts";
import type { SemanticResponsibilityController } from "../dedup/index.ts";
import type { ExpertBinding, ExpertOutcomeRecorder, ExpertSelectionService } from "../expert-routing/index.ts";
import { buildWorkerCapabilityRequest } from "../expert-routing/index.ts";
import { describeRequirementCheckRefusal, type RequirementCheckProof } from "../goals/prove-requirement-checks.ts";
import type { WorkerResultContract } from "../orchestration/contracts.ts";
import { objectiveNeedsCorrectedOutcome } from "../orchestration/objective-criteria.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { blocksRuleTransition } from "../project-rules/types.ts";
import {
	SteeringJudgmentUnavailableError,
	SteeringSemanticFailedError,
	type SystemOneSteeringPlane,
} from "../steering/index.ts";
import { readObjectiveWorkClass } from "../steering/programs.ts";
import { requestsBugFix } from "../system-one/bug-fix.ts";
import {
	type CandidateSnapshot,
	candidateSnapshotIdentity,
	captureCandidateSnapshotAsync,
} from "../system-one/candidate-snapshot.ts";
import {
	accountRequestDirective,
	assertVerificationResolved,
	isSameLaneVerificationDirective,
	type SystemOneControlDirective,
	sameLaneVerificationDirective,
} from "../system-one/control-directive.ts";
import type { TerminalCompletionOptions, TerminalCompletionProof } from "../system-one/controller.ts";
import type { FinalCompletionVerdict } from "../system-one/policy.ts";
import type { ExecutionState } from "../system-one/types.ts";
import {
	CompletionCoordinator,
	type CompletionEvaluationContext,
	type IndependentReviewerVerdict,
} from "./completion-coordinator.ts";
import { objectiveExecutionSignal } from "./current-objective-execution.ts";
import {
	buildDeliveryBundle,
	type DeliveryArtifact,
	type DeliveryBundle,
	type DeliveryTerminalStatus,
	sideEffectSucceeded,
} from "./delivery-bundle.ts";
import {
	type DeliveryGitExecutor,
	type DeliveryReleaseExecutor,
	deliveryCandidateIdentityLost,
	deliveryReceiptFailed,
	executeDelivery,
} from "./delivery-coordinator.ts";
import { type ApprovedCandidateTree, candidateTreeDigest } from "./delivery-proof.ts";
import { finalizeDelivery } from "./finalization-coordinator.ts";
import { evaluateRouteHistory, LocalRouteHistory } from "./ledger-route-checkpoints.ts";
import { applyLocalCommitCharter } from "./local-commit-delivery.ts";
import { objectiveJoinAttempts } from "./objective-readiness.ts";
import { completionFailuresToRepairWork, type RepairWork } from "./objective-repair-work.ts";
import {
	type ObjectiveRoute,
	type ObjectiveRouteExecutor,
	type ObjectiveRouteName,
	type ObjectiveTerminalResult,
	PENDING_WORKER_EXECUTOR,
	type RetrievalDisposition,
	routeToTerminal,
	validateObjectiveRoute,
	type WorkerRouteAdmission,
} from "./objective-route.ts";
import {
	dispatchObjectiveRoute,
	executeObjectiveRetrieval,
	executeObjectiveSpecialist,
	executeObjectiveWorker,
	executeWithRouteAdmission,
	runAdmittedRoute,
} from "./objective-route-execution.ts";
import {
	composeObjectiveRoute,
	INDEPENDENT_VERIFICATION_REASON_CODE,
	SAME_LANE_VERIFICATION_RECOVERY_REASON_CODE,
} from "./objective-route-policy.ts";
import {
	projectBoundedCombinedState,
	type RouteHistoryEntry,
	type SemanticRouteJudgments,
} from "./objective-route-projector.ts";
import { evidenceMarkerOf, type StallEvaluation } from "./objective-stall-fingerprint.ts";
import { judgeTransition } from "./transition-judgment.ts";

export type ExecutionLoopMode = "legacy_goal" | "objective_shadow" | "objective_primary" | "start_only" | "interactive";

export interface DisagreementTelemetryEvent {
	cycleId: string;
	objectiveId: string;
	legacyAction: string;
	objectiveRoute: ObjectiveRouteName;
	reasonCodes: readonly string[];
}

type RouteAcknowledgment =
	| { readonly kind: "supervision"; readonly signalId: string }
	| { readonly kind: "system_one"; readonly directive: SystemOneControlDirective };

type ObjectiveWorkerDispatch = (
	route: ObjectiveRoute,
	signal?: AbortSignal,
	binding?: ExpertBinding,
	onStarted?: () => void,
) => Promise<WorkerRouteAdmission> | Promise<void>;

export interface ObjectiveExecutionControllerDeps {
	executionSignal?(objectiveId: string, activeOnly?: boolean): AbortSignal | undefined;
	reviewCorrectedOutcome?(objectiveId: string, signal?: AbortSignal): Promise<void>;
	prepareGoalCompletion?(objectiveId: string): { key: string; refusal?: string; assertCurrent(): void } | undefined;
	runtime: {
		getEvidenceRevision?(objectiveId: string): number | Promise<number>;
		reconcileObjective(objectiveId: string): Promise<TaskRuntimeProjection>;
		recordExecutorRefusal?(
			objectiveId: string,
			route: ObjectiveRoute,
			reasons: readonly string[],
		): ObjectiveTerminalResult | undefined;
		/** Session adapters fence superseded goal routes without changing historical objective state. */
		assertExecutionCurrent?(objectiveId: string): void;
		ensureRepairTasks?(objectiveId: string, repairs: readonly RepairWork[]): Promise<void>;
		requestReplan?(objectiveId: string, stall: StallEvaluation): Promise<void>;
		isBudgetExhausted?(objectiveId: string): boolean;
		isCancelled?(objectiveId: string): boolean;
		getSourceRevision?(objectiveId: string): Promise<string> | string;
		getArtifacts?(objectiveId: string): Promise<readonly DeliveryArtifact[]> | readonly DeliveryArtifact[];
		getLimitations?(objectiveId: string): Promise<readonly string[]> | readonly string[];
	};
	systemOne?: {
		adapter?: { provenance?: string };
		snapshot?(): ExecutionState;
		/** The completion projection every completion judgment reads (SystemOneController.completionView). */
		completionView?(signal?: AbortSignal): Promise<{ view: Record<string, unknown>; repositoryOutcome: boolean }>;
		evaluateObjectiveRoute?(objectiveId: string, options?: { signal?: AbortSignal }): Promise<SemanticRouteJudgments>;
		executeCompletionTransaction?(
			isBugFix: boolean,
			options?: { signal?: AbortSignal; persistTerminal?: boolean },
		): Promise<FinalCompletionVerdict>;
		commitTerminalCompletion?(input: TerminalCompletionProof, options?: TerminalCompletionOptions): Promise<void>;
		validateObjectivePostflight?(objectiveId: string): Promise<void>;
		recordHostEvidence?(evidence: unknown): Promise<void>;
		syncOwnerCorrection?(entryId: string): void;
		peekControlDirective?(): SystemOneControlDirective | undefined;
		/** With `expected`, clears only the still-current directive represented by the executed route. */
		consumeControlDirective?(expected?: SystemOneControlDirective): SystemOneControlDirective | undefined;
		noteControlDirective?(directive: SystemOneControlDirective): void;
	};
	repoRoot?: string;
	authorityEnvelope?: AuthorityEnvelope;
	humanEdgeLedger?: DurableHumanEdgeLedger;
	completionProfile?: CompletionAssuranceProfile;
	reviewer?: {
		review(input: {
			objectiveId: string;
			sourceRevision: string;
			acceptanceMatrix: Record<string, unknown>;
		}): Promise<IndependentReviewerVerdict> | IndependentReviewerVerdict;
	};
	evidence?: {
		getEvidenceRevision?(objectiveId: string): number | Promise<number>;
		reconcile?(objectiveId: string): Promise<void>;
		ingestLatest?(objectiveId: string): Promise<void>;
	};
	waiter?: {
		wait(waitContext: unknown, signal?: AbortSignal): Promise<void>;
	};
	checkpoints?: {
		recordRoute(route: ObjectiveRoute): Promise<void>;
		/** Who ran the route once it ran: root, worker, wait, terminal. */
		recordRouteOutcome?(route: ObjectiveRoute, executor: string): Promise<void>;
		/** The objective's recent routes, oldest first, for the judge's history block. */
		recentRoutes?(objectiveId: string, limit: number): Promise<readonly RouteHistoryEntry[]>;
	};
	stalls?: {
		evaluate(objectiveId: string): Promise<StallEvaluation>;
	};
	retrieval?: {
		/** Resolves with who gathered (the root or workers), recorded as the route's executor. */
		reportsAdmission?: boolean;
		execute(
			route: ObjectiveRoute,
			signal?: AbortSignal,
			submitted?: (executor: "worker" | "root") => void,
		): Promise<RetrievalDisposition | undefined>;
	};
	verifier?: ObjectiveRouteExecutor;
	workerDispatcher?: {
		dispatch: ObjectiveWorkerDispatch;
		continueWorker: ObjectiveWorkerDispatch;
		dispatchEscalated: ObjectiveWorkerDispatch;
		readonly ownsSpecialistAttempts?: boolean;
		dispatchSpecialist?(input: {
			objectiveId: string;
			route: ObjectiveRoute;
			onStarted?: () => void;
			specialist: MaterializedSpecialist;
			taskId: string;
			attemptId?: string;
			leaseId?: string;
			fencingToken?: number;
			expiresAt?: string;
			signal?: AbortSignal;
		}): Promise<WorkerResultContract | WorkerRouteAdmission>;
	};
	expertSelector?: ExpertSelectionService;
	outcomeRecorder?: ExpertOutcomeRecorder;
	/**
	 * The root model as an executor: one foreground turn carrying the route's brief. Used for the
	 * routes System One does not hand to an independent worker (implement, investigate, replan,
	 * retrieval and non-independent verification); review and escalations stay with workers.
	 */
	rootExecutor?: ObjectiveRouteExecutor;
	/**
	 * Who executes a route the root may take: the root (the talker, on its warm cache) or a worker given
	 * the route's brief, by what each costs (`priceExecutor`). Absent, the root takes it.
	 */
	chooseExecutor?(route: ObjectiveRoute): "root" | "worker";
	runnableRequirements?(objectiveId: string): readonly string[] | undefined;
	/** The owner's authority is what the objective waits on right now: an open question or an operator blocker. */
	ownerRequired?(objectiveId: string): boolean;
	/** Unconsumed specialist/capability/verifier requests from live worker supervision. */
	pendingSupervisionRequests?(): readonly {
		readonly signal_id: string;
		/** The objective of the worker that raised the request; only that objective's route adopts it. */
		readonly objective_id: string;
		readonly action: string;
		readonly reason_codes?: readonly string[];
	}[];
	consumePendingSupervisionRequest?(signalId: string): void;
	mode?: ExecutionLoopMode;
	executionCharter?: ExecutionCharter;
	/** Set when System One classified this task as local commits. Empty string means detached HEAD. */
	localCommitBranch?(): string | undefined;
	/** unset: written rules apply. ask: the user has not chosen. user: the request is above the files. */
	ruleAuthority?(): "unset" | "ask" | "user" | "written";
	authorityBlockLedger?: DurableAuthorityBlockLedger;
	/** Paths the objective itself wrote. Unlisted worktree changes block automatic git delivery. */
	attributedMutationPaths?(): readonly string[];
	/** Precise reason the owned-path set is empty: shell mutation or digest drift. */
	deliveryBlockReason?(): string | undefined;
	/** Resolves when no mutation-capable call for this objective is still running. */
	waitForRepositoryQuiescence?(objectiveId: string, signal?: AbortSignal): Promise<void>;
	/**
	 * Rerun the goal's requirement checks and record their results (goals/prove-requirement-checks.ts),
	 * the same proof the goal tool's completion takes. Undefined when there is no goal.
	 */
	proveRequirementChecks?(
		signal: AbortSignal | undefined,
		objectiveId: string,
	): Promise<RequirementCheckProof | undefined>;
	ownedPathDigests?(): readonly { readonly path: string; readonly digest: string }[];
	gitExecutor?: DeliveryGitExecutor;
	releaseExecutor?: DeliveryReleaseExecutor;
	steeringPlane?: SystemOneSteeringPlane;
	adaptiveResolution?: AdaptiveResolutionController;
	specialistSynthesis?: SpecialistSynthesisController;
	adaptiveCapabilities?: AdaptiveCapabilityController;
	responsibilityController?: SemanticResponsibilityController;
	onDisagreementTelemetry?(event: DisagreementTelemetryEvent): void;
	onHumanEdgeRequest?(request: HumanEdgeRequest): Promise<boolean> | boolean;
	/** Told what the owner has to resolve when a human-edge request blocks the objective, and `undefined` when it clears. */
	onOwnerBlocker?(blocker: string | undefined): void;
	getRouteProposedAction?(route: ObjectiveRoute): ProposedAction;
	/**
	 * Root semantic project rules. A blocking violation queues durable RepairWork and stops the
	 * transition it was found at: postflight does not advance, completion does not finalize.
	 */
	projectRules?: {
		validateTaskPostflight(input: {
			objectiveId: string;
			taskId: string;
			changedFiles: readonly string[];
			boundedDiffEvidence?: Record<string, unknown>;
			signal?: AbortSignal;
		}): Promise<{
			passed: boolean;
			advisory?: boolean;
			verificationRequired?: boolean;
			violations: readonly { consequence: string; explanation: string }[];
		}>;
		validateCompletion(
			input: {
				objectiveId: string;
				changedFiles: readonly string[];
				boundedDiffEvidence?: Record<string, unknown>;
				signal?: AbortSignal;
			},
			options?: { record?: boolean },
		): Promise<{
			passed: boolean;
			advisory?: boolean;
			verificationRequired?: boolean;
			violations: readonly { consequence: string; explanation: string }[];
		}>;
	};
}

function routeStateProjection(
	deps: ObjectiveExecutionControllerDeps,
	objectiveId: string,
	runtime: TaskRuntimeProjection,
	stall: StallEvaluation,
	history: readonly RouteHistoryEntry[],
	initialDigest: string,
	routeSnapshot: CandidateSnapshot | undefined,
	afterDigest: string,
) {
	return projectBoundedCombinedState(objectiveId, runtime, {
		stallTurns: stall.stallTurns,
		strategyFingerprint: stall.fingerprint,
		history,
		beforeDigest: initialDigest,
		afterDigest,
		systemOneState: deps.systemOne?.snapshot?.(),
		candidateDigest: routeSnapshot?.digest,
		integrityState: deps.systemOne?.snapshot ? "available" : "unavailable",
	});
}

/** Reason code of a completion route held back because running work exists anywhere in the runtime. */
export const COMPLETION_FENCED_REASON_CODE = "completion_fenced_by_running_work";

async function captureOptionalSnapshot(repoRoot: string | undefined): Promise<CandidateSnapshot | undefined> {
	if (!repoRoot) return undefined;
	try {
		return await captureCandidateSnapshotAsync(repoRoot);
	} catch {
		return undefined;
	}
}

export class ObjectiveExecutionController {
	private readonly deps: ObjectiveExecutionControllerDeps;
	private readonly localRoutes = new LocalRouteHistory();
	private readonly humanEdgeLedger: DurableHumanEdgeLedger;
	private readonly authorityBlockLedger: DurableAuthorityBlockLedger;
	private readonly attemptBindings = new Map<string, { binding: ExpertBinding; route: ObjectiveRoute }>();
	private readonly admittedObjectives = new Map<string, AbortSignal | undefined>();
	private readonly admissionCerts = new Map<string, string[]>();
	private readonly alternativesTried = new Set<string>();
	private readonly routeAcknowledgments = new WeakMap<ObjectiveRoute, RouteAcknowledgment>();
	/** The running attempts a decided `wait_for_worker` route waits on. */
	private readonly routeWaitAttempts = new WeakMap<ObjectiveRoute, readonly AttemptRuntimeState[]>();
	private readonly completedVerificationRecoveries = new Map<string, string>();
	private cycleCounter = 0;
	private _lastBinding?: ExpertBinding;
	private _lastRoute?: ObjectiveRoute;
	private readonly executors = new WeakMap<ObjectiveRoute, string>();

	private assertExecutionCurrent(objectiveId: string, signal?: AbortSignal): void {
		signal?.throwIfAborted();
		this.deps.runtime.assertExecutionCurrent?.(objectiveId);
	}

	private nextCycleId(): string {
		return `cycle_${++this.cycleCounter}_${randomUUID().slice(0, 8)}`;
	}

	private async _noteExecutor(route: ObjectiveRoute, runtime: TaskRuntimeProjection, executor: string): Promise<void> {
		const prior = this.executors.get(route);
		if (prior === executor || (prior !== undefined && executor === PENDING_WORKER_EXECUTOR)) return;
		this.executors.set(route, executor);
		if (executor === PENDING_WORKER_EXECUTOR) return;
		if (!this.deps.checkpoints?.recentRoutes) this.localRoutes.record(route, runtime, executor);
		await this.deps.checkpoints?.recordRouteOutcome?.(route, executor);
	}

	private acknowledgeRouteRequests(route: ObjectiveRoute): void {
		const acknowledgment = this.routeAcknowledgments.get(route);
		if (!acknowledgment) return;

		if (acknowledgment.kind === "supervision") {
			this.deps.consumePendingSupervisionRequest?.(acknowledgment.signalId);
		} else {
			this.deps.systemOne?.consumeControlDirective?.(acknowledgment.directive);
		}
		this.routeAcknowledgments.delete(route);
	}
	private ownerBlockerSink?: (blocker: string | undefined) => void;

	/** The route the last run cycle evaluated; the session's loop reads it to name a wait or a stop. */
	getLastRoute(): ObjectiveRoute | undefined {
		return this._lastRoute;
	}

	/** Explicit owner resumption grants another recovery attempt without resolving its findings. */
	resetVerificationRecovery(objectiveId: string): void {
		this.completedVerificationRecoveries.delete(objectiveId);
	}

	private verificationRecoveryFingerprint(objectiveId: string, runtime: TaskRuntimeProjection): string {
		const state = this.deps.systemOne?.snapshot?.();
		const objective = runtime.objectives[objectiveId];
		return createHash("sha256")
			.update(
				JSON.stringify({
					objective: objective?.objective.description,
					ownerCorrection: objective?.goalSource?.lastCorrection?.ownerEntryId,
					evidence: objective?.evidence,
					findings: this.deps.systemOne?.peekControlDirective?.()?.reasonCodes,
					// Canonical hydration stamps observations with the projection revision and open
					// obligations with "now". Neither is an executed diagnostic/check receipt.
					observations: state?.observations.map((observation) => ({
						...observation,
						source: {
							kind: observation.source.kind,
							locator: observation.source.locator,
							content_hash: observation.source.content_hash,
							line_start: observation.source.line_start,
							line_end: observation.source.line_end,
							trust: observation.source.trust,
						},
					})),
					verification: state?.verification.map((verification) => ({
						id: verification.id,
						kind: verification.kind,
						status: verification.status,
						command: verification.command,
						artifact_ref: verification.artifact_ref,
						covers_acceptance_ids: verification.covers_acceptance_ids,
						observation_ids: verification.observation_ids,
					})),
					changes: state?.changes,
				}),
			)
			.digest("hex");
	}

	/**
	 * Late-bound executors owned by the live session (the root turn, worker waits, System One's
	 * completion transaction, the completion profile): the stack is built before the session exists.
	 */
	bindSessionExecutors(
		executors: Partial<
			Pick<
				ObjectiveExecutionControllerDeps,
				| "rootExecutor"
				| "executionSignal"
				| "prepareGoalCompletion"
				| "reviewCorrectedOutcome"
				| "chooseExecutor"
				| "runnableRequirements"
				| "waiter"
				| "retrieval"
				| "verifier"
				| "systemOne"
				| "completionProfile"
				| "mode"
				| "checkpoints"
				| "stalls"
				| "ownerRequired"
				| "pendingSupervisionRequests"
				| "consumePendingSupervisionRequest"
				| "repoRoot"
				| "gitExecutor"
				| "releaseExecutor"
				| "attributedMutationPaths"
				| "deliveryBlockReason"
				| "waitForRepositoryQuiescence"
				| "proveRequirementChecks"
				| "ownedPathDigests"
				| "localCommitBranch"
				| "ruleAuthority"
			>
		>,
	): void {
		Object.assign(this.deps, executors);
	}

	/** Late-bound: the session that owns the operator projection binds it after the stack is built. */
	setOwnerBlockerSink(sink: ((blocker: string | undefined) => void) | undefined): void {
		this.ownerBlockerSink = sink;
	}

	constructor(deps: ObjectiveExecutionControllerDeps) {
		this.deps = deps;
		this.ownerBlockerSink = deps.onOwnerBlocker;
		this.humanEdgeLedger = deps.humanEdgeLedger ?? new DurableHumanEdgeLedger();
		this.authorityBlockLedger = deps.authorityBlockLedger ?? new DurableAuthorityBlockLedger();
		if (this.getMode() === "start_only" && !deps.executionCharter) {
			throw new Error("ExecutionCharter is required in start_only mode; compile once at admission (PH-102)");
		}
	}

	getMode(): ExecutionLoopMode {
		return this.deps.mode ?? "objective_shadow";
	}

	private throwIfRequiredSemantic(err: unknown): void {
		if (this.deps.steeringPlane?.policy.mode === "system_one_required") throw err;
	}

	getHumanEdgeLedger(): DurableHumanEdgeLedger {
		return this.humanEdgeLedger;
	}

	getAuthorityBlockLedger(): DurableAuthorityBlockLedger {
		return this.authorityBlockLedger;
	}

	async step(options: {
		objectiveId: string;
		action?: string;
		input?: Record<string, unknown>;
		signal?: AbortSignal;
	}): Promise<{ action: string; executed: boolean; result?: unknown }> {
		const { objectiveId, action = "escalate_capability", input } = options;
		const signal = objectiveExecutionSignal(this.deps, objectiveId, options.signal, true);
		signal?.throwIfAborted();
		this.assertExecutionCurrent(objectiveId);

		if (action === "escalate_capability") {
			const route: ObjectiveRoute = {
				schema_version: "1.0",
				cycle_id: this.nextCycleId(),
				objective_id: objectiveId,
				route: "escalate_capability",
				reason_codes: ["explicit_step"],
			};
			const charter =
				this.deps.executionCharter ??
				compileExecutionCharter({
					objectiveId,
					prompt: (input?.description as string) ?? `Escalate capability for ${objectiveId}`,
				});
			const rawRuntime = this.deps.runtime as any;
			const runtime: TaskRuntimeProjection =
				rawRuntime?.objectives && rawRuntime?.tasks
					? (rawRuntime as TaskRuntimeProjection)
					: typeof rawRuntime?.reconcileObjective === "function"
						? await rawRuntime.reconcileObjective(objectiveId)
						: typeof rawRuntime?.getSnapshot === "function"
							? rawRuntime.getSnapshot()
							: rawRuntime;

			if (this.deps.specialistSynthesis) {
				const needInput = (input?.need as Record<string, unknown>) ?? {};
				const specialist = await this.deps.specialistSynthesis.resolveOrCreate({
					objectiveId,
					taskId: `${objectiveId}-spec-${this.cycleCounter}`,
					need: {
						specialty: (needInput.domain as string) ?? "ui_ux",
						purpose: (input?.description as string) ?? (needInput.mission as string) ?? "Specialist mission",
						authorityRole: (input?.role as string) ?? "implementer",
						mission: (input?.title as string) ?? (needInput.mission as string) ?? "Specialist mission",
					},
					charter,
					signal,
				});

				this.assertExecutionCurrent(objectiveId, signal);
				await this.deps.checkpoints?.recordRoute?.(route);
				const taskRunner = (rawRuntime?.createTask ? rawRuntime : runtime) as any;
				const snapshot = taskRunner?.getSnapshot?.();
				if (snapshot && !snapshot.objectives?.[objectiveId]) {
					taskRunner?.createObjective?.({
						objectiveId,
						title: (input?.title as string) ?? `Objective ${objectiveId}`,
						description: (input?.description as string) ?? `Objective ${objectiveId}`,
					});
				}
				const specTaskId = `${objectiveId}-spec-${++this.cycleCounter}`;
				const workerResult = await this.runSpecialistWorkerExecution(
					taskRunner,
					specialist,
					specTaskId,
					objectiveId,
					route,
					signal,
				);

				return {
					action,
					executed: this.executors.get(route) !== PENDING_WORKER_EXECUTOR,
					result: workerResult,
				};
			}
		}

		return {
			action,
			executed: false,
		};
	}

	private async recentRouteHistory(objectiveId: string): Promise<readonly RouteHistoryEntry[]> {
		return this.deps.checkpoints?.recentRoutes?.(objectiveId, 8) ?? this.localRoutes.recent(objectiveId, 8);
	}

	async evaluateRouteOnce(
		objectiveId: string,
		options?: { signal?: AbortSignal; legacyActionHint?: string },
	): Promise<ObjectiveRoute> {
		const signal = objectiveExecutionSignal(this.deps, objectiveId, options?.signal);
		const routeSnapshot = await captureOptionalSnapshot(this.deps.repoRoot);
		const initialDigest = routeSnapshot?.digest ?? "unknown";
		signal?.throwIfAborted();
		this.assertExecutionCurrent(objectiveId, signal);
		const cycleId = this.nextCycleId();

		const runtime = await this.deps.runtime.reconcileObjective(objectiveId);

		// Reconcile evidence
		await this.deps.evidence?.reconcile?.(objectiveId);

		const history = await this.recentRouteHistory(objectiveId);
		const judgedMarker = evidenceMarkerOf(runtime, objectiveId);
		const stall = (await this.deps.stalls?.evaluate(objectiveId)) ?? evaluateRouteHistory(history, judgedMarker);

		// Evaluate semantic route via SteeringPlane JEV-004 (PH-113: JEV-004 route owner)
		let semantic: SemanticRouteJudgments = {};
		let routeCertificateId: string | undefined;
		const correction = runtime.objectives[objectiveId]?.goalSource?.lastCorrection;
		if (correction) this.deps.systemOne?.syncOwnerCorrection?.(correction.ownerEntryId);
		const verificationPending = isSameLaneVerificationDirective(this.deps.systemOne?.peekControlDirective?.());

		if (!verificationPending && this.deps.steeringPlane) {
			try {
				const stateProjection = routeStateProjection(
					this.deps,
					objectiveId,
					runtime,
					stall,
					history,
					initialDigest,
					routeSnapshot,
					(await captureOptionalSnapshot(this.deps.repoRoot))?.digest ?? "unknown",
				);
				const cert = await this.deps.steeringPlane.requireCertificate("JEV-004", stateProjection, {
					objectiveId,
					signal,
				});

				routeCertificateId = cert.certificate_id;
				const spAns = cert.answers.semantic_progress as { level?: number; score?: number } | undefined;

				// Certificate answers carry the band; an ambiguous one settles nothing and reads as undefined.
				// The work class acts only at its probability floor. The route program asks neither whether
				// the current worker can continue nor whether an external blocker is present, so neither is
				// read here: external blockers and worker waits come from deterministic facts.
				semantic = {
					workRemaining: settledAnswer(cert.answers.work_remaining),
					missingWorkClass: readObjectiveWorkClass(cert.answers, cert.unsure_semantic_predicates),
					independentWorkerRequired: settledAnswer(cert.answers.independent_worker_required),
					capabilityEscalationRequired: settledAnswer(cert.answers.capability_escalation_required),
					semanticProgress: spAns?.level ?? spAns?.score,
					contextStale: settledAnswer(cert.answers.context_stale),
					strategyRepetition: settledAnswer(cert.answers.strategy_repetition),
				};
			} catch (err) {
				// Routing is reversible work. An unsettled route judgment gathers evidence; an outage routes
				// on deterministic facts alone. Anything else keeps its required-mode failure.
				if (err instanceof SteeringSemanticFailedError && err.outcome === "gather_more") {
					semantic = { missingWorkClass: "insufficient_evidence" };
				} else if (
					!isReversibleDoubtOrOutage(err) &&
					this.deps.steeringPlane.policy.mode === "system_one_required"
				) {
					throw err;
				}
			}
		} else if (!verificationPending && this.deps.systemOne?.evaluateObjectiveRoute) {
			try {
				semantic = await this.deps.systemOne.evaluateObjectiveRoute(objectiveId, { signal });
			} catch (err) {
				this.throwIfRequiredSemantic(err);
			}
		}

		// Readiness is read after the asynchronous judgment above, so cancellation, budget and work
		// admitted while System One was answering all reach this route.
		const current = await this.deps.runtime.reconcileObjective(objectiveId);
		this.assertExecutionCurrent(objectiveId, signal);
		const cancelled =
			this.deps.runtime.isCancelled?.(objectiveId) ??
			current.objectives[objectiveId]?.objective.status === "cancelled";
		const budgetExhausted = this.deps.runtime.isBudgetExhausted?.(objectiveId);
		const activeAttempts = objectiveJoinAttempts(current, objectiveId, this.deps.repoRoot);
		const requiredWorkerInFlight = activeAttempts.length > 0;

		let pendingDirective = this.deps.systemOne?.peekControlDirective?.();
		if (
			pendingDirective === undefined &&
			this.deps.systemOne?.peekControlDirective === undefined &&
			this.deps.systemOne?.consumeControlDirective &&
			this.deps.systemOne.noteControlDirective
		) {
			// Legacy consume-only adapters borrow and immediately restore the directive. Execution later
			// acknowledges the exact identity; composition itself never transfers ownership.
			pendingDirective = this.deps.systemOne.consumeControlDirective();
			if (pendingDirective) this.deps.systemOne.noteControlDirective(pendingDirective);
		}
		const pendingSupervision = requiredWorkerInFlight
			? undefined
			: this.deps.pendingSupervisionRequests?.().find((request) => request.objective_id === objectiveId);
		const verificationDirective = isSameLaneVerificationDirective(pendingDirective) ? pendingDirective : undefined;
		const currentEvidenceMarker = evidenceMarkerOf(current, objectiveId);
		const sameEvidence = currentEvidenceMarker === judgedMarker;
		const repeatedSameLaneVerification =
			verificationDirective !== undefined &&
			history.filter(
				(entry) =>
					entry.evidenceMarker === currentEvidenceMarker &&
					verificationDirective.reasonCodes.every((reasonCode) => entry.reasonCodes.includes(reasonCode)),
			).length >= 2;
		const supervisionAction =
			pendingSupervision?.action === "request_specialist" ||
			pendingSupervision?.action === "request_capability" ||
			pendingSupervision?.action === "request_verifier" ||
			pendingSupervision?.action === "mark_external_block"
				? pendingSupervision.action
				: undefined;
		const composed = composeObjectiveRoute({
			cycleId,
			objectiveId,
			cancelled,
			budgetExhausted,
			requiredWorkerInFlight,
			ownerRequired: this.deps.ownerRequired?.(objectiveId) ?? false,
			targetRequirementIds: this.deps.runnableRequirements?.(objectiveId)?.slice(0, 1),
			strategyRepetition: sameEvidence && stall.repeatedWithoutNewEvidence,
			repeatedSameLaneVerification,
			semantic: sameEvidence ? semantic : { ...semantic, strategyRepetition: undefined },
			...(supervisionAction && pendingSupervision
				? {
						supervisionRequest: {
							action: supervisionAction,
							reasonCodes: pendingSupervision.reason_codes ?? [],
						},
					}
				: {}),
			...(pendingDirective
				? {
						systemOneDirective: {
							objectiveRoute: pendingDirective.objectiveRoute,
							reasonCodes: pendingDirective.reasonCodes,
						},
					}
				: {}),
		});
		// Completion is fenced by running work anywhere in the runtime, not only this objective's:
		// repository quiescence and delivery ownership are objective-scoped, so unrelated running work
		// must never let completion start earlier than it could before that work was scoped out.
		const completionFence =
			composed.route === "completion_candidate"
				? Object.values(current.attempts).filter((attempt) => attempt.status === "running")
				: [];
		const route: ObjectiveRoute =
			completionFence.length > 0
				? {
						...composed,
						route: "wait_for_worker",
						reason_codes: [COMPLETION_FENCED_REASON_CODE, ...composed.reason_codes],
					}
				: composed;
		if (route.route === "wait_for_worker") {
			this.routeWaitAttempts.set(route, completionFence.length > 0 ? completionFence : activeAttempts);
		}
		// The route checkpoint's trace ends at the route the policy composed from its judgments and the facts.
		if (routeCertificateId !== undefined)
			this.deps.steeringPlane?.noteDecision(
				routeCertificateId,
				`route ${route.route}`,
				[
					{ id: "work_class", result: String(semantic.missingWorkClass ?? "unjudged"), decided: false },
					{ id: "route_policy", result: route.route, decided: true },
					...(completionFence.length > 0
						? [{ id: "completion_fence", result: `${completionFence.length} running`, decided: true }]
						: []),
				],
				route.reason_codes,
			);
		let adoptedSupervisionSignalId: string | undefined;
		if (supervisionAction && pendingSupervision) {
			const adopted =
				(supervisionAction === "request_specialist" &&
					route.route === "escalate_capability" &&
					route.reason_codes.includes("specialist_gap_detected")) ||
				(supervisionAction === "request_capability" &&
					route.route === "escalate_capability" &&
					route.reason_codes.includes("capability_gap_detected")) ||
				(supervisionAction === "request_verifier" &&
					route.route === "verify" &&
					route.reason_codes.includes(INDEPENDENT_VERIFICATION_REASON_CODE)) ||
				(supervisionAction === "mark_external_block" &&
					route.route === "blocked_external" &&
					route.reason_codes.includes("external_dependency_unavailable"));
			if (adopted) adoptedSupervisionSignalId = pendingSupervision.signal_id;
		}
		const adoptedDirective =
			adoptedSupervisionSignalId === undefined &&
			pendingDirective !== undefined &&
			route.route === pendingDirective.objectiveRoute &&
			pendingDirective.reasonCodes.every((reasonCode) => route.reason_codes.includes(reasonCode))
				? pendingDirective
				: undefined;

		validateObjectiveRoute(route);
		await this.deps.checkpoints?.recordRoute?.(route);
		if (adoptedSupervisionSignalId) {
			this.routeAcknowledgments.set(route, { kind: "supervision", signalId: adoptedSupervisionSignalId });
		} else if (adoptedDirective) {
			this.routeAcknowledgments.set(route, { kind: "system_one", directive: adoptedDirective });
		}

		// Record disagreement telemetry in shadow mode
		if (options?.legacyActionHint && this.deps.onDisagreementTelemetry) {
			if (options.legacyActionHint !== route.route) {
				this.deps.onDisagreementTelemetry({
					cycleId,
					objectiveId,
					legacyAction: options.legacyActionHint,
					objectiveRoute: route.route,
					reasonCodes: route.reason_codes,
				});
			}
		}

		return route;
	}

	private async buildBundle(
		objectiveId: string,
		terminalStatus: DeliveryTerminalStatus,
		runtime: TaskRuntimeProjection,
		extra?: { decisionRefs?: readonly string[]; reasonCodes?: readonly string[] },
	): Promise<DeliveryBundle> {
		const sourceRevision = (await this.deps.runtime.getSourceRevision?.(objectiveId)) ?? "HEAD";
		const artifacts = (await this.deps.runtime.getArtifacts?.(objectiveId)) ?? [];
		const limitations = (await this.deps.runtime.getLimitations?.(objectiveId)) ?? [];
		const objective = runtime.objectives[objectiveId];

		return buildDeliveryBundle({
			objectiveId,
			terminalStatus,
			sourceRevision,
			acceptance: { evidence: objective?.evidence ?? [] },
			verification: [],
			artifacts,
			limitations,
			decisionRefs: extra?.decisionRefs,
			failedGates: extra?.reasonCodes,
		});
	}

	private async refuseDelivery(
		objectiveId: string,
		runtime: TaskRuntimeProjection,
		error: string,
		effect: "commit" | "publish" = "commit",
	): Promise<ObjectiveTerminalResult> {
		const base = await this.buildBundle(objectiveId, "unrecoverable", runtime, { reasonCodes: [error] });
		const failed = { state: "failed" as const, error };
		return {
			status: "unrecoverable",
			reasonCodes: [error],
			cycleCount: this.cycleCounter,
			deliveryBundle: buildDeliveryBundle({
				objectiveId,
				terminalStatus: "unrecoverable",
				sourceRevision: base.source_revision,
				acceptance: base.acceptance,
				verification: base.verification,
				artifacts: base.artifacts,
				limitations: base.limitations,
				failedGates: [error],
				sideEffects: effect === "publish" ? { publish: failed } : { commit: failed },
			}),
		};
	}

	private async rejectedCompletion(
		signal: AbortSignal | undefined,
		objectiveId: string,
		runtime: TaskRuntimeProjection,
		reasonCodes: string[],
		/** The reasons that are requests for the model's account: answered with an account, never held as findings. */
		accountRequests: readonly string[] = [],
	): Promise<ObjectiveTerminalResult> {
		this.assertExecutionCurrent(objectiveId, signal);
		const findings = reasonCodes.filter((reason) => !accountRequests.includes(reason));
		if (findings.length > 0) this.deps.systemOne?.noteControlDirective?.(sameLaneVerificationDirective(findings));
		else if (accountRequests.length > 0)
			this.deps.systemOne?.noteControlDirective?.(accountRequestDirective(accountRequests));
		return {
			status: "incomplete",
			reasonCodes,
			cycleCount: this.cycleCounter,
			deliveryBundle: await this.buildBundle(objectiveId, "incomplete", runtime, { reasonCodes }),
		};
	}

	/** A transition System One could not settle: the objective is not closed, and says why. */
	private async heldCompletion(
		goalCompletionKey: string | undefined,
		objectiveId: string,
		runtime: TaskRuntimeProjection,
		reasonCodes: readonly string[],
	): Promise<ObjectiveTerminalResult> {
		return {
			status: "semantic_gate_unavailable",
			goalCompletionKey,
			reasonCodes: [...reasonCodes],
			cycleCount: this.cycleCounter,
			deliveryBundle: await this.buildBundle(objectiveId, "semantic_gate_unavailable", runtime, {
				reasonCodes: [...reasonCodes],
			}),
		};
	}

	async run(objectiveId: string, signal?: AbortSignal): Promise<ObjectiveTerminalResult> {
		const terminal = await this.runLoop(objectiveId, signal);
		if (!terminal) throw new Error("Objective run loop ended without a terminal result.");
		return terminal;
	}

	/**
	 * At most `maxCycles` route cycles; `undefined` when the budget ran out before a terminal. The
	 * session's continuation loop drives the objective one cycle at a time so its own turn, wall
	 * clock and stall limits keep applying between cycles.
	 */
	async runCycles(
		objectiveId: string,
		maxCycles: number,
		signal?: AbortSignal,
	): Promise<ObjectiveTerminalResult | undefined> {
		return this.runLoop(objectiveId, signal, maxCycles);
	}

	private async runLoop(
		objectiveId: string,
		signal?: AbortSignal,
		maxCycles?: number,
	): Promise<ObjectiveTerminalResult | undefined> {
		signal = objectiveExecutionSignal(this.deps, objectiveId, signal);
		let cycles = 0;
		while (true) {
			if (maxCycles !== undefined && cycles++ >= maxCycles) return undefined;
			signal?.throwIfAborted();

			const runtime = await this.deps.runtime.reconcileObjective(objectiveId);
			this.assertExecutionCurrent(objectiveId, signal);

			// 1. Check deterministic terminals
			if (
				this.deps.runtime.isCancelled?.(objectiveId) ||
				runtime.objectives[objectiveId]?.objective.status === "cancelled"
			) {
				const bundle = await this.buildBundle(objectiveId, "cancelled", runtime);
				return {
					status: "cancelled",
					reasonCodes: ["deterministic_cancellation"],
					cycleCount: this.cycleCounter,
					deliveryBundle: bundle,
				};
			}
			if (this.deps.runtime.isBudgetExhausted?.(objectiveId)) {
				const bundle = await this.buildBundle(objectiveId, "budget_exhausted", runtime);
				return {
					status: "budget_exhausted",
					reasonCodes: ["budget_exhausted"],
					cycleCount: this.cycleCounter,
					deliveryBundle: bundle,
				};
			}

			// PH-110..PH-112: Objective admission certificates
			const lifetime = this.deps.executionSignal?.(objectiveId, true);
			if (
				this.deps.steeringPlane &&
				(!this.admittedObjectives.has(objectiveId) || this.admittedObjectives.get(objectiveId) !== lifetime)
			) {
				// One admission state for all three checkpoints: the objective as the runtime holds it.
				const objective = runtime.objectives[objectiveId]?.objective;
				const admissionState = {
					objectiveId,
					title: objective?.title ?? objectiveId,
					request: objective?.description ?? objectiveId,
					constraints: objective?.constraints ?? [],
					acceptanceCriteria: objective?.acceptanceCriteria ?? [],
				};
				// Admission steers reversible work: an outage or an unsettled answer does not end the objective.
				// The route's own evidence gathering answers what admission could not; a decisive failure
				// (an incoherent objective) still stops here.
				// The three are independent judgments of one state: one System One request asks them all,
				// and each still settles as its own certificate.
				const settled = await this.deps.steeringPlane.requireCertificates(
					["JEV-001", "JEV-002", "JEV-003"],
					admissionState,
					{ objectiveId, signal },
				);
				const admitted: string[] = [];
				for (const outcome of settled) {
					if (outcome.status === "fulfilled") admitted.push(outcome.value.certificate_id);
					else if (!isReversibleDoubtOrOutage(outcome.reason)) throw outcome.reason;
				}
				this.assertExecutionCurrent(objectiveId, signal);
				this.admittedObjectives.set(objectiveId, lifetime);
				this.admissionCerts.set(objectiveId, admitted);
			}
			this.assertExecutionCurrent(objectiveId, signal);

			// 2. Join this objective's in-flight workers and any running work that may mutate its repository.
			// The join is a decided route: composed, checkpointed and current before the loop waits on it.
			const activeAttempts = objectiveJoinAttempts(runtime, objectiveId, this.deps.repoRoot);
			if (activeAttempts.length > 0) {
				if (this.deps.waiter) {
					const waitRoute = composeObjectiveRoute({
						cycleId: this.nextCycleId(),
						objectiveId,
						requiredWorkerInFlight: true,
					});
					await this.deps.checkpoints?.recordRoute?.(waitRoute);
					this._lastRoute = waitRoute;
					const waiter = this.deps.waiter;
					await runAdmittedRoute(
						() => waiter.wait({ inFlightAttempts: activeAttempts }, signal),
						() => this._noteExecutor(waitRoute, runtime, waitRoute.route),
					);
					continue;
				}
			}

			if (objectiveNeedsCorrectedOutcome(runtime.objectives[objectiveId])) {
				await this.deps.reviewCorrectedOutcome?.(objectiveId, signal);
				this.assertExecutionCurrent(objectiveId, signal);
			}
			// 3. Evaluate route
			const route = await this.evaluateRouteOnce(objectiveId, { signal });
			this.assertExecutionCurrent(objectiveId, signal);
			this._lastRoute = route;
			const verificationRecovery = route.reason_codes.includes(SAME_LANE_VERIFICATION_RECOVERY_REASON_CODE);
			const recoveryFingerprint = verificationRecovery
				? this.verificationRecoveryFingerprint(objectiveId, await this.deps.runtime.reconcileObjective(objectiveId))
				: undefined;
			if (recoveryFingerprint && this.completedVerificationRecoveries.get(objectiveId) === recoveryFingerprint) {
				// The model cannot clear this: the owner can, with /verification (list, or waive with a reason).
				const reasonCodes = [
					"same_lane_verification_recovery_exhausted",
					"owner_exit:/verification",
					...route.reason_codes,
				];
				return {
					status: "blocked",
					reasonCodes,
					cycleCount: this.cycleCounter,
					deliveryBundle: await this.buildBundle(objectiveId, "incomplete", runtime, { reasonCodes }),
				};
			}

			// 4. Authority Envelope / Execution Charter gate (FIN-070..FIN-074, ZH-001..ZH-012)
			const proposedAction = this.deps.getRouteProposedAction
				? this.deps.getRouteProposedAction(route)
				: { kind: route.route };

			const charter = this.deps.executionCharter;
			if (this.getMode() === "start_only" && !charter) {
				throw new Error("ExecutionCharter is required in start_only mode; compile once at admission (PH-102)");
			}
			const isStartOnly = charter?.interaction_mode === "start_only" || this.getMode() === "start_only";

			if (isStartOnly && charter) {
				const charterDecision = evaluateCharterAuthority(charter, proposedAction);
				if (charterDecision.outcome === "deny") {
					this.authorityBlockLedger.recordBlock({
						objectiveId,
						action: proposedAction.kind,
						missingAuthority: charterDecision.missingAuthority,
						alternativesAttempted: ["evaluate_in_scope_alternative", "replan"],
					});

					// PH-105: Steering evaluates in-scope alternative before terminal block
					let alternativeFound = false;
					if (this.deps.steeringPlane) {
						try {
							const altCert = await this.deps.steeringPlane.requireCertificate(
								"JEV-006",
								{
									objectiveId,
									deniedAction: proposedAction.kind,
									...(charterDecision.missingAuthority !== undefined
										? { missingAuthority: charterDecision.missingAuthority }
										: {}),
									action: "replan_alternative",
								},
								{ objectiveId, signal },
							);
							if (altCert.directive === "proceed" || altCert.certificate_id) {
								alternativeFound = true;
							}
						} catch {
							// No alternative available
						}
					}

					const altKey = `${objectiveId}:${proposedAction.kind}`;
					if (alternativeFound && !this.alternativesTried.has(altKey)) {
						this.alternativesTried.add(altKey);
						continue;
					}

					const bundle = await this.buildBundle(objectiveId, "blocked_by_initial_authority", runtime, {
						reasonCodes: ["blocked_by_initial_authority", charterDecision.missingAuthority],
					});
					return {
						status: "unrecoverable",
						reasonCodes: ["blocked_by_initial_authority", charterDecision.missingAuthority],
						cycleCount: this.cycleCounter,
						deliveryBundle: bundle,
					};
				}
			} else if (this.deps.authorityEnvelope && !isStartOnly) {
				const edge = requiresHumanEdge(
					objectiveId,
					proposedAction,
					this.deps.authorityEnvelope,
					false,
					this.humanEdgeLedger,
				);
				if (edge) {
					if (this.deps.onHumanEdgeRequest) {
						const approved = await this.deps.onHumanEdgeRequest(edge);
						if (!approved) {
							// FIN-071: Record denial
							this.humanEdgeLedger.recordDecision({
								id: `dec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
								request_id: edge.id,
								decision: "deny",
								exact_scope: edge.exact_authority ?? proposedAction.kind,
								scope_type: "one_shot",
								timestamp: Date.now(),
							});
							const bundle = await this.buildBundle(objectiveId, "owner_required", runtime);
							this.ownerBlockerSink?.(
								`${edge.edge_type} denied: ${edge.exact_authority ?? proposedAction.kind}`,
							);
							return {
								status: "blocked",
								reasonCodes: ["human_edge_denied", edge.edge_type],
								cycleCount: this.cycleCounter,
								deliveryBundle: bundle,
							};
						}
						// FIN-071: Record grant
						this.humanEdgeLedger.recordDecision({
							id: `dec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
							request_id: edge.id,
							decision: "grant",
							exact_scope: edge.exact_authority ?? proposedAction.kind,
							scope_type: "durable",
							timestamp: Date.now(),
						});
					} else {
						const bundle = await this.buildBundle(objectiveId, "owner_required", runtime);
						this.ownerBlockerSink?.(
							`${edge.edge_type} needs you: ${edge.exact_authority ?? proposedAction.kind}`,
						);
						return {
							status: "blocked",
							reasonCodes: ["human_edge_required", edge.edge_type],
							cycleCount: this.cycleCounter,
							deliveryBundle: bundle,
						};
					}
				}
			}

			// 5. Dispatch based on route (FIN-051, FIN-052: Explicit failure if executor is missing)
			this.assertExecutionCurrent(objectiveId, signal);
			switch (route.route) {
				case "retrieve":
					if (!this.deps.retrieval?.execute && this.deps.rootExecutor) {
						// No dedicated retrieval executor: the root reads, with the route's brief.
						await executeWithRouteAdmission(this.deps.rootExecutor, route, signal, () =>
							this._noteExecutor(route, runtime, "root"),
						);
						break;
					}
					if (!this.deps.retrieval?.execute) {
						const bundle = await this.buildBundle(objectiveId, "unrecoverable", runtime);
						return {
							status: "unrecoverable",
							reasonCodes: ["missing_required_executor:retrieval"],
							cycleCount: this.cycleCounter,
							deliveryBundle: bundle,
						};
					}
					await executeObjectiveRetrieval(this.deps.retrieval, route, signal, (executor) =>
						this._noteExecutor(route, runtime, executor),
					);
					break;

				case "deterministic_test":
					if (isSameLaneVerificationDirective({ objectiveRoute: route.route, reasonCodes: route.reason_codes })) {
						if (!this.deps.rootExecutor)
							throw new Error("Same-lane verification requires the receiving root executor.");
						await executeWithRouteAdmission(this.deps.rootExecutor, route, signal, () =>
							this._noteExecutor(route, runtime, "root"),
						);
						break;
					}
					if (!this.deps.verifier?.execute && this.deps.rootExecutor) {
						// No dedicated verifier: the root runs the checks, with the route's brief.
						await executeWithRouteAdmission(this.deps.rootExecutor, route, signal, () =>
							this._noteExecutor(route, runtime, "root"),
						);
						break;
					}
					if (!this.deps.verifier?.execute) {
						const bundle = await this.buildBundle(objectiveId, "unrecoverable", runtime);
						return {
							status: "unrecoverable",
							reasonCodes: ["missing_required_executor:verifier"],
							cycleCount: this.cycleCounter,
							deliveryBundle: bundle,
						};
					}
					try {
						await executeWithRouteAdmission(this.deps.verifier, route, signal, () =>
							this._noteExecutor(route, runtime, route.route),
						);
					} catch (err) {
						const lastAttempt = Array.from(this.attemptBindings.entries()).pop();
						if (this.deps.outcomeRecorder && lastAttempt) {
							const [taskId, { binding, route: attemptRoute }] = lastAttempt;
							await this.deps.outcomeRecorder.record({
								binding,
								request: buildWorkerCapabilityRequest({
									objectiveId,
									taskId,
									route: attemptRoute,
									consequence: "high",
								}),
								verificationPassed: false,
							});
						}
						throw err;
					}
					break;

				case "investigate":
				case "implement":
				case "verify":
				case "review":
				case "replan": {
					const failure = await this._dispatchWithExpertSelection(objectiveId, route, runtime, false, signal);
					if (failure) return failure;

					this.acknowledgeRouteRequests(route);
					break;
				}

				case "continue_current_worker":
					if (!this.deps.workerDispatcher?.continueWorker) {
						const bundle = await this.buildBundle(objectiveId, "unrecoverable", runtime);
						return {
							status: "unrecoverable",
							reasonCodes: ["missing_required_executor:workerDispatcher.continueWorker"],
							cycleCount: this.cycleCounter,
							deliveryBundle: bundle,
						};
					}
					{
						const dispatcher = this.deps.workerDispatcher;
						const admission = await executeObjectiveWorker(
							(admit) => dispatcher.continueWorker(route, signal, this._lastBinding, admit),
							() => this._noteExecutor(route, runtime, "worker"),
						);
						if (admission?.started === false) {
							if (!admission.pending) {
								const reasons = ["worker_admission_refused", admission.reason];
								return (
									this.deps.runtime.recordExecutorRefusal?.(objectiveId, route, reasons) ?? {
										status: "blocked",
										reasonCodes: reasons,
										cycleCount: this.cycleCounter,
										deliveryBundle: await this.buildBundle(objectiveId, "incomplete", runtime, {
											reasonCodes: reasons,
										}),
									}
								);
							}
							await this._noteExecutor(route, runtime, PENDING_WORKER_EXECUTOR);
						}
					}
					this.assertExecutionCurrent(objectiveId, signal);
					this.acknowledgeRouteRequests(route);
					break;

				case "escalate_capability": {
					if (this.deps.adaptiveResolution) {
						const resolution = await this.deps.adaptiveResolution.resolve({
							objectiveId,
							taskId: `${objectiveId}-adapt-${this.cycleCounter}`,
							currentExpert: this._lastBinding?.model_id,
							signal,
						});
						this.assertExecutionCurrent(objectiveId, signal);

						if (resolution.dimension === "specialist" && this.deps.specialistSynthesis) {
							const need = resolution.specialistNeed ?? {
								specialty: "code_architecture_specialist",
								purpose: `Fulfill specialist need for ${objectiveId} (${resolution.action || "targeted expert synthesis"})`,
							};
							const specialist = await this.deps.specialistSynthesis.resolveOrCreate({
								objectiveId,
								taskId: `${objectiveId}-spec-${this.cycleCounter}`,
								need,
								charter,
								signal,
							});
							this.assertExecutionCurrent(objectiveId, signal);

							const specTaskId = `${objectiveId}-spec-${this.cycleCounter}`;
							await this.runSpecialistWorkerExecution(
								runtime,
								specialist,
								specTaskId,
								objectiveId,
								route,
								signal,
								this.cycleCounter,
							);

							break;
						}

						if (resolution.dimension === "capability" && this.deps.adaptiveCapabilities) {
							// FC-025, FC-026: Real dynamic CapabilityNeed from resolution (never adaptation node id)
							const need = resolution.capabilityNeed ?? {
								requiredOutcome: `Capability escalation for ${objectiveId}: ${resolution.action || "tool extension"}`,
							};
							await this.deps.adaptiveCapabilities.resolveOrBuild({
								objectiveId,
								taskId: `${objectiveId}-cap-${this.cycleCounter}`,
								need,
								charter,
								signal,
							});
							break;
						}
					}
					const failure = await this._dispatchWithExpertSelection(objectiveId, route, runtime, true, signal);
					if (failure) return failure;
					this.acknowledgeRouteRequests(route);
					break;
				}

				case "completion_candidate": {
					await this.deps.waitForRepositoryQuiescence?.(objectiveId, signal);
					this.assertExecutionCurrent(objectiveId, signal);
					// A checked requirement is proven by rerunning its check, before any judgment. A failed
					// check is repair work for the loop, never a terminal state.
					const checkProof = await this.deps.proveRequirementChecks?.(signal, objectiveId);
					this.assertExecutionCurrent(objectiveId, signal);
					const checkRefusal = checkProof ? describeRequirementCheckRefusal(checkProof) : undefined;
					if (checkProof && checkRefusal) {
						const failedChecks = checkProof.unrunnable
							? [{ gate_id: "requirement_check", reason: checkRefusal }]
							: checkProof.failures.map((failure) => ({
									gate_id: "requirement_check",
									reason: `${failure.requirementId} (${failure.text}): ${failure.reason}`,
									required_next_proof:
										"Fix the outcome so the check passes; the harness reruns it at completion.",
								}));
						await this._recordCompletionOutcomes(objectiveId, route, {
							completionChallengeRejected: true,
							repairRoundsCaused: failedChecks.length,
						});
						if (this.deps.runtime.ensureRepairTasks) {
							await this.deps.runtime.ensureRepairTasks(
								objectiveId,
								completionFailuresToRepairWork(failedChecks, objectiveId),
							);
						}
						break;
					}
					const admission = this.deps.prepareGoalCompletion?.(objectiveId);
					if (admission?.refusal)
						return { status: "incomplete", reasonCodes: [admission.refusal], cycleCount: this.cycleCounter };
					// Check reruns can replace the previous proof. Review the synchronized receipts that just ran.
					const runtime = await this.deps.runtime.reconcileObjective(objectiveId);
					this.assertExecutionCurrent(objectiveId, signal);
					// FIN-060: Single completion owner via CompletionCoordinator
					const profile = resolveEffectiveCompletionProfile({
						requestedProfile: this.deps.completionProfile,
						steeringMode: this.deps.steeringPlane?.policy.mode,
						systemOneBound: Boolean(this.deps.systemOne || this.deps.steeringPlane),
					});
					const holdOnUnsettled = profile === "system_one_required";
					const steeringCertRefs: string[] = [];
					const completionAdvice: string[] = [];
					const recordCompletionAdvice = (advice: string): void => {
						completionAdvice.push(advice);
					};

					// FC-070, FC-071, FC-072: Canonical proof state on real projection without asserted verificationPassed:true
					const objRecord = runtime.objectives[objectiveId];
					const bugFix = requestsBugFix(objectiveId, objRecord?.objective?.description);
					const { evidenceRevision, artifacts, verificationMatrix } = await this._resolveCanonicalEvidenceState(
						objectiveId,
						runtime,
					);
					const sourceRevision =
						(await this.deps.runtime.getSourceRevision?.(objectiveId)) ?? String(evidenceRevision);
					const limitations = (await this.deps.runtime.getLimitations?.(objectiveId)) ?? [];
					const acceptanceEvidence = objRecord?.evidence ?? [];
					const candidateSnapshot = await captureOptionalSnapshot(this.deps.repoRoot);
					const diffDigest = candidateSnapshot?.digest ?? "unknown";
					const snapshotIdentity = candidateSnapshot ? candidateSnapshotIdentity(candidateSnapshot) : undefined;
					const charterForFreeze = this.deps.executionCharter;
					let frozenGit: ApprovedCandidateTree | undefined;
					const frozenPaths = this.deps.attributedMutationPaths?.() ?? [];
					const frozenDigests = this.deps.ownedPathDigests?.() ?? [];
					if (charterForFreeze?.git.commit) {
						const ownershipBlock = this.deps.deliveryBlockReason?.();
						if (ownershipBlock) return this.refuseDelivery(objectiveId, runtime, ownershipBlock);
						const git = this.deps.gitExecutor;
						if (git?.certifyOwnedCandidate) {
							try {
								frozenGit = await git.certifyOwnedCandidate(frozenPaths, signal);
							} catch (error) {
								const message = error instanceof Error ? error.message : String(error);
								return this.refuseDelivery(objectiveId, runtime, message);
							}
							if (candidateSnapshot && frozenGit.parent !== candidateSnapshot.candidateRevision) {
								// The snapshot and the certified parent are not one candidate yet.
								continue;
							}
						} else if (git?.inspectCandidate) {
							try {
								frozenGit = await git.inspectCandidate();
							} catch (error) {
								const message = error instanceof Error ? error.message : String(error);
								return this.refuseDelivery(objectiveId, runtime, message);
							}
						}
					}
					const worktreeClean = candidateSnapshot
						? candidateSnapshot.trackedDiffBytes.length === 0 && candidateSnapshot.untracked.length === 0
						: undefined;

					const correction = objRecord?.goalSource?.lastCorrection;
					const correctionScope = correction ? { ownerCorrection: correction } : {};
					const canonicalProofState = {
						...correctionScope,
						objectiveId,
						cycleCount: this.cycleCounter,
						evidenceRevision,
						sourceRevision: candidateSnapshot?.candidateRevision ?? sourceRevision,
						verificationMatrix,
						acceptanceEvidence,
						acceptanceCriteria: objRecord?.objective?.acceptanceCriteria ?? [],
						evidenceRefs: objRecord?.evidence?.map((e) => e.evidenceId) ?? [],
						diffDigest,
						artifacts,
						limitations,
						// System One evidence is JSON: an absent snapshot or delivery candidate is omitted,
						// never sent as `undefined` (the transport refuses it and JEV-024 could never run).
						...(snapshotIdentity ? { candidateSnapshot: snapshotIdentity } : {}),
						...(frozenGit
							? {
									deliveryCandidate: {
										approvedParent: frozenGit.parent,
										approvedTreeOid: frozenGit.tree,
										treeDigest: candidateTreeDigest(frozenGit.tree),
										ownedPaths: frozenPaths,
										ownedDigests: frozenDigests,
									},
								}
							: {}),
					};

					// 1. PH-150, FC-062: JEV-024 completion plausibility on canonical proof state BEFORE finalization gates
					if (this.deps.steeringPlane) {
						const j24 = await judgeTransition(this.deps.steeringPlane, "JEV-024", canonicalProofState, {
							objectiveId,
							evidenceRevision,
							signal,
							holdOnUnsettled,
							onAdvisory: recordCompletionAdvice,
						});
						if (j24.certificate) steeringCertRefs.push(j24.certificate.certificate_id);
						if (j24.kind === "held")
							return this.heldCompletion(admission?.key, objectiveId, runtime, j24.reasonCodes);
						if (
							j24.kind === "judged" &&
							(j24.certificate.semantic_outcome !== "pass" ||
								j24.certificate.directive !== "completion_candidate")
						) {
							return this.rejectedCompletion(signal, objectiveId, runtime, [
								"completion_not_plausible",
								...(j24.certificate.failed_semantic_predicates ?? []),
							]);
						}
					}

					// RCG-043: completion project rules. A blocking violation queues repair work and
					// refuses the completion candidate; it never finalizes on a violated rule.
					const ruleAuthority = this.deps.ruleAuthority?.() ?? "unset";
					if (this.deps.projectRules && ruleAuthority !== "user") {
						const completionRules = await this.deps.projectRules.validateCompletion(
							{
								objectiveId,
								changedFiles: artifacts.map((artifact) => artifact.path),
								boundedDiffEvidence: canonicalProofState,
								signal,
							},
							{ record: ruleAuthority !== "ask" },
						);
						this.assertExecutionCurrent(objectiveId, signal);
						if (blocksRuleTransition(completionRules)) {
							if (completionRules.verificationRequired) {
								return this.rejectedCompletion(
									signal,
									objectiveId,
									runtime,
									completionRules.violations.map((finding) => finding.explanation),
								);
							}
							if (ruleAuthority !== "ask" && this.deps.runtime.ensureRepairTasks) {
								await this.deps.runtime.ensureRepairTasks(
									objectiveId,
									completionFailuresToRepairWork(
										completionRules.violations.map((violation) => ({
											gate_id: `project_rule:${violation.explanation}`,
										})),
										objectiveId,
									),
								);
							}
							break;
						}
					}

					// 2. PH-151: CompletionCoordinator mechanical/common gates
					let completionFinding: FinalCompletionVerdict | undefined;
					const completionContext: CompletionEvaluationContext = {
						runtime,
						getExecutionState: this.deps.systemOne?.snapshot ? () => this.deps.systemOne!.snapshot!() : undefined,
						getSourceRevision: this.deps.runtime.getSourceRevision?.bind(this.deps.runtime),
						getArtifacts: this.deps.runtime.getArtifacts?.bind(this.deps.runtime),
						getLimitations: this.deps.runtime.getLimitations?.bind(this.deps.runtime),
						repoRoot: this.deps.repoRoot,
						candidateSnapshot,
						reviewer: this.deps.reviewer,
						semanticEvaluator: this.deps.systemOne?.executeCompletionTransaction
							? {
									evaluateCompletion: async (_objId, opts) => {
										this.assertExecutionCurrent(objectiveId, signal);
										const verdict = await this.deps.systemOne!.executeCompletionTransaction!(bugFix, {
											...opts,
											persistTerminal: false,
										});
										this.assertExecutionCurrent(objectiveId, signal);
										completionAdvice.push(...(verdict.advisories ?? []).map((advice) => advice.reason));
										completionFinding = verdict;
										return {
											passed: verdict.verdict === "complete",
											decisionRef: (verdict as { decision_id?: string }).decision_id,
											failedGates: (verdict.failed_gates ?? []).map((g) => g.id),
										};
									},
								}
							: undefined,
						hasCalibratedEngine: () =>
							Boolean(this.deps.systemOne?.executeCompletionTransaction) &&
							this.deps.systemOne?.adapter?.provenance === "native_calibrated",
					};

					const evalResult = await CompletionCoordinator.evaluate(objectiveId, profile, completionContext, {
						signal,
					});
					this.assertExecutionCurrent(objectiveId, signal);
					this.acknowledgeRouteRequests(route);
					if (
						completionFinding?.verdict === "blocked_external" &&
						completionFinding.diagnostic === "evaluator_unavailable"
					) {
						return this.heldCompletion(
							admission?.key,
							objectiveId,
							runtime,
							completionFinding.failed_gates.map((finding) => `${finding.id}: ${finding.reason}`),
						);
					}
					if (completionFinding?.verdict === "verify_more") {
						const describe = (finding: { id: string; reason: string; required_next_proof: string }) =>
							`${finding.id}: ${finding.reason}. ${finding.required_next_proof}`;
						return this.rejectedCompletion(
							signal,
							objectiveId,
							runtime,
							completionFinding.failed_gates.map(describe),
							completionFinding.failed_gates
								.filter((finding) => finding.id.startsWith("account_"))
								.map(describe),
						);
					}

					if (evalResult.verdict === "complete") {
						// A completion transaction that returned a verdict already asked the completion and challenge
						// packs on the completion view, and evalResult carries it. JEV-025/JEV-026 ask those packs only
						// when no transaction verdict exists: a mechanical or reviewer profile, an evaluator exception
						// the coordinator fell back from, or a steering plane without a completion transaction.
						const completion =
							completionFinding === undefined ? await this.deps.systemOne?.completionView?.(signal) : undefined;
						const completionEvidence = completion
							? { ...completion.view, repository_outcome: completion.repositoryOutcome }
							: {};
						if (completionFinding === undefined && this.deps.steeringPlane) {
							// 3. PH-152, FC-063: JEV-025 primary semantic completion (proof-bearing)
							const j25 = await judgeTransition(
								this.deps.steeringPlane,
								"JEV-025",
								{
									...canonicalProofState,
									...completionEvidence,
									mechanicalVerdict: evalResult.verdict,
									evalResultDetails: evalResult,
									bugFix,
								},
								{ objectiveId, evidenceRevision, signal, holdOnUnsettled, onAdvisory: recordCompletionAdvice },
							);
							if (j25.certificate) steeringCertRefs.push(j25.certificate.certificate_id);
							if (j25.kind === "held")
								return this.heldCompletion(admission?.key, objectiveId, runtime, j25.reasonCodes);

							if (j25.kind === "judged" && j25.certificate.semantic_outcome !== "pass") {
								return this.rejectedCompletion(signal, objectiveId, runtime, [
									"primary_completion_failed",
									...(j25.certificate.failed_semantic_predicates ?? []),
								]);
							}

							// 4. PH-153, FC-064, FC-073: JEV-026 cold adversarial challenge (cold proof-bearing)
							const coldProofState = {
								...correctionScope,
								objectiveId,
								acceptanceCriteria: canonicalProofState.acceptanceCriteria,
								evidenceRefs: canonicalProofState.evidenceRefs,
								coldChallenge: true,
								verificationMatrix,
								diffDigest,
								...completionEvidence,
							};
							const j26 = await judgeTransition(this.deps.steeringPlane, "JEV-026", coldProofState, {
								objectiveId,
								evidenceRevision,
								signal,
								holdOnUnsettled,
								onAdvisory: recordCompletionAdvice,
							});
							if (j26.certificate) steeringCertRefs.push(j26.certificate.certificate_id);
							if (j26.kind === "held")
								return this.heldCompletion(admission?.key, objectiveId, runtime, j26.reasonCodes);
							// The challenge pack's own failures (a missing requirement among them) are the certificate's
							// failed predicates; its outcome is the whole verdict.
							if (j26.kind === "judged" && j26.certificate.semantic_outcome !== "pass") {
								return this.rejectedCompletion(signal, objectiveId, runtime, [
									"adversarial_completion_failed",
									...(j26.certificate.failed_semantic_predicates ?? []),
								]);
							}
						}

						// 5. PH-154, FC-042: jscpd + JEV-044 final semantic-dedup sweep
						if (this.deps.responsibilityController) {
							try {
								await this.deps.responsibilityController.completionSweep({ objectiveId, signal });
							} catch (err: unknown) {
								const failureReason = err instanceof Error ? err.message : "semantic_duplicate_remaining";
								const bundle = await this.buildBundle(objectiveId, "unrecoverable", runtime, {
									reasonCodes: ["semantic_duplicate_remaining", failureReason],
								});
								return {
									status: "unrecoverable",
									reasonCodes: ["semantic_duplicate_remaining"],
									cycleCount: this.cycleCounter,
									deliveryBundle: bundle,
								};
							}
						}

						// 6. Release artifact/mechanical gates

						// 7. PH-155, FC-065: JEV-027 delivery-claim truth
						// 7. JEV-027 moved to after side effects

						// 8. PH-156, PH-157, FC-066: JEV-028 gates publish AND/OR deploy
						const activeCharter = this.deps.executionCharter;
						let packageArtifact:
							| { packageName: string; version: string; registry?: string; integrity: string }
							| undefined;
						if (activeCharter?.release.package_publish && this.deps.releaseExecutor?.preparePublish) {
							try {
								const prepared = await this.deps.releaseExecutor.preparePublish();
								packageArtifact = {
									packageName: prepared.packageName,
									version: prepared.version,
									...(prepared.registry !== undefined ? { registry: prepared.registry } : {}),
									integrity: prepared.integrity,
								};
							} catch (error) {
								const message = error instanceof Error ? error.message : String(error);
								return this.refuseDelivery(objectiveId, runtime, message, "publish");
							}
						}
						if (activeCharter) {
							const needsPublishOrDeploy =
								activeCharter.release.package_publish || activeCharter.release.deploy_targets.length > 0;
							if (needsPublishOrDeploy && this.deps.steeringPlane) {
								const j28 = await judgeTransition(
									this.deps.steeringPlane,
									"JEV-028",
									{
										objectiveId,
										...correctionScope,
										publishRequested: Boolean(activeCharter.release.package_publish),
										deployTargets: activeCharter.release.deploy_targets,
										releaseRules: activeCharter.release,
										...(packageArtifact !== undefined ? { packageArtifact } : {}),
									},
									{
										objectiveId,
										evidenceRevision,
										signal,
										holdOnUnsettled,
										onAdvisory: recordCompletionAdvice,
									},
								);
								if (j28.certificate) steeringCertRefs.push(j28.certificate.certificate_id);
								if (j28.kind === "held")
									return this.heldCompletion(admission?.key, objectiveId, runtime, j28.reasonCodes);

								// deploy_safe is one of the outcome's predicates: a pass already means it held.
								if (j28.kind === "judged" && j28.certificate.semantic_outcome !== "pass") {
									return this.rejectedCompletion(signal, objectiveId, runtime, [
										"release_readiness_rejected",
										...(j28.certificate.failed_semantic_predicates ?? []),
									]);
								}
							}
						}

						const deliveryCharter =
							activeCharter && this.deps.localCommitBranch?.() !== undefined
								? applyLocalCommitCharter(activeCharter)
								: activeCharter;
						const sideEffects = await executeDelivery({
							beforeEffect: () => {
								admission?.assertCurrent();
								this.assertExecutionCurrent(objectiveId, signal);
								assertVerificationResolved(this.deps.systemOne?.peekControlDirective?.());
							},
							charter: deliveryCharter,
							git: this.deps.gitExecutor,
							release: this.deps.releaseExecutor,
							signal,
							candidateUntrackedPaths: candidateSnapshot?.untracked.map((file) => file.path) ?? [],
							attributedPaths: frozenPaths,
							candidateRevision: candidateSnapshot?.candidateRevision,
							approvedTreeOid: frozenGit?.tree,
							approvedParent: frozenGit?.parent,
							worktreeClean,
							expectedArtifactDigest: packageArtifact?.integrity,
						});
						this.assertExecutionCurrent(objectiveId, signal);
						if (isSameLaneVerificationDirective(this.deps.systemOne?.peekControlDirective?.())) {
							const reasons = this.deps.systemOne?.peekControlDirective?.()?.reasonCodes ?? [];
							return {
								status: "incomplete",
								reasonCodes: [...reasons],
								cycleCount: this.cycleCounter,
								deliveryBundle: await this.buildBundle(objectiveId, "incomplete", runtime, {
									reasonCodes: reasons,
								}),
							};
						}
						const requiredReceiptFailed = deliveryReceiptFailed(sideEffects);

						const bundleBase =
							evalResult.deliveryBundle ?? (await this.buildBundle(objectiveId, "complete", runtime));
						const commitDetail = sideEffectSucceeded(sideEffects.commit) ? sideEffects.commit.detail : undefined;
						const pushDetail = sideEffectSucceeded(sideEffects.push) ? sideEffects.push.detail : undefined;
						const terminalStatus: DeliveryTerminalStatus = requiredReceiptFailed ? "unrecoverable" : "complete";
						const enrichedBundle = buildDeliveryBundle({
							objectiveId,
							terminalStatus,
							sourceRevision: candidateSnapshot?.candidateRevision ?? bundleBase.source_revision,
							diffDigest: candidateSnapshot?.digest ?? bundleBase.diff_digest,
							acceptance: bundleBase.acceptance,
							verification: bundleBase.verification,
							limitations: [...(bundleBase.limitations ?? []), ...completionAdvice],
							artifacts: [
								...(bundleBase.artifacts ?? []),
								...(commitDetail
									? [
											{
												path: "git:commit",
												description: `Commit ${commitDetail.sha}`,
												hash: commitDetail.sha,
											},
										]
									: []),
							],
							finalCommit: commitDetail?.sha,
							pushRefs: pushDetail ? [pushDetail.ref] : undefined,
							sideEffects,
							candidateSnapshot: snapshotIdentity,
							steeringCertificateRefs: steeringCertRefs.length > 0 ? steeringCertRefs : undefined,
							assuranceProfileRequested: bundleBase.assurance_profile_requested,
							assuranceProfileUsed: bundleBase.assurance_profile_used,
							decisionRefs: bundleBase.decision_refs,
							reviewerRefs: bundleBase.reviewer_refs,
						});

						if (requiredReceiptFailed) {
							if (deliveryCandidateIdentityLost(sideEffects)) continue;
							return {
								status: "unrecoverable",
								reasonCodes: ["delivery_side_effect_failed"],
								cycleCount: this.cycleCounter,
								deliveryBundle: enrichedBundle,
							};
						}

						const finished = await finalizeDelivery({
							...correctionScope,
							bundle: enrichedBundle,
							sideEffects,
							objectiveId,
							evidenceRevision,
							candidateDigest: candidateSnapshot?.digest ?? diffDigest,
							snapshotIdentity,
							steeringCertRefs,
							holdOnUnsettled,
							signal,
							steeringPlane: this.deps.steeringPlane,
							systemOne: this.deps.systemOne?.commitTerminalCompletion
								? {
										commitTerminalCompletion: (proof, options) => {
											admission?.assertCurrent();
											this.assertExecutionCurrent(objectiveId, signal);
											return this.deps.systemOne!.commitTerminalCompletion!(proof, {
												...options,
												assertCurrent: admission?.assertCurrent,
											});
										},
									}
								: undefined,
						});
						this.assertExecutionCurrent(objectiveId, signal);
						if (finished.status !== "complete") {
							if (finished.status === "incomplete")
								this.deps.systemOne?.noteControlDirective?.(
									sameLaneVerificationDirective(finished.reasonCodes),
								);
							return {
								status: finished.status,
								goalCompletionKey: admission?.key,
								reasonCodes: [...finished.reasonCodes],
								cycleCount: this.cycleCounter,
								deliveryBundle: finished.bundle,
							};
						}

						await this._recordCompletionOutcomes(objectiveId, route, { verificationPassed: true });
						return {
							status: "complete",
							goalCompletionKey: admission?.key,
							reasonCodes: [...finished.reasonCodes],
							completionDecisionId: evalResult.semanticRefs?.[0],
							cycleCount: this.cycleCounter,
							deliveryBundle: finished.bundle,
						};
					}

					if (evalResult.failedGates.length > 0) {
						await this._recordCompletionOutcomes(objectiveId, route, {
							completionChallengeRejected: true,
							repairRoundsCaused: evalResult.failedGates.length,
						});
					}

					if (evalResult.verdict === "semantic_gate_unavailable") {
						const bundle = await this.buildBundle(objectiveId, "semantic_gate_unavailable", runtime, {
							reasonCodes: evalResult.failedGates,
						});
						return {
							status: "semantic_gate_unavailable",
							reasonCodes:
								evalResult.failedGates.length > 0
									? evalResult.failedGates
									: ["system_one_required_but_unavailable"],
							cycleCount: this.cycleCounter,
							deliveryBundle: bundle,
						};
					}

					// Not complete: schedule repair tasks if runtime supports it
					if (evalResult.failedGates.length > 0 && this.deps.runtime.ensureRepairTasks) {
						const repairs = completionFailuresToRepairWork(
							evalResult.failedGates.map((gateId) => ({ gate_id: gateId })),
							objectiveId,
						);
						await this.deps.runtime.ensureRepairTasks(objectiveId, repairs);
					}
					break;
				}

				case "blocked_external":
				case "owner_required":
				case "cancel":
				case "unrecoverable": {
					const terminal = routeToTerminal(route);
					const statusMap: Record<string, DeliveryTerminalStatus> = {
						cancelled: "cancelled",
						blocked: "blocked_external",
						unrecoverable: "unrecoverable",
						budget_exhausted: "budget_exhausted",
						complete: "complete",
					};
					const deliveryStatus = statusMap[terminal.status] ?? "unrecoverable";
					const bundle = await this.buildBundle(objectiveId, deliveryStatus, runtime);
					this.acknowledgeRouteRequests(route);
					return {
						...terminal,
						cycleCount: this.cycleCounter,
						deliveryBundle: bundle,
					};
				}

				case "wait_for_worker":
				case "wait_for_tool": {
					if (!this.deps.waiter?.wait) {
						const bundle = await this.buildBundle(objectiveId, "unrecoverable", runtime);
						return {
							status: "unrecoverable",
							reasonCodes: ["missing_required_executor:waiter"],
							cycleCount: this.cycleCounter,
							deliveryBundle: bundle,
						};
					}
					const inFlightAttempts = this.routeWaitAttempts.get(route);
					const waiter = this.deps.waiter;
					await runAdmittedRoute(
						() => waiter.wait(inFlightAttempts ? { inFlightAttempts } : route, signal),
						() => this._noteExecutor(route, runtime, route.route),
					);
					break;
				}
			}

			this.assertExecutionCurrent(objectiveId, signal);
			this.acknowledgeRouteRequests(route);
			await this._noteExecutor(route, runtime, this.executors.get(route) ?? route.route);

			// 6. Ingest evidence & validate postflight
			await this.deps.evidence?.ingestLatest?.(objectiveId);
			this.assertExecutionCurrent(objectiveId, signal);
			await this.deps.systemOne?.validateObjectivePostflight?.(objectiveId);
			// A returned root recovery, unlike a decided route or interrupted executor, spent this
			// evidence's recovery allowance. New diagnostic/check evidence changes the fingerprint.
			if (recoveryFingerprint) this.completedVerificationRecoveries.set(objectiveId, recoveryFingerprint);

			// RCG-042: task postflight project rules. A blocking violation queues repair work and
			// stops this cycle rather than letting the objective advance past it.
			if (this.deps.projectRules) {
				const postflightState = await this._resolveCanonicalEvidenceState(
					objectiveId,
					await this.deps.runtime.reconcileObjective(objectiveId),
				);
				const postflight = await this.deps.projectRules.validateTaskPostflight({
					objectiveId,
					taskId: route.task_id ?? objectiveId,
					changedFiles: postflightState.artifacts.map((artifact) => artifact.path),
					boundedDiffEvidence: postflightState,
					signal,
				});
				this.assertExecutionCurrent(objectiveId, signal);
				if (blocksRuleTransition(postflight)) {
					if (postflight.verificationRequired) {
						this.deps.systemOne?.noteControlDirective?.(
							sameLaneVerificationDirective(postflight.violations.map((finding) => finding.explanation)),
						);
					} else if (this.deps.runtime.ensureRepairTasks) {
						await this.deps.runtime.ensureRepairTasks(
							objectiveId,
							completionFailuresToRepairWork(
								postflight.violations.map((violation) => ({
									gate_id: `project_rule:${violation.explanation}`,
								})),
								objectiveId,
							),
						);
					}
				}
			}

			// Read actual postflight evidence; a new routing cycle alone is never progress.
			const stall =
				(await this.deps.stalls?.evaluate(objectiveId)) ??
				evaluateRouteHistory(
					await this.recentRouteHistory(objectiveId),
					evidenceMarkerOf(await this.deps.runtime.reconcileObjective(objectiveId), objectiveId),
				);

			if (stall.repeatedWithoutNewEvidence) {
				await this.deps.runtime.requestReplan?.(objectiveId, stall);
			}
		}
	}

	private async _dispatchWithExpertSelection(
		objectiveId: string,
		route: ObjectiveRoute,
		runtime: TaskRuntimeProjection,
		escalated: boolean,
		signal?: AbortSignal,
	): Promise<ObjectiveTerminalResult | undefined> {
		return dispatchObjectiveRoute(
			{
				deps: this.deps,
				cycle: this.cycleCounter,
				assertCurrent: () => this.assertExecutionCurrent(objectiveId, signal),
				noteExecutor: (executor) => this._noteExecutor(route, runtime, executor),
				noteBinding: (taskId, binding) => {
					this._lastBinding = binding;
					this.attemptBindings.set(taskId, { binding, route });
				},
				refuse: async (reasonCodes) => ({
					status: "unrecoverable",
					reasonCodes,
					cycleCount: this.cycleCounter,
					deliveryBundle: await this.buildBundle(objectiveId, "unrecoverable", runtime, { reasonCodes }),
				}),
			},
			objectiveId,
			route,
			runtime,
			escalated,
			signal,
		);
	}

	private async _recordCompletionOutcomes(
		objectiveId: string,
		route: ObjectiveRoute,
		fields: {
			verificationPassed?: boolean;
			completionChallengeRejected?: boolean;
			repairRoundsCaused?: number;
		},
	): Promise<void> {
		if (!this.deps.outcomeRecorder) return;
		if (this.attemptBindings.size > 0) {
			for (const [taskId, { binding, route: attemptRoute }] of this.attemptBindings.entries()) {
				await this.deps.outcomeRecorder.record({
					binding,
					request: buildWorkerCapabilityRequest({
						objectiveId,
						taskId,
						route: attemptRoute,
						consequence: "critical",
					}),
					...fields,
				});
			}
		} else if (this._lastBinding) {
			await this.deps.outcomeRecorder.record({
				binding: this._lastBinding,
				request: buildWorkerCapabilityRequest({
					objectiveId,
					taskId: `${objectiveId}-completion-${this.cycleCounter}`,
					route,
					consequence: "critical",
				}),
				...fields,
			});
		}
	}

	private async _resolveCanonicalEvidenceState(
		objectiveId: string,
		runtime: TaskRuntimeProjection,
	): Promise<{
		evidenceRevision: number;
		artifacts: readonly { path: string; kind?: string }[];
		verificationMatrix: Record<string, unknown>;
	}> {
		const objRecord = runtime.objectives[objectiveId];
		const evidenceRevision =
			(await this.deps.evidence?.getEvidenceRevision?.(objectiveId)) ??
			(await this.deps.runtime.getEvidenceRevision?.(objectiveId)) ??
			evidenceMarkerOf(runtime, objectiveId);
		const artifacts = (await this.deps.runtime.getArtifacts?.(objectiveId)) ?? [];
		const verificationMatrix: Record<string, unknown> = {};
		for (const e of objRecord?.evidence ?? []) {
			if (e.kind === "test" || e.kind === "review") {
				verificationMatrix[e.evidenceId] = e.summary;
			}
		}
		return { evidenceRevision, artifacts, verificationMatrix };
	}

	async runToDelivery(objectiveId: string, signal?: AbortSignal): Promise<DeliveryBundle> {
		const result = await this.run(objectiveId, signal);
		if (result.deliveryBundle) {
			return result.deliveryBundle;
		}

		const runtime = await this.deps.runtime.reconcileObjective(objectiveId);
		const statusMap: Record<string, DeliveryTerminalStatus> = {
			cancelled: "cancelled",
			blocked: "blocked_external",
			unrecoverable: "unrecoverable",
			budget_exhausted: "budget_exhausted",
			semantic_gate_unavailable: "semantic_gate_unavailable",
		};
		return this.buildBundle(objectiveId, statusMap[result.status] ?? "unrecoverable", runtime);
	}

	private async runSpecialistWorkerExecution(
		runtime: any,
		specialist: MaterializedSpecialist,
		specTaskId: string,
		objectiveId: string,
		route: ObjectiveRoute,
		signal?: AbortSignal,
		evidenceRevision?: number,
	): Promise<WorkerResultContract | undefined> {
		this.assertExecutionCurrent(objectiveId, signal);
		const dispatchRuntime = this.deps.workerDispatcher?.ownsSpecialistAttempts ? undefined : runtime;
		const specTask = dispatchRuntime?.createTask?.({
			objectiveId,
			title: specialist.spec.mission,
			description: specialist.spec.purpose,
			role: specialist.spec.authority_role,
		}) ?? { taskId: specTaskId };
		const specAttempt = dispatchRuntime?.queueAttempt?.(
			specTask.taskId,
			{
				taskId: specTask.taskId,
				profileId: specialist.profileId,
				instructions: specialist.spec.mission,
				resourcePointerIds: [],
			},
			`grant-${specTaskId}`,
		) ?? { attemptId: `att-${specTaskId}` };
		(specAttempt as any).profileId = specialist.profileId;
		const specLease = dispatchRuntime?.leaseAttempt?.(
			specAttempt.attemptId,
			`owner-spec-${specialist.specialistId}`,
			60000,
		);
		if (specLease) {
			dispatchRuntime?.startAttempt?.(specAttempt.attemptId, specLease.leaseId, specLease.fencingToken);
		}

		let workerResult: WorkerResultContract | undefined;
		if (this.deps.workerDispatcher?.dispatchSpecialist) {
			const dispatcher = this.deps.workerDispatcher;
			const snapshot: TaskRuntimeProjection =
				runtime?.getSnapshot?.() ??
				(runtime?.objectives ? runtime : await this.deps.runtime.reconcileObjective(objectiveId));
			workerResult = await executeObjectiveSpecialist(
				(admit) =>
					dispatcher.dispatchSpecialist!({
						route,
						onStarted: admit,
						objectiveId,
						specialist,
						taskId: specTask.taskId,
						attemptId: specAttempt.attemptId,
						leaseId: specLease?.leaseId,
						fencingToken: specLease?.fencingToken,
						expiresAt: specLease?.expiresAt,
						signal,
					}),
				(executor) => this._noteExecutor(route, snapshot, executor),
			);
		} else if (this.deps.workerDispatcher?.dispatch) {
			await this.deps.workerDispatcher.dispatch(route, signal, {
				model_id: specialist.expert.modelId,
				provider: specialist.expert.providerId,
				routing_band: specialist.expert.routingBand as any,
				capability_tier: specialist.expert.capabilityTier as any,
				thinking_level: "high",
				work_class: "implement",
				worker_role: specialist.spec.authority_role,
			} as any);
		}

		if (workerResult) {
			dispatchRuntime?.finishAttempt?.({
				...workerResult,
				objectiveId,
				taskId: specTask.taskId,
				attemptId: specAttempt.attemptId,
				leaseId: specLease?.leaseId ?? workerResult.leaseId,
				fencingToken: specLease?.fencingToken ?? workerResult.fencingToken,
			});
			this.assertExecutionCurrent(objectiveId, signal);

			const normalizedEvidence = {
				resultId: workerResult.resultId,
				status: workerResult.status,
				summary: workerResult.summary,
				artifacts: workerResult.artifacts ?? [],
				changedFiles:
					(workerResult as any).claim?.changedFiles ?? (workerResult.artifacts ?? []).map((a: any) => a.uri) ?? [],
				toolCalls: workerResult.usage?.toolCalls ?? 0,
				usage: workerResult.usage,
				modelBinding: specialist.expert,
			};
			await this.deps.systemOne?.recordHostEvidence?.(normalizedEvidence);

			if (this.deps.specialistSynthesis?.evaluateEffectiveness) {
				await this.deps.specialistSynthesis.evaluateEffectiveness(specialist, normalizedEvidence, {
					objectiveId,
					taskId: specTask.taskId,
					evidenceRevision,
				});
			}
		}

		return workerResult;
	}
}

/** A judgment that reversible work may proceed past: an outage, or an ambiguous answer. */
function isReversibleDoubtOrOutage(err: unknown): boolean {
	if (err instanceof SteeringJudgmentUnavailableError) return err.authority === "reversible_work";
	return err instanceof SteeringSemanticFailedError && err.outcome === "gather_more";
}
