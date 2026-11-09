import type { AgentMessage } from "./types.ts";

const revisions = new WeakMap<readonly AgentMessage[], number>();
const contentRevisions = new WeakMap<object, number>();
let contentEpoch = 0;

/** Only arrays owned by Agent have a revision; arbitrary caller arrays must not be memoized. */
export function messageRevision(messages: readonly AgentMessage[]): number | undefined {
	return revisions.get(messages);
}

/** Publish an Agent-owned message change before readers can observe it. */
export function advanceMessageRevision(messages: readonly AgentMessage[]): void {
	revisions.set(messages, (revisions.get(messages) ?? 0) + 1);
}

/**
 * The content revision of one message object. It moves only when that object is edited in place (`replaceMessageContents`),
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
	contentRevisions.set(message, (contentRevisions.get(message) ?? 0) + 1);
	contentEpoch++;
}
