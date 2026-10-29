import type { AgentMessage } from "./types.ts";

const revisions = new WeakMap<readonly AgentMessage[], number>();

/** Only arrays owned by Agent have a revision; arbitrary caller arrays must not be memoized. */
export function messageRevision(messages: readonly AgentMessage[]): number | undefined {
	return revisions.get(messages);
}

/** Publish an Agent-owned message change before readers can observe it. */
export function advanceMessageRevision(messages: readonly AgentMessage[]): void {
	revisions.set(messages, (revisions.get(messages) ?? 0) + 1);
}
