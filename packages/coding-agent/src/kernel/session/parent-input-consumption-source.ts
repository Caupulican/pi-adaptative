/**
 * The indexed source a session's parent-input consumption reads, live and for historical imports alike
 * (`ParentInputConsumptionSource`): its entries by id, durable for the session, and the ancestry of its entry tree. The
 * evidence index follows the session's entries as they grow and is rebuilt when the entry map is replaced; a source
 * handed out refuses to answer once its session or entry map changed under it.
 */
import type { ParentInputConsumptionSource } from "./parent-input-ledger.ts";
import type { SessionEntry } from "./session-entries.ts";
import { SessionEntryEvidenceIndex } from "./session-entry-evidence-index.ts";

/** What the session shows the source, read at each call: its entry map and entries, its id and an entry's durability. */
export interface ParentEvidenceSession {
	byId(): Map<string, SessionEntry>;
	entries(): readonly SessionEntry[];
	sessionId(): string;
	isEntryDurable(id: string): boolean;
}

export class ParentInputConsumptionSources {
	private cache: { byId: Map<string, SessionEntry>; count: number; index: SessionEntryEvidenceIndex } | undefined;

	private readonly session: ParentEvidenceSession;

	constructor(session: ParentEvidenceSession) {
		this.session = session;
	}

	/** The source over the session's entries as they are now. */
	current(): ParentInputConsumptionSource {
		const session = this.session;
		const byId = session.byId();
		const entries = session.entries();
		let cache = this.cache;
		if (!cache || cache.byId !== byId || cache.count > entries.length) {
			cache = { byId, count: 0, index: new SessionEntryEvidenceIndex() };
			this.cache = cache;
		}
		for (; cache.count < entries.length; cache.count++) cache.index.add(entries[cache.count]!);
		const sessionId = session.sessionId();
		const index = cache.index;
		const assertCurrent = (signal?: AbortSignal): void => {
			signal?.throwIfAborted();
			if (session.byId() !== byId || session.sessionId() !== sessionId)
				throw new Error("Parent input source changed during ingestion.");
		};
		return {
			sessionId,
			readEntries: async (ids, signal) => {
				assertCurrent(signal);
				if (ids.length > 64) throw new Error("Parent input lookup exceeds its entry bound.");
				return new Map(
					ids.map((id) => {
						const entry = byId.get(id);
						if (!entry || entry.id !== id || !session.isEntryDurable(id))
							throw new Error("Parent input source entry is not durable.");
						return [id, entry] as const;
					}),
				);
			},
			isAncestor: async (ancestor, descendant, signal) => {
				assertCurrent(signal);
				return index.isAncestor(ancestor, descendant);
			},
			findAncestors: async (descendant, query, signal) => {
				assertCurrent(signal);
				return index.findAncestors(descendant, query);
			},
		};
	}
}
