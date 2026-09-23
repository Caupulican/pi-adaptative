/**
 * The flow trace: what actually happened in the session, as a bounded list of actor actions in the
 * order they began. It is recorded from the sources that do the work (the session's event stream,
 * settled System One evaluations, questions to the owner, worker lane records), never inferred from
 * phases afterwards, so a view drawn from it shows what is going on and nothing else.
 *
 * Every session event type is either mapped or ignored with its reason in one exhaustive table: a
 * new event type does not compile until someone decides where it belongs in the flow.
 */

import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { AgentSessionEvent } from "../agent-session-contracts.ts";
import type { LaneRecord, LaneStatus } from "../autonomy/lane-tracker.ts";
import type { HumanInputActivity } from "../human-input-activity.ts";
import { evaluationResultText, type SemanticEvaluationRecord } from "../system-one/semantic-evaluation-ledger.ts";

/** Who acts. Each actor is one lane of the flow; every worker shares the workers lane, named per event. */
export type FlowActor = "owner" | "system_one" | "root" | "worker";

export const FLOW_ACTORS: readonly FlowActor[] = ["owner", "system_one", "root", "worker"];

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
	/** The worker's name, for actions in the workers lane. */
	readonly lane?: string;
	readonly startedAt: number;
	/** Absent while the action is running. An instant action ends when it starts. */
	readonly endedAt?: number;
	readonly outcome?: FlowOutcome;
}

/** Oldest finished actions are dropped past this; running ones are always kept. */
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

export class FlowTrace {
	private readonly events: FlowEvent[] = [];
	private readonly open = new Map<string, number>();
	private readonly listeners = new Set<() => void>();
	private readonly laneStatus = new Map<string, LaneStatus>();
	private readonly backgroundOpen = new Set<string>();
	private readonly now: () => number;
	private sequence = 0;

	constructor(options: { now?: () => number } = {}) {
		this.now = options.now ?? Date.now;
	}

	/** Every recorded action, oldest first. */
	snapshot(): readonly FlowEvent[] {
		return this.events;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Forget everything: a new or resumed session has its own flow. */
	reset(): void {
		this.events.length = 0;
		this.open.clear();
		this.laneStatus.clear();
		this.backgroundOpen.clear();
		this.changed();
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
			else this.finish("wait", "ok");
		},
		// Worker lanes are read from their records (observeLanes); this summary carries no dispatches.
		delegate_workers: () => {},
		// Session state, not actions.
		queue_update: () => {},
		session_info_changed: () => {},
		thinking_level_changed: () => {},
	};

	observe(event: AgentSessionEvent): void {
		(this.handlers[event.type] as (event: AgentSessionEvent) => void)(event);
	}

	/** A settled System One evaluation: a judgment handed to the root, with its own timing. */
	observeEvaluation(record: SemanticEvaluationRecord): void {
		const result = evaluationResultText(record);
		this.push(
			{
				actor: "system_one",
				kind: "judgment",
				label: short(result ? `${record.label} → ${result}` : record.label),
				to: "root",
				startedAt: record.startedAt,
				endedAt: record.endedAt,
				outcome: record.outcome === "ok" ? "ok" : record.outcome,
			},
			`judgment:${record.evaluationId}`,
		);
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
			const key = `worker:${record.laneId}`;
			const outcome = LANE_OUTCOME[record.status];
			if (previous === undefined && outcome === "open") {
				const startedAt = Date.parse(record.startedAt ?? "") || this.now();
				this.push({
					actor: "root",
					kind: "delegate",
					label: short(lane),
					to: "worker",
					startedAt,
					endedAt: startedAt,
				});
				this.begin(key, { actor: "worker", kind: "worker", label: short(lane), lane }, startedAt);
			}
			if (outcome !== "open" && previous !== undefined && LANE_OUTCOME[previous] === "open") {
				const endedAt = Date.parse(record.completedAt ?? "") || this.now();
				this.finish(key, outcome, endedAt);
				this.push({
					actor: "worker",
					kind: "report",
					label: short(`${lane}: ${record.status}`),
					to: "root",
					lane,
					startedAt: endedAt,
					endedAt,
					outcome,
				});
			}
		}
	}

	private instant(event: Omit<FlowEvent, "id" | "startedAt" | "endedAt">): void {
		const at = this.now();
		this.push({ ...event, startedAt: at, endedAt: at });
	}

	private begin(key: string, event: Omit<FlowEvent, "id" | "startedAt">, startedAt = this.now()): void {
		if (this.open.has(key)) this.finish(key, "cancelled");
		this.open.set(key, this.push({ ...event, startedAt }, key));
	}

	private finish(key: string, outcome: FlowOutcome, endedAt = this.now()): void {
		const sequence = this.open.get(key);
		if (sequence === undefined) return;
		this.open.delete(key);
		const index = this.events.findIndex((event) => event.id === `${sequence}`);
		if (index === -1) return;
		this.events[index] = { ...this.events[index]!, endedAt, outcome };
		this.changed();
	}

	private push(event: Omit<FlowEvent, "id">, _key?: string): number {
		const sequence = ++this.sequence;
		this.events.push({ ...event, id: `${sequence}` });
		this.bound();
		this.changed();
		return sequence;
	}

	/** Drops the oldest finished actions past the bound; a running action is never dropped. */
	private bound(): void {
		while (this.events.length > MAX_FLOW_EVENTS) {
			const index = this.events.findIndex((event) => event.endedAt !== undefined);
			if (index === -1) return;
			this.events.splice(index, 1);
		}
	}

	private changed(): void {
		for (const listener of this.listeners) listener();
	}
}
