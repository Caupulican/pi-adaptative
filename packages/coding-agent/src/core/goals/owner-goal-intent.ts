/**
 * Owner goal intent: starts a goal from an owner's message that asks for an outcome to be pursued until it is reached,
 * whatever its wording. Code decides what is a fact (the owner typed words, no explicit goal phrase states one, no goal is
 * unfinished, the objective fits, the runtime is ready) and System One answers the one semantic question code cannot,
 * whether the message sets such an outcome, with an evidence-sufficiency question beside it. Ordered exits written here
 * combine the two answers; only an established "yes" starts a goal, every other case starts nothing.
 */

import { createHash } from "node:crypto";
import type { AssistantMessage } from "@caupulican/pi-ai";
import { harnessLog } from "../../kernel/harness-log.ts";
import type { CustomMessage } from "../../kernel/messages.ts";
import type { AdaptiveRuntimeReadiness } from "../adaptive/adaptive-runtime-readiness.ts";
import { interfaceText } from "../language/interface-text.ts";
import type { OwnerWords } from "../learning/owner-evidence-ledger.ts";
import { ownerRequestForJudge, ownerTypedText, programOverOwnerWords } from "../security/owner-paste-boundary.ts";
import { wrapUntrustedText } from "../security/untrusted-boundary.ts";
import { ACCEPT_ABSENCE_AT, ACCEPT_AT, noulProbability } from "../system-one/answer-acceptance.ts";
import { assistantAnswerText } from "../system-one/claim-delivery.ts";
import type { OperationEffectEngine, OperationEvaluation } from "../system-one/operation-classifier.ts";
import { noteDecisionTrace } from "../system-one/semantic-evaluation-ledger.ts";
import type { GoalSessionController } from "./goal-session-controller.ts";
import { isGoalUnfinishedStatus, MAX_GOAL_OBJECTIVE_LENGTH } from "./goal-state.ts";
import { LEGACY_GOAL_TOOL_NAME } from "./goal-tool-names.ts";
import { GoalTokenBudgetParseError, parseExplicitGoalStartAuthority } from "./natural-language-goal.ts";

/**
 * How long the judgment may take before it counts as an outage. The judgment never delays the owner's turn (it runs after
 * the message is delivered), so this only bounds how late a goal can start; it is ten times the 2 s the operation gate
 * allows a blocking judgment (whose p99 over 1,204 recorded calls is under 0.9 s).
 */
const OWNER_GOAL_INTENT_TIMEOUT_MS = 10_000;

/** The tail of the previous assistant answer a short reply ("yes, do that") may refer to. */
const PREVIOUS_ANSWER_CHARACTERS = 1_500;

export const OWNER_GOAL_INTENT_PROGRAM = {
	schema_version: "2.0",
	program_id: "S1-OWNER-GOAL-INTENT",
	description: "Whether the owner's message sets an outcome the agent pursues across turns until it is reached.",
	decisions: [
		{
			id: "sets_standing_outcome",
			instruction:
				"Does `owner_message` ask the agent to keep working toward a stated end state until that state is reached, an outcome to pursue over several turns, rather than a question, one bounded action or conversation? `previous_assistant_answer`, when present, only shows what a short reply refers to.",
		},
		{
			id: "message_evidence_sufficient",
			instruction:
				"Does `owner_message`, read with `previous_assistant_answer` when it refers to it, show enough to tell whether it asks for such an outcome? Answer no when it refers to text that is not shown, is cut off or has no words of its own.",
		},
	],
} as const;

/** The decisions that read the owner's words, which gain the owner-paste rule when a message carries a pasted span. */
const READS_OWNER_WORDS: ReadonlySet<string> = new Set(["sets_standing_outcome"]);

/** Why the message did or did not start a goal, in the order the exits are tried. */
type OwnerGoalIntentExit =
	| "outage"
	| "unasked"
	| "evidence_insufficient"
	| "standing_outcome"
	| "not_standing_outcome"
	| "open";

/** The questions that drove each exit that read an answer. */
const DRIVING_QUESTIONS: Readonly<Record<Exclude<OwnerGoalIntentExit, "outage" | "unasked">, readonly string[]>> = {
	evidence_insufficient: ["message_evidence_sufficient"],
	standing_outcome: ["sets_standing_outcome", "message_evidence_sufficient"],
	not_standing_outcome: ["sets_standing_outcome", "message_evidence_sufficient"],
	open: ["sets_standing_outcome", "message_evidence_sufficient"],
};

/** What the owner's goal intent reads of the session; the prompt submission controller's own dependencies satisfy it. */
export interface OwnerGoalIntentPorts {
	/** The session's batched-question engine; absent while System One is off or has none bound. */
	getSemanticDecisionEngine(): OperationEffectEngine | undefined;
	readonly goals: Pick<GoalSessionController, "getState" | "startJudgedOwnerGoal">;
	/** The adaptive runtime's readiness a goal needs, when one is configured. */
	getAdaptiveReadiness(): Pick<AdaptiveRuntimeReadiness, "getStatus"> | undefined;
	/** Gives the running turn, or the next one, a note the model reads and the owner does not see. */
	sendCustomMessage(
		message: Pick<CustomMessage, "customType" | "content" | "display">,
		options: { deliverAs: "steer" },
	): Promise<void>;
	emit(event: { type: "warning"; message: string }): void;
	isDisposed(): boolean;
}

/** Whether `typed` states a goal in words the explicit grammar knows; a budget phrase it cannot read is such a statement. */
function statesGoalExplicitly(typed: string): boolean {
	try {
		return parseExplicitGoalStartAuthority(typed) !== undefined;
	} catch (error) {
		if (error instanceof GoalTokenBudgetParseError) return true;
		throw error;
	}
}

/** The owner's words as the goal's objective: the whole message, or its typed words when the paste makes it too long. */
function objectiveOf(words: OwnerWords): string | undefined {
	return [words.text, ownerTypedText(words)]
		.map((text) => text.trim())
		.find((text) => text.length > 0 && text.length <= MAX_GOAL_OBJECTIVE_LENGTH);
}

export class OwnerGoalIntent {
	private readonly ports: OwnerGoalIntentPorts;
	private outageReported = false;

	constructor(ports: OwnerGoalIntentPorts) {
		this.ports = ports;
	}

	/**
	 * The owner's words were delivered. Starts the judgment when the facts call for it, without waiting for it: the owner's
	 * turn is already running, and a goal the judgment grants is handed to that turn, or to the goal's own continuation
	 * when the turn has ended.
	 */
	noteDelivered(words: OwnerWords, previousAnswer: AssistantMessage | undefined): void {
		const request = ownerRequestForJudge(words);
		const objective = objectiveOf(words);
		if (request === undefined || objective === undefined || statesGoalExplicitly(ownerTypedText(words))) return;
		if (this.hasUnfinishedGoal()) return;
		const engine = this.ports.getSemanticDecisionEngine();
		if (!engine) return;
		void this.judgeAndStart(engine, request, objective, assistantAnswerText(previousAnswer)).catch(
			(error: unknown) => {
				// Only the admission can throw here (the judgment reports its own outage): the goal could not be started.
				this.warn(
					interfaceText().sessions.goal.intentNotStarted(error instanceof Error ? error.message : String(error)),
				);
			},
		);
	}

	private warn(message: string): void {
		this.ports.emit({ type: "warning", message });
	}

	private hasUnfinishedGoal(): boolean {
		const state = this.ports.goals.getState();
		return state !== undefined && isGoalUnfinishedStatus(state.status);
	}

	private async judgeAndStart(
		engine: OperationEffectEngine,
		request: string,
		objective: string,
		previousAnswer: string,
	): Promise<void> {
		const exit = await this.judge(engine, request, previousAnswer);
		if (exit !== "standing_outcome" || this.ports.isDisposed() || this.hasUnfinishedGoal()) return;
		const readiness = this.ports.getAdaptiveReadiness()?.getStatus();
		if (readiness && !readiness.ready) {
			this.warn(interfaceText().sessions.goal.intentNotStarted(readiness.issues.join("; ")));
			return;
		}
		const admission = this.ports.goals.startJudgedOwnerGoal(objective);
		if (admission.status !== "started") return;
		await this.ports
			.sendCustomMessage(
				{
					customType: "owner-goal-intent",
					content: `The owner's message sets an outcome to pursue until it is reached, so goal '${admission.state.goalId}' was started from it. Record the end state the owner stated, and every step the owner ordered, as goal requirements (the ${LEGACY_GOAL_TOOL_NAME} tool, action add_requirement), then keep working until each is satisfied.`,
					display: false,
				},
				{ deliverAs: "steer" },
			)
			.catch((error: unknown) => {
				this.warn(
					interfaceText().sessions.goal.intentNoteFailed(error instanceof Error ? error.message : String(error)),
				);
			});
	}

	private async judge(
		engine: OperationEffectEngine,
		request: string,
		previousAnswer: string,
	): Promise<OwnerGoalIntentExit> {
		const bounded = previousAnswer.slice(-PREVIOUS_ANSWER_CHARACTERS);
		let evaluation: OperationEvaluation;
		try {
			evaluation = await engine.evaluate(
				programOverOwnerWords(OWNER_GOAL_INTENT_PROGRAM, READS_OWNER_WORDS, request),
				{
					owner_message: request,
					...(bounded
						? {
								previous_assistant_answer: wrapUntrustedText(bounded, "assistant-answer", {
									nonce: createHash("sha256").update(bounded).digest("hex").slice(0, 32),
								}),
							}
						: {}),
				},
				{ consequence: "medium", signal: AbortSignal.timeout(OWNER_GOAL_INTENT_TIMEOUT_MS) },
			);
		} catch (error) {
			// An outage starts no goal, and the owner is told once per session.
			this.reportOutage(error);
			return "outage";
		}
		const standing = noulProbability(evaluation.answers?.sets_standing_outcome);
		const sufficient = noulProbability(evaluation.answers?.message_evidence_sufficient);
		// Ordered exits: only a sufficiently evidenced, established "yes" starts a goal; every other case is open or a no.
		let exit: OwnerGoalIntentExit;
		if (standing === undefined || sufficient === undefined) exit = "unasked";
		else if (sufficient < ACCEPT_AT) exit = "evidence_insufficient";
		else if (standing >= ACCEPT_AT) exit = "standing_outcome";
		else if (standing <= ACCEPT_ABSENCE_AT) exit = "not_standing_outcome";
		else exit = "open";
		harnessLog.info("owner-goal-intent", "an owner message was judged for a standing outcome", () => ({
			exit,
			standingOutcome: standing ?? null,
			evidenceSufficient: sufficient ?? null,
		}));
		noteDecisionTrace(engine, evaluation, {
			decision: `owner goal intent: ${exit}`,
			drove: exit === "unasked" ? [] : DRIVING_QUESTIONS[exit],
		});
		return exit;
	}

	private reportOutage(error: unknown): void {
		if (this.ports.isDisposed() || this.outageReported) return;
		this.outageReported = true;
		harnessLog.warn("owner-goal-intent", "an owner message could not be judged; no goal started", () => ({
			error: error instanceof Error ? error.name : typeof error,
		}));
		this.warn(interfaceText().sessions.goal.intentOutage(error instanceof Error ? error.message : String(error)));
	}
}
