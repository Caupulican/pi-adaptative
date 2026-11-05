import type { WorkerReceiptOrigin } from "../orchestration/worker-receipt-origin.ts";
import type {
	HostEventDeliveryBinding,
	HostEventEnvelope,
	HostEventReceipt,
	HostEventReplayGap,
	HostEventSealedFrontier,
	HostEventSequenceRange,
	HostEventSourceRegistration,
	HostEventSubscriptionInput,
	HostEventTranscriptReceipt,
} from "./host-event-contract.ts";

export interface HostEventSourceState {
	readonly registration: HostEventSourceRegistration;
	readonly acceptedThrough: number;
	readonly retiredThrough: number;
	readonly catchUpGeneration: number;
	readonly replayFloor: number;
	readonly lastReplayGap?: HostEventReplayGap;
	readonly seal?: HostEventSealedFrontier;
	/**
	 * Positions below `replayFloor` this consumer never accepted: before `registration.startingSequence`
	 * and inside replay gaps, minus accepted snapshots. Every other retired position is its own history.
	 */
	readonly unaccepted: readonly HostEventSequenceRange[];
}

export interface HostEventSubscription extends HostEventSubscriptionInput {
	readonly subscriptionId: string;
	readonly taskId: string;
	readonly revision: number;
	readonly createdOrdinal: number;
	readonly revokedOrdinal?: number;
}

export interface AcceptedHostEvent {
	readonly envelope: HostEventEnvelope;
	readonly receipt: HostEventReceipt;
	readonly origin: WorkerReceiptOrigin;
	readonly acceptedOrdinal: number;
	readonly recallUntil: string;
	readonly deliveryIds: readonly string[];
}

export type HostEventDeliveryTarget =
	| {
			readonly kind: "task";
			readonly taskId: string;
			readonly subscriptionId: string;
			readonly subscriptionRevision: number;
	  }
	| { readonly kind: "root"; readonly scopeVersion: number };

export interface HostEventDelivery {
	readonly deliveryId: string;
	readonly eventId: string;
	readonly target: HostEventDeliveryTarget;
	readonly status: "reserved" | "pending" | "consumed" | "settled";
	readonly purpose: "failure" | "update" | "handback";
	readonly generation: number;
	readonly binding?: HostEventDeliveryBinding;
	/** Prior transcript was locked and proved to contain no consumption before rebind. */
	readonly bindingRetired?: true;
	readonly mailboxAccepted?: true;
	/** Exact physical mailbox write completed; canonical history may now release this generation. */
	readonly mailboxSettled?: true;
	readonly transcriptReceipt?: HostEventTranscriptReceipt;
	readonly parentReceiptId?: string;
	readonly reason?: string;
	readonly settledAt?: string;
}

export interface HostEventProjection {
	eventSources: Readonly<Record<string, HostEventSourceState>>;
	hostEvents: Readonly<Record<string, AcceptedHostEvent>>;
	threadSubscriptions: Readonly<Record<string, HostEventSubscription>>;
	eventDeliveries: Readonly<Record<string, HostEventDelivery>>;
}

export const HOST_EVENT_RECORD_FIELDS = [
	"eventSources",
	"hostEvents",
	"threadSubscriptions",
	"eventDeliveries",
] as const;

export function emptyHostEventProjection(): HostEventProjection {
	return { eventSources: {}, hostEvents: {}, threadSubscriptions: {}, eventDeliveries: {} };
}
