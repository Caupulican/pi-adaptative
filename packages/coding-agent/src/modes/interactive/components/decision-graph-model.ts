/**
 * The Decision graph's model: a pure projection of canonical runtime facts into what the pane draws.
 * No clock reads, no I/O, no state of its own — `nowMs` is an input so a frame is reproducible. The
 * graph is composed per task from what the task needs (plan, checks, participants), what it will do
 * next (the continuation) and what it did (stage log, evaluations, routed choices, evidence); nothing
 * here is a fixed skeleton.
 */

import type { LaneRecord } from "../../../core/autonomy/lane-tracker.ts";
import type { ForegroundRouteSnapshot } from "../../../core/model-router-controller.ts";
import {
	type DecisionStage,
	type DecisionStageLogView,
	isIdleProjection,
} from "../../../core/operator-projection/decision-stage-log.ts";
import type { OperatorProjection } from "../../../core/operator-projection/types.ts";
import {
	doubtsFromReasons,
	type SemanticEvaluationRecord,
} from "../../../core/system-one/semantic-evaluation-ledger.ts";
import type { SemanticPlaneHealth } from "../../../core/system-one/semantic-plane-health.ts";
import { formatRouteValue, shortModelName } from "./operator-pov-bar.ts";

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
	readonly nowMs: number;
}

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
	readonly kind: "root" | "specialist" | "worker" | "verifier" | "capability" | "tool";
	readonly label: string;
	readonly model?: string;
	/** Who chose the model, in the operator's words; absent when the choice was direct. */
	readonly routeText?: string;
	readonly task?: string;
	readonly startedAt?: number;
	readonly running: boolean;
	/** The participant executed something in this objective (even if idle now). */
	readonly acted: boolean;
}

export type DecisionGoalBranch = "pending" | "deliver" | "delivered" | "repair" | "clarify";

export interface DecisionDoubt {
	/** The judgment that came back unsure, as the ledger recorded it. */
	readonly text: string;
	/** The evaluation that raised it, for the stage it belongs to. */
	readonly label: string;
	readonly at: number;
}

/** Doubts are read from the last few evaluations; older ones are history, not open questions. */
export const DOUBT_EVALUATION_WINDOW = 3;
/** The pane names at most this many; the count still reports all of them. */
export const MAX_DOUBTS = 4;

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
	};
	readonly stages: readonly DecisionStageRow[];
	readonly current?: DecisionStageRow;
	readonly loop: number;
	readonly next?: string;
	readonly plan: DecisionGraphInput["plan"];
	readonly checks: DecisionGraphInput["checks"];
	readonly participants: readonly DecisionParticipant[];
	readonly routing: readonly { readonly text: string; readonly live: boolean }[];
	readonly evidence: DecisionGraphInput["receipts"];
	readonly blocked?: string;
	/** `present` is false for a plain request: it has no goal to satisfy, only a turn to finish. */
	readonly goal: { readonly present: boolean; readonly branch: DecisionGoalBranch };
	/**
	 * Judgments that settled nothing and are still open, newest evaluation first.
	 *
	 * A doubt is the third state between a pass and a failure, and it is the one the pane never had:
	 * without it an unsure judgment is drawn as a quiet yes. It is why the loop is going round again,
	 * so it belongs on the drawing next to the stage that asked it.
	 */
	readonly doubts: readonly DecisionDoubt[];
	readonly hasRunningClock: boolean;
	readonly stageLogEmpty: boolean;
	readonly nowMs: number;
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

function laneRunning(lane: LaneRecord): boolean {
	return lane.status === "queued" || lane.status === "running";
}

function participantKind(lane: LaneRecord): DecisionParticipant["kind"] {
	return lane.type === "research" ? "specialist" : "worker";
}

function parseTime(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function buildDecisionGraphModel(input: DecisionGraphInput): DecisionGraphModel {
	const { projection, stageLog, health, evaluations, route, lanes, nowMs } = input;
	const open = stageLog.open;
	const stages: DecisionStageRow[] = [];
	const seen = new Set<DecisionStage>();
	const timedEvents = (input.events ?? []).flatMap((event) => {
		const at = Date.parse(event.timestamp);
		return Number.isFinite(at) ? [{ at, title: event.title, severity: event.severity }] : [];
	});
	const eventsDuring = (stage: DecisionStage): DecisionStageRow["events"] => {
		const windows = stageLog.entries
			.filter((entry) => entry.stage === stage)
			.map((entry) => ({ from: entry.enteredAt, to: entry.endedAt ?? nowMs }));
		return timedEvents
			.filter((event) => windows.some((window) => event.at >= window.from && event.at < window.to))
			.slice(-MAX_STAGE_EVENTS)
			.map(({ title, severity }) => ({ title, severity }));
	};
	for (const entry of stageLog.entries) {
		if (seen.has(entry.stage)) continue;
		seen.add(entry.stage);
		const totals = stageLog.totals[entry.stage];
		const isCurrent = open?.stage === entry.stage;
		stages.push({
			events: eventsDuring(entry.stage),
			stage: entry.stage,
			totalMs: totals.elapsedMs,
			passMs: isCurrent && open ? Math.max(0, nowMs - open.enteredAt) : 0,
			passes: totals.passes,
			current: isCurrent,
			loop: isCurrent && open ? open.loop : entry.loop,
			...(isCurrent && open?.reasonCode
				? { reasonCode: open.reasonCode }
				: entry.reasonCode
					? { reasonCode: entry.reasonCode }
					: {}),
			...(isCurrent && open?.note ? { note: open.note } : entry.note ? { note: entry.note } : {}),
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
	const decider = {
		owner: projection.control.owner,
		...(inFlight ? { evaluating: { label: inFlight.label, startedAt: inFlight.startedAt } } : {}),
		...(last ? { last } : {}),
		evaluations: evaluations.length,
		doing: inFlight
			? `judging ${inFlight.label}`
			: current
				? STAGE_DOING[current.stage]
				: projection.phase === "done"
					? "delivered"
					: projection.control.owner === "system_one"
						? "decides next"
						: projection.control.owner === "user"
							? "waiting for you"
							: "standing by",
	};

	const routed = route.switched && route.activeModel !== route.rootModel;
	const rootRunning =
		projection.active_actors.some((actor) => actor.kind === "root") &&
		projection.phase !== "done" &&
		!waiting &&
		!isIdleProjection(projection);
	const rootActed =
		input.receipts.actions > 0 ||
		stageLog.entries.some((entry) => entry.stage === "build" || entry.stage === "repair");
	const participants: DecisionParticipant[] = [
		{
			id: "root",
			kind: "root",
			label: "root",
			model: shortModelName(route.activeModel ?? route.rootModel),
			...(routed ? { routeText: formatRouteValue(route) } : {}),
			...(rootRunning ? { task: projection.current_action } : {}),
			running: rootRunning,
			acted: rootActed,
		},
	];
	const order: Record<DecisionParticipant["kind"], number> = {
		root: 0,
		specialist: 1,
		worker: 2,
		verifier: 3,
		capability: 4,
		tool: 5,
	};
	const laneParticipants = lanes
		.filter((lane) => lane.type === "research" || lane.type === "worker" || lane.type === "tmux-worker")
		.map(
			(lane): DecisionParticipant => ({
				id: lane.laneId,
				kind: participantKind(lane),
				label: lane.label ?? `worker ${lane.laneId.slice(0, 8)}`,
				...(lane.modelRef ? { model: shortModelName(lane.modelRef) } : {}),
				...(workerRouteText(lane) ? { routeText: workerRouteText(lane) } : {}),
				...(lane.label ? { task: lane.label } : {}),
				...(parseTime(lane.startedAt) !== undefined ? { startedAt: parseTime(lane.startedAt) } : {}),
				running: laneRunning(lane),
				acted: true,
			}),
		)
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
			routing.push({ text: `${lane.routeText} → ${lane.model} for ${lane.label}`, live: lane.running });
	}

	const lastVerify = [...evaluations]
		.reverse()
		.find(
			(record) => /^(verify|completion|objective route)/.test(record.label) || record.label.startsWith("completion"),
		);
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

	// Only the most recent evaluations are asked: a doubt from five judgments ago was either
	// resolved by the work since, or it is being raised again by the evaluation that still holds it.
	const doubts: DecisionDoubt[] = [];
	for (const record of evaluations.slice(-DOUBT_EVALUATION_WINDOW).reverse()) {
		for (const text of doubtsFromReasons(record.reasons)) {
			if (doubts.some((doubt) => doubt.text === text)) continue;
			doubts.push({ text, label: record.label, at: record.endedAt });
		}
	}

	const hasRunningClock = Boolean(
		(open && projection.phase !== "done") ||
			inFlight ||
			participants.some((p) => p.running && p.startedAt !== undefined),
	);

	return {
		objectiveId: projection.objective_id,
		you,
		decider,
		stages,
		...(current ? { current } : {}),
		loop: stageLog.loop,
		...(projection.next_action ? { next: projection.next_action } : {}),
		plan: input.plan,
		checks: input.checks,
		participants,
		routing,
		evidence: input.receipts,
		...(blocked ? { blocked } : {}),
		goal: { present: projection.has_goal, branch },
		doubts,
		hasRunningClock,
		stageLogEmpty: stageLog.entries.length === 0,
		nowMs,
	};
}
