/**
 * Live operator projection for a session.
 *
 * The projection is derived from canonical runtime state on every read — the goal, its
 * requirements and evidence, the live worker lanes, unresolved proof obligations, the adaptive
 * runtime's current work, the charter's delivery authority and the context window. Nothing here is
 * a literal the UI hands itself, and nothing is a second copy of state that could drift.
 * Conforms to OPERATOR_TUI_LIVE_BINDING.md and RCG-050..RCG-055.
 */

import { isDeepStrictEqual } from "node:util";
import type { GoalContinuationDecision } from "../goals/goal-continuation-controller.ts";
import { type GoalState, isGoalExecutionActive } from "../goals/goal-state.ts";
import { goalObjectiveId } from "../orchestration/work-state-projection.ts";
import { DecisionStageLog, type DecisionStageLogView, type DecisionStageSink } from "./decision-stage-log.ts";
import { OperatorEventController } from "./operator-event-controller.ts";
import { MAX_OPERATOR_EVENTS, OperatorProjectionController } from "./operator-projection-controller.ts";
import type {
	ActiveActor,
	AdaptationProjection,
	OperatorControlProjection,
	OperatorControlState,
	OperatorEvent,
	OperatorHealth,
	OperatorPhase,
	OperatorProjection,
	ProofProgress,
} from "./types.ts";

/** One worker lane, as the lane tracker knows it; terminal lanes are included. */
export interface LiveLaneView {
	readonly laneId: string;
	readonly type: string;
	readonly status: string;
	readonly label?: string;
	readonly startedAt?: string;
}

/** An unanswered question the operator owns, as the durable human-input record holds it. */
export interface PendingOwnerQuestion {
	readonly requestId: string;
	readonly question: string;
}

/** Reason codes whose next transition is an acceptance/verification decision, not new work. */
const VERIFYING_REASON_CODES: ReadonlySet<string> = new Set([
	"acceptance_evidence_required",
	"verification_repair_required",
	"goal_completion_required",
]);

/** How much of a question or continuation message the bar carries; the rest lives in the surface. */
const BLOCKER_TEXT_LIMIT = 120;

function boundedText(value: string, limit = BLOCKER_TEXT_LIMIT): string {
	const collapsed = value.replace(/\s+/g, " ").trim();
	return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}

/** A lane is terminal once the tracker no longer counts it as dispatched work. */
function isTerminalLaneStatus(status: string): boolean {
	return status !== "queued" && status !== "running";
}

/** Whether the session is in a delivery step: an outward-facing action is running or authorized-and-due. */
export type DeliveryState = "none" | "in_progress";

export interface SessionOperatorProjectionDeps {
	getObjectiveId(): string;
	getTitle(): string;
	getGoalState(): GoalState | undefined;
	getLanes(): readonly LiveLaneView[];
	/** Unresolved verification obligations; each is an unsatisfied proof. */
	getUnresolvedProofIds(): readonly string[];
	/** Adaptive work in flight (specialist synthesis, capability build, runtime update). */
	getAdaptation(): AdaptationProjection | undefined;
	getDeliveryState(): DeliveryState;
	/** Context usage percentage and whether the session has compacted. */
	getContext(): { percent?: number; compacted?: boolean } | undefined;
	/** True while the owner's fast-iteration rule is in force. */
	isFastIteration(): boolean;
	/** A blocking condition the operator has to resolve; absent when nothing blocks. */
	getBlocker(): string | undefined;
	/** The goal loop's live continuation verdict — the runtime decision control is derived from. */
	getContinuation(): GoalContinuationDecision | undefined;
	/**
	 * The objective route System One last decided, while it drives the loop (`objective_primary`).
	 * Present, it is what control is derived from; the continuation verdict stays the input layer.
	 */
	getRoute?(): { objectiveId: string; route: string; reasonCodes: readonly string[] } | undefined;
	/** The durable unanswered owner question, when one is open. */
	getPendingHumanInput(): PendingOwnerQuestion | undefined;
	/** Whether the foreground loop is executing a turn right now. */
	isForegroundBusy(): boolean;
	/**
	 * Count of persisted session entries. Every input the continuation and the durable human-input
	 * record are derived from is appended to the session, so this count moving is what says the two
	 * branch-walking reads below can return something new.
	 */
	getSessionEntryCount(): number;
	/**
	 * Durable sink of the Decision graph's stage log for the current session (the decision ledger
	 * bound to the session id), or undefined for a process-local log. `key` changes when the session
	 * changes, which reopens the log from the sink. Read per refresh.
	 */
	getStageSink?(): { readonly key: string; readonly sink: DecisionStageSink } | undefined;
}

const PHASE_ORDER: readonly OperatorPhase[] = ["understand", "plan", "build", "adapt", "verify", "deliver"];

/** Routes whose execution is someone else's turn System One waits on. */
const ROUTE_EXECUTING: ReadonlySet<string> = new Set(["wait_for_worker", "wait_for_tool", "continue_current_worker"]);
/** Routes that are proof work, whoever runs them. */
const ROUTE_VERIFYING: ReadonlySet<string> = new Set([
	"verify",
	"deterministic_test",
	"review",
	"completion_candidate",
]);
/** Routes the root executes as one turn: executing while that turn runs, deciding between turns. */
const ROUTE_ROOT_EXECUTES: ReadonlySet<string> = new Set([
	"retrieve",
	"investigate",
	"implement",
	"replan",
	"escalate_capability",
]);

/** The compact fast-iteration indicator, shown without listing every skipped check. */
export const FAST_ITERATION_INDICATOR = "fast iteration · targeted validation";

/**
 * Owns the session's one projection controller and refreshes it from canonical state.
 *
 * `refresh()` is idempotent and cheap: it reads live state and writes the derived projection, so a
 * UI that calls it per render always sees current truth without holding any state of its own.
 */
export class SessionOperatorProjection {
	private readonly deps: SessionOperatorProjectionDeps;
	private controller?: OperatorProjectionController;
	private controllerObjectiveId?: string;
	/** Subscribers live here, not on the controller, so they survive an objective change. */
	private readonly listeners = new Set<(projection: OperatorProjection) => void>();
	private readonly events: OperatorEvent[] = [];
	private eventController?: OperatorEventController;
	private eventControllerObjectiveId?: string;
	/**
	 * The last derivation key the two branch-walking reads were taken at. Both walk the active
	 * branch several times, and the POV bar refreshes on every TUI render (per streamed token during
	 * a turn), so they are read once per change of their own inputs rather than once per render.
	 */
	private derivationKey?: string;
	private cachedContinuation?: GoalContinuationDecision;
	private cachedPendingQuestion?: PendingOwnerQuestion;
	/**
	 * The Decision graph's stage log. It observes this projection's own published transitions; it is
	 * reopened when the durable path changes (a session switch) and reset when the objective changes.
	 */
	private stageLog = new DecisionStageLog();
	private stageLogPath?: string;
	private readonly stageListeners = new Set<() => void>();

	constructor(deps: SessionOperatorProjectionDeps) {
		this.deps = deps;
		// Deliberately not refreshed here: the session is still constructing its collaborators, and
		// every read refreshes anyway.
	}

	/**
	 * The projection controller the session owns. It is rebuilt when the objective changes, because
	 * a projection's `objective_id` is immutable; subscribers and events carry across.
	 */
	get projectionController(): OperatorProjectionController {
		const objectiveId = this.deps.getObjectiveId();
		if (this.controller && this.controllerObjectiveId === objectiveId) return this.controller;
		const controller = new OperatorProjectionController({ objectiveId, title: this.deps.getTitle() });
		for (const event of this.events) controller.emitEvent(event);
		controller.subscribe((projection) => {
			for (const listener of this.listeners) {
				try {
					listener(projection);
				} catch {
					// A failing subscriber must not break the projection.
				}
			}
		});
		this.controller = controller;
		this.controllerObjectiveId = objectiveId;
		return controller;
	}

	/**
	 * The bridge runtime subsystems record milestones and interventions through. It is rebuilt with
	 * the projection controller so both always speak for the same objective.
	 */
	get eventBridge(): OperatorEventController {
		const controller = this.projectionController;
		if (this.eventController && this.eventControllerObjectiveId === this.controllerObjectiveId) {
			return this.eventController;
		}
		this.eventController = new OperatorEventController({ projectionController: controller });
		this.eventControllerObjectiveId = this.controllerObjectiveId;
		return this.eventController;
	}

	getProjection(): OperatorProjection {
		return this.refresh();
	}

	getVisibleEvents(): readonly OperatorEvent[] {
		return this.projectionController.getVisibleEvents();
	}

	emitEvent(event: Omit<OperatorEvent, "id" | "timestamp">): OperatorEvent {
		const emitted = this.projectionController.emitEvent(event);
		this.events.push(emitted);
		while (this.events.length > MAX_OPERATOR_EVENTS) this.events.shift();
		return emitted;
	}

	subscribe(listener: (projection: OperatorProjection) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Recomputes the projection from live state and publishes it to subscribers. */
	refresh(): OperatorProjection {
		const goal = this.deps.getGoalState();
		const allLanes = this.deps.getLanes();
		const lanes = allLanes.filter((lane) => lane.status === "running" || lane.status === "queued");
		const proof = this.resolveProof(goal);
		const adaptation = this.deps.getAdaptation();
		const reviewableLane = this.resolveReviewableLane(goal, allLanes);
		this.syncDerivedReads(goal, allLanes);
		const control = this.resolveControl(goal, reviewableLane);
		// An open owner question is a real blocking condition, exactly like an operator-set blocker:
		// the objective cannot advance until it is answered, so it drives the same derivation.
		const blocker = this.deps.getBlocker() ?? (control.owner === "user" ? (control.blocker ?? undefined) : undefined);
		const phase = this.resolvePhase(goal, lanes, proof, adaptation, blocker);
		const observing = control.owner === "system_one" && control.state === "observing" && reviewableLane !== undefined;

		const patch = {
			title: this.deps.getTitle(),
			phase,
			phase_index: phaseIndex(phase),
			phase_count: PHASE_ORDER.length,
			current_action: observing
				? `Reviewing worker result: ${reviewableLane.label ?? reviewableLane.laneId}`
				: this.describeAction(phase, goal, lanes, adaptation, blocker),
			why: this.describeWhy(phase, goal, proof, blocker),
			next_action: observing ? "review evidence" : this.describeNext(phase, proof),
			health: resolveHealth(phase),
			control,
			active_actors: this.resolveActors(lanes),
			adaptation: adaptation ?? null,
			proof,
			context: this.deps.getContext() ?? null,
		};

		// Publishing an unchanged projection would wake every subscriber (the TUI requests a render,
		// whose render reads the projection again) with nothing to show; only real change publishes.
		const current = this.projectionController.getProjection();
		if (isDeepStrictEqual({ ...current, ...patch }, current)) return current;
		const published = this.projectionController.updateProjection(patch);
		// The stage log observes the projection's own transitions; it never decides one. Recorded at
		// the single point a real change publishes, so it cannot drift from what subscribers saw.
		if (this.currentStageLog().observe(published, Date.now())) {
			for (const listener of this.stageListeners) {
				try {
					listener();
				} catch {
					// A failing listener must not break the projection.
				}
			}
		}
		return published;
	}

	/** The stage log bound to the current session's sink, reopened when the session changes. */
	private currentStageLog(): DecisionStageLog {
		const bound = this.deps.getStageSink?.();
		const key = bound?.key;
		if (key !== this.stageLogPath) {
			this.stageLogPath = key;
			this.stageLog = new DecisionStageLog(bound ? { sink: bound.sink } : {});
		}
		return this.stageLog;
	}

	/** The loop stage log derived from this projection's published transitions. */
	getStageLog(now: number = Date.now()): DecisionStageLogView {
		return this.currentStageLog().view(now);
	}

	/** Fires when a new stage entry opens; the TUI uses it to keep the stage clock ticking. */
	onStageChange(listener: () => void): () => void {
		this.stageListeners.add(listener);
		return () => {
			this.stageListeners.delete(listener);
		};
	}

	/**
	 * Refreshes the two reads that walk the session branch — the goal continuation verdict and the
	 * durable owner question — and only when something they read has actually changed: the goal's
	 * own revision, the number of persisted entries, or the live lane roster. Recomputing them per
	 * render would walk the branch several times per streamed token.
	 */
	private syncDerivedReads(goal: GoalState | undefined, lanes: readonly LiveLaneView[]): void {
		const key = [
			goal ? `${goal.goalId}:${goal.revision ?? ""}:${goal.updatedAt}:${goal.status}` : "no-goal",
			this.deps.getSessionEntryCount(),
			lanes.map((lane) => `${lane.laneId}=${lane.status}`).join(","),
		].join("|");
		if (key === this.derivationKey) return;
		this.derivationKey = key;
		this.cachedPendingQuestion = this.deps.getPendingHumanInput();
		// Read only when an objective exists: with no goal the evaluator reports `missing_goal_state`
		// as ask-user, which is the absence of an objective rather than a question for the operator,
		// and an idle session should not pay for a runtime snapshot that cannot change the answer.
		this.cachedContinuation = goal ? this.deps.getContinuation() : undefined;
	}

	/**
	 * The lane whose returned work an open requirement is still bound to. A worker finishing is
	 * evidence for the owner of the objective to review, never completion by itself (FC-070/071),
	 * so a terminal lane still bound to an open requirement means control is observing it.
	 */
	private resolveReviewableLane(
		goal: GoalState | undefined,
		lanes: readonly LiveLaneView[],
	): LiveLaneView | undefined {
		if (!goal || !isGoalExecutionActive(goal.status)) return undefined;
		for (const requirement of goal.requirements) {
			if (requirement.status !== "open" || requirement.boundLaneId === undefined) continue;
			const lane = lanes.find((candidate) => candidate.laneId === requirement.boundLaneId);
			if (lane && isTerminalLaneStatus(lane.status)) return lane;
		}
		return undefined;
	}

	/**
	 * Who owns the NEXT objective transition, and what they are doing with it. Deliberately
	 * independent of `active_actors`: a worker can be executing while the semantic plane owns the
	 * decision, and the root can own the decision while nothing executes at all.
	 */
	private resolveControl(
		goal: GoalState | undefined,
		reviewableLane: LiveLaneView | undefined,
	): OperatorControlProjection {
		const pending = this.cachedPendingQuestion;
		if (pending) {
			return {
				owner: "user",
				state: "awaiting_user",
				reasonCode: "clarification_pending",
				clarificationRequestId: pending.requestId,
				blocker: boundedText(pending.question),
			};
		}

		const continuation = this.cachedContinuation;
		if (continuation?.action === "ask-user") {
			return {
				owner: "user",
				state: "awaiting_user",
				reasonCode: continuation.reasonCode,
				blocker: boundedText(continuation.message),
			};
		}

		if (goal && isGoalExecutionActive(goal.status)) {
			const route = this.deps.getRoute?.();
			if (route && route.objectiveId === goalObjectiveId(goal.goalId)) {
				// System One routed: control is the route's own vocabulary, not the legacy verdict's.
				const reasonCode = route.reasonCodes[0] ?? route.route;
				if (route.route === "owner_required") {
					return {
						owner: "user",
						state: "awaiting_user",
						reasonCode,
						blocker: boundedText(this.deps.getBlocker() ?? "owner authority required"),
					};
				}
				let state: OperatorControlState = "deciding";
				if (reviewableLane) state = "observing";
				else if (ROUTE_EXECUTING.has(route.route)) state = "executing";
				else if (ROUTE_VERIFYING.has(route.route)) state = "verifying";
				else if (ROUTE_ROOT_EXECUTES.has(route.route) && this.deps.isForegroundBusy()) state = "executing";
				return { owner: "system_one", state, reasonCode };
			}
			const reasonCode = continuation?.reasonCode ?? "goal_active";
			let state: OperatorControlState = "deciding";
			if (continuation?.action === "waiting") state = "executing";
			else if (reviewableLane) state = "observing";
			else if (VERIFYING_REASON_CODES.has(reasonCode)) state = "verifying";
			return { owner: "system_one", state, reasonCode };
		}

		return {
			owner: "root",
			state: this.deps.isForegroundBusy() ? "executing" : "deciding",
			reasonCode: goal ? `objective_${goal.status}` : "no_objective",
		};
	}

	private resolveProof(goal: GoalState | undefined): ProofProgress {
		const unresolved = this.deps.getUnresolvedProofIds().length;
		const requirements = goal?.requirements ?? [];
		const satisfied = requirements.filter((requirement) => requirement.status === "satisfied").length;
		const failing = requirements.filter((requirement) => requirement.status === "blocked").length;
		const total = requirements.length + unresolved;
		if (total === 0) return { satisfied: 0, total: 0, failing: 0, pending: 0 };
		return {
			satisfied,
			total,
			failing,
			pending: Math.max(0, total - satisfied - failing),
		};
	}

	private resolvePhase(
		goal: GoalState | undefined,
		lanes: readonly LiveLaneView[],
		proof: ProofProgress,
		adaptation: AdaptationProjection | undefined,
		blocker: string | undefined,
	): OperatorPhase {
		if (blocker) return "blocked";
		if (goal?.status === "blocked") return "blocked";
		if (goal?.status === "completed") return "done";
		if (this.deps.getDeliveryState() === "in_progress") return "deliver";
		if (adaptation) return "adapt";
		if (proof.total > 0 && proof.pending === 0 && proof.failing === 0 && goal) return "verify";
		if (lanes.length > 0) return "build";
		// No objective: a running foreground turn is the root's own work; idle is readiness, not work.
		if (!goal) return this.deps.isForegroundBusy() ? "build" : "understand";
		// A goal with no decomposition yet is still being planned; one with requirements is building.
		return goal.requirements.length === 0 ? "plan" : "build";
	}

	private describeAction(
		phase: OperatorPhase,
		goal: GoalState | undefined,
		lanes: readonly LiveLaneView[],
		adaptation: AdaptationProjection | undefined,
		blocker: string | undefined,
	): string {
		if (blocker) return blocker;
		const fast = this.deps.isFastIteration() && (phase === "build" || phase === "adapt");
		const suffix = fast ? ` · ${FAST_ITERATION_INDICATOR}` : "";
		switch (phase) {
			case "understand":
				return goal ? `Framing ${goal.userGoal}` : "Ready for operator instructions";
			case "plan":
				return `Decomposing ${goal?.userGoal ?? "the objective"}`;
			case "build":
				return `${lanes[0]?.label ?? (goal ? "Implementing" : "Working the operator's turn")}${suffix}`;
			case "adapt":
				return `${adaptation?.label ?? "Adapting the runtime"}${suffix}`;
			case "verify":
				return "Running acceptance proof";
			case "deliver":
				return "Delivering authorized changes";
			case "done":
				return `Completed ${goal?.userGoal ?? "the objective"}`;
			default:
				return "Working";
		}
	}

	private describeWhy(
		phase: OperatorPhase,
		goal: GoalState | undefined,
		proof: ProofProgress,
		blocker: string | undefined,
	): string {
		if (blocker) return blocker;
		if (phase === "understand" && !goal) return "Standing by for user directives";
		if (phase === "verify") return `${proof.satisfied}/${proof.total} acceptance criteria satisfied`;
		if (phase === "done") return `Delivered with ${proof.satisfied}/${proof.total} criteria satisfied`;
		return goal?.userGoal ?? "Advancing the objective";
	}

	private describeNext(phase: OperatorPhase, proof: ProofProgress): string | null {
		if (phase === "build" || phase === "adapt") {
			return proof.pending > 0 ? `verify ${proof.pending} open criteria` : "verify";
		}
		if (phase === "verify") return "deliver";
		return null;
	}

	private resolveActors(lanes: readonly LiveLaneView[]): readonly ActiveActor[] {
		if (lanes.length === 0) return [{ id: "root", kind: "root", label: "Root orchestrator" }];
		return lanes.map((lane) => ({
			id: lane.laneId,
			kind: lane.type === "research" ? "specialist" : "worker",
			label: lane.label ?? `Worker ${lane.laneId.slice(0, 8)}`,
			...(lane.startedAt ? { elapsedMs: Math.max(0, Date.now() - Date.parse(lane.startedAt)) } : {}),
		}));
	}
}

function phaseIndex(phase: OperatorPhase): number {
	const index = PHASE_ORDER.indexOf(phase);
	if (index >= 0) return index + 1;
	// Blocked and done are terminal states outside the ordered walk; both report the full count.
	return PHASE_ORDER.length;
}

function resolveHealth(phase: OperatorPhase): OperatorHealth {
	if (phase === "blocked") return "blocked";
	if (phase === "done") return "complete";
	return "normal";
}
