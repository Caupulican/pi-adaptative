/**
 * Live operator projection for a session.
 *
 * The projection is derived from canonical runtime state on every read — the goal, its
 * requirements and evidence, the live worker lanes, unresolved proof obligations, the adaptive
 * runtime's current work, the charter's delivery authority and the context window. Nothing here is
 * a literal the UI hands itself, and nothing is a second copy of state that could drift.
 * Conforms to OPERATOR_TUI_LIVE_BINDING.md and RCG-050..RCG-055.
 */

import type { GoalState } from "../goals/goal-state.ts";
import { OperatorEventController } from "./operator-event-controller.ts";
import { OperatorProjectionController } from "./operator-projection-controller.ts";
import type {
	ActiveActor,
	AdaptationProjection,
	OperatorEvent,
	OperatorHealth,
	OperatorPhase,
	OperatorProjection,
	ProofProgress,
} from "./types.ts";

/** One running worker, as the lane tracker knows it. */
export interface LiveLaneView {
	readonly laneId: string;
	readonly type: string;
	readonly status: string;
	readonly label?: string;
	readonly startedAt?: string;
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
}

const PHASE_ORDER: readonly OperatorPhase[] = ["understand", "plan", "build", "adapt", "verify", "deliver"];

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
		const lanes = this.deps.getLanes().filter((lane) => lane.status === "running" || lane.status === "queued");
		const proof = this.resolveProof(goal);
		const adaptation = this.deps.getAdaptation();
		const blocker = this.deps.getBlocker();
		const phase = this.resolvePhase(goal, lanes, proof, adaptation, blocker);

		return this.projectionController.updateProjection({
			title: this.deps.getTitle(),
			phase,
			phase_index: phaseIndex(phase),
			phase_count: PHASE_ORDER.length,
			current_action: this.describeAction(phase, goal, lanes, adaptation, blocker),
			why: this.describeWhy(phase, goal, proof, blocker),
			next_action: this.describeNext(phase, proof),
			health: resolveHealth(phase),
			active_actors: this.resolveActors(lanes),
			adaptation: adaptation ?? null,
			proof,
			context: this.deps.getContext() ?? null,
		});
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
		if (!goal) return "understand";
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
				return `${lanes[0]?.label ?? "Implementing"}${suffix}`;
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
