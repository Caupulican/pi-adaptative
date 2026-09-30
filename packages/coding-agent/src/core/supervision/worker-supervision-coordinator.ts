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

import { MAX_ORCHESTRATION_ATTEMPTS } from "../orchestration/contracts.ts";
import { classifyCommandFamily } from "../tools/command-family.ts";
import type { LiveWorkerAttempt, WorkerSupervisionAction, WorkerSupervisionSignal } from "./types.ts";
import type { WorkerSemanticSupervisor } from "./worker-semantic-supervisor.ts";

/**
 * Root control surface the supervisor is allowed to reach: the session's existing worker-agent
 * control, keyed the same way (`agentId`). The supervisor adds no new authority.
 */
export interface WorkerControlPort {
	/** Deliver one steering message: for the worker's next model turn, or now (interrupt, queue, resume). */
	steerWorker(agentId: string, directive: string, delivery?: "queue" | "now"): Promise<void> | void;
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
	/** Whether an attempt is still live (not terminal); a request from a finished attempt is stale. */
	isAttemptLive?(attemptId: string): boolean;
}

/** One live worker observation, assembled by the lane that is actually running the worker. */
export interface WorkerProgressObservation extends LiveWorkerAttempt {
	/** The worker-agent identity the session's control surface addresses. */
	readonly agentId: string;
	/** Tool names of the most recent executed calls, for the deterministic churn check. */
	readonly recentToolNames?: readonly string[];
	/** Tool calls behind those names, so discovery is not mistaken for tests or diagnostics. */
	readonly recentToolCalls?: readonly { name: string; args: unknown }[];
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
/** A worker judged off track is interrupted and redirected now; waiting for its next turn wastes the turn. */
const OFF_TRACK_DIRECTIVE =
	"System One: the current work is off the mission. Stop the current line of work, return to the mission's open requirements, and say what you are doing next.";

const VALIDATION_CHURN_THRESHOLD = 3;

function commandFromToolCall(call: { name: string; args: unknown }): string | undefined {
	if (!call.args || typeof call.args !== "object" || Array.isArray(call.args)) return undefined;
	const args = call.args as Record<string, unknown>;
	if (typeof args.command === "string") return args.command;
	if (typeof args.code === "string") return args.code;
	if (typeof args.executable !== "string") return undefined;
	return [
		args.executable,
		...(Array.isArray(args.args) ? args.args.filter((arg): arg is string => typeof arg === "string") : []),
	]
		.join(" ")
		.trim();
}

function isBroadValidationCall(call: { name: string; args: unknown }): boolean {
	if (call.name !== "bash" && call.name !== "run_process" && call.name !== "python") return false;
	const command = commandFromToolCall(call);
	if (!command) return false;
	const classification = classifyCommandFamily(command);
	if (classification.family === "test" || classification.family === "diagnostics") return true;
	return (
		classification.family === "package-manager" &&
		/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|check|lint|test)(?:\s|$)/u.test(command.trim())
	);
}

/**
 * Recognizes repeated broad validation with no new implementation.
 *
 * This is the owner's fast-iteration rule expressed as an observation: several consecutive broad
 * validation calls while the changed-file set did not grow means the worker is re-proving instead
 * of building.
 */
export function isValidationChurn(observation: {
	readonly recentToolNames?: readonly string[];
	readonly recentToolCalls?: readonly { name: string; args: unknown }[];
	readonly changedFileCountAtWindowStart?: number;
	readonly changedFileCount?: number;
}): boolean {
	const changedNow = observation.changedFileCount ?? 0;
	const changedAtStart = observation.changedFileCountAtWindowStart ?? 0;
	if (changedNow > changedAtStart) return false;
	const recentCalls = (observation.recentToolCalls ?? []).slice(-VALIDATION_CHURN_THRESHOLD);
	if (recentCalls.length >= VALIDATION_CHURN_THRESHOLD) return recentCalls.every(isBroadValidationCall);
	const recent = (observation.recentToolNames ?? []).slice(-VALIDATION_CHURN_THRESHOLD);
	return (
		recent.length >= VALIDATION_CHURN_THRESHOLD &&
		recent.every((name) => name === "bash" || name === "run_process" || name === "python")
	);
}

export class WorkerSupervisionCoordinator {
	private readonly deps: WorkerSupervisionCoordinatorDeps;
	private readonly signals: WorkerSupervisionSignal[] = [];
	private readonly lastErrorTimestamp = new Map<string, number>();
	private readonly pendingRootRequests = new Map<string, WorkerSupervisionSignal>();
	private nextDeterministicSignalSequence = 0;

	constructor(deps: WorkerSupervisionCoordinatorDeps) {
		this.deps = deps;
	}

	/** Bounded history of this session's supervisor signals, newest last. */
	getSignals(): readonly WorkerSupervisionSignal[] {
		return [...this.signals];
	}

	/** Signals the root has not yet acted on that ask for a new owner (specialist, capability, verifier). */
	getPendingRootRequests(): readonly WorkerSupervisionSignal[] {
		// Pending ownership is independent of observational history: capacity eviction cannot silently
		// discard work the root has not consumed. A terminal attempt makes that ownership permanently stale.
		for (const [key, signal] of this.pendingRootRequests) {
			if (this.deps.isAttemptLive && !this.deps.isAttemptLive(signal.attempt_id)) {
				this.pendingRootRequests.delete(key);
			}
		}
		return [...this.pendingRootRequests.values()];
	}

	consumePendingRootRequest(signalId: string): void {
		for (const [key, signal] of this.pendingRootRequests) {
			if (signal.signal_id !== signalId) continue;
			this.pendingRootRequests.delete(key);
			return;
		}
	}

	private reportError(attemptId: string, error: unknown): void {
		const text = error instanceof Error ? error.message : String(error);
		const fingerprint = `${attemptId}:${text}`;
		const lastReportedAt = this.lastErrorTimestamp.get(fingerprint);
		const now = Date.now();
		// F12: Debounce repeated identical supervision/control errors for the same attempt by 30 seconds.
		if (lastReportedAt !== undefined && now - lastReportedAt <= 30_000) return;
		this.lastErrorTimestamp.delete(fingerprint);
		this.lastErrorTimestamp.set(fingerprint, now);
		if (this.lastErrorTimestamp.size > MAX_ORCHESTRATION_ATTEMPTS) {
			const oldest = this.lastErrorTimestamp.keys().next().value;
			if (oldest !== undefined) this.lastErrorTimestamp.delete(oldest);
		}
		try {
			this.deps.onSupervisionError?.(error);
		} catch {
			// A diagnostic observer is outside supervision authority and cannot fail the worker.
		}
	}

	private clearErrors(attemptId: string): void {
		for (const key of this.lastErrorTimestamp.keys()) {
			if (key.startsWith(`${attemptId}:`)) this.lastErrorTimestamp.delete(key);
		}
	}

	/**
	 * Observes one live worker event and applies the resulting signal through root control.
	 * Returns the signal when the supervisor produced one, so the caller can record it.
	 */
	async observe(
		observation: WorkerProgressObservation,
		signal?: AbortSignal,
	): Promise<WorkerSupervisionSignal | undefined> {
		if (signal?.aborted) return undefined;
		// The deterministic churn check needs no semantic judgment and runs first. It applies to the role
		// whose job is building: re-running validation is a verifier's or explorer's work, not churn.
		if (observation.role === "implementer" && isValidationChurn(observation)) {
			const steered = this.deps.supervisor.getPriorSteeringCount(observation.attemptId) > 0;
			if (!steered || this.deps.supervisor.steerGraceElapsed(observation.attemptId, observation.toolCalls))
				return this.steerValidationChurn(observation.agentId, observation, signal);
		}
		let verdict: WorkerSupervisionSignal | undefined;
		try {
			verdict = await this.deps.supervisor.observe(observation, signal);
		} catch (error) {
			// Supervision is advisory. A failed assessment must never fail the worker it observes;
			// the worker keeps running and no intervention is applied on unknown state.
			this.reportError(observation.attemptId, error);
			return undefined;
		}
		if (!verdict) return undefined;
		return this.applyAndRecord(verdict, observation, STALL_DIRECTIVE, signal);
	}

	/**
	 * Steers a worker back to implementation when it is re-running broad validation instead of
	 * building. This is deterministic: it does not need a semantic judgment to fire, and it is
	 * applied through the same control surface as any other steer.
	 */
	async steerValidationChurn(
		agentId: string,
		attempt: LiveWorkerAttempt,
		signal?: AbortSignal,
	): Promise<WorkerSupervisionSignal | undefined> {
		const prior = this.deps.supervisor.getPriorSteeringCount(attempt.attemptId);
		const reroute = prior > 0;
		const verdict: WorkerSupervisionSignal = {
			schema_version: "1.0",
			signal_id: `sig-churn-${attempt.attemptId}-${++this.nextDeterministicSignalSequence}`,
			objective_id: attempt.objectiveId,
			task_id: attempt.taskId,
			attempt_id: attempt.attemptId,
			action: reroute ? "stop_and_reroute" : "steer_once",
			certificate_id: "deterministic:validation_churn",
			reason_codes: reroute
				? ["validation_churn_without_implementation", "worker_stalled_repeated_reroute"]
				: ["validation_churn_without_implementation"],
			created_at: new Date().toISOString(),
			explanation: reroute
				? "Worker rerouted · repeated broad validation after a prior steer"
				: VALIDATION_CHURN_DIRECTIVE,
			summaryEvent: reroute
				? "Worker rerouted · repeated broad validation with no new implementation"
				: "Worker steered · repeated broad validation with no new implementation",
		};
		return this.applyAndRecord(verdict, { ...attempt, agentId }, VALIDATION_CHURN_DIRECTIVE, signal);
	}

	private async applyControl(
		verdict: WorkerSupervisionSignal,
		observation: WorkerProgressObservation,
		steerDirective: string,
	): Promise<void> {
		const action: WorkerSupervisionAction = verdict.action;
		if (action === "continue") return;

		// The worker receives the directive; the signal's explanation is the operator's label for it.
		if (action === "steer_once") {
			await this.deps.control.steerWorker(observation.agentId, steerDirective, "queue");
		} else if (action === "steer_now") {
			await this.deps.control.steerWorker(observation.agentId, OFF_TRACK_DIRECTIVE, "now");
		} else if (action === "stop_and_reroute") {
			await this.deps.control.cancelWorker(
				observation.agentId,
				verdict.summaryEvent ?? "supervisor requested reroute",
			);
		}
	}

	private async applyAndRecord(
		verdict: WorkerSupervisionSignal,
		observation: WorkerProgressObservation,
		steerDirective = STALL_DIRECTIVE,
		signal?: AbortSignal,
	): Promise<WorkerSupervisionSignal | undefined> {
		// An assessment can settle after its attempt. Fence at the shared control boundary so a stale
		// signal cannot steer or cancel a newer assignment on the same persistent logical agent.
		if (
			verdict.objective_id !== observation.objectiveId ||
			verdict.task_id !== observation.taskId ||
			verdict.attempt_id !== observation.attemptId ||
			signal?.aborted ||
			(this.deps.isAttemptLive && !this.deps.isAttemptLive(observation.attemptId))
		) {
			return undefined;
		}
		try {
			await this.applyControl(verdict, observation, steerDirective);
		} catch (error) {
			// The command did not cross its authority boundary. It is neither a delivered steer nor a
			// completed reroute, and identical evidence must remain eligible for a safe retry.
			this.deps.supervisor.invalidateAssessment(observation.attemptId);
			this.reportError(observation.attemptId, error);
			return undefined;
		}
		if (verdict.action === "steer_once" || verdict.action === "steer_now") {
			this.deps.supervisor.noteSteering(observation.attemptId, observation.toolCalls);
		}
		this.clearErrors(observation.attemptId);
		this.signals.push(verdict);
		if (this.signals.length > MAX_ORCHESTRATION_ATTEMPTS) {
			this.signals.splice(0, this.signals.length - MAX_ORCHESTRATION_ATTEMPTS);
		}
		if (
			verdict.action === "request_specialist" ||
			verdict.action === "request_capability" ||
			verdict.action === "request_verifier" ||
			verdict.action === "mark_external_block"
		) {
			this.pendingRootRequests.set(`${verdict.attempt_id}\u0000${verdict.action}`, verdict);
		}
		if (verdict.action !== "continue") {
			try {
				// request_verifier / request_specialist / request_capability / mark_external_block are root
				// decisions: recorded for root retrieval, never executed here.
				this.deps.onIntervention?.(verdict);
			} catch (error) {
				this.reportError(observation.attemptId, error);
			}
		}
		return verdict;
	}
}
