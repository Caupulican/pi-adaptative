import type { HarnessNoticeKind, HarnessNoticeObservation } from "../harness-notice.ts";
import type { DurableTaskRuntime } from "../orchestration/task-runtime.ts";
import type { WorkerReceiptOrigin } from "../orchestration/worker-receipt-origin.ts";
import type { ParentInputDelivery, ParentInputDeliveryOptions, ParentInputReceipt } from "../parent-input-delivery.ts";
import type { ParentWakeDelivery } from "../proactivity/proactivity-controller.ts";
import { runtimeGenerationAdmission } from "../runtime-generation-admission.ts";
import { boundedRedactedDiagnosticText } from "../security/secret-text.ts";
import {
	HostEventError,
	type HostEventReplayGap,
	type HostEventSink,
	hostEventHash,
	hostEventString,
} from "./host-event-contract.ts";
import { hostEventParentInput } from "./host-event-delivery.ts";
import type { HostEventSourceLifetime } from "./host-event-runtime.ts";
import type { HostEventDelivery } from "./host-event-state.ts";

export interface HostEventSessionControllerDeps {
	readonly runtime: DurableTaskRuntime;
	readonly agentDir: string;
	readonly sessionId: string;
	readonly signal: AbortSignal;
	assertCurrent(): void;
	captureOrigin(): WorkerReceiptOrigin;
	canDeliver(): boolean;
	subscribeContext(listener: () => void): () => void;
	subscribeSettings(listener: () => void): () => void;
	/**
	 * How a root delivery reaches the parent: a delivery already saved keeps its saved mode; a new one wakes a parent
	 * turn within the rolling-day wake bound and is otherwise carried with the owner's next turn.
	 */
	admitRootDelivery(deliveryId: string): Promise<ParentWakeDelivery>;
	/** Records how a root delivery was accepted, for `/proactivity status`. */
	rootDelivered(delivery: ParentWakeDelivery): void;
	deliverParent(input: ParentInputDelivery, options: ParentInputDeliveryOptions): Promise<ParentInputReceipt>;
	/**
	 * `dormant` keeps the delivery pending until a state, readiness or control change re-drives it;
	 * `unavailable` means the running execution can never hold the event and hands it back.
	 */
	deliverTask(delivery: HostEventDelivery, signal: AbortSignal): Promise<"queued" | "dormant" | "unavailable">;
	/** Reconcile the original transcript and settle its physical mailbox before handback. */
	reconcileTask(delivery: HostEventDelivery): void;
	/** The session's owner notices: history this session never observed is told once, with the owner's next turn. */
	observeNotice(kind: HarnessNoticeKind, read: () => HarnessNoticeObservation | undefined): void;
	warn(message: string): void;
}

const GAP_CAUSES: Readonly<Record<HostEventReplayGap["reason"], string>> = {
	consumer_expired: "this session's event custody expired after it stayed closed for 7 days",
	consumer_evicted: "this session's event custody was removed while it was closed to make room for live sessions",
	consumer_inactive: "this session's saved event position is older than the source's retained history",
};

function replayGapNotice(gap: HostEventReplayGap): HarnessNoticeObservation {
	const count = gap.throughSequence - gap.afterSequence;
	return {
		scope: `gap:${gap.sourceId}`,
		state: {
			reason: `${gap.reason}:${gap.afterSequence}-${gap.throughSequence}`,
			text: `Up to ${count} CI ${count === 1 ? "result was" : "results were"} never delivered to this session: ${GAP_CAUSES[gap.reason]}. Check CI directly for results from that period.`,
		},
	};
}

/** One serialized, level-triggered drain: a request during a pass schedules exactly one more pass. */
class DeliveryLane {
	private readonly run: () => Promise<void>;
	private readonly isActive: () => boolean;
	private readonly fail: (error: unknown) => void;
	private pending: Promise<void> | undefined;
	private requested = false;

	constructor(run: () => Promise<void>, isActive: () => boolean, fail: (error: unknown) => void) {
		this.run = run;
		this.isActive = isActive;
		this.fail = fail;
	}

	request(): void {
		if (!this.isActive()) return;
		this.requested = true;
		if (this.pending) return;
		this.pending = Promise.resolve()
			.then(async () => {
				while (this.requested && this.isActive()) {
					this.requested = false;
					await this.run();
				}
			})
			.catch(this.fail)
			.finally(() => {
				this.pending = undefined;
				if (this.requested) this.request();
			});
	}

	async settled(): Promise<void> {
		await this.pending;
	}
}

/** Joins host custody to canonical task delivery. No timer, provider I/O or second accepted-event store. */
export class HostEventSessionController {
	readonly sink: HostEventSink;
	private readonly deps: HostEventSessionControllerDeps;
	private readonly abort = new AbortController();
	private readonly signal: AbortSignal;
	private readonly unsubscribe: (() => void)[] = [];
	private readonly warned = new Map<string, string>();
	private readonly taskLane = new DeliveryLane(
		() => this.drainTasks(),
		() => this.active(),
		(error) => this.report("session", error),
	);
	private readonly rootLane = new DeliveryLane(
		() => this.drainRoot(),
		() => this.active(),
		(error) => this.report("session", error),
	);
	private closed = false;
	private readonly sourceLifetime: HostEventSourceLifetime;

	constructor(deps: HostEventSessionControllerDeps) {
		this.deps = deps;
		this.signal = AbortSignal.any([deps.signal, this.abort.signal]);
		this.signal.throwIfAborted();
		const events = deps.runtime.hostEvents;
		this.sourceLifetime = events.openSourceLifetime();
		const lifetime = this.sourceLifetime;
		this.signal.addEventListener("abort", () => events.closeSourceLifetime(lifetime), { once: true });
		const consumerId = `session-${hostEventHash("pi-host-event-consumer-v1", [deps.agentDir, deps.sessionId])}`;
		this.sink = {
			consumerId,
			checkpoint: async (sourceId, signal) =>
				this.mutate(signal, () => {
					hostEventString(sourceId, "sourceId");
					const sources = deps.runtime.getSnapshot().eventSources;
					const source = Object.hasOwn(sources, sourceId) ? sources[sourceId] : undefined;
					return source
						? {
								registration: structuredClone(source.registration),
								acceptedThrough: source.acceptedThrough,
								catchUpGeneration: source.catchUpGeneration,
								replayFloor: source.replayFloor,
								...(source.lastReplayGap ? { lastReplayGap: structuredClone(source.lastReplayGap) } : {}),
							}
						: undefined;
				}),
			register: async (source, signal) => this.mutate(signal, () => events.registerSource(source, lifetime)),
			beginCatchUp: async (input, signal) => this.mutate(signal, () => events.beginCatchUp(input, lifetime)),
			resumeGap: async (gap, signal) => {
				this.mutate(signal, () => events.resumeGap(gap, lifetime));
				this.observeSources();
			},
			accept: async (envelope, signal) =>
				this.mutate(signal, () => events.accept(envelope, { consumerId, origin: deps.captureOrigin(), lifetime })),
			seal: async (seal, signal) =>
				this.mutate(signal, () => events.seal(seal, { consumerId, origin: deps.captureOrigin(), lifetime })),
			retireThrough: async (horizon, signal) =>
				this.mutate(signal, () => {
					events.retireThrough(horizon, lifetime);
					events.prune();
				}),
			deactivate: async (sourceId) => events.deactivateSource(sourceId, lifetime),
			subscribeWritable: (listener) => {
				const notify = () => {
					if (!this.signal.aborted && !this.closed) listener();
				};
				const off = [
					events.subscribe(notify),
					deps.subscribeContext(notify),
					runtimeGenerationAdmission(deps.agentDir).subscribeAvailability(notify),
				];
				return () => {
					for (const unsubscribe of off) unsubscribe();
				};
			},
		};
		this.unsubscribe.push(
			events.subscribe(() => this.schedule()),
			deps.subscribeContext(() => this.schedule()),
			deps.subscribeSettings(() => this.schedule()),
			runtimeGenerationAdmission(deps.agentDir).subscribeAvailability(() => this.schedule()),
		);
		// A gap committed before a crash is told at the next open; a told gap finds its saved notice.
		this.observeSources();
		this.schedule();
	}

	private observeSources(): void {
		for (const source of Object.values(this.deps.runtime.getSnapshot().eventSources)) {
			const gap = source.lastReplayGap;
			if (gap) this.deps.observeNotice("host-event-gap", () => replayGapNotice(gap));
		}
	}

	private active(): boolean {
		return !this.closed && !this.signal.aborted;
	}

	private assertCurrent(): void {
		this.signal.throwIfAborted();
		if (this.closed) throw new HostEventError("closed", "Host event session closed.");
		this.deps.assertCurrent();
	}

	private mutate<T>(signal: AbortSignal, operation: () => T): T {
		this.assertCurrent();
		signal.throwIfAborted();
		const lease = runtimeGenerationAdmission(this.deps.agentDir).tryAdmitWork({
			kind: "host-event",
			label: "host event custody",
		});
		if (!lease) throw new HostEventError("runtime_replacing", "Host event waits for runtime replacement.");
		try {
			lease.assertCurrent();
			return operation();
		} finally {
			lease.release();
		}
	}

	/** Task and root deliveries are independent serialized lanes, both level-triggered by the same notifications. */
	private schedule(): void {
		if (this.closed || this.signal.aborted) return;
		this.taskLane.request();
		this.rootLane.request();
	}

	/** Task delivery is synchronous host work, so it runs under one runtime work lease. */
	private async drainTasks(): Promise<void> {
		this.assertCurrent();
		if (!this.deps.canDeliver()) return;
		const lease = runtimeGenerationAdmission(this.deps.agentDir).tryAdmitWork({
			kind: "host-event",
			label: "host event delivery",
		});
		if (!lease) return;
		try {
			const events = this.deps.runtime.hostEvents;
			for (const delivery of events.pendingDeliveries()) {
				if (delivery.target.kind !== "task") continue;
				this.assertCurrent();
				lease.assertCurrent();
				if (!this.deps.canDeliver()) return;
				try {
					const subscription = this.deps.runtime.getSnapshot().threadSubscriptions[delivery.target.subscriptionId];
					if (
						!subscription ||
						subscription.revokedOrdinal !== undefined ||
						subscription.revision !== delivery.target.subscriptionRevision
					) {
						this.settleTask(delivery.deliveryId, "unsubscribed");
					} else if (events.taskDisposition(delivery.target.taskId) === "closed") {
						this.settleTask(delivery.deliveryId, "task_closed");
					} else if (events.eligible(delivery.deliveryId)) {
						const outcome = await this.deps.deliverTask(delivery, this.signal);
						this.assertCurrent();
						if (outcome === "unavailable") this.settleTask(delivery.deliveryId, "handed_back");
					}
					this.warned.delete(delivery.deliveryId);
				} catch (error) {
					this.report(delivery.deliveryId, error);
				}
			}
		} finally {
			lease.release();
		}
	}

	/**
	 * Root delivery waits for the foreground, so it holds no runtime work lease while waiting: the
	 * parent-input path admits its own reader when it takes ownership. Runtime replacement and task
	 * delivery never queue behind a parent turn.
	 */
	private async drainRoot(): Promise<void> {
		this.assertCurrent();
		const events = this.deps.runtime.hostEvents;
		for (const delivery of events.pendingDeliveries()) {
			if (delivery.target.kind !== "root") continue;
			this.assertCurrent();
			if (!this.deps.canDeliver()) return;
			// A replacing runtime re-drives this lane through its availability notification.
			const probe = runtimeGenerationAdmission(this.deps.agentDir).tryAdmitWork({
				kind: "host-event",
				label: "host event parent delivery",
			});
			if (!probe) return;
			probe.release();
			try {
				if (events.eligible(delivery.deliveryId)) await this.deliverRoot(delivery);
				this.warned.delete(delivery.deliveryId);
			} catch (error) {
				this.report(delivery.deliveryId, error);
			}
		}
	}

	private settleTask(deliveryId: string, reason: "unsubscribed" | "task_closed" | "handed_back"): void {
		const events = this.deps.runtime.hostEvents;
		const current = events.getDelivery(deliveryId);
		if (current?.status !== "pending") return;
		if (current.binding && !current.mailboxSettled) this.deps.reconcileTask(current);
		// A crash may have left a real transcript append without its canonical receipt.
		// Physical reconciliation must resolve that before we mint a parent handback.
		if (events.getDelivery(deliveryId)?.status === "pending") events.settle(deliveryId, reason);
	}

	private async deliverRoot(delivery: HostEventDelivery): Promise<void> {
		const events = this.deps.runtime.hostEvents;
		const accepted = events.getEvent(delivery.eventId);
		if (!accepted) throw new HostEventError("missing", "Host event evidence is missing.");
		// Past the wake bound the event is carried with the owner's next turn: never dropped, never a wake.
		const admission = await this.deps.admitRootDelivery(delivery.deliveryId);
		this.assertCurrent();
		// The foreground submission's own runtime reader is asserted before this append.
		const receipt = await this.deps.deliverParent(hostEventParentInput(accepted, delivery, admission.mode), {
			signal: this.signal,
			withAppend: (append) =>
				events.guardedRootDelivery(delivery.deliveryId, "append", (transaction) => {
					this.assertCurrent();
					if (!this.deps.canDeliver())
						throw new HostEventError("disabled", "Proactive event delivery is disabled.");
					const receipt = append();
					if (receipt.durability !== "persisted" || receipt.entries.length !== 1)
						throw new HostEventError("unpersisted", "Host event parent receipt is not durable.");
					transaction.acknowledge(receipt.entries[0]!.id);
					return receipt;
				}),
		});
		// Replay already validated exact parent-input metadata under its transcript lock.
		events.acknowledgeRoot(delivery.deliveryId, receipt.entryId);
		this.deps.rootDelivered(admission);
	}

	private report(key: string, error: unknown): void {
		if (this.signal.aborted) return;
		const message =
			boundedRedactedDiagnosticText(error instanceof Error ? error.message : String(error)) ?? "unknown failure";
		if (this.warned.get(key) === message) return;
		this.warned.set(key, message);
		this.deps.warn(`Host event remains pending: ${message}`);
	}

	async close(): Promise<void> {
		this.closed = true;
		this.abort.abort(new Error("Host event session closed."));
		this.deps.runtime.hostEvents.closeSourceLifetime(this.sourceLifetime);
		for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
		await Promise.all([this.taskLane.settled(), this.rootLane.settled()]);
		this.warned.clear();
	}
}
