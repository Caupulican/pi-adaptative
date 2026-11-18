import type { AgentMessage } from "./types.ts";

const revisions = new WeakMap<readonly object[], { revision: number; appendLineage: object }>();
const contentRevisions = new WeakMap<object, number>();
let contentEpoch = 0;

/** Only arrays owned by Agent have a revision; arbitrary caller arrays must not be memoized. */
export function messageRevision(messages: readonly AgentMessage[]): number | undefined {
	return revisions.get(messages)?.revision;
}

/** A shared token certifies that the owner only appended since the previous observation. */
export function messageAppendLineage(items: readonly object[]): object | undefined {
	return revisions.get(items)?.appendLineage;
}

/** Publish an Agent-owned change. All mutations except a declared append end the prior lineage. */
export function advanceMessageRevision(messages: readonly AgentMessage[], change?: "append"): void {
	const previous = revisions.get(messages);
	if (previous && change === "append") previous.revision++;
	else revisions.set(messages, { revision: (previous?.revision ?? 0) + 1, appendLineage: {} });
}

/**
 * The process-wide epoch of the last published edit to one message, or zero. It moves only when that object is edited in place (a replacement or tool argument normalization),
 * never on append or removal, so a cache keyed by message identity compares it to know whether its reading is still the
 * object's content.
 */
export function messageContentRevision(message: object): number {
	return contentRevisions.get(message) ?? 0;
}

/**
 * The number of in-place content edits of live messages so far, process-wide. A fold that reads message content checks it
 * once per call and starts over when it has moved: any edit may have changed an element the fold already read, and the
 * identity of the element does not show that.
 */
export function messageContentEpoch(): number {
	return contentEpoch;
}

/** Publish an in-place content edit of one live message before any reader can observe the edited content. */
export function advanceMessageContentRevision(message: object): void {
	contentRevisions.set(message, ++contentEpoch);
}

const messageSources = new WeakMap<AgentMessage, AgentMessage>();

/** Preserve provenance when a projection rewrites a message without modifying the original. */
export function withMessageSource<T extends AgentMessage>(source: AgentMessage, projection: T): T {
	messageSources.set(projection, messageSourceOf(source));
	return projection;
}

export function messageSourceOf(message: AgentMessage): AgentMessage {
	return messageSources.get(message) ?? message;
}
