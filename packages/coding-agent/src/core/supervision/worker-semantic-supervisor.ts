import { randomUUID } from "node:crypto";
import { compileDecisionProgramForCheckpoint } from "../steering/programs.ts";
import { evaluateNoul, noulFromAnswer } from "../system-one/policy.ts";
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
	maxFailures?: number;
}

/**
 * Tool calls a worker makes after a steer before it can be rerouted for the same problem: one full
 * observation window (the churn check's window), enough for the steer to reach a model turn and show.
 */
export const STEER_GRACE_TOOL_CALLS = 3;

export const WORKER_SUPERVISION_DECISION_IDS = [
	"meaningful_progress",
	"worker_stuck",
	"work_off_track",
	"strategy_repetition",
	"needs_independent_verification",
	"specialist_gap_present",
	"capability_gap_present",
	"external_block_present",
] as const;

function noulOf(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (value === true) return 1;
	if (value === false) return 0;
	if (value && typeof value === "object") {
		const record = value as { probabilityTrue?: unknown; noul?: unknown; value?: unknown };
		if (typeof record.probabilityTrue === "number" && Number.isFinite(record.probabilityTrue))
			return record.probabilityTrue;
		if (typeof record.noul === "number" && Number.isFinite(record.noul)) return record.noul;
		if (typeof record.value === "number" && Number.isFinite(record.value)) return record.value;
		if (record.value === true) return 1;
		if (record.value === false) return 0;
	}
	return undefined;
}

function requireSupervisionAnswers(raw: Record<string, unknown>): Record<string, number> {
	const answers: Record<string, number> = {};
	for (const id of WORKER_SUPERVISION_DECISION_IDS) {
		const noul = noulOf(raw[id]);
		if (noul === undefined) {
			throw new Error(`Missing answer for boolean decision '${id}'`);
		}
		answers[id] = noul;
	}
	return answers;
}

/** Semantic supervision stopped for one attempt after repeated evaluation failures; the worker continues. */
export class WorkerSupervisionPausedError extends Error {
	readonly attemptId: string;
	readonly failures: number;

	constructor(attemptId: string, failures: number, cause: unknown) {
		super(
			`Worker supervision paused for attempt ${attemptId} after ${failures} failed evaluations; the worker continues unsupervised: ${cause instanceof Error ? cause.message : String(cause)}`,
			{ cause },
		);
		this.name = "WorkerSupervisionPausedError";
		this.attemptId = attemptId;
		this.failures = failures;
	}
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
	private readonly lastAssessmentHash = new Map<string, string>();
	private readonly steeringInterventions = new Map<string, number>();
	private readonly steeredAtToolCalls = new Map<string, number>();
	private readonly inFlightAssessments = new Set<string>();
	private readonly consecutiveFailures = new Map<string, number>();
	private readonly openBreakers = new Set<string>();
	private readonly maxFailures: number;

	constructor(deps: WorkerSemanticSupervisorDeps) {
		this.steering = deps.steering;
		this.decisionEngine = deps.decisionEngine;
		this.debounceMs = deps.debounceMs ?? 5000;
		this.minToolCalls = deps.minToolCalls ?? 2;
		this.minElapsedMs = deps.minElapsedMs ?? 3000;
		this.maxFailures = deps.maxFailures ?? 3;
	}

	getPriorSteeringCount(attemptId: string): number {
		return this.steeringInterventions.get(attemptId) ?? 0;
	}

	/**
	 * Share anti-oscillation with deterministic churn steers on the same attempt. `toolCalls` is the
	 * attempt's executed tool-call count when the steer was sent, the start of its grace window.
	 */
	noteSteering(attemptId: string, toolCalls = 0): number {
		const next = this.getPriorSteeringCount(attemptId) + 1;
		this.steeringInterventions.set(attemptId, next);
		this.steeredAtToolCalls.set(attemptId, toolCalls);
		return next;
	}

	/**
	 * Whether the worker has had the chance to act on its last steer: a full observation window of tool
	 * calls made after the steer was sent. A steer is delivered at the worker's next model turn, so a
	 * reroute before then cancels a worker that never saw the correction.
	 */
	steerGraceElapsed(attemptId: string, toolCalls: number): boolean {
		const steeredAt = this.steeredAtToolCalls.get(attemptId);
		return steeredAt === undefined || toolCalls - steeredAt >= STEER_GRACE_TOOL_CALLS;
	}

	/**
	 * The evidence an assessment is about. An unchanged key is not assessed again. Whether the steer's
	 * grace window has elapsed is part of it: a stalled worker's evidence never changes, and the
	 * assessment after the window is the one that can reroute it.
	 */
	private assessmentKey(attempt: LiveWorkerAttempt): string {
		const tail = attempt.outputTail ? attempt.outputTail.slice(-2000) : "";
		return [
			attempt.evidenceRevision ?? 1,
			tail,
			Boolean(attempt.isStalled),
			Boolean(attempt.isRepeating),
			this.getPriorSteeringCount(attempt.attemptId),
			this.steerGraceElapsed(attempt.attemptId, attempt.toolCalls),
		].join(":");
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

		const hashStr = this.assessmentKey(attempt);
		const lastHash = this.lastAssessmentHash.get(attempt.attemptId);
		if (lastHash === hashStr) {
			return false; // No material state change
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

		if (this.openBreakers.has(attempt.attemptId)) {
			return undefined;
		}

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
			isStalled: Boolean(attempt.isStalled),
			isRepeating: Boolean(attempt.isRepeating),
		};

		this.inFlightAssessments.add(attempt.attemptId);
		this.lastAssessmentAt.set(attempt.attemptId, Date.now());
		this.lastAssessmentHash.set(attempt.attemptId, this.assessmentKey(attempt));

		try {
			let certId = `cert-supervision-${Date.now()}`;
			let answers: Record<string, number>;

			try {
				if (this.steering) {
					const cert = await this.steering.requireCertificate("JEV-WORKER-SUPERVISION", state, {
						objectiveId: attempt.objectiveId,
						taskId: attempt.taskId,
						evidenceRevision: state.evidenceRevision,
						signal,
					});
					certId = cert.certificate_id;
					answers = requireSupervisionAnswers((cert.answers ?? {}) as Record<string, unknown>);
				} else if (this.decisionEngine) {
					// The same canonical program the steering plane compiles; never an inline copy.
					const evalRes = await this.decisionEngine.evaluate(
						compileDecisionProgramForCheckpoint("JEV-WORKER-SUPERVISION", state),
						state as unknown as Record<string, unknown>,
						{ consequence: "medium", signal },
					);
					// Per decision: the normalized result when present, else the raw answer. An empty
					// `results` object must not hide populated answers.
					const merged: Record<string, unknown> = {};
					for (const id of WORKER_SUPERVISION_DECISION_IDS) {
						merged[id] = evalRes.results?.[id] ?? evalRes.answers?.[id];
					}
					answers = requireSupervisionAnswers(merged);
				} else {
					// Unbound supervisor (tests / no plane): local stall/repeat heuristics, never empty answers.
					answers = {
						meaningful_progress: attempt.isStalled ? 0.1 : 0.9,
						worker_stuck: attempt.isStalled ? 0.9 : 0.1,
						strategy_repetition: attempt.isRepeating ? 0.9 : 0.1,
						work_off_track: 0.1,
						needs_independent_verification: 0.1,
						specialist_gap_present: 0.1,
						capability_gap_present: 0.1,
						external_block_present: 0.1,
					};
				}
				this.consecutiveFailures.delete(attempt.attemptId);
			} catch (err) {
				const fails = (this.consecutiveFailures.get(attempt.attemptId) ?? 0) + 1;
				this.consecutiveFailures.set(attempt.attemptId, fails);
				if (fails >= this.maxFailures) {
					// The observer failed, not the worker: stop spending System One calls on this attempt and let
					// the worker keep running. The failure still reaches the caller once, below.
					this.openBreakers.add(attempt.attemptId);
					throw new WorkerSupervisionPausedError(attempt.attemptId, fails, err);
				}
				throw err;
			}

			// FR-064: Deterministic Intervention Policy
			let action: WorkerSupervisionAction = "continue";
			let summaryEvent: string | undefined;
			const reasonCodes: string[] = [];

			// Every one of these asks whether a problem is present: the required end is "no", and only a
			// decisive yes moves a worker. Intervening on a coin flip reroutes healthy work.
			const risk = (probability: number | undefined): boolean =>
				evaluateNoul(noulFromAnswer(probability, false), "required_false") === "hard_fail";
			// meaningful_progress asks the opposite way round: a decisive NO is the adverse answer.
			const noProgress = (probability: number | undefined): boolean =>
				evaluateNoul(noulFromAnswer(probability, true), "required_true") === "hard_fail";

			if (risk(answers.specialist_gap_present)) {
				action = "request_specialist";
				summaryEvent = "Specialist requested · worker mission requires specialist domain";
				reasonCodes.push("specialist_gap_detected");
			} else if (risk(answers.external_block_present)) {
				action = "mark_external_block";
				summaryEvent = "External block detected · worker is waiting on external dependencies";
				reasonCodes.push("external_block_detected");
			} else if (risk(answers.capability_gap_present)) {
				action = "request_capability";
				summaryEvent = "Capability requested · worker mission requires synthesized capability";
				reasonCodes.push("capability_gap_detected");
			} else if (risk(answers.needs_independent_verification)) {
				action = "request_verifier";
				summaryEvent = "Verification requested · implementation complete, independent proof missing";
				reasonCodes.push("independent_verification_needed");
			} else if (
				risk(answers.worker_stuck) ||
				risk(answers.strategy_repetition) ||
				risk(answers.work_off_track) ||
				noProgress(answers.meaningful_progress)
			) {
				if (noProgress(answers.meaningful_progress)) {
					reasonCodes.push("meaningful_progress_insufficient");
				}
				// FR-065: Anti-oscillation (one steer + grace period, then stop and reroute). Off-track
				// work is redirected now, not at the worker's next turn; a stall waits for that turn.
				if (priorSteeringCount === 0 && risk(answers.work_off_track)) {
					action = "steer_now";
					this.noteSteering(attempt.attemptId, attempt.toolCalls);
					summaryEvent = "Worker redirected now · work off the mission";
					reasonCodes.push("worker_off_track_steer_now");
				} else if (priorSteeringCount === 0) {
					action = "steer_once";
					this.noteSteering(attempt.attemptId, attempt.toolCalls);
					summaryEvent =
						answers.meaningful_progress < 0.3
							? "Worker steering initiated · insufficient meaningful progress"
							: "Worker steering initiated · progress stalled or strategy repeating";
					reasonCodes.push(
						answers.meaningful_progress < 0.3 ? "meaningful_progress_insufficient" : "worker_stuck_steer_once",
					);
				} else if (!this.steerGraceElapsed(attempt.attemptId, attempt.toolCalls)) {
					// The worker has not yet had a window to act on the steer it was sent.
					action = "continue";
					summaryEvent = undefined;
					reasonCodes.push("steer_grace_pending");
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
