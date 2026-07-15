import { Agent } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { getModel } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { addTaskStep, createTaskStepsState } from "../src/core/tasks/task-state.ts";
import { createTestResourceLoader } from "./utilities.ts";

function createSession(): AgentSession {
	const model = getModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Missing test model");
	const agent = new Agent({
		getApiKey: () => "test",
		initialState: { model, systemPrompt: "test", tools: [], thinkingLevel: "off" },
	});
	return new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settingsManager: SettingsManager.inMemory(),
		resourceLoader: createTestResourceLoader(),
		cwd: process.cwd(),
		modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
	});
}

describe("native task_steps session integration", () => {
	it("saves and restores task state through AgentSession", () => {
		const session = createSession();
		const state = addTaskStep(createTaskStepsState("T0"), { content: "Persist natively" }, "T1");
		session.saveTaskStepsStateSnapshot(state);
		expect(session.getTaskStepsStateSnapshot()).toEqual(state);
	});

	it("registers task_steps as an active built-in tool", async () => {
		const session = createSession();
		expect(session.getActiveToolNames()).toContain("task_steps");
		const tool = session.getToolDefinition("task_steps");
		if (!tool) throw new Error("task_steps tool not registered");

		await tool.execute(
			"call-1",
			{ action: "add", content: "Wire native task steps", status: "in_progress" },
			undefined,
			undefined,
			undefined as never,
		);
		expect(session.getTaskStepsStateSnapshot()?.steps[0]).toMatchObject({
			content: "Wire native task steps",
			status: "in_progress",
		});
	});
});
