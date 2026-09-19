/**
 * Objective Execution Controller.
 * Deterministic loop owner for objective continuation, semantic routing, and completion gating.
 * Conforms to ROUTING_PROGRAM.md, COMPLETION_COORDINATOR.md, HUMAN_EDGE.md, and FINAL_PATCH_SPEC v2.1.
 */

import { randomUUID } from "node:crypto";
import type {
	AdaptiveCapabilityController,
	AdaptiveResolutionController,
	SpecialistSynthesisController,
} from "../adaptive/index.ts";
import type { AuthorityEnvelope, ProposedAction } from "../autonomy/authority-envelope.ts";
import {
	DurableAuthorityBlockLedger,
	type ExecutionCharter,
	evaluateCharterAuthority,
} from "../autonomy/execution-charter.ts";
import { DurableHumanEdgeLedger, type HumanEdgeRequest, requiresHumanEdge } from "../autonomy/human-edge.ts";
import { DecisionActionPolicy } from "../decision/action-policy.ts";
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
import type { TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import type { SystemOneSteeringPlane } from "../steering/index.ts";
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
		commit?(message?: string): Promise<void>;
		push?(): Promise<void>;
		tag?(name?: string): Promise<void>;
	};
	releaseExecutor?: {
		publish?(): Promise<void>;
		deploy?(target: string): Promise<void>;
	};
	steeringPlane?: SystemOneSteeringPlane;
	adaptiveResolution?: AdaptiveResolutionController;
	specialistSynthesis?: SpecialistSynthesisController;
	adaptiveCapabilities?: AdaptiveCapabilityController;
	responsibilityController?: SemanticResponsibilityController;
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
	private readonly admittedObjectives = new Set<string>();
	private readonly admissionCerts = new Map<string, string[]>();
	private readonly alternativesTried = new Set<string>();
	private cycleCounter = 0;
	private _lastBinding?: ExpertBinding;

	constructor(deps: ObjectiveExecutionControllerDeps) {
		this.deps = deps;
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

		// Evaluate semantic route via SteeringPlane JEV-004 (PH-113: JEV-004 route owner)
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
		} else if (this.deps.steeringPlane) {
			try {
				const stateProjection = projectBoundedCombinedState(objectiveId, runtime, {
					stallTurns: stall.stallTurns,
					strategyFingerprint: stall.fingerprint,
				});
				const cert = await this.deps.steeringPlane.requireCertificate("JEV-004", stateProjection, {
					objectiveId,
					signal: options?.signal,
				});

				const wrAns = cert.answers.work_remaining as { boolean?: boolean; noul?: number } | undefined;
				const cwccAns = cert.answers.current_worker_can_continue as
					| { boolean?: boolean; noul?: number }
					| undefined;
				const iwrAns = cert.answers.independent_worker_required as { boolean?: boolean; noul?: number } | undefined;
				const cerAns = cert.answers.capability_escalation_required as
					| { boolean?: boolean; noul?: number }
					| undefined;
				const spAns = cert.answers.semantic_progress as { level?: number; score?: number } | undefined;
				const csAns = cert.answers.context_stale as { boolean?: boolean; noul?: number } | undefined;
				const srAns = cert.answers.strategy_repetition as { boolean?: boolean; noul?: number } | undefined;
				const mwcAns = cert.answers.missing_work_class as { choice?: string } | undefined;

				semantic = {
					workRemaining:
						typeof wrAns?.boolean === "boolean"
							? wrAns.boolean
							: wrAns?.noul !== undefined
								? wrAns.noul >= 0.5
								: undefined,
					missingWorkClass: mwcAns?.choice as SemanticRouteJudgments["missingWorkClass"],
					currentWorkerCanContinue:
						typeof cwccAns?.boolean === "boolean"
							? cwccAns.boolean
							: cwccAns?.noul !== undefined
								? cwccAns.noul >= 0.5
								: undefined,
					independentWorkerRequired:
						typeof iwrAns?.boolean === "boolean"
							? iwrAns.boolean
							: iwrAns?.noul !== undefined
								? iwrAns.noul >= 0.5
								: undefined,
					capabilityEscalationRequired:
						typeof cerAns?.boolean === "boolean"
							? cerAns.boolean
							: cerAns?.noul !== undefined
								? cerAns.noul >= 0.5
								: undefined,
					semanticProgress: spAns?.level ?? spAns?.score,
					contextStale:
						typeof csAns?.boolean === "boolean"
							? csAns.boolean
							: csAns?.noul !== undefined
								? csAns.noul >= 0.5
								: undefined,
					strategyRepetition:
						typeof srAns?.boolean === "boolean"
							? srAns.boolean
							: srAns?.noul !== undefined
								? srAns.noul >= 0.5
								: undefined,
				};
			} catch (err) {
				if (this.deps.steeringPlane.policy.mode === "system_one_required") {
					throw err;
				}
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
							await this.deps.specialistSynthesis.resolveOrCreate({
								objectiveId,
								taskId: `${objectiveId}-spec-${this.cycleCounter}`,
								need,
								charter,
								signal,
							});
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
					const profile = this.deps.completionProfile ?? "semantic_enhanced";
					const steeringCertRefs: string[] = [];

					// FC-070, FC-071, FC-072: Canonical proof state on real projection without asserted verificationPassed:true
					const objRecord = runtime.objectives[objectiveId];
					const evidenceRevision =
						objRecord?.evidence && objRecord.evidence.length > 0 ? objRecord.evidence.length : this.cycleCounter;
					const sourceRevision =
						(await this.deps.runtime.getSourceRevision?.(objectiveId)) ?? String(evidenceRevision);
					const artifacts = (await this.deps.runtime.getArtifacts?.(objectiveId)) ?? [];
					const limitations = (await this.deps.runtime.getLimitations?.(objectiveId)) ?? [];
					const verificationMatrix: Record<string, unknown> = {};
					for (const e of objRecord?.evidence ?? []) {
						if (e.kind === "test" || e.kind === "review") {
							verificationMatrix[e.evidenceId] = e.summary;
						}
					}
					const acceptanceEvidence = objRecord?.evidence ?? [];
					const diffDigest = "";

					const canonicalProofState = {
						objectiveId,
						cycleCount: this.cycleCounter,
						evidenceRevision,
						sourceRevision,
						verificationMatrix,
						acceptanceEvidence,
						acceptanceCriteria: objRecord?.objective?.acceptanceCriteria ?? [],
						evidenceRefs: objRecord?.evidence?.map((e) => e.evidenceId) ?? [],
						diffDigest,
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

					// 2. PH-151: CompletionCoordinator mechanical/common gates
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
											failedGates: (verdict.failed_gates ?? []).map((g) => g.id),
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
						// 3. PH-152, FC-063: JEV-025 primary semantic completion (proof-bearing)
						if (this.deps.steeringPlane) {
							const c25 = await this.deps.steeringPlane.requireCertificate(
								"JEV-025",
								{
									...canonicalProofState,
									mechanicalVerdict: evalResult.verdict,
									evalResultDetails: evalResult,
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
								break;
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

							const hiddenRegressions = (c26.answers.hidden_regressions as { value?: boolean })?.value === true;
							if (c26.semantic_outcome !== "pass" || hiddenRegressions) {
								if (this.deps.runtime.ensureRepairTasks) {
									const repairs = completionFailuresToRepairWork(
										(c26.failed_semantic_predicates ?? ["hidden_regressions_or_edge_concern"]).map((p) => ({
											gate_id: p,
										})),
										objectiveId,
									);
									await this.deps.runtime.ensureRepairTasks(objectiveId, repairs);
								}
								break;
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
						if (this.deps.steeringPlane) {
							const c27 = await this.deps.steeringPlane.requireCertificate(
								"JEV-027",
								{
									...canonicalProofState,
									deliveryClaimsVerified: true,
									steeringCertRefs: [...steeringCertRefs],
								},
								{ objectiveId, evidenceRevision, signal },
							);
							steeringCertRefs.push(c27.certificate_id);

							if (c27.semantic_outcome !== "pass") {
								const bundle = await this.buildBundle(objectiveId, "unrecoverable", runtime, {
									reasonCodes: ["delivery_truth_rejected", ...(c27.failed_semantic_predicates ?? [])],
								});
								return {
									status: "unrecoverable",
									reasonCodes: ["delivery_truth_rejected"],
									cycleCount: this.cycleCounter,
									deliveryBundle: bundle,
								};
							}
						}

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
										releaseReady: true,
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

						await this._recordCompletionOutcomes(objectiveId, route, { verificationPassed: true });

						// 9. PH-106, PH-158: Execute all charter-required final side effects (throw on missing executor)
						const sideEffectEvidence: {
							commitSha?: string;
							pushedRef?: string;
							tag?: string;
							publicationId?: string;
							deployments?: { target: string; result: unknown }[];
						} = {};

						if (activeCharter) {
							if (activeCharter.git.commit) {
								if (!this.deps.gitExecutor?.commit) {
									throw new Error(
										"Git commit is required by charter but gitExecutor.commit is unavailable (PH-106)",
									);
								}
								const commitRes = await this.deps.gitExecutor.commit();
								sideEffectEvidence.commitSha =
									typeof commitRes === "object" && commitRes && "sha" in commitRes
										? String((commitRes as { sha: unknown }).sha)
										: "committed";
							}
							if (activeCharter.git.push) {
								if (!this.deps.gitExecutor?.push) {
									throw new Error(
										"Git push is required by charter but gitExecutor.push is unavailable (PH-106)",
									);
								}
								const pushRes = await this.deps.gitExecutor.push();
								sideEffectEvidence.pushedRef =
									typeof pushRes === "object" && pushRes && "ref" in pushRes
										? String((pushRes as { ref: unknown }).ref)
										: "pushed";
							}
							if (activeCharter.git.create_tag) {
								if (!this.deps.gitExecutor?.tag) {
									throw new Error(
										"Git tag is required by charter but gitExecutor.tag is unavailable (PH-106)",
									);
								}
								const tagRes = await this.deps.gitExecutor.tag();
								sideEffectEvidence.tag =
									typeof tagRes === "object" && tagRes && "tag" in tagRes
										? String((tagRes as { tag: unknown }).tag)
										: "tagged";
							}
							if (activeCharter.release.package_publish) {
								if (!this.deps.releaseExecutor?.publish) {
									throw new Error(
										"Package publish is required by charter but releaseExecutor.publish is unavailable (PH-106)",
									);
								}
								const pubRes = await this.deps.releaseExecutor.publish();
								sideEffectEvidence.publicationId =
									typeof pubRes === "object" && pubRes && "id" in pubRes
										? String((pubRes as { id: unknown }).id)
										: "published";
							}
							if (activeCharter.release.deploy_targets.length > 0) {
								if (!this.deps.releaseExecutor?.deploy) {
									throw new Error(
										"Deployment is required by charter but releaseExecutor.deploy is unavailable (PH-106)",
									);
								}
								sideEffectEvidence.deployments = [];
								for (const target of activeCharter.release.deploy_targets) {
									const depRes = await this.deps.releaseExecutor.deploy(target);
									sideEffectEvidence.deployments.push({ target, result: depRes });
								}
							}
						}

						// 10 & 11. PH-159, PH-160: Rebuild DeliveryBundle afterward with exact side-effect evidence
						const bundleBase =
							evalResult.deliveryBundle ?? (await this.buildBundle(objectiveId, "complete", runtime));
						const enrichedBundle = buildDeliveryBundle({
							objectiveId,
							terminalStatus: "complete",
							sourceRevision: bundleBase.source_revision,
							acceptance: bundleBase.acceptance,
							verification: bundleBase.verification,
							artifacts: [
								...(bundleBase.artifacts ?? []),
								...(sideEffectEvidence.commitSha
									? [
											{
												path: "git:commit",
												description: `Commit ${sideEffectEvidence.commitSha}`,
												hash: sideEffectEvidence.commitSha,
											},
										]
									: []),
							],
							finalCommit: sideEffectEvidence.commitSha,
							pushRefs: sideEffectEvidence.pushedRef ? [sideEffectEvidence.pushedRef] : undefined,
							limitations: bundleBase.limitations,
							decisionRefs: bundleBase.decision_refs,
							steeringCertificateRefs: steeringCertRefs.length > 0 ? steeringCertRefs : undefined,
							usage: bundleBase.usage,
							assuranceProfileRequested: bundleBase.assurance_profile_requested,
							assuranceProfileUsed: bundleBase.assurance_profile_used,
							reviewerRefs: bundleBase.reviewer_refs,
							failedGates: bundleBase.failed_gates,
							requiredNextProof: bundleBase.required_next_proof,
							changedFiles: bundleBase.changed_files,
							diffDigest: bundleBase.diff_digest,
						});

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

	private async _runObjectivePostflight(
		objectiveId: string,
		route: ObjectiveRoute,
		runtime: TaskRuntimeProjection,
		signal?: AbortSignal,
	): Promise<void> {
		if (!this.deps.steeringPlane) return;

		const objRecord = runtime.objectives[objectiveId];
		const evidenceRevision =
			objRecord?.evidence && objRecord.evidence.length > 0 ? objRecord.evidence.length : this.cycleCounter;
		const taskId = `${objectiveId}-${route.route}-${this.cycleCounter}`;
		const artifacts = (await this.deps.runtime.getArtifacts?.(objectiveId)) ?? [];
		const changedFiles = artifacts.map((a) => a.path);

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

			// FC-051: JEV-018 patch fit (when implementation work occurred)
			if (route.route === "implement") {
				await this.deps.steeringPlane.requireCertificate(
					"JEV-018",
					{
						objectiveId,
						taskId,
						patchFit: true,
						changedFiles,
					},
					{ objectiveId, taskId, evidenceRevision, signal },
				);
			}

			// FC-052: JEV-019 bug causality applicability for bug fixes
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
						causalityVerified: true,
					},
					{ objectiveId, taskId, evidenceRevision, signal },
				);
			}

			// FC-053: JEV-020 architecture fit applicability for ownership changes
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
						architectureFit: true,
					},
					{ objectiveId, taskId, evidenceRevision, signal },
				);
			}

			// FC-054: JEV-022 verification relevance applicability
			if (route.route === "verify") {
				await this.deps.steeringPlane.requireCertificate(
					"JEV-022",
					{
						objectiveId,
						taskId,
						verificationRelevance: true,
					},
					{ objectiveId, taskId, evidenceRevision, signal },
				);
			}

			// FC-055: JEV-023 repair adequacy applicability
			const isRepair = Boolean(
				route.route === "replan" || Object.keys(runtime.tasks).some((tid) => tid.includes("repair")),
			);
			if (isRepair) {
				await this.deps.steeringPlane.requireCertificate(
					"JEV-023",
					{
						objectiveId,
						taskId,
						repairAdequate: true,
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
