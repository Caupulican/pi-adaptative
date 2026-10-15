/**
 * The Decision graph's model: a pure projection of canonical runtime facts into what the pane draws.
 * No clock reads, no I/O, no state of its own — `nowMs` is an input so a frame is reproducible. The
 * graph is composed per task from what the task needs (plan, checks, participants), what it will do
 * next (the continuation) and what it did (stage log, evaluations, routed choices, evidence); nothing
 * here is a fixed skeleton.
 */

import type { LaneRecord } from "../../../core/autonomy/lane-tracker.ts";
import type { IdlePreparationView } from "../../../core/compaction-controller.ts";
import type { ForegroundRouteSnapshot } from "../../../core/model-router-controller.ts";
import type { DecisionStage, DecisionStageLogView } from "../../../core/operator-projection/decision-stage-log.ts";
import type { FlowEvent, FlowOutcome } from "../../../core/operator-projection/flow-trace.ts";
import type { OperatorProjection } from "../../../core/operator-projection/types.ts";
import { formatRouteValue, shortModelName } from "../../../core/route-text.ts";
import type { SemanticEvaluationRecord } from "../../../core/system-one/semantic-evaluation-ledger.ts";
import type { SemanticPlaneHealth } from "../../../core/system-one/semantic-plane-health.ts";
import { formatCompactDuration } from "../../../core/util/format-duration.ts";

export type DecisionPlanStepStatus = "done" | "active" | "pending" | "blocked" | "failed" | "cancelled";
export type DecisionCheckStatus = "pending" | "satisfied" | "failed";

export interface DecisionGraphInput {
	readonly projection: OperatorProjection;
	readonly stageLog: DecisionStageLogView;
	readonly health: SemanticPlaneHealth;
	/** Settled evaluations, oldest first. */
	readonly evaluations: readonly SemanticEvaluationRecord[];
	readonly route: ForegroundRouteSnapshot;
	readonly lanes: readonly LaneRecord[];
	/** What the task needs: its steps, in order. */
	readonly plan: readonly { readonly title: string; readonly status: DecisionPlanStepStatus }[];
	/** The checks the task must pass: acceptance criteria and verification obligations. */
	readonly checks: readonly { readonly text: string; readonly status: DecisionCheckStatus }[];
	/** Mandatory semantic findings from peer review; kept separate from deterministic checks and doubts. */
	readonly peerFindings?: readonly { readonly id: string; readonly reason: string; readonly scope: string }[];
	readonly receipts: { readonly actions: number; readonly fileEffects: number; readonly failures: number };
	/** Question to the operator, when one was asked in this objective. */
	readonly humanInput?: {
		readonly question?: string;
		readonly askedAt?: number;
		readonly asked: number;
		readonly answered: number;
	};
	readonly backgroundTools: readonly { readonly name: string; readonly startedAt?: number }[];
	/** The operator event stream (visible events only); a stage's detail lists what happened while it was open. */
	readonly events?: readonly { readonly timestamp: string; readonly title: string; readonly severity: string }[];
	/** What actually happened, recorded where it happened: the source for what is running now. */
	readonly flow?: readonly FlowEvent[];
	/** The root lane's idle compaction preparation, when one is planned or just decided a resume. */
	readonly idlePreparation?: IdlePreparationView;
	readonly nowMs: number;
}

/**
 * One stage over the whole objective, in the order the stage was first entered. `totalMs`, `passes`
 * and `events` aggregate every visit; `loop`, `reasonCode` and `note` describe the LATEST visit.
 */
export interface DecisionStageRow {
	readonly stage: DecisionStage;
	readonly totalMs: number;
	/** This visit only. Zero when the stage is not the open one. The ticking clock uses this, not `totalMs`. */
	readonly passMs: number;
	readonly passes: number;
	readonly current: boolean;
	readonly loop: number;
	readonly reasonCode?: string;
	readonly note?: string;
	/** Titles of the events recorded while this stage was open, oldest first, bounded. */
	readonly events: readonly { readonly title: string; readonly severity: string }[];
}

/** A stage's detail lists at most this many events; the transcript keeps the rest. */
export const MAX_STAGE_EVENTS = 6;

export interface DecisionParticipant {
	readonly id: string;
	readonly kind: "root" | "specialist" | "worker" | "capability" | "tool";
	readonly label: string;
	readonly model?: string;
	/** Who chose the model, in the operator's words; absent when the choice was direct. */
	readonly routeText?: string;
	readonly task?: string;
	readonly startedAt?: number;
	readonly running: boolean;
	readonly queued?: boolean;
	readonly waitReason?: string;
	/** The participant executed something in this objective (even if idle now). */
	readonly acted: boolean;
}

export type DecisionGoalBranch = "pending" | "deliver" | "delivered" | "repair" | "clarify";

export interface DecisionGraphModel {
	readonly objectiveId: string;
	readonly you: {
		readonly present: boolean;
		readonly waiting: boolean;
		readonly waitingSinceMs?: number;
		readonly asked: number;
		readonly answered: number;
		readonly question?: string;
	};
	readonly decider: {
		readonly owner: OperatorProjection["control"]["owner"];
		readonly evaluating?: { readonly label: string; readonly startedAt: number };
		readonly last?: SemanticEvaluationRecord;
		readonly evaluations: number;
		/** What System One is doing with control right now, in one phrase. */
		readonly doing: string;
		readonly rootOwned: boolean;
	};
	readonly stages: readonly DecisionStageRow[];
	readonly current?: DecisionStageRow;
	readonly loop: number;
	readonly next?: string;
	readonly plan: DecisionGraphInput["plan"];
	readonly checks: DecisionGraphInput["checks"];
	readonly peerFindings: NonNullable<DecisionGraphInput["peerFindings"]>;
	readonly participants: readonly DecisionParticipant[];
	readonly routing: readonly { readonly text: string; readonly live: boolean }[];
	readonly evidence: DecisionGraphInput["receipts"];
	readonly blocked?: string;
	/** `present` is false for a plain request: it has no goal to satisfy, only a turn to finish. */
	readonly goal: { readonly present: boolean; readonly branch: DecisionGoalBranch };
	/** Live unresolved semantic uncertainties, owned by the evaluation lifecycle rather than history. */
	readonly unresolvedDoubtCount: number;
	readonly hasRunningClock: boolean;
	/** The request is in flight: something in the trace is still open (routing, the turn, a tool, a question). */
	readonly turnRunning: boolean;
	/** How the last finished turn ended, from the trace. */
	readonly lastTurnOutcome?: FlowOutcome;
	/** The flow trace, for the views drawn from it. */
	readonly flow: readonly FlowEvent[];
	readonly stageLogEmpty: boolean;
	/** Set when the stage history's durable store failed: the rows shown are live, the stored history may be behind. */
	readonly stageHistoryFailure?: string;
	/** What the idle root lane's compaction preparation is doing, in one line; absent when none is planned. */
	readonly idleText?: string;
	readonly nowMs: number;
}

/**
 * Whether the graph has anything to draw: a stage ran, a plan or check is open, System One holds a question or doubt,
 * a turn is in flight or the flow trace recorded an event. A graph with none of that earns no width, like the work area.
 */
export function graphHasContent(model: DecisionGraphModel): boolean {
	return (
		!model.stageLogEmpty ||
		model.plan.length > 0 ||
		model.checks.length > 0 ||
		model.peerFindings.length > 0 ||
		model.unresolvedDoubtCount > 0 ||
		model.you.present ||
		model.turnRunning ||
		model.flow.length > 0
	);
}

/** Whether the goal is closed, and what still holds it open. The one definition every view of the verdict uses. */
export interface GoalClosure {
	/** Unsatisfied checks, peer findings and unresolved doubts. */
	readonly open: number;
	/** The goal reached its delivered branch with nothing open. */
	readonly delivered: boolean;
	/** The loop is at its delivery step with nothing open. */
	readonly delivering: boolean;
}

export function goalClosure(model: DecisionGraphModel): GoalClosure {
	const open =
		model.checks.filter((check) => check.status !== "satisfied").length +
		model.peerFindings.length +
		model.unresolvedDoubtCount;
	return {
		open,
		delivered: model.goal.branch === "delivered" && open === 0,
		delivering: (model.goal.branch === "deliver" || model.current?.stage === "deliver") && open === 0,
	};
}

/** The idle preparation in the operator's words: when it prepares and what it expects, or how the lane resumed. */
export function idlePreparationText(view: IdlePreparationView, nowMs: number): string {
	switch (view.state) {
		case "armed":
			return `idle · prepare in ${formatCompactDuration(view.prepareAt - nowMs)} · ~$${view.valueUsd.toFixed(3)} expected`;
		case "preparing":
			return `idle · preparing a summary ${formatCompactDuration(nowMs - view.since)}`;
		case "prepared":
			return "idle · summary prepared";
		case "resumed":
			return view.fresh
				? `resumed · fresh${view.savedUsd !== undefined ? ` · saved ~$${view.savedUsd.toFixed(3)}` : ""}`
				: "resumed · warm";
	}
}

/**
 * Who chose a worker's model, in the operator's words. The dispatch records it at admission; a
 * lane from before the record existed shows its profile, the only fact it carries. Never credits
 * the router or H-MoE, which choose no worker models.
 */
export function workerRouteText(lane: LaneRecord): string | undefined {
	switch (lane.routeSource) {
		case "contract":
			return "contract";
		case "inherited":
			return "inherited";
		case "model_pin":
			return `model pin${lane.routePinSource ? ` (${lane.routePinSource})` : ""}`;
		case "profile":
			return lane.profileId ? `profile ${lane.profileId}` : "profile";
		case "authority":
			return "requested model";
		default:
			return lane.profileId ? `profile ${lane.profileId}` : undefined;
	}
}

const STAGE_DOING: Readonly<Record<DecisionStage, string>> = {
	understand: "understanding the request",
	plan: "planning",
	build: "building",
	dispatch: "dispatching",
	observe: "reviewing evidence",
	verify: "verifying",
	clarify: "waiting for you",
	repair: "repairing",
	deliver: "delivering",
	done: "delivered",
};

function participantKind(lane: LaneRecord): DecisionParticipant["kind"] {
	return lane.type === "research" ? "specialist" : "worker";
}

function parseTime(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeText(value: string | null | undefined): string {
	return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

interface TimedEvent {
	readonly at: number;
	readonly title: string;
	readonly severity: string;
}

/** Parsed event times per events array: a frame handed the same array does no parsing. */
const timedEventsCache = new WeakMap<readonly unknown[], readonly TimedEvent[]>();

function timedEventsOf(events: DecisionGraphInput["events"]): readonly TimedEvent[] {
	if (events === undefined) return [];
	const cached = timedEventsCache.get(events);
	if (cached) return cached;
	const parsed = events.flatMap((event) => {
		const at = Date.parse(event.timestamp);
		return Number.isFinite(at) ? [{ at, title: event.title, severity: event.severity }] : [];
	});
	timedEventsCache.set(events, parsed);
	return parsed;
}

export function buildDecisionGraphModel(input: DecisionGraphInput): DecisionGraphModel {
	const { projection, stageLog, health, evaluations, route, lanes, nowMs } = input;
	const open = stageLog.open;
	const stages: DecisionStageRow[] = [];
	const timedEvents = timedEventsOf(input.events);
	const eventsDuring = (stage: DecisionStage, stageNote: string | undefined): DecisionStageRow["events"] => {
		const windows = stageLog.entries
			.filter((entry) => entry.stage === stage)
			.map((entry) => ({ from: entry.enteredAt, to: entry.endedAt ?? nowMs }));
		const stageNorm = normalizeText(stage);
		const doingNorm = normalizeText(STAGE_DOING[stage]);
		const noteNorm = normalizeText(stageNote);
		const deduped = new Map<string, { readonly title: string; readonly severity: string }>();
		for (const event of timedEvents) {
			if (!windows.some((window) => event.at >= window.from && event.at < window.to)) continue;
			const key = normalizeText(event.title);
			if (!key || key === stageNorm || key === doingNorm || (noteNorm && key === noteNorm)) continue;
			deduped.delete(key);
			deduped.set(key, { title: event.title, severity: event.severity });
		}
		return [...deduped.values()].slice(-MAX_STAGE_EVENTS);
	};
	for (const summary of stageLog.stages) {
		const isCurrent = open?.stage === summary.stage;
		const noteNorm = normalizeText(summary.note);
		const note =
			summary.note &&
			noteNorm.length > 0 &&
			noteNorm !== normalizeText(summary.stage) &&
			noteNorm !== normalizeText(STAGE_DOING[summary.stage])
				? summary.note
				: undefined;
		stages.push({
			events: eventsDuring(summary.stage, note),
			stage: summary.stage,
			totalMs: summary.elapsedMs,
			passMs: isCurrent && open ? Math.max(0, nowMs - open.enteredAt) : 0,
			passes: summary.passes,
			current: isCurrent,
			loop: summary.loop,
			...(summary.reasonCode ? { reasonCode: summary.reasonCode } : {}),
			...(note ? { note } : {}),
		});
	}
	const current = stages.find((row) => row.current);

	const waiting = projection.control.owner === "user";
	const clarifyEntry = open?.stage === "clarify" ? open : undefined;
	const asked = input.humanInput?.asked ?? 0;
	const answered = input.humanInput?.answered ?? 0;
	const you = {
		present: waiting || asked > 0,
		waiting,
		...(waiting ? { waitingSinceMs: clarifyEntry?.enteredAt ?? input.humanInput?.askedAt } : {}),
		asked,
		answered,
		...(waiting ? { question: projection.control.blocker ?? input.humanInput?.question } : {}),
	};

	const inFlight = health.inFlightEvaluations?.at(-1);
	const last = evaluations.at(-1);
	const rootOwned = projection.control.owner === "root";
	const decider = {
		owner: projection.control.owner,
		...(inFlight ? { evaluating: { label: inFlight.label, startedAt: inFlight.startedAt } } : {}),
		...(last ? { last } : {}),
		evaluations: evaluations.length,
		doing: inFlight
			? `judging ${inFlight.label}`
			: health.state === "unbound"
				? "off"
				: projection.phase === "done"
					? "delivered"
					: projection.control.owner === "system_one"
						? "decides next"
						: projection.control.owner === "user"
							? "waiting for you"
							: "standing by",
		rootOwned,
	};

	const routed = route.switched && route.activeModel !== route.rootModel;
	// What the root is doing is read from the trace, not guessed from phases: running while a turn is
	// open, and doing the latest action still open inside it.
	const flow = input.flow ?? [];
	const openRoot = flow.filter((event) => event.actor === "root" && event.endedAt === undefined);
	const turnRunning = flow.some((event) => event.endedAt === undefined && event.actor !== "worker");
	const rootAction = openRoot.findLast((event) => event.kind !== "turn");
	const rootRunning = openRoot.some((event) => event.kind === "turn");
	const lastTurnOutcome = flow.findLast((event) => event.kind === "turn" && event.endedAt !== undefined)?.outcome;
	const rootTask = waiting ? "waiting for your answer" : (rootAction?.label ?? "thinking");
	const rootActed =
		input.receipts.actions > 0 || flow.some((event) => event.actor === "root" && event.kind !== "notice");
	const participants: DecisionParticipant[] = [
		{
			id: "root",
			kind: "root",
			label: "root",
			model: shortModelName(route.activeModel ?? route.rootModel),
			...(routed ? { routeText: formatRouteValue(route) } : {}),
			...(rootRunning ? { task: rootTask } : {}),
			running: rootRunning,
			acted: rootActed,
		},
	];
	const order: Record<DecisionParticipant["kind"], number> = {
		root: 0,
		specialist: 1,
		worker: 2,
		capability: 3,
		tool: 4,
	};
	const laneParticipants = lanes
		.filter((lane) => lane.type === "research" || lane.type === "worker" || lane.type === "tmux-worker")
		.map((lane): DecisionParticipant => {
			const startedAt = lane.status === "running" ? parseTime(lane.startedAt) : undefined;
			const routeText = workerRouteText(lane);
			return {
				id: lane.laneId,
				kind: participantKind(lane),
				label: lane.label ?? `worker ${lane.laneId.slice(0, 8)}`,
				...(lane.modelRef ? { model: shortModelName(lane.modelRef) } : {}),
				...(routeText ? { routeText } : {}),
				...(startedAt !== undefined ? { startedAt } : {}),
				running: lane.status === "running",
				queued: lane.status === "queued",
				...(lane.status === "queued" && lane.waitReason ? { waitReason: lane.waitReason } : {}),
				acted: true,
			};
		})
		.sort((a, b) => order[a.kind] - order[b.kind]);
	participants.push(...laneParticipants);
	if (projection.adaptation) {
		participants.push({
			id: `adaptation:${projection.adaptation.kind}`,
			kind: "capability",
			label: projection.adaptation.label,
			task: projection.adaptation.state,
			running: projection.adaptation.state !== "active",
			acted: true,
		});
	}
	for (const tool of input.backgroundTools) {
		participants.push({
			id: `tool:${tool.name}`,
			kind: "tool",
			label: tool.name,
			...(tool.startedAt !== undefined ? { startedAt: tool.startedAt } : {}),
			running: true,
			acted: true,
		});
	}

	const routing: { text: string; live: boolean }[] = [];
	if (routed)
		routing.push({ text: `${formatRouteValue(route)} → ${shortModelName(route.activeModel)} for root`, live: true });
	for (const lane of laneParticipants) {
		if (lane.routeText && lane.model)
			routing.push({
				text: `${lane.routeText} → ${lane.model} for ${lane.label}`,
				live: lane.running || lane.queued === true,
			});
	}

	const lastVerify = [...evaluations]
		.reverse()
		.find((record) => /^(verify|completion|objective route)/.test(record.label));
	const currentStage = current?.stage;
	const blocked = projection.phase === "blocked" && !waiting ? projection.why : undefined;
	const branch: DecisionGoalBranch =
		projection.phase === "done"
			? "delivered"
			: currentStage === "deliver"
				? "deliver"
				: currentStage === "clarify"
					? "clarify"
					: currentStage === "repair" ||
							(lastVerify &&
								lastVerify.outcome === "ok" &&
								lastVerify.verdict !== undefined &&
								lastVerify.verdict !== "pass" &&
								currentStage !== "verify")
						? "repair"
						: "pending";

	// Evaluation history explains what happened; only the lifecycle owner decides what remains open.
	const unresolvedDoubtCount = health.unresolvedDoubts?.length ?? 0;
	const peerFindings = input.peerFindings ?? [];

	const idle = input.idlePreparation;
	const hasRunningClock = Boolean(
		(open && projection.phase !== "done") ||
			inFlight ||
			idle?.state === "armed" ||
			idle?.state === "preparing" ||
			flow.some((event) => event.endedAt === undefined) ||
			participants.some((p) => p.running && p.startedAt !== undefined),
	);

	const nextNorm = normalizeText(projection.next_action);
	const nextDuplicates =
		!nextNorm ||
		(current !== undefined &&
			(nextNorm === normalizeText(current.stage) ||
				nextNorm === normalizeText(STAGE_DOING[current.stage]) ||
				(current.note !== undefined && nextNorm === normalizeText(current.note)))) ||
		(you.question !== undefined && nextNorm === normalizeText(you.question));
	const next = projection.next_action && !nextDuplicates ? projection.next_action : undefined;

	return {
		objectiveId: projection.objective_id,
		you,
		decider,
		stages,
		...(current ? { current } : {}),
		loop: stageLog.loop,
		...(next ? { next } : {}),
		plan: input.plan,
		checks: input.checks,
		peerFindings,
		participants,
		routing,
		evidence: input.receipts,
		...(blocked ? { blocked } : {}),
		goal: { present: projection.has_goal, branch },
		unresolvedDoubtCount,
		hasRunningClock,
		turnRunning,
		...(lastTurnOutcome ? { lastTurnOutcome } : {}),
		flow,
		stageLogEmpty: stageLog.entries.length === 0,
		...(stageLog.sinkFailure !== undefined ? { stageHistoryFailure: stageLog.sinkFailure } : {}),
		...(idle ? { idleText: idlePreparationText(idle, nowMs) } : {}),
		nowMs,
	};
}
