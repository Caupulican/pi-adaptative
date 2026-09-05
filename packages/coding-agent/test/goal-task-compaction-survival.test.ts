import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createDeterministicCompaction,
	DEFAULT_COMPACTION_SETTINGS,
	prepareCompaction,
} from "@caupulican/pi-agent-core/compaction";
import { createCustomMessage } from "@caupulican/pi-agent-core/messages";
import { SessionManager } from "@caupulican/pi-agent-core/session";
import type { AssistantMessage } from "@caupulican/pi-ai/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ACTIVE_GOAL_CONTEXT_CUSTOM_TYPE,
	captureGoalContextProjection,
	injectCompactGoalContext,
} from "../src/core/goals/compact-goal-context.ts";
import { GOAL_CONTINUATION_TRIGGER_CUSTOM_TYPE } from "../src/core/goals/goal-continuation-prompt.ts";
import { GoalSessionController } from "../src/core/goals/goal-session-controller.ts";
import { createGoalState } from "../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot, getLatestGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import { appendTaskStepsStateSnapshot, getLatestTaskStepsStateSnapshot } from "../src/core/tasks/session-task-state.ts";
import { addTaskStep, createTaskStepsState } from "../src/core/tasks/task-state.ts";

function assistantReply(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 20,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 40,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function appendTurn(sessionManager: SessionManager, text: string, timestamp: number): void {
	sessionManager.appendMessage({ role: "user", content: text, timestamp });
	sessionManager.appendMessage(assistantReply("ok"));
}

function compactSession(sessionManager: SessionManager): string {
	const preparation = prepareCompaction(sessionManager.getBranch(), {
		...DEFAULT_COMPACTION_SETTINGS,
		keepRecentTokens: 1,
	});
	if (!preparation) throw new Error("Expected a compaction preparation");
	const result = createDeterministicCompaction(preparation);
	return sessionManager.appendCompaction(result.summary, result.firstKeptEntryId, result.tokensBefore, result.details);
}

describe("goal/task custom-entry snapshot resolution survives compaction", () => {
	let sessionManager: SessionManager;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-goal-task-compaction-survival-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		sessionManager = SessionManager.create(tempDir, tempDir);
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	it("resolves custom snapshots past the real compaction cut in memory and after reload", () => {
		appendTurn(sessionManager, "turn one", 1);
		const now = new Date().toISOString();
		const goalState = createGoalState({
			goalId: "g-compaction-survival",
			userGoal: "Verify goal state survives compaction",
			now,
		});
		const goalEntryId = appendGoalStateSnapshot(sessionManager, goalState);
		const taskState = addTaskStep(
			createTaskStepsState(now),
			{ content: "Verify task-steps state survives compaction" },
			now,
		);
		const taskEntryId = appendTaskStepsStateSnapshot(sessionManager, taskState);
		appendTurn(sessionManager, "turn two", 2);

		const compactionId = compactSession(sessionManager);
		const branch = sessionManager.getBranch();
		const compactionEntry = branch.find((entry) => entry.id === compactionId);
		if (compactionEntry?.type !== "compaction") {
			throw new Error("Expected the appended compaction entry");
		}
		const goalIndex = branch.findIndex((entry) => entry.id === goalEntryId);
		const taskIndex = branch.findIndex((entry) => entry.id === taskEntryId);
		const firstKeptIndex = branch.findIndex((entry) => entry.id === compactionEntry.firstKeptEntryId);
		expect(firstKeptIndex).toBeGreaterThan(goalIndex);
		expect(firstKeptIndex).toBeGreaterThan(taskIndex);
		expect(sessionManager.getLeafId()).toBe(compactionEntry.id);
		expect(getLatestGoalStateSnapshot(sessionManager)).toEqual(goalState);
		expect(getLatestTaskStepsStateSnapshot(sessionManager)).toEqual(taskState);

		const sessionFilePath = sessionManager.getSessionFile();
		if (!sessionFilePath) throw new Error("Expected a persisted session file path");
		const reloaded = SessionManager.open(sessionFilePath, tempDir);
		expect(reloaded.getLeafId()).toBe(compactionEntry.id);
		expect(getLatestGoalStateSnapshot(reloaded)).toEqual(goalState);
		expect(getLatestTaskStepsStateSnapshot(reloaded)).toEqual(taskState);
	});

	it("keeps chat-admitted goals active and projects one bounded hidden continuation after compaction", () => {
		const warnings: string[] = [];
		const controller = new GoalSessionController({
			getSessionManager: () => sessionManager,
			getModelProvider: () => "anthropic",
			getLaneRecords: () => [],
			getTaskRuntimeSnapshot: () => undefined,
			getBackgroundToolTasks: () => [],
			synchronizeGoalState: () => {},
			scheduleGoalAutoContinueFromIdle: () => {},
			prompt: async () => {},
			emitWarning: (message) => warnings.push(message),
		});
		const objective = "preserve efficient compaction delivery and goal continuation.";
		const ownerPrompt = `Set a persistent goal: ${objective}`;
		appendTurn(sessionManager, ownerPrompt, 1);
		const admission = controller.admitOwnerChatGoal(ownerPrompt, []);
		expect(admission).toMatchObject({ status: "started", state: { status: "active", userGoal: objective } });
		appendTurn(sessionManager, "Generate history that can be summarized.", 2);
		compactSession(sessionManager);

		const state = controller.getState();
		expect(state).toMatchObject({ status: "active", userGoal: objective });
		const continuationTrigger = createCustomMessage(
			GOAL_CONTINUATION_TRIGGER_CUSTOM_TYPE,
			"Continue active goal.",
			false,
			undefined,
			new Date().toISOString(),
		);
		const withTrigger = [...sessionManager.buildSessionContext().messages, continuationTrigger];
		// Captured before the trigger is stripped, exactly as the request planner does.
		const goalProjection = captureGoalContextProjection(withTrigger);
		const providerMessages = injectCompactGoalContext(withTrigger, state, goalProjection);
		const projections = providerMessages.filter(
			(message) => message.role === "custom" && message.customType === ACTIVE_GOAL_CONTEXT_CUSTOM_TYPE,
		);
		expect(projections).toHaveLength(1);
		const projection = projections[0];
		if (projection?.role !== "custom" || typeof projection.content !== "string") {
			throw new Error("Expected one textual compact goal projection");
		}
		// Offered again for the same state, the projection is byte-identical, which is what lets the
		// request planner record it once and keep every later request an append of the previous one.
		const again = injectCompactGoalContext(providerMessages, state, goalProjection).at(-1);
		const againRecord = again && again.role === "custom" ? again : undefined;
		expect(againRecord?.content).toBe(projection.content);
		expect(projection.display).toBe(false);
		expect(projection.content).toContain(objective);
		expect(projection.content.match(/ACTIVE GOAL — HOST-OWNED/g)).toHaveLength(1);
		expect(projection.content.length).toBeLessThan(2_500);
		expect(projection.content).not.toContain("Continue active goal.");
		expect(warnings).toEqual([]);
	});
});
