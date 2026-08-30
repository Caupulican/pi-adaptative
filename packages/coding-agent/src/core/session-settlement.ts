/**
 * Settlement predicates for the session coordinator: "is a backgrounded tool call still running"
 * and "has this run actually settled". Both are pure and live here rather than on AgentSession so
 * the reasoning that makes them correct sits next to the rule instead of inside the coordinator.
 */

/** The subset of a background tool-task record these predicates read. */
export interface BackgroundToolTaskStatusView {
	status: string;
}

export interface SessionSettlementState {
	isStreaming: boolean;
	isCompacting: boolean;
	pendingMessageCount: number;
}

/**
 * True while a backgrounded tool call is still awaiting its result.
 *
 * The foreground `prompt()` call can already have resolved by this point — a backgrounded tool
 * call runs independently of it — so the foreground busy flag alone does not see it, and neither
 * does submission-lease ownership: `sendCustomMessage()` self-acquires a fresh lease whenever
 * nothing else is busy, which trivially satisfies an ownership check. A `triggerTurn:false`
 * message must therefore be QUEUED, not spliced into state, whenever this is true: the
 * backgrounded tool's own completion delivery could still land after it chronologically but
 * before it positionally, putting the message between a tool call and its result.
 */
export function hasRunningBackgroundedToolCall(records: readonly BackgroundToolTaskStatusView[]): boolean {
	return records.some((record) => record.status === "running");
}

/**
 * Whether a session-level run has settled, gating the extension-only `agent_settled` event.
 *
 * Extension-only is deliberate: `agent_end` is the pinned terminal event on the public session
 * event channel, and emitting a second terminal-looking event there made every settled single-turn
 * prompt trail `agent_end` with one — which four pinned event-order tests correctly rejected.
 *
 * Streaming, compaction and pending-message state cover retry-pending, compaction-retry and
 * queued-follow-up: by the time this is consulted the routed turn has resolved every retry it will
 * run this cycle, so none of those can be true without one of these flags reflecting it.
 *
 * KNOWN GAP, documented rather than silently dropped: goal-auto-continue and research-lane
 * scheduling are debounced-idle timers, and the background lane controller exposes no query for
 * "did this just arm a continuation". Until it does, a timer armed moments earlier does not
 * suppress the emission.
 */
export function isSessionSettled(state: SessionSettlementState): boolean {
	return !state.isStreaming && !state.isCompacting && state.pendingMessageCount === 0;
}
