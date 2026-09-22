import { SessionManager } from "@caupulican/pi-agent-core/node";
import { describe, expect, it } from "vitest";
import { compileExecutionCharter, evaluateCharterAuthority } from "../src/core/autonomy/execution-charter.ts";
import { WORKER_TOOL_ADAPTER_FORBIDDEN_NAMES } from "../src/core/autonomy/worker-tool-adapter-registry.ts";
import { createInMemoryArtifactStore } from "../src/core/context/context-artifacts.ts";
import type { ExtensionContext, ExtensionUIContext } from "../src/core/extensions/types.ts";
import { clarificationRequestedEvent, recordObjectiveClarification } from "../src/core/goals/goal-clarification-log.ts";
import { applyGoalEvent, createGoalState, type GoalState } from "../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot, getLatestGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import { beginHumanInputRequest, createHumanInputRequest } from "../src/core/human-input.ts";
import { HumanInputController } from "../src/core/human-input-controller.ts";
import { formatClarificationQuestion } from "../src/core/system-one/clarification.ts";
import { type AskQuestion, createAskQuestionToolDefinition } from "../src/core/tools/ask-question.ts";

const USER_GOAL = "tidy the settings screen";

const questions: AskQuestion[] = [
	{
		id: "decision",
		header: "Decision",
		question: "Which release lane should the tidy-up land on?",
		options: [
			{ label: "Next patch", description: "Ship with the next patch release." },
			{ label: "Hold", description: "Hold until the next minor." },
		],
	},
];

const ANSWER_TEXT = "yes, push it and install the package";

function goalPort(sessionManager: SessionManager) {
	return {
		getGoalState: () => getLatestGoalStateSnapshot(sessionManager),
		saveGoalState: (state: GoalState) => {
			appendGoalStateSnapshot(sessionManager, state, getLatestGoalStateSnapshot(sessionManager));
		},
	};
}

function startActiveGoal(sessionManager: SessionManager): GoalState {
	const state = createGoalState({ goalId: "goal-1", userGoal: USER_GOAL, now: "2026-09-20T00:00:00.000Z" });
	appendGoalStateSnapshot(sessionManager, state);
	return state;
}

function answeringUI(): ExtensionUIContext {
	return {
		askQuestions: async (request: { questions: readonly AskQuestion[] }) => ({
			answers: request.questions.map((question) => ({
				id: question.id,
				header: question.header,
				question: question.question,
				selected: [],
				custom: ANSWER_TEXT,
				skipped: false,
			})),
			cancelled: false,
			imageContents: [],
		}),
	} as unknown as ExtensionUIContext;
}

describe("objective-correlated ask_question", () => {
	it("records the clarification without touching the objective's authority", async () => {
		const sessionManager = SessionManager.inMemory();
		startActiveGoal(sessionManager);
		const port = goalPort(sessionManager);
		const charterBefore = compileExecutionCharter({ objectiveId: "goal-1", prompt: USER_GOAL });

		const tool = createAskQuestionToolDefinition({
			sessionManager,
			artifactStore: createInMemoryArtifactStore(),
			getObjectiveId: () => port.getGoalState()?.goalId,
			getObjectiveClarificationState: () => {
				const goal = port.getGoalState();
				return goal ? { userGoal: goal.userGoal, clarifications: goal.clarifications ?? [] } : undefined;
			},
			recordObjectiveClarification: (objectiveId, event) => {
				recordObjectiveClarification(port, objectiveId, event);
			},
		});

		const result = await tool.execute("call-1", { questions }, undefined, undefined, {
			hasUI: true,
			ui: answeringUI(),
		} as unknown as ExtensionContext);
		expect(result.details.cancelled).toBe(false);
		expect(result.details.answers[0]?.custom).toBe(ANSWER_TEXT);

		const goal = port.getGoalState();
		expect(goal?.goalId).toBe("goal-1");
		expect(goal?.status).toBe("active");
		expect(goal?.events.map((event) => event.type)).toEqual(["clarification_requested", "clarification_answered"]);
		expect(goal?.clarifications).toHaveLength(1);
		expect(goal?.clarifications?.[0]).toMatchObject({
			status: "answered",
			category: "information",
			answerSummary: `Decision: user answered: ${ANSWER_TEXT}`,
		});

		// The owner said "push it and install the package" INSIDE an answer. An answer is information,
		// never a grant: the charter compiled for this objective is byte-identical before and after,
		// and a push is still denied.
		const charterAfter = compileExecutionCharter({ objectiveId: "goal-1", prompt: USER_GOAL });
		expect(charterAfter).toEqual(charterBefore);
		expect(charterAfter.interaction_mode).toBe("start_only");
		expect(evaluateCharterAuthority(charterAfter, { kind: "git_push", pushRequested: true })).toEqual({
			outcome: "deny",
			reason: "Git push is not authorized in the execution charter",
			missingAuthority: "git:push",
		});
		expect(charterAfter.acquisition.package_installs).toBe(false);
	});

	function routedTool(
		sessionManager: SessionManager,
		routing: Partial<Parameters<typeof createAskQuestionToolDefinition>[0]> = {},
	) {
		const port = goalPort(sessionManager);
		const tool = createAskQuestionToolDefinition({
			sessionManager,
			getObjectiveId: () => port.getGoalState()?.goalId,
			getObjectiveClarificationState: () => {
				const goal = port.getGoalState();
				return goal ? { userGoal: goal.userGoal, clarifications: goal.clarifications ?? [] } : undefined;
			},
			recordObjectiveClarification: (objectiveId, event) => {
				recordObjectiveClarification(port, objectiveId, event);
			},
			...routing,
		});
		const counter = { presented: 0 };
		const ui = {
			askQuestions: async (request: { questions: readonly AskQuestion[] }) => {
				counter.presented += 1;
				return {
					answers: request.questions.map((question) => ({
						id: question.id,
						header: question.header,
						question: question.question,
						selected: ["Hold"],
						skipped: false,
					})),
					cancelled: false,
					imageContents: [],
				};
			},
		} as unknown as ExtensionUIContext;
		const ctx = { hasUI: true, ui } as unknown as ExtensionContext;
		return { tool, ctx, counter, port };
	}

	it("outside a handoff, always presents the question to the owner, even one already answered", async () => {
		const sessionManager = SessionManager.inMemory();
		startActiveGoal(sessionManager);
		const { tool, ctx, counter } = routedTool(sessionManager, { isHandoff: () => false });
		await tool.execute("call-1", { questions }, undefined, undefined, ctx);
		await tool.execute("call-2", { questions }, undefined, undefined, ctx);
		expect(counter.presented).toBe(2);
	});

	it("under a handoff, withholds a question the owner already answered, without presenting a dialog", async () => {
		const sessionManager = SessionManager.inMemory();
		startActiveGoal(sessionManager);
		let handoff = false;
		const { tool, ctx, counter, port } = routedTool(sessionManager, { isHandoff: () => handoff });
		await tool.execute("call-1", { questions }, undefined, undefined, ctx);
		handoff = true;
		const repeat = await tool.execute("call-2", { questions }, undefined, undefined, ctx);
		expect(counter.presented).toBe(1);
		expect(repeat.details.answers).toEqual([]);
		expect((repeat.content[0] as { text: string }).text).toContain("already_answered");
		expect(port.getGoalState()?.clarifications).toHaveLength(1);
	});

	it("under a handoff, a stronger model's answer settles the question", async () => {
		const sessionManager = SessionManager.inMemory();
		const { tool, ctx, counter } = routedTool(sessionManager, {
			isHandoff: () => true,
			getRequestText: () => "tidy the settings screen",
			consultStrongerModel: async () => ({
				kind: "answered",
				answer: "Keep the archived importer.",
				basis: "tidy the settings screen",
				model: "big/model",
			}),
		});
		const result = await tool.execute("call-1", { questions }, undefined, undefined, ctx);
		expect(counter.presented).toBe(0);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Keep the archived importer.");
		expect(text).toContain('checked by System One against the request ("tidy the settings screen")');
	});

	it("under a handoff, a decision only the owner can make becomes a follow-up and the run goes on", async () => {
		const sessionManager = SessionManager.inMemory();
		const followUps: string[] = [];
		const { tool, ctx, counter } = routedTool(sessionManager, {
			isHandoff: () => true,
			consultStrongerModel: async () => ({
				kind: "needs_owner",
				reason: "It changes the product scope.",
				model: "big/model",
			}),
			recordOwnerFollowUp: (entry) => {
				followUps.push(`${entry.question} | ${entry.reason}`);
				return "/tmp/follow-ups/s.md";
			},
		});
		const result = await tool.execute("call-1", { questions }, undefined, undefined, ctx);
		expect(counter.presented).toBe(0);
		expect(followUps).toHaveLength(1);
		expect(followUps[0]).toContain("It changes the product scope.");
		expect((result.content[0] as { text: string }).text).toContain("do not wait");
	});

	it("under a handoff with nowhere to record a follow-up, the owner is asked rather than skipped", async () => {
		const sessionManager = SessionManager.inMemory();
		const { tool, ctx, counter } = routedTool(sessionManager, {
			isHandoff: () => true,
			consultStrongerModel: async () => ({ kind: "needs_owner", reason: "scope", model: "big/model" }),
		});
		await tool.execute("call-1", { questions }, undefined, undefined, ctx);
		expect(counter.presented).toBe(1);
	});

	it("never exposes ask_question to a worker lane", () => {
		expect(WORKER_TOOL_ADAPTER_FORBIDDEN_NAMES.has("ask_question")).toBe(true);
	});

	it("settles a clarification that outlived its own process on resume", async () => {
		const sessionManager = SessionManager.inMemory();
		const started = startActiveGoal(sessionManager);
		const port = goalPort(sessionManager);

		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "call-9", name: "ask_question", arguments: { questions } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		});
		const request = createHumanInputRequest({
			source: "tool",
			toolCallId: "call-9",
			toolName: "ask_question",
			objectiveId: started.goalId,
			category: "ambiguous_requirement",
			questions,
			acceptsImages: false,
			now: () => "2026-09-20T00:00:01.000Z",
		});
		beginHumanInputRequest(sessionManager, request);
		appendGoalStateSnapshot(
			sessionManager,
			applyGoalEvent(
				started,
				clarificationRequestedEvent({
					requestId: request.requestId,
					category: "ambiguous_requirement",
					question: formatClarificationQuestion(questions),
					detail: "semantic_unavailable",
					now: request.createdAt,
				}),
			),
			started,
		);
		expect(port.getGoalState()?.clarifications?.[0]?.status).toBe("pending");

		const prompts: unknown[] = [];
		const controller = new HumanInputController({
			getSessionManager: () => sessionManager,
			getUIContext: () => answeringUI(),
			isDisposed: () => false,
			isStreaming: () => false,
			getModel: () => undefined,
			getArtifactStore: () => createInMemoryArtifactStore(),
			getImageStore: () => undefined,
			runAgentPrompt: async (messages) => {
				prompts.push(messages);
			},
			recordObjectiveClarification: (objectiveId, event) => {
				recordObjectiveClarification(port, objectiveId, event);
			},
		});

		expect(await controller.resumePending()).toBe(true);
		expect(prompts).toHaveLength(1);

		const goal = port.getGoalState();
		expect(goal?.goalId).toBe("goal-1");
		expect(goal?.status).toBe("active");
		expect(goal?.clarifications?.[0]).toMatchObject({
			requestId: request.requestId,
			category: "ambiguous_requirement",
			status: "answered",
			answerSummary: `Decision: user answered: ${ANSWER_TEXT}`,
		});
		expect(goal?.events.map((event) => event.type)).toEqual(["clarification_requested", "clarification_answered"]);
	});
});
