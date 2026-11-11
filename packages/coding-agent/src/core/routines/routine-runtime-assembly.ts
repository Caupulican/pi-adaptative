/**
 * Assembly of a session's routine runtime: the scheduler that dispatches saved routines, the session that saves them from the
 * routine tool and the host, automatic intake of the owner's words, and the watch monitor, each wired to the session's ports.
 * A routine's result is delivered to its parent through the same parent-input port as every other note, and its workers start
 * through the worker runtime. The coordinator supplies the runtime and the operator sends through its host port and keeps the
 * routine state and the start of the runtime to itself.
 */
import { randomUUID } from "node:crypto";
import type { Api, Model } from "@caupulican/pi-ai";
import type { BackgroundLaneControllerDeps } from "../background-lane-deps.ts";
import { sessionSemanticUsageOf } from "../cost/semantic-usage-delivery.ts";
import type {
	BotOperatorMessageDispatchResult,
	PersistentBotTeamStore,
	TeamOperatorMessageDispatchResult,
} from "../delegation/persistent-bot-team-store.ts";
import type { WorkerDelegationController } from "../delegation/worker-delegation-controller.ts";
import type { WorkerLifecycle } from "../delegation/worker-lifecycle.ts";
import { captureWorkerReceiptOrigin } from "../delegation/worker-receipt-origin.ts";
import type { WorkerReceiptOrigin } from "../orchestration/worker-receipt-origin.ts";
import { rollingDayWindow } from "../proactivity/proactivity-controller.ts";
import { isSessionAppendAnchorCurrent } from "../session-snapshot.ts";
import { RoutineIntake } from "./routine-intake.ts";
import { isCarriedRoutineCompletion, ROUTINE_RESULT_WAKES_HOLD, routineParentInput } from "./routine-parent-input.ts";
import type { RoutineHostEventPort } from "./routine-scheduler-controller.ts";
import {
	RoutineSchedulerController,
	routineCiWorkflowPaths,
	routineEventAnchor,
	routineWorkerRequest,
} from "./routine-scheduler-controller.ts";
import { RoutineSessionController } from "./routine-session-controller.ts";
import { RoutineWatchMonitor } from "./routine-watch-monitor.ts";
import { RoutineWorkerExecutor } from "./routine-worker-executor.ts";
import { WatchAdmission } from "./watch-admission.ts";
import { WatchSampler } from "./watch-evaluators.ts";

/** The routine runtime one session holds: built once, started with the session's inputs, closed when the session disposes. */
export interface RoutineRuntime {
	readonly scheduler: RoutineSchedulerController;
	readonly session: RoutineSessionController;
	readonly intake: RoutineIntake;
	readonly watches: RoutineWatchMonitor;
}

/** What the assembly reads from and asks of the coordinator: the worker runtime, the lifecycle and the operator sends. */
export interface RoutineAssemblyHost {
	workerController(): Pick<WorkerDelegationController, "startSavedIntent" | "captureSavedIntent">;
	workerLifecycle(): WorkerLifecycle;
	parentWriteHolds(): ReadonlySet<string>;
	landRecordedParentWrites(lifecycle: WorkerLifecycle): void;
	hostEventFeed(): RoutineHostEventPort;
	subscribeStateChanges(listener: () => void): () => void;
	subscribeOrchestrationStore(listener: () => void): () => void;
	sendOperatorMessageToBot(agentId: string, message: string): Promise<BotOperatorMessageDispatchResult>;
	sendOperatorMessageToTeam(teamId: string, message: string): Promise<TeamOperatorMessageDispatchResult>;
	resolveLaneModel(configuredPattern: string | undefined): Model<Api> | undefined;
	warn(message: string): void;
}

/** Builds the routine runtime of a session from its deps and host ports; the coordinator decides when it is built and started. */
export class RoutineRuntimeAssembly {
	private readonly deps: BackgroundLaneControllerDeps;
	private readonly host: RoutineAssemblyHost;

	constructor(deps: BackgroundLaneControllerDeps, host: RoutineAssemblyHost) {
		this.deps = deps;
		this.host = host;
	}

	/**
	 * A guard captured now that throws `message` once the session's branch moved, the session was replaced or disposed, or
	 * `stillValid` no longer holds: what a routine origin or an intake decision is checked against before it is saved.
	 */
	private sessionBranchGuard(message: string, stillValid: () => boolean = () => true): () => void {
		const manager = this.deps.getSessionManager();
		const assertBranch = manager.captureBranchContext();
		return () => {
			assertBranch();
			if (this.deps.isDisposed() || this.deps.getSessionManager() !== manager || !stillValid())
				throw new Error(message);
		};
	}

	/** The parent input still carrying an earlier result of this routine, quiet or held, to the owner's next turn. */
	private findCarriedRoutineResult(routineId: string, cause: "quiet" | "held"): { entryId: string } | undefined {
		const manager = this.deps.getSessionManager();
		const carried = manager
			.getPendingParentInputs("next-owner-turn")
			.find((input) => isCarriedRoutineCompletion(manager.getEntry(input.entryId), routineId, cause));
		return carried ? { entryId: carried.entryId } : undefined;
	}

	/** Builds the routine runtime of this session's store: the scheduler, the routine tool's session, intake and the watch monitor. */
	assemble(store: PersistentBotTeamStore): RoutineRuntime {
		const parentSessionId = this.deps.getSessionId();
		const canUseOrigin = (origin: WorkerReceiptOrigin): boolean => {
			const manager = this.deps.getSessionManager();
			return (
				origin.sessionId === manager.getSessionId() &&
				(manager.isPersisted()
					? Boolean(manager.getSessionFile()) &&
						(origin.sessionFile === undefined || origin.sessionFile === manager.getSessionFile())
					: origin.sessionFile === undefined) &&
				!manager.isPersistenceStateUncertain() &&
				isSessionAppendAnchorCurrent(manager, origin) &&
				Boolean(origin.leafId && manager.isEntryDurableForSession(origin.leafId))
			);
		};
		const worker = new RoutineWorkerExecutor({
			getSnapshot: () => {
				this.host.workerController();
				return this.host.workerLifecycle().getTaskRuntimeSnapshot();
			},
			start: (input, signal) => this.host.workerController().startSavedIntent(input, signal),
		});
		const scheduler = new RoutineSchedulerController({
			store,
			worker,
			parentSessionId,
			owner: randomUUID(),
			timers: this.deps.getTimers().port("routines"),
			isDisposed: () => this.deps.isDisposed(),
			canDispatch: () => this.deps.isDelegateToolActive(),
			getReceiptOrigin: () => captureWorkerReceiptOrigin(this.deps.getSessionManager()),
			canUseOrigin,
			captureOriginGuard: (origin) =>
				this.sessionBranchGuard("Routine origin is not on the current durable parent branch.", () =>
					canUseOrigin(origin),
				),
			subscribeContext: (listener) => this.deps.subscribeForegroundActivity(listener),
			subscribeExecution: (listener) => this.host.subscribeOrchestrationStore(listener),
			hostEvents: this.host.hostEventFeed(),
			subscribeCapacity: (listener) => this.host.subscribeStateChanges(listener),
			delivery: {
				deliver: async (delivery) => {
					const { occurrence } = delivery;
					const intent = occurrence.definition.executionSnapshot?.savedIntent;
					// A run away recorded its claims for this parent; they explain its result, so they land first, and the
					// result waits while one cannot land yet. A run of this session wrote its claims itself.
					if (occurrence.executor === "away" && occurrence.dispatchKey && intent) {
						const attemptIds = worker.notificationAttemptIds(
							routineWorkerRequest(occurrence, intent, occurrence.dispatchKey),
						);
						this.host.landRecordedParentWrites(this.host.workerLifecycle());
						for (const attemptId of attemptIds)
							if (this.host.parentWriteHolds().has(attemptId))
								throw new Error("Routine result is waiting for the claims its run recorded away to land.");
					}
					const input = routineParentInput(delivery);
					// Quiet results and expiry notices already ride with the owner's next turn and never count as wakes.
					if (input.mode === "next-owner-turn") return this.deps.deliverParentInput(input);
					const manager = this.deps.getSessionManager();
					// A replay repeats the saved mode, so a saved delivery is never measured again.
					const saved = manager.getParentInput(input.deliveryId);
					let held = saved !== undefined && saved.metadata.mode === "next-owner-turn";
					if (!saved) {
						const day = await this.deps.aggregateUsageWindow(rollingDayWindow(Date.now()));
						const bound = this.deps.getSettingsManager().getRoutinesSettings().maxResultWakesPerDay;
						held = day.routineResultTurnWakes >= bound;
						if (held) {
							this.deps.observeHarnessNotice?.("routine-result-wakes", () => ({
								reason: ROUTINE_RESULT_WAKES_HOLD,
								text: `Routine results started ${bound} parent turns in the last 24 hours, the routines.maxResultWakesPerDay bound; later results wait for the owner's next turn until the day has room. Raising the setting lets more start turns.`,
							}));
							// One held result of a routine is carried at a time; later ones are recorded against it.
							const carried = this.findCarriedRoutineResult(delivery.occurrence.routineId, "held");
							if (carried) return carried;
						} else this.deps.observeHarnessNotice?.("routine-result-wakes", () => "clear");
					}
					return this.deps.deliverParentInput(held ? routineParentInput(delivery, true) : input);
				},
				findCarriedQuietResult: (routineId) => this.findCarriedRoutineResult(routineId, "quiet"),
				acknowledgeWorkerNotification: (occurrence) => {
					if (occurrence.target.kind !== "session" || !occurrence.dispatchKey) return;
					const intent = occurrence.definition.executionSnapshot?.savedIntent;
					if (!intent) return;
					const attemptIds = worker.notificationAttemptIds(
						routineWorkerRequest(occurrence, intent, occurrence.dispatchKey),
					);
					const lifecycle = this.host.workerLifecycle();
					const ids: string[] = [];
					for (const attemptId of attemptIds) {
						const notification = lifecycle.getAttemptTerminalNotification(attemptId);
						if (!notification) throw new Error("Routine completion is waiting for its native terminal receipt.");
						if (notification.status === "pending") ids.push(notification.notificationId);
					}
					lifecycle.markNotificationsDelivered(ids);
				},
				noticeRoutineState: (kind, routineId, notice) =>
					this.deps.observeHarnessNotice?.(kind, () => ({ scope: routineId, state: notice ?? "clear" })),
			},
			dispatchMessage: async (occurrence) => {
				if (occurrence.target.kind === "bot") {
					const result = await this.host.sendOperatorMessageToBot(
						occurrence.target.agentId,
						occurrence.definition.prompt,
					);
					return `Prompt accepted by bot ${occurrence.target.agentId} (${result.mode}); worker completion is tracked separately.`;
				}
				if (occurrence.target.kind === "team") {
					const result = await this.host.sendOperatorMessageToTeam(
						occurrence.target.teamId,
						occurrence.definition.prompt,
					);
					return `Prompt accepted for ${result.deliveries.length} team deliveries; worker completion is tracked separately.`;
				}
				throw new Error("Session routines require the native worker executor.");
			},
			warn: (message) => this.host.warn(message),
		});
		// One admission serves a watch when it is saved and at every evaluation, so a saved watch never runs with more
		// authority than the session has now.
		const watchAdmission = new WatchAdmission({
			getCwd: () => this.deps.getCwd(),
			getAgentDir: () => this.deps.getAgentDir(),
			getCapabilityEnvelope: () => this.deps.getCapabilityEnvelope(),
			getCredentialExposureBoundary: () => this.deps.getCredentialExposureBoundary?.(),
			getEdgeGrants: () => this.deps.getEdgeGrants?.() ?? [],
			getEdgeMode: () => this.deps.getSettingsManager().getEdgeSettings().mode,
			getDenyCommands: () => this.deps.getSettingsManager().getEdgeSettings().deny,
		});
		const routineTimers = this.deps.getTimers().port("routines");
		const watches = new RoutineWatchMonitor({
			store,
			sampler: new WatchSampler({
				admission: watchAdmission,
				agentDir: () => this.deps.getAgentDir(),
				now: () => routineTimers.now(),
			}),
			parentSessionId,
			timers: routineTimers,
			agentDir: () => this.deps.getAgentDir(),
			isDisposed: () => this.deps.isDisposed(),
			warn: (message) => this.host.warn(message),
		});
		const session = new RoutineSessionController({
			store,
			scheduler,
			parentSessionId,
			admitWatch: (condition) => watchAdmission.admit(condition),
			capture: (request, signal) => this.host.workerController().captureSavedIntent(request, signal),
			invocationKey: (callId) => this.deps.getToolInvocationKey(callId, "routine"),
			eventAnchor: () => routineEventAnchor(this.host.workerLifecycle().getTaskRuntimeSnapshot()),
			ownerTurnSources: () => this.deps.getOwnerEvidence().currentTurnSources(),
			now: () => this.deps.getTimers().port("routines").now(),
			isDisposed: () => this.deps.isDisposed(),
		});
		const intake = new RoutineIntake({
			parentSessionId,
			store,
			routines: session,
			evidence: this.deps.getOwnerEvidence(),
			time: this.deps.getTimers().port("routine-intake"),
			hostInactiveReason: () => {
				const manager = this.deps.getSessionManager();
				if (!manager.isPersisted() || !manager.getSessionFile()) return "ephemeral_session";
				return this.deps.getSettingsManager().getRoutinesSettings().automaticIntake ? undefined : "disabled";
			},
			model: () => this.host.resolveLaneModel(undefined),
			systemOne: () => this.deps.systemOne.recordingSemanticEngine(),
			usageOwner: () => sessionSemanticUsageOf(this.deps.getSessionManager()),
			maxEstimatedUsd: () => this.deps.getCapabilityEnvelope()?.maxEstimatedUsd,
			isForegroundBusy: () => this.deps.isForegroundBusy(),
			subscribeActivity: (listener) => this.deps.subscribeForegroundActivity(listener),
			captureOrigin: () => captureWorkerReceiptOrigin(this.deps.getSessionManager()),
			captureBranchGuard: () =>
				this.sessionBranchGuard("Routine intake session changed before its decision was saved."),
			deliver: (notice, signal) => this.deps.deliverNotes(notice, { signal }),
			isDelivered: (deliveryId) => this.deps.getSessionManager().getParentInput(deliveryId) !== undefined,
			observeHarnessNotice: (kind, read) => this.deps.observeHarnessNotice?.(kind, read),
			runIsolatedCompletion: (options) => this.deps.runIsolatedCompletion(options),
			ciWorkflowPaths: () => {
				const lifecycle = this.host.workerLifecycle();
				const events = lifecycle.ledger.runtime.hostEvents;
				return routineCiWorkflowPaths(lifecycle.getTaskRuntimeSnapshot(), (sourceId) =>
					events.isSourceReady(sourceId),
				);
			},
			warn: (message) => this.host.warn(message),
		});
		return { scheduler, session, intake, watches };
	}
}
