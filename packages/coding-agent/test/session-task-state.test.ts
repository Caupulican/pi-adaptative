import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { afterEach, describe, expect, it } from "vitest";
import {
	appendTaskStepsStateSnapshot,
	getLatestTaskStepsStateSnapshot,
	TASK_STEPS_STATE_CUSTOM_TYPE,
} from "../src/core/tasks/session-task-state.ts";
import { addTaskStep, createTaskStepsState } from "../src/core/tasks/task-state.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("session task step state", () => {
	it("persists and restores the latest valid in-memory snapshot", () => {
		const session = SessionManager.inMemory();
		const first = addTaskStep(createTaskStepsState("T0"), { content: "Inspect" }, "T1");
		const second = addTaskStep(first, { content: "Implement" }, "T2");

		appendTaskStepsStateSnapshot(session, first);
		session.appendCustomEntry(TASK_STEPS_STATE_CUSTOM_TYPE, { version: 2, state: second });
		session.appendCustomEntry(TASK_STEPS_STATE_CUSTOM_TYPE, { version: 1, state: { broken: true } });
		appendTaskStepsStateSnapshot(session, second);

		expect(getLatestTaskStepsStateSnapshot(session)).toEqual(second);
	});

	it("does not share state between sessions", () => {
		const firstSession = SessionManager.inMemory();
		const secondSession = SessionManager.inMemory();
		const state = addTaskStep(createTaskStepsState("T0"), { content: "Only first" }, "T1");
		appendTaskStepsStateSnapshot(firstSession, state);

		expect(getLatestTaskStepsStateSnapshot(firstSession)).toEqual(state);
		expect(getLatestTaskStepsStateSnapshot(secondSession)).toBeUndefined();
	});

	it("does not retain caller-owned arrays", () => {
		const session = SessionManager.inMemory();
		const state = addTaskStep(createTaskStepsState("T0"), { content: "Persist", evidence: ["original"] }, "T1");
		appendTaskStepsStateSnapshot(session, state);
		const mutableEvidence = state.steps[0].evidence as string[];
		mutableEvidence.push("mutated");

		expect(getLatestTaskStepsStateSnapshot(session)?.steps[0].evidence).toEqual(["original"]);
	});

	it("restores a snapshot after reopening a persisted session", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-task-steps-"));
		tempDirs.push(directory);
		const session = SessionManager.create(directory, directory, directory);
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "ready" }],
			api: "openai-completions",
			provider: "openai",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const state = addTaskStep(createTaskStepsState("T0"), { content: "Resume" }, "T1");
		appendTaskStepsStateSnapshot(session, state);
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");

		const reopened = SessionManager.open(sessionFile, directory, directory);
		expect(getLatestTaskStepsStateSnapshot(reopened)).toEqual(state);
	});
});
