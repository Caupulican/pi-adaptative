/**
 * Idempotency-key indexing for the orchestration event store: the bounded snapshot selection, and the one place every
 * append, sync and compaction path indexes a key, including the retirement a `retention.pruned` event performs.
 */

import { MAX_ORCHESTRATION_SNAPSHOT_IDEMPOTENCY_BYTES, type OrchestrationEvent } from "./contracts.ts";
import { eventNamesRecord, retiredRecordIds } from "./retention-event.ts";

export function boundedIdempotencyEvents(
	events: readonly OrchestrationEvent[],
	maxEvents: number,
): OrchestrationEvent[] {
	const selectedNewestFirst: OrchestrationEvent[] = [];
	let serializedBytes = 2;
	for (const event of [...events].sort((left, right) => right.ordinal - left.ordinal)) {
		if (selectedNewestFirst.length >= maxEvents) break;
		const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
		const nextBytes = serializedBytes + (selectedNewestFirst.length > 0 ? 1 : 0) + eventBytes;
		if (nextBytes > MAX_ORCHESTRATION_SNAPSHOT_IDEMPOTENCY_BYTES) continue;
		selectedNewestFirst.push(structuredClone(event));
		serializedBytes = nextBytes;
	}
	return selectedNewestFirst.reverse();
}

/**
 * Indexes one event's idempotency key. A `retention.pruned` event also retires the keys of every held event that names
 * a record it deleted, so a later re-creation of a released id (for example `goal:<id>`) appends under a fresh key.
 */
export function indexIdempotentEvent(index: Map<string, OrchestrationEvent>, event: OrchestrationEvent): void {
	if (event.idempotencyKey) index.set(event.idempotencyKey, event);
	const retired = retiredRecordIds(event);
	if (retired.size === 0) return;
	for (const [key, held] of index) {
		if (held !== event && eventNamesRecord(held, retired)) index.delete(key);
	}
}
