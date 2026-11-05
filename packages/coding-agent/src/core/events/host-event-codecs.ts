import type { TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import { workerReceiptOriginFromValue } from "../orchestration/worker-receipt-origin.ts";
import { HOST_EVENT_RECORD_LIMITS, hostEventCapacity } from "./host-event-capacity.ts";
import {
	assertHostEventReceiptMatchesBinding,
	ciEventSubject,
	ciSubjectKey,
	HOST_EVENT_SOURCE_END_REASONS,
	HostEventError,
	type HostEventReceipt,
	type HostEventSourceEndReason,
	hostEventArray,
	hostEventDate,
	hostEventDigest,
	hostEventInteger,
	hostEventRecord,
	hostEventString,
	hostEventSubscriptionId,
	isCiEnvelope,
	MAX_HOST_EVENT_TARGETS,
	parseHostEventCatchUpSeal,
	parseHostEventDeliveryBinding,
	parseHostEventEnvelope,
	parseHostEventReplayGap,
	parseHostEventSequenceRanges,
	parseHostEventSourceRegistration,
	parseHostEventSubscriptionInput,
	parseHostEventTranscriptReceipt,
} from "./host-event-contract.ts";
import { hostEventObservationIsHistory } from "./host-event-reducer.ts";
import {
	type AcceptedHostEvent,
	HOST_EVENT_RECORD_FIELDS,
	type HostEventDelivery,
	type HostEventDeliveryTarget,
	type HostEventProjection,
	type HostEventSourceState,
	type HostEventSubscription,
} from "./host-event-state.ts";

export function parseHostEventReceipt(value: unknown): HostEventReceipt {
	const record = hostEventRecord(
		value,
		["consumerId", "sourceId", "sourceEpoch", "sourceSequence", "eventId", "payloadDigest", "canonicalReceiptId"],
		"host event receipt",
	);
	return {
		consumerId: hostEventString(record.consumerId, "consumerId"),
		sourceId: hostEventString(record.sourceId, "sourceId"),
		sourceEpoch: hostEventString(record.sourceEpoch, "sourceEpoch"),
		sourceSequence: hostEventInteger(record.sourceSequence, "sourceSequence"),
		eventId: hostEventString(record.eventId, "eventId"),
		payloadDigest: hostEventDigest(record.payloadDigest, "payloadDigest"),
		canonicalReceiptId: hostEventString(record.canonicalReceiptId, "canonicalReceiptId"),
	};
}

function sourceFromValue(value: unknown): HostEventSourceState {
	const record = hostEventRecord(
		value,
		[
			"registration",
			"acceptedThrough",
			"retiredThrough",
			"catchUpGeneration",
			"replayFloor",
			"lastReplayGap",
			"seal",
			"unaccepted",
			"ended",
			"replaced",
		],
		"host event source",
	);
	const source = {
		registration: parseHostEventSourceRegistration(record.registration),
		acceptedThrough: hostEventInteger(record.acceptedThrough, "acceptedThrough", 0),
		retiredThrough: hostEventInteger(record.retiredThrough, "retiredThrough", 0),
		catchUpGeneration: hostEventInteger(record.catchUpGeneration, "catchUpGeneration", 0),
		replayFloor: hostEventInteger(record.replayFloor, "replayFloor"),
		...(record.lastReplayGap === undefined ? {} : { lastReplayGap: parseHostEventReplayGap(record.lastReplayGap) }),
		...(record.seal === undefined ? {} : { seal: parseHostEventCatchUpSeal(record.seal) }),
		unaccepted: parseHostEventSequenceRanges(record.unaccepted),
		...(record.ended === undefined ? {} : { ended: sourceEndFromValue(record.ended) }),
		...(record.replaced === undefined ? {} : { replaced: true as const }),
	};
	if (record.replaced !== undefined && record.replaced !== true)
		throw new HostEventError("invalid", "replaced must be true when present.");
	// Unaccepted positions lie below the replay floor; without a replay gap only before the stream floor.
	const unacceptedThrough = source.unaccepted.at(-1)?.through ?? 0;
	if (
		unacceptedThrough >= source.replayFloor ||
		(!source.lastReplayGap && unacceptedThrough >= source.registration.startingSequence)
	)
		throw new HostEventError("invalid", "Unaccepted source positions are inconsistent.");
	if (
		source.retiredThrough > source.acceptedThrough ||
		source.acceptedThrough < source.registration.startingSequence - 1 ||
		source.replayFloor < source.registration.startingSequence ||
		source.replayFloor > source.acceptedThrough + 1 ||
		(source.lastReplayGap
			? source.lastReplayGap.sourceId !== source.registration.sourceId ||
				source.lastReplayGap.sourceEpoch !== source.registration.sourceEpoch ||
				source.lastReplayGap.scopeVersion > source.registration.scopeVersion ||
				source.lastReplayGap.generation > source.catchUpGeneration ||
				source.lastReplayGap.throughSequence + 1 !== source.replayFloor ||
				source.lastReplayGap.throughSequence > source.retiredThrough
			: source.replayFloor !== source.registration.startingSequence) ||
		(source.seal &&
			(source.seal.snapshots !== undefined ||
				source.seal.sourceId !== source.registration.sourceId ||
				source.seal.sourceEpoch !== source.registration.sourceEpoch ||
				source.seal.scopeVersion > source.registration.scopeVersion ||
				source.seal.generation > source.catchUpGeneration ||
				source.seal.throughSequence > source.acceptedThrough))
	)
		throw new HostEventError("invalid", "Source frontier is inconsistent.");
	// An ended source holds no seal and has released every position it accepted.
	if (source.ended && (source.seal || source.retiredThrough !== source.acceptedThrough))
		throw new HostEventError("invalid", "Ended source still holds a frontier.");
	return source;
}

function sourceEndFromValue(value: unknown): NonNullable<HostEventSourceState["ended"]> {
	const record = hostEventRecord(value, ["reason", "at"], "host event source end");
	if (!HOST_EVENT_SOURCE_END_REASONS.some((reason) => reason === record.reason))
		throw new HostEventError("invalid", "Unknown host event source end reason.");
	return { reason: record.reason as HostEventSourceEndReason, at: hostEventDate(record.at, "ended at") };
}

function subscriptionFromValue(value: unknown): HostEventSubscription {
	const record = hostEventRecord(
		value,
		["subscriptionId", "taskId", "revision", "threadKey", "subject", "wake", "createdOrdinal", "revokedOrdinal"],
		"thread subscription",
	);
	const input = parseHostEventSubscriptionInput({
		threadKey: record.threadKey,
		subject: record.subject,
		wake: record.wake,
	});
	const subscription = {
		...input,
		subscriptionId: hostEventString(record.subscriptionId, "subscriptionId"),
		taskId: hostEventString(record.taskId, "taskId"),
		revision: hostEventInteger(record.revision, "revision"),
		createdOrdinal: hostEventInteger(record.createdOrdinal, "createdOrdinal"),
		...(record.revokedOrdinal === undefined
			? {}
			: { revokedOrdinal: hostEventInteger(record.revokedOrdinal, "revokedOrdinal") }),
	};
	if (subscription.subscriptionId !== hostEventSubscriptionId(subscription.taskId, subscription.threadKey))
		throw new HostEventError("invalid", "Subscription identity conflicts with its task/thread.");
	return subscription;
}

function eventFromValue(value: unknown): AcceptedHostEvent {
	const record = hostEventRecord(
		value,
		["envelope", "receipt", "origin", "acceptedOrdinal", "recallUntil", "deliveryIds"],
		"accepted host event",
	);
	const envelope = parseHostEventEnvelope(record.envelope);
	const receipt = parseHostEventReceipt(record.receipt);
	if (
		receipt.sourceId !== envelope.sourceId ||
		receipt.sourceEpoch !== envelope.sourceEpoch ||
		receipt.sourceSequence !== envelope.sourceSequence ||
		receipt.eventId !== envelope.event.eventId ||
		receipt.payloadDigest !== envelope.event.payloadDigest
	)
		throw new HostEventError("invalid", "Canonical event receipt differs from its envelope.");
	const deliveryIds = hostEventArray(
		record.deliveryIds,
		MAX_HOST_EVENT_TARGETS,
		(id) => hostEventString(id, "deliveryId"),
		"event targets",
	);
	if (new Set(deliveryIds).size !== deliveryIds.length)
		throw new HostEventError("invalid", "Duplicate event delivery identity.");
	return {
		envelope,
		receipt,
		origin: workerReceiptOriginFromValue(record.origin),
		acceptedOrdinal: hostEventInteger(record.acceptedOrdinal, "acceptedOrdinal"),
		recallUntil: hostEventDate(record.recallUntil, "recallUntil"),
		deliveryIds,
	};
}

function targetFromValue(value: unknown): HostEventDeliveryTarget {
	const record = hostEventRecord(
		value,
		["kind", "taskId", "subscriptionId", "subscriptionRevision", "scopeVersion"],
		"host event target",
	);
	if (
		record.kind === "root" &&
		record.taskId === undefined &&
		record.subscriptionId === undefined &&
		record.subscriptionRevision === undefined
	)
		return { kind: "root", scopeVersion: hostEventInteger(record.scopeVersion, "scopeVersion") };
	if (record.kind === "task" && record.scopeVersion === undefined)
		return {
			kind: "task",
			taskId: hostEventString(record.taskId, "taskId"),
			subscriptionId: hostEventString(record.subscriptionId, "subscriptionId"),
			subscriptionRevision: hostEventInteger(record.subscriptionRevision, "subscriptionRevision"),
		};
	throw new HostEventError("invalid", "Host event target is invalid.");
}

function deliveryFromValue(value: unknown): HostEventDelivery {
	const record = hostEventRecord(
		value,
		[
			"deliveryId",
			"eventId",
			"target",
			"status",
			"purpose",
			"generation",
			"binding",
			"bindingRetired",
			"mailboxAccepted",
			"mailboxSettled",
			"transcriptReceipt",
			"parentReceiptId",
			"reason",
			"settledAt",
		],
		"host event delivery",
	);
	if (
		record.status !== "reserved" &&
		record.status !== "pending" &&
		record.status !== "consumed" &&
		record.status !== "settled"
	)
		throw new HostEventError("invalid", "Host event delivery status is invalid.");
	if (record.purpose !== "failure" && record.purpose !== "update" && record.purpose !== "handback")
		throw new HostEventError("invalid", "Host event delivery purpose is invalid.");
	if (record.mailboxAccepted !== undefined && record.mailboxAccepted !== true)
		throw new HostEventError("invalid", "Mailbox receipt is invalid.");
	if (record.mailboxSettled !== undefined && record.mailboxSettled !== true)
		throw new HostEventError("invalid", "Mailbox settlement receipt is invalid.");
	if (record.bindingRetired !== undefined && record.bindingRetired !== true)
		throw new HostEventError("invalid", "Binding retirement receipt is invalid.");
	const delivery: HostEventDelivery = {
		deliveryId: hostEventString(record.deliveryId, "deliveryId"),
		eventId: hostEventString(record.eventId, "eventId"),
		target: targetFromValue(record.target),
		status: record.status,
		purpose: record.purpose,
		generation: hostEventInteger(record.generation, "generation", 0),
		...(record.binding === undefined ? {} : { binding: parseHostEventDeliveryBinding(record.binding) }),
		...(record.bindingRetired ? { bindingRetired: true } : {}),
		...(record.mailboxAccepted ? { mailboxAccepted: true } : {}),
		...(record.mailboxSettled ? { mailboxSettled: true } : {}),
		...(record.transcriptReceipt === undefined
			? {}
			: { transcriptReceipt: parseHostEventTranscriptReceipt(record.transcriptReceipt) }),
		...(record.parentReceiptId === undefined
			? {}
			: { parentReceiptId: hostEventString(record.parentReceiptId, "parentReceiptId") }),
		...(record.reason === undefined ? {} : { reason: hostEventString(record.reason, "reason", 128) }),
		...(record.settledAt === undefined ? {} : { settledAt: hostEventDate(record.settledAt, "settledAt") }),
	};
	if (
		delivery.binding &&
		(delivery.target.kind !== "task" ||
			delivery.binding.deliveryId !== delivery.deliveryId ||
			delivery.binding.eventId !== delivery.eventId ||
			delivery.binding.generation !== delivery.generation ||
			delivery.binding.subscriptionId !== delivery.target.subscriptionId ||
			// A wake-only subscription change moves an open delivery's target past its binding's revision.
			delivery.binding.subscriptionRevision > delivery.target.subscriptionRevision ||
			delivery.binding.execution.taskId !== delivery.target.taskId)
	)
		throw new HostEventError("invalid", "Delivery binding differs from immutable target.");
	if (delivery.transcriptReceipt) {
		if (!delivery.binding) throw new HostEventError("invalid", "Transcript receipt has no execution binding.");
		assertHostEventReceiptMatchesBinding(delivery.transcriptReceipt, delivery.binding);
	}
	if (
		delivery.target.kind === "root"
			? delivery.binding || delivery.transcriptReceipt || delivery.mailboxAccepted || delivery.generation !== 0
			: delivery.parentReceiptId
	)
		throw new HostEventError("invalid", "Physical receipt does not belong to its target kind.");
	if (delivery.mailboxAccepted && !delivery.binding)
		throw new HostEventError("invalid", "Mailbox acceptance has no binding.");
	if (delivery.mailboxSettled && (!delivery.binding || (!delivery.transcriptReceipt && !delivery.bindingRetired)))
		throw new HostEventError("invalid", "Mailbox settlement has no reconciled binding.");
	if (delivery.bindingRetired && (!delivery.binding || delivery.transcriptReceipt))
		throw new HostEventError("invalid", "Retired binding has inconsistent consumption state.");
	if (delivery.status === "consumed" && !delivery.transcriptReceipt && !delivery.parentReceiptId)
		throw new HostEventError("invalid", "Consumed delivery lacks physical receipt.");
	if ((delivery.status === "consumed" || delivery.status === "settled") !== (delivery.settledAt !== undefined))
		throw new HostEventError("invalid", "Delivery settlement timestamp is inconsistent.");
	return delivery;
}

export function parseHostEventProjection(value: unknown): HostEventProjection {
	const record = hostEventRecord(value, HOST_EVENT_RECORD_FIELDS, "host event projection");
	const parseMap = <T>(
		field: (typeof HOST_EVENT_RECORD_FIELDS)[number],
		parser: (entry: unknown) => T,
	): Record<string, T> => {
		const values = record[field];
		if (!values || typeof values !== "object" || Array.isArray(values))
			throw new HostEventError("invalid", `${field} must be a record.`);
		const entries = Object.entries(values);
		if (entries.length > HOST_EVENT_RECORD_LIMITS[field])
			throw new HostEventError("capacity", `${field} exceeds capacity.`);
		return Object.fromEntries(entries.map(([key, entry]) => [hostEventString(key, `${field} key`), parser(entry)]));
	};
	const state = {
		eventSources: parseMap("eventSources", sourceFromValue),
		hostEvents: parseMap("hostEvents", eventFromValue),
		threadSubscriptions: parseMap("threadSubscriptions", subscriptionFromValue),
		eventDeliveries: parseMap("eventDeliveries", deliveryFromValue),
	};
	hostEventCapacity(state);
	return state;
}

/** No independently valid record may point at another task's event, source or receipt. */
export function validateHostEventGraph(state: TaskRuntimeProjection): void {
	for (const [id, source] of Object.entries(state.eventSources)) {
		if (id !== source.registration.sourceId)
			throw new HostEventError("invalid", "Source map key differs from its identity.");
		for (const observation of source.seal?.observations ?? []) {
			if (observation.status !== "completed") continue;
			const envelope = observation.eventId ? state.hostEvents[observation.eventId]?.envelope : undefined;
			const event = envelope && isCiEnvelope(envelope) ? envelope.event : undefined;
			// A sealed occurrence this consumer accepted and pruned is retired history, not a missing event.
			if (!envelope && hostEventObservationIsHistory(state, source, observation)) continue;
			if (
				!event ||
				envelope?.sourceId !== id ||
				envelope.sourceSequence !== observation.sourceSequence ||
				ciSubjectKey(ciEventSubject(event)) !== ciSubjectKey(observation.subject) ||
				event.identity.runId !== observation.runId ||
				event.identity.runNumber !== observation.runNumber ||
				event.identity.runAttempt !== observation.runAttempt ||
				event.conclusion !== observation.conclusion
			)
				throw new HostEventError("invalid", "Source seal terminal observation lacks exact canonical event.");
		}
	}
	for (const [id, subscription] of Object.entries(state.threadSubscriptions)) {
		if (
			id !== subscription.subscriptionId ||
			!state.tasks[subscription.taskId] ||
			subscription.createdOrdinal > state.lastOrdinal ||
			(subscription.revokedOrdinal ?? 0) > state.lastOrdinal
		)
			throw new HostEventError("invalid", "Subscription references unknown task or future ordinal.");
	}
	const positions = new Set<string>();
	for (const [id, event] of Object.entries(state.hostEvents)) {
		const source = state.eventSources[event.envelope.sourceId];
		const position = JSON.stringify([
			event.envelope.sourceId,
			event.envelope.sourceEpoch,
			event.envelope.sourceSequence,
		]);
		if (
			id !== event.envelope.event.eventId ||
			!source ||
			source.registration.sourceEpoch !== event.envelope.sourceEpoch ||
			event.envelope.sourceSequence > source.acceptedThrough ||
			positions.has(position) ||
			event.acceptedOrdinal > state.lastOrdinal
		)
			throw new HostEventError("invalid", "Accepted event references inconsistent source position.");
		positions.add(position);
		for (const deliveryId of event.deliveryIds)
			if (state.eventDeliveries[deliveryId]?.eventId !== id)
				throw new HostEventError("invalid", "Event target membership is inconsistent.");
	}
	for (const [id, delivery] of Object.entries(state.eventDeliveries)) {
		const event = state.hostEvents[delivery.eventId];
		// Only a CI attempt has deliveries; an occurrence kind reaches routines from the ledger alone.
		if (id !== delivery.deliveryId || !event?.deliveryIds.includes(id) || !isCiEnvelope(event.envelope))
			throw new HostEventError("invalid", "Delivery has no canonical event membership.");
		if (delivery.target.kind === "task") {
			const subscription = state.threadSubscriptions[delivery.target.subscriptionId];
			if (
				!subscription ||
				subscription.taskId !== delivery.target.taskId ||
				subscription.revision < delivery.target.subscriptionRevision
			)
				throw new HostEventError("invalid", "Delivery has no matching subscription lineage.");
		}
		if (
			delivery.binding &&
			(delivery.binding.payloadDigest !== event.envelope.event.payloadDigest ||
				state.attempts[delivery.binding.execution.attemptId]?.taskId !== delivery.binding.execution.taskId)
		)
			throw new HostEventError("invalid", "Delivery receipt execution is inconsistent.");
	}
}
