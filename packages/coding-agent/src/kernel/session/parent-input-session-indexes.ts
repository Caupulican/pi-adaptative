/**
 * The indexes a session keeps over every entry it holds, on any branch, for its parent inputs: the saved input of each
 * delivery (`ParentInputReceipts`), and the source its parent-input consumption reads, live and for historical imports
 * alike (`ParentInputConsumptionSources`): its entries by id, durable for the session, and the ancestry of its entry tree.
 * Each follows the session's entries as they grow and is rebuilt when the entry map is replaced; a consumption source
 * handed out refuses to answer once its session or entry map changed under it.
 */
import { type ParentInputConsumptionSource, type PersistedParentInput, parentInputOf } from "./parent-input-ledger.ts";
import type { SessionEntry } from "./session-entries.ts";
import { SessionEntryEvidenceIndex } from "./session-entry-evidence-index.ts";

/** What the session shows its indexes, read at each call: its entry map and entries, its id and an entry's durability. */
export interface ParentInputSessionView {
	byId(): Map<string, SessionEntry>;
	entries(): readonly SessionEntry[];
	sessionId(): string;
	isEntryDurable(id: string): boolean;
}

/** An index of every entry of `session`, added to as its entries grow, rebuilt when its entry map is replaced. */
abstract class SessionEntryFold<T> {
	private cache: { byId: Map<string, SessionEntry>; count: number; state: T } | undefined;
	protected readonly session: ParentInputSessionView;

	constructor(session: ParentInputSessionView) {
		this.session = session;
	}

	protected abstract start(): T;
	protected abstract add(state: T, entry: SessionEntry): void;

	/** The index over the session's entries as they are now. */
	protected current(): T {
		const byId = this.session.byId();
		const entries = this.session.entries();
		let cache = this.cache;
		if (!cache || cache.byId !== byId || cache.count > entries.length) {
			cache = { byId, count: 0, state: this.start() };
			this.cache = cache;
		}
		for (; cache.count < entries.length; cache.count++) this.add(cache.state, entries[cache.count]!);
		return cache.state;
	}
}

/** The saved input of each delivery the session holds, on any branch, pending or consumed. */
export class ParentInputReceipts extends SessionEntryFold<Map<string, PersistedParentInput>> {
	protected start(): Map<string, PersistedParentInput> {
		return new Map();
	}

	protected add(deliveries: Map<string, PersistedParentInput>, entry: SessionEntry): void {
		const input = parentInputOf(entry);
		if (!input) return;
		if (deliveries.has(input.metadata.deliveryId))
			throw new Error("Duplicate parent input delivery requires inspection.");
		deliveries.set(input.metadata.deliveryId, input);
	}

	find(deliveryId: string): PersistedParentInput | undefined {
		return this.current().get(deliveryId);
	}
}

export class ParentInputConsumptionSources extends SessionEntryFold<SessionEntryEvidenceIndex> {
	protected start(): SessionEntryEvidenceIndex {
		return new SessionEntryEvidenceIndex();
	}

	protected add(index: SessionEntryEvidenceIndex, entry: SessionEntry): void {
		index.add(entry);
	}

	/** The source over the session's entries as they are now. */
	source(): ParentInputConsumptionSource {
		const index = this.current();
		const session = this.session;
		const byId = session.byId();
		const sessionId = session.sessionId();
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
