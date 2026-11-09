/** Session and entry id generation: fresh session ids, the auto-learn session id test, and the entry id space that keeps generated ids unique within one transcript. */
import { randomUUID } from "node:crypto";
import { uuidv7 } from "../uuid.ts";

export function createSessionId(): string {
	return uuidv7();
}

export function isAutoLearnSessionId(id: string): boolean {
	return id.startsWith("auto-learn-");
}

/**
 * Id space for a batch being minted: the persisted ids plus the ones minted so far in this batch,
 * WITHOUT copying the persisted set. Copying `byId.keys()` into a fresh Set per batch made every
 * tool-call marker and message batch O(entries in the session) -- measured at 3% of host CPU over a
 * 1,500-turn session, and growing with it.
 */
export function pendingIdSpace(byId: ReadonlyMap<string, unknown>): {
	has(id: string): boolean;
	add(id: string): void;
} {
	const pending = new Set<string>();
	return {
		has: (id) => byId.has(id) || pending.has(id),
		add: (id) => {
			pending.add(id);
		},
	};
}

/** Generate a unique short ID (8 hex chars, collision-checked) */
export function generateId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		const id = randomUUID().slice(0, 8);
		if (!byId.has(id)) return id;
	}
	// Fallback to full UUID if somehow we have collisions
	return randomUUID();
}

export function assistantToolIdentityKey(assistantMessageEntryId: string, callId: string): string {
	return JSON.stringify([assistantMessageEntryId, callId]);
}
