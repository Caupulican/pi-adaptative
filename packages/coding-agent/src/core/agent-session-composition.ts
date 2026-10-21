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
} from "@caupulican/pi-ai";
import type { Agent } from "../kernel/agent.ts";
import type { SessionManager } from "../kernel/session/session-manager.ts";
import type { AgentMessage } from "../kernel/types.ts";
import { ExternalCapabilityAcquisitionGate } from "./acquisition/external-capability-acquisition-gate.ts";
import type { AdaptiveCapabilityController } from "./adaptive/adaptive-capability-controller.ts";
import type { AdaptiveRuntimeReadiness } from "./adaptive/adaptive-runtime-readiness.ts";
import type { AgentSessionEvent } from "./agent-session-contracts.ts";
import type { CapabilityEnvelope } from "./autonomy/contracts.ts";
import type { EdgeGrantView } from "./autonomy/edge-policy.ts";
import type { ExecutionCharter } from "./autonomy/execution-charter.ts";
import { formatForegroundEnvelopeObservation } from "./autonomy/foreground-envelope.ts";
import type { LaneRecord } from "./autonomy/lane-tracker.ts";
import type { BackgroundLaneController } from "./background-lane-controller.ts";
import type { BashExecutionController } from "./bash-execution-controller.ts";
import type { createRetentionDecisionEngine } from "./compaction/retention-decision-engine.ts";
import type { CurationTelemetrySnapshot } from "./context/brain-curator.ts";
import { buildContextCompositionReport, type ContextCompositionReport } from "./context/context-composition.ts";
import type { PromptEnforcementReport } from "./context/context-prompt-enforcement.ts";
import { CONTEXT_VISIBILITY_LONG_CHARS, CONTEXT_VISIBILITY_SHORT_CHARS } from "./context/context-query-visibility.ts";
import type { MemoryPromptInclusionReport } from "./context/memory-diagnostics.ts";
import type { ContextGcResult } from "./context-gc.ts";
import type { SpawnedUsageTotals } from "./cost/usage-records.ts";
import type { SemanticDecisionEngine } from "./decision/engine.ts";
import type { ExpertSelectionService } from "./expert-routing/service.ts";
import type { ContextUsage } from "./extensions/index.ts";
import type { GoalStateRevision } from "./goals/goal-lifecycle.ts";
import type { GoalRuntimeSnapshot, GoalRuntimeSnapshotSettings } from "./goals/goal-runtime-snapshot.ts";
import type { GoalSessionController } from "./goals/goal-session-controller.ts";
import type { GoalState } from "./goals/goal-state.ts";
import { proveRequirementChecks } from "./goals/prove-requirement-checks.ts";
import { runRequirementCheck } from "./goals/requirement-checks.ts";
import { getResumableHumanInputSnapshot } from "./human-input.ts";
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
import type { ProfileFilterController } from "./profile-filter-controller.ts";
import type { DurableOwnerRuleStore } from "./project-rules/durable-owner-rules.ts";
import {
	PROJECT_RULE_REPAIR_CUSTOM_TYPE,
	SessionProjectRules,
	type TrustedRuleSource,
} from "./project-rules/session-project-rules.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import type { RuntimeBuilder } from "./runtime-builder.ts";
import type { SessionWorkState } from "./session-work-state.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { SkillVaultController } from "./skill-vault.ts";
import type { SystemOneSteeringPlane } from "./steering/system-one-steering-plane.ts";
import { WorkerSemanticSupervisor } from "./supervision/worker-semantic-supervisor.ts";
import { WorkerSupervisionCoordinator } from "./supervision/worker-supervision-coordinator.ts";
import { sameLaneVerificationDirective } from "./system-one/control-directive.ts";
import type { SystemOneController } from "./system-one/controller.ts";
import type { SystemOneWorkerControl } from "./system-one/worker-control.ts";

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
	getDecisionEngine(): SemanticDecisionEngine | undefined;
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
		getDecisionEngine: () => deps.getDecisionEngine(),
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
	readonly delegatePromptGuidelineWarnings: readonly string[];
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
	const gcResult = deps.applyContextGc(rawMessages, false, 0);
	const requestMessages = gcResult.messages;
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
	return buildContextCompositionReport({
		systemPrompt: requestSystemPrompt ?? "",
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
			...deps.delegatePromptGuidelineWarnings,
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
		deps.agent.state.messages.push(message);
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
