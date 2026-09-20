/**
 * Live worker supervision binding.
 *
 * The supervisor observes real worker lifecycle events — one observation per executed tool call —
 * and its signals are consumed by root control through the existing worker-control surface:
 * a steer is delivered as a steering message on that worker's own lane, a reroute cancels the lane,
 * and every other signal is recorded for the root to retrieve.
 *
 * The supervisor can never complete the root objective: `WorkerSupervisionAction` contains no
 * terminal outcome, and this coordinator exposes no path to one.
 * Conforms to GOVERNANCE_LIVE_PATHS.md and RCG-044, RCG-014.
 */

import type { LiveWorkerAttempt, WorkerSupervisionAction, WorkerSupervisionSignal } from "./types.ts";
import type { WorkerSemanticSupervisor } from "./worker-semantic-supervisor.ts";

/**
 * Root control surface the supervisor is allowed to reach: the session's existing worker-agent
 * control, keyed the same way (`agentId`). The supervisor adds no new authority.
 */
export interface WorkerControlPort {
	/** Deliver one steering message to a running worker. */
	steerWorker(agentId: string, directive: string): Promise<void> | void;
	/** Stop a running worker so the root can reroute its work. */
	cancelWorker(agentId: string, reason: string): Promise<void> | void;
}

export interface WorkerSupervisionCoordinatorDeps {
	supervisor: WorkerSemanticSupervisor;
	control: WorkerControlPort;
	/** Bounded operator-visible notice for an intervention. Routine continuation stays silent. */
	onIntervention?(signal: WorkerSupervisionSignal): void;
	/** A failed assessment, reported as a diagnostic rather than failing the observed worker. */
	onSupervisionError?(error: unknown): void;
}

/** One live worker observation, assembled by the lane that is actually running the worker. */
export interface WorkerProgressObservation extends LiveWorkerAttempt {
	/** The worker-agent identity the session's control surface addresses. */
	readonly agentId: string;
	/** Tool names of the most recent executed calls, for the deterministic churn check. */
	readonly recentToolNames?: readonly string[];
	/** Changed-file count when the current churn window opened. */
	readonly changedFileCountAtWindowStart?: number;
	readonly changedFileCount?: number;
}

/**
 * Directive text for a steer. It names the correction rather than restating the mission, and the
 * validation-churn case carries the owner's fast-iteration correction verbatim.
 */
export const VALIDATION_CHURN_DIRECTIVE = [
	"STOP VERIFICATION CHURN.",
	"Return to implementation.",
	"Use only the cheapest targeted proof required for the current fact.",
	"Full regression belongs to VERIFY.",
].join(" ");

const STALL_DIRECTIVE =
	"Progress has stalled or the same strategy is repeating. Change approach before the next tool call.";

/** Tool names whose repeated use with no file change is validation, not implementation. */
const BROAD_VALIDATION_TOOLS: readonly string[] = ["bash", "run_process", "python"];
const VALIDATION_CHURN_THRESHOLD = 3;

/**
 * Recognizes repeated broad validation with no new implementation.
 *
 * This is the owner's fast-iteration rule expressed as an observation: several consecutive broad
 * validation calls while the changed-file set did not grow means the worker is re-proving instead
 * of building.
 */
export function isValidationChurn(observation: {
	readonly recentToolNames?: readonly string[];
	readonly changedFileCountAtWindowStart?: number;
	readonly changedFileCount?: number;
}): boolean {
	const changedNow = observation.changedFileCount ?? 0;
	const changedAtStart = observation.changedFileCountAtWindowStart ?? 0;
	if (changedNow > changedAtStart) return false;
	const recent = (observation.recentToolNames ?? []).slice(-VALIDATION_CHURN_THRESHOLD);
	return recent.length >= VALIDATION_CHURN_THRESHOLD && recent.every((name) => BROAD_VALIDATION_TOOLS.includes(name));
}

export class WorkerSupervisionCoordinator {
	private readonly deps: WorkerSupervisionCoordinatorDeps;
	private readonly signals: WorkerSupervisionSignal[] = [];

	constructor(deps: WorkerSupervisionCoordinatorDeps) {
		this.deps = deps;
	}

	/** Every signal this session's supervisor produced, newest last. */
	getSignals(): readonly WorkerSupervisionSignal[] {
		return [...this.signals];
	}

	/** Signals the root has not yet acted on that ask for a new owner (specialist, capability, verifier). */
	getPendingRootRequests(): readonly WorkerSupervisionSignal[] {
		return this.signals.filter(
			(signal) =>
				signal.action === "request_specialist" ||
				signal.action === "request_capability" ||
				signal.action === "request_verifier",
		);
	}

	/**
	 * Observes one live worker event and applies the resulting signal through root control.
	 * Returns the signal when the supervisor produced one, so the caller can record it.
	 */
	async observe(
		observation: WorkerProgressObservation,
		signal?: AbortSignal,
	): Promise<WorkerSupervisionSignal | undefined> {
		// The deterministic churn check needs no semantic judgment and runs first.
		if (isValidationChurn(observation)) {
			return this.steerValidationChurn(observation.agentId, observation);
		}
		let verdict: WorkerSupervisionSignal | undefined;
		try {
			verdict = await this.deps.supervisor.observe(observation, signal);
		} catch (error) {
			// Supervision is advisory. A failed assessment must never fail the worker it observes;
			// the worker keeps running and no intervention is applied on unknown state.
			this.deps.onSupervisionError?.(error);
			return undefined;
		}
		if (!verdict) return undefined;
		this.signals.push(verdict);
		await this.apply(verdict, observation);
		return verdict;
	}

	/**
	 * Steers a worker back to implementation when it is re-running broad validation instead of
	 * building. This is deterministic: it does not need a semantic judgment to fire, and it is
	 * applied through the same control surface as any other steer.
	 */
	async steerValidationChurn(agentId: string, attempt: LiveWorkerAttempt): Promise<WorkerSupervisionSignal> {
		const verdict: WorkerSupervisionSignal = {
			schema_version: "1.0",
			signal_id: `sig-churn-${attempt.attemptId}-${this.signals.length + 1}`,
			objective_id: attempt.objectiveId,
			task_id: attempt.taskId,
			attempt_id: attempt.attemptId,
			action: "steer_once",
			certificate_id: "deterministic:validation_churn",
			reason_codes: ["validation_churn_without_implementation"],
			created_at: new Date().toISOString(),
			explanation: VALIDATION_CHURN_DIRECTIVE,
			summaryEvent: "Worker steered · repeated broad validation with no new implementation",
		};
		this.signals.push(verdict);
		await this.deps.control.steerWorker(agentId, VALIDATION_CHURN_DIRECTIVE);
		this.deps.onIntervention?.(verdict);
		return verdict;
	}

	private async apply(verdict: WorkerSupervisionSignal, observation: WorkerProgressObservation): Promise<void> {
		const action: WorkerSupervisionAction = verdict.action;
		if (action === "continue") return;

		if (action === "steer_once") {
			await this.deps.control.steerWorker(observation.agentId, verdict.explanation ?? STALL_DIRECTIVE);
		} else if (action === "stop_and_reroute") {
			await this.deps.control.cancelWorker(
				observation.agentId,
				verdict.summaryEvent ?? "supervisor requested reroute",
			);
		}
		// request_verifier / request_specialist / request_capability / mark_external_block are root
		// decisions: they are recorded for the root to retrieve, never executed here.
		this.deps.onIntervention?.(verdict);
	}
}
