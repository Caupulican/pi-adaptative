/**
 * Memory index store abstraction (Phase 2): the operational index over durable memory
 * refs (Pi OKF and, later, external providers), so retrieval can rank/filter without
 * re-querying every source on every turn. This is an index/cache layer per
 * memory-architecture.md, not the durable memory itself; the OKF bundle (or a provider)
 * remains canonical for the underlying content.
 *
 * This module does not hardcode Automata or any specific provider: `ContextMemoryRef`
 * already carries an opaque `providerId`, and nothing here special-cases a provider name.
 * No external provider queries or writes happen here — this is metadata indexing only.
 */

import type { ContextMemoryRef, MemoryScope } from "./context-item.ts";

export interface MemoryIndexRecord {
	ref: ContextMemoryRef;
	title?: string;
	summary: string;
	indexedAtTurn: number;
	stale: boolean;
}

export interface MemoryIndexStore {
	upsert(record: MemoryIndexRecord): void;
	get(providerId: string, itemId: string): MemoryIndexRecord | undefined;
	list(scope?: MemoryScope): MemoryIndexRecord[];
	markStale(providerId: string, itemId: string): void;
	remove(providerId: string, itemId: string): void;
}

function indexKey(providerId: string, itemId: string): string {
	return `${providerId}\0${itemId}`;
}

export function createInMemoryMemoryIndexStore(): MemoryIndexStore {
	const records = new Map<string, MemoryIndexRecord>();

	return {
		upsert(record: MemoryIndexRecord): void {
			records.set(indexKey(record.ref.providerId, record.ref.itemId), record);
		},

		get(providerId: string, itemId: string): MemoryIndexRecord | undefined {
			return records.get(indexKey(providerId, itemId));
		},

		list(scope?: MemoryScope): MemoryIndexRecord[] {
			const all = Array.from(records.values());
			return scope === undefined ? all : all.filter((record) => record.ref.scope === scope);
		},

		markStale(providerId: string, itemId: string): void {
			const record = records.get(indexKey(providerId, itemId));
			if (record) record.stale = true;
		},

		remove(providerId: string, itemId: string): void {
			records.delete(indexKey(providerId, itemId));
		},
	};
}
