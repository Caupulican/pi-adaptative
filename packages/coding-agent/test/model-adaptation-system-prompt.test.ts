import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import {
	type Api,
	formatToolRepairStandingRule,
	type Model,
	type ToolArgumentValidationTelemetryEvent,
} from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelAdaptationStore } from "../src/core/models/adaptation-store.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function createModel(id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "test-provider",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

async function createSession(cwd: string, agentDir: string, model: Model<Api>) {
	return createAgentSession({
		cwd,
		agentDir,
		model,
		authStorage: AuthStorage.create(join(agentDir, "auth.json")),
		modelRegistry: ModelRegistry.create(
			AuthStorage.create(join(agentDir, "auth.json")),
			join(agentDir, "models.json"),
		),
		settingsManager: SettingsManager.create(cwd, agentDir),
		sessionManager: SessionManager.inMemory(cwd),
	});
}

function repairEvent(model: Model<Api>): ToolArgumentValidationTelemetryEvent {
	return {
		outcome: "repaired",
		provider: model.provider,
		model: model.id,
		tool: "collect",
		failureModes: ["jsonStringParse"],
		repairsApplied: ["jsonStringParse"],
		taught: "none",
		executionOutcome: "succeeded",
	};
}

describe("model adaptation system prompt", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-model-adaptation-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("persists repeated repair modes and injects only the current model's standing rules", async () => {
		const model = createModel("model-a");
		const otherModel = createModel("model-b");
		const ruleText = formatToolRepairStandingRule("jsonStringParse");

		const first = await createSession(cwd, agentDir, model);
		try {
			first.session.agent.onToolArgumentValidation?.(repairEvent(model));
			first.session.agent.onToolArgumentValidation?.(repairEvent(model));
			first.session.agent.onToolArgumentValidation?.(repairEvent(model));
		} finally {
			first.session.dispose();
		}

		const stored = ModelAdaptationStore.forAgentDir(agentDir).get(`${model.provider}/${model.id}`);
		expect(stored.rules.map((rule) => rule.text)).toEqual([ruleText]);

		const second = await createSession(cwd, agentDir, model);
		try {
			expect(second.session.agent.state.systemPrompt).toContain(ruleText);
		} finally {
			second.session.dispose();
		}

		const other = await createSession(cwd, agentDir, otherModel);
		try {
			expect(other.session.agent.state.systemPrompt).not.toContain(ruleText);
		} finally {
			other.session.dispose();
		}
	});

	it("omits retired standing rules from the system prompt", async () => {
		const model = createModel("model-retired");
		const ruleText = formatToolRepairStandingRule("jsonStringParse");
		const store = ModelAdaptationStore.forAgentDir(agentDir);
		store.addRule(
			`${model.provider}/${model.id}`,
			{
				mode: "jsonStringParse",
				text: ruleText,
				addedAt: "2026-01-01T00:00:00.000Z",
				lastFiredAt: "2026-01-01T00:00:00.000Z",
			},
			new Date("2026-01-01T00:00:00.000Z"),
		);

		const session = await createSession(cwd, agentDir, model);
		try {
			expect(session.session.agent.state.systemPrompt).not.toContain(ruleText);
		} finally {
			session.session.dispose();
		}
	});
});
