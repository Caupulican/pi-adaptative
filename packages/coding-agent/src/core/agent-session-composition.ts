/**
 * Factory builders for the session coordinator's operator projection, worker supervision, project
 * rules, adaptive-runtime attachment, context-composition dashboard report, and toolkit execution.
 */

import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import {
	type Api,
	type AssistantMessage,
	listOpenAICodexRateLimitResetCredits,
	type Message,
	type Model,
	planToolSchemaDisclosure,
} from "@caupulican/pi-ai";
import type { Agent } from "../kernel/agent.ts";
import { projectToolsForProvider } from "../kernel/provider-tool-projection.ts";
import type { SessionManager } from "../kernel/session/session-manager.ts";
import type { AgentMessage } from "../kernel/types.ts";
import { ExternalCapabilityAcquisitionGate } from "./acquisition/external-capability-acquisition-gate.ts";
import type { AdaptiveCapabilityController } from "./adaptive/adaptive-capability-controller.ts";
import type { AdaptiveRuntimeReadiness } from "./adaptive/adaptive-runtime-readiness.ts";
import type { AgentSessionEvent } from "./agent-session-contracts.ts";
import type { CapabilityEnvelope, WorkerClaim } from "./autonomy/contracts.ts";
import type { EdgeGrantView } from "./autonomy/edge-policy.ts";
import type { ExecutionCharter } from "./autonomy/execution-charter.ts";
import { formatForegroundEnvelopeObservation } from "./autonomy/foreground-envelope.ts";
import type { LaneRecord } from "./autonomy/lane-tracker.ts";
import type { BackgroundLaneController } from "./background-lane-controller.ts";
import type { BashExecutionController } from "./bash-execution-controller.ts";
import type { createRetentionDecisionEngine } from "./compaction/retention-decision-engine.ts";
import type { SelfCompactionController } from "./compaction/self-compaction-controller.ts";
import type { CurationTelemetrySnapshot } from "./context/brain-curator.ts";
import { buildContextCompositionReport, type ContextCompositionReport } from "./context/context-composition.ts";
import type { PromptEnforcementReport } from "./context/context-prompt-enforcement.ts";
import { CONTEXT_VISIBILITY_LONG_CHARS, CONTEXT_VISIBILITY_SHORT_CHARS } from "./context/context-query-visibility.ts";
import type { MemoryPromptInclusionReport } from "./context/memory-diagnostics.ts";
import type { ContextGcResult } from "./context-gc.ts";
import type { ContextPipeline } from "./context-pipeline.ts";
import type { SpawnedUsageTotals } from "./cost/usage-records.ts";
import type { SemanticDecisionEngine } from "./decision/engine.ts";
import { noulProbability } from "./decision/noul.ts";
import { createDecisionProgram } from "./decision/program.ts";
import type { ExpertSelectionService } from "./expert-routing/service.ts";
import type { ContextUsage } from "./extensions/index.ts";
import type { ForegroundRecoveryController } from "./foreground-recovery-controller.ts";
import type { GoalStateRevision } from "./goals/goal-lifecycle.ts";
import type { GoalRuntimeSnapshot, GoalRuntimeSnapshotSettings } from "./goals/goal-runtime-snapshot.ts";
import type { GoalSessionController } from "./goals/goal-session-controller.ts";
import type { GoalState } from "./goals/goal-state.ts";
import { proveRequirementChecks, recordHostRequirementCheckProof } from "./goals/prove-requirement-checks.ts";
import { type RequirementCheckResult, runRequirementCheck } from "./goals/requirement-checks.ts";
import { recordAcceptedWorkerRequirementEvidence } from "./goals/worker-requirement-evidence.ts";
import { getResumableHumanInputSnapshot } from "./human-input.ts";
import type { AutoLearnApplyPorts } from "./learning/auto-learn-proposals.ts";
import { ObservationStore, observationKey } from "./learning/observation-store.ts";
import { type LessonCandidate, type LessonJudge, routeLesson } from "./learning/structural-backlog.ts";
import { type ContinuousChatRequestSource, splitContinuousChatRequest } from "./memory/continuous-chat-projection.ts";
import type { MemoryController } from "./memory-controller.ts";
import type { ModelRouterController } from "./model-router-controller.ts";
import { assertCurrentGoalObjective } from "./objective-execution/current-objective-execution.ts";
import { createRepoGitDelivery } from "./objective-execution/delivery-proof.ts";
import type { ExecutionLoopMode, ObjectiveExecutionController } from "./objective-execution/index.ts";
import { LedgerRouteCheckpoints } from "./objective-execution/ledger-route-checkpoints.ts";
import type { ObjectiveRoute } from "./objective-execution/objective-route.ts";
import {
	createRepoReleaseDelivery,
	type TrustedDeployAdapterRegistry,
} from "./objective-execution/release-delivery.ts";
import type { RepositoryMutationObserver } from "./objective-execution/repository-mutation-observer.ts";
import type { DecisionLedgerStore } from "./operator-projection/decision-ledger-store.ts";
import type { DecisionStageSink } from "./operator-projection/decision-stage-log.ts";
import {
	type DeliveryState,
	type PendingOwnerQuestion,
	SessionOperatorProjection,
} from "./operator-projection/session-operator-projection.ts";
import type { AdaptationProjection } from "./operator-projection/types.ts";
import type { TaskRuntimeProjection } from "./orchestration/task-runtime-state.ts";
import { ReturnBriefController } from "./owner-decisions/return-brief-controller.ts";
import type { OwnerInputLedger } from "./owner-input-ledger.ts";
import type { ProfileFilterController } from "./profile-filter-controller.ts";
import type { DurableOwnerRuleStore } from "./project-rules/durable-owner-rules.ts";
import {
	PROJECT_RULE_REPAIR_CUSTOM_TYPE,
	SessionProjectRules,
	type TrustedRuleSource,
} from "./project-rules/session-project-rules.ts";
import { ProviderRequestContextController } from "./provider-request-context-controller.ts";
import type { ReflectionController } from "./reflection-controller.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import type { RuntimeBuilder } from "./runtime-builder.ts";
import type { SessionEdgeIntentController } from "./session-edge-intent-controller.ts";
import type { SessionSemanticPlaneController } from "./session-semantic-plane-controller.ts";
import type { SessionWorkState } from "./session-work-state.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { SkillVaultController } from "./skill-vault.ts";
import type { SystemOneSteeringPlane } from "./steering/system-one-steering-plane.ts";
import { WorkerSemanticSupervisor } from "./supervision/worker-semantic-supervisor.ts";
import { WorkerSupervisionCoordinator } from "./supervision/worker-supervision-coordinator.ts";
import { sameLaneVerificationDirective } from "./system-one/control-directive.ts";
import type { SystemOneController } from "./system-one/controller.ts";
import type { SystemOneWorkerControl } from "./system-one/worker-control.ts";
import { captureSessionTaskDirectoryContext } from "./tasks/task-directory-context.ts";

export interface SessionOperatorProjectionWiringDeps {
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	readonly ownerRules: Pick<DurableOwnerRuleStore, "list">;
	getGoalStateSnapshot(): GoalState | undefined;
	getLaneRecords(): readonly LaneRecord[];
	getActiveVerificationIds(): readonly string[];
	getAdaptationProjection(): AdaptationProjection | undefined;
	getDeliveryState(): DeliveryState;
	getContextUsage(): ContextUsage | undefined;
	getOperatorBlocker(): string | undefined;
	getGoalRuntimeSnapshot(settings: GoalRuntimeSnapshotSettings): GoalRuntimeSnapshot;
	getExecutionLoopMode(): ExecutionLoopMode | undefined;
	getLastObjectiveRoute(): ObjectiveRoute | undefined;
	getPendingHumanInput?(): PendingOwnerQuestion | undefined;
	getSessionWorkState(): SessionWorkState;
	getStageSink(): { readonly key: string; readonly sink: DecisionStageSink } | undefined;
}

export function createSessionOperatorProjection(deps: SessionOperatorProjectionWiringDeps): SessionOperatorProjection {
	return new SessionOperatorProjection({
		getObjectiveId: () => deps.getGoalStateSnapshot()?.goalId ?? deps.sessionManager.getSessionId(),
		getTitle: () => deps.sessionManager.getSessionName() || basename(deps.sessionManager.getCwd()),
		getGoalState: () => deps.getGoalStateSnapshot(),
		getLanes: () => deps.getLaneRecords(),
		getUnresolvedProofIds: () => deps.getActiveVerificationIds(),
		getAdaptation: () => deps.getAdaptationProjection(),
		getDeliveryState: () => deps.getDeliveryState(),
		getContext: () => {
			const usage = deps.getContextUsage();
			if (!usage) return undefined;
			// `tokens: null` is the post-compaction state: the window is unknown until the next
			// provider response, which is exactly what the operator should see.
			return {
				...(usage.percent !== null ? { percent: usage.percent } : {}),
				compacted: usage.tokens === null,
			};
		},
		// The owner's durable fast-iteration rule is what makes the compact indicator true.
		isFastIteration: () =>
			deps.ownerRules
				.list()
				.some((policy) => policy.forbid.includes("full_suite_per_edit") || policy.forbid.includes("tdd_workflow")),
		getBlocker: () => deps.getOperatorBlocker(),
		// The live continuation verdict is the field loop's own decision record; control is derived
		// from it, never from a second copy of the goal's state.
		getContinuation: () =>
			deps.getGoalRuntimeSnapshot({
				maxStallTurns: deps.settingsManager.getAutonomySettings().maxStallTurns,
			}).continuation,
		// While System One drives the loop, control speaks the route's vocabulary.
		getRoute: () => {
			if (deps.getExecutionLoopMode() !== "objective_primary") return undefined;
			const route = deps.getLastObjectiveRoute();
			return route
				? { objectiveId: route.objective_id, route: route.route, reasonCodes: route.reason_codes }
				: undefined;
		},
		// Durable, not the process-local activity feed: an unanswered question survives a restart.
		getPendingHumanInput: () => {
			if (deps.getPendingHumanInput) return deps.getPendingHumanInput();
			const snapshot = getResumableHumanInputSnapshot(deps.sessionManager);
			if (snapshot?.status !== "pending") return undefined;
			const question = snapshot.request.questions[0];
			if (!question) return undefined;
			return {
				requestId: snapshot.request.requestId,
				question: question.header || question.question,
			};
		},
		isForegroundBusy: () => deps.getSessionWorkState().busy,
		// The invalidation signal for both branch-walking reads above: every input they derive
		// from is a persisted session entry.
		getSessionEntryCount: () => deps.sessionManager.getEntryCount(),
		// Durable, never erased: the decision ledger keyed by session id, so timers survive a
		// restart and sessions opened in the same cwd never share rows.
		getStageSink: () => deps.getStageSink(),
	});
}

export interface SessionWorkerSupervisionWiringDeps {
	readonly sessionManager: Pick<SessionManager, "getSessionId">;
	readonly cwd: string;
	getSteeringPlane(): SystemOneSteeringPlane | undefined;
	readonly systemOneWorkerControl: Pick<SystemOneWorkerControl, "steerWorker" | "cancelWorker">;
	emit(event: AgentSessionEvent): void;
	getOperatorProjection(): Pick<SessionOperatorProjection, "eventBridge">;
	getDecisionLedger(): Pick<DecisionLedgerStore, "recordSupervisionAction"> | undefined;
	getTaskRuntimeSnapshot(): TaskRuntimeProjection | undefined;
}

export function createSessionWorkerSupervision(deps: SessionWorkerSupervisionWiringDeps): WorkerSupervisionCoordinator {
	return new WorkerSupervisionCoordinator({
		supervisor: new WorkerSemanticSupervisor({
			// First-class SteeringPlane checkpoint. The compaction retention adapter is not this bridge.
			steering: {
				requireCertificate: async (checkpoint, payload, context) => {
					const plane = deps.getSteeringPlane();
					if (!plane) {
						throw new Error("System One steering plane is not bound for worker supervision");
					}
					const certificate = await plane.requireCertificate(checkpoint, payload, {
						...context,
						requirePass: false,
						consequence: "medium",
					});
					return {
						certificate_id: certificate.certificate_id,
						answers: certificate.answers,
					};
				},
			},
		}),
		control: {
			// The supervisor reaches System One's worker levers and nothing else.
			steerWorker: (agentId, directive, delivery) =>
				deps.systemOneWorkerControl.steerWorker(agentId, directive, delivery ?? "queue"),
			cancelWorker: (agentId, reason) => deps.systemOneWorkerControl.cancelWorker(agentId, reason),
		},
		onIntervention: (signal) => {
			if (!signal.summaryEvent) return;
			// A request to the root (verifier, specialist, capability, external block) is work flowing, not a
			// problem with the worker; only steering and stopping are warnings.
			const requestsRoot =
				signal.action === "request_verifier" ||
				signal.action === "request_specialist" ||
				signal.action === "request_capability" ||
				signal.action === "mark_external_block";
			deps.emit({
				type: "warning",
				message: signal.summaryEvent,
				...(requestsRoot ? { severity: "info" as const } : {}),
			});
			deps
				.getOperatorProjection()
				.eventBridge.recordSupervisorIntervention(signal.attempt_id, signal.explanation ?? signal.summaryEvent);
		},
		onSupervisionError: (error) => {
			const message = error instanceof Error ? error.message : String(error);
			deps.emit({ type: "warning", message: `Worker supervision degraded: ${message}` });
		},
		recordAction: (record) =>
			deps.getDecisionLedger()?.recordSupervisionAction({
				sessionId: deps.sessionManager.getSessionId(),
				cwd: deps.cwd,
				decidedAt: Date.now(),
				...record,
			}),
		// Stale only when the attempt is known to have ended; an unknown status is not evidence of that.
		isAttemptLive: (attemptId) => {
			const status = deps.getTaskRuntimeSnapshot()?.attempts[attemptId]?.status;
			return (
				status === undefined ||
				status === "queued" ||
				status === "leased" ||
				status === "running" ||
				status === "suspended"
			);
		},
	});
}

export interface SessionProjectRulesWiringDeps {
	readonly cwd: string;
	readonly resourceLoader: Pick<ResourceLoader, "getAgentsFiles"> & {
		getAdmittedAgentsRuleSources?(): readonly TrustedRuleSource[] | undefined;
	};
	readonly ownerRules: Pick<DurableOwnerRuleStore, "list">;
	/** The session's semantic plane: its batched engine, and whether System One is configured without one. */
	readonly systemOne: Pick<SessionSemanticPlaneController, "semanticDecisionEngine" | "configured">;
	readonly sessionManager: Pick<SessionManager, "appendCustomEntry">;
	emit(event: AgentSessionEvent): void;
	getSystemOneController(): Pick<SystemOneController, "noteControlDirective"> | undefined;
	getOperatorProjection(): Pick<SessionOperatorProjection, "eventBridge">;
}

export function createSessionProjectRules(deps: SessionProjectRulesWiringDeps): SessionProjectRules {
	return new SessionProjectRules({
		cwd: deps.cwd,
		// Only instruction files the active profile already admitted are rule sources; arbitrary
		// repository text never gets to author a rule that blocks a transition.
		getTrustedRuleSources: () => {
			const admitted = deps.resourceLoader.getAdmittedAgentsRuleSources?.();
			if (admitted !== undefined) return admitted;
			return deps.resourceLoader
				.getAgentsFiles()
				.agentsFiles.flatMap((file) => (file.content ? [{ path: file.path, content: file.content }] : []));
		},
		getOwnerRulePolicies: () => deps.ownerRules.list(),
		getDecisionEngine: () => deps.systemOne.semanticDecisionEngine(),
		isSystemOneConfigured: () => deps.systemOne.configured,
		recordRepairWork: (repair) => {
			deps.sessionManager.appendCustomEntry(PROJECT_RULE_REPAIR_CUSTOM_TYPE, repair);
		},
		emitViolation: (result) => {
			const violation = result.violations[0];
			deps.emit({
				type: "warning",
				message:
					result.advisory || result.verificationRequired
						? (result.summaryEvent ?? "Project rule advice unavailable")
						: `Project rule violation blocks this transition: ${result.summaryEvent ?? violation?.explanation ?? "unspecified"}`,
			});
			if (result.verificationRequired) {
				deps
					.getSystemOneController()
					?.noteControlDirective(
						sameLaneVerificationDirective(result.violations.map((finding) => finding.explanation)),
					);
			}
			if (violation && !result.advisory && !result.verificationRequired) {
				deps
					.getOperatorProjection()
					.eventBridge.recordRuleRepair(violation.ruleId, violation.suggestedFix ?? violation.explanation);
			}
		},
	});
}

export interface SessionAdaptiveRuntimeStack {
	readiness?: AdaptiveRuntimeReadiness;
	steeringPlane?: SystemOneSteeringPlane;
	objectiveController?: ObjectiveExecutionController;
	adaptiveCapabilities?: AdaptiveCapabilityController;
	charter?: ExecutionCharter;
	expertService?: ExpertSelectionService;
}

export interface SessionAdaptiveRuntimeAttachDeps {
	readonly cwd: string;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	readonly modelRouter: Pick<ModelRouterController, "setExpertSelector">;
	getSteeringPlane(): SystemOneSteeringPlane | undefined;
	setSteeringPlane(plane: SystemOneSteeringPlane): void;
	bindSemanticObserver(plane: SystemOneSteeringPlane): void;
	getExecutionCharter(): ExecutionCharter | undefined;
	setExecutionCharter(charter: ExecutionCharter): void;
	readonly mutationLedger: {
		bindObjective(objectiveId: string): void;
		reconcile(objectiveId: string, repoRoot: string): void;
		provenOwnedPaths(objectiveId: string): readonly string[];
		ownedDigests(objectiveId: string): readonly { readonly path: string; readonly digest: string }[];
	};
	getSemanticDecisionEngine(): ReturnType<typeof createRetentionDecisionEngine> | undefined;
	getEdgeGrants(): readonly EdgeGrantView[];
	emit(event: AgentSessionEvent): void;
	setAcquisitionGate(gate: ExternalCapabilityAcquisitionGate): void;
	setAdaptiveReadiness(readiness: AdaptiveRuntimeReadiness): void;
	setObjectiveExecutionController(controller: ObjectiveExecutionController): void;
	setOperatorBlocker(blocker: string | undefined): void;
	getOperatorBlocker(): string | undefined;
	getDecisionLedger(): DecisionLedgerStore | undefined;
	readonly backgroundLanes: Pick<BackgroundLaneController, "getTaskRuntimeSnapshot">;
	readonly goals: Pick<GoalSessionController, "objectiveRootExecutor">;
	chooseObjectiveExecutor(route: ObjectiveRoute): "root" | "worker";
	retrieveForObjective(route: ObjectiveRoute, signal?: AbortSignal): Promise<"root" | "worker" | undefined>;
	waitForObjectiveWorkers(context: unknown, signal?: AbortSignal): Promise<void>;
	readonly workerSupervision: Pick<
		WorkerSupervisionCoordinator,
		"getPendingRootRequests" | "consumePendingRootRequest"
	>;
	objectiveMutationId(): string;
	readonly repositoryObserver: Pick<RepositoryMutationObserver, "deliveryBlockReason" | "waitForQuiescence">;
	readonly runtimeBuilder: Pick<RuntimeBuilder, "withTaskDirectoryContext" | "taskCwd">;
	getGoalStateSnapshot(): GoalState | undefined;
	saveGoalStateSnapshot(state: GoalState, expected?: GoalStateRevision): string | Promise<boolean> | boolean;
	getLocalCommitBranch(): string | undefined;
	getRuleAuthority(): "unset" | "ask" | "user" | "written";
	readonly deployAdapters: TrustedDeployAdapterRegistry;
	getSystemOneController(): SystemOneController | undefined;
	getExecutionLoopMode(): ExecutionLoopMode | undefined;
	setAdaptationProjection(adaptation: AdaptationProjection | undefined): void;
}

export function attachSessionAdaptiveRuntime(
	deps: SessionAdaptiveRuntimeAttachDeps,
	stack: SessionAdaptiveRuntimeStack,
): void {
	if (stack.expertService) {
		// The foreground router's AUTO tiers refine through the same H-MoE plane the objective
		// controller uses, bounded to the operator's candidate pool.
		deps.modelRouter.setExpertSelector(stack.expertService);
	}
	if (stack.steeringPlane) {
		// Bound before the gate below so the gate, like every other consumer, reaches the plane's
		// engine through the one recording accessor.
		deps.setSteeringPlane(stack.steeringPlane);
		deps.bindSemanticObserver(stack.steeringPlane);
	}
	if (stack.charter) {
		// Authority for external acquisition comes from this charter and nowhere else; the gate is
		// only constructed once a real charter exists.
		deps.setExecutionCharter(stack.charter);
		deps.mutationLedger.bindObjective(stack.charter.objective_id);
		const decisionEngine = deps.getSemanticDecisionEngine();
		deps.setAcquisitionGate(
			new ExternalCapabilityAcquisitionGate({
				charter: stack.charter,
				// An operator grant recorded at the edge is authority the session really has; reading it
				// here keeps the gate from re-denying what the operator already allowed.
				getGrantedAuthority: () => {
					const classes = new Set(deps.getEdgeGrants().map((grant) => grant.class));
					return {
						allowPackageInstalls: classes.has("package.install"),
						allowNetworkDownloads: classes.has("package.install"),
					};
				},
				systemOneRequired: deps.getSteeringPlane()?.policy.mode === "system_one_required",
				...(decisionEngine ? { decisionEngine } : {}),
				onSemanticFailure: (error) =>
					deps.emit({
						type: "warning",
						message: `Acquisition gate: semantic evaluation failed (${error instanceof Error ? error.message : String(error)}); conservative route kept`,
					}),
			}),
		);
	}
	if (stack.readiness) {
		deps.setAdaptiveReadiness(stack.readiness);
	}
	if (stack.objectiveController) {
		deps.setObjectiveExecutionController(stack.objectiveController);
		stack.objectiveController.setOwnerBlockerSink((blocker) => deps.setOperatorBlocker(blocker));
		// The executors System One routes to live on this session: the root turn, the worker wait
		// and System One's own completion transaction.
		const ledgerRoutes = new LedgerRouteCheckpoints({
			getLedger: () => deps.getDecisionLedger(),
			sessionId: deps.sessionManager.getSessionId(),
			cwd: deps.cwd,
			getSnapshot: () => deps.backgroundLanes.getTaskRuntimeSnapshot(),
		});
		stack.objectiveController.bindSessionExecutors({
			rootExecutor: deps.goals.objectiveRootExecutor(),
			chooseExecutor: (route) => deps.chooseObjectiveExecutor(route),
			retrieval: { execute: (route, signal) => deps.retrieveForObjective(route, signal) },
			waiter: { wait: (context, signal) => deps.waitForObjectiveWorkers(context, signal) },
			checkpoints: ledgerRoutes,
			stalls: ledgerRoutes,
			// The owner's authority is required while a question is open or a blocker stands.
			ownerRequired: () =>
				deps.getOperatorBlocker() !== undefined ||
				getResumableHumanInputSnapshot(deps.sessionManager)?.status === "pending",
			pendingSupervisionRequests: () => deps.workerSupervision.getPendingRootRequests(),
			consumePendingSupervisionRequest: (signalId) => deps.workerSupervision.consumePendingRootRequest(signalId),
			repoRoot: deps.cwd,
			gitExecutor: createRepoGitDelivery(deps.cwd),
			attributedMutationPaths: () => {
				const objectiveId = deps.objectiveMutationId();
				deps.mutationLedger.reconcile(objectiveId, deps.cwd);
				return deps.mutationLedger.provenOwnedPaths(objectiveId);
			},
			deliveryBlockReason: () => {
				const objectiveId = deps.objectiveMutationId();
				deps.mutationLedger.reconcile(objectiveId, deps.cwd);
				return deps.repositoryObserver.deliveryBlockReason(objectiveId);
			},
			waitForRepositoryQuiescence: (objectiveId, signal) =>
				deps.repositoryObserver.waitForQuiescence(objectiveId, signal),
			proveRequirementChecks: (signal) =>
				deps.runtimeBuilder.withTaskDirectoryContext(async () => {
					const goal = deps.getGoalStateSnapshot();
					if (!goal) return undefined;
					return proveRequirementChecks({
						state: goal,
						runCheck: (check, checkSignal) =>
							runRequirementCheck(check, {
								cwd: deps.runtimeBuilder.taskCwd,
								...(checkSignal ? { signal: checkSignal } : {}),
							}),
						now: () => new Date().toISOString(),
						save: (state, expected) => deps.saveGoalStateSnapshot(state, expected),
						requireVerifiedEvidenceForCompletion: true,
						...(signal ? { signal } : {}),
					});
				}, signal),
			ownedPathDigests: () => deps.mutationLedger.ownedDigests(deps.objectiveMutationId()),
			localCommitBranch: () => deps.getLocalCommitBranch(),
			ruleAuthority: () => deps.getRuleAuthority(),
			...(() => {
				const packageIntent = deps.getExecutionCharter()?.delivery.packagePublish ?? false;
				const releaseExecutor = createRepoReleaseDelivery(deps.cwd, {
					npmCommand: deps.settingsManager.getNpmCommand(),
					packageIntent,
					adapters: deps.deployAdapters,
				});
				return releaseExecutor ? { releaseExecutor } : {};
			})(),
			...(() => {
				const systemOneController = deps.getSystemOneController();
				return systemOneController
					? {
							systemOne: {
								get adapter() {
									return systemOneController.adapter;
								},
								snapshot: () => systemOneController.store.snapshot(),
								completionView: (signal) => systemOneController.completionView(signal),
								executeCompletionTransaction: (isBugFix, options) =>
									deps.runtimeBuilder.withTaskDirectoryContext(() =>
										deps.getSystemOneController()!.executeCompletionTransaction(isBugFix, options),
									),
								commitTerminalCompletion: (input, options) =>
									deps.runtimeBuilder.withTaskDirectoryContext(() =>
										deps.getSystemOneController()!.commitTerminalCompletion(input, options),
									),
								validateObjectivePostflight: (objectiveId) =>
									deps.runtimeBuilder.withTaskDirectoryContext(() => {
										assertCurrentGoalObjective(objectiveId, deps.getGoalStateSnapshot());
										return deps.getSystemOneController()!.validateObjectivePostflight(objectiveId);
									}),
								peekControlDirective: () => deps.getSystemOneController()!.peekControlDirective(),
								consumeControlDirective: (directive) =>
									deps.getSystemOneController()!.consumeControlDirective(directive),
								noteControlDirective: (directive) =>
									deps.getSystemOneController()!.noteControlDirective(directive),
							},
						}
					: {};
			})(),
			...(deps.getExecutionLoopMode() ? { mode: deps.getExecutionLoopMode() } : {}),
		});
	}
	if (stack.adaptiveCapabilities) {
		stack.adaptiveCapabilities.setAdaptationSink((adaptation) => deps.setAdaptationProjection(adaptation));
	}
}

export interface SessionSubscriptionResetDeps {
	readonly subscriptionResetOffered: Set<string>;
	readonly subscriptionResetChecking: Set<string>;
	readonly modelRegistry: {
		find(provider: string, modelId: string): Model<Api> | undefined;
		getApiKeyForProvider(provider: string): Promise<string | undefined>;
		readonly authStorage: {
			getOAuthRequestHeaders(provider: string, accessToken: string): Record<string, string> | undefined;
		};
	};
	emit(event: AgentSessionEvent): void;
}

export async function offerCodexSubscriptionReset(
	deps: SessionSubscriptionResetDeps,
	message: AssistantMessage,
): Promise<void> {
	const provider = message.provider;
	if (
		provider !== "openai-codex" ||
		deps.subscriptionResetOffered.has(provider) ||
		deps.subscriptionResetChecking.has(provider)
	)
		return;
	// Only a notice the owner actually received uses up the episode; a check that found no reset or
	// could not complete is made again on the next limit answer.
	deps.subscriptionResetChecking.add(provider);
	const codex = deps.modelRegistry.find(message.provider, message.model);
	try {
		const accessToken = await deps.modelRegistry.getApiKeyForProvider(message.provider);
		if (!accessToken) return;
		const summary = await listOpenAICodexRateLimitResetCredits({
			accessToken,
			credentialHeaders: deps.modelRegistry.authStorage.getOAuthRequestHeaders(message.provider, accessToken),
			baseUrl: codex?.baseUrl,
			signal: AbortSignal.timeout(15_000),
		});
		if (summary.availableCount === 0) return;
		deps.subscriptionResetOffered.add(provider);
		deps.emit({
			type: "warning",
			message: `OpenAI Codex usage limit reached. ${summary.availableCount} usage ${summary.availableCount === 1 ? "reset is" : "resets are"} available: /usage, then Redeem usage limit reset.`,
		});
	} catch (error) {
		deps.emit({
			type: "warning",
			message: `OpenAI Codex usage limit reached; checking for usage resets failed: ${error instanceof Error ? error.message : String(error)}`,
		});
	} finally {
		deps.subscriptionResetChecking.delete(provider);
	}
}

export interface SessionContextCompositionDeps {
	readonly agent: Agent;
	readonly model?: Model<Api>;
	readonly systemPrompt: string;
	readonly unboundToolGrantWarnings: readonly string[];
	readonly skillVault: Pick<SkillVaultController, "previewRequestSystemPrompt">;
	readonly resourceLoader: {
		getExtensions(): {
			extensions: readonly {
				path: string;
				tools: Map<string, unknown>;
				commands: Map<string, unknown>;
			}[];
		};
		getAgentsDiagnostics(): readonly { message: string }[];
	};
	readonly profileFilter: Pick<
		ProfileFilterController,
		"profileDeniedResourceObservations" | "getInertExtensionWarnings"
	>;
	readonly settingsManager: Pick<SettingsManager, "getProfileGrantsOverriddenByUserDisable">;
	applyContextGc(rawMessages: AgentMessage[], writePayloads: boolean, sentPrefixCount: number): ContextGcResult;
	getContextUsage(): ContextUsage | undefined;
	getPromptEnforcementReport(): PromptEnforcementReport;
	getContextCurationStatus(): {
		enabled: boolean;
		telemetry: CurationTelemetrySnapshot;
		lastSkipReason?: string;
	};
	getSpawnedUsage(): SpawnedUsageTotals;
	continuousChat(): ContinuousChatRequestSource;
	getMemoryPromptInclusionReport(): MemoryPromptInclusionReport;
	getCurrentForegroundEnvelope(): CapabilityEnvelope | undefined;
	buildForegroundEnvelopeFromState(): CapabilityEnvelope;
}

export function buildSessionContextCompositionReport(deps: SessionContextCompositionDeps): ContextCompositionReport {
	const rawMessages = deps.agent.state.messages.slice();
	// Dashboard/diagnostic view, not a live provider request: the send-time `sentPrefixCount`
	// mark lives inside the agent-core loop for the duration of one active plan() call and is
	// not readable from here, so this shows full packing potential (0 = no freeze) rather than a
	// stale or guessed mark.
	// Under ICM a request carries the chat frame and the running turn's own messages, never durable history.
	const chatRequest = splitContinuousChatRequest(deps.continuousChat(), rawMessages);
	const gcResult = deps.applyContextGc(chatRequest ? chatRequest.own : rawMessages, false, 0);
	const requestMessages = chatRequest ? [...chatRequest.frame, ...gcResult.messages] : gcResult.messages;
	const requestSystemPrompt = deps.skillVault.previewRequestSystemPrompt(deps.systemPrompt);
	const extensions = deps.resourceLoader.getExtensions().extensions;
	const extensionToolNames = new Set(extensions.flatMap((extension) => [...extension.tools.keys()]));
	const usage = deps.getContextUsage();
	const enforcementItems = deps.getPromptEnforcementReport().items;
	const curationStatus = deps.getContextCurationStatus();
	const spawned = deps.getSpawnedUsage();
	const promptInclusion = deps.getMemoryPromptInclusionReport();
	const memoryEvidenceTokens = promptInclusion.status === "included" ? Math.ceil(promptInclusion.blockChars / 4) : 0;
	// Query projections are applied at send time. In-place short/hidden views save against the
	// raw message shown here; tail overlays restore evidence after GC and therefore add tokens.
	const projectionTokens = (item: (typeof enforcementItems)[number]) => {
		const originalChars = item.originalChars ?? 0;
		if (item.deliveredVisibility === "hidden") return 50;
		if (item.deliveredVisibility === "short") {
			return Math.ceil((Math.min(originalChars, CONTEXT_VISIBILITY_SHORT_CHARS) + 256) / 4);
		}
		if (item.deliveredVisibility === "long") {
			return Math.ceil((Math.min(originalChars, CONTEXT_VISIBILITY_LONG_CHARS) + 256) / 4);
		}
		return Math.ceil((originalChars + 256) / 4);
	};
	const enforcementSavedTokens = enforcementItems
		.filter(
			(item) => item.enforced && item.projectionPlacement === "in_place" && typeof item.originalChars === "number",
		)
		.reduce((sum, item) => sum + Math.max(0, Math.ceil((item.originalChars ?? 0) / 4) - projectionTokens(item)), 0);
	const enforcementAddedTokens = enforcementItems
		.filter(
			(item) =>
				item.enforced && item.projectionPlacement === "tail_overlay" && typeof item.originalChars === "number",
		)
		.reduce((sum, item) => sum + projectionTokens(item), 0);
	const deferredToolNames = deps.model
		? planToolSchemaDisclosure(deps.model, projectToolsForProvider(deps.agent.state.tools)).deferredToolNames
		: undefined;
	return buildContextCompositionReport({
		systemPrompt: requestSystemPrompt ?? "",
		deferredToolNames,
		tools: deps.agent.state.tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			providerDescription: tool.providerDescription,
			parameters: tool.parameters,
			source: extensionToolNames.has(tool.name) ? ("extension" as const) : ("built-in" as const),
		})),
		extensions: extensions.map((extension) => ({
			name: basename(extension.path),
			path: extension.path,
			toolNames: [...extension.tools.keys()],
			commandCount: extension.commands.size,
		})),
		messages: requestMessages,
		providerReportedTokens: usage?.tokens ?? null,
		contextWindow: usage?.contextWindow ?? deps.model?.contextWindow ?? null,
		gc: { packedCount: gcResult.report.packedCount, savedTokens: gcResult.report.savedTokens },
		enforcement: {
			enforcedCount: enforcementItems.filter((item) => item.enforced).length,
			advisoryEvictions: enforcementItems.filter(
				(item) => item.advisory === "brain_irrelevant" && item.deliveredVisibility === "hidden",
			).length,
		},
		curation: {
			enabled: curationStatus.enabled,
			telemetry: curationStatus.telemetry,
			lastSkipReason: curationStatus.lastSkipReason,
		},
		spawned: { cost: spawned.cost, reports: spawned.reports },
		adjustments: { memoryEvidenceTokens, enforcementSavedTokens, enforcementAddedTokens },
		extraObservations: [
			...deps.resourceLoader.getAgentsDiagnostics().map((diagnostic) => diagnostic.message),
			...deps.profileFilter.profileDeniedResourceObservations(),
			...deps.profileFilter.getInertExtensionWarnings(),
			...deps.unboundToolGrantWarnings,
			// Auto-built per-turn foreground envelope (observe-only; not enforced). Falls back to a
			// live preview when no turn has run yet so /context always shows the current scope.
			formatForegroundEnvelopeObservation(
				deps.getCurrentForegroundEnvelope() ?? deps.buildForegroundEnvelopeFromState(),
			),
			// A user disable always beats a profile grant — surface the conflict.
			...(["tools", "skills", "prompts", "extensions"] as const).flatMap((kind) =>
				deps.settingsManager
					.getProfileGrantsOverriddenByUserDisable(kind)
					.map(
						(entry) =>
							`profile grants ${kind} "${entry}" but your disable list overrides it (user disable wins; re-enable to use)`,
					),
			),
		],
	});
}

export interface SessionToolkitHitDeps {
	readonly agent: Agent;
	/** The session's message persistence (the foreground lifecycle's): a persisted owner message is delivered there. */
	persistMessage(message: Message): void;
	readonly bash: Pick<BashExecutionController, "recordBashResult">;
	emit(event: AgentSessionEvent): void;
}

export async function runToolkitHit(
	deps: SessionToolkitHitDeps,
	scriptName: string,
	turnMessages: readonly AgentMessage[],
	signal?: AbortSignal,
): Promise<void> {
	const tool = deps.agent.state.tools.find((candidate) => candidate.name === "run_toolkit_script");
	if (!tool) return;
	for (const message of turnMessages) {
		if (message.role !== "user") continue;
		deps.agent.appendMessage(message);
		deps.persistMessage(message);
		deps.emit({ type: "message_end", message });
	}
	const command = `run_toolkit_script ${scriptName}`;
	let output: string;
	let exitCode: number | undefined;
	try {
		const result = await tool.execute(`toolkit-${randomUUID()}`, { script: scriptName }, signal);
		output = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		const details = result.details as { exitCode?: number | null } | undefined;
		exitCode = typeof details?.exitCode === "number" ? details.exitCode : result.isError ? 1 : 0;
	} catch (error) {
		output = error instanceof Error ? error.message : String(error);
		exitCode = undefined;
	}
	deps.bash.recordBashResult(command, { output, exitCode, cancelled: signal?.aborted === true, truncated: false });
	const recorded = deps.agent.state.messages.at(-1);
	if (recorded?.role === "bashExecution") {
		deps.emit({ type: "message_start", message: recorded });
		deps.emit({ type: "message_end", message: recorded });
	}
}

/**
 * The owners the request context is planned from. A member the session assigns after it builds the controller (the
 * model router, the reflection controller, the runtime builder, the extension runner) is passed as a getter, so the
 * closures read the member as it stands when a request is planned.
 */
export interface SessionProviderRequestContextOwners {
	readonly sessionManager: SessionManager;
	readonly memory: MemoryController;
	readonly pipeline: ContextPipeline;
	readonly selfCompaction: Pick<SelfCompactionController, "guidance" | "guidanceClearedText">;
	readonly skillVault: SkillVaultController;
	readonly goals: Pick<GoalSessionController, "getRoutedGoalContext" | "autoContinueNote">;
	readonly edgeIntent: Pick<SessionEdgeIntentController, "getRunEdgeGrants">;
	readonly ownerInputs: Pick<OwnerInputLedger, "onDelivered">;
	readonly modelRouter: () => Pick<ModelRouterController, "projectTurnContext">;
	readonly reflection: () => Pick<ReflectionController, "previewCurrentTurnCue">;
	readonly runtimeBuilder: () => Pick<RuntimeBuilder, "previewTaskAutomationContext">;
	readonly extensionRunner: Parameters<MemoryController["createContextProjection"]>[0];
	readonly getGoalState: () => GoalState | undefined;
	readonly agentDir: () => string;
	readonly cwd: () => string;
	readonly taskProjection: () => TaskRuntimeProjection | undefined;
	/** The foreground run in progress: the submission it belongs to and the origin that decided it. */
	readonly foreground: () => Pick<ForegroundRecoveryController, "getCurrentSubmissionEpoch" | "turnOrigin">;
	readonly warn: (message: string) => void;
}

export interface SessionProviderRequestContext {
	readonly controller: ProviderRequestContextController;
	/** The owner's return brief: built and carried by the controller, merged into the `/status` view. */
	readonly returnBrief: ReturnBriefController;
}

/**
 * Builds the provider request context controller for a session and the return brief controller it carries. Each step of
 * the request plan is the pipeline's own call, in the order the plan runs them.
 */
export function createSessionProviderRequestContext(
	owners: SessionProviderRequestContextOwners,
): SessionProviderRequestContext {
	const { pipeline, memory, selfCompaction, goals, edgeIntent, skillVault } = owners;
	const returnBrief = new ReturnBriefController({
		getSessionId: () => owners.sessionManager.getSessionId(),
		getAgentDir: owners.agentDir,
		getCwd: owners.cwd,
		now: () => Date.now(),
		ownerInputs: owners.ownerInputs,
		sessionManager: owners.sessionManager,
		taskProjection: owners.taskProjection,
		currentSubmissionEpoch: () => owners.foreground().getCurrentSubmissionEpoch(),
		liveRun: () => owners.foreground().turnOrigin.live(),
		warn: owners.warn,
	});
	const controller = new ProviderRequestContextController({
		// A side trip reads its small brief, never the transcript (see ModelRouterController.projectTurnContext).
		transformBase: async (messages) => owners.modelRouter().projectTurnContext(messages),
		transformExtensions: memory.createContextProjection(owners.extensionRunner),
		runContextAudit: (messages) => pipeline.runContextAudit(messages),
		runPromptPolicyPlanning: (report) => pipeline.runPromptPolicyPlanning(report),
		previewContextProjection: (messages) => pipeline.previewContextProjection(messages),
		commitContextProjection: (projection) => pipeline.commitContextProjection(projection),
		runMemoryRetrieval: (messages) => memory.runMemoryRetrieval(messages),
		applyContextGc: (messages, writePayloads, frozenBelow) =>
			pipeline.applyContextGc(messages, writePayloads, frozenBelow),
		correlatePromptPolicyWithContextGc: (report) => pipeline.correlatePromptPolicyWithContextGc(report),
		runPromptEnforcement: (messages, report, sourceMessages, frozenBelow, gcReport) =>
			pipeline.runPromptEnforcement(messages, report, undefined, { sourceMessages, frozenBelow, gcReport }),
		enqueueRelevanceCuration: (messages, report) => pipeline.enqueueRelevanceCuration(messages, report),
		maybeDrainBrainCuration: () =>
			pipeline.maybeDrainBrainCuration((type, data) => owners.sessionManager.appendCustomEntry(type, data)),
		appendMemoryEvidence: (messages, report, wire) => memory.appendPromptMemory(messages, report, wire),
		previewReflectionCue: () => owners.reflection().previewCurrentTurnCue(),
		previewTaskDirectoryContext: () => captureSessionTaskDirectoryContext(owners.sessionManager),
		previewTaskAutomationContext: () => owners.runtimeBuilder().previewTaskAutomationContext(),
		previewReturnBrief: () => returnBrief.previewReturnBrief(),
		previewSelfCompactionGuidance: () => ({
			content: selfCompaction.guidance(),
			cleared: selfCompaction.guidanceClearedText(),
		}),
		getGoalState: owners.getGoalState,
		skillVault,
		getRoutedGoalContext: () => goals.getRoutedGoalContext(),
		getGoalAutoContinueNote: () => goals.autoContinueNote(),
		getEdgeGrants: () => edgeIntent.getRunEdgeGrants(),
		applyPathAliases: (messages) => pipeline.applyPathAliases(messages),
	});
	return { controller, returnBrief };
}

/** The observation count a lesson carries. Skill updates are never observation-counted, so they count 0. */
function observedCountOf(agentDir: string, lesson: LessonCandidate): number {
	if (lesson.layer === "skill") return 0;
	return ObservationStore.forAgentDir(agentDir, { readOnly: true }).get(observationKey(lesson.layer, lesson.summary));
}

/**
 * The lesson router of one apply batch (`applyAutoLearnProposals`). Each lesson is routed by System One's atomic judgments,
 * one boolean question per call, and a judgment System One cannot answer is `open`. Undefined where no System One engine is
 * bound, and then nothing is routed.
 */
export function createLessonRoutePort(owners: {
	readonly agentDir: () => string;
	readonly engine: () => SemanticDecisionEngine | undefined;
}): AutoLearnApplyPorts["routeLesson"] {
	const engine = owners.engine();
	if (engine === undefined) return undefined;
	const judge: LessonJudge = {
		async noul(question, context, signal) {
			try {
				const program = createDecisionProgram({
					id: "auto-learn-lesson-route",
					decisions: [{ kind: "boolean", id: "judgment", instruction: question }],
				});
				const evaluation = await engine.evaluate(
					program,
					{ lesson: context },
					{ signal, consequence: "low", occupancy: "background" },
				);
				const probability = noulProbability((evaluation.results as Readonly<Record<string, unknown>>).judgment);
				return probability === undefined
					? { error: "System One returned no probability for the lesson judgment" }
					: { probability };
			} catch (error) {
				signal?.throwIfAborted();
				return { error: error instanceof Error ? error.message : String(error) };
			}
		},
	};
	return (lesson, facts) => {
		const agentDir = owners.agentDir();
		return routeLesson({
			agentDir,
			candidate: lesson,
			facts: {
				observedCount: observedCountOf(agentDir, lesson),
				skillLoadedThisSession: facts.skillLoadedThisSession,
			},
			judge,
			now: Date.now(),
		});
	};
}

/**
 * The writes a session makes into its goal state from its workers' proof: the evidence an accepted claim gives, and the
 * result of the host's own requirement check. A write that fails is reported as a warning, so a saved claim never reports
 * itself unsaved and a passing check never fails the attempt that ran it.
 */
export function createGoalProofWrites(deps: {
	getGoalState(): GoalState | undefined;
	saveGoalState(state: GoalState, expected: GoalStateRevision): string;
	getTaskRuntimeSnapshot(): TaskRuntimeProjection | undefined;
	getWorkerClaimSnapshots(): readonly WorkerClaim[];
	warn(message: string): void;
}): {
	/** Makes accepted worker proof citable by the goal's completion account, after every claim save and review acknowledgement. */
	recordAcceptedWorkerEvidence(): void;
	/** Records the host's own check as the goal's proof: a check that passed satisfies its requirement. */
	recordRequirementCheckProof(attemptId: string, requirementId: string, result: RequirementCheckResult): void;
} {
	const guarded = (failure: string, write: () => void): void => {
		try {
			write();
		} catch (error) {
			deps.warn(`${failure}: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
	return {
		recordAcceptedWorkerEvidence: () =>
			guarded("Worker evidence for the goal was not recorded", () =>
				recordAcceptedWorkerRequirementEvidence({
					getGoalState: deps.getGoalState,
					saveGoalState: deps.saveGoalState,
					getTaskRuntimeSnapshot: deps.getTaskRuntimeSnapshot,
					getWorkerClaimSnapshots: deps.getWorkerClaimSnapshots,
				}),
			),
		recordRequirementCheckProof: (attemptId, requirementId, result) =>
			guarded("The host check's proof for a goal requirement was not recorded", () =>
				recordHostRequirementCheckProof(deps, { attemptId, requirementId, result }),
			),
	};
}
