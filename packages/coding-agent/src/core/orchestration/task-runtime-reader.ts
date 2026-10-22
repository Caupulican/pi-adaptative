import type { OrchestrationEvent } from "./contracts.ts";
import { type OrchestrationEventStore, OrchestrationSnapshotRequiredError } from "./event-store.ts";
import { projectionFromSnapshot } from "./task-runtime-codecs.ts";
import { projectOrchestrationEvents, reduceOrchestrationEvent } from "./task-runtime-reducer.ts";
import { DurableTaskRuntimeError, type TaskRuntimeProjection } from "./task-runtime-state.ts";

/** Shared replay without maintenance writes; unchanged reads retain the prior projection identity. */
export function readTaskRuntimeProjection(
	store: Pick<OrchestrationEventStore, "readProjectionSnapshot" | "readAll" | "readAfter">,
	prior?: TaskRuntimeProjection,
): TaskRuntimeProjection {
	let state = prior;
	if (!state) {
		const snapshot = store.readProjectionSnapshot();
		if (snapshot) {
			state = projectionFromSnapshot(snapshot.projection, snapshot.throughOrdinal);
		} else {
			const events = store.readAll();
			// A baseline may publish between the first snapshot read and the tail read.
			const snapshotAfterRead = store.readProjectionSnapshot();
			state = snapshotAfterRead
				? events
						.filter((event) => event.ordinal > snapshotAfterRead.throughOrdinal)
						.reduce(
							reduceOrchestrationEvent,
							projectionFromSnapshot(snapshotAfterRead.projection, snapshotAfterRead.throughOrdinal),
						)
				: projectOrchestrationEvents(events);
		}
	}
	let events: OrchestrationEvent[];
	try {
		events = store.readAfter(state.lastOrdinal);
	} catch (error) {
		if (!(error instanceof OrchestrationSnapshotRequiredError)) throw error;
		const snapshot = store.readProjectionSnapshot();
		if (!snapshot || snapshot.throughOrdinal < error.throughOrdinal)
			throw new DurableTaskRuntimeError("Required orchestration projection snapshot is unavailable.");
		state = projectionFromSnapshot(snapshot.projection, snapshot.throughOrdinal);
		events = store.readAfter(state.lastOrdinal);
	}
	return events.reduce(reduceOrchestrationEvent, state);
}
