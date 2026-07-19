/**
 * Repro for "compaction survival of goal/task state": does the latest
 * goal_state / task_steps_state custom entry stay resolvable after a REAL compaction
 * whose cut point lands PAST it (i.e. the custom entry falls inside the summarized,
 * not the "kept", span)?
 *
 * Drives a real AgentSession + SessionManager end to end: only the LLM wire is faked
 * (a canned assistant reply / compaction summary), matching the offline-pipeline
 * pattern used by auto-compaction-apply.test.ts. No API key required.
 *
 * The expected outcome is PASS: entries are append-only,
 * `_releaseCompactedMessagePayloads` skips non-message entries (custom entries'
 * `data` is never touched), and branch-ancestry resolution walks past the
 * compaction entry to the custom entries regardless of where the cut point landed.
 * This test is the permanent regression guard for that invariant.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createGoalState } from "../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot, getLatestGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { appendTaskStepsStateSnapshot, getLatestTaskStepsStateSnapshot } from "../src/core/tasks/session-task-state.ts";
import { addTaskStep, createTaskStepsState } from "../src/core/tasks/task-state.ts";
import { createTestResourceLoader } from "./utilities.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function assistantReply(text: string, inputTokens = 20): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: inputTokens,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: inputTokens + 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("goal/task custom-entry snapshot resolution survives compaction", () => {
	let session: AgentSession;
	let sessionManager: SessionManager;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-goal-task-compaction-survival-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (session) session.dispose();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	function createSession() {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			// Real trigger -> prepare -> summarize -> apply pipeline; only the LLM wire is faked.
			streamFn: () => {
				const stream = new MockAssistantStream();
				const compacting = session?.isCompacting === true;
				queueMicrotask(() => {
					const message = compacting
						? assistantReply("## Summary\n- prior conversation summarized", 40)
						: assistantReply("ok", 20);
					stream.push({ type: "done", reason: "stop", message } as AssistantMessageEvent);
				});
				return stream;
			},
		});

		sessionManager = SessionManager.create(tempDir, tempDir);
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		// Aggressive cut: forces the compaction below to actually discard the earlier turn
		// (and, with it, the custom entries appended after that turn) from the "kept" span.
		settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = ModelRegistry.create(authStorage);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});
		return session;
	}

	it("cut point lands past the custom entries; snapshots still resolve in-memory and after reload", async () => {
		createSession();

		// Turn 1: history that will end up on the summarized (discarded) side of the cut.
		await session.prompt("turn one");
		await session.agent.waitForIdle();

		// Latest goal_state / task_steps_state, appended right after turn 1.
		const goalState = createGoalState({
			goalId: "g-compaction-survival",
			userGoal: "Verify goal state survives compaction",
			now: new Date().toISOString(),
		});
		const goalEntryId = appendGoalStateSnapshot(sessionManager, goalState);

		const taskState = addTaskStep(
			createTaskStepsState(new Date().toISOString()),
			{ content: "Verify task-steps state survives compaction" },
			new Date().toISOString(),
		);
		const taskEntryId = appendTaskStepsStateSnapshot(sessionManager, taskState);

		// Sanity: both resolve before compaction ever runs.
		expect(getLatestGoalStateSnapshot(sessionManager)).toEqual(goalState);
		expect(getLatestTaskStepsStateSnapshot(sessionManager)).toEqual(taskState);

		// Turn 2: recent history appended AFTER the custom entries. With keepRecentTokens:1
		// this becomes (part of) the "kept" tail, pushing the custom entries into the
		// discarded/summarized span.
		await session.prompt("turn two");
		await session.agent.waitForIdle();

		const result = await session.compact();
		expect(result.summary.length).toBeGreaterThan(0);

		const branch = sessionManager.getBranch();
		const compactionEntry = branch.find((entry) => entry.type === "compaction");
		if (!compactionEntry || compactionEntry.type !== "compaction") {
			throw new Error("Expected a compaction entry on the branch after session.compact()");
		}

		const goalIndex = branch.findIndex((entry) => entry.id === goalEntryId);
		const taskIndex = branch.findIndex((entry) => entry.id === taskEntryId);
		const firstKeptIndex = branch.findIndex((entry) => entry.id === compactionEntry.firstKeptEntryId);
		expect(goalIndex).toBeGreaterThanOrEqual(0);
		expect(taskIndex).toBeGreaterThanOrEqual(0);
		expect(firstKeptIndex).toBeGreaterThanOrEqual(0);

		// The actual repro condition: the cut point (firstKeptEntryId) is AFTER both custom
		// entries in path order, i.e. they fall inside the summarized span, not the kept tail.
		expect(firstKeptIndex).toBeGreaterThan(goalIndex);
		expect(firstKeptIndex).toBeGreaterThan(taskIndex);

		// The compaction entry itself is the new leaf, and the custom entries remain its
		// ancestors (append-only tree; compaction never removes entries).
		expect(sessionManager.getLeafId()).toBe(compactionEntry.id);

		// In-memory: the public AgentSession accessors still resolve past the compaction entry.
		expect(session.getGoalStateSnapshot()).toEqual(goalState);
		expect(session.getTaskStepsStateSnapshot()).toEqual(taskState);
		// Same assertion at the resolver layer directly against the live sessionManager.
		expect(getLatestGoalStateSnapshot(sessionManager)).toEqual(goalState);
		expect(getLatestTaskStepsStateSnapshot(sessionManager)).toEqual(taskState);

		// Reload: cold-load the persisted session file through the real SessionManager load
		// path (not a hand-parsed read), simulating e.g. /reload picking the file back up.
		const sessionFilePath = sessionManager.getSessionFile();
		if (!sessionFilePath) throw new Error("Expected a persisted session file path");
		session.dispose();

		const reloaded = SessionManager.open(sessionFilePath, tempDir);
		expect(reloaded.getLeafId()).toBe(compactionEntry.id);
		expect(getLatestGoalStateSnapshot(reloaded)).toEqual(goalState);
		expect(getLatestTaskStepsStateSnapshot(reloaded)).toEqual(taskState);
	}, 30_000);
});
