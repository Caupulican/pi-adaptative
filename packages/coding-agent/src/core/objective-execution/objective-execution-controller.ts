/**
 * Objective Execution Controller.
 * Deterministic loop owner for objective continuation, semantic routing, and completion gating.
 * Conforms to ROUTING_PROGRAM.md, COMPLETION_COORDINATOR.md, HUMAN_EDGE.md, and FINAL_PATCH_SPEC v2.1.
 */

import { randomUUID } from "node:crypto";
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
import { DecisionActionPolicy } from "../decision/action-policy.ts";
import { resolveEffectiveCompletionProfile } from "../decision/completion-profile.ts";
import type { DecisionEngineRouter } from "../decision/engine-router.ts";
import type { CompletionAssuranceProfile } from "../decision/policy.ts";
import { createDecisionProgram } from "../decision/program.ts";
import type { ResponsibilityStatement, SemanticResponsibilityController } from "../dedup/index.ts";
import type {
	ExpertBinding,
	ExpertOutcomeRecorder,
	ExpertSelectionResult,
	ExpertSelectionService,
} from "../expert-routing/index.ts";
import { buildWorkerCapabilityRequest, NoEligibleExpertError } from "../expert-routing/index.ts";
import type { WorkerResultContract } from "../orchestration/contracts.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import type { SystemOneSteeringPlane } from "../steering/index.ts";
import {
	type CandidateSnapshot,
	candidateSnapshotIdentity,
	captureCandidateSnapshot,
} from "../system-one/candidate-snapshot.ts";
import type { SystemOneControlDirective } from "../system-one/control-directive.ts";
import { TerminalCompletionConflictError, type TerminalCompletionProof } from "../system-one/controller.ts";
import type { FinalCompletionVerdict } from "../system-one/policy.ts";
import type { ExecutionState } from "../system-one/types.ts";
import {
	CompletionCoordinator,
	type CompletionEvaluationContext,
	type IndependentReviewerVerdict,
} from "./completion-coordinator.ts";
import {
	buildDeliveryBundle,
	type CommitReceipt,
	type DeliveryArtifact,
	type DeliveryBundle,
	type DeliveryTerminalStatus,
	type PushReceipt,
	type SideEffectReceipt,
	sideEffectSucceeded,
} from "./delivery-bundle.ts";
import {
	type DeliveryProofObservation,
	type DeliveryProofQuery,
	type DeployProofObservation,
	type PublishProofObservation,
	proveCommitAndPush,
	proveDeployReceipt,
	provePublishReceipt,
	proveTagReceipt,
	type TagProofObservation,
} from "./delivery-proof.ts";
import { completionFailuresToRepairWork, type RepairWork } from "./objective-repair-work.ts";
import {
	type ObjectiveRoute,
	type ObjectiveRouteName,
	type ObjectiveTerminalResult,
	routeToTerminal,
	validateObjectiveRoute,
} from "./objective-route.ts";
import { composeObjectiveRoute } from "./objective-route-policy.ts";
import {
	projectBoundedCombinedState,
	type RouteHistoryEntry,
	type SemanticRouteJudgments,
} from "./objective-route-projector.ts";
import { ObjectiveStallDetector, type StallEvaluation } from "./objective-stall-fingerprint.ts";

export type ExecutionLoopMode = "legacy_goal" | "objective_shadow" | "objective_primary" | "start_only" | "interactive";

export interface DisagreementTelemetryEvent {
	cycleId: string;
	objectiveId: string;
	legacyAction: string;
	objectiveRoute: ObjectiveRouteName;
	reasonCodes: readonly string[];
}

export interface ObjectiveExecutionControllerDeps {
	runtime: {
		reconcileObjective(objectiveId: string): Promise<TaskRuntimeProjection>;
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
		evaluateObjectiveRoute?(objectiveId: string, options?: { signal?: AbortSignal }): Promise<SemanticRouteJudgments>;
		executeCompletionTransaction?(
			isBugFix: boolean,
			options?: { signal?: AbortSignal; persistTerminal?: boolean },
		): Promise<FinalCompletionVerdict>;
		commitTerminalCompletion?(input: TerminalCompletionProof, options?: { signal?: AbortSignal }): Promise<void>;
		validateObjectivePostflight?(objectiveId: string): Promise<void>;
		recordHostEvidence?(evidence: unknown): Promise<void>;
		peekControlDirective?(): SystemOneControlDirective | undefined;
		consumeControlDirective?(): SystemOneControlDirective | undefined;
		noteControlDirective?(directive: SystemOneControlDirective): void;
	};
	repoRoot?: string;
	decisions?: DecisionEngineRouter;
	actionPolicy?: DecisionActionPolicy;
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
		execute(route: ObjectiveRoute, signal?: AbortSignal): Promise<void>;
	};
	verifier?: {
		execute(route: ObjectiveRoute, signal?: AbortSignal): Promise<void>;
	};
	workerDispatcher?: {
		dispatch(route: ObjectiveRoute, signal?: AbortSignal, binding?: ExpertBinding): Promise<void>;
		continueWorker(route: ObjectiveRoute, signal?: AbortSignal, binding?: ExpertBinding): Promise<void>;
		dispatchEscalated(route: ObjectiveRoute, signal?: AbortSignal, binding?: ExpertBinding): Promise<void>;
		dispatchSpecialist?(input: {
			specialist: MaterializedSpecialist;
			taskId: string;
			attemptId?: string;
			leaseId?: string;
			fencingToken?: number;
			expiresAt?: string;
			signal?: AbortSignal;
		}): Promise<WorkerResultContract>;
	};
	expertSelector?: ExpertSelectionService;
	outcomeRecorder?: ExpertOutcomeRecorder;
	/**
	 * The root model as an executor: one foreground turn carrying the route's brief. Used for the
	 * routes System One does not hand to an independent worker (implement, investigate, replan,
	 * retrieval and non-independent verification); review and escalations stay with workers.
	 */
	rootExecutor?: { execute(route: ObjectiveRoute, signal?: AbortSignal): Promise<void> };
	/** The owner's authority is what the objective waits on right now: an open question or an operator blocker. */
	ownerRequired?(objectiveId: string): boolean;
	/** Unconsumed specialist/capability/verifier requests from live worker supervision. */
	pendingSupervisionRequests?(): readonly {
		readonly signal_id: string;
		readonly action: string;
		readonly reason_codes?: readonly string[];
	}[];
	consumePendingSupervisionRequest?(signalId: string): void;
	mode?: ExecutionLoopMode;
	executionCharter?: ExecutionCharter;
	authorityBlockLedger?: DurableAuthorityBlockLedger;
	gitExecutor?: {
		commit?(message?: string): Promise<{ sha: string } | undefined>;
		push?(): Promise<{ ref: string; remote?: string } | undefined>;
		tag?(name?: string): Promise<{ tag: string } | undefined>;
		/** Observed HEAD, remote SHA, and candidate residue. No network call lives in the controller. */
		proveDelivery?(query: DeliveryProofQuery): Promise<DeliveryProofObservation>;
		proveTag?(tag: string): Promise<TagProofObservation>;
	};
	releaseExecutor?: {
		publish?(): Promise<{ id: string } | undefined>;
		deploy?(target: string): Promise<{ id: string } | undefined>;
		provePublish?(publicationId: string): Promise<PublishProofObservation>;
		proveDeploy?(target: string): Promise<DeployProofObservation>;
	};
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
			signal?: AbortSignal;
		}): Promise<{ passed: boolean; violations: readonly { consequence: string; explanation: string }[] }>;
		validateCompletion(input: {
			objectiveId: string;
			changedFiles: readonly string[];
			signal?: AbortSignal;
		}): Promise<{ passed: boolean; violations: readonly { consequence: string; explanation: string }[] }>;
	};
}

/** A rule violation blocks when the owner marked the rule critical or high. */
function ruleViolationBlocks(result: { passed: boolean; violations: readonly { consequence: string }[] }): boolean {
	return (
		!result.passed &&
		result.violations.some((violation) => violation.consequence === "critical" || violation.consequence === "high")
	);
}

export const ROUTE_DECISION_PROGRAM = createDecisionProgram({
	id: "objective-route-v2",
	version: "2.1.0",
	decisions: [
		{
			kind: "choice",
			id: "task_kind",
			instruction: "Which task class best describes the current objective?",
			options: {
				bug_fix: { description: "Investigate and correct wrong behavior" },
				feature: { description: "Implement new capabilities" },
				refactor: { description: "Restructure code without changing behavior" },
				exploration: { description: "Investigate codebase or documentation" },
			},
		},
		{
			kind: "boolean",
			id: "work_remaining",
			instruction: "Does verifiable implementation work or required proof remain unsatisfied?",
		},
		{
			kind: "choice",
			id: "missing_work_class",
			instruction: "What primary canonical class of work remains to advance the objective?",
			options: {
				retrieve: {
					description: "Retrieve code, tests, docs, or runtime context",
					notFor: "Required context and files are already loaded and verified",
				},
				investigate: {
					description: "Inspect codebase, trace root cause, explore hypotheses",
					notFor: "Root cause is understood and exact code changes are planned",
				},
				implement: {
					description: "Author or edit source code to advance objective",
					notFor: "Root cause or necessary evidence is still unresolved",
				},
				deterministic_test: {
					description: "Run deterministic tests or static checks",
					notFor: "No test or check commands are available or needed",
				},
				verify: {
					description: "Verify behavior against required criteria",
					notFor: "Implementation has not yet changed",
				},
				review: {
					description: "Review diff or verify architectural invariants",
					notFor: "Significant implementation work is still incomplete",
				},
				replan: {
					description: "Strategy failed, scope changed, or replanning required",
					notFor: "Current strategy is progressing smoothly",
				},
				none: {
					description: "All required criteria verified and complete",
					notFor: "Acceptance criteria or mechanical checks remain incomplete",
				},
				insufficient_evidence: {
					description: "Insufficient evidence to determine next implementation action",
					notFor: "Clear path forward is established with available evidence",
				},
			},
		},
		{
			kind: "boolean",
			id: "current_worker_can_continue",
			instruction: "Can the current worker continue without resetting context or changing role?",
		},
		{
			kind: "boolean",
			id: "independent_worker_required",
			instruction: "Does the current stage require a fresh or independent worker context?",
		},
		{
			kind: "boolean",
			id: "capability_escalation_required",
			instruction: "Does the remaining work require escalated tools or reasoning models?",
		},
		{
			kind: "boolean",
			id: "external_blocker_present",
			instruction: "Is progress blocked by external service, permissions, or missing user action?",
		},
		{
			kind: "score",
			id: "semantic_progress",
			instruction: "Score the verified semantic progress made towards the objective",
			levels: [
				{ value: 0, description: "No verified progress" },
				{ value: 1, description: "Useful evidence only" },
				{ value: 2, description: "Acceptance advanced" },
				{ value: 3, description: "Major uncertainty or required behavior resolved" },
			],
		},
		{
			kind: "boolean",
			id: "context_stale",
			instruction: "Has the worker context become stale relative to recent file or runtime changes?",
		},
		{
			kind: "boolean",
			id: "strategy_repetition",
			instruction: "Is the execution repeating a failed strategy without acquiring new evidence?",
		},
		{
			kind: "boolean",
			id: "completion_plausible",
			instruction: "Is the objective plausibly ready for formal completion verification?",
		},
		{
			kind: "boolean",
			id: "evidence_sufficient",
			instruction: "Is the available evidence sufficient to substantiate the current state?",
		},
	],
});

function routeStateProjection(
	deps: ObjectiveExecutionControllerDeps,
	objectiveId: string,
	runtime: TaskRuntimeProjection,
	stall: StallEvaluation,
	history: readonly RouteHistoryEntry[],
	initialDigest: string,
	routeSnapshot: CandidateSnapshot | undefined,
) {
	return projectBoundedCombinedState(objectiveId, runtime, {
		stallTurns: stall.stallTurns,
		strategyFingerprint: stall.fingerprint,
		history,
		beforeDigest: initialDigest,
		afterDigest: captureOptionalSnapshot(deps.repoRoot)?.digest ?? "unknown",
		systemOneState: deps.systemOne?.snapshot?.(),
		candidateDigest: routeSnapshot?.digest,
		integrityState: deps.systemOne?.snapshot ? "available" : "unavailable",
	});
}

function captureOptionalSnapshot(repoRoot: string | undefined): CandidateSnapshot | undefined {
	if (!repoRoot) return undefined;
	try {
		return captureCandidateSnapshot(repoRoot);
	} catch {
		return undefined;
	}
}

export class ObjectiveExecutionController {
	private readonly deps: ObjectiveExecutionControllerDeps;
	private readonly defaultStallDetector: ObjectiveStallDetector;
	private readonly humanEdgeLedger: DurableHumanEdgeLedger;
	private readonly authorityBlockLedger: DurableAuthorityBlockLedger;
	private readonly attemptBindings = new Map<string, { binding: ExpertBinding; route: ObjectiveRoute }>();
	private readonly admittedObjectives = new Set<string>();
	private readonly admissionCerts = new Map<string, string[]>();
	private readonly alternativesTried = new Set<string>();
	private cycleCounter = 0;
	private _lastBinding?: ExpertBinding;
	private _lastRoute?: ObjectiveRoute;
	private _lastExecutor?: string;
	private ownerBlockerSink?: (blocker: string | undefined) => void;

	/** The route the last run cycle evaluated; the session's loop reads it to name a wait or a stop. */
	getLastRoute(): ObjectiveRoute | undefined {
		return this._lastRoute;
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
		this.defaultStallDetector = new ObjectiveStallDetector();
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
		if (this.deps.steeringPlane?.policy.mode === "system_one_required" || this.getMode() === "objective_primary") {
			throw err;
		}
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
		const { objectiveId, action = "escalate_capability", input, signal } = options;
		signal?.throwIfAborted();

		if (action === "escalate_capability") {
			const route: ObjectiveRoute = {
				schema_version: "1.0",
				cycle_id: `cycle-${objectiveId}`,
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
					executed: true,
					result: workerResult,
				};
			}
		}

		return {
			action,
			executed: false,
		};
	}

	async evaluateRouteOnce(
		objectiveId: string,
		options?: { signal?: AbortSignal; legacyActionHint?: string },
	): Promise<ObjectiveRoute> {
		const routeSnapshot = captureOptionalSnapshot(this.deps.repoRoot);
		const initialDigest = routeSnapshot?.digest ?? "unknown";
		options?.signal?.throwIfAborted();
		const cycleId = `cycle_${++this.cycleCounter}_${randomUUID().slice(0, 8)}`;

		const runtime = await this.deps.runtime.reconcileObjective(objectiveId);

		// Check deterministic cancellation and budget invariants
		const cancelled =
			this.deps.runtime.isCancelled?.(objectiveId) ??
			runtime.objectives[objectiveId]?.objective.status === "cancelled";
		const budgetExhausted = this.deps.runtime.isBudgetExhausted?.(objectiveId);

		// Check in-flight workers / tools
		const activeAttempts = Object.values(runtime.attempts).filter((a) => a.status === "running");
		const requiredWorkerInFlight = activeAttempts.length > 0;

		// Reconcile evidence
		await this.deps.evidence?.reconcile?.(objectiveId);

		// Evaluate stall
		let stall: StallEvaluation = {
			stalled: false,
			stallTurns: 0,
			repeatedWithoutNewEvidence: false,
			fingerprint: "init",
		};
		if (this.deps.stalls) {
			stall = await this.deps.stalls.evaluate(objectiveId);
		}

		// The ledger's recent routes are part of what the judge sees: repetition is a fact, not a hunch.
		const history = (await this.deps.checkpoints?.recentRoutes?.(objectiveId, 6)) ?? [];

		// Evaluate semantic route via SteeringPlane JEV-004 (PH-113: JEV-004 route owner)
		let semantic: SemanticRouteJudgments = {};

		if (this.deps.decisions) {
			try {
				// FIN-034: Use bounded combined state projection
				const stateProjection = routeStateProjection(
					this.deps,
					objectiveId,
					runtime,
					stall,
					history,
					initialDigest,
					routeSnapshot,
				);

				const evaluation = await this.deps.decisions.evaluateOrFallback(ROUTE_DECISION_PROGRAM, stateProjection, {
					signal: options?.signal,
					consequence: "medium",
				});

				// FIN-035: Pass evaluation through DecisionActionPolicy
				const policy = this.deps.actionPolicy ?? new DecisionActionPolicy();
				const mwc = evaluation.results.missing_work_class;
				let missingWorkClass: SemanticRouteJudgments["missingWorkClass"] =
					mwc?.kind === "choice" ? (mwc.selected as SemanticRouteJudgments["missingWorkClass"]) : undefined;

				if (mwc && mwc.kind === "choice") {
					const disposition = policy.evaluateChoice(mwc, "medium");
					if (disposition.action !== "accept") {
						// Low confidence or unaccepted provenance routes to retrieve or insufficient_evidence
						missingWorkClass = "insufficient_evidence";
					}
				}

				const wr = evaluation.results.work_remaining;
				const cwcc = evaluation.results.current_worker_can_continue;
				const iwr = evaluation.results.independent_worker_required;
				const cer =
					evaluation.results.capability_escalation_required ?? evaluation.results.capability_escalation_needed;
				const ebp = evaluation.results.external_blocker_present ?? evaluation.results.external_blocker;
				const sp = evaluation.results.semantic_progress;
				const cs = evaluation.results.context_stale;
				const sr = evaluation.results.strategy_repetition;

				semantic = {
					workRemaining: wr?.kind === "boolean" ? wr.value : undefined,
					missingWorkClass,
					currentWorkerCanContinue: cwcc?.kind === "boolean" ? cwcc.value : undefined,
					independentWorkerRequired: iwr?.kind === "boolean" ? iwr.value : undefined,
					capabilityEscalationRequired: cer?.kind === "boolean" ? cer.value : undefined,
					externalBlockerPresent: ebp?.kind === "boolean" ? ebp.value : undefined,
					semanticProgress: sp?.kind === "score" ? sp.value : undefined,
					contextStale: cs?.kind === "boolean" ? cs.value : undefined,
					strategyRepetition: sr?.kind === "boolean" ? sr.value : undefined,
				};
			} catch (err) {
				this.throwIfRequiredSemantic(err);
			}
		} else if (this.deps.steeringPlane) {
			try {
				const stateProjection = routeStateProjection(
					this.deps,
					objectiveId,
					runtime,
					stall,
					history,
					initialDigest,
					routeSnapshot,
				);
				const cert = await this.deps.steeringPlane.requireCertificate("JEV-004", stateProjection, {
					objectiveId,
					signal: options?.signal,
				});

				const wrAns = cert.answers.work_remaining as { boolean?: boolean } | undefined;
				const cwccAns = cert.answers.current_worker_can_continue as { boolean?: boolean } | undefined;
				const iwrAns = cert.answers.independent_worker_required as { boolean?: boolean } | undefined;
				const cerAns = cert.answers.capability_escalation_required as { boolean?: boolean } | undefined;
				const spAns = cert.answers.semantic_progress as { level?: number; score?: number } | undefined;
				const csAns = cert.answers.context_stale as { boolean?: boolean } | undefined;
				const srAns = cert.answers.strategy_repetition as { boolean?: boolean } | undefined;
				const mwcAns = cert.answers.missing_work_class as { choice?: string } | undefined;

				semantic = {
					workRemaining: typeof wrAns?.boolean === "boolean" ? wrAns.boolean : undefined,
					missingWorkClass: mwcAns?.choice as SemanticRouteJudgments["missingWorkClass"],
					currentWorkerCanContinue: typeof cwccAns?.boolean === "boolean" ? cwccAns.boolean : undefined,
					independentWorkerRequired: typeof iwrAns?.boolean === "boolean" ? iwrAns.boolean : undefined,
					capabilityEscalationRequired: typeof cerAns?.boolean === "boolean" ? cerAns.boolean : undefined,
					semanticProgress: spAns?.level ?? spAns?.score,
					contextStale: typeof csAns?.boolean === "boolean" ? csAns.boolean : undefined,
					strategyRepetition: typeof srAns?.boolean === "boolean" ? srAns.boolean : undefined,
				};
			} catch (err) {
				if (this.deps.steeringPlane.policy.mode === "system_one_required") {
					throw err;
				}
			}
		} else if (this.deps.systemOne?.evaluateObjectiveRoute) {
			try {
				semantic = await this.deps.systemOne.evaluateObjectiveRoute(objectiveId, { signal: options?.signal });
			} catch (err) {
				this.throwIfRequiredSemantic(err);
			}
		}

		const pendingDirective =
			this.deps.systemOne?.peekControlDirective?.() ?? this.deps.systemOne?.consumeControlDirective?.();
		const consumedWithoutPeek =
			pendingDirective !== undefined && this.deps.systemOne?.peekControlDirective === undefined;
		const pendingSupervision = requiredWorkerInFlight ? undefined : this.deps.pendingSupervisionRequests?.()[0];
		const supervisionAction =
			pendingSupervision?.action === "request_specialist" ||
			pendingSupervision?.action === "request_capability" ||
			pendingSupervision?.action === "request_verifier" ||
			pendingSupervision?.action === "mark_external_block"
				? pendingSupervision.action
				: undefined;
		const route = composeObjectiveRoute({
			cycleId,
			objectiveId,
			cancelled,
			budgetExhausted,
			requiredWorkerInFlight,
			ownerRequired: this.deps.ownerRequired?.(objectiveId) ?? false,
			strategyRepetition: stall.repeatedWithoutNewEvidence,
			semantic,
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
					route.reason_codes.includes("independent_verification_needed")) ||
				(supervisionAction === "mark_external_block" &&
					route.route === "blocked_external" &&
					route.reason_codes.includes("external_dependency_unavailable"));
			if (adopted) {
				this.deps.consumePendingSupervisionRequest?.(pendingSupervision.signal_id);
			}
		}
		if (pendingDirective) {
			const adopted = route.route === pendingDirective.objectiveRoute;
			if (adopted && !consumedWithoutPeek) {
				this.deps.systemOne?.consumeControlDirective?.();
			} else if (!adopted && consumedWithoutPeek) {
				this.deps.systemOne?.noteControlDirective?.(pendingDirective);
			}
		}

		validateObjectiveRoute(route);
		await this.deps.checkpoints?.recordRoute?.(route);

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
		let cycles = 0;
		while (true) {
			if (maxCycles !== undefined && cycles++ >= maxCycles) return undefined;
			signal?.throwIfAborted();

			const runtime = await this.deps.runtime.reconcileObjective(objectiveId);

			// PH-110..PH-112: Objective admission certificates
			if (this.deps.steeringPlane && !this.admittedObjectives.has(objectiveId)) {
				this.admittedObjectives.add(objectiveId);
				const c1 = await this.deps.steeringPlane.requireCertificate(
					"JEV-001",
					{
						objectiveId,
						request: runtime.objectives[objectiveId]?.objective?.description ?? objectiveId,
					},
					{ objectiveId, signal },
				);
				const c2 = await this.deps.steeringPlane.requireCertificate(
					"JEV-002",
					{
						objectiveId,
						acceptanceCriteria: runtime.objectives[objectiveId]?.objective?.acceptanceCriteria ?? [],
					},
					{ objectiveId, signal },
				);
				const c3 = await this.deps.steeringPlane.requireCertificate(
					"JEV-003",
					{
						objectiveId,
						groundingState: "intake_verified",
					},
					{ objectiveId, signal },
				);
				this.admissionCerts.set(objectiveId, [c1.certificate_id, c2.certificate_id, c3.certificate_id]);
			}

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

			// 2. Check required in-flight workers
			const activeAttempts = Object.values(runtime.attempts).filter((a) => a.status === "running");
			if (activeAttempts.length > 0) {
				if (this.deps.waiter) {
					await this.deps.waiter.wait({ inFlightAttempts: activeAttempts }, signal);
					continue;
				}
			}

			// 3. Evaluate route
			const route = await this.evaluateRouteOnce(objectiveId, { signal });
			this._lastRoute = route;
			this._lastExecutor = undefined;

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
									missingAuthority: charterDecision.missingAuthority,
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
			switch (route.route) {
				case "retrieve":
					if (!this.deps.retrieval?.execute && this.deps.rootExecutor) {
						// No dedicated retrieval executor: the root reads, with the route's brief.
						await this.deps.rootExecutor.execute(route, signal);
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
					await this.deps.retrieval.execute(route, signal);
					break;

				case "deterministic_test":
					if (!this.deps.verifier?.execute && this.deps.rootExecutor) {
						// No dedicated verifier: the root runs the checks, with the route's brief.
						await this.deps.rootExecutor.execute(route, signal);
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
						await this.deps.verifier.execute(route, signal);
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

					await this._runObjectivePostflight(objectiveId, route, runtime, signal);
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
					await this.deps.workerDispatcher.continueWorker(route, signal, this._lastBinding);
					await this._runObjectivePostflight(objectiveId, route, runtime, signal);
					break;

				case "escalate_capability": {
					if (this.deps.adaptiveResolution) {
						const resolution = await this.deps.adaptiveResolution.resolve({
							objectiveId,
							taskId: `${objectiveId}-adapt-${this.cycleCounter}`,
							currentExpert: this._lastBinding?.model_id,
							signal,
						});

						if (resolution.dimension === "specialist" && this.deps.specialistSynthesis) {
							// FC-023, FC-024, FC-025: Real dynamic SpecialistNeed from resolution (never adaptation node id)
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

							// ERC-040..ERC-045: Materialized specialist becomes durable task, attempt, and worker execution
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

							// ERC-046: Objective resumes
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
					await this._runObjectivePostflight(objectiveId, route, runtime, signal);
					break;
				}

				case "completion_candidate": {
					// FIN-060: Single completion owner via CompletionCoordinator
					const profile = resolveEffectiveCompletionProfile({
						requestedProfile: this.deps.completionProfile,
						steeringMode: this.deps.steeringPlane?.policy.mode,
						systemOneBound: Boolean(this.deps.systemOne || this.deps.steeringPlane),
					});
					const steeringCertRefs: string[] = [];

					// FC-070, FC-071, FC-072: Canonical proof state on real projection without asserted verificationPassed:true
					const objRecord = runtime.objectives[objectiveId];
					const { evidenceRevision, artifacts, verificationMatrix } = await this._resolveCanonicalEvidenceState(
						objectiveId,
						runtime,
					);
					const sourceRevision =
						(await this.deps.runtime.getSourceRevision?.(objectiveId)) ?? String(evidenceRevision);
					const limitations = (await this.deps.runtime.getLimitations?.(objectiveId)) ?? [];
					const acceptanceEvidence = objRecord?.evidence ?? [];
					const candidateSnapshot = captureOptionalSnapshot(this.deps.repoRoot);
					const diffDigest = candidateSnapshot?.digest ?? "unknown";
					const snapshotIdentity = candidateSnapshot ? candidateSnapshotIdentity(candidateSnapshot) : undefined;

					const canonicalProofState = {
						objectiveId,
						cycleCount: this.cycleCounter,
						evidenceRevision,
						sourceRevision: candidateSnapshot?.candidateRevision ?? sourceRevision,
						verificationMatrix,
						acceptanceEvidence,
						acceptanceCriteria: objRecord?.objective?.acceptanceCriteria ?? [],
						evidenceRefs: objRecord?.evidence?.map((e) => e.evidenceId) ?? [],
						diffDigest,
						candidateSnapshot: snapshotIdentity,
						artifacts,
						limitations,
					};

					// 1. PH-150, FC-062: JEV-024 completion plausibility on canonical proof state BEFORE finalization gates
					if (this.deps.steeringPlane) {
						try {
							const c24 = await this.deps.steeringPlane.requireCertificate("JEV-024", canonicalProofState, {
								objectiveId,
								evidenceRevision,
								signal,
							});
							steeringCertRefs.push(c24.certificate_id);

							if (c24.semantic_outcome !== "pass" || c24.directive !== "completion_candidate") {
								if (this.deps.runtime.ensureRepairTasks) {
									const repairs = completionFailuresToRepairWork(
										(c24.failed_semantic_predicates ?? ["completion_not_plausible"]).map((p) => ({
											gate_id: p,
										})),
										objectiveId,
									);
									await this.deps.runtime.ensureRepairTasks(objectiveId, repairs);
								}
								break;
							}
						} catch (_err) {
							if (this.deps.steeringPlane.policy.mode === "system_one_required") {
								const bundle = await this.buildBundle(objectiveId, "semantic_gate_unavailable", runtime, {
									reasonCodes: ["system_one_required_but_unavailable"],
								});
								return {
									status: "semantic_gate_unavailable",
									reasonCodes: ["system_one_required_but_unavailable"],
									cycleCount: this.cycleCounter,
									deliveryBundle: bundle,
								};
							}
							break;
						}
					}

					// RCG-043: completion project rules. A blocking violation queues repair work and
					// refuses the completion candidate; it never finalizes on a violated rule.
					if (this.deps.projectRules) {
						const completionRules = await this.deps.projectRules.validateCompletion({
							objectiveId,
							changedFiles: artifacts.map((artifact) => artifact.path),
							signal,
						});
						if (ruleViolationBlocks(completionRules)) {
							if (this.deps.runtime.ensureRepairTasks) {
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
										const verdict = await this.deps.systemOne!.executeCompletionTransaction!(false, {
											...opts,
											persistTerminal: false,
										});
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

					if (evalResult.verdict === "complete") {
						// 3. PH-152, FC-063: JEV-025 primary semantic completion (proof-bearing)
						if (this.deps.steeringPlane) {
							const description = String(objRecord?.objective?.description ?? "");
							const bugFix =
								objectiveId.toLowerCase().includes("bug") || description.toLowerCase().includes("bug");
							const c25 = await this.deps.steeringPlane.requireCertificate(
								"JEV-025",
								{
									...canonicalProofState,
									mechanicalVerdict: evalResult.verdict,
									evalResultDetails: evalResult,
									bugFix,
								},
								{ objectiveId, evidenceRevision, signal },
							);
							steeringCertRefs.push(c25.certificate_id);

							if (c25.semantic_outcome !== "pass") {
								if (this.deps.runtime.ensureRepairTasks) {
									const repairs = completionFailuresToRepairWork(
										(c25.failed_semantic_predicates ?? ["primary_completion_failed"]).map((p) => ({
											gate_id: p,
										})),
										objectiveId,
									);
									await this.deps.runtime.ensureRepairTasks(objectiveId, repairs);
								}
								const reasonCodes = ["primary_completion_failed", ...(c25.failed_semantic_predicates ?? [])];
								const bundle = await this.buildBundle(objectiveId, "unrecoverable", runtime, {
									reasonCodes,
								});
								return {
									status: "unrecoverable",
									reasonCodes,
									cycleCount: this.cycleCounter,
									deliveryBundle: bundle,
								};
							}
						}

						// 4. PH-153, FC-064, FC-073: JEV-026 cold adversarial challenge (cold proof-bearing)
						if (this.deps.steeringPlane) {
							const coldProofState = {
								objectiveId,
								acceptanceCriteria: canonicalProofState.acceptanceCriteria,
								evidenceRefs: canonicalProofState.evidenceRefs,
								coldChallenge: true,
								verificationMatrix,
								diffDigest,
							};
							const c26 = await this.deps.steeringPlane.requireCertificate("JEV-026", coldProofState, {
								objectiveId,
								evidenceRevision,
								signal,
							});
							steeringCertRefs.push(c26.certificate_id);

							const adverseChallengeIds = [
								"hidden_regressions",
								"plausible_regression_not_tested",
								"missing_requirement",
								"hidden_assumption",
								"conclusion_overstates_evidence",
							].filter((id) => (c26.answers[id] as { value?: boolean } | undefined)?.value === true);
							if (c26.semantic_outcome !== "pass" || adverseChallengeIds.length > 0) {
								if (this.deps.runtime.ensureRepairTasks) {
									const repairs = completionFailuresToRepairWork(
										(c26.failed_semantic_predicates ?? ["hidden_regressions_or_edge_concern"]).map((p) => ({
											gate_id: p,
										})),
										objectiveId,
									);
									await this.deps.runtime.ensureRepairTasks(objectiveId, repairs);
								}
								const reasonCodes = [
									"adversarial_completion_failed",
									...adverseChallengeIds,
									...(c26.failed_semantic_predicates ?? []),
								];
								const bundle = await this.buildBundle(objectiveId, "unrecoverable", runtime, {
									reasonCodes,
								});
								return {
									status: "unrecoverable",
									reasonCodes,
									cycleCount: this.cycleCounter,
									deliveryBundle: bundle,
								};
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
						if (activeCharter) {
							const needsPublishOrDeploy =
								activeCharter.release.package_publish || activeCharter.release.deploy_targets.length > 0;
							if (needsPublishOrDeploy && this.deps.steeringPlane) {
								const c28 = await this.deps.steeringPlane.requireCertificate(
									"JEV-028",
									{
										objectiveId,
										publishRequested: Boolean(activeCharter.release.package_publish),
										deployTargets: activeCharter.release.deploy_targets,
										releaseRules: activeCharter.release,
									},
									{ objectiveId, evidenceRevision, signal },
								);
								steeringCertRefs.push(c28.certificate_id);

								const deploySafe =
									c28.semantic_outcome === "pass" &&
									(c28.answers.deploy_safe as { value?: boolean })?.value !== false;
								if (!deploySafe) {
									const bundle = await this.buildBundle(objectiveId, "unrecoverable", runtime, {
										reasonCodes: ["release_readiness_rejected", ...(c28.failed_semantic_predicates ?? [])],
									});
									return {
										status: "unrecoverable",
										reasonCodes: ["release_readiness_rejected"],
										cycleCount: this.cycleCounter,
										deliveryBundle: bundle,
									};
								}
							}
						}

						const sideEffects: {
							commit?: SideEffectReceipt<CommitReceipt>;
							tag?: SideEffectReceipt<{ tag: string }>;
							push?: SideEffectReceipt<PushReceipt>;
							publish?: SideEffectReceipt<{ publicationId: string }>;
							deploy?: SideEffectReceipt<{ target: string; deploymentId?: string }>[];
						} = {};
						let reportedCommitSha: string | undefined;
						let commitError: string | undefined;
						let reportedPushRef: string | undefined;
						let reportedPushRemote: string | undefined;
						let pushError: string | undefined;
						let reportedTag: string | undefined;
						let tagError: string | undefined;
						let reportedPublicationId: string | undefined;
						let publishError: string | undefined;
						const reportedDeploys: { target: string; id?: string; error?: string }[] = [];
						if (activeCharter) {
							if (activeCharter.git.commit) {
								if (!this.deps.gitExecutor?.commit) {
									commitError = "Git commit unavailable";
								} else {
									try {
										const commitRes = await this.deps.gitExecutor.commit();
										if (commitRes && typeof commitRes === "object" && "sha" in commitRes && commitRes.sha) {
											reportedCommitSha = String(commitRes.sha);
										} else {
											commitError = "Missing sha";
										}
									} catch (error) {
										commitError = error instanceof Error ? error.message : String(error);
									}
								}
							}
							if (activeCharter.git.create_tag) {
								if (!this.deps.gitExecutor?.tag) {
									tagError = "Git tag unavailable";
								} else {
									try {
										const tagRes = await this.deps.gitExecutor.tag();
										if (tagRes && typeof tagRes === "object" && "tag" in tagRes && tagRes.tag) {
											reportedTag = String(tagRes.tag);
										} else {
											tagError = "Missing tag";
										}
									} catch (error) {
										tagError = error instanceof Error ? error.message : String(error);
									}
								}
							}
							if (activeCharter.git.push) {
								if (!this.deps.gitExecutor?.push) {
									pushError = "Git push unavailable";
								} else
									try {
										const pushRes = await this.deps.gitExecutor.push();
										if (pushRes && typeof pushRes === "object" && "ref" in pushRes && pushRes.ref) {
											reportedPushRef = String(pushRes.ref);
											if ("remote" in pushRes && pushRes.remote) reportedPushRemote = String(pushRes.remote);
										} else {
											pushError = "Missing ref";
										}
									} catch (error) {
										pushError = error instanceof Error ? error.message : String(error);
									}
							}
							if (activeCharter.release.package_publish) {
								if (!this.deps.releaseExecutor?.publish) {
									publishError = "Package publish unavailable";
								} else {
									try {
										const pubRes = await this.deps.releaseExecutor.publish();
										if (pubRes && typeof pubRes === "object" && "id" in pubRes && pubRes.id) {
											reportedPublicationId = String(pubRes.id);
										} else {
											publishError = "Missing id";
										}
									} catch (error) {
										publishError = error instanceof Error ? error.message : String(error);
									}
								}
							}
							if (activeCharter.release.deploy_targets.length > 0) {
								if (!this.deps.releaseExecutor?.deploy) {
									for (const target of activeCharter.release.deploy_targets) {
										reportedDeploys.push({ target, error: "Deploy unavailable" });
									}
								} else {
									for (const target of activeCharter.release.deploy_targets) {
										try {
											const depRes = await this.deps.releaseExecutor.deploy(target);
											if (depRes && typeof depRes === "object" && "id" in depRes && depRes.id) {
												reportedDeploys.push({ target, id: String(depRes.id) });
											} else {
												reportedDeploys.push({ target, error: "Missing id" });
											}
										} catch (error) {
											reportedDeploys.push({
												target,
												error: error instanceof Error ? error.message : String(error),
											});
										}
									}
								}
							}
						}

						const commitRequired = Boolean(activeCharter?.git.commit);
						const pushRequired = Boolean(activeCharter?.git.push);
						const needsDeliveryProof =
							(commitRequired && commitError === undefined && reportedCommitSha !== undefined) ||
							(pushRequired && pushError === undefined && reportedPushRef !== undefined);
						let observation: DeliveryProofObservation | undefined;
						if (needsDeliveryProof && this.deps.gitExecutor?.proveDelivery) {
							try {
								observation = await this.deps.gitExecutor.proveDelivery({
									candidateDigest: candidateSnapshot?.digest ?? diffDigest,
									candidateRevision: candidateSnapshot?.candidateRevision ?? sourceRevision,
									candidateUntrackedPaths: candidateSnapshot?.untracked.map((file) => file.path) ?? [],
									remote: reportedPushRemote,
									ref: reportedPushRef,
								});
							} catch (error) {
								const message = error instanceof Error ? error.message : String(error);
								if (commitRequired && commitError === undefined) commitError = message;
								if (pushRequired && pushError === undefined) pushError = message;
							}
						}
						const provenReceipts = proveCommitAndPush({
							commitRequired,
							pushRequired,
							reportedCommitSha,
							commitError,
							reportedPushRef,
							reportedPushRemote,
							pushError,
							observation,
						});
						if (provenReceipts.commit) sideEffects.commit = provenReceipts.commit;
						if (provenReceipts.push) sideEffects.push = provenReceipts.push;
						if (activeCharter?.git.create_tag) {
							let tagObservation: TagProofObservation | undefined;
							if (reportedTag && tagError === undefined && this.deps.gitExecutor?.proveTag) {
								try {
									tagObservation = await this.deps.gitExecutor.proveTag(reportedTag);
								} catch (error) {
									tagError = error instanceof Error ? error.message : String(error);
								}
							}
							const provenCommitSha =
								sideEffects.commit?.state === "proven" ? sideEffects.commit.detail.sha : undefined;
							sideEffects.tag = proveTagReceipt({
								reportedTag,
								tagError,
								commitSha: provenCommitSha,
								observation: tagObservation,
							});
						}
						if (activeCharter?.release.package_publish) {
							let publishObservation: PublishProofObservation | undefined;
							if (
								reportedPublicationId &&
								publishError === undefined &&
								this.deps.releaseExecutor?.provePublish
							) {
								try {
									publishObservation = await this.deps.releaseExecutor.provePublish(reportedPublicationId);
								} catch (error) {
									publishError = error instanceof Error ? error.message : String(error);
								}
							}
							sideEffects.publish = provePublishReceipt({
								reportedId: reportedPublicationId,
								error: publishError,
								observation: publishObservation,
							});
						}
						if (reportedDeploys.length > 0) {
							sideEffects.deploy = [];
							for (const deployment of reportedDeploys) {
								let observation: DeployProofObservation | undefined;
								let error = deployment.error;
								if (deployment.id && error === undefined && this.deps.releaseExecutor?.proveDeploy) {
									try {
										observation = await this.deps.releaseExecutor.proveDeploy(deployment.target);
									} catch (caught) {
										error = caught instanceof Error ? caught.message : String(caught);
									}
								}
								sideEffects.deploy.push(
									proveDeployReceipt({
										target: deployment.target,
										reportedId: deployment.id,
										error,
										observation,
									}),
								);
							}
						}

						const requiredReceiptFailed =
							sideEffects.commit?.state === "failed" ||
							sideEffects.tag?.state === "failed" ||
							sideEffects.push?.state === "failed" ||
							sideEffects.publish?.state === "failed" ||
							(sideEffects.deploy ?? []).some((receipt) => receipt.state === "failed");

						const bundleBase =
							evalResult.deliveryBundle ?? (await this.buildBundle(objectiveId, "complete", runtime));
						const commitDetail = sideEffectSucceeded(sideEffects.commit) ? sideEffects.commit.detail : undefined;
						const pushDetail = sideEffectSucceeded(sideEffects.push) ? sideEffects.push.detail : undefined;
						const terminalStatus: DeliveryTerminalStatus = requiredReceiptFailed ? "unrecoverable" : "complete";
						let enrichedBundle = buildDeliveryBundle({
							objectiveId,
							terminalStatus,
							sourceRevision: candidateSnapshot?.candidateRevision ?? bundleBase.source_revision,
							diffDigest: candidateSnapshot?.digest ?? bundleBase.diff_digest,
							acceptance: bundleBase.acceptance,
							verification: bundleBase.verification,
							limitations: bundleBase.limitations,
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
							return {
								status: "unrecoverable",
								reasonCodes: ["delivery_side_effect_failed"],
								cycleCount: this.cycleCounter,
								deliveryBundle: enrichedBundle,
							};
						}

						if (this.deps.steeringPlane) {
							const c27 = await this.deps.steeringPlane.requireCertificate(
								"JEV-027",
								{
									...enrichedBundle,
									candidateSnapshot: snapshotIdentity,
								},
								{
									objectiveId,
									evidenceRevision,
									signal,
								},
							);
							steeringCertRefs.push(c27.certificate_id);
							if (c27.semantic_outcome !== "pass") {
								enrichedBundle = buildDeliveryBundle({
									...enrichedBundle,
									objectiveId,
									terminalStatus: "unrecoverable",
									sourceRevision: enrichedBundle.source_revision,
									sideEffects,
									steeringCertificateRefs: steeringCertRefs,
									failedGates: ["delivery_certificate_rejected", ...(c27.failed_semantic_predicates ?? [])],
								});
								return {
									status: "unrecoverable",
									reasonCodes: ["delivery_certificate_rejected"],
									cycleCount: this.cycleCounter,
									deliveryBundle: enrichedBundle,
								};
							}
							enrichedBundle = buildDeliveryBundle({
								objectiveId,
								terminalStatus: "complete",
								sourceRevision: enrichedBundle.source_revision,
								acceptance: enrichedBundle.acceptance,
								verification: enrichedBundle.verification,
								artifacts: enrichedBundle.artifacts,
								limitations: enrichedBundle.limitations,
								diffDigest: enrichedBundle.diff_digest,
								finalCommit: enrichedBundle.final_commit,
								pushRefs: enrichedBundle.push_refs,
								sideEffects,
								candidateSnapshot: snapshotIdentity,
								steeringCertificateRefs: steeringCertRefs,
								assuranceProfileRequested: enrichedBundle.assurance_profile_requested,
								assuranceProfileUsed: enrichedBundle.assurance_profile_used,
								decisionRefs: enrichedBundle.decision_refs,
								reviewerRefs: enrichedBundle.reviewer_refs,
							});
						}

						await this._recordCompletionOutcomes(objectiveId, route, { verificationPassed: true });

						if (this.deps.systemOne?.commitTerminalCompletion) {
							try {
								await this.deps.systemOne.commitTerminalCompletion(
									{
										objectiveId,
										candidateDigest: candidateSnapshot?.digest ?? diffDigest,
										deliveryCertificateId: steeringCertRefs[steeringCertRefs.length - 1],
										finalCommit: enrichedBundle.final_commit,
										pushRefs: enrichedBundle.push_refs,
									},
									{ signal },
								);
							} catch (error) {
								if (!(error instanceof TerminalCompletionConflictError)) throw error;
								const rejected = await this.buildBundle(objectiveId, "unrecoverable", runtime, {
									reasonCodes: ["terminal_completion_rejected", error.reason],
								});
								return {
									status: "unrecoverable",
									reasonCodes: ["terminal_completion_rejected", error.reason],
									cycleCount: this.cycleCounter,
									deliveryBundle: rejected,
								};
							}
						}

						return {
							status: "complete",
							reasonCodes: ["completion_passed"],
							completionDecisionId: evalResult.semanticRefs?.[0],
							cycleCount: this.cycleCounter,
							deliveryBundle: enrichedBundle,
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
					return {
						...terminal,
						cycleCount: this.cycleCounter,
						deliveryBundle: bundle,
					};
				}

				case "wait_for_worker":
				case "wait_for_tool":
					if (!this.deps.waiter?.wait) {
						const bundle = await this.buildBundle(objectiveId, "unrecoverable", runtime);
						return {
							status: "unrecoverable",
							reasonCodes: ["missing_required_executor:waiter"],
							cycleCount: this.cycleCounter,
							deliveryBundle: bundle,
						};
					}
					await this.deps.waiter.wait(route, signal);
					break;
			}

			await this.deps.checkpoints?.recordRouteOutcome?.(route, this._lastExecutor ?? route.route);
			this._lastExecutor = undefined;

			// 6. Ingest evidence & validate postflight
			await this.deps.evidence?.ingestLatest?.(objectiveId);
			await this.deps.systemOne?.validateObjectivePostflight?.(objectiveId);

			// RCG-042: task postflight project rules. A blocking violation queues repair work and
			// stops this cycle rather than letting the objective advance past it.
			if (this.deps.projectRules) {
				const postflightState = await this._resolveCanonicalEvidenceState(objectiveId, runtime);
				const postflight = await this.deps.projectRules.validateTaskPostflight({
					objectiveId,
					taskId: route.task_id ?? objectiveId,
					changedFiles: postflightState.artifacts.map((artifact) => artifact.path),
					signal,
				});
				if (ruleViolationBlocks(postflight)) {
					if (this.deps.runtime.ensureRepairTasks) {
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
					continue;
				}
			}

			// 7. Stall evaluation
			let stall: StallEvaluation;
			if (this.deps.stalls) {
				stall = await this.deps.stalls.evaluate(objectiveId);
			} else {
				stall = this.defaultStallDetector.evaluate({
					currentRevision: this.cycleCounter,
					isWaiting: route.route === "wait_for_worker" || route.route === "wait_for_tool",
				});
			}

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
		// The root executes what System One did not hand to an independent worker: a review and an
		// escalation always go to a worker, so does a verification that must be independent.
		if (
			this.deps.rootExecutor &&
			!escalated &&
			route.route !== "review" &&
			!route.reason_codes.includes("independent_verification_required")
		) {
			this._lastExecutor = "root";
			await this.deps.rootExecutor.execute(route, signal);
			return undefined;
		}
		this._lastExecutor = escalated ? "worker:escalated" : "worker";
		const dispatcher = escalated
			? this.deps.workerDispatcher?.dispatchEscalated
			: this.deps.workerDispatcher?.dispatch;
		const missingCode = escalated
			? "missing_required_executor:workerDispatcher.dispatchEscalated"
			: "missing_required_executor:workerDispatcher.dispatch";

		if (!dispatcher) {
			const bundle = await this.buildBundle(objectiveId, "unrecoverable", runtime);
			return {
				status: "unrecoverable",
				reasonCodes: [missingCode],
				cycleCount: this.cycleCounter,
				deliveryBundle: bundle,
			};
		}

		let binding: ExpertBinding | undefined;
		let selectionResult: ExpertSelectionResult | undefined;
		const taskId = `${objectiveId}-${escalated ? "escalate" : route.route}-${this.cycleCounter}`;
		if (this.deps.expertSelector) {
			const priorAttempts = Object.values(runtime.attempts);
			const consequence = escalated
				? "critical"
				: route.route === "verify" || route.route === "review"
					? "high"
					: "medium";
			const request = buildWorkerCapabilityRequest({
				objectiveId,
				taskId,
				route,
				consequence,
				decisionSignals: escalated ? { capabilityEscalationRequired: true } : undefined,
				priorAttempts,
			});
			try {
				selectionResult = await this.deps.expertSelector.select(request, { signal });
				binding = selectionResult.primary;
				this._lastBinding = binding;
				this.attemptBindings.set(taskId, { binding, route });
			} catch (error) {
				if (error instanceof NoEligibleExpertError) {
					const bundle = await this.buildBundle(objectiveId, "unrecoverable", runtime, {
						reasonCodes: ["no_eligible_expert", ...error.rejectedCandidates.flatMap((r) => r.reasonCodes)],
					});
					return {
						status: "unrecoverable",
						reasonCodes: ["no_eligible_expert"],
						cycleCount: this.cycleCounter,
						deliveryBundle: bundle,
					};
				}
				throw error;
			}
		}

		// FC-040: Pre-implementation responsibility guard before material write
		let responsibilityStatement: ResponsibilityStatement | undefined;
		if (route.route === "implement" && this.deps.responsibilityController) {
			responsibilityStatement = {
				statement: `Implementation for ${objectiveId} (${route.route})`,
				targetLocation: `packages/coding-agent/src/core/${objectiveId}`,
			};
			await this.deps.responsibilityController.preImplementation({
				objectiveId,
				taskId,
				proposed: responsibilityStatement,
				signal,
			});
		}

		try {
			await dispatcher(route, signal, binding);

			// FC-041: Post-mutation responsibility guard before task acceptance
			if (route.route === "implement" && this.deps.responsibilityController && responsibilityStatement) {
				const artifacts = (await this.deps.runtime.getArtifacts?.(objectiveId)) ?? [];
				const changedFiles =
					artifacts.length > 0 ? artifacts.map((a) => a.path) : [responsibilityStatement.targetLocation];
				for (const mutatedFile of changedFiles) {
					const postVerdict = await this.deps.responsibilityController.postMutation({
						objectiveId,
						taskId,
						responsibility: responsibilityStatement,
						mutatedFile,
						signal,
					});
					if (postVerdict.unintentionalDuplicate) {
						if (this.deps.runtime.ensureRepairTasks) {
							const repairs = completionFailuresToRepairWork(
								[{ gate_id: "duplicate_responsibility_detected" }],
								objectiveId,
							);
							await this.deps.runtime.ensureRepairTasks(objectiveId, repairs);
						}
						throw new Error(`Semantic duplicate responsibility detected in ${mutatedFile} (FC-041)`);
					}
				}
			}
		} finally {
			if (selectionResult && this.deps.expertSelector) {
				this.deps.expertSelector.release(selectionResult);
			}
		}
		return undefined;
	}

	async enforcePostflightCertificates(
		first: string | ObjectiveRoute | { route: string },
		second?: string | ObjectiveRoute | { route: string },
		signal?: AbortSignal,
	): Promise<void> {
		let objectiveId: string;
		let route: ObjectiveRoute;
		if (typeof first === "string") {
			objectiveId = first;
			route = typeof second === "string" ? ({ route: second } as ObjectiveRoute) : (second as ObjectiveRoute);
		} else {
			route = first as ObjectiveRoute;
			objectiveId = second as string;
		}
		const rawRuntime = this.deps.runtime as any;
		const runtime: TaskRuntimeProjection =
			rawRuntime?.objectives && rawRuntime?.tasks
				? (rawRuntime as TaskRuntimeProjection)
				: await this.deps.runtime.reconcileObjective(objectiveId);
		await this._runObjectivePostflight(objectiveId, route, runtime, signal);
	}

	private async _runObjectivePostflight(
		objectiveId: string,
		route: ObjectiveRoute,
		runtime: TaskRuntimeProjection,
		signal?: AbortSignal,
	): Promise<void> {
		if (!this.deps.steeringPlane) return;

		const { evidenceRevision, artifacts, verificationMatrix } = await this._resolveCanonicalEvidenceState(
			objectiveId,
			runtime,
		);
		const taskId = `${objectiveId}-${route.route}-${this.cycleCounter}`;
		const changedFiles = artifacts.map((a) => a.path);
		const objRecord = runtime?.objectives?.[objectiveId];

		try {
			// FC-050: JEV-017 worker claim support
			await this.deps.steeringPlane.requireCertificate(
				"JEV-017",
				{
					objectiveId,
					taskId,
					route: route.route,
					workerRole: this._lastBinding?.role ?? "implementer",
					claims: ["work_completed", "progress_reported"],
				},
				{ objectiveId, taskId, evidenceRevision, signal },
			);

			// PRC-050, PRC-051: JEV-018 raw proof state (no asserted patchFit: true)
			if (route.route === "implement") {
				await this.deps.steeringPlane.requireCertificate(
					"JEV-018",
					{
						objectiveId,
						taskId,
						changedFiles,
						artifacts,
						requirements:
							objRecord?.objective?.acceptanceCriteria?.map((ac: any) => ac.text ?? ac.description) ?? [],
					},
					{ objectiveId, taskId, evidenceRevision, signal },
				);
			}

			// PRC-050, PRC-051: JEV-019 raw proof state (no asserted causalityVerified: true)
			const isBugFix = Boolean(
				objectiveId.toLowerCase().includes("bug") ||
					(objRecord?.objective?.description?.toLowerCase().includes("bug") ?? false),
			);
			if (isBugFix) {
				await this.deps.steeringPlane.requireCertificate(
					"JEV-019",
					{
						objectiveId,
						taskId,
						bugFix: true,
						changedFiles,
						reproducerResults: (objRecord?.evidence ?? []).filter((e) => e.kind === "test"),
						verificationMatrix,
					},
					{ objectiveId, taskId, evidenceRevision, signal },
				);
			}

			// PRC-050, PRC-051: JEV-020 raw proof state (no asserted architectureFit: true)
			const isArchitectureChange = Boolean(
				route.route === "implement" &&
					(objectiveId.toLowerCase().includes("refactor") ||
						changedFiles.some((f) => f.includes("architecture") || f.includes("core"))),
			);
			if (isArchitectureChange) {
				await this.deps.steeringPlane.requireCertificate(
					"JEV-020",
					{
						objectiveId,
						taskId,
						changedFiles,
						modulesAffected: changedFiles.map((f) => f.split("/")[0] || f),
						boundaries: ["core", "orchestration", "adaptive", "steering"],
					},
					{ objectiveId, taskId, evidenceRevision, signal },
				);
			}

			// PRC-050, PRC-051: JEV-022 raw proof state (no asserted verificationRelevance: true)
			if (route.route === "verify") {
				await this.deps.steeringPlane.requireCertificate(
					"JEV-022",
					{
						objectiveId,
						taskId,
						verificationMatrix,
						acceptanceCriteria:
							objRecord?.objective?.acceptanceCriteria?.map((ac: any) => ac.text ?? ac.description) ?? [],
					},
					{ objectiveId, taskId, evidenceRevision, signal },
				);
			}

			// PRC-050, PRC-051: JEV-023 raw proof state (no asserted repairAdequate: true)
			const isRepair = Boolean(
				route.route === "replan" || Object.keys(runtime.tasks).some((tid) => tid.includes("repair")),
			);
			if (isRepair) {
				await this.deps.steeringPlane.requireCertificate(
					"JEV-023",
					{
						objectiveId,
						taskId,
						repairWork: Object.keys(runtime.tasks).filter((tid) => tid.includes("repair")),
						changedFiles,
						failedGates: (objRecord as any)?.failedGates ?? [],
					},
					{ objectiveId, taskId, evidenceRevision, signal },
				);
			}

			// FC-056: JEV-005 semantic progress
			await this.deps.steeringPlane.requireCertificate(
				"JEV-005",
				{ objectiveId, cycleCount: this.cycleCounter },
				{ objectiveId, taskId, evidenceRevision, signal },
			);

			// FC-057: JEV-006 repetition
			await this.deps.steeringPlane.requireCertificate(
				"JEV-006",
				{ objectiveId, strategy: route.route },
				{ objectiveId, taskId, evidenceRevision, signal },
			);
		} catch (err) {
			if (this.deps.steeringPlane.policy.mode === "system_one_required") {
				throw err;
			}
		}
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
		const canonicalRevision =
			((await this.deps.evidence?.reconcile)
				? (this.deps.evidence as any)?.getEvidenceRevision?.(objectiveId)
				: undefined) ?? (await (this.deps.runtime as any)?.getEvidenceRevision?.(objectiveId));
		const evidenceRevision =
			typeof canonicalRevision === "number"
				? canonicalRevision
				: objRecord?.evidence && objRecord.evidence.length > 0
					? objRecord.evidence.length
					: 1;
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
		const specTask = runtime?.createTask?.({
			objectiveId,
			title: specialist.spec.mission,
			description: specialist.spec.purpose,
			role: specialist.spec.authority_role,
		}) ?? { taskId: specTaskId };
		const specGrantId = `grant-${specTaskId}`;
		const specAttempt = runtime?.queueAttempt?.(
			specTask.taskId,
			{
				taskId: specTask.taskId,
				profileId: specialist.profileId,
				instructions: specialist.spec.mission,
				resourcePointerIds: [],
			},
			specGrantId,
		) ?? { attemptId: `att-${specTaskId}` };
		(specAttempt as any).profileId = specialist.profileId;
		const specLease = runtime?.leaseAttempt?.(specAttempt.attemptId, `owner-spec-${specialist.specialistId}`, 60000);
		if (specLease) {
			runtime?.startAttempt?.(specAttempt.attemptId, specLease.leaseId, specLease.fencingToken);
		}

		let workerResult: WorkerResultContract | undefined;
		if (this.deps.workerDispatcher?.dispatchSpecialist) {
			workerResult = await this.deps.workerDispatcher.dispatchSpecialist({
				specialist,
				taskId: specTask.taskId,
				attemptId: specAttempt.attemptId,
				leaseId: specLease?.leaseId,
				fencingToken: specLease?.fencingToken,
				expiresAt: specLease?.expiresAt,
				signal,
			});
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
			const aligned: WorkerResultContract = {
				...workerResult,
				objectiveId,
				taskId: specTask.taskId,
				attemptId: specAttempt.attemptId,
				leaseId: specLease?.leaseId ?? workerResult.leaseId,
				fencingToken: specLease?.fencingToken ?? workerResult.fencingToken,
			};
			runtime?.finishAttempt?.(aligned);

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
			if (this.deps.systemOne?.recordHostEvidence) {
				await this.deps.systemOne.recordHostEvidence(normalizedEvidence);
			}

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
