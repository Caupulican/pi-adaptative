import type { AgentMessage } from "./types.ts";

/**
 * The identity of one accepted owner input: minted once at acceptance (`OwnerInputLedger`), never reused, carried by
 * the message the input becomes and written on the session entry that message is persisted as.
 */
export type OwnerInputId = string & { readonly __ownerInputId: true };

const OWNER_INPUT_ID = Symbol("pi.ownerInputId");

/**
 * Stamps `message` with the input it carries. The stamp is a non-enumerable symbol property of the object itself: it
 * travels wherever the object goes (the agent's queues, the run, the routed-turn buffer, the session append) and never
 * reaches a serialized message, a provider request or an equality check. A copy of the message does not carry it. The
 * session manager writes it on the message's entry (`SessionMessageEntry.ownerInputId`), beside the message.
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
