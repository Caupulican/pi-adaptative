import type { TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import {
	type CiAttemptTerminalEvent,
	type CiCurrentObservation,
	type CiSubject,
	ciSubjectKey,
	ciThreadKey,
	HostEventError,
	type HostEventReplayGap,
	type HostEventSubscriptionInput,
	type HostEventWorkerScope,
	hostEventInteger,
	hostEventString,
} from "./host-event-contract.ts";
import { hostEventIsCurrent, hostEventSealDigest } from "./host-event-reducer.ts";
import type { HostEventSourceState, HostEventSubscription } from "./host-event-state.ts";

export const MAX_HOST_EVENT_PAGE_BYTES = 12 * 1024;
export const MAX_HOST_EVENT_PAGE_ITEMS = 32;

export interface HostEventQuery {
	readonly view?: "sources" | "events" | "subscriptions";
	readonly taskId?: string;
	readonly eventId?: string;
	readonly cursor?: number;
	readonly maxItems?: number;
}

export interface HostEventSourceView {
	readonly kind: "source";
	readonly sourceId: string;
	readonly threadKey: string;
	readonly subject: CiSubject;
	readonly reconciled: boolean;
	readonly replayFloor: number;
	readonly lastReplayGap?: HostEventReplayGap;
	readonly current?: CiCurrentObservation;
	/** Set once a successor journal replaced this source: it never reconciles again. */
	readonly ended?: HostEventSourceState["ended"];
}

export interface HostEventEvidenceView {
	readonly kind: "event";
	readonly event: CiAttemptTerminalEvent;
	readonly sourceId: string;
	readonly sourceSequence: number;
	readonly acceptedOrdinal: number;
	readonly current: boolean;
	readonly canonicalReceiptId: string;
	readonly deliveryCount: number;
	readonly taskDelivery?: {
		readonly deliveryId: string;
		readonly status: string;
		readonly reason?: string;
		readonly entryId?: string;
	};
}

export interface HostEventSubscriptionView {
	readonly taskId: string;
	readonly revision: number;
	readonly subscriptions: readonly HostEventSubscription[];
}

export interface HostEventPage {
	readonly view: "sources" | "events" | "subscriptions";
	readonly revision: number;
	readonly subscriptionRevision?: number;
	readonly cursor: number;
	readonly nextCursor?: number;
	readonly total: number;
	readonly items: readonly (HostEventSourceView | HostEventEvidenceView | HostEventSubscription)[];
}

export interface HostEventSubscriptionChange {
	readonly taskId: string;
	readonly expectedRevision: number;
	readonly subscriptions: readonly HostEventSubscriptionInput[];
}

/** Caller identity is supplied by the tool host; it is never a model argument. */
export interface HostEventControlScope {
	readonly callerAgentId?: string;
	readonly execution?: Omit<HostEventWorkerScope, "agentId">;
}

export interface HostEventControlPort {
	readHostEvents(query: HostEventQuery, scope?: HostEventControlScope): HostEventPage;
	changeHostEventSubscriptions(
		input: HostEventSubscriptionChange,
		scope?: HostEventControlScope,
	): HostEventSubscriptionView;
}

export function hostEventSubscriptionView(state: TaskRuntimeProjection, taskId: string): HostEventSubscriptionView {
	hostEventString(taskId, "taskId");
	if (!state.tasks[taskId]) throw new HostEventError("unknown_task", "Event subscriptions require a known task.");
	const all = Object.values(state.threadSubscriptions).filter((subscription) => subscription.taskId === taskId);
	return {
		taskId,
		revision: all.reduce((revision, subscription) => Math.max(revision, subscription.revision), 0),
		subscriptions: all.filter((subscription) => subscription.revokedOrdinal === undefined),
	};
}

/** Selection is pure; the control owner resolves and validates any worker scope before calling. */
export function readHostEventPage(
	state: TaskRuntimeProjection,
	query: HostEventQuery,
	allowedTaskId?: string,
	isSourceReady: (sourceId: string) => boolean = () => false,
): HostEventPage {
	const view = query.view ?? "events";
	if (view !== "sources" && view !== "events" && view !== "subscriptions")
		throw new HostEventError("invalid", "Unknown host event view.");
	const cursor = hostEventInteger(query.cursor ?? 0, "cursor", 0);
	const maxItems = hostEventInteger(query.maxItems ?? 16, "maxItems");
	if (maxItems > MAX_HOST_EVENT_PAGE_ITEMS)
		throw new HostEventError("invalid", "Host event page size exceeds its bound.");
	const taskId = query.taskId ?? allowedTaskId;
	if (allowedTaskId && taskId !== allowedTaskId)
		throw new HostEventError("authority", "A worker may read only its current task's event subscriptions.");
	if (query.eventId !== undefined) {
		if (view !== "events") throw new HostEventError("invalid", "eventId applies only to the events view.");
		hostEventString(query.eventId, "eventId");
	}
	const subscriptions = taskId ? hostEventSubscriptionView(state, taskId).subscriptions : undefined;
	const visibleSubjects = subscriptions
		? new Set(subscriptions.map((subscription) => ciSubjectKey(subscription.subject)))
		: undefined;
	let items: HostEventPage["items"];
	if (view === "subscriptions") {
		if (!taskId) throw new HostEventError("invalid", "The subscriptions view requires taskId.");
		items = subscriptions ?? [];
	} else if (view === "sources") {
		items = Object.values(state.eventSources).flatMap((source) =>
			source.registration.subjects
				.filter((subject) => !visibleSubjects || visibleSubjects.has(ciSubjectKey(subject)))
				.map(
					(subject): HostEventSourceView => ({
						kind: "source",
						sourceId: source.registration.sourceId,
						threadKey: ciThreadKey(subject),
						subject,
						replayFloor: source.replayFloor,
						...(source.lastReplayGap ? { lastReplayGap: source.lastReplayGap } : {}),
						...(source.ended ? { ended: source.ended } : {}),
						reconciled: isSourceReady(source.registration.sourceId) && hostEventSealDigest(source) !== undefined,
						current: source.seal?.observations.find(
							(observation) => ciSubjectKey(observation.subject) === ciSubjectKey(subject),
						),
					}),
				),
		);
	} else {
		items = Object.values(state.hostEvents)
			.filter(
				(accepted) =>
					(query.eventId === undefined || accepted.envelope.event.eventId === query.eventId) &&
					(taskId === undefined ||
						accepted.deliveryIds.some((id) => {
							const target = state.eventDeliveries[id]?.target;
							return target?.kind === "task" && target.taskId === taskId;
						})),
			)
			.sort((left, right) => left.acceptedOrdinal - right.acceptedOrdinal)
			.map((accepted): HostEventEvidenceView => {
				const delivery = taskId
					? accepted.deliveryIds
							.map((id) => state.eventDeliveries[id])
							.find((candidate) => candidate.target.kind === "task" && candidate.target.taskId === taskId)
					: undefined;
				return {
					kind: "event",
					event: accepted.envelope.event,
					sourceId: accepted.envelope.sourceId,
					sourceSequence: accepted.envelope.sourceSequence,
					acceptedOrdinal: accepted.acceptedOrdinal,
					current: isSourceReady(accepted.envelope.sourceId) && hostEventIsCurrent(state, accepted),
					canonicalReceiptId: accepted.receipt.canonicalReceiptId,
					deliveryCount: accepted.deliveryIds.length,
					...(delivery
						? {
								taskDelivery: {
									deliveryId: delivery.deliveryId,
									status: delivery.status,
									...(delivery.reason ? { reason: delivery.reason } : {}),
									...(delivery.transcriptReceipt ? { entryId: delivery.transcriptReceipt.entryId } : {}),
								},
							}
						: {}),
				};
			});
	}
	if (cursor > items.length) throw new HostEventError("stale_cursor", "Host event page changed; restart at cursor 0.");
	const selected: HostEventPage["items"][number][] = [];
	let page: HostEventPage = {
		view,
		revision: state.lastOrdinal,
		...(taskId ? { subscriptionRevision: hostEventSubscriptionView(state, taskId).revision } : {}),
		cursor,
		total: items.length,
		items: selected,
	};
	for (const item of items.slice(cursor, cursor + maxItems)) {
		const nextCursor = cursor + selected.length + 1;
		const candidate = { ...page, items: [...selected, item], ...(nextCursor < items.length ? { nextCursor } : {}) };
		if (Buffer.byteLength(JSON.stringify(candidate)) > MAX_HOST_EVENT_PAGE_BYTES) break;
		selected.push(item);
	}
	if (!selected.length && cursor < items.length)
		throw new HostEventError("oversized", "A host event exceeds the bounded recall projection.");
	const nextCursor = cursor + selected.length;
	page = { ...page, ...(nextCursor < items.length ? { nextCursor } : {}) };
	return page;
}
