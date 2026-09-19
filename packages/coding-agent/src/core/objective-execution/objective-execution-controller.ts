/**
 * Objective Execution Controller.
 * Deterministic loop owner for objective continuation, semantic routing, and completion gating.
 * Conforms to ROUTING_PROGRAM.md, COMPLETION_COORDINATOR.md, HUMAN_EDGE.md, and FINAL_PATCH_SPEC v2.1.
 */

import { randomUUID } from "node:crypto";
import type { AuthorityEnvelope, ProposedAction } from "../autonomy/authority-envelope.ts";
import {
	compileExecutionCharter,
	DurableAuthorityBlockLedger,
	type ExecutionCharter,
	evaluateCharterAuthority,
} from "../autonomy/execution-charter.ts";
import { DurableHumanEdgeLedger, type HumanEdgeRequest, requiresHumanEdge } from "../autonomy/human-edge.ts";
import { DecisionActionPolicy } from "../decision/action-policy.ts";
import type { DecisionEngineRouter } from "../decision/engine-router.ts";
import type { CompletionAssuranceProfile } from "../decision/policy.ts";
import { createDecisionProgram } from "../decision/program.ts";
import type {
	ExpertBinding,
	ExpertOutcomeRecorder,
	ExpertSelectionResult,
	ExpertSelectionService,
} from "../expert-routing/index.ts";
import { buildWorkerCapabilityRequest, NoEligibleExpertError } from "../expert-routing/index.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import type { FinalCompletionVerdict } from "../system-one/policy.ts";
import {
	CompletionCoordinator,
	type CompletionEvaluationContext,
	type IndependentReviewerVerdict,
} from "./completion-coordinator.ts";
import {
	buildDeliveryBundle,
	type DeliveryArtifact,
	type DeliveryBundle,
	type DeliveryTerminalStatus,
} from "./delivery-bundle.ts";
import { completionFailuresToRepairWork, type RepairWork } from "./objective-repair-work.ts";
import {
	type ObjectiveRoute,
	type ObjectiveRouteName,
	type ObjectiveTerminalResult,
	routeToTerminal,
	validateObjectiveRoute,
} from "./objective-route.ts";
import { composeObjectiveRoute } from "./objective-route-policy.ts";
import { projectBoundedCombinedState, type SemanticRouteJudgments } from "./objective-route-projector.ts";
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
		evaluateObjectiveRoute?(objectiveId: string, options?: { signal?: AbortSignal }): Promise<SemanticRouteJudgments>;
		executeCompletionTransaction?(
			isBugFix: boolean,
			options?: { signal?: AbortSignal },
		): Promise<FinalCompletionVerdict>;
		validateObjectivePostflight?(objectiveId: string): Promise<void>;
		recordHostEvidence?(evidence: unknown): Promise<void>;
	};
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
	};
	expertSelector?: ExpertSelectionService;
	outcomeRecorder?: ExpertOutcomeRecorder;
	mode?: ExecutionLoopMode;
	executionCharter?: ExecutionCharter;
	authorityBlockLedger?: DurableAuthorityBlockLedger;
	gitExecutor?: {
		commit?(): Promise<void>;
		push?(): Promise<void>;
	};
	releaseExecutor?: {
		publish?(): Promise<void>;
		deploy?(target: string): Promise<void>;
	};
	onDisagreementTelemetry?(event: DisagreementTelemetryEvent): void;
	onHumanEdgeRequest?(request: HumanEdgeRequest): Promise<boolean> | boolean;
	getRouteProposedAction?(route: ObjectiveRoute): ProposedAction;
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

export class ObjectiveExecutionController {
	private readonly deps: ObjectiveExecutionControllerDeps;
	private readonly defaultStallDetector: ObjectiveStallDetector;
	private readonly humanEdgeLedger: DurableHumanEdgeLedger;
	private readonly authorityBlockLedger: DurableAuthorityBlockLedger;
	private readonly attemptBindings = new Map<string, { binding: ExpertBinding; route: ObjectiveRoute }>();
	private cycleCounter = 0;
	private _lastBinding?: ExpertBinding;

	constructor(deps: ObjectiveExecutionControllerDeps) {
		this.deps = deps;
		this.defaultStallDetector = new ObjectiveStallDetector();
		this.humanEdgeLedger = deps.humanEdgeLedger ?? new DurableHumanEdgeLedger();
		this.authorityBlockLedger = deps.authorityBlockLedger ?? new DurableAuthorityBlockLedger();
	}

	getMode(): ExecutionLoopMode {
		return this.deps.mode ?? "objective_shadow";
	}

	getHumanEdgeLedger(): DurableHumanEdgeLedger {
		return this.humanEdgeLedger;
	}

	getAuthorityBlockLedger(): DurableAuthorityBlockLedger {
		return this.authorityBlockLedger;
	}

	async evaluateRouteOnce(
		objectiveId: string,
		options?: { signal?: AbortSignal; legacyActionHint?: string },
	): Promise<ObjectiveRoute> {
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

		// Evaluate semantic route via Decision Kernel (FIN-050: no direct provider-specific route branch)
		let semantic: SemanticRouteJudgments = {};

		if (this.deps.decisions) {
			try {
				// FIN-034: Use bounded combined state projection
				const stateProjection = projectBoundedCombinedState(objectiveId, runtime, {
					stallTurns: stall.stallTurns,
					strategyFingerprint: stall.fingerprint,
				});

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
			} catch {
				// Fallback to deterministic route policy
			}
		} else if (this.deps.systemOne?.evaluateObjectiveRoute) {
			try {
				semantic = await this.deps.systemOne.evaluateObjectiveRoute(objectiveId, { signal: options?.signal });
			} catch {
				// Fallback to deterministic rule set
			}
		}

		const route = composeObjectiveRoute({
			cycleId,
			objectiveId,
			cancelled,
			budgetExhausted,
			requiredWorkerInFlight,
			strategyRepetition: stall.repeatedWithoutNewEvidence,
			semantic,
		});

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
		while (true) {
			signal?.throwIfAborted();

			const runtime = await this.deps.runtime.reconcileObjective(objectiveId);

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

			// 4. Authority Envelope / Execution Charter gate (FIN-070..FIN-074, ZH-001..ZH-012)
			const proposedAction = this.deps.getRouteProposedAction
				? this.deps.getRouteProposedAction(route)
				: { kind: route.route };

			const charter =
				this.deps.executionCharter ??
				(this.getMode() === "start_only" ? compileExecutionCharter({ objectiveId }) : undefined);
			const isStartOnly = charter?.interaction_mode === "start_only" || this.getMode() === "start_only";

			if (isStartOnly && charter) {
				const charterDecision = evaluateCharterAuthority(charter, proposedAction);
				if (charterDecision.outcome === "deny") {
					this.authorityBlockLedger.recordBlock({
						objectiveId,
						action: proposedAction.kind,
						missingAuthority: charterDecision.missingAuthority,
						alternativesAttempted: ["replan"],
					});
					const bundle = await this.buildBundle(objectiveId, "unrecoverable", runtime, {
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
					break;

				case "escalate_capability": {
					const failure = await this._dispatchWithExpertSelection(objectiveId, route, runtime, true, signal);
					if (failure) return failure;
					break;
				}

				case "completion_candidate": {
					// FIN-060: Single completion owner via CompletionCoordinator
					const profile = this.deps.completionProfile ?? "semantic_enhanced";

					const completionContext: CompletionEvaluationContext = {
						runtime,
						getSourceRevision: this.deps.runtime.getSourceRevision?.bind(this.deps.runtime),
						getArtifacts: this.deps.runtime.getArtifacts?.bind(this.deps.runtime),
						getLimitations: this.deps.runtime.getLimitations?.bind(this.deps.runtime),
						reviewer: this.deps.reviewer,
						semanticEvaluator: this.deps.systemOne?.executeCompletionTransaction
							? {
									evaluateCompletion: async (_objId, opts) => {
										const verdict = await this.deps.systemOne!.executeCompletionTransaction!(false, opts);
										return {
											passed: verdict.verdict === "complete",
											decisionRef: (verdict as { decision_id?: string }).decision_id,
											failedGates: verdict.failed_gates.map((g) => g.id),
										};
									},
								}
							: undefined,
						hasCalibratedEngine: () => {
							const candidate = this.deps.decisions?.select(ROUTE_DECISION_PROGRAM, "critical");
							return (
								candidate?.capabilities().confidenceProvenance === "native_calibrated" ||
								Boolean(this.deps.systemOne?.executeCompletionTransaction)
							);
						},
					};

					const evalResult = await CompletionCoordinator.evaluate(objectiveId, profile, completionContext, {
						signal,
					});

					if (evalResult.verdict === "complete") {
						await this._recordCompletionOutcomes(objectiveId, route, { verificationPassed: true });

						const activeCharter =
							this.deps.executionCharter ??
							(this.getMode() === "start_only" ? compileExecutionCharter({ objectiveId }) : undefined);
						if (activeCharter) {
							if (activeCharter.git.commit && this.deps.gitExecutor?.commit) {
								await this.deps.gitExecutor.commit();
							}
							if (activeCharter.git.push && this.deps.gitExecutor?.push) {
								await this.deps.gitExecutor.push();
							}
							if (activeCharter.release.package_publish && this.deps.releaseExecutor?.publish) {
								await this.deps.releaseExecutor.publish();
							}
							if (activeCharter.release.deploy_targets.length > 0 && this.deps.releaseExecutor?.deploy) {
								for (const target of activeCharter.release.deploy_targets) {
									await this.deps.releaseExecutor.deploy(target);
								}
							}
						}

						return {
							status: "complete",
							reasonCodes: ["completion_passed"],
							completionDecisionId: evalResult.semanticRefs?.[0],
							cycleCount: this.cycleCounter,
							deliveryBundle: evalResult.deliveryBundle,
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

			// 6. Ingest evidence & validate postflight
			await this.deps.evidence?.ingestLatest?.(objectiveId);
			await this.deps.systemOne?.validateObjectivePostflight?.(objectiveId);

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
		if (this.deps.expertSelector) {
			const priorAttempts = Object.values(runtime.attempts);
			const consequence = escalated
				? "critical"
				: route.route === "verify" || route.route === "review"
					? "high"
					: "medium";
			const taskId = `${objectiveId}-${escalated ? "escalate" : route.route}-${this.cycleCounter}`;
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

		try {
			await dispatcher(route, signal, binding);
		} finally {
			if (selectionResult && this.deps.expertSelector) {
				this.deps.expertSelector.release(selectionResult);
			}
		}
		return undefined;
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
}
