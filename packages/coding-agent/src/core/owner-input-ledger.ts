import { type OwnerInputId, ownerInputIdOf } from "../kernel/owner-input-stamp.ts";
import type { AgentMessage } from "../kernel/types.ts";
import { uuidv7 } from "../kernel/uuid.ts";
import { runReleaseSteps } from "./util/resource-release.ts";

export { type OwnerInputId, ownerInputIdOf, stampOwnerInput } from "../kernel/owner-input-stamp.ts";

/**
 * The owner-input ledger: the identity and the one state of every accepted input, from acceptance to its terminal. An
 * identity is minted once, at acceptance, for every source, and stamped on the user message the input becomes. Delivery
 * matches that stamp, never the message's text, its queue entry or its object. Every effect an input has is registered
 * here against its identity and fires at its commit point: on Delivered (its user entry is persisted), or once when it
 * ends without being delivered (Withdrawn, Held, Cancelled, Refused).
 */

/** Where an input was accepted. An extension's message (a peer's, say) is accepted on its untrusted path. */
export type OwnerInputSource = "prompt" | "steer" | "followUp" | "extension";

/**
 * The one state of an accepted input. `judged`: its words received their judgment. `pending`: admitted, waiting for its
 * turn to be handed to the agent's queue. `own_turn`: it runs as its own turn (that turn's preparation or run). `handed`:
 * in the agent's queue, or read by a run that has not persisted it yet. `held`: kept in full and visible, never delivered
 * on its own; it leaves only when the owner takes it back. The rest are terminals.
 */
export type OwnerInputState =
	| "accepted"
	| "judged"
	| "pending"
	| "own_turn"
	| "handed"
	| "delivered"
	| "withdrawn"
	| "held"
	| "cancelled"
	| "refused";

/** How an input ends without being delivered: taken back, kept for the owner, cut by an interrupt, or refused. */
export type OwnerInputEndState = "withdrawn" | "held" | "cancelled" | "refused";

/** A non-delivered end and why it happened. */
export interface OwnerInputEnd {
	readonly state: OwnerInputEndState;
	readonly reason: string;
}

/** The Delivered commit: the message that carried the input and the session entry it was persisted as. */
export interface OwnerInputDelivery {
	readonly id: OwnerInputId;
	readonly message: AgentMessage;
	readonly entryId: string;
}

/** What became of an input its submitter waited for: queued for delivery (no `ended`), or how it ended without delivery. */
export interface OwnerInputOutcome {
	readonly inputId: OwnerInputId;
	readonly ended?: OwnerInputEnd;
}

/** The transitions each state allows; anything else is a lifecycle defect and throws. */
const NEXT_STATES: Readonly<Record<OwnerInputState, readonly OwnerInputState[]>> = {
	accepted: ["judged", "pending", "own_turn", "withdrawn", "held", "cancelled", "refused"],
	judged: ["pending", "own_turn", "withdrawn", "held", "cancelled", "refused"],
	pending: ["handed", "withdrawn", "held", "cancelled"],
	own_turn: ["delivered", "held", "cancelled", "refused"],
	handed: ["delivered", "withdrawn", "held"],
	held: ["withdrawn"],
	delivered: [],
	withdrawn: [],
	cancelled: [],
	refused: [],
};

/** States from which an input can no longer change: its record is gone once it reaches one. */
const TERMINAL_STATES: ReadonlySet<OwnerInputState> = new Set(["delivered", "withdrawn", "cancelled", "refused"]);

interface InputRecord {
	readonly source: OwnerInputSource;
	state: OwnerInputState;
	readonly onDelivered: Array<(delivery: OwnerInputDelivery) => void>;
	readonly onUndelivered: Array<(end: OwnerInputEnd) => void>;
}

export class OwnerInputLedger {
	/** Every input that has not reached a terminal; a held input stays until the owner takes it back. */
	private readonly records = new Map<OwnerInputId, InputRecord>();
	private readonly deliveredListeners = new Set<(delivery: OwnerInputDelivery) => void>();

	/**
	 * A new input was accepted from `source`: its identity, minted now. It is unique across processes, because it
	 * outlives this one: the durable queued-input record and the user entry that delivers the input both carry it.
	 */
	accept(source: OwnerInputSource): OwnerInputId {
		const id = `${source}:${uuidv7()}` as OwnerInputId;
		this.records.set(id, { source, state: "accepted", onDelivered: [], onUndelivered: [] });
		return id;
	}

	/**
	 * An input an earlier process recorded as undelivered is open again here, held, under the identity it was accepted
	 * with (`recorded`), or a new one for a record written before inputs carried theirs. An identity already open here
	 * is a lifecycle defect and throws.
	 */
	restoreHeld(source: OwnerInputSource, recorded: string | undefined): OwnerInputId {
		const id = (recorded ?? `${source}:${uuidv7()}`) as OwnerInputId;
		if (this.records.has(id)) throw new Error(`Owner input ${id} is already open; it cannot be restored.`);
		this.records.set(id, { source, state: "held", onDelivered: [], onUndelivered: [] });
		return id;
	}

	/** The input's current state; undefined once it reached a terminal (or was never accepted here). */
	stateOf(id: OwnerInputId): OwnerInputState | undefined {
		return this.records.get(id)?.state;
	}

	/** A step on the way to delivery. Repeating the current state is no step; any transition the table forbids throws. */
	move(id: OwnerInputId, to: "judged" | "pending" | "own_turn" | "handed"): void {
		const record = this.records.get(id);
		if (record === undefined) throw new Error(`Owner input ${id} is not open; it cannot become ${to}.`);
		if (record.state === to) return;
		this.transition(id, record, to);
	}

	/**
	 * The input ends without being delivered. Its undelivered effects run once, at the first such end (a held input that
	 * is later taken back ran them when it was held). False when the input is no longer open: it ended already.
	 */
	end(id: OwnerInputId, end: OwnerInputEnd): boolean {
		const record = this.records.get(id);
		if (record === undefined) return false;
		if (record.state === end.state) return false;
		const firstEnd = record.state !== "held";
		this.transition(id, record, end.state);
		record.onDelivered.length = 0;
		// Every effect runs whatever an earlier one threw; their failures surface together.
		if (firstEnd)
			runReleaseSteps(
				record.onUndelivered.splice(0).map((effect) => () => effect(end)),
				`Owner input ${id} ended ${end.state}; some of its effects failed.`,
			);
		return true;
	}

	/** Runs once, when the input is delivered; never when it ends any other way. */
	whenDelivered(id: OwnerInputId, effect: (delivery: OwnerInputDelivery) => void): void {
		this.openRecord(id).onDelivered.push(effect);
	}

	/** Runs once, when the input first ends without being delivered (held included); never when it is delivered. */
	whenUndelivered(id: OwnerInputId, effect: (end: OwnerInputEnd) => void): void {
		this.openRecord(id).onUndelivered.push(effect);
	}

	/** Called once per delivered input, in delivery order, after the input's own delivered effects. */
	onDelivered(listener: (delivery: OwnerInputDelivery) => void): () => void {
		this.deliveredListeners.add(listener);
		return () => {
			this.deliveredListeners.delete(listener);
		};
	}

	/**
	 * The one Delivered commit point: `message` reached the session file as `entryId` (appended at its message_end, or
	 * flushed with a routed turn's buffer). A user message that carries an open input delivers that input; every other
	 * message delivers nothing, and a message persisted again delivers nothing again. A message the model read but that was
	 * never persisted (a routed turn that dropped it) is not delivered.
	 */
	notePersisted(message: AgentMessage, entryId: string): void {
		if (message.role !== "user") return;
		const id = ownerInputIdOf(message);
		if (id === undefined) return;
		const record = this.records.get(id);
		if (record === undefined) return;
		this.transition(id, record, "delivered");
		record.onUndelivered.length = 0;
		const delivery: OwnerInputDelivery = { id, message, entryId };
		// Every effect and listener runs whatever an earlier one threw; their failures surface together, after the commit.
		runReleaseSteps(
			[...record.onDelivered.splice(0), ...this.deliveredListeners].map((effect) => () => effect(delivery)),
			`Owner input ${id} was delivered; some of its effects failed.`,
		);
	}

	private openRecord(id: OwnerInputId): InputRecord {
		const record = this.records.get(id);
		if (record === undefined) throw new Error(`Owner input ${id} is not open; no effect can be registered for it.`);
		return record;
	}

	private transition(id: OwnerInputId, record: InputRecord, to: OwnerInputState): void {
		if (!NEXT_STATES[record.state].includes(to))
			throw new Error(`Owner input ${id} (${record.source}) cannot go from ${record.state} to ${to}.`);
		record.state = to;
		if (TERMINAL_STATES.has(to)) this.records.delete(id);
	}
}
