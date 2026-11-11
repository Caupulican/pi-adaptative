/**
 * Leaders as sub-orchestrators: the root hands a goal to a leader bot, the leader works it with the bots it owns, and the
 * root hears back once, with one bounded Outcome, when the goal ends. A leader whose goal may nest (`leaders.maxDepth` above
 * 1) hands a part of it to a leader of its own: that part's Outcome goes to the leader that handed it on, and the goal
 * settles only after every part it handed on has ended and its Outcome reached that leader. A leader is a privileged
 * worker, never a second root: its turns are ordinary bot turns the root's controller admits, its authority is its parent's
 * narrowed (see `leader-delegation.ts`), and everything this controller decides comes from durable facts in the root's
 * orchestration store (the delegation record, attempts, outcomes), so a restart resumes exactly where it stood.
 *
 * Decisions, all code facts:
 * - a delegation is dispatched when its leader is idle and has no earlier open delegation (one at a time, oldest first);
 * - a turn filed under a delegation's objective is the delegation's: the leader's own, and those its work started (the
 *   sender's turn carries the objective into each message it writes); its terminal notice never wakes the root;
 * - the orchestrator's words to a leader for a goal are filed under that goal, an owner's chat with the leader is not;
 * - the delegation is final when the leader's latest turn ended, no leader turn or owned-bot turn is still running, no goal
 *   it handed on is open or undelivered, and that turn did not ask the orchestrator; then the Outcome (the children's
 *   aggregate, never re-judged) is recorded, the objective settles and the orchestrator (for a nested goal, its parent
 *   leader) is woken once;
 * - a turn that ended asking the orchestrator wakes it with that question and keeps the delegation open;
 * - the deadline, the metered budget, cancellation and a lost leader close it early, with its nested goals first (deepest
 *   first), stopping the leaders and their bots.
 */

import { randomUUID } from "node:crypto";
import { harnessLog } from "../../kernel/harness-log.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { owesParentItsResult } from "../orchestration/worker-terminal-notification.ts";
import type { ParentInputDelivery } from "../parent-input-delivery.ts";
import { strictCanonicalDigest, withoutUndefinedMembers } from "../steering/canonical.ts";
import type { BotAskRootResult } from "./bot-message-contract.ts";
import { ACTIVE_ATTEMPT_STATUSES, delegationBudgetLeftUsd, delegationBudgetStop } from "./delegation-spend.ts";
import type { LeaderAppointer, LeaderControllerDeps } from "./leader-controller-ports.ts";
import {
	admitChain,
	briefBotsOwnedBy,
	composeDelegationOutcome,
	goalLeaderRequest,
	type LeaderBotView,
	type LeaderEnvelope,
	type LeadRequest,
	type LeadResult,
	LOCAL_MACHINE_ID,
	leaderAskNotice,
	leaderEnvelopeFromRecord,
	leaderOutcomeNotice,
	leaderQuestionNotice,
	namedLeaderRefusal,
	narrowEnvelope,
	outcomeDetails,
	questionOf,
	renderLeaderBrief,
	rootLeaderEnvelope,
	touchedByThirdParty,
	UNPRICED_BUDGET_REMEDY,
} from "./leader-delegation.ts";
import {
	type DelegationCloseReason,
	type DelegationRecord,
	earliestDeadlineMs,
	LeaderDelegationLedger,
	openDescendantsDeepestFirst,
	readDelegations,
	splitTurnsByLeader,
	turnBelongsToDelegation,
} from "./leader-delegation-ledger.ts";
import { currentDelegationFor } from "./leader-view.ts";
import type { WorkerTerminalHandoffRecord } from "./worker-notification-coordinator.ts";
import { type Outcome, sameOutcomeAttempt } from "./worker-outcome.ts";

export const LEADER_OUTCOME_CUSTOM_TYPE = "leader-outcome";
export const LEADER_QUESTION_CUSTOM_TYPE = "leader-question";

/** The longest single timer the platform keeps; a later deadline re-arms when this one fires. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

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
	/** Serializes `deps.send` per leader so concurrent goal dispatches, updates, resumes and child notices never race. */
	private readonly sendChains = new Map<string, Promise<unknown>>();
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

	/** Whether a turn belongs to a delegation (see `turnBelongsToDelegation`). */
	private belongs(snapshot: TaskRuntimeProjection, record: DelegationRecord, attempt: AttemptRuntimeState): boolean {
		return turnBelongsToDelegation({
			snapshot,
			record,
			attempt,
			directBotOf: (agentId) => this.deps.directBotOf(agentId),
			bots: () => this.deps.bots(),
		});
	}

	/** Every turn that belongs to a delegation, oldest first. */
	private turnsOf(snapshot: TaskRuntimeProjection, record: DelegationRecord): AttemptRuntimeState[] {
		return Object.values(snapshot.attempts)
			.filter((attempt) => this.belongs(snapshot, record, attempt))
			.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
	}

	/** Opens a leader's fleet subtree once; a goal still running keeps it open. */
	private ensureSubtree(leader: string, parentLeader: string | undefined): void {
		if (this.openSubtrees.has(leader)) return;
		this.deps.openSubtree(leader, parentLeader);
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
		const claimed = readDelegations(snapshot).some((delegation) => this.belongs(snapshot, delegation, attempt));
		if (claimed) queueMicrotask(() => this.trigger());
		return claimed;
	}

	/** Opens a delegation for the orchestrator; dispatch follows as soon as the leader is free. */
	delegate(lead: LeadRequest): LeadResult {
		return this.open(lead, { envelope: rootLeaderEnvelope(this.deps.maxDepth()), appointer: { kind: "root" } });
	}

	/**
	 * Opens a nested delegation: a running leader that may delegate hands a part of its goal to a leader of its own. The
	 * part's envelope is its parent's narrowed, and its Outcome goes to the parent leader.
	 */
	delegateFrom(parentLeader: string, lead: LeadRequest): LeadResult {
		const parent = this.requireCurrent(parentLeader);
		if (parent.state !== "running")
			throw new Error(`${this.displayName(parentLeader)}'s goal is not running, so it cannot hand a part on.`);
		if (!parent.charter.envelope.capabilities.includes("delegate"))
			throw new Error("This goal cannot hand a part on: leaders.maxDepth allows no deeper nesting.");
		const remaining = delegationBudgetLeftUsd(
			this.deps.snapshot(),
			this.ledger.list(),
			parent,
			this.deps.isMeteredAttempt,
		);
		return this.open(lead, {
			envelope: leaderEnvelopeFromRecord(parent, remaining),
			record: parent,
			appointer: { kind: "leader", agentId: parentLeader },
		});
	}

	/**
	 * Opens a delegation under a parent envelope: the leader is the named standing leader or a goal leader appointed for it;
	 * the chain is admitted (no cycle, not too deep) and the envelope narrowed. A nested delegation is refused when its leader
	 * already leads a goal; a root delegation queues behind it.
	 */
	private open(
		lead: LeadRequest,
		parent: { envelope: LeaderEnvelope; record?: DelegationRecord; appointer: LeaderAppointer },
	): LeadResult {
		const bots = this.deps.bots();
		let leader: LeaderBotView;
		let appointedBy: "owner" | "root";
		let goalLeader = false;
		if (lead.agentId !== undefined) {
			const named = bots.find((bot) => bot.agentId === lead.agentId);
			const refusal = namedLeaderRefusal(named, lead.agentId);
			if (!named || refusal !== undefined) throw new Error(refusal);
			leader = named;
			const madeByLeader = bots.some((bot) => bot.leader && bot.agentId === named.createdBy);
			appointedBy = named.createdBy === "root" || madeByLeader ? "root" : "owner";
		} else {
			const created = this.deps.createGoalLeader(goalLeaderRequest(lead), parent.appointer);
			const found = this.deps.bots().find((bot) => bot.agentId === created.agentId);
			if (!found) throw new Error(`The goal leader ${created.agentId} was not saved.`);
			leader = found;
			appointedBy = "root";
			goalLeader = true;
		}
		const objectiveId = this.ledger.newObjectiveId();
		const hop = { machineId: LOCAL_MACHINE_ID, objectiveId, leader: leader.agentId };
		const maxDepth = this.deps.maxDepth();
		const admission = admitChain(parent.envelope.chain, hop, maxDepth);
		if (admission !== "ok") {
			if (goalLeader) this.deps.retire(leader.agentId);
			throw new Error(
				admission === "cycle_refused"
					? `${leader.displayName} already works on this chain of goals.`
					: "This goal would nest leaders deeper than leaders.maxDepth allows.",
			);
		}
		const nowMs = this.deps.now();
		const { envelope, clipped } = narrowEnvelope(parent.envelope, {
			lead,
			leaderCanWrite: leader.canWrite,
			appointedBy,
			hop,
			nowMs,
		});
		const ahead = this.currentFor(leader.agentId);
		if (parent.record && ahead)
			throw new Error(
				`${leader.displayName} already leads a goal; name a leader that is free, or leave agentId out to appoint a goal leader.`,
			);
		try {
			this.ledger.open(objectiveId, {
				v: 1,
				leader: leader.agentId,
				appointedBy,
				lead,
				envelope,
				clipped,
				createdAt: iso(nowMs),
				...(parent.record ? { parentObjectiveId: parent.record.objectiveId } : {}),
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

	/**
	 * Sends the leader more words for its goal; the update is recorded on the delegation first. `fromLeader` names the parent
	 * leader that sent it; without it the words come from the orchestrator.
	 */
	async update(leader: string, text: string, fromLeader?: string): Promise<void> {
		const record = this.requireCurrent(leader);
		this.ledger.recordUpdate(record.objectiveId, text);
		if (record.state === "running") {
			const source = fromLeader === undefined ? "the orchestrator" : this.displayName(fromLeader);
			const content = `Update from ${source} for your goal:\n${text}`;
			await this.sendToLeader(leader, content, record.objectiveId, { fromLeader });
		}
	}

	async cancel(leader: string): Promise<DelegationRecord> {
		const record = this.requireCurrent(leader);
		return this.forceClose(record, "cancelled");
	}

	/**
	 * A leader's question in the middle of its goal: delivered now, the goal stays open, and the answer (`bot` action ask from
	 * the orchestrator, or `bot_message` send from the parent leader of a nested goal) is the leader's next turn. A question that
	 * did not land is refused, so the leader knows to ask again.
	 */
	async askRoot(leader: string, question: string): Promise<BotAskRootResult> {
		const record = this.currentFor(leader);
		if (record?.state !== "running") throw new Error(`${leader} has no goal running to ask about.`);
		const askId = `${record.objectiveId}:ask:${randomUUID().replace(/-/g, "").slice(0, 16)}`;
		const deliveryId = `leader-ask:${askId}`;
		const notice = { title: record.title, leader, leaderName: this.displayName(leader), askId, question };
		const parent = this.parentOf(record);
		if (parent) {
			if (parent.state !== "running")
				throw new Error("The leader that handed this goal on is paused; ask again later.");
			if (
				!(await this.sendToParent(parent, leaderAskNotice({ ...notice, to: "parent_leader" }), deliveryId, leader))
			)
				throw new Error("The leader that handed this goal on did not receive the question yet; ask again.");
			return { askId };
		}
		const delivered = await this.deliverOnce(deliveryId, {
			customType: LEADER_QUESTION_CUSTOM_TYPE,
			display: true,
			content: leaderAskNotice({ ...notice, to: "orchestrator" }),
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
		await this.sendToLeader(leader, "Continue your goal from where you stopped.", record.objectiveId);
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
		for (const listed of records) {
			// A nested goal that an earlier cascade of this pass closed is read from the store, not from the snapshot taken before it.
			const record = this.ledger.get(listed.objectiveId) ?? listed;
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
			this.ensureSubtree(leader.agentId, this.parentOf(record, records)?.charter.leader);
			const deadline = record.charter.envelope.deadlineAt;
			if (deadline !== undefined && Date.parse(deadline) <= nowMs) {
				await this.forceClose(record, "deadline");
				changed = true;
				continue;
			}
			// Every turn filed under this delegation: the leader's own and those its work started, nothing else.
			const delegated = this.turnsOf(snapshot, record);
			const { leaderTurns, ownedTurns } = splitTurnsByLeader(delegated, aliasOf, leader.agentId);
			const stop = delegationBudgetStop(record, snapshot, records, delegated, this.deps.isMeteredAttempt);
			if (stop !== undefined) {
				await this.forceClose(record, "budget", stop === "unpriced" ? UNPRICED_BUDGET_REMEDY : undefined);
				changed = true;
				continue;
			}
			const ranAliases = [
				...new Set([
					leader.agentId,
					...delegated.flatMap((turn) => {
						const alias = turn.agentId === undefined ? undefined : aliasOf(turn.agentId);
						return alias === undefined ? [] : [alias];
					}),
				]),
			];
			if (this.deps.subscriptionExhausted(ranAliases)) {
				await this.forceClose(record, "allowance");
				changed = true;
				continue;
			}
			const last = leaderTurns.at(-1);
			if (!last || ACTIVE_ATTEMPT_STATUSES.has(last.status)) continue;
			// A bot's result that has not reached the agent that started it is the goal's unfinished work: its handoff files
			// that agent's next turn under the goal, and a goal that settled first would leave that turn outside it.
			if (ownedTurns.some((turn) => ACTIVE_ATTEMPT_STATUSES.has(turn.status) || owesParentItsResult(snapshot, turn)))
				continue;
			// A message filed under this goal still waiting in a bot's mailbox is the goal's unfinished work; an owner's chat is not.
			if (this.deps.hasPendingDelegatedMessage(record.objectiveId)) continue;
			const lastOutcome = sameOutcomeAttempt(snapshot.tasks[last.taskId]?.outcome, last.attemptId);
			if (
				lastOutcome &&
				(lastOutcome.nextAction.kind === "ask_owner" || lastOutcome.nextAction.kind === "ask_root")
			) {
				await this.deliverQuestion(record, leader, last, lastOutcome, snapshot, records);
				continue;
			}
			// A goal this leader handed on settles first: each one is open, or its Outcome has not reached this leader yet.
			const handedOn = records.filter((child) => child.charter.parentObjectiveId === record.objectiveId);
			if (handedOn.some((child) => isOpen(child) || !child.outcomeDeliveredToParent)) continue;
			const outcome = this.composeOutcome(record, snapshot, leaderTurns, ownedTurns, "settled");
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

	/**
	 * The open delegation a nested goal was handed on under: its parent leader receives the goal's notices while that goal is
	 * open. Undefined for a goal the orchestrator delegated, and once its parent is closed or missing (the orchestrator hears
	 * about it then).
	 */
	private parentOf(
		record: DelegationRecord,
		records: readonly DelegationRecord[] = this.ledger.list(),
	): DelegationRecord | undefined {
		const parentId = record.charter.parentObjectiveId;
		const parent = parentId === undefined ? undefined : records.find((entry) => entry.objectiveId === parentId);
		return parent && isOpen(parent) ? parent : undefined;
	}

	private sendToLeader(
		leader: string,
		content: string,
		objectiveId: string,
		options?: { readonly idempotencyKey?: string; readonly fromLeader?: string },
	): Promise<void> {
		const prior = this.sendChains.get(leader) ?? Promise.resolve();
		const run = prior.catch(() => undefined).then(() => this.deps.send(leader, content, objectiveId, options));
		const settled = run.then(
			() => undefined,
			() => undefined,
		);
		this.sendChains.set(leader, settled);
		void settled.then(() => {
			if (this.sendChains.get(leader) === settled) this.sendChains.delete(leader);
		});
		return run;
	}

	/**
	 * Sends a notice from a nested leader (`fromLeader`) to the parent leader of its goal, filed under that parent's goal. The
	 * key makes a repeated send one message, so a restart that sends again delivers nothing twice. A send that did not land
	 * returns false and is retried.
	 */
	private async sendToParent(
		parent: DelegationRecord,
		content: string,
		idempotencyKey: string,
		fromLeader: string,
	): Promise<boolean> {
		try {
			await this.sendToLeader(parent.charter.leader, content, parent.objectiveId, { idempotencyKey, fromLeader });
			return true;
		} catch (error) {
			harnessLog.warn("leaders", "a nested leader's notice could not reach the parent leader yet", () => ({
				idempotencyKey,
				error: error instanceof Error ? error.message : String(error),
			}));
			return false;
		}
	}

	/** Every pending terminal notice of a delegation's leader turn is consumed here; the store already says what it means. */
	private acknowledgeClaimed(snapshot: TaskRuntimeProjection, records: readonly DelegationRecord[]): void {
		const ids: string[] = [];
		for (const notification of Object.values(snapshot.notifications)) {
			if (notification.status !== "pending" || !notification.attemptId) continue;
			const attempt = snapshot.attempts[notification.attemptId];
			if (!attempt || ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) continue;
			if (records.some((record) => this.belongs(snapshot, record, attempt))) ids.push(notification.notificationId);
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
			const brief = renderLeaderBrief({
				lead: record.charter.lead,
				envelope: record.charter.envelope,
				clipped: record.charter.clipped,
				ownedBots: briefBotsOwnedBy(bots.values(), leader.agentId),
			});
			this.ledger.markDispatched(record.objectiveId);
			changed = true;
			try {
				await this.sendToLeader(leader.agentId, brief, record.objectiveId, {
					idempotencyKey: `leader-dispatch:${record.objectiveId}`,
				});
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

	/**
	 * Ends a delegation before its leader did: stop the leader and its bots, record the Outcome, wake the orchestrator. Its
	 * nested goals end first, deepest first, and every one is recorded closed before any is settled: a settled nested goal's
	 * Outcome then goes to the orchestrator, not to a parent that is closing.
	 */
	private async forceClose(
		record: DelegationRecord,
		reason: DelegationCloseReason,
		remedy?: string,
	): Promise<DelegationRecord> {
		const closing = [...openDescendantsDeepestFirst(this.ledger.list(), record.objectiveId), record];
		const closed = closing.map((entry) => this.closeRecord(entry, reason, entry === record ? remedy : undefined));
		const bots = new Map(this.deps.bots().map((bot) => [bot.agentId, bot]));
		for (const entry of closed) {
			await this.settleClosed(entry, this.deps.snapshot(), bots, (agentId) => this.deps.directBotOf(agentId));
		}
		this.notifyListeners();
		return closed[closed.length - 1] ?? record;
	}

	/** Stops one delegation's leader and records its Outcome as the close: the settle (delivery) follows the whole cascade. */
	private closeRecord(record: DelegationRecord, reason: DelegationCloseReason, remedy?: string): DelegationRecord {
		if (record.state === "running" || record.state === "paused") this.deps.stop(record.charter.leader);
		const snapshot = this.deps.snapshot();
		const { leaderTurns, ownedTurns } = splitTurnsByLeader(
			this.turnsOf(snapshot, record),
			(agentId) => this.deps.directBotOf(agentId),
			record.charter.leader,
		);
		const outcome = this.composeOutcome(record, snapshot, leaderTurns, ownedTurns, reason, remedy);
		const closed = this.ledger.close(record.objectiveId, outcome, reason);
		harnessLog.info("leaders", "a delegated goal was closed early", () => ({
			leader: record.charter.leader,
			reason,
		}));
		return closed;
	}

	/** The delegation's Outcome at this moment; see `composeDelegationOutcome`. */
	private composeOutcome(
		record: DelegationRecord,
		snapshot: TaskRuntimeProjection,
		leaderTurns: readonly AttemptRuntimeState[],
		ownedTurns: readonly AttemptRuntimeState[],
		reason: DelegationCloseReason,
		remedy?: string,
	): Outcome {
		return composeDelegationOutcome({
			objectiveId: record.objectiveId,
			snapshot,
			leaderAttempts: leaderTurns,
			ownedAttempts: ownedTurns,
			reason,
			remedy,
			recordedAt: iso(this.deps.now()),
		});
	}

	/** After a close: wake the orchestrator (or the parent leader) once with the Outcome, then retire a goal leader whose only goal this was. */
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

	/**
	 * Delivers a closed goal's Outcome once: to its parent leader while that goal is open (recorded on the goal, so a restart
	 * does not send again), else to the orchestrator as before. Returns whether the Outcome is delivered.
	 */
	private async deliverOutcome(
		record: DelegationRecord,
		snapshot: TaskRuntimeProjection,
		aliasOf: (agentId: string) => string | undefined,
	): Promise<boolean> {
		const outcome = record.outcome;
		if (!outcome) return false;
		const deliveryId = `leader-outcome:${record.objectiveId}`;
		if (record.outcomeDeliveredToParent || this.delivered.has(deliveryId)) return true;
		const { leaderTurns } = splitTurnsByLeader(this.turnsOf(snapshot, record), aliasOf, record.charter.leader);
		const last = leaderTurns.at(-1);
		const notice = {
			title: record.title,
			objectiveId: record.objectiveId,
			leaderName: this.displayName(record.charter.leader),
			closeReason: record.closeReason,
			outcome,
			report: record.closeReason === "settled" ? last?.result?.summary?.trim() : undefined,
		};
		const parent = this.parentOf(record);
		if (parent) {
			// A paused parent takes the Outcome when it resumes: the next pass retries it.
			if (parent.state !== "running") return false;
			const content = leaderOutcomeNotice({ ...notice, to: "parent_leader" });
			if (!(await this.sendToParent(parent, content, deliveryId, record.charter.leader))) return false;
			this.delivered.add(deliveryId);
			this.ledger.recordChildOutcomeDelivered(record.objectiveId);
			return true;
		}
		if (this.delivered.has(deliveryId) || this.deps.hasDelivered(deliveryId)) return true;
		return this.deliverOnce(deliveryId, {
			customType: LEADER_OUTCOME_CUSTOM_TYPE,
			display: true,
			content: leaderOutcomeNotice({ ...notice, to: "orchestrator" }),
			details: {
				objectiveId: record.objectiveId,
				leader: record.charter.leader,
				outcome: outcomeDetails(outcome),
				...(record.closeReason ? { closeReason: record.closeReason } : {}),
				...(touchedByThirdParty(snapshot, leaderTurns) ? { thirdParty: true } : {}),
			},
		});
	}

	/**
	 * A leader's turn that ended with a question. An `ask_root` question goes to the parent leader of a nested goal, an
	 * `ask_owner` question always to the orchestrator; the answer is the leader's next turn.
	 */
	private async deliverQuestion(
		record: DelegationRecord,
		leader: LeaderBotView,
		attempt: AttemptRuntimeState,
		outcome: Outcome,
		snapshot: TaskRuntimeProjection,
		records: readonly DelegationRecord[],
	): Promise<void> {
		const deliveryId = `leader-question:${record.objectiveId}:${attempt.attemptId}`;
		if (this.delivered.has(deliveryId) || this.deps.hasDelivered(deliveryId)) return;
		const notice = {
			title: record.title,
			objectiveId: record.objectiveId,
			leader: leader.agentId,
			leaderName: leader.displayName,
			outcome,
			question: questionOf(outcome),
			report: attempt.result?.summary?.trim(),
			attemptId: attempt.attemptId,
		};
		const parent = outcome.nextAction.kind === "ask_root" ? this.parentOf(record, records) : undefined;
		if (parent) {
			if (parent.state !== "running") return;
			const content = leaderQuestionNotice({ ...notice, to: "parent_leader" });
			if (await this.sendToParent(parent, content, deliveryId, leader.agentId)) this.delivered.add(deliveryId);
			return;
		}
		await this.deliverOnce(deliveryId, {
			customType: LEADER_QUESTION_CUSTOM_TYPE,
			display: true,
			content: leaderQuestionNotice({ ...notice, to: "orchestrator" }),
			details: {
				objectiveId: record.objectiveId,
				leader: leader.agentId,
				attemptId: attempt.attemptId,
				...(touchedByThirdParty(snapshot, [attempt]) ? { thirdParty: true } : {}),
			},
		});
	}

	private async deliverOnce(deliveryId: string, message: ParentInputDelivery["message"]): Promise<boolean> {
		try {
			await this.deps.deliver({
				deliveryId,
				payloadDigest: strictCanonicalDigest(withoutUndefinedMembers({ message })),
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
		const next = earliestDeadlineMs(this.ledger.list());
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
