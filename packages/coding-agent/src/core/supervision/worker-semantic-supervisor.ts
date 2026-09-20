import { randomUUID } from "node:crypto";
import type {
	LiveWorkerAttempt,
	SupervisionObservationState,
	WorkerSupervisionAction,
	WorkerSupervisionSignal,
} from "./types.ts";

export interface SteeringPlane {
	requireCertificate(
		checkpoint: string,
		payload: unknown,
		context?: { objectiveId?: string; taskId?: string; evidenceRevision?: number; signal?: AbortSignal },
	): Promise<{ certificate_id: string; answers?: Record<string, unknown> }>;
}

export interface DecisionEngine {
	evaluate(
		program: unknown,
		state?: Record<string, unknown>,
		options?: { consequence?: string; signal?: AbortSignal },
	): Promise<{
		answers?: Record<string, { type?: string; noul?: number; choice?: string; value?: boolean | number }>;
		results?: Record<string, { kind?: string; confidence?: { value?: number }; selected?: unknown }>;
	}>;
}

export interface WorkerSemanticSupervisorDeps {
	steering?: SteeringPlane;
	decisionEngine?: DecisionEngine;
	debounceMs?: number;
	minToolCalls?: number;
	minElapsedMs?: number;
}

/**
 * WorkerSemanticSupervisor:
 * Bounded live supervision of workers to detect stalls, repetitions, gaps, and readiness for verification.
 * Emits WorkerSupervisionSignal without human loops or expanding authority.
 * Implements FR-060..FR-069.
 */
export class WorkerSemanticSupervisor {
	private readonly steering?: SteeringPlane;
	private readonly decisionEngine?: DecisionEngine;
	private readonly debounceMs: number;
	private readonly minToolCalls: number;
	private readonly minElapsedMs: number;

	private readonly lastAssessmentAt = new Map<string, number>();
	private readonly steeringInterventions = new Map<string, number>();
	private readonly inFlightAssessments = new Set<string>();

	constructor(deps: WorkerSemanticSupervisorDeps) {
		this.steering = deps.steering;
		this.decisionEngine = deps.decisionEngine;
		this.debounceMs = deps.debounceMs ?? 5000;
		this.minToolCalls = deps.minToolCalls ?? 2;
		this.minElapsedMs = deps.minElapsedMs ?? 3000;
	}

	getPriorSteeringCount(attemptId: string): number {
		return this.steeringInterventions.get(attemptId) ?? 0;
	}

	/**
	 * FR-061, FR-062: Checks whether observation is eligible under debounce/threshold rules.
	 */
	shouldAssess(attempt: LiveWorkerAttempt): boolean {
		// FR-062: No assessment for very short workers
		if (attempt.toolCalls < this.minToolCalls && attempt.elapsedMs < this.minElapsedMs) {
			return false;
		}

		if (this.inFlightAssessments.has(attempt.attemptId)) {
			return false;
		}

		const now = Date.now();
		const lastAt = this.lastAssessmentAt.get(attempt.attemptId) ?? 0;
		if (now - lastAt < this.debounceMs) {
			return false;
		}

		return true;
	}

	/**
	 * Observes a live worker attempt and produces a supervision signal if intervention or check is needed.
	 * Implements FR-060..FR-069.
	 */
	async assessWorker(attempt: LiveWorkerAttempt, signal?: AbortSignal): Promise<WorkerSupervisionSignal | undefined> {
		return this.observe(attempt, signal);
	}

	async observe(attempt: LiveWorkerAttempt, signal?: AbortSignal): Promise<WorkerSupervisionSignal | undefined> {
		signal?.throwIfAborted();

		if (!this.shouldAssess(attempt)) {
			return undefined;
		}

		const priorSteeringCount = this.getPriorSteeringCount(attempt.attemptId);

		// FR-061: Bounded observation projection
		const tail = attempt.outputTail ? attempt.outputTail.slice(-2000) : "";
		const state: SupervisionObservationState = {
			objectiveId: attempt.objectiveId,
			taskId: attempt.taskId,
			attemptId: attempt.attemptId,
			mission: attempt.mission,
			elapsedMs: attempt.elapsedMs,
			toolCalls: attempt.toolCalls,
			outputTail: tail,
			changedFiles: attempt.changedFiles ? [...attempt.changedFiles] : [],
			recentFailures: attempt.recentFailures ? [...attempt.recentFailures] : [],
			evidenceRevision: attempt.evidenceRevision ?? 1,
			priorSteeringCount,
		};

		this.inFlightAssessments.add(attempt.attemptId);
		this.lastAssessmentAt.set(attempt.attemptId, Date.now());

		try {
			let certId = `cert-supervision-${Date.now()}`;
			const answers: Record<string, number> = {};

			if (this.steering) {
				const cert = await this.steering.requireCertificate("JEV-WORKER-SUPERVISION", state, {
					objectiveId: attempt.objectiveId,
					taskId: attempt.taskId,
					evidenceRevision: state.evidenceRevision,
					signal,
				});
				certId = cert.certificate_id;
				const rawAnswers = (cert.answers ?? {}) as Record<string, any>;
				for (const [k, v] of Object.entries(rawAnswers)) {
					answers[k] = typeof v?.noul === "number" ? v.noul : typeof v === "number" ? v : v === true ? 1.0 : 0.0;
				}
			} else if (this.decisionEngine) {
				const program = {
					schema_version: "1.0",
					program_id: `supervision_eval_${Date.now()}`,
					description: "Live worker supervision assessment",
					decisions: [
						{
							id: "meaningful_progress",
							kind: "noul",
							type: "noul",
							instruction: "Is the worker making meaningful progress?",
						},
						{
							id: "worker_stuck",
							kind: "noul",
							type: "noul",
							instruction: "Is the worker stuck or making no progress?",
						},
						{
							id: "work_off_track",
							kind: "noul",
							type: "noul",
							instruction: "Has the worker drifted off-track from the mission?",
						},
						{
							id: "strategy_repetition",
							kind: "noul",
							type: "noul",
							instruction: "Is the worker repeating failing strategies without modification?",
						},
						{
							id: "needs_independent_verification",
							kind: "noul",
							type: "noul",
							instruction: "Is the implementation finished and ready for independent verification?",
						},
						{
							id: "specialist_gap_present",
							kind: "noul",
							type: "noul",
							instruction: "Does this require a different domain specialist?",
						},
						{
							id: "capability_gap_present",
							kind: "noul",
							type: "noul",
							instruction: "Is the worker missing an essential capability?",
						},
					],
				};

				const evalRes = await this.decisionEngine.evaluate(program, state as any, {
					consequence: "medium",
					signal,
				});
				const rawAnswers = evalRes.answers ?? (evalRes.results as any) ?? {};
				for (const [k, v] of Object.entries(rawAnswers)) {
					answers[k] =
						typeof (v as any)?.noul === "number"
							? (v as any).noul
							: typeof (v as any)?.value === "number"
								? (v as any).value
								: 0.0;
				}
			} else {
				// Default heuristics if no steering engine is attached
				answers.meaningful_progress = attempt.isStalled ? 0.1 : 0.9;
				answers.worker_stuck = attempt.isStalled ? 0.9 : 0.1;
				answers.strategy_repetition = attempt.isRepeating ? 0.9 : 0.1;
				answers.work_off_track = 0.1;
				answers.needs_independent_verification = 0.1;
				answers.specialist_gap_present = 0.1;
				answers.capability_gap_present = 0.1;
			}

			// FR-064: Deterministic Intervention Policy
			let action: WorkerSupervisionAction = "continue";
			let summaryEvent: string | undefined;
			const reasonCodes: string[] = [];

			if ((answers.specialist_gap_present ?? 0) > 0.5) {
				action = "request_specialist";
				summaryEvent = "Specialist requested · worker mission requires specialist domain";
				reasonCodes.push("specialist_gap_detected");
			} else if ((answers.capability_gap_present ?? 0) > 0.5) {
				action = "request_capability";
				summaryEvent = "Capability requested · worker mission requires synthesized capability";
				reasonCodes.push("capability_gap_detected");
			} else if ((answers.needs_independent_verification ?? 0) > 0.5) {
				action = "request_verifier";
				summaryEvent = "Verification requested · implementation complete, independent proof missing";
				reasonCodes.push("independent_verification_needed");
			} else if (
				(answers.worker_stuck ?? 0) > 0.5 ||
				(answers.strategy_repetition ?? 0) > 0.5 ||
				(answers.work_off_track ?? 0) > 0.5 ||
				attempt.isStalled ||
				attempt.isRepeating
			) {
				// FR-065: Anti-oscillation (one steer + grace period, then stop and reroute). Off-track
				// work is redirected now, not at the worker's next turn; a stall waits for that turn.
				if (priorSteeringCount === 0 && (answers.work_off_track ?? 0) > 0.5) {
					action = "steer_now";
					this.steeringInterventions.set(attempt.attemptId, 1);
					summaryEvent = "Worker redirected now · work off the mission";
					reasonCodes.push("worker_off_track_steer_now");
				} else if (priorSteeringCount === 0) {
					action = "steer_once";
					this.steeringInterventions.set(attempt.attemptId, 1);
					summaryEvent = "Worker steering initiated · progress stalled or strategy repeating";
					reasonCodes.push("worker_stuck_steer_once");
				} else {
					action = "stop_and_reroute";
					summaryEvent = "Worker rerouted · implementation stalled after repeated test failure";
					reasonCodes.push("worker_stalled_repeated_reroute");
				}
			} else {
				action = "continue";
				// FR-068: CONTINUE is silent in UI
				summaryEvent = undefined;
				reasonCodes.push("worker_progressing_normally");
			}

			const signalRecord: WorkerSupervisionSignal = {
				schema_version: "1.0",
				signal_id: `sig-${randomUUID().slice(0, 8)}`,
				objective_id: attempt.objectiveId,
				task_id: attempt.taskId,
				attempt_id: attempt.attemptId,
				action,
				certificate_id: certId,
				reason_codes: reasonCodes,
				created_at: new Date().toISOString(),
				explanation: summaryEvent ?? `Supervisor observed worker state: action=${action}`,
				summaryEvent,
			};

			return signalRecord;
		} finally {
			this.inFlightAssessments.delete(attempt.attemptId);
		}
	}
}
