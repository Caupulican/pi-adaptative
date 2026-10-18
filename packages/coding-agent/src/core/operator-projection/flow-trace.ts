/**
 * The flow trace: what actually happened in the session, as a bounded list of actor actions ordered
 * by when they began (ties keep their recording order; an action recorded late with an earlier start,
 * such as a settled judgment or a restored worker lane, lands where it began). It is recorded from the sources that do the work (the session's event stream,
 * settled System One evaluations, questions to the owner, worker lane records), never inferred from
 * phases afterwards, so a view drawn from it shows what is going on and nothing else.
 *
 * Every session event type is either mapped or ignored with its reason in one exhaustive table: a
 * new event type does not compile until someone decides where it belongs in the flow.
 */

import type { AgentMessage } from "../../kernel/index.ts";
import type { AgentSessionEvent } from "../agent-session-contracts.ts";
import type { LaneRecord, LaneStatus } from "../autonomy/lane-tracker.ts";
import type { HumanInputActivity } from "../human-input-activity.ts";
import { evaluationResultText, type SemanticEvaluationRecord } from "../system-one/semantic-evaluation-ledger.ts";
import type { WaitEndKind } from "../util/wait.ts";

/** Who acts. Each actor is one lane of the flow; every worker shares the workers lane, named per event. */
export type FlowActor = "owner" | "system_one" | "root" | "worker";

/** What an action is. Closed: a view renders every kind, and a new kind fails its exhaustive table. */
export type FlowKind =
	| "prompt"
	| "turn"
	| "reply"
	| "tool"
	| "background"
	| "route"
	| "judgment"
	| "delegate"
	| "worker"
	| "report"
	| "question"
	| "answer"
	| "notice"
	| "compaction"
	| "retry"
	| "wait";

/** `attention`: finished, but its result needs the parent's review (a partial or blocked worker). */
export type FlowOutcome = "ok" | "failed" | "cancelled" | "attention";

export interface FlowEvent {
	readonly id: string;
	readonly actor: FlowActor;
	readonly kind: FlowKind;
	readonly label: string;
	/** The actor the action is addressed to, when it hands something over. */
	readonly to?: FlowActor;
	/** The worker's display name, for actions that belong to a worker lane. Presentation only. */
	readonly lane?: string;
	/**
	 * The identity of the worker lane: its untruncated, unmodified name. Set together with `lane` on
	 * every delegation, wait, worker and report event; views group actions by this key, never by the
	 * display text.
	 */
	readonly laneKey?: string;
	/**
	 * What the action reached, kept apart from its label: the verdict of a settled judgment, the
	 * terminal status of a worker report.
	 */
	readonly result?: string;
	readonly startedAt: number;
	/** Absent while the action is running. An instant action ends when it starts. */
	readonly endedAt?: number;
	readonly outcome?: FlowOutcome;
	/** Short handle of the ledger row behind the action (`#a1b2`), so a view can ground the edge in its evidence. */
	readonly evidence?: string;
}

/** The oldest finished actions (by start) are dropped past this; running ones are always kept. */
export const MAX_FLOW_EVENTS = 400;
const LABEL_LIMIT = 80;

function short(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= LABEL_LIMIT ? flat : `${flat.slice(0, LABEL_LIMIT - 1)}…`;
}

function messageText(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join(" ");
}

function hasToolCall(message: AgentMessage): boolean {
	const content = (message as { content?: unknown }).content;
	return Array.isArray(content) && content.some((block) => block?.type === "toolCall");
}

function stopOutcome(message: AgentMessage | undefined): FlowOutcome {
	const stop = (message as { stopReason?: unknown } | undefined)?.stopReason;
	return stop === "aborted" ? "cancelled" : stop === "error" ? "failed" : "ok";
}

/**
 * How a wait ended, as a flow outcome. A steer or an expired bound is a deliberate end of the wait, not of the work it
 * waited for, so it reads as `attention`; an abort or a disposed owner cancels it, and only a lost target fails it.
 */
const WAIT_END_OUTCOME: Readonly<Record<WaitEndKind, FlowOutcome>> = {
	satisfied: "ok",
	steered: "attention",
	timed_out: "attention",
	aborted: "cancelled",
	disposed: "cancelled",
	unavailable: "failed",
};

/** Every lane state: still open, or how it ended. Exhaustive, so a new lane state must be placed. */
const LANE_OUTCOME: Readonly<Record<LaneStatus, FlowOutcome | "open">> = {
	queued: "open",
	running: "open",
	succeeded: "ok",
	partial: "attention",
	blocked: "attention",
	failed: "failed",
	timeout: "failed",
	budget_exhausted: "failed",
	canceled: "cancelled",
};

type EventHandlers = {
	[K in AgentSessionEvent["type"]]: (event: Extract<AgentSessionEvent, { type: K }>) => void;
};

/**
 * Records the flow of one session's work.
 *
 * History rule: the trace shows what happens while it is bound, never what a resumed session did before.
 * `reset()` (which a bind performs) stamps `since`; a terminal worker lane first seen after that, or a
 * settled System One evaluation, whose end lies before `since` is history and is ignored. Live work that
 * began earlier but ends after `since` is flow and is kept.
 *
 * Identity rule: one evaluation is one judgment, however often its settlement is announced (the verdict
 * note announces it again); a repeat updates the existing event in place.
 *
 * Outcome rule: an action carries an outcome only when its source reports one. A background task leaving
 * the live list reports that it ended, not how, so its event ends without an outcome.
 */
export class FlowTrace {
	private readonly events: FlowEvent[] = [];
	private readonly open = new Map<string, number>();
	/** Event id of the judgment recorded for each evaluation id. */
	private readonly judgments = new Map<string, string>();
	private readonly laneStatus = new Map<string, LaneStatus>();
	private readonly backgroundOpen = new Set<string>();
	private readonly now: () => number;
	private since: number;
	private sequence = 0;

	constructor(options: { now?: () => number } = {}) {
		this.now = options.now ?? Date.now;
		this.since = this.now();
	}

	/** Every recorded action, ordered by start (oldest first). A live array: callers must not mutate it. */
	snapshot(): readonly FlowEvent[] {
		return this.events;
	}

	/** Forget everything: a new or resumed session has its own flow. */
	reset(): void {
		this.events.length = 0;
		this.open.clear();
		this.laneStatus.clear();
		this.backgroundOpen.clear();
		this.judgments.clear();
		this.since = this.now();
	}

	private readonly handlers: EventHandlers = {
		message_start: (event) => {
			if (event.message.role !== "user") return;
			const text = messageText(event.message);
			if (text) this.instant({ actor: "owner", kind: "prompt", label: short(text), to: "root" });
		},
		message_end: (event) => {
			if (event.message.role !== "assistant" || hasToolCall(event.message)) return;
			const text = messageText(event.message);
			if (text) this.instant({ actor: "root", kind: "reply", label: short(text), to: "owner" });
		},
		// The agent run is the turn; its provider rounds are not separate actions in the flow.
		agent_start: () => this.begin("turn", { actor: "root", kind: "turn", label: "turn" }),
		agent_end: (event) => this.finish("turn", stopOutcome(event.messages.at(-1))),
		turn_start: () => {},
		turn_end: () => {},
		// Streaming deltas change text, not the flow.
		message_update: () => {},
		tool_execution_start: (event) =>
			this.begin(`tool:${event.toolCallId}`, { actor: "root", kind: "tool", label: event.toolName }),
		tool_execution_update: () => {},
		tool_execution_end: (event) => this.finish(`tool:${event.toolCallId}`, event.isError ? "failed" : "ok"),
		background_tools: (event) => {
			const live = new Set(event.tasks.map((task) => task.taskId));
			for (const task of event.tasks) {
				if (this.backgroundOpen.has(task.taskId)) continue;
				this.backgroundOpen.add(task.taskId);
				this.begin(`background:${task.taskId}`, {
					actor: "root",
					kind: "background",
					label: `${task.toolName} ${task.description}`.trim(),
				});
			}
			for (const taskId of [...this.backgroundOpen]) {
				if (live.has(taskId)) continue;
				this.backgroundOpen.delete(taskId);
				this.finish(`background:${taskId}`, "ok");
			}
		},
		routing_start: () => this.begin("route", { actor: "root", kind: "route", label: "route the turn" }),
		routing_end: () => this.finish("route", "ok"),
		warning: (event) => this.instant({ actor: "root", kind: "notice", label: short(event.message), to: "owner" }),
		compaction_start: (event) =>
			this.begin("compaction", { actor: "root", kind: "compaction", label: `compact (${event.reason})` }),
		compaction_end: (event) =>
			this.finish("compaction", event.aborted ? "cancelled" : event.errorMessage ? "failed" : "ok"),
		session_compact_failed: (event) => this.finish("compaction", event.aborted ? "cancelled" : "failed"),
		auto_retry_start: (event) =>
			this.begin("retry", {
				actor: "root",
				kind: "retry",
				label: `retry ${event.attempt}/${event.maxAttempts}: ${short(event.errorMessage)}`,
			}),
		auto_retry_end: (event) => this.finish("retry", event.success ? "ok" : "failed"),
		provider_admission_wait: (event) => {
			if (event.phase === "start")
				this.begin("wait", { actor: "root", kind: "wait", label: `waiting on ${event.provider}: ${event.reason}` });
			else this.finish("wait", WAIT_END_OUTCOME[event.end?.kind ?? "satisfied"]);
		},
		continuous_chat_prefix_wait: (event) => {
			if (event.phase === "start")
				this.begin("memory-wait", { actor: "root", kind: "wait", label: "wait for memory summaries" });
			else if (event.phase === "end") this.finish("memory-wait", WAIT_END_OUTCOME[event.end?.kind ?? "satisfied"]);
		},
		// A deadline wait is a span. A watchdog wait (the foreground's own admission and idle waits) is routine and
		// short; only its overdue report, naming the holder, reaches the trace.
		wait: (event) => {
			const key = `wait:${event.id}#${event.seq}`;
			if (event.phase === "overdue") {
				const overdueS = Math.round(event.elapsedMs / 1000);
				const label = short(`wait ${event.id} overdue after ${overdueS}s: ${event.holder ?? ""}`);
				this.instant({ actor: "root", kind: "notice", label, to: "owner" });
			} else if (event.bound.kind === "watchdog") {
				return;
			} else if (event.phase === "start") {
				this.begin(key, { actor: "root", kind: "wait", label: short(`wait ${event.id}`) });
			} else if (event.phase === "end") {
				this.finish(key, WAIT_END_OUTCOME[event.end?.kind ?? "satisfied"]);
			}
		},
		// Worker lanes are read from their records (observeLanes); this summary carries no dispatches.
		delegate_workers: () => {},
		// Session state, not actions. A withdrawn echo's input is held, and that hold is the warning the trace records.
		queue_update: () => {},
		user_message_withdrawn: () => {},
		session_info_changed: () => {},
		thinking_level_changed: () => {},
	};

	observe(event: AgentSessionEvent): void {
		(this.handlers[event.type] as (event: AgentSessionEvent) => void)(event);
	}

	/**
	 * A settled System One evaluation: a judgment handed to the root, with its own timing. An evaluation
	 * that ended before this trace was reset is history and is ignored; a repeat for an evaluation already
	 * recorded replaces that judgment's timing, outcome and result in place.
	 */
	observeEvaluation(record: SemanticEvaluationRecord): void {
		if (record.endedAt < this.since) return;
		const result = evaluationResultText(record);
		const judgment: Omit<FlowEvent, "id"> = {
			actor: "system_one",
			kind: "judgment",
			label: short(record.label),
			...(result ? { result: short(result) } : {}),
			to: "root",
			startedAt: record.startedAt,
			endedAt: record.endedAt,
			outcome: record.outcome,
			evidence: `#${record.evaluationId.slice(0, 4)}`,
		};
		const known = this.judgments.get(record.evaluationId);
		const index = known === undefined ? -1 : this.events.findIndex((event) => event.id === known);
		if (known !== undefined && index !== -1) {
			this.events[index] = { ...judgment, id: known };
			return;
		}
		const id = `${this.push(judgment)}`;
		// A judgment older than every kept action can be bounded away by its own push; remember only a kept one.
		if (this.events.some((event) => event.id === id)) this.judgments.set(record.evaluationId, id);
	}

	/** A question to the owner opens; its settlement closes it and hands the answer back. */
	observeQuestion(activity: HumanInputActivity): void {
		const key = `question:${activity.request.requestId}`;
		if (activity.phase === "waiting") {
			if (this.open.has(key)) return;
			const text = activity.request.questions[0]?.question ?? "question";
			this.begin(key, { actor: "root", kind: "question", label: short(text), to: "owner" });
			return;
		}
		if (!this.open.has(key)) return;
		this.finish(key, "ok");
		this.instant({ actor: "owner", kind: "answer", label: "answered", to: "root" });
	}

	/** Worker lanes as their records stand: a new lane is a delegation, a terminal one a report back. */
	observeLanes(records: readonly LaneRecord[]): void {
		for (const record of records) {
			const previous = this.laneStatus.get(record.laneId);
			if (previous === record.status) continue;
			this.laneStatus.set(record.laneId, record.status);
			const lane = record.label ?? record.laneId;
			const laneFields = { lane: short(lane), laneKey: lane };
			const key = `worker:${record.laneId}`;
			const queueKey = `queue:${record.laneId}`;
			const outcome = LANE_OUTCOME[record.status];
			const timeOf = (value: string | undefined) => Date.parse(value ?? "") || this.now();
			const delegate = (delegatedAt: number) =>
				this.push({
					actor: "root",
					kind: "delegate",
					label: short(lane),
					...laneFields,
					to: "worker",
					startedAt: delegatedAt,
					endedAt: delegatedAt,
				});
			const report = (reported: FlowOutcome, endedAt: number) =>
				this.push({
					actor: "worker",
					kind: "report",
					label: short(`${lane}: ${record.status}`),
					result: record.status,
					to: "root",
					...laneFields,
					startedAt: endedAt,
					endedAt,
					outcome: reported,
				});
			if (previous === undefined && outcome === "open") {
				const delegatedAt = timeOf(record.status === "queued" ? record.queuedAt : record.startedAt);
				delegate(delegatedAt);
				if (record.status === "queued")
					this.begin(queueKey, { actor: "worker", kind: "wait", label: "queued", ...laneFields }, delegatedAt);
			}
			if (record.status === "running") {
				const startedAt = timeOf(record.startedAt);
				this.finish(queueKey, "ok", startedAt);
				this.begin(key, { actor: "worker", kind: "worker", label: short(lane), ...laneFields }, startedAt);
			}
			if (outcome !== "open" && previous !== undefined && LANE_OUTCOME[previous] === "open") {
				const endedAt = timeOf(record.completedAt);
				this.finish(queueKey, outcome, endedAt);
				this.finish(key, outcome, endedAt);
				report(outcome, endedAt);
			}
			if (outcome !== "open" && previous === undefined) {
				const endedAt = Date.parse(record.completedAt ?? "");
				if (!Number.isFinite(endedAt) || endedAt < this.since) continue;
				delegate(Date.parse(record.queuedAt ?? record.startedAt ?? "") || endedAt);
				report(outcome, endedAt);
			}
		}
	}

	private instant(event: Omit<FlowEvent, "id" | "startedAt" | "endedAt">): void {
		const at = this.now();
		this.push({ ...event, startedAt: at, endedAt: at });
	}

	private begin(key: string, event: Omit<FlowEvent, "id" | "startedAt">, startedAt = this.now()): void {
		if (this.open.has(key)) this.finish(key, "cancelled");
		this.open.set(key, this.push({ ...event, startedAt }));
	}

	/** Ends an open action. `outcome` is undefined when the source says the action ended but not how. */
	private finish(key: string, outcome: FlowOutcome | undefined, endedAt = this.now()): void {
		const sequence = this.open.get(key);
		if (sequence === undefined) return;
		this.open.delete(key);
		const index = this.events.findIndex((event) => event.id === `${sequence}`);
		if (index === -1) return;
		this.events[index] = { ...this.events[index]!, endedAt, ...(outcome !== undefined ? { outcome } : {}) };
	}

	/**
	 * The one write path. The list stays ordered by start: the new action goes after the last action
	 * that began no later than it (ties keep recording order). The search runs from the end because
	 * actions almost always arrive in start order.
	 */
	private push(event: Omit<FlowEvent, "id">): number {
		const sequence = ++this.sequence;
		let at = this.events.length;
		while (at > 0 && this.events[at - 1]!.startedAt > event.startedAt) at--;
		this.events.splice(at, 0, { ...event, id: `${sequence}` });
		this.bound();
		return sequence;
	}

	/** Drops the oldest finished actions (by start) past the bound; a running action is never dropped. */
	private bound(): void {
		while (this.events.length > MAX_FLOW_EVENTS) {
			const index = this.events.findIndex((event) => event.endedAt !== undefined);
			if (index === -1) return;
			const [dropped] = this.events.splice(index, 1);
			if (dropped?.kind !== "judgment") continue;
			for (const [evaluationId, eventId] of this.judgments) {
				if (eventId !== dropped.id) continue;
				this.judgments.delete(evaluationId);
				break;
			}
		}
	}
}
