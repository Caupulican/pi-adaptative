import { MAX_ORCHESTRATION_IDENTIFIER_LENGTH } from "../orchestration/contracts.ts";
import {
	type HostEventDeliveryBinding,
	HostEventError,
	type HostEventTranscriptReceipt,
	MAX_HOST_EVENT_DELIVERIES,
	MAX_HOST_EVENT_DOMAIN_BYTES,
	MAX_HOST_EVENT_SOURCES,
	MAX_HOST_EVENT_SUBSCRIPTIONS,
	MAX_HOST_EVENTS,
} from "./host-event-contract.ts";
import { HOST_EVENT_RECORD_FIELDS, type HostEventDelivery, type HostEventProjection } from "./host-event-state.ts";

export const HOST_EVENT_RECORD_LIMITS = {
	eventSources: MAX_HOST_EVENT_SOURCES,
	hostEvents: MAX_HOST_EVENTS,
	threadSubscriptions: MAX_HOST_EVENT_SUBSCRIPTIONS,
	eventDeliveries: MAX_HOST_EVENT_DELIVERIES,
} as const;

// JSON may escape each allowed control character to six bytes.
const ESCAPED_IDENTIFIER_BYTES = 6 * MAX_ORCHESTRATION_IDENTIFIER_LENGTH;
// Settlement adds a status, a reason of at most 128 characters, settledAt and a handback purpose.
const SETTLEMENT_BYTES = 6 * 128 + 256;
// A root acknowledgement adds one bounded parent receipt identity.
const ROOT_SETTLEMENT_BYTES = ESCAPED_IDENTIFIER_BYTES + SETTLEMENT_BYTES;
// mailboxAccepted, mailboxSettled and bindingRetired flags of one physical copy.
const TRANSPORT_FLAG_BYTES = 96;

/** Every receipt field except the bounded transcript entry id is fixed when the binding is minted. */
function transcriptReceiptBytes(binding: HostEventDeliveryBinding): number {
	const receipt: HostEventTranscriptReceipt = {
		sessionId: binding.execution.sessionId,
		sessionFile: binding.execution.sessionFile,
		entryId: "",
		taskId: binding.execution.taskId,
		attemptId: binding.execution.attemptId,
		messageId: binding.messageId,
		contentDigest: binding.contentDigest,
		bindingDigest: binding.bindingDigest,
	};
	return Buffer.byteLength(JSON.stringify({ transcriptReceipt: receipt }), "utf8") + ESCAPED_IDENTIFIER_BYTES;
}

/**
 * Growth this delivery may still need to reach its terminal receipt. A binding is an ordinary
 * admission: its receipt reservation is charged when it is minted, so an unbound obligation only
 * reserves its own settlement and a refused binding leaves the delivery pending.
 */
function deliverySettlementReserve(delivery: HostEventDelivery): number {
	const open = delivery.status === "pending" || delivery.status === "reserved";
	if (delivery.target.kind === "root") return open ? ROOT_SETTLEMENT_BYTES : 0;
	const physical = delivery.binding && !delivery.mailboxSettled ? TRANSPORT_FLAG_BYTES : 0;
	if (!open) return physical;
	const receipt =
		delivery.binding && !delivery.bindingRetired && !delivery.transcriptReceipt
			? transcriptReceiptBytes(delivery.binding)
			: 0;
	return SETTLEMENT_BYTES + physical + receipt;
}

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
	for (const delivery of Object.values(projection.eventDeliveries))
		reservedBytes += deliverySettlementReserve(delivery);
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
