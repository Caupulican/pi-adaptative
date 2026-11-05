import { isDeepStrictEqual } from "node:util";
import { createWorkerHostEventRecord, parseHostEventExecutionIdentity } from "../../kernel/host-event-stamp.ts";
import { IndependentObserverSet } from "../observer-dispatch.ts";
import type { AppendOrchestrationEventInput } from "../orchestration/contracts.ts";
import { toJsonObject } from "../orchestration/contracts.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import { assertWorkerReceiptAdmission, type WorkerReceiptOrigin } from "../orchestration/worker-receipt-origin.ts";
import {
	type CiSubject,
	ciSubjectKey,
	type HostEventCatchUp,
	type HostEventCatchUpSeal,
	type HostEventDeliveryBinding,
	type HostEventEnvelope,
	HostEventError,
	type HostEventExecutionIdentity,
	type HostEventReceipt,
	type HostEventReplayGap,
	type HostEventReplayHorizon,
	type HostEventSourceRegistration,
	type HostEventSubscriptionInput,
	type HostEventTranscriptReceipt,
	type HostEventWorkerScope,
	hostEventDigest,
	hostEventHash,
	hostEventInteger,
	hostEventSealedFrontier,
	hostEventString,
	hostEventTombstoneIsSnapshot,
	MAX_HOST_EVENT_SOURCES,
	parseHostEventCatchUp,
	parseHostEventCatchUpSeal,
	parseHostEventDeliveryBinding,
	parseHostEventEnvelope,
	parseHostEventReplayGap,
	parseHostEventReplayHorizon,
	parseHostEventSourceRegistration,
	parseHostEventTranscriptReceipt,
} from "./host-event-contract.ts";
import {
	assertHostEventExecution,
	hostEventCanPrune,
	hostEventDeliveryEligible,
	hostEventRetentionPressure,
	hostEventSealDigest,
	hostEventTaskDisposition,
} from "./host-event-reducer.ts";
import type { AcceptedHostEvent, HostEventDelivery } from "./host-event-state.ts";

export interface HostEventRuntimeTransaction {
	readonly snapshot: TaskRuntimeProjection;
	commit(input: AppendOrchestrationEventInput): void;
}

export interface HostEventRuntimePort {
	readonly parentSessionId: string;
	read(): TaskRuntimeProjection;
	transact<T>(operation: (transaction: HostEventRuntimeTransaction) => T): T;
	now(): number;
	subscribe(listener: () => void): () => void;
}

const sourceLifetimeBrand: unique symbol = Symbol("host-event-source-lifetime");
export interface HostEventSourceLifetime {
	readonly [sourceLifetimeBrand]: true;
}

export interface HostEventDeliveryTransaction {
	readonly event: AcceptedHostEvent;
	readonly delivery: HostEventDelivery;
	readonly binding: HostEventDeliveryBinding;
	acknowledgeMailbox(): void;
	/** Call only after the exact physical mailbox write, while its lock remains held. */
	acknowledgeMailboxSettlement(): void;
	consume(receipt: HostEventTranscriptReceipt): void;
	/** Only after the original transcript, under its lock, proves no consumption exists. */
	retireUnconsumedBinding(): void;
}

export interface HostEventRootTransaction {
	readonly event: AcceptedHostEvent;
	readonly delivery: HostEventDelivery;
	acknowledge(parentReceiptId: string): void;
}

/** Canonical domain commands plus process-local source authority; durable facts stay in the task runtime. */
export class HostEventRuntime {
	private readonly port: HostEventRuntimePort;
	private readonly lifetimes = new Map<HostEventSourceLifetime, number>();
	private readonly sourceOwners = new Map<
		string,
		{ lifetime: HostEventSourceLifetime; order: number; active: boolean }
	>();
	private readonly readySources = new Map<string, string>();
	private readonly readiness = new IndependentObserverSet<() => void>();
	private nextLifetime = 0;
	constructor(port: HostEventRuntimePort) {
		this.port = port;
	}
	get parentSessionId(): string {
		return this.port.parentSessionId;
	}

	openSourceLifetime(): HostEventSourceLifetime {
		if (this.lifetimes.size >= MAX_HOST_EVENT_SOURCES || this.nextLifetime === Number.MAX_SAFE_INTEGER)
			throw new HostEventError("capacity", "Host source lifetime capacity exceeded.");
		const lifetime = Object.freeze({ [sourceLifetimeBrand]: true as const });
		this.lifetimes.set(lifetime, ++this.nextLifetime);
		return lifetime;
	}

	closeSourceLifetime(lifetime: HostEventSourceLifetime): void {
		if (!this.lifetimes.delete(lifetime)) return;
		for (const [sourceId, owner] of this.sourceOwners)
			if (owner.lifetime === lifetime) this.readySources.delete(sourceId);
		this.notifyReadiness();
	}

	deactivateSource(sourceId: string, lifetime: HostEventSourceLifetime): void {
		const owner = this.sourceOwners.get(sourceId);
		if (owner?.lifetime !== lifetime) return;
		owner.active = false;
		this.invalidateSource(sourceId);
	}

	private invalidateSource(sourceId: string): void {
		if (this.readySources.delete(sourceId)) this.notifyReadiness();
	}

	private assertLifetime(lifetime: HostEventSourceLifetime): number {
		const order = this.lifetimes.get(lifetime);
		if (order === undefined) throw new HostEventError("closed", "Host source lifetime has expired.");
		return order;
	}

	private assertSourceOwner(sourceId: string, lifetime: HostEventSourceLifetime): void {
		this.assertLifetime(lifetime);
		const owner = this.sourceOwners.get(sourceId);
		if (owner?.lifetime !== lifetime || !owner.active)
			throw new HostEventError("source_replaced", "Host source belongs to another live binding.");
	}

	private assertSourceClaim(sourceId: string, lifetime: HostEventSourceLifetime): number {
		const order = this.assertLifetime(lifetime);
		const owner = this.sourceOwners.get(sourceId);
		if (owner && owner.order > order)
			throw new HostEventError("source_replaced", "An older source binding cannot reclaim authority.");
		return order;
	}

	private sourceReady(sourceId: string, state: TaskRuntimeProjection): boolean {
		const owner = this.sourceOwners.get(sourceId);
		const source = state.eventSources[sourceId];
		const digest = this.readySources.get(sourceId);
		return Boolean(
			owner?.active &&
				this.lifetimes.has(owner.lifetime) &&
				source &&
				digest &&
				digest === hostEventSealDigest(source),
		);
	}

	isSourceReady(sourceId: string): boolean {
		return this.sourceReady(sourceId, this.port.read());
	}

	private assertDeliveryReady(state: TaskRuntimeProjection, delivery: HostEventDelivery): void {
		const event = state.hostEvents[delivery.eventId];
		if (delivery.purpose !== "handback" && (!event || !this.sourceReady(event.envelope.sourceId, state)))
			throw new HostEventError("source_catching_up", "Host source has not reconciled in this live session.");
	}

	private notifyReadiness(): void {
		this.readiness.notify(
			(listener) => listener(),
			(error) =>
				process.emitWarning(error instanceof Error ? error : new Error(String(error)), {
					code: "PI_HOST_EVENT_READINESS_OBSERVER",
				}),
		);
	}

	subscribe(listener: () => void): () => void {
		const offState = this.port.subscribe(listener);
		const offReadiness = this.readiness.subscribe(listener);
		return () => {
			offState();
			offReadiness();
		};
	}
	subscribedSubjects(): readonly CiSubject[] {
		const state = this.port.read();
		const subjects = new Map<string, CiSubject>();
		for (const subscription of Object.values(state.threadSubscriptions)) {
			if (
				subscription.revokedOrdinal === undefined &&
				hostEventTaskDisposition(state, subscription.taskId) !== "closed"
			)
				subjects.set(ciSubjectKey(subscription.subject), subscription.subject);
		}
		return [...subjects.values()];
	}
	getEvent(eventId: string): AcceptedHostEvent | undefined {
		return this.port.read().hostEvents[eventId];
	}
	getDelivery(deliveryId: string): HostEventDelivery | undefined {
		return this.port.read().eventDeliveries[deliveryId];
	}
	pendingDeliveries(): readonly HostEventDelivery[] {
		return Object.values(this.port.read().eventDeliveries).filter((delivery) => delivery.status === "pending");
	}
	eligible(deliveryId: string): boolean {
		const state = this.port.read();
		const delivery = state.eventDeliveries[deliveryId];
		return Boolean(
			delivery &&
				hostEventDeliveryEligible(state, delivery) &&
				(delivery.purpose === "handback" ||
					this.sourceReady(state.hostEvents[delivery.eventId].envelope.sourceId, state)),
		);
	}
	taskDisposition(taskId: string): ReturnType<typeof hostEventTaskDisposition> {
		return hostEventTaskDisposition(this.port.read(), taskId);
	}

	registerSource(value: HostEventSourceRegistration, lifetime: HostEventSourceLifetime): void {
		const registration = parseHostEventSourceRegistration(value);
		this.assertSourceClaim(registration.sourceId, lifetime);
		this.invalidateSource(registration.sourceId);
		this.port.transact((tx) => {
			this.assertSourceClaim(registration.sourceId, lifetime);
			if (isDeepStrictEqual(tx.snapshot.eventSources[registration.sourceId]?.registration, registration)) return;
			tx.commit({
				type: "host_source.registered",
				aggregateId: registration.sourceId,
				actor: "runtime",
				payload: toJsonObject({ registration }),
			});
		});
		const order = this.assertSourceClaim(registration.sourceId, lifetime);
		this.sourceOwners.set(registration.sourceId, { lifetime, order, active: true });
	}

	beginCatchUp(value: HostEventCatchUp, lifetime: HostEventSourceLifetime): void {
		const catchUp = parseHostEventCatchUp(value);
		this.assertSourceOwner(catchUp.sourceId, lifetime);
		this.invalidateSource(catchUp.sourceId);
		this.port.transact((tx) => {
			this.assertSourceOwner(catchUp.sourceId, lifetime);
			const source = tx.snapshot.eventSources[catchUp.sourceId];
			if (
				source?.catchUpGeneration === catchUp.generation &&
				source.registration.sourceEpoch === catchUp.sourceEpoch &&
				source.registration.scopeVersion === catchUp.scopeVersion
			)
				return;
			this.pruneWithin(tx);
			tx.commit({
				type: "host_source.catchup_started",
				aggregateId: catchUp.sourceId,
				actor: "runtime",
				payload: toJsonObject({ catchUp }),
			});
		});
	}

	accept(
		value: HostEventEnvelope,
		context: { consumerId: string; origin: WorkerReceiptOrigin; lifetime: HostEventSourceLifetime },
	): HostEventReceipt {
		const envelope = parseHostEventEnvelope(value);
		this.assertSourceOwner(envelope.sourceId, context.lifetime);
		return this.port.transact((tx) => {
			const prior = tx.snapshot.hostEvents[envelope.event.eventId];
			if (prior) {
				if (!isDeepStrictEqual(prior.envelope, envelope) || prior.receipt.consumerId !== context.consumerId)
					throw new HostEventError("identity_conflict", "Host event replay differs from canonical acceptance.");
				return prior.receipt;
			}
			const source = tx.snapshot.eventSources[envelope.sourceId];
			if (source && envelope.sourceSequence <= source.retiredThrough)
				throw new HostEventError("outside_replay_horizon", "Host event is outside the retained replay horizon.");
			assertWorkerReceiptAdmission(context.origin);
			this.pruneWithin(tx);
			tx.commit({
				type: "host_event.accepted",
				aggregateId: envelope.event.eventId,
				actor: "runtime",
				payload: toJsonObject({ envelope, consumerId: context.consumerId, origin: context.origin }),
			});
			return tx.snapshot.hostEvents[envelope.event.eventId].receipt;
		});
	}

	seal(
		value: HostEventCatchUpSeal,
		context: { consumerId: string; origin: WorkerReceiptOrigin; lifetime: HostEventSourceLifetime },
	): void {
		const seal = parseHostEventCatchUpSeal(value);
		this.assertSourceOwner(seal.sourceId, context.lifetime);
		this.port.transact((tx) => {
			const source = tx.snapshot.eventSources[seal.sourceId];
			if (isDeepStrictEqual(source?.seal, hostEventSealedFrontier(seal))) {
				for (const snapshot of seal.snapshots ?? []) {
					const pruned = source.prunedEvents?.find((tombstone) => tombstone.eventId === snapshot.event.eventId);
					if (
						!isDeepStrictEqual(tx.snapshot.hostEvents[snapshot.event.eventId]?.envelope, snapshot) &&
						!(pruned && hostEventTombstoneIsSnapshot(pruned, snapshot))
					)
						throw new HostEventError("identity_conflict", "Replayed snapshot differs from canonical custody.");
				}
				return;
			}
			assertWorkerReceiptAdmission(context.origin);
			tx.commit({
				type: "host_source.sealed",
				aggregateId: seal.sourceId,
				actor: "runtime",
				payload: toJsonObject({
					seal,
					consumerId: context.consumerId,
					origin: context.origin,
				}),
			});
		});
		this.assertSourceOwner(seal.sourceId, context.lifetime);
		const digest = hostEventSealDigest(this.port.read().eventSources[seal.sourceId]);
		if (!digest)
			throw new HostEventError("source_catching_up", "Host source seal did not establish a complete frontier.");
		if (this.readySources.get(seal.sourceId) !== digest) {
			this.readySources.set(seal.sourceId, digest);
			this.notifyReadiness();
		}
	}

	resumeGap(value: HostEventReplayGap, lifetime: HostEventSourceLifetime): void {
		const gap = parseHostEventReplayGap(value);
		this.assertSourceOwner(gap.sourceId, lifetime);
		this.invalidateSource(gap.sourceId);
		this.port.transact((tx) => {
			this.assertSourceOwner(gap.sourceId, lifetime);
			if (isDeepStrictEqual(tx.snapshot.eventSources[gap.sourceId]?.lastReplayGap, gap)) return;
			tx.commit({
				type: "host_source.replay_gap",
				aggregateId: gap.sourceId,
				actor: "runtime",
				payload: toJsonObject({ gap }),
			});
		});
	}

	retireThrough(value: HostEventReplayHorizon, lifetime: HostEventSourceLifetime): void {
		const horizon = parseHostEventReplayHorizon(value);
		this.assertSourceOwner(horizon.sourceId, lifetime);
		this.port.transact((tx) => {
			if (tx.snapshot.eventSources[horizon.sourceId]?.retiredThrough === horizon.throughSequence) return;
			tx.commit({
				type: "host_source.retired",
				aggregateId: horizon.sourceId,
				actor: "runtime",
				payload: toJsonObject({ horizon }),
			});
		});
	}

	replaceSubscriptions(
		taskId: string,
		expectedRevision: number,
		subscriptions: readonly HostEventSubscriptionInput[],
		workerScope?: HostEventWorkerScope,
	): void {
		hostEventString(taskId, "taskId");
		hostEventInteger(expectedRevision, "expectedRevision", 0);
		this.port.transact((tx) =>
			tx.commit({
				type: "task.subscriptions_replaced",
				aggregateId: taskId,
				actor: workerScope ? "worker" : "human",
				payload: toJsonObject({ taskId, expectedRevision, subscriptions, ...(workerScope ? { workerScope } : {}) }),
			}),
		);
	}

	bindDelivery(
		deliveryId: string,
		value: HostEventExecutionIdentity,
		contentDigest: string,
	): HostEventDeliveryBinding {
		const execution = parseHostEventExecutionIdentity(value);
		if (!execution) throw new HostEventError("invalid", "Host event execution identity is invalid.");
		hostEventDigest(contentDigest, "contentDigest");
		return this.port.transact((tx) => {
			const delivery = tx.snapshot.eventDeliveries[deliveryId];
			if (delivery?.target.kind !== "task") throw new HostEventError("invalid", "Host event has no task target.");
			this.assertDeliveryReady(tx.snapshot, delivery);
			const event = tx.snapshot.hostEvents[delivery.eventId];
			const source = tx.snapshot.eventSources[event.envelope.sourceId];
			const sourceSealDigest = hostEventSealDigest(source);
			if (!sourceSealDigest)
				throw new HostEventError("source_catching_up", "Host source has not sealed its current observations.");
			if (
				delivery.binding &&
				!delivery.bindingRetired &&
				isDeepStrictEqual(delivery.binding.execution, execution) &&
				delivery.binding.contentDigest === contentDigest
			) {
				// A re-seal of the same current event keeps the binding; its seal fields are provenance.
				assertHostEventExecution(tx.snapshot, delivery.binding, this.port.now());
				return delivery.binding;
			}
			const generation = delivery.generation + 1;
			const binding = createWorkerHostEventRecord({
				deliveryId,
				eventId: delivery.eventId,
				payloadDigest: event.envelope.event.payloadDigest,
				subscriptionId: delivery.target.subscriptionId,
				subscriptionRevision: delivery.target.subscriptionRevision,
				generation,
				sourceGeneration: source.catchUpGeneration,
				scopeVersion: source.registration.scopeVersion,
				sourceSealDigest,
				messageId: `host-event-${hostEventHash("pi-host-event-message-v1", [deliveryId, generation])}`,
				contentDigest,
				execution,
			});
			tx.commit({
				type: "host_event.delivery_bound",
				aggregateId: deliveryId,
				actor: "runtime",
				payload: toJsonObject({ binding }),
			});
			return binding;
		});
	}

	guardedDelivery<T>(
		value: HostEventDeliveryBinding,
		phase: "enqueue" | "consume" | "reconcile",
		operation: (transaction: HostEventDeliveryTransaction) => T,
	): T {
		const binding = parseHostEventDeliveryBinding(value);
		return this.port.transact((tx) => {
			const delivery = tx.snapshot.eventDeliveries[binding.deliveryId];
			if (!delivery || !isDeepStrictEqual(delivery.binding, binding))
				throw new HostEventError("stale_delivery", "Host event binding was replaced.");
			if (phase !== "reconcile") {
				this.assertDeliveryReady(tx.snapshot, delivery);
				assertHostEventExecution(tx.snapshot, binding, this.port.now());
			}
			const accepted = tx.snapshot.hostEvents[delivery.eventId];
			const attempt = tx.snapshot.attempts[binding.execution.attemptId];
			if (!accepted || attempt?.taskId !== binding.execution.taskId)
				throw new HostEventError("identity_conflict", "Host event historical execution is missing.");
			let active = true;
			const ensureActive = () => {
				if (!active) throw new HostEventError("expired_transaction", "Host event transaction capability expired.");
			};
			try {
				return operation({
					event: accepted,
					delivery,
					binding,
					acknowledgeMailbox: () => {
						ensureActive();
						if (phase !== "enqueue")
							throw new HostEventError("invalid", "Mailbox receipt is only valid at enqueue.");
						if (tx.snapshot.eventDeliveries[binding.deliveryId].mailboxAccepted) return;
						tx.commit({
							type: "host_event.mailbox_accepted",
							aggregateId: binding.deliveryId,
							actor: "runtime",
							payload: toJsonObject({ binding }),
						});
					},
					consume: (value) => {
						ensureActive();
						if (phase === "enqueue") throw new HostEventError("invalid", "Cannot consume while enqueueing.");
						const receipt = parseHostEventTranscriptReceipt(value);
						const prior = tx.snapshot.eventDeliveries[binding.deliveryId].transcriptReceipt;
						if (prior) {
							if (!isDeepStrictEqual(prior, receipt))
								throw new HostEventError("identity_conflict", "Host event consumption changed.");
							return;
						}
						tx.commit({
							type: "host_event.consumed",
							aggregateId: binding.deliveryId,
							actor: "runtime",
							payload: toJsonObject({ binding, receipt }),
						});
					},
					acknowledgeMailboxSettlement: () => {
						ensureActive();
						if (phase === "enqueue") throw new HostEventError("invalid", "Cannot settle while enqueueing.");
						if (tx.snapshot.eventDeliveries[binding.deliveryId].mailboxSettled) return;
						tx.commit({
							type: "host_event.mailbox_settled",
							aggregateId: binding.deliveryId,
							actor: "runtime",
							payload: toJsonObject({ binding }),
						});
					},
					retireUnconsumedBinding: () => {
						ensureActive();
						if (phase !== "reconcile")
							throw new HostEventError(
								"invalid",
								"Binding retirement requires physical transcript reconciliation.",
							);
						if (tx.snapshot.eventDeliveries[binding.deliveryId].bindingRetired) return;
						tx.commit({
							type: "host_event.binding_retired",
							aggregateId: binding.deliveryId,
							actor: "runtime",
							payload: toJsonObject({ binding }),
						});
					},
				});
			} finally {
				active = false;
			}
		});
	}

	guardedRootDelivery<T>(
		deliveryId: string,
		phase: "append" | "reconcile",
		operation: (transaction: HostEventRootTransaction) => T,
	): T {
		return this.port.transact((tx) => {
			const delivery = tx.snapshot.eventDeliveries[deliveryId];
			if (
				delivery?.target.kind !== "root" ||
				(phase === "append" && !hostEventDeliveryEligible(tx.snapshot, delivery))
			)
				throw new HostEventError("stale_delivery", "Root host-event delivery is not eligible.");
			if (phase === "append") this.assertDeliveryReady(tx.snapshot, delivery);
			let active = true;
			try {
				return operation({
					event: tx.snapshot.hostEvents[delivery.eventId],
					delivery,
					acknowledge: (parentReceiptId) => {
						if (!active) throw new HostEventError("expired_transaction", "Host event transaction expired.");
						hostEventString(parentReceiptId, "parentReceiptId");
						const current = tx.snapshot.eventDeliveries[deliveryId];
						if (current.parentReceiptId) {
							if (current.parentReceiptId !== parentReceiptId)
								throw new HostEventError("identity_conflict", "Root event receipt changed.");
							return;
						}
						tx.commit({
							type: "host_event.root_consumed",
							aggregateId: deliveryId,
							actor: "runtime",
							payload: toJsonObject({ deliveryId, parentReceiptId, historical: phase === "reconcile" }),
						});
					},
				});
			} finally {
				active = false;
			}
		});
	}

	/** Only callers already holding a physical parent receipt may reconcile its acceptance. */
	acknowledgeRoot(deliveryId: string, parentReceiptId: string): void {
		this.guardedRootDelivery(deliveryId, "reconcile", (tx) => tx.acknowledge(parentReceiptId));
	}

	settle(deliveryId: string, reason: string): void {
		this.port.transact((tx) => {
			const prior = tx.snapshot.eventDeliveries[deliveryId];
			if (prior?.status === "settled" && prior.reason === reason) return;
			tx.commit({
				type: "host_event.settled",
				aggregateId: deliveryId,
				actor: "runtime",
				payload: toJsonObject({ deliveryId, reason }),
			});
		});
	}

	prune(): number {
		return this.port.transact((tx) => this.pruneWithin(tx));
	}

	/**
	 * Reclaim settled history inside an admission, so reclamation never waits for a later seal. Under
	 * retention pressure the oldest settled events also give up their recall window.
	 */
	private pruneWithin(tx: HostEventRuntimeTransaction): number {
		const now = this.port.now();
		const settled = Object.values(tx.snapshot.hostEvents).sort(
			(left, right) => left.acceptedOrdinal - right.acceptedOrdinal,
		);
		let pressure = false;
		let eventIds = settled
			.filter((event) => hostEventCanPrune(tx.snapshot, event, now))
			.slice(0, 64)
			.map((event) => event.envelope.event.eventId);
		if (eventIds.length === 0 && hostEventRetentionPressure(tx.snapshot)) {
			pressure = true;
			eventIds = settled
				.filter((event) => hostEventCanPrune(tx.snapshot, event, now, true))
				.slice(0, 64)
				.map((event) => event.envelope.event.eventId);
		}
		if (eventIds.length)
			tx.commit({
				type: "host_event.pruned",
				aggregateId: "host-events",
				actor: "runtime",
				payload: toJsonObject({ eventIds, ...(pressure && eventIds.length ? { pressure: true } : {}) }),
			});
		return eventIds.length;
	}
}
