/**
 * Leaders as sub-orchestrators: the root hands a goal to a leader bot, the leader works it with the bots it owns, and the
 * root hears back once, with one bounded Outcome, when the goal ends. A leader is a privileged worker, never a second
 * root: its turns are ordinary bot turns the root's controller admits, its authority is the root's narrowed (see
 * `leader-delegation.ts`), and everything this controller decides comes from durable facts in the root's orchestration
 * store (the delegation record, attempts, outcomes), so a restart resumes exactly where it stood.
 *
 * Decisions, all code facts:
 * - a delegation is dispatched when its leader is idle and has no earlier open delegation (one at a time, oldest first);
 * - a turn filed under a delegation's objective is the delegation's: the leader's own, and those its work started (the
 *   sender's turn carries the objective into each message it writes); its terminal notice never wakes the root;
 * - the orchestrator's words to a leader for a goal are filed under that goal, an owner's chat with the leader is not;
 * - the delegation is final when the leader's latest turn ended, no leader turn or owned-bot turn is still running, and
 *   that turn did not ask the orchestrator; then the Outcome (the children's aggregate, never re-judged) is recorded,
 *   the objective settles and the root is woken once;
 * - a turn that ended asking the orchestrator wakes the root with that question and keeps the delegation open;
 * - the deadline, the metered budget, cancellation and a lost leader close it early, stopping the leader and its bots.
 */

import { randomUUID } from "node:crypto";
import { harnessLog } from "../../kernel/harness-log.ts";
import type { TimerPort } from "../../kernel/timer-port.ts";
import { conversationTurnOrigin } from "../orchestration/attempt-agent-identity.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import type { WorkerReceiptOrigin } from "../orchestration/worker-receipt-origin.ts";
import type { ParentInputDelivery } from "../parent-input-delivery.ts";
import { wrapUntrustedText } from "../security/untrusted-boundary.ts";
import { canonicalDigest } from "../steering/canonical.ts";
import { boundedText } from "../util/bounded-line.ts";
import type { BotCreationRequest, CreatedBotView } from "./bot-creation.ts";
import type { BotAskRootResult } from "./bot-message-contract.ts";
import {
	admitChain,
	type LeadRequest,
	type LeadResult,
	LOCAL_MACHINE_ID,
	narrowEnvelope,
	renderLeaderBrief,
	rootLeaderEnvelope,
} from "./leader-delegation.ts";
import {
	type DelegationCloseReason,
	type DelegationRecord,
	LeaderDelegationLedger,
	type LeaderLedgerRuntime,
	readDelegations,
} from "./leader-delegation-ledger.ts";
import { currentDelegationFor } from "./leader-view.ts";
import type { WorkerAgentView } from "./worker-agent-control.ts";
import type { WorkerTerminalHandoffRecord } from "./worker-notification-coordinator.ts";
import {
	aggregateOutcomes,
	BLOCKER_ATTRIBUTION,
	type BlockerCode,
	describeNextAction,
	describeOutcomeForHandoff,
	type NextAction,
	type Outcome,
	type OutcomeStatus,
	sameOutcomeAttempt,
} from "./worker-outcome.ts";

export const LEADER_OUTCOME_CUSTOM_TYPE = "leader-outcome";
export const LEADER_QUESTION_CUSTOM_TYPE = "leader-question";

/** The standing instructions of a goal leader the orchestrator appoints; it exists for one goal. */
export const GOAL_LEADER_SOUL =
	"You lead one goal for the orchestrator and nothing else. Split it into parts, give each part to a bot with bot_message (create the bots you need with action create), collect their replies, and end with one report of what was done, what is proven and what is left. You and your bots never change files. Ask the orchestrator in your report only when you cannot go on without its answer.";

const ACTIVE_ATTEMPT_STATUSES = new Set<AttemptRuntimeState["status"]>(["queued", "leased", "running", "suspended"]);
const MAX_REPORT_CHARS = 2000;
/** The longest single timer the platform keeps; a later deadline re-arms when this one fires. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/** The bot facts this controller reads; the bot store is their owner. */
export interface LeaderBotView {
	readonly agentId: string;
	readonly displayName: string;
	readonly leader: boolean;
	readonly canWrite: boolean;
	readonly retired: boolean;
	readonly remote: boolean;
	readonly createdBy?: string;
	readonly description?: string;
}

export interface LeaderControllerDeps {
	/** The root session's durable task runtime: the one store the delegation record lives in. */
	runtime(): LeaderLedgerRuntime;
	snapshot(): TaskRuntimeProjection;
	/** Fires after every orchestration store commit. */
	subscribe(listener: () => void): () => void;
	/** Every bot, retired ones included. */
	bots(): readonly LeaderBotView[];
	/** Creates a goal leader on the root's authority (a leader the owner did not make, for one goal). */
	createGoalLeader(request: BotCreationRequest): CreatedBotView;
	/** The bot a runtime is a direct (not group) generation of; undefined for any other worker. */
	directBotOf(runtimeAgentId: string): string | undefined;
	/** Every runtime a bot has had, its current one included. */
	runtimesOf(alias: string): readonly string[];
	workers(): readonly WorkerAgentView[];
	/** Sends the orchestrator's words for a delegation to a bot; the turn they start is filed under that delegation. */
	send(alias: string, text: string, delegationObjectiveId: string): Promise<void>;
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
	 * released when the goal is over.
	 */
	openSubtree(leader: string): void;
	closeSubtree(leader: string, reasonCode: string): void;
	/**
	 * Whether a subscription login the given bots run on has no allowance left in its usage window. Subscription turns are
	 * not metered, so this is the bound a delegation has beyond its metered `budgetUsd`.
	 */
	subscriptionExhausted(aliases: readonly string[]): boolean;
	/** Whether a message filed under this delegation still waits in some bot's mailbox (unfinished work of the goal). */
	hasPendingDelegatedMessage(delegationObjectiveId: string): boolean;
	/** Starts the messages the goal filed while it was paused, now that it runs again. */
	reconcileDelegatedMessages(delegationObjectiveId: string): void;
	/** The orchestration clock: the one attempts are stamped on. */
	now(): number;
	timers: TimerPort;
}

function isOpen(record: DelegationRecord): boolean {
	return record.state !== "closed";
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

export class LeaderController {
	private readonly deps: LeaderControllerDeps;
	private readonly ledger: LeaderDelegationLedger;
	private unsubscribe: (() => void) | undefined;
	private timer: { handle: unknown; at: number } | undefined;
	private running: Promise<void> | undefined;
	private again = false;
	/** Deliveries this process saw land; the session's parent-input ledger is the durable answer. */
	private readonly delivered = new Set<string>();
	/** Closed delegations whose delivery and goal-leader retirement are settled in this process. */
	private readonly settled = new Set<string>();
	/** Leaders whose fleet subtree is open in this process; a restart re-opens the subtree of each running goal. */
	private readonly openSubtrees = new Set<string>();
	private readonly listeners = new Set<() => void>();
	private disposed = false;

	constructor(deps: LeaderControllerDeps) {
		this.deps = deps;
		this.ledger = new LeaderDelegationLedger(
			() => deps.runtime(),
			() => deps.now(),
		);
	}

	/** Follows the store and reconciles what the last process left: a restart adopts every open delegation. */
	start(): void {
		if (this.unsubscribe || this.disposed) return;
		this.unsubscribe = this.deps.subscribe(() => this.trigger());
		this.trigger();
	}

	dispose(): void {
		this.disposed = true;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		if (this.timer) this.deps.timers.clearTimeout(this.timer.handle);
		this.timer = undefined;
		this.listeners.clear();
	}

	/** Every delegation, oldest first; the panel and `/lead` read it. */
	snapshot(): DelegationRecord[] {
		return this.ledger.list();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Whether a turn belongs to a delegation. A delegation dispatched by this build owns the turns filed under its objective:
	 * what a turn was started as, never when it ran, so an owner's chat with the leader is not counted. A delegation an
	 * earlier build dispatched has no filing mark: its turns are attributed by time window (from its dispatch until its close)
	 * and only when the attempt's bot is the leader or a bot the leader created, so an unrelated worker in the window is not
	 * the goal's.
	 */
	private turnBelongsTo(
		snapshot: TaskRuntimeProjection,
		record: DelegationRecord,
		attempt: AttemptRuntimeState,
	): boolean {
		if (attempt.agentId === undefined) return false;
		if (record.filedByObjective) return filedObjectiveOf(snapshot, attempt) === record.objectiveId;
		if (!record.dispatchedAt || attempt.createdAt < record.dispatchedAt) return false;
		if (record.closedAt !== undefined && attempt.createdAt > record.closedAt) return false;
		return this.leaderOrOwnedBot(record, attempt.agentId);
	}

	/** Whether the bot a runtime belongs to is the delegation's leader or a bot that leader created. */
	private leaderOrOwnedBot(record: DelegationRecord, agentId: string): boolean {
		const alias = this.deps.directBotOf(agentId);
		if (alias === undefined) return false;
		if (alias === record.charter.leader) return true;
		return this.deps.bots().some((bot) => bot.agentId === alias && bot.createdBy === record.charter.leader);
	}

	/** Every turn that belongs to a delegation, oldest first. */
	private attemptsOf(snapshot: TaskRuntimeProjection, record: DelegationRecord): AttemptRuntimeState[] {
		return Object.values(snapshot.attempts)
			.filter((attempt) => this.turnBelongsTo(snapshot, record, attempt))
			.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
	}

	/** Opens a leader's fleet subtree once; a goal still running keeps it open. */
	private ensureSubtree(leader: string): void {
		if (this.openSubtrees.has(leader)) return;
		this.deps.openSubtree(leader);
		this.openSubtrees.add(leader);
	}

	/**
	 * Releases a leader's fleet subtree when its goal is over. A leader with another goal running keeps it: that goal is
	 * the subtree's work now.
	 */
	private releaseSubtree(leader: string, reasonCode: string): void {
		const current = this.currentFor(leader);
		if (current?.state === "running" || current?.state === "paused") return;
		if (!this.openSubtrees.delete(leader)) return;
		this.deps.closeSubtree(leader, reasonCode);
	}

	/** The open delegation a leader is working, else the oldest one waiting for it. */
	currentFor(leader: string): DelegationRecord | undefined {
		return currentDelegationFor(this.ledger.list(), leader);
	}

	/** True while a bot leads an open delegation: retiring it then would orphan the goal. */
	leadsOpenDelegation(alias: string): boolean {
		return this.ledger.list().some((record) => isOpen(record) && record.charter.leader === alias);
	}

	/**
	 * A delegation's leader turn is the delegation's input: its terminal notice is claimed here and acknowledged by the
	 * reconcile pass, which acts from the durable store, never from the notice.
	 */
	claimsTerminal(record: Pick<WorkerTerminalHandoffRecord, "attemptId">): boolean {
		if (!record.attemptId) return false;
		const snapshot = this.deps.snapshot();
		const attempt = snapshot.attempts[record.attemptId];
		if (!attempt) return false;
		const claimed = readDelegations(snapshot).some((delegation) => this.turnBelongsTo(snapshot, delegation, attempt));
		if (claimed) queueMicrotask(() => this.trigger());
		return claimed;
	}

	/** Opens a delegation for the root; dispatch follows as soon as the leader is free. */
	delegate(lead: LeadRequest): LeadResult {
		const bots = this.deps.bots();
		let leader: LeaderBotView;
		let appointedBy: "owner" | "root";
		let goalLeader = false;
		if (lead.agentId !== undefined) {
			const named = bots.find((bot) => bot.agentId === lead.agentId);
			if (!named || named.retired)
				throw new Error(
					`There is no bot named ${lead.agentId}. Name a leader (bot list marks them), or leave agentId out to appoint a goal leader.`,
				);
			if (!named.leader)
				throw new Error(
					`${named.displayName} is not a standing leader. Only the owner makes one, with /bot lead ${named.agentId} (not /lead, which shows goals). Name a leader, or leave agentId out to appoint a goal leader.`,
				);
			if (named.remote)
				throw new Error(
					`${named.displayName} works on another machine, which cannot lead a goal from here yet. Name a leader on this machine, or leave agentId out.`,
				);
			leader = named;
			appointedBy = named.createdBy === "root" ? "root" : "owner";
		} else {
			const created = this.deps.createGoalLeader({
				soul: GOAL_LEADER_SOUL,
				description: boundedText(lead.goal.split(/\r?\n/, 1)[0]!.trim(), 200),
				canWrite: false,
			});
			const found = this.deps.bots().find((bot) => bot.agentId === created.agentId);
			if (!found) throw new Error(`The goal leader ${created.agentId} was not saved.`);
			leader = found;
			appointedBy = "root";
			goalLeader = true;
		}
		const objectiveId = this.ledger.newObjectiveId();
		const hop = { machineId: LOCAL_MACHINE_ID, objectiveId, leader: leader.agentId };
		const maxDepth = this.deps.maxDepth();
		const parent = rootLeaderEnvelope(maxDepth);
		const admission = admitChain(parent.chain, hop, maxDepth);
		if (admission !== "ok")
			throw new Error(
				admission === "cycle_refused"
					? `${leader.displayName} already works on this chain of goals.`
					: "This goal would nest leaders deeper than leaders.maxDepth allows.",
			);
		const nowMs = this.deps.now();
		const { envelope, clipped } = narrowEnvelope(parent, {
			lead,
			leaderCanWrite: leader.canWrite,
			appointedBy,
			hop,
			nowMs,
		});
		const ahead = this.currentFor(leader.agentId);
		try {
			this.ledger.open(objectiveId, {
				v: 1,
				leader: leader.agentId,
				appointedBy,
				lead,
				envelope,
				clipped,
				createdAt: iso(nowMs),
			});
		} catch (error) {
			if (goalLeader) this.deps.retire(leader.agentId);
			throw error;
		}
		harnessLog.info("leaders", "a goal was delegated to a leader", () => ({
			leader: leader.agentId,
			goalLeader,
			queued: ahead !== undefined,
			clipped: clipped.length,
		}));
		this.trigger();
		return {
			delegated: true,
			leader: leader.agentId,
			goalLeader,
			envelope,
			clipped,
			...(ahead ? { queuedBehind: ahead.title } : {}),
		};
	}

	/** Sends the leader more words for its goal; the update is recorded on the delegation first. */
	async update(leader: string, text: string): Promise<void> {
		const record = this.requireCurrent(leader);
		this.ledger.recordUpdate(record.objectiveId, text);
		if (record.state === "running")
			await this.deps.send(leader, `Update from the orchestrator for your goal:\n${text}`, record.objectiveId);
	}

	async cancel(leader: string): Promise<DelegationRecord> {
		const record = this.requireCurrent(leader);
		return this.forceClose(record, "cancelled");
	}

	/**
	 * A leader's question to the orchestrator in the middle of its goal: delivered now, the goal stays open, and the
	 * orchestrator's answer (`bot` action ask) is the leader's next turn. A question that did not land is refused, so the
	 * leader knows to ask again.
	 */
	async askRoot(leader: string, question: string): Promise<BotAskRootResult> {
		const record = this.currentFor(leader);
		if (record?.state !== "running") throw new Error(`${leader} has no goal running to ask about.`);
		const askId = `${record.objectiveId}:ask:${randomUUID().replace(/-/g, "").slice(0, 16)}`;
		const content = [
			`Leader ${this.displayName(leader)} asks you about the goal "${record.title.replace(/^Lead: /, "")}" while it keeps working.`,
			`Question (untrusted worker words):\n${wrapUntrustedText(boundedText(question, MAX_REPORT_CHARS), `leader-ask:${askId}`)}`,
			`Answer with bot action ask (agentId ${leader}); the goal goes on with that turn.`,
		].join("\n");
		const delivered = await this.deliverOnce(`leader-ask:${askId}`, {
			customType: LEADER_QUESTION_CUSTOM_TYPE,
			display: true,
			content,
			details: { objectiveId: record.objectiveId, leader, askId },
		});
		if (!delivered) throw new Error("The orchestrator did not receive the question yet; ask again.");
		return { askId };
	}

	pause(leader: string): DelegationRecord {
		const record = this.requireCurrent(leader);
		if (record.state === "paused") return record;
		if (record.state !== "running") throw new Error(`${leader}'s goal has not started; cancel it instead.`);
		this.ledger.pause(record.objectiveId);
		this.deps.stop(leader);
		return this.ledger.get(record.objectiveId) ?? record;
	}

	async resume(leader: string): Promise<DelegationRecord> {
		const record = this.requireCurrent(leader);
		if (record.state !== "paused") throw new Error(`${leader}'s goal is not paused.`);
		this.ledger.resume(record.objectiveId);
		// The goal's messages held while it was paused start first, in the order they were filed.
		this.deps.reconcileDelegatedMessages(record.objectiveId);
		await this.deps.send(leader, "Continue your goal from where you stopped.", record.objectiveId);
		return this.ledger.get(record.objectiveId) ?? record;
	}

	private requireCurrent(leader: string): DelegationRecord {
		const record = this.currentFor(leader);
		if (!record) throw new Error(`${leader} leads no open goal.`);
		return record;
	}

	// -------------------------------------------------------------------------------------------------------------
	// Reconcile: one pass at a time, rerun when the store moved while it ran.
	// -------------------------------------------------------------------------------------------------------------

	private trigger(): void {
		if (this.disposed) return;
		if (this.running) {
			this.again = true;
			return;
		}
		this.running = (async () => {
			try {
				do {
					this.again = false;
					await this.reconcile();
				} while (this.again && !this.disposed);
			} catch (error) {
				harnessLog.warn("leaders", "a leader reconcile pass failed", () => ({
					error: error instanceof Error ? error.message : String(error),
				}));
			} finally {
				this.running = undefined;
			}
		})();
	}

	private async reconcile(): Promise<void> {
		const snapshot = this.deps.snapshot();
		const records = readDelegations(snapshot);
		if (records.length === 0) return;
		const aliases = new Map<string, string | undefined>();
		const aliasOf = (agentId: string) => {
			if (!aliases.has(agentId)) aliases.set(agentId, this.deps.directBotOf(agentId));
			return aliases.get(agentId);
		};
		this.acknowledgeClaimed(snapshot, records);
		const bots = new Map(this.deps.bots().map((bot) => [bot.agentId, bot]));
		const nowMs = this.deps.now();
		let changed = false;
		for (const record of records) {
			if (record.state === "closed") {
				if (!this.settled.has(record.objectiveId)) await this.settleClosed(record, snapshot, bots, aliasOf);
				continue;
			}
			if (record.state !== "running") continue;
			const leader = bots.get(record.charter.leader);
			if (!leader || leader.retired) {
				await this.forceClose(record, "leader_unavailable");
				changed = true;
				continue;
			}
			this.ensureSubtree(leader.agentId);
			const deadline = record.charter.envelope.deadlineAt;
			if (deadline !== undefined && Date.parse(deadline) <= nowMs) {
				await this.forceClose(record, "deadline");
				changed = true;
				continue;
			}
			// Every turn filed under this delegation: the leader's own and those its work started, nothing else.
			const delegated = this.attemptsOf(snapshot, record);
			const aliasOfAttempt = (attempt: AttemptRuntimeState) =>
				attempt.agentId === undefined ? undefined : aliasOf(attempt.agentId);
			const leaderAttempts = delegated.filter((attempt) => aliasOfAttempt(attempt) === leader.agentId);
			const ownedAttempts = delegated.filter((attempt) => {
				const alias = aliasOfAttempt(attempt);
				return alias !== undefined && alias !== leader.agentId;
			});
			const budget = record.charter.envelope.budgetUsd;
			if (budget !== undefined && spentUsd(delegated) >= budget) {
				await this.forceClose(record, "budget");
				changed = true;
				continue;
			}
			const ranAliases = [
				...new Set([
					leader.agentId,
					...delegated.flatMap((attempt) => {
						const alias = aliasOfAttempt(attempt);
						return alias === undefined ? [] : [alias];
					}),
				]),
			];
			if (this.deps.subscriptionExhausted(ranAliases)) {
				await this.forceClose(record, "allowance");
				changed = true;
				continue;
			}
			const last = leaderAttempts.at(-1);
			if (!last || ACTIVE_ATTEMPT_STATUSES.has(last.status)) continue;
			if (ownedAttempts.some((attempt) => ACTIVE_ATTEMPT_STATUSES.has(attempt.status))) continue;
			// A message filed under this goal still waiting in a bot's mailbox is the goal's unfinished work; an owner's chat is not.
			if (this.deps.hasPendingDelegatedMessage(record.objectiveId)) continue;
			const lastOutcome = sameOutcomeAttempt(snapshot.tasks[last.taskId]?.outcome, last.attemptId);
			if (
				lastOutcome &&
				(lastOutcome.nextAction.kind === "ask_owner" || lastOutcome.nextAction.kind === "ask_root")
			) {
				await this.deliverQuestion(record, leader, last, lastOutcome, snapshot);
				continue;
			}
			const outcome = this.composeOutcome(record, snapshot, leaderAttempts, ownedAttempts, "settled");
			const closed = this.ledger.close(record.objectiveId, outcome, "settled");
			harnessLog.info("leaders", "a delegated goal ended", () => ({
				leader: leader.agentId,
				status: outcome.status,
				blocker: outcome.blocker,
			}));
			await this.settleClosed(closed, this.deps.snapshot(), bots, aliasOf);
			changed = true;
		}
		changed = (await this.dispatchQueued(bots)) || changed;
		this.armDeadline();
		if (changed) this.notifyListeners();
	}

	/** Every pending terminal notice of a delegation's leader turn is consumed here; the store already says what it means. */
	private acknowledgeClaimed(snapshot: TaskRuntimeProjection, records: readonly DelegationRecord[]): void {
		const ids: string[] = [];
		for (const notification of Object.values(snapshot.notifications)) {
			if (notification.status !== "pending" || !notification.attemptId) continue;
			const attempt = snapshot.attempts[notification.attemptId];
			if (!attempt || ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) continue;
			if (records.some((record) => this.turnBelongsTo(snapshot, record, attempt)))
				ids.push(notification.notificationId);
		}
		if (ids.length > 0) this.deps.acknowledge(ids);
	}

	private leaderIdle(alias: string): boolean {
		const runtimes = new Set(this.deps.runtimesOf(alias));
		return !this.deps
			.workers()
			.some((worker) => runtimes.has(worker.agentId) && worker.status !== "retired" && worker.activity !== "idle");
	}

	/** One delegation per leader at a time, oldest first, and only once the leader has no other turn running. */
	private async dispatchQueued(bots: ReadonlyMap<string, LeaderBotView>): Promise<boolean> {
		const records = this.ledger.list().filter(isOpen);
		const busy = new Set(
			records.filter((record) => record.state !== "queued").map((record) => record.charter.leader),
		);
		let changed = false;
		for (const record of records) {
			if (record.state !== "queued" || busy.has(record.charter.leader)) continue;
			busy.add(record.charter.leader);
			const leader = bots.get(record.charter.leader);
			if (!leader || leader.retired) {
				await this.forceClose(record, "leader_unavailable");
				changed = true;
				continue;
			}
			if (!this.leaderIdle(leader.agentId)) continue;
			// A standing leader's idle runtime from before it could lead bots is restarted, so the goal's start is granted its children.
			this.deps.restartLeaderRuntimeIfLeaf(leader.agentId);
			const ownedBots = [...bots.values()]
				.filter((bot) => bot.createdBy === leader.agentId && !bot.retired)
				.map((bot) => ({ agentId: bot.agentId, ...(bot.description ? { description: bot.description } : {}) }));
			const brief = renderLeaderBrief({
				lead: record.charter.lead,
				envelope: record.charter.envelope,
				clipped: record.charter.clipped,
				ownedBots,
			});
			this.ledger.markDispatched(record.objectiveId);
			changed = true;
			try {
				await this.deps.send(leader.agentId, brief, record.objectiveId);
			} catch (error) {
				harnessLog.warn("leaders", "a leader could not be started for its goal", () => ({
					leader: leader.agentId,
					error: error instanceof Error ? error.message : String(error),
				}));
				const current = this.ledger.get(record.objectiveId);
				if (current && isOpen(current)) await this.forceClose(current, "leader_unavailable");
			}
		}
		return changed;
	}

	/** Ends a delegation before its leader did: stop the leader and its bots, record the Outcome, wake the root. */
	private async forceClose(record: DelegationRecord, reason: DelegationCloseReason): Promise<DelegationRecord> {
		if (record.state === "running" || record.state === "paused") this.deps.stop(record.charter.leader);
		const snapshot = this.deps.snapshot();
		const bots = new Map(this.deps.bots().map((bot) => [bot.agentId, bot]));
		const delegated = this.attemptsOf(snapshot, record);
		const aliasOfAttempt = (attempt: AttemptRuntimeState) =>
			attempt.agentId === undefined ? undefined : this.deps.directBotOf(attempt.agentId);
		const leaderAttempts = delegated.filter((attempt) => aliasOfAttempt(attempt) === record.charter.leader);
		const ownedAttempts = delegated.filter((attempt) => {
			const alias = aliasOfAttempt(attempt);
			return alias !== undefined && alias !== record.charter.leader;
		});
		const outcome = this.composeOutcome(record, snapshot, leaderAttempts, ownedAttempts, reason);
		const closed = this.ledger.close(record.objectiveId, outcome, reason);
		harnessLog.info("leaders", "a delegated goal was closed early", () => ({
			leader: record.charter.leader,
			reason,
		}));
		await this.settleClosed(closed, this.deps.snapshot(), bots, (agentId) => this.deps.directBotOf(agentId));
		this.notifyListeners();
		return closed;
	}

	/**
	 * The delegation's Outcome. The children are the leader's last turn and each owned bot's last turn in the window,
	 * aggregated as they are; an early close states its own cause (who or what ended it) over that aggregate.
	 */
	private composeOutcome(
		record: DelegationRecord,
		snapshot: TaskRuntimeProjection,
		leaderAttempts: readonly AttemptRuntimeState[],
		ownedAttempts: readonly AttemptRuntimeState[],
		reason: DelegationCloseReason,
	): Outcome {
		const latestByAgent = new Map<string, AttemptRuntimeState>();
		for (const attempt of ownedAttempts) if (attempt.agentId) latestByAgent.set(attempt.agentId, attempt);
		const lastLeader = leaderAttempts.at(-1);
		const children = [...latestByAgent.values(), ...(lastLeader ? [lastLeader] : [])]
			.map((attempt) => sameOutcomeAttempt(snapshot.tasks[attempt.taskId]?.outcome, attempt.attemptId))
			.filter((outcome): outcome is Outcome => outcome !== undefined);
		const aggregate = aggregateOutcomes(children, "all", "leader", {
			outcomeId: `outcome-obj-${record.objectiveId}`,
			nodeId: record.objectiveId,
			objectiveId: record.objectiveId,
			generation: 1,
			recordedAt: iso(this.deps.now()),
		});
		const early = EARLY_CLOSE[reason];
		if (!early) return aggregate;
		return {
			...aggregate,
			status: early.status,
			blocker: early.blocker,
			attribution: BLOCKER_ATTRIBUTION[early.blocker],
			sourceCodes: [`delegation_${reason}`, ...aggregate.sourceCodes].slice(0, 8),
			assurance: "unverified",
			nextAction: early.nextAction,
			ladder: { rung: 0, exit: `delegation_${reason}` },
		};
	}

	/** After a close: wake the root once with the Outcome, then retire a goal leader whose only goal this was. */
	private async settleClosed(
		record: DelegationRecord,
		snapshot: TaskRuntimeProjection,
		bots: ReadonlyMap<string, LeaderBotView>,
		aliasOf: (agentId: string) => string | undefined,
	): Promise<void> {
		this.releaseSubtree(record.charter.leader, `delegation_${record.closeReason ?? "settled"}`);
		// Every close releases what the goal's messages held while it was paused, including a close from paused (a cancel).
		this.deps.reconcileDelegatedMessages(record.objectiveId);
		if (!record.outcome) {
			// The objective was settled outside this controller; the Outcome still has to be recorded and told.
			if (record.objectiveStatus === "completed" || record.objectiveStatus === "cancelled") {
				const outcome = this.composeOutcome(record, snapshot, [], [], "cancelled");
				const closed = this.ledger.close(record.objectiveId, outcome, "cancelled");
				if (closed.outcome) await this.settleClosed(closed, snapshot, bots, aliasOf);
			}
			return;
		}
		// A crash between recording the Outcome and settling the objective left it open; the record says how it ends.
		if (record.objectiveStatus === "active" || record.objectiveStatus === "paused")
			record = this.ledger.settle(record.objectiveId);
		const delivered = await this.deliverOutcome(record, snapshot, aliasOf);
		const leader = bots.get(record.charter.leader);
		// A standing leader whose goal has ended restarts an idle runtime that predates leading bots (see the restart below).
		if (leader && !leader.retired && record.charter.appointedBy === "owner" && this.leaderIdle(leader.agentId))
			this.deps.restartLeaderRuntimeIfLeaf(leader.agentId);
		const retireDue =
			record.charter.appointedBy === "root" &&
			leader !== undefined &&
			!leader.retired &&
			!this.leadsOpenDelegation(leader.agentId);
		if (retireDue) {
			if (!this.leaderIdle(leader.agentId)) return;
			const result = this.deps.retire(leader.agentId);
			if (!result.retired)
				harnessLog.warn("leaders", "a goal leader could not be retired after its goal", () => ({
					leader: leader.agentId,
					detail: result.detail,
				}));
		}
		if (delivered) this.settled.add(record.objectiveId);
	}

	private async deliverOutcome(
		record: DelegationRecord,
		snapshot: TaskRuntimeProjection,
		aliasOf: (agentId: string) => string | undefined,
	): Promise<boolean> {
		const outcome = record.outcome;
		if (!outcome) return false;
		const deliveryId = `leader-outcome:${record.objectiveId}`;
		if (this.delivered.has(deliveryId) || this.deps.hasDelivered(deliveryId)) return true;
		const leaderAttempts = this.attemptsOf(snapshot, record).filter(
			(attempt) => attempt.agentId !== undefined && aliasOf(attempt.agentId) === record.charter.leader,
		);
		const last = leaderAttempts.at(-1);
		const report = record.closeReason === "settled" ? last?.result?.summary?.trim() : undefined;
		const leaderName = this.displayName(record.charter.leader);
		const content = [
			`Leader ${leaderName} ${record.closeReason === "settled" ? "finished" : "stopped"} the goal "${record.title.replace(/^Lead: /, "")}": ${describeNextAction(outcome)}`,
			describeOutcomeForHandoff(outcome),
			...(report
				? [
						`Leader report (untrusted worker evidence):\n${wrapUntrustedText(boundedText(report, MAX_REPORT_CHARS), `leader-report:${record.objectiveId}`)}`,
					]
				: []),
			"Decide whether the owner needs an update or further work; the leader's bots keep their conversations.",
		].join("\n");
		const message = {
			customType: LEADER_OUTCOME_CUSTOM_TYPE,
			display: true,
			content,
			details: {
				objectiveId: record.objectiveId,
				leader: record.charter.leader,
				outcome: {
					outcomeId: outcome.outcomeId,
					status: outcome.status,
					blocker: outcome.blocker,
					assurance: outcome.assurance,
					nextAction: outcome.nextAction.kind,
				},
				...(record.closeReason ? { closeReason: record.closeReason } : {}),
				...(touchedByThirdParty(snapshot, leaderAttempts) ? { thirdParty: true } : {}),
			},
		};
		return this.deliverOnce(deliveryId, message);
	}

	private async deliverQuestion(
		record: DelegationRecord,
		leader: LeaderBotView,
		attempt: AttemptRuntimeState,
		outcome: Outcome,
		snapshot: TaskRuntimeProjection,
	): Promise<void> {
		const deliveryId = `leader-question:${record.objectiveId}:${attempt.attemptId}`;
		if (this.delivered.has(deliveryId) || this.deps.hasDelivered(deliveryId)) return;
		const question =
			outcome.nextAction.kind === "ask_owner" || outcome.nextAction.kind === "ask_root"
				? outcome.nextAction.question
				: "";
		const report = attempt.result?.summary?.trim();
		const content = [
			`Leader ${leader.displayName} needs you to go on with the goal "${record.title.replace(/^Lead: /, "")}".`,
			describeOutcomeForHandoff(outcome),
			...(question
				? [
						`Question (untrusted worker words):\n${wrapUntrustedText(question, `leader-question:${record.objectiveId}`)}`,
					]
				: []),
			...(report
				? [
						`Leader report (untrusted worker evidence):\n${wrapUntrustedText(boundedText(report, MAX_REPORT_CHARS), `leader-report:${attempt.attemptId}`)}`,
					]
				: []),
			`Answer with bot action ask (agentId ${leader.agentId}); the goal goes on with that turn. The owner can stop it with /lead cancel ${leader.agentId}.`,
		].join("\n");
		const message = {
			customType: LEADER_QUESTION_CUSTOM_TYPE,
			display: true,
			content,
			details: {
				objectiveId: record.objectiveId,
				leader: leader.agentId,
				attemptId: attempt.attemptId,
				...(touchedByThirdParty(snapshot, [attempt]) ? { thirdParty: true } : {}),
			},
		};
		await this.deliverOnce(deliveryId, message);
	}

	private async deliverOnce(deliveryId: string, message: ParentInputDelivery["message"]): Promise<boolean> {
		try {
			await this.deps.deliver({
				deliveryId,
				payloadDigest: canonicalDigest({ message }),
				message,
				origin: this.deps.origin(),
			});
			this.delivered.add(deliveryId);
			return true;
		} catch (error) {
			// Delivery is retried by the next pass; the durable record already holds what it says.
			harnessLog.warn("leaders", "a leader notice could not reach the orchestrator yet", () => ({
				deliveryId,
				error: error instanceof Error ? error.message : String(error),
			}));
			return false;
		}
	}

	private displayName(alias: string): string {
		return this.deps.bots().find((bot) => bot.agentId === alias)?.displayName ?? alias;
	}

	/** One alarm for the earliest open deadline; firing runs a pass, which closes what is due and re-arms. */
	private armDeadline(): void {
		const next = this.ledger
			.list()
			.filter((record) => record.state === "running" && record.charter.envelope.deadlineAt !== undefined)
			.map((record) => Date.parse(record.charter.envelope.deadlineAt!))
			.filter((at) => Number.isFinite(at))
			.sort((left, right) => left - right)[0];
		if (this.timer && this.timer.at === next) return;
		if (this.timer) this.deps.timers.clearTimeout(this.timer.handle);
		this.timer = undefined;
		if (next === undefined || this.disposed) return;
		const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, next - this.deps.now()));
		this.timer = {
			at: next,
			handle: this.deps.timers.setTimeout(() => {
				this.timer = undefined;
				this.trigger();
			}, delay),
		};
	}

	private notifyListeners(): void {
		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch {
				// A view listener never stops the controller.
			}
		}
	}
}

const EARLY_CLOSE: Readonly<
	Partial<Record<DelegationCloseReason, { status: OutcomeStatus; blocker: BlockerCode; nextAction: NextAction }>>
> = {
	cancelled: {
		status: "cancelled",
		blocker: "cancelled_by_owner",
		nextAction: { kind: "abandon", reason: "cancelled" },
	},
	deadline: {
		status: "blocked",
		blocker: "deadline_reached",
		nextAction: { kind: "fix_request", remedy: "Lead it again with more time or a smaller goal." },
	},
	budget: {
		status: "blocked",
		blocker: "budget_exhausted",
		nextAction: { kind: "fix_request", remedy: "Lead it again with a larger budget or a smaller goal." },
	},
	allowance: {
		status: "blocked",
		blocker: "budget_exhausted",
		nextAction: { kind: "fix_request", remedy: "Lead it again once the subscription's usage window reopens." },
	},
	leader_unavailable: {
		status: "failed",
		blocker: "request_rejected",
		nextAction: { kind: "fix_request", remedy: "Name another leader, or leave agentId out to appoint one." },
	},
};

/** The objective a turn's work is filed under: the delegation's own when the turn was started under it. */
function filedObjectiveOf(snapshot: TaskRuntimeProjection, attempt: AttemptRuntimeState): string | undefined {
	return snapshot.tasks[attempt.taskId]?.task.objectiveId;
}

/** The cost the harness recorded for these turns, the figure the worker tree budget reads too. */
function spentUsd(attempts: readonly AttemptRuntimeState[]): number {
	return attempts.reduce((sum, attempt) => {
		const usd = attempt.usageAccounting?.total.costUsd ?? attempt.result?.usage.costUsd ?? 0;
		return sum + (Number.isFinite(usd) && usd > 0 ? usd : 0);
	}, 0);
}

/** A notice reporting work a third party's words reached opens a third-party run, as a worker handoff does. */
function touchedByThirdParty(snapshot: TaskRuntimeProjection, attempts: readonly AttemptRuntimeState[]): boolean {
	return attempts.some((attempt) => conversationTurnOrigin(snapshot.attempts, attempt)?.thirdParty === true);
}
