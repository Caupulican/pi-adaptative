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
import type { TurnOriginRecord } from "../../kernel/turn-origin-stamp.ts";
import { thirdPartyProtectedWritePaths } from "../autonomy/lane-private-paths.ts";
import type { BackgroundLaneControllerDeps } from "../background-lane-deps.ts";
import { botInboxStopWaiting } from "../bots/bot-inbox.ts";
import { sessionSemanticUsageOf } from "../cost/semantic-usage-delivery.ts";
import type {
	BotOperatorMessageDispatchResult,
	BotOperatorMessageOptions,
} from "../delegation/bot-operator-message-options.ts";
import { BotUnreachableError } from "../delegation/bot-unreachable.ts";
import type {
	PersistentBotTeamStore,
	TeamOperatorMessageDispatchResult,
} from "../delegation/persistent-bot-team-store.ts";
import type { WorkerDelegationController } from "../delegation/worker-delegation-controller.ts";
import type { WorkerLifecycle } from "../delegation/worker-lifecycle.ts";
import { captureWorkerReceiptOrigin } from "../delegation/worker-receipt-origin.ts";
import { type HarnessNotice, wordedNotice } from "../harness-notice.ts";
import { envelopeCeilingUsd } from "../orchestration/risk-budget.ts";
import type { WorkerReceiptOrigin } from "../orchestration/worker-receipt-origin.ts";
import type { ParentInputDelivery } from "../parent-input-delivery.ts";
import { findSteeredDelivery } from "../parent-input-steer.ts";
import { rollingDayWindow } from "../proactivity/proactivity-controller.ts";
import { latestDecisiveEntry, turnAuthorityOf } from "../turn-origin.ts";
import { type GithubWatchLink, GithubWatchPoller } from "../watches/github-watch-poller.ts";
import {
	SessionWatchLedger,
	type SessionWatchServed,
	sessionWatchLedgerPath,
} from "../watches/session-watch-ledger.ts";
import { SessionWatchService } from "../watches/session-watch-service.ts";
import type { WatchAutoArmPort } from "../watches/watch-auto-arm.ts";
import type { SessionWatchPort } from "../watches/watch-tool.ts";
import { ROUTINE_FAILURE_PAUSE_THRESHOLD, type RoutineDelivery, type RoutineOccurrence } from "./routine-contract.ts";
import type { RoutineScope } from "./routine-holder.ts";
import { RoutineIntake } from "./routine-intake.ts";
import { routineOriginReach } from "./routine-origin-reach.ts";
import {
	deliverWhileOwed,
	deliverWhilePending,
	isCarriedRoutineCompletion,
	ROUTINE_COMPLETION_TYPE,
	ROUTINE_RESULT_WAKES_HOLD,
	type RoutineDeliveryReceipt,
	routineBotMessageOrigin,
	routineParentInput,
	routineResultInputIds,
	routineResultIsQuiet,
} from "./routine-parent-input.ts";
import type { RoutineHostEventPort } from "./routine-scheduler-controller.ts";
import {
	RoutineSchedulerController,
	routineCiWorkflowPaths,
	routineEventAnchor,
	routineWorkerRequest,
} from "./routine-scheduler-controller.ts";
import { RoutineSessionController } from "./routine-session-controller.ts";
import type { RoutineMessageResult } from "./routine-store-port.ts";
import { TASK_WATCH_TOOL_NAME } from "./routine-tool-names.ts";
import { routineWakeAddress } from "./routine-wake-address.ts";
import { agentArmedWatchCount, heldWatchCount, workerArmedWatchCount } from "./routine-watch-arming.ts";
import {
	RoutineWatchMonitor,
	routineStoreWatches,
	type WatchFailing,
	type WatchObservationStore,
} from "./routine-watch-monitor.ts";
import {
	isOneShotWatch,
	routineWakeText,
	routineWatchCondition,
	routineWatchPlan,
	watchFailingWakeText,
} from "./routine-watch-wake.ts";
import { RoutineWorkerExecutor } from "./routine-worker-executor.ts";
import {
	WORKER_WAKE_PLAN_CHARS,
	WORKER_WAKE_RETRY_MS,
	type WorkerWakeHost,
	wakeWorkerRuntime,
	workerUnreachableLine,
} from "./routine-worker-wake.ts";
import type { TaskWatchPort } from "./task-watch-tool.ts";
import { WatchAdmission } from "./watch-admission.ts";
import type { WatchCheckAdmitter } from "./watch-check-admission.ts";
import type { WatchCondition } from "./watch-contract.ts";
import { WatchSampler } from "./watch-evaluators.ts";
import { workerRuntimeCarriesThirdPartyWords, workerRuntimeLive } from "./worker-watch-liveness.ts";
import type { WorkerWatchAuthority } from "./worker-watch-scope.ts";

/** The routine runtime one session holds: built once, started with the session's inputs, closed when the session disposes. */
export interface RoutineRuntime {
	readonly scheduler: RoutineSchedulerController;
	readonly session: RoutineSessionController;
	/** Absent in a bot's own session: it holds only the watches it arms, so no owner words become routines there. */
	readonly intake?: RoutineIntake;
	readonly watches: RoutineWatchMonitor;
	/** The session's own watches (`core/watches/`), and the monitor that samples them with the same samplers. */
	readonly sessionWatches: SessionWatchService;
	readonly sessionWatchMonitor: RoutineWatchMonitor;
	/** Reads the session's watches on typed GitHub sources through the host's {@link GithubWatchLink}. */
	readonly githubWatchPoller: GithubWatchPoller;
	/** The session's own watches as its `watch` tool (and a bot's own `task_watch`) reach them. */
	readonly watchPort: SessionWatchPort;
	/** The session's watches as the host arms them after its own calls: an `auto` armer that tells the owner each result. */
	readonly autoWatches: WatchAutoArmPort;
	stop(): Promise<void>;
}

/** What the assembly reads from and asks of the coordinator: the worker runtime, the lifecycle and the operator sends. */
export interface RoutineAssemblyHost {
	workerController(): Pick<
		WorkerDelegationController,
		"startSavedIntent" | "captureSavedIntent" | "getAgentControl" | "attemptIsMetered"
	>;
	workerLifecycle(): WorkerLifecycle;
	parentWriteHolds(): ReadonlySet<string>;
	landRecordedParentWrites(lifecycle: WorkerLifecycle): void;
	hostEventFeed(): RoutineHostEventPort;
	/** What the host offers the session's typed GitHub watches: its reader and its CI source (`github-watch-poller.ts`). */
	githubWatches(): GithubWatchLink;
	/** Tells the owner once per key on the phone (`OwnerPush.tell`). */
	tellOwner(key: string, text: string): void;
	subscribeStateChanges(listener: () => void): () => void;
	subscribeOrchestrationStore(listener: () => void): () => void;
	sendOperatorMessageToBot(
		agentId: string,
		message: string,
		options: BotOperatorMessageOptions,
	): Promise<BotOperatorMessageDispatchResult>;
	sendOperatorMessageToTeam(
		teamId: string,
		message: string,
		routine: TurnOriginRecord,
	): Promise<TeamOperatorMessageDispatchResult>;
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
	 * Sends a bot or group routine's prompt. A bot that is retired or missing takes no prompt (`bot-unreachable.ts`): the
	 * run failed, and the owner is told once, until a run reaches the bot again. A group run failed when no member took the
	 * prompt. Any other error leaves the run uncertain.
	 */
	private async dispatchRoutineMessage(occurrence: RoutineOccurrence): Promise<RoutineMessageResult> {
		const { target, routineId } = occurrence;
		const prompt = occurrence.definition.prompt;
		// A bot that answers in a session of its own takes the prompt there as its turn, under the routine's origin.
		const origin = routineBotMessageOrigin(occurrence, prompt);
		if (target.kind === "bot") {
			const notice = (state: HarnessNotice | "clear") =>
				this.deps.observeHarnessNotice?.("routine-bot-unreachable", () => ({ scope: routineId, state }));
			try {
				const result = await this.host.sendOperatorMessageToBot(target.agentId, prompt, { fromRoutine: origin });
				notice("clear");
				return {
					outcome: "succeeded",
					summary: `Prompt accepted by bot ${target.agentId} (${result.mode}); the bot's answer is not part of this run.`,
					facts: { reasonCode: "delivered" },
				};
			} catch (error) {
				if (!(error instanceof BotUnreachableError)) throw error;
				const { agentId, state } = error;
				notice(
					wordedNotice(`${routineId}:${agentId}:${state}`, (words) =>
						words.notices.routineStates.botUnreachable(
							routineId,
							agentId,
							state,
							ROUTINE_FAILURE_PAUSE_THRESHOLD,
						),
					),
				);
				return {
					outcome: "failed",
					summary: error.message,
					facts: { reasonCode: `bot_${state}`, step: "dispatch" },
				};
			}
		}
		if (target.kind === "team") {
			const { deliveries } = await this.host.sendOperatorMessageToTeam(target.teamId, prompt, origin);
			const failed = deliveries.filter((delivery) => delivery.outcome === "failed");
			const why = failed.map((delivery) => `${delivery.agentId}: ${delivery.detail ?? "not delivered"}`).join("; ");
			if (failed.length === deliveries.length)
				return {
					outcome: "failed",
					summary: `No member of group ${target.teamId} took the prompt (${why}).`,
					facts: { reasonCode: "team_undelivered", step: "dispatch" },
				};
			const accepted = deliveries.length - failed.length;
			return {
				outcome: "succeeded",
				summary: `Prompt accepted for ${accepted} of ${deliveries.length} team deliveries${failed.length > 0 ? ` (not delivered: ${why})` : ""}; the members' answers are not part of this run.`,
				facts: { reasonCode: "delivered" },
			};
		}
		throw new Error("Session routines require the native worker executor.");
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

	/** The watch a worker runtime arms through: this session's watch service, which holds the worker's bounds and wakes it. */
	taskWatches(runtime: () => RoutineRuntime | undefined): TaskWatchPort {
		return {
			available: () => runtime() !== undefined,
			arm: async (worker, watch, signal) => {
				const routines = runtime();
				if (!routines) throw new Error("Watches are unavailable in this session.");
				return routines.sessionWatches.arm(
					{
						...watch,
						armedBy: { kind: "worker", runtimeId: worker.runtimeId, scope: worker.scope },
						parentToolName: TASK_WATCH_TOOL_NAME,
					},
					signal,
				);
			},
			cancel: async (worker, watchId, signal) => {
				const routines = runtime();
				if (!routines) throw new Error("Watches are unavailable in this session.");
				// The ledger holds the worker's watches; a routine watch of that id is one an earlier build armed for it.
				if (routines.sessionWatches.holds(watchId))
					routines.sessionWatches.cancel(watchId, { kind: "worker", runtimeId: worker.runtimeId }, signal);
				else await routines.session.cancelForWorker(worker, watchId, signal);
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

	/**
	 * Delivers a watch event to the worker runtime that armed it. A runtime that is gone settles without a wake. One that
	 * does not take it now is retried for {@link WORKER_WAKE_RETRY_MS}, then the session is woken with the event instead, so
	 * a stuck worker never holds the deliveries behind it and the event is never lost.
	 */
	private async deliverToWorker(
		runtimeId: string,
		delivery: RoutineDelivery,
		send: (input: ParentInputDelivery) => Promise<RoutineDeliveryReceipt>,
	): Promise<RoutineDeliveryReceipt> {
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
		return send(
			this.sessionWake(
				routineResultInputIds(delivery)[1],
				`${workerUnreachableLine(runtimeId, wake.reason)}\n${routineWakeText(delivery)}`,
				input.message.details,
			),
		);
	}

	/**
	 * Tells the armer of a watch that its checks keep failing, or that its firing keeps finding the journal full, as one more wake (a session's parent input, a worker's message).
	 * The delivery is keyed by the watch's incarnation, its firing count and the words, so a restart that finds the same failure
	 * tells the armer nothing twice. It is not a routine result, so the day's wake bound does not hold it.
	 */
	private reportWatchFailing(store: PersistentBotTeamStore, failing: WatchFailing): void {
		const routine = store.getRoutine(failing.routineId);
		const address = routine && routineWakeAddress(routine);
		if (!routine || !address || routine.incarnationId !== failing.incarnationId) return;
		const plan = routineWatchPlan(routine);
		const condition = routineWatchCondition(routine.schedule);
		const expiresAt = routine.schedule.kind === "once" ? undefined : routine.schedule.expiresAt;
		const text = watchFailingWakeText(plan, routine.incarnationId, condition, expiresAt, failing);
		const fires = routine.cursor.kind === "watch" ? routine.cursor.fires : 0;
		const deliveryId = `watch-failing:${createHash("sha256")
			.update(JSON.stringify([routine.incarnationId, fires, text]))
			.digest("hex")}`;
		const details = {
			routineId: routine.routineId,
			routineRevision: routine.revision,
			failing: true as const,
			// A firing the journal holds is not a failing check: the owner's line says which (older builds read `failing` only).
			...(failing.cause === "journal-full" ? { held: true as const } : {}),
		};
		let content = text;
		if (address.kind === "worker") {
			const wake = wakeWorkerRuntime(
				this.workerWakeHost(),
				address.runtimeId,
				watchFailingWakeText(plan, routine.incarnationId, condition, expiresAt, failing, WORKER_WAKE_PLAN_CHARS),
				deliveryId,
			);
			if (wake.kind !== "refused") return;
			content = `${workerUnreachableLine(address.runtimeId, wake.reason)}\n${text}`;
		}
		this.deps
			.deliverParentInput(this.sessionWake(deliveryId, content, details))
			.catch((error: unknown) =>
				this.host.warn(
					`Watch ${routine.routineId} is failing and its armer could not be told: ${error instanceof Error ? error.message : String(error)}`,
				),
			);
	}

	/** The transcript entry an arming happens at, which its watch's wakes are charged to; undefined with none. */
	private armingEntry(): SessionWatchServed | undefined {
		const current = this.deps.getSessionManager();
		const leafId = current.getLeafId();
		return leafId === null ? undefined : { sessionId: current.getSessionId(), leafId };
	}

	/**
	 * The session's own watches over its ledger beside the session's transcript (in memory while it has none). Routine
	 * watches an earlier build armed without the owner's words hold slots of the same bound; a bot's own session counts every
	 * routine watch it holds, since all of them are its own waits.
	 */
	private sessionWatches(
		store: PersistentBotTeamStore,
		scope: RoutineScope,
		checks: WatchCheckAdmitter,
	): SessionWatchService {
		const sessionId = this.deps.getSessionId();
		const manager = this.deps.getSessionManager();
		const timers = this.deps.getTimers().port("routines");
		const warn = (message: string) => this.host.warn(message);
		const ledger = new SessionWatchLedger({
			sessionId,
			path: () => {
				const file = manager.isPersisted() ? manager.getSessionFile() : undefined;
				return file === undefined ? undefined : sessionWatchLedgerPath(file);
			},
			now: () => timers.now(),
			warn,
		});
		return new SessionWatchService({
			ledger,
			sessionId,
			timers,
			checks,
			legacyAgentWatches: () =>
				(scope === "own-watches" ? heldWatchCount : agentArmedWatchCount)(
					store.listRoutines(),
					sessionId,
					timers.now(),
				),
			legacyWorkerWatches: (runtimeId) =>
				workerArmedWatchCount(store.listRoutines(), sessionId, runtimeId, timers.now()),
			workerRuntimeLive: (runtimeId) =>
				workerRuntimeLive(this.host.workerLifecycle().getTaskRuntimeSnapshot(), runtimeId),
			subscribeWorkers: (listener) => this.host.subscribeOrchestrationStore(listener),
			deliverToSession: async (deliveryId, content, details, owed) => {
				// Appended only while the wake is still owed and no owner's stop of the bot waits, as a routine result is.
				const bot = this.deps.botAgentId;
				const receipt = await deliverWhileOwed(
					this.sessionWake(deliveryId, content, details),
					(next, options) => this.deps.deliverParentInput(next, options),
					owed,
					() => bot !== undefined && botInboxStopWaiting(this.deps.getAgentDir(), bot),
				);
				return receipt === "settled" ? "settled" : "delivered";
			},
			wakeWorker: (runtimeId, text, key) => wakeWorkerRuntime(this.workerWakeHost(), runtimeId, text, key),
			armingEntry: () => this.armingEntry(),
			warnOwner: warn,
			tellOwner: (key, text) => this.host.tellOwner(key, text),
			isDisposed: () => this.deps.isDisposed(),
			warn,
		});
	}

	/**
	 * Builds the routine runtime of this session's store: the scheduler, the routine tool's session, intake and the watch
	 * monitor, over the routines `scope` holds (`routine-holder.ts`). A bot's own session ("own-watches") dispatches no run
	 * and has no intake: its scheduler only delivers the firings of its watches and retires the ended ones.
	 */
	assemble(store: PersistentBotTeamStore, scope: RoutineScope): RoutineRuntime {
		const [parentSessionId, bot] = [this.deps.getSessionId(), this.deps.botAgentId];
		const canUseOrigin = (origin: WorkerReceiptOrigin): boolean =>
			routineOriginReach(this.deps.getSessionManager(), origin) === "usable";
		const worker = new RoutineWorkerExecutor({
			getSnapshot: () => {
				this.host.workerController();
				return this.host.workerLifecycle().getTaskRuntimeSnapshot();
			},
			start: (input, signal) => this.host.workerController().startSavedIntent(input, signal),
			isMeteredAttempt: (attempt) => this.host.workerController().attemptIsMetered(attempt),
		});
		const scheduler = new RoutineSchedulerController({
			store,
			worker,
			parentSessionId,
			scope,
			owner: randomUUID(),
			timers: this.deps.getTimers().port("routines"),
			isDisposed: () => this.deps.isDisposed(),
			canDispatch: () => scope === "session" && this.deps.isDelegateToolActive(),
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
					// Each input is appended only while the result is still pending and no owner's stop of the bot waits.
					const send = (input: ParentInputDelivery) =>
						deliverWhilePending(
							store,
							delivery,
							input,
							(next, options) => this.deps.deliverParentInput(next, options),
							() => bot !== undefined && botInboxStopWaiting(this.deps.getAgentDir(), bot),
						);
					if (address?.kind === "worker") return this.deliverToWorker(address.runtimeId, delivery, send);
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
					if (input.mode === "next-owner-turn") return send(input);
					// A one-shot watch is bounded by its slots and its deadline: its wake is never held by the day's bound.
					if (isOneShotWatch(occurrence.definition.schedule)) return send(input);
					const manager = this.deps.getSessionManager();
					// A replay repeats the saved mode, so a saved or steered delivery is never measured again.
					const saved = manager.getParentInput(input.deliveryId);
					let held = saved !== undefined && saved.metadata.mode === "next-owner-turn";
					if (!saved && !findSteeredDelivery(manager, input.deliveryId)) {
						const day = await this.deps.aggregateUsageWindow(rollingDayWindow(Date.now()));
						const bound = this.deps.getSettingsManager().getRoutinesSettings().maxResultWakesPerDay;
						held = day.routineResultTurnWakes >= bound;
						if (held) {
							this.deps.observeHarnessNotice?.("routine-result-wakes", () =>
								wordedNotice(ROUTINE_RESULT_WAKES_HOLD, (words) => words.notices.routineResultWakesHeld(bound)),
							);
							// One held result of a routine is carried at a time; later ones are recorded against it.
							const carried = this.findCarriedRoutineResult(delivery.occurrence.routineId, "held");
							if (carried) return carried;
						} else this.deps.observeHarnessNotice?.("routine-result-wakes", () => "clear");
					}
					return send(held ? routineParentInput(delivery, true) : input);
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
			dispatchMessage: (occurrence) => this.dispatchRoutineMessage(occurrence),
			warn: (message) => this.host.warn(message),
		});
		// One admission serves a watch when it is saved and at every evaluation, so a saved watch never runs with more
		// authority than the session has now.
		const watchAdmission = new WatchAdmission({
			getCwd: () => this.deps.getCwd(),
			getAgentDir: () => this.deps.getAgentDir(),
			getCapabilityEnvelope: () => this.deps.getCapabilityEnvelope(),
			getCredentialExposureBoundary: () => this.deps.getCredentialExposureBoundary?.(),
			getSessionConfinement: () => this.deps.getSessionConfinement(),
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
		const sampler = new WatchSampler({
			admission: watchAdmission,
			agentDir: () => this.deps.getAgentDir(),
			now: () => routineTimers.now(),
		});
		const monitorOver = (observed: WatchObservationStore, onFailing: (failing: WatchFailing) => void) =>
			new RoutineWatchMonitor({
				watches: observed,
				sessionId: parentSessionId,
				sampler,
				onFailing,
				timers: routineTimers,
				agentDir: () => this.deps.getAgentDir(),
				isDisposed: () => this.deps.isDisposed(),
				warn: (message) => this.host.warn(message),
			});
		const watches = monitorOver(routineStoreWatches(store, { sessionId: parentSessionId, scope }), (failing) =>
			this.reportWatchFailing(store, failing),
		);
		const checks = {
			admitWatch: (condition: WatchCondition, worker?: WorkerWatchAuthority) =>
				watchAdmission.admit(condition, worker),
			admitSubCall: this.deps.admitNestedToolCall.bind(this.deps),
			holdsTool: (toolName: string) => this.deps.getForegroundToolNames().includes(toolName),
		} satisfies WatchCheckAdmitter;
		const sessionWatches = this.sessionWatches(store, scope, checks);
		const sessionWatchMonitor = monitorOver(sessionWatches, (failing) => sessionWatches.noteFailing(failing));
		const githubWatchPoller = new GithubWatchPoller({
			watches: sessionWatches,
			link: this.host.githubWatches(),
			hostEvents: this.host.hostEventFeed(),
			timers: routineTimers,
			isDisposed: () => this.deps.isDisposed(),
			warn: (message) => this.host.warn(message),
		});
		const session = new RoutineSessionController({
			store,
			scheduler,
			parentSessionId,
			...checks,
			capture: (request, signal) => this.host.workerController().captureSavedIntent(request, signal),
			captureOrigin: () => captureWorkerReceiptOrigin(this.deps.getSessionManager()),
			invocationKey: (callId) => this.deps.getToolInvocationKey(callId, "routine"),
			eventAnchor: () => routineEventAnchor(this.host.workerLifecycle().getTaskRuntimeSnapshot()),
			ownerTurnSources: () => this.deps.getOwnerEvidence().currentTurnSources(),
			warnOwner: (message) => this.host.warn(message),
			now: () => this.deps.getTimers().port("routines").now(),
			isDisposed: () => this.deps.isDisposed(),
		});
		const intake =
			scope !== "session"
				? undefined
				: new RoutineIntake({
						parentSessionId,
						store,
						routines: session,
						evidence: this.deps.getOwnerEvidence(),
						time: this.deps.getTimers().port("routine-intake"),
						hostInactiveReason: () => {
							const manager = this.deps.getSessionManager();
							if (!manager.isPersisted() || !manager.getSessionFile()) return "ephemeral_session";
							return this.deps.getSettingsManager().getRoutinesSettings().automaticIntake
								? undefined
								: "disabled";
						},
						model: () => this.host.resolveLaneModel(undefined),
						systemOne: () => this.deps.systemOne.recordingSemanticEngine(),
						usageOwner: () => sessionSemanticUsageOf(this.deps.getSessionManager()),
						billing: this.deps.getModelRegistry(),
						// The same selection the intake makes: a bound System One judges, otherwise the lane model does.
						maxEstimatedUsd: () =>
							envelopeCeilingUsd(
								this.deps.getCapabilityEnvelope(),
								this.deps.systemOne.recordingSemanticEngine()
									? undefined
									: this.host.resolveLaneModel(undefined),
								this.deps.getModelRegistry(),
							),
						isForegroundBusy: () => this.deps.isForegroundBusy(),
						subscribeActivity: (listener) => this.deps.subscribeForegroundActivity(listener),
						captureOrigin: () => captureWorkerReceiptOrigin(this.deps.getSessionManager()),
						captureBranchGuard: () =>
							this.sessionBranchGuard("Routine intake session changed before its decision was saved."),
						deliver: (notice, signal) => this.deps.deliverParentInput(notice, { signal }),
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
				start("stop session watches", async () => {
					await Promise.all([sessionWatchMonitor.dispose(), githubWatchPoller.stop()]);
					await sessionWatches.stop();
				}),
				start("stop routine scheduler", () => scheduler.close()),
				start("stop routine intake", () => intake?.stop()),
			];
			void Promise.allSettled(completions).then((settled) => {
				const failures = settled.flatMap((entry) => (entry.status === "rejected" ? [entry.reason] : []));
				if (failures.length === 0) complete();
				else fail(new AggregateError(failures, "Routine runtime shutdown failed"));
			});
			return shutdown;
		};
		// The authority of the turn a call runs in: the latest decisive origin of the branch it extends.
		const authority = () => turnAuthorityOf(latestDecisiveEntry(this.deps.getSessionManager().getBranch())?.origin);
		const turn = () => ({ kind: "turn" as const, authority: authority() });
		const watchPort: SessionWatchPort = {
			arm: (watch, toolCallId, signal) =>
				sessionWatches.arm({ ...watch, armedBy: { kind: "session", authority: authority() }, toolCallId }, signal),
			list: () => sessionWatches.listFor(turn()),
			get: (watchId) => sessionWatches.get(watchId, turn()),
			cancel: (watchId, signal) => sessionWatches.cancel(watchId, turn(), signal),
			// A bot's own session's: its ledger's watch, else a routine watch an earlier build armed under that id.
			cancelOwn: async (watchId, signal) => {
				const caller = { ...turn(), sessionOnly: true };
				if (sessionWatches.holds(watchId)) sessionWatches.cancel(watchId, caller, signal);
				else await session.cancelForSession(watchId, caller.authority, signal);
			},
			now: () => routineTimers.now(),
		};
		const autoWatches: WatchAutoArmPort = {
			followsCi: () => this.host.githubWatches().followsCi,
			readsGithub: () => this.host.githubWatches().readsGithub,
			armingContext: () => {
				const served = this.armingEntry();
				return { authority: authority(), ...(served === undefined ? {} : { served }) };
			},
			armedOn: (source) => sessionWatches.armedOn(source),
			arm: (watch, { authority: armedUnder, served }) =>
				sessionWatches.arm({
					...watch,
					armedBy: { kind: "auto", authority: armedUnder },
					tellOwner: true,
					...(served === undefined ? {} : { served }),
				}),
			now: () => routineTimers.now(),
		};
		return {
			scheduler,
			session,
			intake,
			watches,
			sessionWatches,
			sessionWatchMonitor,
			githubWatchPoller,
			watchPort,
			autoWatches,
			stop,
		};
	}
}
