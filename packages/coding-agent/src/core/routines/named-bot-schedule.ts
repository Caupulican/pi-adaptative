/** Delivery of a project-bound bot clock occurrence. Its bot session owns the model turn and its spend. */
import { randomUUID } from "node:crypto";
import { BotInboxFullError, enqueueBotInbox, hasNamedBotReceipt } from "../bots/bot-inbox.ts";
import type { PersistentBotTeamStore } from "../delegation/persistent-bot-team-store.ts";
import { cleanRedactBound } from "../security/secret-text.ts";
import { OWNER_STOP_CLOCK } from "../util/timer-port.ts";
import { awaySavedRoutineRefusal, namedBotSessionRefusal } from "./away-routine-admission.ts";
import type { RoutineAwayClaimGate } from "./routine-away-spend.ts";
import {
	MAX_ROUTINE_SUMMARY_CHARS,
	type PersistentRoutineDefinition,
	type RoutineDefinitionView,
	type RoutineOccurrence,
	routineEnded,
	routineOpensAt,
} from "./routine-contract.ts";
import { routineBotMessageOrigin } from "./routine-parent-input.ts";
import type { RoutineMessageResult, RoutineStorePort } from "./routine-store-port.ts";

export function botScheduleAccepted(agentId: string, mode: string): RoutineMessageResult {
	return {
		outcome: "succeeded",
		summary: `Prompt accepted by bot ${agentId} (${mode}); the bot's answer is not part of this run.`,
		facts: { reasonCode: "delivered" },
	};
}

export function queueNamedBotSchedule(agentDir: string, occurrence: RoutineOccurrence): RoutineMessageResult {
	const { target, definition, parentOrigin } = occurrence;
	if (target.kind !== "bot" || !definition.botProjectCwd || !definition.receiptOrigin)
		throw new Error("A named bot schedule requires a pinned project and receipt origin.");
	try {
		enqueueBotInbox(agentDir, {
			agentId: target.agentId,
			text: definition.prompt,
			from: { pid: process.pid, sessionId: parentOrigin.sessionId, cwd: definition.botProjectCwd },
			at: OWNER_STOP_CLOCK.now(),
			origin: routineBotMessageOrigin(occurrence, definition.prompt),
			projectBound: true,
			occurrenceCreatedAt: occurrence.createdAt,
		});
	} catch (error) {
		if (!(error instanceof BotInboxFullError)) throw error;
		return { outcome: "failed", summary: error.message, facts: { reasonCode: "bot_inbox_full", step: "dispatch" } };
	}
	return inboxAccepted(target.agentId);
}

function inboxAccepted(agentId: string): RoutineMessageResult {
	return { ...botScheduleAccepted(agentId, "queued"), facts: { reasonCode: "bot_inbox_accepted" } };
}

/** References in this projection are immutable store records. A single store revision serves every project clock. */
export function namedBotClockWork(definitions: Iterable<RoutineDefinitionView>, journal: Iterable<RoutineOccurrence>) {
	const routines = Array.from(definitions).filter((item) => item.botProjectCwd && item.enabled);
	const open = new Map<string, RoutineOccurrence[]>();
	for (const item of journal) {
		if (!item.definition.botProjectCwd || item.phase === "terminal" || item.phase === "uncertain") continue;
		const id = item.definition.incarnationId;
		const list = open.get(id);
		if (list) list.push(item);
		else open.set(id, [item]);
	}
	return { routines, open };
}

type NamedBotClockStore = RoutineStorePort & Pick<PersistentBotTeamStore, "getBot" | "namedBotWork">;

export interface NamedBotClockHost {
	readonly agentDir: string;
	readonly store: NamedBotClockStore;
	now(): number;
	/** A root serves its project. Away serves closed projects and charges only the bot's model turn. */
	serves(cwd: string): boolean;
	away?: () => RoutineAwayClaimGate;
}

/** A bounded, transcript-free clock. The receipt branch addresses results and grants no authority to the bot. */
export class NamedBotScheduleClock {
	private readonly owner = `bot-clock:${randomUUID()}`;

	private readonly host: NamedBotClockHost;

	constructor(host: NamedBotClockHost) {
		this.host = host;
	}

	advance(): { next: number; dispatched: string[]; failed: string[] } {
		const { store } = this.host;
		const nowMs = this.host.now();
		const due = new Map<string, number>();
		const recoverable: string[] = [];
		const refusals: { routineId: string; reason: string }[] = [];
		let next = Number.POSITIVE_INFINITY;
		const work = store.namedBotWork();
		for (const routine of work.routines) {
			if (
				!routine.botProjectCwd ||
				!routine.enabled ||
				routineEnded(routine, nowMs) ||
				!this.host.serves(routine.botProjectCwd) ||
				routine.target.kind !== "bot"
			)
				continue;
			const at = routineOpensAt(routine, work.open.get(routine.incarnationId) ?? []);
			if (at > nowMs) {
				next = Math.min(next, at);
				continue;
			}
			const bot = store.getBot(routine.target.agentId);
			const reason = this.host.away ? awaySavedRoutineRefusal(routine, undefined, bot) : namedBotSessionRefusal(bot);
			if (!reason) due.set(routine.routineId, routine.revision);
			else if (this.host.away && routine.awayRefusal?.reason !== reason)
				refusals.push({ routineId: routine.routineId, reason });
		}
		for (const runs of work.open.values())
			for (const run of runs) {
				const cwd = run.definition.botProjectCwd;
				if (run.target.kind !== "bot" || !cwd || !this.host.serves(cwd) || (run.claim && !namedBotClockClaim(run)))
					continue;
				if (run.phase !== "claimed" && run.phase !== "dispatching" && run.phase !== "pending") continue;
				if (run.claim && run.claim.leaseUntil > nowMs) {
					next = Math.min(next, run.claim.leaseUntil);
					continue;
				}
				if (run.phase === "dispatching" && run.claim) {
					if (hasNamedBotReceipt(this.host.agentDir, run.target.agentId, run.occurrenceId, run.createdAt, cwd)) {
						store.finishRoutineOccurrence({
							occurrenceId: run.occurrenceId,
							claimToken: run.claim.token,
							nowMs,
							recipient: run.parentOrigin.sessionId,
							...inboxAccepted(run.target.agentId),
							...(run.executor === "away" ? { awaySpentUsd: 0 } : {}),
						});
						continue;
					}
					store.markRoutineUncertain({
						occurrenceId: run.occurrenceId,
						claimToken: run.claim.token,
						nowMs,
						recipient: run.parentOrigin.sessionId,
						reason: "Bot dispatch was interrupted; its prompt was not sent again.",
						facts: { reasonCode: "dispatch_interrupted" },
					});
				} else if (!namedBotSessionRefusal(store.getBot(run.target.agentId))) recoverable.push(run.occurrenceId);
			}
		if (refusals.length) store.recordRoutineAwayRefusals({ refusals, nowMs });
		const dispatched: string[] = [];
		const failed: string[] = [];
		if (!due.size && !recoverable.length) return { next, dispatched, failed };
		const claim = store.claimDueRoutineOccurrences({
			owner: this.owner,
			leaseMs: BOT_CLOCK_LEASE_MS,
			nowMs,
			limit: 8,
			eligibleRoutineIds: [...due.keys()],
			eligibleOccurrenceIds: recoverable,
			namedBotRevisions: due,
			...(this.host.away ? { away: this.host.away() } : {}),
		});
		for (const run of claim.claimed) this.dispatch(run, dispatched, failed);
		return { next, dispatched, failed };
	}

	/** Checks the caller's project for an explicit manual request, returning undefined for a root-only bot. */
	manual(routine: RoutineDefinitionView, expectedRevision: number | undefined, commandId: string): string | undefined {
		if (!routine.botProjectCwd || !routine.receiptOrigin || routine.target.kind !== "bot") return undefined;
		if (!this.host.serves(routine.botProjectCwd))
			throw new Error(`Run this bot schedule in its saved project: ${routine.botProjectCwd}`);
		if (!this.owns(routine)) return undefined;
		const run = this.host.store.claimManualRoutineOccurrence({
			routineId: routine.routineId,
			expectedRevision: expectedRevision ?? routine.revision,
			commandId,
			parentSessionId: routine.receiptOrigin.sessionId,
			receiptOrigin: routine.receiptOrigin,
			owner: this.owner,
			nowMs: this.host.now(),
			leaseMs: BOT_CLOCK_LEASE_MS,
		});
		if (run.phase === "claimed" && run.claim?.owner === this.owner) this.dispatch(run, [], []);
		return run.occurrenceId;
	}

	owns(definition: PersistentRoutineDefinition): boolean {
		return (
			!!definition.botProjectCwd &&
			definition.target.kind === "bot" &&
			!namedBotSessionRefusal(this.host.store.getBot(definition.target.agentId))
		);
	}

	private dispatch(run: RoutineOccurrence, dispatched: string[], failed: string[]): void {
		const { store } = this.host;
		const nowMs = this.host.now();
		const claimToken = run.claim!.token;
		const id = { occurrenceId: run.occurrenceId, claimToken };
		const recipient = run.parentOrigin.sessionId;
		if (
			run.target.kind !== "bot" ||
			!run.definition.botProjectCwd ||
			!this.host.serves(run.definition.botProjectCwd) ||
			namedBotSessionRefusal(store.getBot(run.target.agentId))
		) {
			store.deferRoutineOccurrence({ ...id, nowMs });
			return;
		}
		store.markRoutineDispatching({ ...id, dispatchKey: `routine:${run.occurrenceId}`, nowMs });
		try {
			const result = queueNamedBotSchedule(this.host.agentDir, run);
			store.finishRoutineOccurrence({
				...id,
				...result,
				recipient,
				nowMs: this.host.now(),
				...(run.executor === "away" ? { awaySpentUsd: 0 } : {}),
			});
			if (result.outcome === "failed") failed.push(`${run.routineId}: ${result.summary}`);
			else dispatched.push(run.routineId);
		} catch (error) {
			const reason =
				cleanRedactBound(error instanceof Error ? error.message : String(error), MAX_ROUTINE_SUMMARY_CHARS) ||
				"Bot dispatch failed.";
			store.markRoutineUncertain({
				...id,
				recipient,
				nowMs: this.host.now(),
				reason,
				facts: { reasonCode: "dispatch_failed", step: "dispatch" },
			});
			failed.push(`${run.routineId}: ${reason}`);
		}
	}
}

export const BOT_CLOCK_LEASE_MS = 120_000;

export function namedBotClockClaim(run: RoutineOccurrence): boolean {
	return run.claim?.owner.startsWith("bot-clock:") === true;
}
