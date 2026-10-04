import type { SessionManager } from "../../kernel/node.ts";
import type { ArtifactStore } from "../context/context-artifacts.ts";
import type { ExtensionUIContext } from "../extensions/types.ts";
import {
	beginHumanInputRequest,
	createHumanInputRequest,
	DEFAULT_OWNER_WAIT_TIMEOUT_MS,
	resolveHumanInput,
} from "../human-input.ts";
import type { SessionImageStore } from "../session-image-store.ts";

export interface GoalCompletionOwnerDecisionInput {
	toolCallId: string;
	goalId: string;
	userGoal: string;
	reasons: readonly string[];
}

export type GoalCompletionOwnerDecision =
	| { decision: "accept_complete" }
	| { decision: "continue"; answer?: string }
	| { decision: "deferred"; followUpPath?: string };

export interface GoalCompletionOwnerDecisionDeps {
	sessionManager: SessionManager;
	ui?: Pick<ExtensionUIContext, "askQuestions">;
	isHandoff: boolean;
	requestText?: string;
	recordOwnerFollowUp?(entry: { question: string; reason: string; request: string }): string | undefined;
	artifactStore?: ArtifactStore;
	getImageStore?: () => Pick<SessionImageStore, "retainContent"> | undefined;
	timeoutMs?: number;
}

const ACCEPT_COMPLETE = "Accept complete";
const CONTINUE_WORKING = "Continue working";

/** Route a repeated, unchanged semantic completion rejection to one durable owner decision. */
export async function resolveGoalCompletionOwnerDecision(
	input: GoalCompletionOwnerDecisionInput,
	deps: GoalCompletionOwnerDecisionDeps,
	signal?: AbortSignal,
): Promise<GoalCompletionOwnerDecision> {
	const reason = input.reasons.join("; ") || "System One could not verify completion.";
	const question = `System One still cannot verify goal "${input.userGoal}" as complete: ${reason} What should Pi do?`;
	const defer = (deferReason: string): GoalCompletionOwnerDecision => {
		const followUpPath = deps.recordOwnerFollowUp?.({
			question,
			reason: deferReason,
			request: deps.requestText ?? input.userGoal,
		});
		return { decision: "deferred", ...(followUpPath ? { followUpPath } : {}) };
	};
	if (deps.isHandoff) {
		return defer("Goal completion remained semantically rejected after an unchanged retry under handoff.");
	}
	if (!deps.ui) return defer("The completion decision panel was unavailable; no completion override was granted.");

	const request = createHumanInputRequest({
		source: "tool",
		toolCallId: input.toolCallId,
		toolName: "goal",
		objectiveId: input.goalId,
		category: "blocked_by_user_decision",
		questions: [
			{
				id: "goal_completion_decision",
				header: "Completion",
				question,
				options: [
					{
						label: CONTINUE_WORKING,
						description: "Keep the goal active and address System One's missing proof.",
					},
					{
						label: ACCEPT_COMPLETE,
						description: "Apply your explicit completion override and close the goal.",
					},
				],
			},
		],
		acceptsImages: false,
	});
	beginHumanInputRequest(deps.sessionManager, request);

	const resolved = await resolveHumanInput({
		sessionManager: deps.sessionManager,
		request,
		present: (presentation, options) => deps.ui!.askQuestions(presentation, options),
		artifactStore: deps.artifactStore,
		getImageStore: deps.getImageStore,
		signal,
		timeoutMs: deps.timeoutMs ?? DEFAULT_OWNER_WAIT_TIMEOUT_MS,
	});
	if (resolved.snapshot.status === "pending") {
		return defer("The owner did not answer the completion decision before its deadline.");
	}

	const answer = resolved.snapshot.answers[0];
	if (answer?.selected.includes(ACCEPT_COMPLETE)) return { decision: "accept_complete" };
	const answerText = answer?.custom?.trim() || answer?.selected.join(", ") || undefined;
	return { decision: "continue", ...(answerText ? { answer: answerText } : {}) };
}
