/**
 * Assembly and joined shutdown owner for a session's routine runtime: the scheduler that dispatches saved routines, the session
 * that saves them from the routine tool and the host, automatic intake of the owner's words, and the watch monitor, each wired to
 * the session's ports.
 * A routine's result is delivered to its parent through the same parent-input port as every other note, and its workers start
 * through the worker runtime. The coordinator supplies the runtime and the operator sends through its host port and keeps the
 * routine state and the start of the runtime to itself.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Api, Model } from "@caupulican/pi-ai";
import { thirdPartyProtectedWritePaths } from "../autonomy/lane-private-paths.ts";
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
import type { ParentInputDelivery } from "../parent-input-delivery.ts";
import { findSteeredDelivery } from "../parent-input-steer.ts";
import { rollingDayWindow } from "../proactivity/proactivity-controller.ts";
import type { RoutineDelivery } from "./routine-contract.ts";
import { RoutineIntake } from "./routine-intake.ts";
import { routineOriginReach } from "./routine-origin-reach.ts";
import {
	isCarriedRoutineCompletion,
	ROUTINE_COMPLETION_TYPE,
	ROUTINE_RESULT_WAKES_HOLD,
	routineParentInput,
	routineResultIsQuiet,
} from "./routine-parent-input.ts";
import { routineRunOpener } from "./routine-run-opener.ts";
import type { RoutineHostEventPort } from "./routine-scheduler-controller.ts";
import {
	RoutineSchedulerController,
	routineCiWorkflowPaths,
	routineEventAnchor,
	routineWorkerRequest,
} from "./routine-scheduler-controller.ts";
import { RoutineSessionController } from "./routine-session-controller.ts";
import { routineWakeAddress } from "./routine-wake-address.ts";
import { RoutineWatchMonitor, type WatchFailing } from "./routine-watch-monitor.ts";
import { isOneShotWatch, routineWakeText, watchFailingWakeText } from "./routine-watch-wake.ts";
import { RoutineWorkerExecutor } from "./routine-worker-executor.ts";
import {
	WORKER_WAKE_PLAN_CHARS,
	WORKER_WAKE_RETRY_MS,
	type WorkerWakeHost,
	wakeWorkerRuntime,
} from "./routine-worker-wake.ts";
import type { TaskWatchPort } from "./task-watch-tool.ts";
import { WatchAdmission } from "./watch-admission.ts";
import { WatchSampler } from "./watch-evaluators.ts";
import { workerRuntimeCarriesThirdPartyWords, workerRuntimeLive } from "./worker-watch-liveness.ts";

/** The routine runtime one session holds: built once, started with the session's inputs, closed when the session disposes. */
export interface RoutineRuntime {
	readonly scheduler: RoutineSchedulerController;
	readonly session: RoutineSessionController;
	readonly intake: RoutineIntake;
	readonly watches: RoutineWatchMonitor;
	stop(): Promise<void>;
}

/** What the assembly reads from and asks of the coordinator: the worker runtime, the lifecycle and the operator sends. */
export interface RoutineAssemblyHost {
	workerController(): Pick<WorkerDelegationController, "startSavedIntent" | "captureSavedIntent" | "getAgentControl">;
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

	/** The watch a worker runtime arms through: this session's routine runtime, which holds the worker's bounds and its wake address. */
	taskWatches(runtime: () => RoutineRuntime | undefined): TaskWatchPort {
		return {
			available: () => runtime() !== undefined,
			arm: async (worker, input, signal) => {
				const routines = runtime();
				if (!routines) throw new Error("Routines are unavailable in this session.");
				return routines.session.armForWorker(worker, input, signal);
			},
		};
	}

	/** What waking a worker runtime reads and asks of the worker runtime: its durable task state and the session root's follow-up. */
	private workerWakeHost(): WorkerWakeHost {
		return {
			snapshot: () => this.host.workerLifecycle().getTaskRuntimeSnapshot(),
			followUp: (runtimeId, text, idempotencyKey) =>
				this.host
					.workerController()
					.getAgentControl()
					.followUpSessionRootWorkerAgent(runtimeId, text, { idempotencyKey }),
		};
	}

	/**
	 * One wake of the session itself, as a routine-completion parent input in steer mode (a running turn reads it at its next
	 * model step, an idle session starts a turn): what a failing watch tells its armer, and what a worker's watch delivers when
	 * its worker cannot take the wake (the event is not lost).
	 */
	private sessionWake(deliveryId: string, content: string, details: unknown): ParentInputDelivery {
		return {
			deliveryId,
			payloadDigest: createHash("sha256").update(content).digest("hex"),
			message: { customType: ROUTINE_COMPLETION_TYPE, display: true, content, details },
			origin: captureWorkerReceiptOrigin(this.deps.getSessionManager()),
			mode: "steer",
		};
	}

	private workerUnreachable(runtimeId: string, reason: string): string {
		return `Worker ${runtimeId} armed this watch but could not be woken by it (${reason}), so it reaches you instead: act on it, or pass it to the worker yourself.`;
	}

	/**
	 * Delivers a watch event to the worker runtime that armed it. A runtime that is gone settles without a wake. One that
	 * does not take it now is retried for {@link WORKER_WAKE_RETRY_MS}, then the session is woken with the event instead, so
	 * a stuck worker never holds the deliveries behind it and the event is never lost.
	 */
	private async deliverToWorker(runtimeId: string, delivery: RoutineDelivery): Promise<{ entryId: string }> {
		const input = routineParentInput(delivery);
		const wake = wakeWorkerRuntime(
			this.workerWakeHost(),
			runtimeId,
			routineWakeText(delivery, false, WORKER_WAKE_PLAN_CHARS),
			input.deliveryId,
		);
		if (wake.kind === "sent") return { entryId: `worker-message:${wake.messageId}` };
		if (wake.kind === "void") return { entryId: `worker-unwoken:${input.deliveryId}` };
		if (this.deps.getTimers().port("routines").now() - delivery.occurrence.createdAt < WORKER_WAKE_RETRY_MS)
			throw new Error(`Worker ${runtimeId} could not take the watch wake now (${wake.reason}); it is tried again.`);
		return this.deps.deliverParentInput(
			this.sessionWake(
				`${input.deliveryId}:session`,
				`${this.workerUnreachable(runtimeId, wake.reason)}\n${routineWakeText(delivery)}`,
				input.message.details,
			),
		);
	}

	/**
	 * Tells the armer of a watch that its checks keep failing, as one more wake (a session's parent input, a worker's message).
	 * The delivery is keyed by the watch's incarnation, its firing count and the words, so a restart that finds the same failure
	 * tells the armer nothing twice. It is not a routine result, so the day's wake bound does not hold it.
	 */
	private reportWatchFailing(store: PersistentBotTeamStore, failing: WatchFailing): void {
		const routine = store.getRoutine(failing.routineId);
		const address = routine && routineWakeAddress(routine);
		if (!routine || !address || routine.incarnationId !== failing.incarnationId) return;
		const text = watchFailingWakeText(routine, failing.failures, failing.reason);
		const fires = routine.cursor.kind === "watch" ? routine.cursor.fires : 0;
		const deliveryId = `watch-failing:${createHash("sha256")
			.update(JSON.stringify([routine.incarnationId, fires, text]))
			.digest("hex")}`;
		const details = { routineId: routine.routineId, routineRevision: routine.revision, failing: true as const };
		let content = text;
		if (address.kind === "worker") {
			const wake = wakeWorkerRuntime(
				this.workerWakeHost(),
				address.runtimeId,
				watchFailingWakeText(routine, failing.failures, failing.reason, WORKER_WAKE_PLAN_CHARS),
				deliveryId,
			);
			if (wake.kind !== "refused") return;
			content = `${this.workerUnreachable(address.runtimeId, wake.reason)}\n${text}`;
		}
		this.deps
			.deliverParentInput(this.sessionWake(deliveryId, content, details))
			.catch((error: unknown) =>
				this.host.warn(
					`Watch ${routine.routineId} is failing and its armer could not be told: ${error instanceof Error ? error.message : String(error)}`,
				),
			);
	}

	/** Builds the routine runtime of this session's store: the scheduler, the routine tool's session, intake and the watch monitor. */
	assemble(store: PersistentBotTeamStore): RoutineRuntime {
		const parentSessionId = this.deps.getSessionId();
		const canUseOrigin = (origin: WorkerReceiptOrigin): boolean =>
			routineOriginReach(this.deps.getSessionManager(), origin) === "usable";
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
			workerRuntimeLive: (runtimeId) =>
				workerRuntimeLive(this.host.workerLifecycle().getTaskRuntimeSnapshot(), runtimeId),
			delivery: {
				deliver: async (delivery) => {
					const { occurrence } = delivery;
					const address = routineWakeAddress(occurrence.definition);
					if (address?.kind === "worker") return this.deliverToWorker(address.runtimeId, delivery);
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
					// A one-shot watch is bounded by its slots and its deadline: its wake is never held by the day's bound.
					if (isOneShotWatch(occurrence.definition.schedule)) return this.deps.deliverParentInput(input);
					const manager = this.deps.getSessionManager();
					// A replay repeats the saved mode, so a saved or steered delivery is never measured again.
					const saved = manager.getParentInput(input.deliveryId);
					let held = saved !== undefined && saved.metadata.mode === "next-owner-turn";
					if (!saved && !findSteeredDelivery(manager, input.deliveryId)) {
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
				findCarriedQuietResult: ({ occurrence, result }) =>
					routineResultIsQuiet(result) ? this.findCarriedRoutineResult(occurrence.routineId, "quiet") : undefined,
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
				originLoss: (origin) => {
					const reach = routineOriginReach(this.deps.getSessionManager(), origin);
					return reach === "usable" || reach === "waiting" ? undefined : reach;
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
			getEdgeGrants: (standingOnly) => this.deps.getEdgeGrants?.(standingOnly) ?? [],
			getEdgeMode: () => this.deps.getSettingsManager().getEdgeSettings().mode,
			getDenyCommands: () => this.deps.getSettingsManager().getEdgeSettings().deny,
			localCommitBranch: () => this.deps.localCommitBranch?.(),
			workerCarriesThirdPartyWords: (runtimeId) =>
				workerRuntimeCarriesThirdPartyWords(this.host.workerLifecycle().getTaskRuntimeSnapshot(), runtimeId),
			thirdPartyProtectedWrites: (cwd) =>
				thirdPartyProtectedWritePaths(cwd, this.deps.getAgentDir(), this.deps.getSessionManager()),
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
			onFailing: (failing) => this.reportWatchFailing(store, failing),
			timers: routineTimers,
			agentDir: () => this.deps.getAgentDir(),
			isDisposed: () => this.deps.isDisposed(),
			warn: (message) => this.host.warn(message),
		});
		const session = new RoutineSessionController({
			store,
			scheduler,
			parentSessionId,
			admitWatch: (condition, worker) => watchAdmission.admit(condition, worker),
			admitSubCall: (parentId, call, signal) => this.deps.admitNestedToolCall(parentId, call, signal),
			holdsTool: (toolName) => this.deps.getForegroundToolNames().includes(toolName),
			capture: (request, signal) => this.host.workerController().captureSavedIntent(request, signal),
			captureOrigin: () => captureWorkerReceiptOrigin(this.deps.getSessionManager()),
			invocationKey: (callId) => this.deps.getToolInvocationKey(callId, "routine"),
			eventAnchor: () => routineEventAnchor(this.host.workerLifecycle().getTaskRuntimeSnapshot()),
			ownerTurnSources: () => this.deps.getOwnerEvidence().currentTurnSources(),
			runOpener: () => routineRunOpener(this.deps.getSessionManager().getBranch(), this.deps.getGoalStateSnapshot()),
			warnOwner: (message) => this.host.warn(message),
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
		let shutdown: Promise<void> | undefined;
		const stop = (): Promise<void> => {
			if (shutdown) return shutdown;
			let complete!: () => void;
			let fail!: (error: unknown) => void;
			shutdown = new Promise<void>((resolve, reject) => {
				complete = resolve;
				fail = reject;
			});
			const start = (label: string, operation: () => void | Promise<void>): Promise<void> => {
				try {
					return Promise.resolve(operation());
				} catch (error) {
					try {
						this.host.warn(`Failed to ${label}: ${error instanceof Error ? error.message : String(error)}`);
					} catch {
						/* Shutdown diagnostics have no lifecycle authority. */
					}
					return Promise.resolve().then(() => {
						throw error;
					});
				}
			};
			const completions = [
				start("stop routine watches", () => watches.dispose()),
				start("stop routine scheduler", () => scheduler.close()),
				start("stop routine intake", () => intake.stop()),
			];
			void Promise.allSettled(completions).then((settled) => {
				const failures = settled.flatMap((entry) => (entry.status === "rejected" ? [entry.reason] : []));
				if (failures.length === 0) complete();
				else fail(new AggregateError(failures, "Routine runtime shutdown failed"));
			});
			return shutdown;
		};
		return { scheduler, session, intake, watches, stop };
	}
}
