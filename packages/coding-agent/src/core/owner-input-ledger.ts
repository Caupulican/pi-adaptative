import type { AgentMessage } from "../kernel/types.ts";

/**
 * The owner-input ledger, first increment: the identity of every accepted input and the one point where an input is
 * delivered. An identity is minted once, at acceptance, for every source, and stamped on the user message the input
 * becomes. Delivery matches that stamp, never the message's text, its queue entry or its object.
 */

/** The identity of one accepted input: minted at acceptance, never reused, carried by the message the input becomes. */
export type OwnerInputId = string & { readonly __ownerInputId: true };

/** Where an input was accepted. An extension's message (a peer's, say) is accepted on its untrusted path. */
export type OwnerInputSource = "prompt" | "steer" | "followUp" | "extension";

const OWNER_INPUT_ID = Symbol("pi.ownerInputId");

/**
 * Stamps `message` with the input it carries. The stamp is a non-enumerable symbol property of the object itself: it travels
 * wherever the object goes (the agent's queues, the run, the routed-turn buffer, the session append) and never reaches a
 * serialized form, a provider request or an equality check. A copy of the message does not carry it.
 */
export function stampOwnerInput(message: AgentMessage, id: OwnerInputId): void {
	const current = ownerInputIdOf(message);
	if (current === id) return;
	if (current !== undefined)
		throw new Error(`A message already carries owner input ${current}; it cannot carry ${id}.`);
	Object.defineProperty(message, OWNER_INPUT_ID, {
		value: id,
		enumerable: false,
		writable: false,
		configurable: false,
	});
}

/** The input `message` carries, if it carries one. */
export function ownerInputIdOf(message: AgentMessage): OwnerInputId | undefined {
	const id: unknown = Reflect.get(message, OWNER_INPUT_ID);
	return typeof id === "string" ? (id as OwnerInputId) : undefined;
}

export class OwnerInputLedger {
	private nextOrdinal = 1;
	private readonly deliveredListeners = new Set<(id: OwnerInputId) => void>();

	/** A new input was accepted from `source`: its identity, minted now. */
	accept(source: OwnerInputSource): OwnerInputId {
		return `${source}:${this.nextOrdinal++}` as OwnerInputId;
	}

	/** Called once per delivered input, in delivery order. Consumers are idempotent for an id they no longer hold. */
	onDelivered(listener: (id: OwnerInputId) => void): () => void {
		this.deliveredListeners.add(listener);
		return () => {
			this.deliveredListeners.delete(listener);
		};
	}

	/**
	 * The one Delivered commit point: `message` reached the session file (appended at its message_end, or flushed with a
	 * routed turn's buffer). A user message that carries an input delivers that input; every other message delivers nothing.
	 * A message the model read but that was never persisted (a routed turn that dropped it) is not delivered.
	 */
	notePersisted(message: AgentMessage): void {
		if (message.role !== "user") return;
		const id = ownerInputIdOf(message);
		if (id === undefined) return;
		for (const listener of [...this.deliveredListeners]) listener(id);
	}
}
