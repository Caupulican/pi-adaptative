/**
 * Goal outside wait: whether an open requirement of the session's goal waits on state outside the session (a CI run, a
 * release, a deployment, a review, another process), so that the goal's continuation tells the model to read that state and
 * follow it with a watch bound to the requirement instead of spending passes on it. Code decides the facts (an active goal,
 * an open requirement no watch was ever bound to, a bound engine, no live watch at decision time); System One answers the
 * one semantic question code cannot, with an evidence-sufficiency question beside it. The judgment is taken when one of the
 * session's own watches ends, off the turn, once per goal, requirement and requirement text, and saved in the session's
 * watch ledger, which a restart reads back; the goal's runtime snapshot reads the saved answers
 * (`GoalWatchFacts.waitsOutside`), so the continuation decision stays synchronous. Nothing is written to the goal's state. With System One off or out, only bound watches count.
 */
import { createHash } from "node:crypto";
import { harnessLog } from "../../kernel/harness-log.ts";
import { interfaceText } from "../language/interface-text.ts";
import { wrapUntrustedText } from "../security/untrusted-boundary.ts";
import { ACCEPT_ABSENCE_AT, ACCEPT_AT, noulProbability } from "../system-one/answer-acceptance.ts";
import type { OperationEffectEngine, OperationEvaluation } from "../system-one/operation-classifier.ts";
import { noteDecisionTrace } from "../system-one/semantic-evaluation-ledger.ts";
import type { RequirementWaitAnswer, SessionRequirementJudgment } from "../watches/session-watch-ledger.ts";
import { type GoalState, isGoalExecutionActive, type Requirement } from "./goal-state.ts";

/** How long one judgment may take before it counts as an outage; it runs off the turn, so it delays no one. */
const GOAL_OUTSIDE_WAIT_TIMEOUT_MS = 10_000;

export const GOAL_OUTSIDE_WAIT_PROGRAM = {
	schema_version: "2.0",
	program_id: "S1-GOAL-OUTSIDE-WAIT",
	description: "Whether a goal requirement is met only once something outside the session reaches a state.",
	decisions: [
		{
			id: "waits_on_outside_state",
			instruction:
				"Is `requirement` met only once something outside this session reaches a state that the session's own next step cannot bring about, such as a CI run or workflow finishing, a release being published, a deployment, a review or another process, so that working on it now means waiting on that state?",
		},
		{
			id: "requirement_evidence_sufficient",
			instruction:
				"Does `requirement` say enough to tell whether it waits on such outside state? Answer no when it is too terse to tell or refers to text that is not shown.",
		},
	],
} as const;

/** Why a requirement was or was not taken to wait on outside state, in the order the exits are tried. */
type GoalOutsideWaitExit = "unasked" | RequirementWaitAnswer;

const DRIVING_QUESTIONS: Readonly<Record<RequirementWaitAnswer, readonly string[]>> = {
	evidence_insufficient: ["requirement_evidence_sufficient"],
	waits_outside: ["waits_on_outside_state", "requirement_evidence_sufficient"],
	within_session: ["waits_on_outside_state", "requirement_evidence_sufficient"],
	open: ["waits_on_outside_state", "requirement_evidence_sufficient"],
};

export interface GoalOutsideWaitPorts {
	/** The session's batched-question engine; absent while System One is off or has none bound. */
	engine(): OperationEffectEngine | undefined;
	/** The session's goal as its branch holds it now. */
	goal(): GoalState | undefined;
	/** The requirements of `goalId` a watch was ever bound to: their link answers the question, so they are not asked. */
	linked(goalId: string): ReadonlySet<string>;
	/** The answers the session saved (its watch ledger), a restart's included. */
	saved(): readonly SessionRequirementJudgment[];
	/** Saves an answer in place of an earlier one to its question; a failure to write is the ledger's to report. */
	save(judgment: SessionRequirementJudgment): void;
	/** The time an answer is stamped with. */
	now(): number;
	warn(message: string): void;
	isDisposed(): boolean;
}

/** One requirement's question, keyed by its goal, its id and its text: changed words are a new question. */
function questionKey(goalId: string, requirement: Requirement): string {
	return createHash("sha256")
		.update(JSON.stringify([goalId, requirement.id, requirement.text]))
		.digest("hex");
}

export class GoalOutsideWait {
	private readonly ports: GoalOutsideWaitPorts;
	/** The pass in flight; a watch that ends during it asks for one more pass after it. */
	private pass: Promise<void> | undefined;
	private passAgain = false;
	private outageReported = false;
	/** Cancels the pass in flight: before dispatch it never sends, in flight its request is aborted. */
	private readonly closing = new AbortController();

	constructor(ports: GoalOutsideWaitPorts) {
		this.ports = ports;
	}

	/** One of the session's own watches ended: asks, without waiting, about each open requirement not yet asked. */
	noteWatchEnded(): void {
		if (this.closing.signal.aborted || this.ports.isDisposed()) return;
		if (this.pass) {
			this.passAgain = true;
			return;
		}
		const pass = this.judgeOpenRequirements().catch((error: unknown) => this.reportOutage(error));
		this.pass = pass;
		void pass.finally(() => {
			if (this.pass === pass) this.pass = undefined;
			if (this.passAgain) {
				this.passAgain = false;
				this.noteWatchEnded();
			}
		});
	}

	/** The open requirements of `state` judged, at p >= 0.90 on sufficient evidence, to wait on outside state. */
	waitsOutside(state: GoalState): string[] {
		const answers = this.answers();
		return state.requirements.flatMap((requirement) =>
			requirement.status === "open" && answers.get(questionKey(state.goalId, requirement)) === "waits_outside"
				? [requirement.id]
				: [],
		);
	}

	/** The saved answers, by question. */
	private answers(): Map<string, RequirementWaitAnswer> {
		return new Map(this.ports.saved().map((judgment) => [judgment.question, judgment.answer]));
	}

	/** Stops the pass in flight and joins it; none starts after. */
	async stop(): Promise<void> {
		this.closing.abort();
		while (this.pass) await this.pass;
	}

	/** The facts that call for a question: an active goal, an engine, and open requirements no watch was bound to. */
	private unasked(): { engine: OperationEffectEngine; goalId: string; requirements: Requirement[] } | undefined {
		const goal = this.ports.goal();
		const engine = this.ports.engine();
		if (!goal || !engine || !isGoalExecutionActive(goal.status)) return undefined;
		const linked = this.ports.linked(goal.goalId);
		const answers = this.answers();
		const requirements = goal.requirements.filter(
			(requirement) =>
				requirement.status === "open" &&
				!linked.has(requirement.id) &&
				!answers.has(questionKey(goal.goalId, requirement)),
		);
		return requirements.length > 0 ? { engine, goalId: goal.goalId, requirements } : undefined;
	}

	private async judgeOpenRequirements(): Promise<void> {
		const asked = this.unasked();
		if (!asked) return;
		for (const requirement of asked.requirements) {
			if (this.closing.signal.aborted || this.ports.isDisposed()) return;
			const exit = await this.judge(asked.engine, requirement);
			if (exit !== "unasked")
				this.ports.save({
					goalId: asked.goalId,
					requirementId: requirement.id,
					question: questionKey(asked.goalId, requirement),
					answer: exit,
					at: this.ports.now(),
				});
		}
	}

	private async judge(engine: OperationEffectEngine, requirement: Requirement): Promise<GoalOutsideWaitExit> {
		const evaluation: OperationEvaluation = await engine.evaluate(
			GOAL_OUTSIDE_WAIT_PROGRAM,
			{
				requirement: wrapUntrustedText(requirement.text, "goal-requirement", {
					nonce: createHash("sha256").update(requirement.text).digest("hex").slice(0, 32),
				}),
			},
			{
				consequence: "low",
				signal: AbortSignal.any([this.closing.signal, AbortSignal.timeout(GOAL_OUTSIDE_WAIT_TIMEOUT_MS)]),
				occupancy: "background",
			},
		);
		const waits = noulProbability(evaluation.answers?.waits_on_outside_state);
		const sufficient = noulProbability(evaluation.answers?.requirement_evidence_sufficient);
		// Ordered exits: only a sufficiently evidenced, established "yes" counts; every other case leaves the goal as it was.
		let exit: GoalOutsideWaitExit;
		if (waits === undefined || sufficient === undefined) exit = "unasked";
		else if (sufficient < ACCEPT_AT) exit = "evidence_insufficient";
		else if (waits >= ACCEPT_AT) exit = "waits_outside";
		else if (waits <= ACCEPT_ABSENCE_AT) exit = "within_session";
		else exit = "open";
		harnessLog.info("goal-outside-wait", "a goal requirement was judged for an outside wait", () => ({
			exit,
			waitsOnOutsideState: waits ?? null,
			evidenceSufficient: sufficient ?? null,
		}));
		noteDecisionTrace(engine, evaluation, {
			decision: `goal outside wait: ${exit}`,
			drove: exit === "unasked" ? [] : DRIVING_QUESTIONS[exit],
		});
		return exit;
	}

	/** An outage leaves the goal following only bound watches; the owner is told once per session. */
	private reportOutage(error: unknown): void {
		if (this.closing.signal.aborted || this.ports.isDisposed() || this.outageReported) return;
		this.outageReported = true;
		harnessLog.warn("goal-outside-wait", "a goal requirement could not be judged for an outside wait", () => ({
			error: error instanceof Error ? error.name : typeof error,
		}));
		this.ports.warn(
			interfaceText().sessions.goal.outsideWaitOutage(error instanceof Error ? error.message : String(error)),
		);
	}
}
