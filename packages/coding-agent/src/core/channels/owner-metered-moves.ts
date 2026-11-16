/**
 * The owner pool's hold on the moves of the session an owner turn runs in to metered (API) models (`MeteredMoveGate`). An
 * owner turn accepted while its model's spend was not metered (`quota`) charges its channel's owner pool nothing
 * (`ownerBatchCharge`), so before the session moves it to a metered model the turn is reserved its per-turn bound on the
 * pool: its batch's `quota` mark is cleared in the journal, from which the pool charges it as a metered turn
 * (`ownerMaxUsdPerTurn` while it runs, its recorded spend once settled), and the per-turn dollar bound holds its spend.
 * While the pool's day bound has no room for the turns a move would reserve, or the journal that holds them does not
 * read, the move is held: the quota fallback admits no metered model and a failover leaves the work where it is. A move
 * that is made whatever the gate says (an explicit model choice, an owner turn that starts on a metered model) is charged
 * whether or not the bound has room. Only an owner turn that holds the session's foreground counts: its run in progress,
 * or its submission preparing it as its own turn, accepted or not yet (one queued behind another turn has not started,
 * and starts on whichever model the session is on then), so the owner's own turns at the terminal are never the pool's.
 * A turn not yet accepted has no batch to reserve: its offer already holds its per-turn bound on the pool (an approval
 * turn, offered by no message, needs room for one more), and once accepted after a move to a metered model its batch is
 * recorded as a metered turn. A move that reserves on one channel and finds no room on another keeps the first
 * reservation: the stricter reading.
 */

import type { MeteredMoveGate, MeteredMoveMode } from "../agent-session-model-access.ts";
import { interfaceText } from "../language/interface-text.ts";
import type { ChannelJournal, ChannelJournalState, ChannelJournalUpdate } from "./channel-journal.ts";
import type { ResolvedChannelPolicy } from "./channel-policy.ts";
import { ownerMoveFits } from "./owner-channel.ts";

/** An owner turn the channels core offered or runs, as the hold reads it; `metered` once a move was reserved for it. */
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
	/** Whether the turn `ref` opened holds the session's foreground now (`OwnerChannelDelivery.holdsForeground`). */
	started(ref: string): boolean;
	now(): number;
	warn(message: string): void;
}

/** What a decision asks: whether a move fits, or the move reserved (`MeteredMoveMode`). */
type MoveDecision = "fits" | MeteredMoveMode;

/** One channel's owner turns that hold the session's foreground, by batch id: accepted, or still being prepared. */
interface HeldTurns {
	readonly accepted: Set<string>;
	readonly preparing: Set<string>;
}

export class OwnerMeteredMoves implements MeteredMoveGate {
	private readonly ports: OwnerMeteredMovePorts;
	/** The channels and cause kinds a move was not reserved or charged for, told once each until the channel's next one is. */
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

	/** The owner turns holding the session's foreground now, by channel: accepted ones and those still being prepared. */
	private holding(): Map<string, HeldTurns> {
		const byChannel = new Map<string, HeldTurns>();
		for (const [ref, run] of this.ports.runs) {
			if (!this.ports.started(ref)) continue;
			const turns = byChannel.get(run.name) ?? { accepted: new Set<string>(), preparing: new Set<string>() };
			(run.accepted ? turns.accepted : turns.preparing).add(ref);
			byChannel.set(run.name, turns);
		}
		return byChannel;
	}

	/** The turns among `preparing` that no owner offer to this session holds on the pool: each needs room for one more. */
	private unoffered(state: ChannelJournalState, preparing: ReadonlySet<string>): number {
		const sessionId = this.ports.sessionId();
		const offered = new Set(
			state.pending.flatMap((entry) =>
				entry.owner === true && entry.offeredTo === sessionId && entry.offeredBatch ? [entry.offeredBatch] : [],
			),
		);
		return [...preparing].filter((ref) => !offered.has(ref)).length;
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
	 * written whatever the room, its turns are held to their per-turn dollar bound even when the write fails. Only the
	 * accepted turns' marks are written; a channel holding only a turn being prepared writes nothing.
	 */
	private decide(decision: MoveDecision): boolean {
		const now = this.ports.now();
		const charge = decision === "charge";
		for (const [name, turns] of this.holding()) {
			const policy = this.ports.policy(name);
			// The accepted turns to reserve and the prepared ones no offer holds yet, beside what the pool holds (the offers
			// of the turns being prepared included). With the channel's policy gone mid-turn no pool takes it: held.
			const fits = (state: ChannelJournalState, unreserved: ReadonlySet<string>) =>
				charge ||
				(unreserved.size === 0 && turns.preparing.size === 0) ||
				(policy !== undefined &&
					ownerMoveFits(name, state, policy, now, unreserved.size + this.unoffered(state, turns.preparing)));
			const journal = this.ports.journal(name);
			const read = this.readState(name, journal, charge);
			const unreserved = read === undefined ? undefined : this.unreserved(read, turns.accepted);
			if (!charge && (read === undefined || unreserved === undefined || !fits(read, unreserved))) return false;
			if (decision === "fits") continue;
			const written = !unreserved?.size || this.write(name, journal, turns, fits, now, charge);
			if (!written && !charge) return false;
			for (const ref of [...turns.accepted, ...turns.preparing]) {
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
			this.tellFailure(name, error, charge);
			return undefined;
		}
		if (!read.reset) return read.result;
		const unparsable = interfaceText().notices.channels.owner.journalUnparsable;
		this.tell(name, "unparsable", unparsable, charge);
		return undefined;
	}

	/** Clears the `quota` marks of the turns `refs` names under the journal's lock; false (told) when not written. */
	private write(
		name: string,
		journal: ChannelJournal,
		turns: HeldTurns,
		fits: (state: ChannelJournalState, unreserved: ReadonlySet<string>) => boolean,
		now: number,
		charge: boolean,
	): boolean {
		try {
			const written = journal.update(now, (state) => {
				const ids = this.unreserved(state, turns.accepted);
				if (!fits(state, ids)) return false;
				state.batches = state.batches.map((batch) => {
					if (!ids.has(batch.id)) return batch;
					const { quota: _reserved, ...metered } = batch;
					return metered;
				});
				return true;
			});
			// A journal that stopped parsing since it was read was moved aside: the turns it held are not reserved.
			if (written.reset)
				this.tell(name, "unparsable", interfaceText().notices.channels.owner.journalUnparsable, charge);
			else if (written.result) this.clearTold(name);
			return written.result && !written.reset;
		} catch (error) {
			this.tellFailure(name, error, charge);
			return false;
		}
	}

	/** A read or write that threw, told once per cause: a system error by its code (its message names the file it met). */
	private tellFailure(name: string, error: unknown, charge: boolean): void {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		const kind = typeof code === "string" ? code : error instanceof Error ? error.name : "thrown";
		this.tell(name, kind, error instanceof Error ? error.message : String(error), charge);
	}

	/** Tells that a move was not reserved (or not charged) on channel `name` for `cause`, once per channel and `kind`. */
	private tell(name: string, kind: string, cause: string, charge: boolean): void {
		const key = `${name}\n${kind}`;
		if (this.told.has(key)) return;
		this.told.add(key);
		const words = interfaceText().notices.channels.owner;
		this.ports.warn(charge ? words.moveNotCharged(name, cause) : words.moveNotReserved(name, cause));
	}

	private clearTold(name: string): void {
		for (const key of this.told) if (key.startsWith(`${name}\n`)) this.told.delete(key);
	}
}
