import type { JsonObject } from "../autonomy/contracts.ts";
import { projectionWithCarriedPlans } from "../plan/plan-carry.ts";
import type { OrchestrationEvent } from "./contracts.ts";
import type { OrchestrationEventStore } from "./event-store.ts";
import { OrchestrationSnapshotRequiredError } from "./event-store-errors.ts";
import { projectionFromSnapshot } from "./task-runtime-codecs.ts";
import { projectOrchestrationEvents, reduceOrchestrationEvent } from "./task-runtime-reducer.ts";
import { DurableTaskRuntimeError, type TaskRuntimeProjection } from "./task-runtime-state.ts";

/** A published snapshot's projection, with the plans its carry holds rebuilt over it (`plan-carry.ts`). */
function projectionOfSnapshot(snapshot: { throughOrdinal: number; projection: JsonObject; carried?: JsonObject }) {
	return projectionWithCarriedPlans(
		projectionFromSnapshot(snapshot.projection, snapshot.throughOrdinal),
		snapshot.carried,
	);
}

/** Shared replay without maintenance writes; unchanged reads retain the prior projection identity. */
export function readTaskRuntimeProjection(
	store: Pick<OrchestrationEventStore, "readProjectionSnapshot" | "readAll" | "readAfter">,
	prior?: TaskRuntimeProjection,
): TaskRuntimeProjection {
	let state = prior;
	if (!state) {
		const snapshot = store.readProjectionSnapshot();
		if (snapshot) {
			state = projectionOfSnapshot(snapshot);
		} else {
			const events = store.readAll();
			// A baseline may publish between the first snapshot read and the tail read.
			const snapshotAfterRead = store.readProjectionSnapshot();
			state = snapshotAfterRead
				? events
						.filter((event) => event.ordinal > snapshotAfterRead.throughOrdinal)
						.reduce(reduceOrchestrationEvent, projectionOfSnapshot(snapshotAfterRead))
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
		state = projectionOfSnapshot(snapshot);
		events = store.readAfter(state.lastOrdinal);
	}
	return events.reduce(reduceOrchestrationEvent, state);
}
