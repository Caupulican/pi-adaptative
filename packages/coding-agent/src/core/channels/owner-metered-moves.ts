/**
 * The owner pool's hold on the moves of the session an owner turn runs in to metered (API) models (`MeteredMoveGate`). An
 * owner turn accepted while its model's spend was not metered (`quota`) charges its channel's owner pool nothing
 * (`ownerBatchCharge`), so before the session moves it to a metered model the turn is reserved its per-turn bound on the
 * pool: its batch's `quota` mark is cleared in the journal, from which the pool charges it as a metered turn
 * (`ownerMaxUsdPerTurn` while it runs, its recorded spend once settled), and the per-turn dollar bound holds its spend.
 * While the pool's day bound has no room for the turns a move would reserve, the move is held: the quota fallback admits
 * no metered model and a failover leaves the work where it is. With no such turn running nothing is held, so the owner's
 * own turns at the terminal are never the pool's. A move that reserves on one channel and finds no room on another keeps
 * the first reservation: the stricter reading.
 */

import type { MeteredMoveGate } from "../agent-session-model-access.ts";
import { interfaceText } from "../language/interface-text.ts";
import type { ChannelJournal, ChannelJournalState } from "./channel-journal.ts";
import type { ResolvedChannelPolicy } from "./channel-policy.ts";
import { ownerMoveFits } from "./owner-channel.ts";

/** An owner turn the channels core runs, as the hold reads it: accepted ones count; `metered` once its move was reserved. */
export interface OwnerMoveRun {
	readonly name: string;
	readonly accepted: boolean;
	/** Reserved on its pool by a move to a metered model: the per-turn dollar bound holds its spend from then on. */
	metered?: true;
}

export interface OwnerMeteredMovePorts {
	/** The owner turns this session offered or runs, by batch id (their `ref`). */
	readonly runs: ReadonlyMap<string, OwnerMoveRun>;
	policy(name: string): ResolvedChannelPolicy | undefined;
	journal(name: string): ChannelJournal;
	sessionId(): string;
	now(): number;
	warn(message: string): void;
}

export class OwnerMeteredMoves implements MeteredMoveGate {
	private readonly ports: OwnerMeteredMovePorts;
	/** Channels whose reservation was not written, told once each until one is. */
	private readonly notWritten = new Set<string>();

	constructor(ports: OwnerMeteredMovePorts) {
		this.ports = ports;
	}

	fits(): boolean {
		return this.decide(false);
	}

	reserve(): boolean {
		return this.decide(true);
	}

	/** The accepted owner turns this session runs, by channel: their batch ids. */
	private running(): Map<string, Set<string>> {
		const byChannel = new Map<string, Set<string>>();
		for (const [ref, run] of this.ports.runs) {
			if (!run.accepted) continue;
			const refs = byChannel.get(run.name) ?? new Set<string>();
			refs.add(ref);
			byChannel.set(run.name, refs);
		}
		return byChannel;
	}

	/** The batch ids among `refs` this session accepted on a subscription and has not reserved: what a move reserves. */
	private unreserved(state: ChannelJournalState, refs: ReadonlySet<string>): Set<string> {
		const sessionId = this.ports.sessionId();
		const ids = state.batches.filter(
			(batch) =>
				batch.owner === true &&
				batch.quota === true &&
				batch.state === "accepted" &&
				batch.sessionId === sessionId &&
				refs.has(batch.id),
		);
		return new Set(ids.map((batch) => batch.id));
	}

	/** Whether each channel's pool has room for its turns a move reserves; with `reserve`, reserves them, channel by channel. */
	private decide(reserve: boolean): boolean {
		const now = this.ports.now();
		for (const [name, refs] of this.running()) {
			const policy = this.ports.policy(name);
			// With the channel's policy gone mid-turn no pool takes the charge: the move is held.
			const fits = (state: ChannelJournalState, count: number) =>
				count === 0 || (policy !== undefined && ownerMoveFits(name, state, policy, now, count));
			const journal = this.ports.journal(name);
			const read = journal.read().result;
			if (!fits(read, this.unreserved(read, refs).size)) return false;
			if (!reserve) continue;
			try {
				const written = journal.update(now, (state) => {
					const ids = this.unreserved(state, refs);
					if (!fits(state, ids.size)) return false;
					state.batches = state.batches.map((batch) => {
						if (!ids.has(batch.id)) return batch;
						const { quota: _reserved, ...metered } = batch;
						return metered;
					});
					return true;
				});
				if (!written.result) return false;
			} catch (error) {
				const cause = error instanceof Error ? error.message : String(error);
				if (!this.notWritten.has(name))
					this.ports.warn(interfaceText().notices.channels.owner.moveNotReserved(name, cause));
				this.notWritten.add(name);
				return false;
			}
			this.notWritten.delete(name);
			for (const ref of refs) {
				const run = this.ports.runs.get(ref);
				if (run) run.metered = true;
			}
		}
		return true;
	}
}
