/**
 * The ports the leader controller runs through: the root's delegation store and orchestration projection, the bots and
 * workers it reads, the sends, stops and retirements it issues, the parent deliveries, the subtree accounting, the
 * timers and the clock. The controller takes one of these at construction; this file holds the contract only, so the
 * controller's decisions stay in `leader-controller.ts`.
 */
import type { TimerPort } from "../../kernel/timer-port.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import type { WorkerReceiptOrigin } from "../orchestration/worker-receipt-origin.ts";
import type { ParentInputDelivery } from "../parent-input-delivery.ts";
import type { BotCreationRequest, CreatedBotView } from "./bot-creation.ts";
import type { LeaderBotView } from "./leader-delegation.ts";
import type { LeaderLedgerRuntime } from "./leader-delegation-ledger.ts";
import type { WorkerAgentView } from "./worker-agent-control.ts";

/** Who appoints a goal leader: the orchestrator, or the leader whose goal hands a part on. */
export type LeaderAppointer = { readonly kind: "root" } | { readonly kind: "leader"; readonly agentId: string };

export interface LeaderControllerDeps {
	/** The root session's durable task runtime: the one store the delegation record lives in. */
	runtime(): LeaderLedgerRuntime;
	snapshot(): TaskRuntimeProjection;
	/** Fires after every orchestration store commit. */
	subscribe(listener: () => void): () => void;
	/** Every bot, retired ones included. */
	bots(): readonly LeaderBotView[];
	/** Creates a goal leader for one goal, appointed by the orchestrator or by the leader whose goal hands a part on. */
	createGoalLeader(request: BotCreationRequest, appointer?: LeaderAppointer): CreatedBotView;
	/** The bot a runtime is a direct (not group) generation of; undefined for any other worker. */
	directBotOf(runtimeAgentId: string): string | undefined;
	/** Every runtime a bot has had, its current one included. */
	runtimesOf(alias: string): readonly string[];
	workers(): readonly WorkerAgentView[];
	/**
	 * Sends words for a delegation to a bot; the turn they start is filed under that delegation. `idempotencyKey` makes a
	 * repeated send one message (the Outcome of a nested goal, sent to its parent leader, is one). `fromLeader` is the alias
	 * of the leader whose words these are, when they are not the orchestrator's.
	 */
	send(
		alias: string,
		text: string,
		delegationObjectiveId: string,
		options?: { readonly idempotencyKey?: string; readonly fromLeader?: string },
	): Promise<void>;
	/** Stops a bot's running turn and those of the bots it owns. */
	stop(alias: string): void;
	retire(alias: string): { retired: boolean; detail: string };
	acknowledge(notificationIds: readonly string[]): void;
	deliver(input: ParentInputDelivery): Promise<unknown>;
	origin(): WorkerReceiptOrigin;
	hasDelivered(deliveryId: string): boolean;
	maxDepth(): number;
	/**
	 * Retires a leader's idle runtime when its contract grants it no children (a runtime started before the leader could
	 * lead bots); its next start is granted the leader limits. A busy runtime is left alone.
	 */
	restartLeaderRuntimeIfLeaf(leader: string): void;
	/**
	 * The fleet subtree of a leader: its children are charged to it, so its share is opened while a goal runs and
	 * released when the goal is over. A nested leader's share sits under its parent leader's.
	 */
	openSubtree(leader: string, parentLeader?: string): void;
	closeSubtree(leader: string, reasonCode: string): void;
	/**
	 * Whether a subscription login the given bots run on has no allowance left in its usage window. Subscription turns are
	 * not metered, so this is the bound a delegation has beyond its metered `budgetUsd`.
	 */
	subscriptionExhausted(aliases: readonly string[]): boolean;
	isMeteredAttempt(attempt: AttemptRuntimeState): boolean;
	/** Whether a message filed under this delegation still waits in some bot's mailbox (unfinished work of the goal). */
	hasPendingDelegatedMessage(delegationObjectiveId: string): boolean;
	/** Starts the messages the goal filed while it was paused, now that it runs again. */
	reconcileDelegatedMessages(delegationObjectiveId: string): void;
	/** The orchestration clock: the one attempts are stamped on. */
	now(): number;
	timers: TimerPort;
}
