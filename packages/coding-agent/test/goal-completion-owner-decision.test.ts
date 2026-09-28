import { SessionManager } from "@caupulican/pi-agent-core/node";
import { describe, expect, it, vi } from "vitest";
import { resolveGoalCompletionOwnerDecision } from "../src/core/goals/goal-completion-owner-decision.ts";
import { getLatestHumanInputSnapshots } from "../src/core/human-input.ts";

const input = {
	toolCallId: "call-complete",
	goalId: "goal-1",
	userGoal: "Ship the feature",
	reasons: ["Required behavior is not proven."],
};

describe("goal completion owner decision", () => {
	it("opens the native question panel and returns an explicit completion override", async () => {
		const sessionManager = SessionManager.inMemory();
		const askQuestions = vi.fn(async (request: { questions: readonly { id: string }[] }) => ({
			answers: [
				{
					id: request.questions[0]!.id,
					header: "Completion",
					question: "question",
					selected: ["Accept complete"],
					skipped: false,
				},
			],
			cancelled: false,
			imageContents: [],
		}));

		const decision = await resolveGoalCompletionOwnerDecision(input, {
			sessionManager,
			ui: { askQuestions } as never,
			isHandoff: false,
		});

		expect(decision).toMatchObject({ decision: "accept_complete" });
		expect(askQuestions).toHaveBeenCalledOnce();
		expect(getLatestHumanInputSnapshots(sessionManager).at(-1)?.status).toBe("answered");
	});

	it("records a handoff decision for final review without opening UI", async () => {
		const sessionManager = SessionManager.inMemory();
		const askQuestions = vi.fn();
		const recordOwnerFollowUp = vi.fn(() => "/tmp/follow-ups/session.md");

		const decision = await resolveGoalCompletionOwnerDecision(input, {
			sessionManager,
			ui: { askQuestions } as never,
			isHandoff: true,
			requestText: "Implement and hand off",
			recordOwnerFollowUp,
		});

		expect(decision).toEqual({ decision: "deferred", followUpPath: "/tmp/follow-ups/session.md" });
		expect(recordOwnerFollowUp).toHaveBeenCalledOnce();
		expect(askQuestions).not.toHaveBeenCalled();
	});

	it("records the decision for review when interactive UI is unavailable", async () => {
		const sessionManager = SessionManager.inMemory();
		const recordOwnerFollowUp = vi.fn(() => "/tmp/follow-ups/session.md");

		const decision = await resolveGoalCompletionOwnerDecision(input, {
			sessionManager,
			isHandoff: false,
			recordOwnerFollowUp,
		});

		expect(decision).toEqual({ decision: "deferred", followUpPath: "/tmp/follow-ups/session.md" });
		expect(recordOwnerFollowUp).toHaveBeenCalledOnce();
		expect(getLatestHumanInputSnapshots(sessionManager)).toEqual([]);
	});
});
