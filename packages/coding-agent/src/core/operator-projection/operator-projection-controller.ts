import { randomUUID } from "node:crypto";
import type {
	ActiveActor,
	AdaptationProjection,
	OperatorContextInfo,
	OperatorEvent,
	OperatorHealth,
	OperatorPhase,
	OperatorProjection,
	ProofProgress,
} from "./types.ts";

export interface OperatorProjectionInit {
	objectiveId: string;
	title: string;
	phase?: OperatorPhase;
	phaseIndex?: number;
	phaseCount?: number;
	currentAction?: string;
	why?: string;
	nextAction?: string | null;
	health?: OperatorHealth;
	activeActors?: readonly ActiveActor[];
	adaptation?: AdaptationProjection | null;
	proof?: ProofProgress;
	context?: OperatorContextInfo | null;
}

/**
 * OperatorProjectionController:
 * Pure canonical projection of runtime state for human operators and UIs.
 * Exposes OperatorProjection and OperatorEvent streams without LLM dependencies.
 * Implements FR-110..FR-119.
 */
export class OperatorProjectionController {
	private projection: OperatorProjection;
	private readonly events: OperatorEvent[] = [];
	private readonly projectionListeners = new Set<(projection: OperatorProjection) => void>();
	private readonly eventListeners = new Set<(event: OperatorEvent) => void>();

	constructor(init: OperatorProjectionInit) {
		this.projection = {
			schema_version: "1.0",
			objective_id: init.objectiveId,
			title: init.title,
			phase: init.phase ?? "understand",
			phase_index: init.phaseIndex ?? 1,
			phase_count: init.phaseCount ?? 5,
			current_action: init.currentAction ?? "Analyzing objective requirements",
			why: init.why ?? "Initial objective framing",
			next_action: init.nextAction ?? null,
			health: init.health ?? "normal",
			active_actors: init.activeActors ?? [{ id: "root", kind: "root", label: "Root orchestrator" }],
			adaptation: init.adaptation ?? null,
			proof: init.proof ?? { satisfied: 0, total: 1, failing: 0, pending: 1 },
			context: init.context ?? null,
		};
	}

	getProjection(): OperatorProjection {
		return this.projection;
	}

	updateProjection(patch: Partial<Omit<OperatorProjection, "schema_version" | "objective_id">>): OperatorProjection {
		this.projection = {
			...this.projection,
			...patch,
			schema_version: "1.0",
			objective_id: this.projection.objective_id,
		};

		for (const listener of this.projectionListeners) {
			try {
				listener(this.projection);
			} catch {
				// Listeners must not break controller state
			}
		}

		return this.projection;
	}

	/**
	 * FR-111, FR-112, FR-113, FR-114, FR-115, FR-116, FR-117, FR-118:
	 * Convenience method to transition phase and update proof progress.
	 */
	transitionPhase(
		phase: OperatorPhase,
		phaseIndex: number,
		options: {
			currentAction?: string;
			why?: string;
			nextAction?: string | null;
			health?: OperatorHealth;
			adaptation?: AdaptationProjection | null;
			proof?: Partial<ProofProgress>;
			activeActors?: readonly ActiveActor[];
		} = {},
	): OperatorProjection {
		const updatedProof: ProofProgress = options.proof
			? {
					satisfied: options.proof.satisfied ?? this.projection.proof.satisfied,
					total: options.proof.total ?? this.projection.proof.total,
					failing: options.proof.failing ?? this.projection.proof.failing,
					pending: options.proof.pending ?? this.projection.proof.pending,
				}
			: this.projection.proof;

		return this.updateProjection({
			phase,
			phase_index: phaseIndex,
			current_action: options.currentAction ?? this.projection.current_action,
			why: options.why ?? this.projection.why,
			next_action: options.nextAction !== undefined ? options.nextAction : this.projection.next_action,
			health: options.health ?? (phase === "blocked" ? "blocked" : phase === "done" ? "complete" : "normal"),
			adaptation: options.adaptation !== undefined ? options.adaptation : this.projection.adaptation,
			proof: updatedProof,
			active_actors: options.activeActors ?? this.projection.active_actors,
		});
	}

	/**
	 * FR-119: Emit an operator event.
	 */
	emitEvent(
		eventInput: (Omit<OperatorEvent, "id" | "timestamp"> & { id?: string; timestamp?: string }) | OperatorEvent,
	): OperatorEvent {
		const event: OperatorEvent = {
			id: eventInput.id ?? randomUUID(),
			timestamp: eventInput.timestamp ?? new Date().toISOString(),
			severity: eventInput.severity,
			category: eventInput.category,
			title: eventInput.title,
			detail: eventInput.detail,
			debugRefs: eventInput.debugRefs,
		};

		this.events.push(event);

		for (const listener of this.eventListeners) {
			try {
				listener(event);
			} catch {
				// Listeners must not break controller state
			}
		}

		return event;
	}

	getEvents(): readonly OperatorEvent[] {
		return [...this.events];
	}

	/**
	 * FR-129, FR-130..FR-134: Filter out routine internal events from user-facing presentation.
	 */
	getVisibleEvents(): readonly OperatorEvent[] {
		return this.events.filter((e) => {
			// Routine supervisor CONTINUE is silent
			if (e.category === "worker" && e.title.includes("CONTINUE") && e.severity === "info") {
				return false;
			}
			// Passing semantic rules are silent
			if (e.category === "rule" && e.title.includes("passed") && e.severity === "info") {
				return false;
			}
			// Successful acquisition checks are silent
			if (e.category === "acquisition" && e.title.includes("verified") && e.severity === "info") {
				return false;
			}
			// Routine tool calls or raw Jev certificates hidden
			if (e.title.startsWith("JEV:") || e.title.startsWith("Certificate:")) {
				return false;
			}
			return true;
		});
	}

	subscribe(listener: (projection: OperatorProjection) => void): () => void {
		this.projectionListeners.add(listener);
		return () => {
			this.projectionListeners.delete(listener);
		};
	}

	onEvent(listener: (event: OperatorEvent) => void): () => void {
		this.eventListeners.add(listener);
		return () => {
			this.eventListeners.delete(listener);
		};
	}
}
