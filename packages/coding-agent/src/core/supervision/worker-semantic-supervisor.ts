import { randomUUID } from "node:crypto";
import type { NoulDirection } from "../decision/noul.ts";
import { compileDecisionProgramForCheckpoint } from "../steering/programs.ts";
import { type BandedNoulAnswer, bandedNoulAnswer, isAdverseAnswer } from "../system-one/policy.ts";
import { type SemanticEvaluationScope, semanticWorkerTaskScope } from "../system-one/semantic-evaluation-ledger.ts";
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
		options?: { consequence?: string; signal?: AbortSignal; evaluationScope?: SemanticEvaluationScope },
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

/**
 * Tool calls between assessments of otherwise unchanged evidence. The state System One judges carries the tool
 * calls, the failures and the changed files, so a worker that keeps working changes what is being judged; one
 * assessment per window keeps the cost to a round trip every few calls while a worker never goes unseen for long.
 */
export const ASSESSMENT_TOOL_CALL_STEP = 4;

/** Tool calls a worker needs before the semantic judgment reads it: the smallest count it was measured on. */
export const MIN_ASSESSED_TOOL_CALLS = 5;

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

/** The end each supervision question requires, as the program declares it: the one place polarity lives. */
function supervisionDirections(state: unknown): Record<string, NoulDirection> {
	const program = compileDecisionProgramForCheckpoint("JEV-WORKER-SUPERVISION", state);
	const directions: Record<string, NoulDirection> = {};
	for (const decision of program.decisions) {
		if (decision.kind === "boolean" && decision.direction) directions[decision.id] = decision.direction;
	}
	return directions;
}

/** Every question's answer, banded against the direction its decision declares. */
function requireSupervisionAnswers(
	raw: Record<string, unknown>,
	directions: Readonly<Record<string, NoulDirection>>,
): Record<string, BandedNoulAnswer> {
	const answers: Record<string, BandedNoulAnswer> = {};
	for (const id of WORKER_SUPERVISION_DECISION_IDS) {
		const direction = directions[id];
		if (!direction) throw new Error(`Supervision decision '${id}' declares no direction`);
		const answer = bandedNoulAnswer(raw[id], direction);
		if (answer === undefined) throw new Error(`Missing answer for boolean decision '${id}'`);
		answers[id] = answer;
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
		this.minToolCalls = deps.minToolCalls ?? MIN_ASSESSED_TOOL_CALLS;
		this.minElapsedMs = deps.minElapsedMs ?? 3000;
		this.maxFailures = deps.maxFailures ?? 3;
	}

	getPriorSteeringCount(attemptId: string): number {
		return this.steeringInterventions.get(attemptId) ?? 0;
	}

	/**
	 * Commit one successfully accepted steer for anti-oscillation across semantic and deterministic
	 * supervision. `toolCalls` is the attempt's executed tool-call count at the control boundary, the
	 * start of its grace window.
	 */
	noteSteering(attemptId: string, toolCalls = 0): number {
		const next = this.getPriorSteeringCount(attemptId) + 1;
		this.steeringInterventions.set(attemptId, next);
		this.steeredAtToolCalls.set(attemptId, toolCalls);
		return next;
	}

	/** A failed control action changed no worker state, so the same evidence may be assessed again. */
	invalidateAssessment(attemptId: string): void {
		this.lastAssessmentAt.delete(attemptId);
		this.lastAssessmentHash.delete(attemptId);
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
			Math.floor(attempt.toolCalls / ASSESSMENT_TOOL_CALL_STEP),
			attempt.recentFailures?.length ?? 0,
			attempt.changedFiles?.length ?? 0,
		].join(":");
	}

	/**
	 * FR-061, FR-062: Checks whether observation is eligible under debounce/threshold rules.
	 */
	shouldAssess(attempt: LiveWorkerAttempt): boolean {
		// FR-062: No assessment for very short workers
		// The semantic judgment is only as good as the evidence it reads, and it was measured on workers with at
		// least five tool calls: a worker that has made one or two has shown nothing to judge, however slow its
		// first turn was. Early churn is still caught by the deterministic check.
		if (attempt.toolCalls < this.minToolCalls || attempt.elapsedMs < this.minElapsedMs) {
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

		const assessmentHash = this.assessmentKey(attempt);
		const priorSteeringCount = this.getPriorSteeringCount(attempt.attemptId);

		// FR-061: Bounded observation projection
		const tail = attempt.outputTail ? attempt.outputTail.slice(-2000) : "";
		const state: SupervisionObservationState = {
			objectiveId: attempt.objectiveId,
			taskId: attempt.taskId,
			attemptId: attempt.attemptId,
			role: attempt.role,
			mission: attempt.mission,
			elapsedMs: attempt.elapsedMs,
			toolCalls: attempt.toolCalls,
			recentToolNames: attempt.recentToolNames ? [...attempt.recentToolNames] : [],
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

		try {
			let certId = `cert-supervision-${Date.now()}`;
			let answers: Record<string, BandedNoulAnswer>;
			const directions = supervisionDirections(state);

			try {
				if (this.steering) {
					const cert = await this.steering.requireCertificate("JEV-WORKER-SUPERVISION", state, {
						objectiveId: attempt.objectiveId,
						taskId: attempt.taskId,
						evidenceRevision: state.evidenceRevision,
						signal,
					});
					certId = cert.certificate_id;
					answers = requireSupervisionAnswers((cert.answers ?? {}) as Record<string, unknown>, directions);
				} else if (this.decisionEngine) {
					// The same canonical program the steering plane compiles; never an inline copy.
					const evalRes = await this.decisionEngine.evaluate(
						compileDecisionProgramForCheckpoint("JEV-WORKER-SUPERVISION", state),
						state as unknown as Record<string, unknown>,
						{
							consequence: "medium",
							signal,
							evaluationScope: semanticWorkerTaskScope(attempt.objectiveId, attempt.taskId),
						},
					);
					// Per decision: the normalized result when present, else the raw answer. An empty
					// `results` object must not hide populated answers.
					const merged: Record<string, unknown> = {};
					for (const id of WORKER_SUPERVISION_DECISION_IDS) {
						merged[id] = evalRes.results?.[id] ?? evalRes.answers?.[id];
					}
					answers = requireSupervisionAnswers(merged, directions);
				} else {
					// Unbound supervisor (no plane): local stall/repeat heuristics, never empty answers.
					answers = requireSupervisionAnswers(
						{
							meaningful_progress: attempt.isStalled ? 0.1 : 0.9,
							worker_stuck: attempt.isStalled ? 0.9 : 0.1,
							strategy_repetition: attempt.isRepeating ? 0.9 : 0.1,
							work_off_track: 0.1,
							needs_independent_verification: 0.1,
							specialist_gap_present: 0.1,
							capability_gap_present: 0.1,
							external_block_present: 0.1,
						},
						directions,
					);
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

			// Adverse is read from the band the decision's declared direction gave the answer: only a decisive
			// answer moves a worker, and intervening on a coin flip would reroute healthy work.
			const adverse = (id: (typeof WORKER_SUPERVISION_DECISION_IDS)[number]): boolean =>
				isAdverseAnswer(answers[id]);

			if (adverse("specialist_gap_present")) {
				action = "request_specialist";
				summaryEvent = "Specialist requested · worker mission requires specialist domain";
				reasonCodes.push("specialist_gap_detected");
			} else if (adverse("external_block_present")) {
				action = "mark_external_block";
				summaryEvent = "External block detected · worker is waiting on external dependencies";
				reasonCodes.push("external_block_detected");
			} else if (adverse("capability_gap_present")) {
				action = "request_capability";
				summaryEvent = "Capability requested · worker mission requires synthesized capability";
				reasonCodes.push("capability_gap_detected");
			} else if (adverse("needs_independent_verification")) {
				action = "request_verifier";
				summaryEvent = "Verification requested · implementation complete, independent proof missing";
				reasonCodes.push("independent_verification_needed");
			} else if (
				adverse("worker_stuck") ||
				adverse("strategy_repetition") ||
				adverse("work_off_track") ||
				adverse("meaningful_progress")
			) {
				if (adverse("meaningful_progress")) {
					reasonCodes.push("meaningful_progress_insufficient");
				}
				// FR-065: Anti-oscillation (one steer + grace period, then stop and reroute). Off-track
				// work is redirected now, not at the worker's next turn; a stall waits for that turn.
				if (priorSteeringCount === 0 && adverse("work_off_track")) {
					action = "steer_now";
					summaryEvent = "Worker redirected now · work off the mission";
					reasonCodes.push("worker_off_track_steer_now");
				} else if (priorSteeringCount === 0) {
					action = "steer_once";
					summaryEvent =
						answers.meaningful_progress.noul < 0.3
							? "Worker steering initiated · insufficient meaningful progress"
							: "Worker steering initiated · progress stalled or strategy repeating";
					reasonCodes.push(
						answers.meaningful_progress.noul < 0.3
							? "meaningful_progress_insufficient"
							: "worker_stuck_steer_once",
					);
				} else if (!this.steerGraceElapsed(attempt.attemptId, attempt.toolCalls)) {
					// The worker has not yet had a window to act on the steer it was sent.
					action = "continue";
					summaryEvent = undefined;
					reasonCodes.push("steer_grace_pending");
				} else if (
					!adverse("work_off_track") &&
					!attempt.isStalled &&
					!attempt.isRepeating &&
					(attempt.recentFailures?.length ?? 0) === 0
				) {
					// A semantic low-progress score alone cannot cancel a worker that is still making
					// distinct successful calls. Require observed stall, repetition, or failure.
					action = "continue";
					summaryEvent = undefined;
					reasonCodes.push("reroute_without_observed_stall");
				} else {
					action = "stop_and_reroute";
					summaryEvent = "Worker rerouted · progress stalled after steering";
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

			// Only a complete verdict owns this assessment identity. A semantic failure retains the
			// admission timestamp for debounce but leaves identical evidence retryable afterward.
			this.lastAssessmentHash.set(attempt.attemptId, assessmentHash);
			return signalRecord;
		} finally {
			this.inFlightAssessments.delete(attempt.attemptId);
		}
	}
}
