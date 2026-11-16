/**
 * The owner pool's hold on the moves of the session an owner turn runs in to metered (API) models (`MeteredMoveGate`). An
 * owner turn accepted while its model's spend was not metered (`quota`) charges its channel's owner pool nothing
 * (`ownerBatchCharge`), so before the session moves it to a metered model the turn is reserved its per-turn bound on the
 * pool: its batch's `quota` mark is cleared in the journal, from which the pool charges it as a metered turn
 * (`ownerMaxUsdPerTurn` while it runs, its recorded spend once settled), and the per-turn dollar bound holds its spend.
 * While the pool's day bound has no room for the turns a move would reserve, or the journal that holds them does not
 * read, the move is held: the quota fallback admits no metered model and a failover leaves the work where it is. A move
 * that is made whatever the gate says (an explicit model choice, an owner turn that starts on a metered model) is charged
 * whether or not the bound has room. Only an owner turn that runs now counts (one queued behind another turn has not
 * started, and starts on whichever model the session is on then), so the owner's own turns at the terminal are never
 * the pool's. A move that reserves on one channel and finds no room on another keeps the first reservation: the stricter
 * reading.
 */

import type { MeteredMoveGate, MeteredMoveMode } from "../agent-session-model-access.ts";
import { interfaceText } from "../language/interface-text.ts";
import type { ChannelJournal, ChannelJournalState, ChannelJournalUpdate } from "./channel-journal.ts";
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
	/** Whether the turn `ref` opened is the session's run in progress now (`OwnerChannelDelivery.isRunning`). */
	started(ref: string): boolean;
	now(): number;
	warn(message: string): void;
}

/** What a decision asks: whether a move fits, or the move reserved (`MeteredMoveMode`). */
type MoveDecision = "fits" | MeteredMoveMode;

export class OwnerMeteredMoves implements MeteredMoveGate {
	private readonly ports: OwnerMeteredMovePorts;
	/** The channels and causes a move was not reserved or charged for, told once each until the channel's next one is. */
	private readonly told = new Set<string>();

	constructor(ports: OwnerMeteredMovePorts) {
		this.ports = ports;
	}

	fits(): boolean {
		return this.decide("fits");
	}

	reserve(mode: MeteredMoveMode = "admit"): boolean {
		return this.decide(mode);
	}

	/** The accepted owner turns this session runs now, by channel: their batch ids. */
	private running(): Map<string, Set<string>> {
		const byChannel = new Map<string, Set<string>>();
		for (const [ref, run] of this.ports.runs) {
			if (!run.accepted || !this.ports.started(ref)) continue;
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

	/**
	 * Whether each channel's pool has room for its turns a move reserves; reserving, reserves them, channel by channel. A
	 * journal that does not read or does not parse has no room. A charged move (`"charge"`) is never refused: it is
	 * written whatever the room, its turns are held to their per-turn dollar bound even when the write fails.
	 */
	private decide(decision: MoveDecision): boolean {
		const now = this.ports.now();
		const charge = decision === "charge";
		for (const [name, refs] of this.running()) {
			const policy = this.ports.policy(name);
			// With the channel's policy gone mid-turn no pool takes the charge: the move is held.
			const fits = (state: ChannelJournalState, count: number) =>
				count === 0 || charge || (policy !== undefined && ownerMoveFits(name, state, policy, now, count));
			const journal = this.ports.journal(name);
			const read = this.readState(name, journal, charge);
			if (!charge && (read === undefined || !fits(read, this.unreserved(read, refs).size))) return false;
			if (decision === "fits") continue;
			if (read !== undefined && !this.write(name, journal, refs, fits, now, charge) && !charge) return false;
			for (const ref of refs) {
				const run = this.ports.runs.get(ref);
				if (run) run.metered = true;
			}
		}
		return true;
	}

	/** The channel's journal, or undefined (told) when it does not read or does not parse. */
	private readState(name: string, journal: ChannelJournal, charge: boolean): ChannelJournalState | undefined {
		let read: ChannelJournalUpdate<ChannelJournalState>;
		try {
			read = journal.read();
		} catch (error) {
			this.tell(name, error instanceof Error ? error.message : String(error), charge);
			return undefined;
		}
		if (!read.reset) return read.result;
		this.tell(name, interfaceText().notices.channels.owner.journalUnparsable, charge);
		return undefined;
	}

	/** Clears the `quota` marks of the turns `refs` names under the journal's lock; false (told) when not written. */
	private write(
		name: string,
		journal: ChannelJournal,
		refs: ReadonlySet<string>,
		fits: (state: ChannelJournalState, count: number) => boolean,
		now: number,
		charge: boolean,
	): boolean {
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
			// A journal that stopped parsing since it was read was moved aside: the turns it held are not reserved.
			if (written.reset) this.tell(name, interfaceText().notices.channels.owner.journalUnparsable, charge);
			else if (written.result) this.clearTold(name);
			return written.result && !written.reset;
		} catch (error) {
			this.tell(name, error instanceof Error ? error.message : String(error), charge);
			return false;
		}
	}

	private tell(name: string, cause: string, charge: boolean): void {
		const key = `${name}\n${cause}`;
		if (this.told.has(key)) return;
		this.told.add(key);
		const words = interfaceText().notices.channels.owner;
		this.ports.warn(charge ? words.moveNotCharged(name, cause) : words.moveNotReserved(name, cause));
	}

	private clearTold(name: string): void {
		for (const key of this.told) if (key.startsWith(`${name}\n`)) this.told.delete(key);
	}
}
