import { isDeepStrictEqual } from "node:util";
import { selectedTaskAttempt } from "../orchestration/attempt-ordering.ts";
import type { OrchestrationEvent } from "../orchestration/contracts.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import { taskAwaitsVerification } from "../orchestration/verification-identity.ts";
import { workerReceiptOriginFromValue } from "../orchestration/worker-receipt-origin.ts";
import { hostEventCapacity } from "./host-event-capacity.ts";
import {
	assertHostEventReceiptMatchesBinding,
	ciEventSubject,
	ciSubjectKey,
	HOST_EVENT_RECALL_MS,
	type HostEventDeliveryBinding,
	type HostEventEnvelope,
	HostEventError,
	type HostEventSealObservation,
	type HostEventSubscriptionInput,
	type HostEventWorkerScope,
	hostEventArray,
	hostEventHash,
	hostEventInteger,
	hostEventRecord,
	hostEventSealedFrontier,
	hostEventSequenceRetired,
	hostEventSequenceUnaccepted,
	hostEventSourceReplaces,
	hostEventString,
	hostEventSubscriptionId,
	hostEventUnacceptedWith,
	hostEventUnacceptedWithout,
	MAX_HOST_EVENT_DELIVERIES,
	MAX_HOST_EVENT_DOMAIN_BYTES,
	MAX_HOST_EVENT_SUBSCRIPTIONS_PER_TASK,
	MAX_HOST_EVENT_TARGETS,
	MAX_HOST_EVENTS,
	parseHostEventCatchUp,
	parseHostEventCatchUpSeal,
	parseHostEventDeliveryBinding,
	parseHostEventEnvelope,
	parseHostEventReplayGap,
	parseHostEventReplayHorizon,
	parseHostEventSourceEnd,
	parseHostEventSourceRegistration,
	parseHostEventSubscriptionInput,
	parseHostEventTranscriptReceipt,
} from "./host-event-contract.ts";
import type {
	AcceptedHostEvent,
	HostEventDelivery,
	HostEventSourceState,
	HostEventSubscription,
} from "./host-event-state.ts";

export function hostEventTaskDisposition(state: TaskRuntimeProjection, taskId: string): "closed" | "dormant" | "live" {
	const task = state.tasks[taskId];
	const objective = task ? state.objectives[task.task.objectiveId]?.objective : undefined;
	if (
		!task ||
		!objective ||
		objective.status === "completed" ||
		objective.status === "cancelled" ||
		task.task.status === "cancelled" ||
		(task.task.status === "completed" && !taskAwaitsVerification(state, taskId))
	)
		return "closed";
	const attempt = selectedTaskAttempt(state, taskId);
	return objective.status === "active" && task.task.status === "running" && attempt?.status === "running"
		? "live"
		: "dormant";
}

export function hostEventSealDigest(source: HostEventSourceState): string | undefined {
	return source.seal &&
		source.seal.generation === source.catchUpGeneration &&
		source.seal.scopeVersion === source.registration.scopeVersion &&
		source.seal.throughSequence === source.acceptedThrough
		? hostEventHash("pi-host-event-seal-v2", source.seal)
		: undefined;
}

export function hostEventIsCurrent(state: TaskRuntimeProjection, event: AcceptedHostEvent): boolean {
	const source = state.eventSources[event.envelope.sourceId];
	if (!source || !hostEventSealDigest(source)) return false;
	const observation = source.seal?.observations.find(
		(candidate) => ciSubjectKey(candidate.subject) === ciSubjectKey(ciEventSubject(event.envelope.event)),
	);
	return observation?.status === "completed" && observation.eventId === event.envelope.event.eventId;
}

/**
 * A current seal observes this event's subject at a later run or attempt. A subject the seal no longer observes, or
 * an unsealed source, proves nothing about the event.
 */
export function hostEventSuperseded(state: TaskRuntimeProjection, event: AcceptedHostEvent): boolean {
	const source = state.eventSources[event.envelope.sourceId];
	if (!source || !hostEventSealDigest(source)) return false;
	const { identity } = event.envelope.event;
	const observation = source.seal?.observations.find(
		(candidate) => ciSubjectKey(candidate.subject) === ciSubjectKey(ciEventSubject(event.envelope.event)),
	);
	return (
		observation !== undefined &&
		(observation.runId > identity.runId ||
			(observation.runId === identity.runId && observation.runAttempt > identity.runAttempt))
	);
}

/**
 * A completed observation names an occurrence this consumer accepted and has since pruned: its position
 * is retired, accepted history and no retained event holds it. The seal then treats it as history.
 */
export function hostEventObservationIsHistory(
	state: Pick<TaskRuntimeProjection, "hostEvents">,
	source: HostEventSourceState,
	observation: HostEventSealObservation,
): boolean {
	const sequence = observation.sourceSequence;
	return (
		observation.status === "completed" &&
		sequence !== undefined &&
		(observation.eventId === undefined || !state.hostEvents[observation.eventId]) &&
		hostEventSequenceRetired(source, sequence) &&
		!Object.values(state.hostEvents).some(
			(accepted) =>
				accepted.envelope.sourceId === source.registration.sourceId &&
				accepted.envelope.sourceEpoch === source.registration.sourceEpoch &&
				accepted.envelope.sourceSequence === sequence,
		)
	);
}

export function hostEventDeliveryEligible(state: TaskRuntimeProjection, delivery: HostEventDelivery): boolean {
	const event = state.hostEvents[delivery.eventId];
	if (!event || delivery.status !== "pending") return false;
	if (delivery.purpose !== "handback" && !hostEventIsCurrent(state, event)) return false;
	if (delivery.target.kind === "root") {
		if (delivery.purpose !== "failure") return true;
		const source = state.eventSources[event.envelope.sourceId];
		return (
			source.registration.scopeVersion === delivery.target.scopeVersion &&
			source.registration.rootSubjects.some(
				(subject) => ciSubjectKey(subject) === ciSubjectKey(ciEventSubject(event.envelope.event)),
			)
		);
	}
	const subscription = state.threadSubscriptions[delivery.target.subscriptionId];
	return Boolean(
		subscription &&
			subscription.revision === delivery.target.subscriptionRevision &&
			subscription.revokedOrdinal === undefined &&
			hostEventTaskDisposition(state, subscription.taskId) !== "closed",
	);
}

/** One live-execution authority check for event reads, mutation and physical delivery. */
export function assertHostEventWorkerScope(
	state: TaskRuntimeProjection,
	scope: HostEventWorkerScope,
	now: number,
): AttemptRuntimeState {
	const attempt = state.attempts[scope.attemptId];
	const agent = state.agents[scope.agentId];
	if (
		!attempt ||
		hostEventTaskDisposition(state, attempt.taskId) !== "live" ||
		selectedTaskAttempt(state, attempt.taskId)?.attemptId !== scope.attemptId ||
		attempt.agentId !== scope.agentId ||
		agent?.activeAttemptId !== scope.attemptId ||
		agent.status !== "active" ||
		attempt.lease?.leaseId !== scope.leaseId ||
		attempt.lease.fencingToken !== scope.fencingToken ||
		Date.parse(attempt.lease.expiresAt) <= now
	)
		throw new HostEventError("stale_execution", "Host event worker scope is no longer the live task execution.");
	return attempt;
}

/**
 * True once a bound execution can never again be the live task execution: the attempt left
 * `running` (a resume issues the next fence), another attempt was selected, or its lease, agent or
 * conversation moved on. Lease time and source readiness are deliberately excluded: renewal and
 * catch-up can restore those, so they fence a copy without retiring it.
 */
export function hostEventExecutionSuperseded(
	state: TaskRuntimeProjection,
	execution: HostEventDeliveryBinding["execution"],
): boolean {
	const attempt = state.attempts[execution.attemptId];
	const agent = state.agents[execution.agentId];
	return (
		!attempt ||
		!agent ||
		attempt.taskId !== execution.taskId ||
		attempt.status !== "running" ||
		attempt.agentId !== execution.agentId ||
		attempt.lease?.leaseId !== execution.leaseId ||
		attempt.lease.fencingToken !== execution.fencingToken ||
		selectedTaskAttempt(state, attempt.taskId)?.attemptId !== execution.attemptId ||
		agent.activeAttemptId !== execution.attemptId ||
		agent.resumeContext.sessionId !== execution.sessionId ||
		agent.resumeContext.sessionFile !== execution.sessionFile ||
		hostEventTaskDisposition(state, attempt.taskId) === "closed"
	);
}

/**
 * A binding stays valid while its event is current under the source's present seal. The seal
 * digest, catch-up generation and scope version recorded in the binding are provenance only: a
 * reconnect that re-seals the same current event neither invalidates a queued copy nor forces a
 * rebind, while an unsealed source or a superseding event still fences it through eligibility.
 */
export function assertHostEventExecution(
	state: TaskRuntimeProjection,
	binding: HostEventDeliveryBinding,
	now: number,
): HostEventDelivery {
	const delivery = state.eventDeliveries[binding.deliveryId];
	if (
		!delivery ||
		delivery.bindingRetired ||
		!isDeepStrictEqual(delivery.binding, binding) ||
		!hostEventDeliveryEligible(state, delivery)
	)
		throw new HostEventError("stale_delivery", "Host event delivery is stale or no longer current.");
	const execution = binding.execution;
	const attempt = assertHostEventWorkerScope(state, execution, now);
	const agent = state.agents[execution.agentId];
	if (
		attempt.taskId !== execution.taskId ||
		agent.resumeContext.sessionId !== execution.sessionId ||
		agent.resumeContext.sessionFile !== execution.sessionFile
	)
		throw new HostEventError("stale_execution", "Host event execution task, lease or conversation is stale.");
	return delivery;
}

export function replaceHostEventSubscriptions(
	state: TaskRuntimeProjection,
	taskId: string,
	declarations: readonly HostEventSubscriptionInput[],
	expectedRevision: number,
	ordinal: number,
): void {
	if (!state.tasks[taskId] || hostEventTaskDisposition(state, taskId) === "closed")
		throw new HostEventError("task_closed", "Cannot subscribe a closed or unknown task.");
	const inputs = hostEventArray(
		declarations,
		MAX_HOST_EVENT_SUBSCRIPTIONS_PER_TASK,
		parseHostEventSubscriptionInput,
		"task subscriptions",
	);
	if (new Set(inputs.map((input) => input.threadKey)).size !== inputs.length)
		throw new HostEventError("invalid", "Task subscriptions require unique canonical CI thread keys.");
	const subscriptions = state.threadSubscriptions as Record<string, HostEventSubscription>;
	const existing = Object.values(subscriptions).filter((subscription) => subscription.taskId === taskId);
	const revision = existing.reduce((maximum, subscription) => Math.max(maximum, subscription.revision), 0);
	if (revision !== expectedRevision)
		throw new HostEventError("stale_subscription", "Task subscription revision changed.");
	// Fan-out is bounded where membership is admitted, so a source can always accept its next event.
	for (const input of inputs) {
		const key = ciSubjectKey(input.subject);
		const others = Object.values(subscriptions).filter(
			(subscription) =>
				subscription.taskId !== taskId &&
				subscription.revokedOrdinal === undefined &&
				ciSubjectKey(subscription.subject) === key &&
				hostEventTaskDisposition(state, subscription.taskId) !== "closed",
		).length;
		const own = inputs.filter((candidate) => ciSubjectKey(candidate.subject) === key).length;
		if (others + own >= MAX_HOST_EVENT_TARGETS)
			throw new HostEventError("capacity", "CI subject already has the maximum number of subscribed tasks.");
	}
	// Only rows whose membership or wake changes take the next revision. An identical row keeps its
	// revision, so its open deliveries stay subscribed; a wake-only change keeps membership and moves
	// its open deliveries with the row. A changed subject or a removed row is a real unsubscribe.
	const next = revision + 1;
	const declared = new Set(inputs.map((input) => hostEventSubscriptionId(taskId, input.threadKey)));
	for (const subscription of existing)
		if (subscription.revokedOrdinal === undefined && !declared.has(subscription.subscriptionId))
			subscriptions[subscription.subscriptionId] = { ...subscription, revision: next, revokedOrdinal: ordinal };
	const deliveries = state.eventDeliveries as Record<string, HostEventDelivery>;
	for (const input of inputs) {
		const id = hostEventSubscriptionId(taskId, input.threadKey);
		const prior = Object.hasOwn(subscriptions, id) ? subscriptions[id] : undefined;
		const member = prior?.revokedOrdinal === undefined && isDeepStrictEqual(prior?.subject, input.subject);
		if (!prior || !member) {
			subscriptions[id] = { ...input, subscriptionId: id, taskId, revision: next, createdOrdinal: ordinal };
			continue;
		}
		if (prior.wake === input.wake) continue;
		subscriptions[id] = { ...prior, wake: input.wake, revision: next };
		for (const delivery of Object.values(deliveries))
			if (
				delivery.target.kind === "task" &&
				delivery.target.subscriptionId === id &&
				delivery.target.subscriptionRevision === prior.revision &&
				(delivery.status === "pending" || delivery.status === "reserved")
			)
				deliveries[delivery.deliveryId] = {
					...delivery,
					target: { ...delivery.target, subscriptionRevision: next },
				};
	}
}

function settleUnusedRoot(state: TaskRuntimeProjection, event: AcceptedHostEvent, at: string): void {
	const deliveries = state.eventDeliveries as Record<string, HostEventDelivery>;
	const targets = event.deliveryIds.map((id) => deliveries[id]);
	if (targets.some((target) => target.target.kind === "task" && target.status === "pending")) return;
	const root = targets.find((target) => target.target.kind === "root");
	if (root?.status === "reserved")
		deliveries[root.deliveryId] = { ...root, status: "settled", reason: "task_delivery_settled", settledAt: at };
}

/**
 * Retained state is within a quarter of a record or byte bound. Settled history then gives up its
 * recall window, so a burst of evidence never leaves the source unable to accept its next event.
 */
export function hostEventRetentionPressure(state: TaskRuntimeProjection): boolean {
	if (Object.keys(state.hostEvents).length > (MAX_HOST_EVENTS * 3) / 4) return true;
	if (Object.keys(state.eventDeliveries).length > (MAX_HOST_EVENT_DELIVERIES * 3) / 4) return true;
	const { bytes, reservedBytes } = hostEventCapacity(state);
	return bytes + reservedBytes > (MAX_HOST_EVENT_DOMAIN_BYTES * 3) / 4;
}

/** `pressure` waives only the recall window; replay, seal and delivery obligations always pin an event. */
export function hostEventCanPrune(
	state: TaskRuntimeProjection,
	event: AcceptedHostEvent,
	now: number,
	pressure = false,
): boolean {
	const source = state.eventSources[event.envelope.sourceId];
	return (
		event.envelope.sourceSequence <= source.retiredThrough &&
		(pressure || Date.parse(event.recallUntil) <= now) &&
		!source.seal?.observations.some((observation) => observation.eventId === event.envelope.event.eventId) &&
		event.deliveryIds.every((id) => {
			const delivery = state.eventDeliveries[id];
			return (
				(delivery.status === "consumed" || delivery.status === "settled") &&
				(!delivery.binding || delivery.mailboxSettled === true) &&
				(delivery.target.kind !== "task" || hostEventTaskDisposition(state, delivery.target.taskId) === "closed")
			);
		})
	);
}

function acceptCanonicalHostEvent(
	state: TaskRuntimeProjection,
	event: OrchestrationEvent,
	envelope: HostEventEnvelope,
	consumerId: unknown,
	origin: unknown,
): void {
	const source = state.eventSources[envelope.sourceId];
	const events = state.hostEvents as Record<string, AcceptedHostEvent>;
	const deliveries = state.eventDeliveries as Record<string, HostEventDelivery>;
	const id = envelope.event.eventId;
	if (
		Object.values(events).some(
			(accepted) =>
				accepted.envelope.sourceId === envelope.sourceId &&
				accepted.envelope.sourceEpoch === envelope.sourceEpoch &&
				accepted.envelope.sourceSequence === envelope.sourceSequence,
		)
	)
		throw new HostEventError("identity_conflict", "Source position already belongs to another event.");
	// Up to the frontier every position not still unaccepted was this consumer's custody: only a new
	// stream position or an unaccepted snapshot position below the floor takes a new occurrence.
	if (
		envelope.sourceSequence <= source.acceptedThrough &&
		!hostEventSequenceUnaccepted(source.unaccepted, envelope.sourceSequence)
	)
		throw new HostEventError(
			"identity_conflict",
			"A position already in this consumer's custody cannot be accepted again.",
		);
	const key = ciSubjectKey(ciEventSubject(envelope.event));
	if (!source.registration.subjects.some((subject) => ciSubjectKey(subject) === key))
		throw new HostEventError("source_conflict", "Event is outside registered source scope.");
	const subscriptions = Object.values(state.threadSubscriptions).filter(
		(subscription) =>
			subscription.revokedOrdinal === undefined &&
			ciSubjectKey(subscription.subject) === key &&
			hostEventTaskDisposition(state, subscription.taskId) !== "closed",
	);
	if (subscriptions.length >= MAX_HOST_EVENT_TARGETS)
		throw new HostEventError("capacity", "Event fanout exceeds target capacity including its root fallback.");
	const deliveryIds: string[] = [];
	for (const subscription of subscriptions) {
		const deliveryId = `hed-${hostEventHash("pi-host-event-target-v1", [id, subscription.subscriptionId, subscription.revision])}`;
		deliveryIds.push(deliveryId);
		deliveries[deliveryId] = {
			deliveryId,
			eventId: id,
			target: {
				kind: "task",
				taskId: subscription.taskId,
				subscriptionId: subscription.subscriptionId,
				subscriptionRevision: subscription.revision,
			},
			status: envelope.event.conclusion === "failure" ? "pending" : "reserved",
			purpose: envelope.event.conclusion === "failure" ? "failure" : "update",
			generation: 0,
		};
	}
	const rootId = `hed-${hostEventHash("pi-host-event-root-v1", id)}`;
	deliveryIds.push(rootId);
	const rootApplicable = source.registration.rootSubjects.some((subject) => ciSubjectKey(subject) === key);
	deliveries[rootId] = {
		deliveryId: rootId,
		eventId: id,
		target: { kind: "root", scopeVersion: source.registration.scopeVersion },
		status:
			envelope.event.conclusion === "failure" && subscriptions.length === 0 && rootApplicable
				? "pending"
				: "reserved",
		purpose: envelope.event.conclusion === "failure" ? "failure" : "update",
		generation: 0,
	};
	events[id] = {
		envelope,
		receipt: {
			consumerId: hostEventString(consumerId, "consumerId"),
			sourceId: envelope.sourceId,
			sourceEpoch: envelope.sourceEpoch,
			sourceSequence: envelope.sourceSequence,
			eventId: id,
			payloadDigest: envelope.event.payloadDigest,
			canonicalReceiptId: `her-${hostEventHash("pi-host-event-receipt-v1", [event.eventId, id])}`,
		},
		origin: workerReceiptOriginFromValue(origin),
		acceptedOrdinal: event.ordinal,
		recallUntil: new Date(Date.parse(event.occurredAt) + HOST_EVENT_RECALL_MS).toISOString(),
		deliveryIds,
	};
}

/** Pure mutation of reducer-owned copied record maps; never performs I/O or owns another store. */
export function applyHostEvent(state: TaskRuntimeProjection, event: OrchestrationEvent): boolean {
	const sources = state.eventSources as Record<string, HostEventSourceState>;
	const events = state.hostEvents as Record<string, AcceptedHostEvent>;
	const deliveries = state.eventDeliveries as Record<string, HostEventDelivery>;
	const payload = event.payload;
	switch (event.type) {
		case "host_source.registered": {
			const registration = parseHostEventSourceRegistration(payload.registration);
			if (event.aggregateId !== registration.sourceId)
				throw new HostEventError("invalid", "Source aggregate mismatch.");
			const prior = sources[registration.sourceId];
			if (prior) {
				if (prior.ended) throw new HostEventError("source_ended", "An ended source is never registered again.");
				if (isDeepStrictEqual(prior.registration, registration)) break;
				// A source saved before stores named themselves adopts its store identity unchanged otherwise.
				const { storeIdentity, ...named } = registration;
				if (
					prior.registration.storeIdentity === undefined &&
					storeIdentity !== undefined &&
					isDeepStrictEqual(prior.registration, named)
				) {
					sources[registration.sourceId] = { ...prior, registration };
					break;
				}
				if (
					prior.registration.storeIdentity !== registration.storeIdentity ||
					prior.registration.sourceEpoch !== registration.sourceEpoch ||
					prior.registration.startingSequence !== registration.startingSequence ||
					registration.scopeVersion !== prior.registration.scopeVersion + 1
				)
					throw new HostEventError(
						"source_conflict",
						"Source scope change is not the next revision of this epoch.",
					);
				const priorRootSubjects = new Set(prior.registration.rootSubjects.map(ciSubjectKey));
				const nextRootSubjects = new Set(registration.rootSubjects.map(ciSubjectKey));
				for (const accepted of Object.values(events)) {
					if (accepted.envelope.sourceId !== registration.sourceId) continue;
					const subject = ciSubjectKey(ciEventSubject(accepted.envelope.event));
					for (const id of accepted.deliveryIds) {
						const delivery = deliveries[id];
						if (
							delivery.target.kind !== "root" ||
							delivery.purpose !== "failure" ||
							(delivery.status !== "pending" && delivery.status !== "reserved")
						)
							continue;
						if (priorRootSubjects.has(subject) && nextRootSubjects.has(subject))
							deliveries[id] = {
								...delivery,
								target: { kind: "root", scopeVersion: registration.scopeVersion },
							};
						else if (delivery.status === "pending")
							deliveries[id] = {
								...delivery,
								status: "settled",
								reason: "root_scope_changed",
								settledAt: event.occurredAt,
							};
					}
				}
				sources[registration.sourceId] = { ...prior, registration };
			} else
				sources[registration.sourceId] = {
					registration,
					acceptedThrough: registration.startingSequence - 1,
					retiredThrough: registration.startingSequence - 1,
					catchUpGeneration: 0,
					replayFloor: registration.startingSequence,
					// The fixed stream floor: earlier positions reach this consumer only as snapshots.
					unaccepted:
						registration.startingSequence > 1 ? [{ from: 1, through: registration.startingSequence - 1 }] : [],
					// The sources it replaced ended in the same admission, just before.
					...(Object.values(sources).some(
						(source) => source.ended && hostEventSourceReplaces(registration, source.registration),
					)
						? { replaced: true as const }
						: {}),
				};
			break;
		}
		case "host_source.catchup_started": {
			const catchUp = parseHostEventCatchUp(payload.catchUp);
			const source = sources[catchUp.sourceId];
			if (
				!source ||
				source.ended ||
				event.aggregateId !== catchUp.sourceId ||
				catchUp.sourceEpoch !== source.registration.sourceEpoch ||
				catchUp.scopeVersion !== source.registration.scopeVersion ||
				catchUp.generation !== source.catchUpGeneration + 1
			)
				throw new HostEventError("source_conflict", "Catch-up does not extend current source generation.");
			sources[catchUp.sourceId] = { ...source, catchUpGeneration: catchUp.generation };
			break;
		}
		case "host_source.replay_gap": {
			const gap = parseHostEventReplayGap(payload.gap);
			const source = sources[gap.sourceId];
			if (
				!source ||
				source.ended ||
				event.aggregateId !== gap.sourceId ||
				gap.sourceEpoch !== source.registration.sourceEpoch ||
				gap.scopeVersion !== source.registration.scopeVersion ||
				gap.generation !== source.catchUpGeneration ||
				gap.afterSequence !== source.acceptedThrough ||
				hostEventSealDigest(source)
			)
				throw new HostEventError("source_conflict", "Replay gap does not extend this unsealed consumer frontier.");
			sources[gap.sourceId] = {
				...source,
				acceptedThrough: gap.throughSequence,
				retiredThrough: gap.throughSequence,
				replayFloor: gap.throughSequence + 1,
				lastReplayGap: gap,
				unaccepted: hostEventUnacceptedWith(source.unaccepted, {
					from: gap.afterSequence + 1,
					through: gap.throughSequence,
				}),
			};
			break;
		}
		case "host_source.sealed": {
			const seal = parseHostEventCatchUpSeal(payload.seal);
			const frontier = hostEventSealedFrontier(seal);
			const source = sources[seal.sourceId];
			if (
				!source ||
				source.ended ||
				event.aggregateId !== seal.sourceId ||
				seal.sourceEpoch !== source.registration.sourceEpoch ||
				seal.scopeVersion !== source.registration.scopeVersion ||
				seal.generation !== source.catchUpGeneration ||
				seal.throughSequence !== source.acceptedThrough
			)
				throw new HostEventError(
					"source_conflict",
					"Seal does not identify the complete accepted source frontier.",
				);
			if (source.seal?.generation === seal.generation && !isDeepStrictEqual(source.seal, frontier))
				throw new HostEventError("source_conflict", "Published source seal is immutable.");
			for (const snapshot of seal.snapshots ?? []) {
				const observation = seal.observations.find((candidate) => candidate.eventId === snapshot.event.eventId);
				if (
					observation?.status !== "completed" ||
					observation.sourceSequence !== snapshot.sourceSequence ||
					snapshot.sourceId !== seal.sourceId ||
					snapshot.sourceEpoch !== seal.sourceEpoch ||
					snapshot.sourceSequence >= source.replayFloor
				)
					throw new HostEventError(
						"source_conflict",
						"Snapshot is not a current terminal observation below the stream replay floor.",
					);
				const retained = events[snapshot.event.eventId];
				const custody = sources[seal.sourceId];
				if (retained) {
					if (!isDeepStrictEqual(retained.envelope, snapshot))
						throw new HostEventError("identity_conflict", "Current snapshot differs from retained occurrence.");
				} else if (hostEventSequenceUnaccepted(custody.unaccepted, snapshot.sourceSequence)) {
					acceptCanonicalHostEvent(state, event, snapshot, payload.consumerId, payload.origin);
					sources[seal.sourceId] = {
						...custody,
						unaccepted: hostEventUnacceptedWithout(custody.unaccepted, snapshot.sourceSequence),
					};
				} else if (!hostEventObservationIsHistory(state, custody, observation))
					throw new HostEventError(
						"identity_conflict",
						"Snapshot names a position this consumer holds without that occurrence.",
					);
				// Otherwise its custody was already transferred and released: a snapshot never delivers it again.
			}
			for (const observation of seal.observations) {
				const key = ciSubjectKey(observation.subject);
				if (!source.registration.subjects.some((subject) => ciSubjectKey(subject) === key))
					throw new HostEventError("source_conflict", "Seal observation is outside registered scope.");
				const previous = source.seal?.observations.find((candidate) => ciSubjectKey(candidate.subject) === key);
				if (
					previous &&
					(observation.runNumber < previous.runNumber ||
						(observation.runNumber === previous.runNumber && observation.runAttempt < previous.runAttempt))
				)
					throw new HostEventError("source_conflict", "Seal moves upstream attempt ordering backwards.");
				if (previous && observation.runNumber === previous.runNumber && observation.runId !== previous.runId)
					throw new HostEventError("source_conflict", "Workflow run number has conflicting run identity.");
				if (
					previous?.status === "completed" &&
					observation.runNumber === previous.runNumber &&
					observation.runAttempt === previous.runAttempt &&
					!isDeepStrictEqual(observation, previous)
				)
					throw new HostEventError("source_conflict", "Completed attempt observation cannot change.");
				if (observation.status === "completed") {
					const terminal = observation.eventId ? events[observation.eventId] : undefined;
					const item = terminal?.envelope.event;
					// A released occurrence of this consumer's own history: the seal neither fails nor redelivers it.
					if (!terminal && hostEventObservationIsHistory(state, sources[seal.sourceId], observation)) continue;
					if (
						!terminal ||
						terminal.envelope.sourceId !== seal.sourceId ||
						terminal.envelope.sourceSequence !== observation.sourceSequence ||
						!item ||
						ciSubjectKey(ciEventSubject(item)) !== key ||
						item.identity.runId !== observation.runId ||
						item.identity.runNumber !== observation.runNumber ||
						item.identity.runAttempt !== observation.runAttempt ||
						item.conclusion !== observation.conclusion
					)
						throw new HostEventError("source_conflict", "Seal terminal outcome has no matching accepted event.");
				}
			}
			// Accepted snapshots already narrowed this source's unaccepted positions.
			sources[seal.sourceId] = { ...sources[seal.sourceId], seal: frontier };
			for (const accepted of Object.values(events).filter(
				(candidate) => candidate.envelope.sourceId === seal.sourceId,
			)) {
				const current = hostEventIsCurrent(state, accepted);
				const subjectKey = ciSubjectKey(ciEventSubject(accepted.envelope.event));
				const consumedPrior = Object.values(deliveries).filter(
					(delivery) =>
						delivery.status === "consumed" &&
						delivery.eventId !== accepted.envelope.event.eventId &&
						events[delivery.eventId]?.envelope.event.conclusion === "failure" &&
						ciSubjectKey(ciEventSubject(events[delivery.eventId].envelope.event)) === subjectKey,
				);
				for (const id of accepted.deliveryIds) {
					const delivery = deliveries[id];
					if (delivery.status !== "pending" && delivery.status !== "reserved") continue;
					if (!current) {
						deliveries[id] = {
							...delivery,
							status: "settled",
							reason: "source_superseded",
							settledAt: event.occurredAt,
						};
						continue;
					}
					if (delivery.purpose === "update") {
						const relevant = consumedPrior.some(
							(prior) =>
								delivery.target.kind === "root" ||
								(prior.target.kind === "task" &&
									prior.target.taskId === (delivery.target.kind === "task" ? delivery.target.taskId : "")),
						);
						deliveries[id] = relevant
							? { ...delivery, status: "pending" }
							: {
									...delivery,
									status: "settled",
									reason: "no_superseded_consumption",
									settledAt: event.occurredAt,
								};
					} else if (
						delivery.target.kind === "root" &&
						!accepted.deliveryIds.some((targetId) => deliveries[targetId].target.kind === "task") &&
						!hostEventDeliveryEligible(state, delivery)
					) {
						deliveries[id] = {
							...delivery,
							status: "settled",
							reason: "non_actionable",
							settledAt: event.occurredAt,
						};
					}
				}
			}
			break;
		}
		case "host_source.ended": {
			const end = parseHostEventSourceEnd(payload.end);
			const source = sources[end.sourceId];
			if (
				!source ||
				source.ended ||
				event.aggregateId !== end.sourceId ||
				end.sourceEpoch !== source.registration.sourceEpoch
			)
				throw new HostEventError("source_conflict", "Only a registered, unended source epoch can end.");
			// Nothing of this source is current again: its open deliveries settle, a bound copy once its physical
			// mailbox is reconciled (the session drain does that), and its history becomes prunable.
			for (const accepted of Object.values(events)) {
				if (accepted.envelope.sourceId !== end.sourceId) continue;
				for (const id of accepted.deliveryIds) {
					const delivery = deliveries[id];
					if (
						(delivery.status === "pending" || delivery.status === "reserved") &&
						(!delivery.binding || delivery.mailboxSettled)
					)
						deliveries[id] = {
							...delivery,
							status: "settled",
							reason: "source_ended",
							settledAt: event.occurredAt,
						};
				}
			}
			const { seal: _seal, ...unsealed } = source;
			sources[end.sourceId] = {
				...unsealed,
				retiredThrough: source.acceptedThrough,
				ended: { reason: end.reason, at: event.occurredAt },
			};
			break;
		}
		case "host_source.retired": {
			const horizon = parseHostEventReplayHorizon(payload.horizon);
			const source = sources[horizon.sourceId];
			if (
				!source ||
				source.ended ||
				event.aggregateId !== horizon.sourceId ||
				horizon.sourceEpoch !== source.registration.sourceEpoch ||
				horizon.throughSequence < source.retiredThrough ||
				horizon.throughSequence > source.acceptedThrough
			)
				throw new HostEventError("source_conflict", "Replay horizon is outside accepted source history.");
			sources[horizon.sourceId] = { ...source, retiredThrough: horizon.throughSequence };
			break;
		}
		case "task.subscriptions_replaced": {
			const taskId = hostEventString(payload.taskId, "taskId");
			if (event.aggregateId !== taskId || (event.actor !== "human" && event.actor !== "worker"))
				throw new HostEventError("authority", "Task subscriptions require root or scoped worker admission.");
			const subscriptions = hostEventArray(
				payload.subscriptions,
				MAX_HOST_EVENT_SUBSCRIPTIONS_PER_TASK,
				parseHostEventSubscriptionInput,
				"subscriptions",
			);
			if (event.actor === "worker") {
				const scope = hostEventRecord(
					payload.workerScope,
					["agentId", "attemptId", "leaseId", "fencingToken"],
					"worker subscription scope",
				);
				const agentId = hostEventString(scope.agentId, "agentId");
				const attemptId = hostEventString(scope.attemptId, "attemptId");
				const leaseId = hostEventString(scope.leaseId, "leaseId");
				const fencingToken = hostEventInteger(scope.fencingToken, "fencingToken");
				const attempt = assertHostEventWorkerScope(
					state,
					{ agentId, attemptId, leaseId, fencingToken },
					Date.parse(event.occurredAt),
				);
				if (attempt.taskId !== taskId)
					throw new HostEventError("stale_execution", "Worker subscription scope is no longer the live task.");
				const current = Object.values(state.threadSubscriptions).filter(
					(subscription) => subscription.taskId === taskId && subscription.revokedOrdinal === undefined,
				);
				if (
					subscriptions.some(
						(replacement) =>
							!current.some(
								(prior) =>
									prior.threadKey === replacement.threadKey &&
									isDeepStrictEqual(prior.subject, replacement.subject) &&
									(prior.wake === replacement.wake ||
										(prior.wake === "resume_same_task" && replacement.wake === "never")),
							),
					)
				)
					throw new HostEventError("authority", "Workers may only narrow their current task's subscriptions.");
			} else if (payload.workerScope !== undefined) {
				throw new HostEventError("authority", "Root subscription admission cannot carry a worker scope.");
			}
			replaceHostEventSubscriptions(
				state,
				taskId,
				subscriptions,
				hostEventInteger(payload.expectedRevision, "expectedRevision", 0),
				event.ordinal,
			);
			break;
		}
		case "host_event.accepted": {
			const envelope = parseHostEventEnvelope(payload.envelope);
			const source = sources[envelope.sourceId];
			const id = envelope.event.eventId;
			if (
				!source ||
				source.ended ||
				event.aggregateId !== id ||
				envelope.sourceEpoch !== source.registration.sourceEpoch ||
				source.catchUpGeneration === 0 ||
				hostEventSealDigest(source) ||
				envelope.sourceSequence !== source.acceptedThrough + 1 ||
				events[id]
			)
				throw new HostEventError("source_conflict", "Host event is not the next immutable source occurrence.");
			acceptCanonicalHostEvent(state, event, envelope, payload.consumerId, payload.origin);
			sources[envelope.sourceId] = { ...source, acceptedThrough: envelope.sourceSequence };
			break;
		}
		case "host_event.delivery_bound": {
			const binding = parseHostEventDeliveryBinding(payload.binding);
			const delivery = deliveries[binding.deliveryId];
			if (delivery?.binding && (!delivery.bindingRetired || !delivery.mailboxSettled))
				throw new HostEventError(
					"binding_unreconciled",
					"Previous physical transcript must be reconciled before rebinding.",
				);
			if (
				!delivery ||
				event.aggregateId !== binding.deliveryId ||
				delivery.target.kind !== "task" ||
				!hostEventDeliveryEligible(state, delivery) ||
				binding.generation !== delivery.generation + 1 ||
				binding.execution.taskId !== delivery.target.taskId ||
				binding.subscriptionId !== delivery.target.subscriptionId ||
				binding.subscriptionRevision !== delivery.target.subscriptionRevision ||
				binding.eventId !== delivery.eventId ||
				binding.payloadDigest !== events[delivery.eventId].envelope.event.payloadDigest ||
				binding.messageId !==
					`host-event-${hostEventHash("pi-host-event-message-v1", [binding.deliveryId, binding.generation])}`
			)
				throw new HostEventError("stale_delivery", "Cannot bind this delivery generation.");
			const next: HostEventDelivery = { ...delivery, generation: binding.generation, binding };
			delete (next as { mailboxAccepted?: true }).mailboxAccepted;
			delete (next as { mailboxSettled?: true }).mailboxSettled;
			delete (next as { bindingRetired?: true }).bindingRetired;
			deliveries[binding.deliveryId] = next;
			assertHostEventExecution(state, binding, Date.parse(event.occurredAt));
			break;
		}
		case "host_event.binding_retired": {
			const binding = parseHostEventDeliveryBinding(payload.binding);
			const delivery = deliveries[binding.deliveryId];
			if (
				!delivery ||
				event.aggregateId !== binding.deliveryId ||
				!isDeepStrictEqual(delivery.binding, binding) ||
				delivery.transcriptReceipt
			)
				throw new HostEventError("stale_delivery", "Cannot retire a changed or consumed binding.");
			deliveries[binding.deliveryId] = { ...delivery, bindingRetired: true };
			break;
		}
		case "host_event.mailbox_accepted":
		case "host_event.mailbox_settled":
		case "host_event.consumed": {
			const binding = parseHostEventDeliveryBinding(payload.binding);
			const delivery = deliveries[binding.deliveryId];
			if (!delivery || event.aggregateId !== binding.deliveryId || !isDeepStrictEqual(delivery.binding, binding))
				throw new HostEventError("stale_delivery", "Receipt does not match retained binding.");
			if (event.type === "host_event.mailbox_accepted") {
				assertHostEventExecution(state, binding, Date.parse(event.occurredAt));
				deliveries[binding.deliveryId] = { ...delivery, mailboxAccepted: true };
			} else if (event.type === "host_event.mailbox_settled") {
				if (!delivery.transcriptReceipt && !delivery.bindingRetired)
					throw new HostEventError(
						"binding_unreconciled",
						"Mailbox settlement requires original transcript proof.",
					);
				deliveries[binding.deliveryId] = { ...delivery, mailboxSettled: true };
			} else {
				const receipt = parseHostEventTranscriptReceipt(payload.receipt);
				assertHostEventReceiptMatchesBinding(receipt, binding);
				if (delivery.transcriptReceipt && !isDeepStrictEqual(delivery.transcriptReceipt, receipt))
					throw new HostEventError("identity_conflict", "Transcript consumption receipt changed.");
				deliveries[binding.deliveryId] = {
					...delivery,
					status: "consumed",
					transcriptReceipt: receipt,
					settledAt: event.occurredAt,
				};
				settleUnusedRoot(state, events[delivery.eventId], event.occurredAt);
			}
			break;
		}
		case "host_event.root_consumed": {
			const deliveryId = hostEventString(payload.deliveryId, "deliveryId");
			const delivery = deliveries[deliveryId];
			if (
				!delivery ||
				event.aggregateId !== deliveryId ||
				delivery.target.kind !== "root" ||
				(payload.historical !== true && !hostEventDeliveryEligible(state, delivery))
			)
				throw new HostEventError("stale_delivery", "Root event delivery is not currently eligible.");
			deliveries[deliveryId] = {
				...delivery,
				status: "consumed",
				parentReceiptId: hostEventString(payload.parentReceiptId, "parentReceiptId"),
				settledAt: event.occurredAt,
			};
			break;
		}
		case "host_event.settled": {
			const deliveryId = hostEventString(payload.deliveryId, "deliveryId");
			const reason = hostEventString(payload.reason, "reason", 128);
			const delivery = deliveries[deliveryId];
			if (!delivery || event.aggregateId !== deliveryId || delivery.status === "consumed")
				throw new HostEventError("stale_delivery", "Cannot settle a consumed or unknown event delivery.");
			if (delivery.binding && !delivery.mailboxSettled)
				throw new HostEventError(
					"binding_unreconciled",
					"Reconcile the physical mailbox before handing back delivery.",
				);
			if (
				![
					"task_closed",
					"unsubscribed",
					"source_superseded",
					"root_scope_changed",
					"handed_back",
					"non_actionable",
					"source_ended",
				].includes(reason)
			)
				throw new HostEventError("invalid", "Unknown host event settlement reason.");
			deliveries[deliveryId] = { ...delivery, status: "settled", reason, settledAt: event.occurredAt };
			if (
				delivery.target.kind === "task" &&
				(reason === "task_closed" || reason === "unsubscribed" || reason === "handed_back")
			) {
				const root = events[delivery.eventId].deliveryIds
					.map((id) => deliveries[id])
					.find((candidate) => candidate.target.kind === "root");
				if (root?.status === "reserved")
					deliveries[root.deliveryId] = { ...root, status: "pending", purpose: "handback" };
			}
			settleUnusedRoot(state, events[delivery.eventId], event.occurredAt);
			break;
		}
		case "host_event.pruned": {
			const ids = hostEventArray(
				payload.eventIds,
				MAX_HOST_EVENT_TARGETS,
				(id) => hostEventString(id, "eventId"),
				"pruned events",
			);
			const pressure = payload.pressure === true;
			if (pressure && !hostEventRetentionPressure(state))
				throw new HostEventError("retained", "Host event recall is waived only under retention pressure.");
			for (const id of ids) {
				const accepted = events[id];
				if (!accepted) continue;
				if (!hostEventCanPrune(state, accepted, Date.parse(event.occurredAt), pressure))
					throw new HostEventError("retained", "Host event still owns recall, replay or delivery obligations.");
				// Its position stays retired, accepted history (`hostEventSequenceRetired`), so a later seal
				// naming it neither fails nor accepts it again.
				for (const deliveryId of accepted.deliveryIds) delete deliveries[deliveryId];
				delete events[id];
			}
			// An ended source leaves the ledger with its last event: it bounds nothing and can never deliver again.
			for (const source of Object.values(sources))
				if (
					source.ended &&
					!Object.values(events).some((accepted) => accepted.envelope.sourceId === source.registration.sourceId)
				)
					delete sources[source.registration.sourceId];
			break;
		}
		default:
			return false;
	}
	return true;
}
