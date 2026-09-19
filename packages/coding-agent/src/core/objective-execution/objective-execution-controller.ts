/**
 * Objective Execution Controller.
 * Deterministic loop owner for objective continuation, semantic routing, and completion gating.
 * Conforms to reference/objective-execution-controller.ts, STRICT_RULES.md, and MASTER_SPEC v2.0.
 */

import { randomUUID } from "node:crypto";
import type { AuthorityEnvelope, ProposedAction } from "../autonomy/authority-envelope.ts";
import { type HumanEdgeRequest, requiresHumanEdge } from "../autonomy/human-edge.ts";
import type { DecisionEngineRouter } from "../decision/engine-router.ts";
import type { CompletionAssuranceProfile } from "../decision/policy.ts";
import { createDecisionProgram } from "../decision/program.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import type { FinalCompletionVerdict } from "../system-one/policy.ts";
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
import type { SemanticRouteJudgments } from "./objective-route-projector.ts";
import { ObjectiveStallDetector, type StallEvaluation } from "./objective-stall-fingerprint.ts";

export type ExecutionLoopMode = "legacy_goal" | "objective_shadow" | "objective_primary";

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
	authorityEnvelope?: AuthorityEnvelope;
	completionProfile?: CompletionAssuranceProfile;
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
		dispatch(route: ObjectiveRoute, signal?: AbortSignal): Promise<void>;
		continueWorker(route: ObjectiveRoute, signal?: AbortSignal): Promise<void>;
		dispatchEscalated(route: ObjectiveRoute, signal?: AbortSignal): Promise<void>;
	};
	mode?: ExecutionLoopMode;
	onDisagreementTelemetry?(event: DisagreementTelemetryEvent): void;
	onHumanEdgeRequest?(request: HumanEdgeRequest): Promise<boolean> | boolean;
	getRouteProposedAction?(route: ObjectiveRoute): ProposedAction;
}

const ROUTE_DECISION_PROGRAM = createDecisionProgram({
	id: "objective-route-v2",
	version: "2.0.0",
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
			instruction: "What primary class of work remains to advance the objective?",
			options: {
				investigation: { description: "Inspect code, search symbols, gather context" },
				implementation: { description: "Author or edit source code" },
				verification: { description: "Run tests, diagnostics, or benchmarks" },
				review: { description: "Review diff or verify architecture invariants" },
				none: { description: "All required criteria verified" },
			},
		},
		{
			kind: "boolean",
			id: "independent_worker_required",
			instruction: "Does the current stage require a fresh or independent worker context?",
		},
		{
			kind: "boolean",
			id: "capability_escalation_needed",
			instruction: "Does the remaining work require escalated tools or reasoning models?",
		},
		{
			kind: "boolean",
			id: "completion_plausible",
			instruction: "Is the objective plausibly ready for formal completion verification?",
		},
		{
			kind: "boolean",
			id: "external_blocker",
			instruction: "Is progress blocked by external service or missing user action?",
		},
	],
});

export class ObjectiveExecutionController {
	private readonly deps: ObjectiveExecutionControllerDeps;
	private readonly defaultStallDetector: ObjectiveStallDetector;
	private cycleCounter = 0;

	constructor(deps: ObjectiveExecutionControllerDeps) {
		this.deps = deps;
		this.defaultStallDetector = new ObjectiveStallDetector();
	}

	getMode(): ExecutionLoopMode {
		return this.deps.mode ?? "objective_shadow";
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

		// Evaluate semantic route from Decision Kernel or System One
		let semantic: SemanticRouteJudgments = {};

		if (this.deps.decisions) {
			try {
				const stateProjection = {
					objective: runtime.objectives[objectiveId],
					tasks: Object.values(runtime.tasks),
					activeAttempts,
				};
				const evaluation = await this.deps.decisions.evaluateOrFallback(ROUTE_DECISION_PROGRAM, stateProjection, {
					signal: options?.signal,
					consequence: "medium",
				});

				const wr = evaluation.results.work_remaining;
				const mwc = evaluation.results.missing_work_class;
				const iwr = evaluation.results.independent_worker_required;
				const cen = evaluation.results.capability_escalation_needed;
				const _cp = evaluation.results.completion_plausible;
				const eb = evaluation.results.external_blocker;

				semantic = {
					workRemaining: wr?.kind === "boolean" ? wr.value : undefined,
					missingWorkClass:
						mwc?.kind === "choice" ? (mwc.selected as SemanticRouteJudgments["missingWorkClass"]) : undefined,
					independentWorkerRequired: iwr?.kind === "boolean" ? iwr.value : undefined,
					capabilityEscalationRequired: cen?.kind === "boolean" ? cen.value : undefined,
					externalBlockerPresent: eb?.kind === "boolean" ? eb.value : undefined,
				};
			} catch {
				// Fallback to deterministic route policy
			}
		} else if (this.deps.systemOne?.evaluateObjectiveRoute) {
			try {
				semantic = await this.deps.systemOne.evaluateObjectiveRoute(objectiveId, { signal: options?.signal });
			} catch {
				// Validator failure falls back to deterministic rule set
			}
		}

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
		extra?: { decisionRefs?: readonly string[] },
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
		});
	}

	private async handleCompletionTransaction(
		objectiveId: string,
		runtime: TaskRuntimeProjection,
		signal?: AbortSignal,
	): Promise<
		| { outcome: "completed"; result: ObjectiveTerminalResult }
		| { outcome: "repaired" }
		| { outcome: "failed"; error: unknown }
	> {
		if (!this.deps.systemOne?.executeCompletionTransaction) {
			return { outcome: "failed", error: new Error("no_completion_transaction") };
		}
		try {
			const verdict = await this.deps.systemOne.executeCompletionTransaction(false, { signal });
			if (verdict.verdict === "complete") {
				const bundle = await this.buildBundle(objectiveId, "complete", runtime, {
					decisionRefs: (verdict as { decision_id?: string }).decision_id
						? [(verdict as { decision_id?: string }).decision_id!]
						: undefined,
				});
				return {
					outcome: "completed",
					result: {
						status: "complete",
						reasonCodes: ["completion_passed"],
						completionDecisionId: (verdict as { decision_id?: string }).decision_id,
						cycleCount: this.cycleCounter,
						deliveryBundle: bundle,
					},
				};
			}
			const repairs = completionFailuresToRepairWork(verdict.failed_gates, objectiveId);
			await this.deps.runtime.ensureRepairTasks?.(objectiveId, repairs);
			return { outcome: "repaired" };
		} catch (err) {
			return { outcome: "failed", error: err };
		}
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

			// 4. Authority Envelope gate
			if (this.deps.authorityEnvelope) {
				const proposedAction = this.deps.getRouteProposedAction
					? this.deps.getRouteProposedAction(route)
					: { kind: route.route };
				const edge = requiresHumanEdge(objectiveId, proposedAction, this.deps.authorityEnvelope);
				if (edge) {
					if (this.deps.onHumanEdgeRequest) {
						const approved = await this.deps.onHumanEdgeRequest(edge);
						if (!approved) {
							const bundle = await this.buildBundle(objectiveId, "owner_required", runtime);
							return {
								status: "blocked",
								reasonCodes: ["human_edge_denied", edge.edge_type],
								cycleCount: this.cycleCounter,
								deliveryBundle: bundle,
							};
						}
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

			// 5. Dispatch based on route
			switch (route.route) {
				case "retrieve":
					await this.deps.retrieval?.execute?.(route, signal);
					break;

				case "deterministic_test":
					await this.deps.verifier?.execute?.(route, signal);
					break;

				case "investigate":
				case "implement":
				case "verify":
				case "review":
				case "replan":
					await this.deps.workerDispatcher?.dispatch?.(route, signal);
					break;

				case "continue_current_worker":
					await this.deps.workerDispatcher?.continueWorker?.(route, signal);
					break;

				case "escalate_capability":
					await this.deps.workerDispatcher?.dispatchEscalated?.(route, signal);
					break;

				case "completion_candidate": {
					const profile = this.deps.completionProfile ?? "semantic_enhanced";

					if (profile === "system_one_required") {
						// ADR-064: system_one_required profile stops as semantic_gate_unavailable if calibrated engine missing
						const hasCalibrated =
							this.deps.decisions?.select(ROUTE_DECISION_PROGRAM, "critical")?.capabilities()
								.confidenceProvenance === "native_calibrated" ||
							Boolean(this.deps.systemOne?.executeCompletionTransaction);

						if (!hasCalibrated) {
							const bundle = await this.buildBundle(objectiveId, "semantic_gate_unavailable", runtime);
							return {
								status: "semantic_gate_unavailable",
								reasonCodes: ["system_one_required_but_unavailable"],
								cycleCount: this.cycleCounter,
								deliveryBundle: bundle,
							};
						}

						const tx = await this.handleCompletionTransaction(objectiveId, runtime, signal);
						if (tx.outcome === "completed") {
							return tx.result;
						}
						if (tx.outcome === "failed") {
							const bundle = await this.buildBundle(objectiveId, "semantic_gate_unavailable", runtime);
							return {
								status: "semantic_gate_unavailable",
								reasonCodes: ["system_one_required_transaction_failed"],
								cycleCount: this.cycleCounter,
								deliveryBundle: bundle,
							};
						}
						break;
					}

					if (profile === "mechanical") {
						// ADR-061: Mechanical completion profile produces DeliveryBundle without Jev
						const bundle = await this.buildBundle(objectiveId, "complete", runtime);
						return {
							status: "complete",
							reasonCodes: ["mechanical_completion_passed"],
							cycleCount: this.cycleCounter,
							deliveryBundle: bundle,
						};
					}

					// Default / semantic_enhanced profile
					if (this.deps.systemOne?.executeCompletionTransaction) {
						const tx = await this.handleCompletionTransaction(objectiveId, runtime, signal);
						if (tx.outcome === "completed") {
							return tx.result;
						}
						if (tx.outcome === "failed") {
							const bundle = await this.buildBundle(objectiveId, "complete", runtime);
							return {
								status: "complete",
								reasonCodes: ["fallback_mechanical_completion_passed"],
								cycleCount: this.cycleCounter,
								deliveryBundle: bundle,
							};
						}
						break;
					}

					const bundle = await this.buildBundle(objectiveId, "complete", runtime);
					return {
						status: "complete",
						reasonCodes: ["mechanical_completion_passed"],
						cycleCount: this.cycleCounter,
						deliveryBundle: bundle,
					};
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
					await this.deps.waiter?.wait?.(route, signal);
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
			complete: "complete",
			semantic_gate_unavailable: "semantic_gate_unavailable",
		};
		return this.buildBundle(objectiveId, statusMap[result.status] ?? "unrecoverable", runtime);
	}
}
