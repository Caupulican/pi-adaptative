import { MAX_ORCHESTRATION_IDENTIFIER_LENGTH, MAX_WORKER_AUTHORITY_PATH_LENGTH } from "../orchestration/contracts.ts";
import {
	HostEventError,
	MAX_HOST_EVENT_DELIVERIES,
	MAX_HOST_EVENT_DOMAIN_BYTES,
	MAX_HOST_EVENT_SOURCES,
	MAX_HOST_EVENT_SUBSCRIPTIONS,
	MAX_HOST_EVENTS,
} from "./host-event-contract.ts";
import { HOST_EVENT_RECORD_FIELDS, type HostEventProjection } from "./host-event-state.ts";

export const HOST_EVENT_RECORD_LIMITS = {
	eventSources: MAX_HOST_EVENT_SOURCES,
	hostEvents: MAX_HOST_EVENTS,
	threadSubscriptions: MAX_HOST_EVENT_SUBSCRIPTIONS,
	eventDeliveries: MAX_HOST_EVENT_DELIVERIES,
} as const;

// JSON may escape each allowed control character to six bytes. Reserve both execution and
// transcript paths, all bounded identities and fixed fields before accepting an obligation.
const TASK_SETTLEMENT_BYTES =
	12 * MAX_WORKER_AUTHORITY_PATH_LENGTH + 144 * MAX_ORCHESTRATION_IDENTIFIER_LENGTH + 16_384;
const ROOT_SETTLEMENT_BYTES = 12 * MAX_ORCHESTRATION_IDENTIFIER_LENGTH + 4_096;

/** Remaining reservation is charged by ordinary orchestration writes as well as event writes. */
export function hostEventCapacity(projection: HostEventProjection): { bytes: number; reservedBytes: number } {
	let bytes = 0;
	let reservedBytes = 0;
	for (const field of HOST_EVENT_RECORD_FIELDS) {
		const entries = Object.entries(projection[field]);
		if (entries.length > HOST_EVENT_RECORD_LIMITS[field])
			throw new HostEventError("capacity", `${field} capacity exceeded.`);
		bytes += Buffer.byteLength(JSON.stringify(projection[field]), "utf8") + field.length + 4;
	}
	for (const delivery of Object.values(projection.eventDeliveries)) {
		if (delivery.status !== "pending" && delivery.status !== "reserved") {
			// Canonical consumption/settlement can precede the physical mailbox write. Retain
			// space for its final receipt even if unrelated admissions fill the projection.
			if (delivery.binding && !delivery.mailboxSettled) reservedBytes += 64;
			continue;
		}
		const ceiling = delivery.target.kind === "task" ? TASK_SETTLEMENT_BYTES : ROOT_SETTLEMENT_BYTES;
		reservedBytes += Math.max(0, ceiling - Buffer.byteLength(JSON.stringify(delivery), "utf8"));
	}
	for (const source of Object.values(projection.eventSources)) {
		// A current observation is bounded by an ASCII hostname, SHA, event ID and numeric
		// run identity. Snapshot bodies live only in canonical hostEvents, never in the seal.
		const sealCeiling =
			2_048 * source.registration.subjects.length + 12 * MAX_ORCHESTRATION_IDENTIFIER_LENGTH + 1_024;
		reservedBytes += Math.max(
			0,
			sealCeiling - (source.seal ? Buffer.byteLength(JSON.stringify(source.seal), "utf8") : 0),
		);
		const gapCeiling = 12 * MAX_ORCHESTRATION_IDENTIFIER_LENGTH + 1_024;
		reservedBytes += Math.max(
			0,
			gapCeiling - (source.lastReplayGap ? Buffer.byteLength(JSON.stringify(source.lastReplayGap), "utf8") : 0),
		);
	}
	if (bytes + reservedBytes > MAX_HOST_EVENT_DOMAIN_BYTES)
		throw new HostEventError("capacity", "Host event retained state and settlement reservations exceed capacity.");
	return { bytes, reservedBytes };
}
