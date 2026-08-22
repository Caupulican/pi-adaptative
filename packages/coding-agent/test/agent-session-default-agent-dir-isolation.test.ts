import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Agent } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { getModel } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR, getAgentDir } from "../src/config.ts";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

describe("AgentSession test agent-directory isolation", () => {
	it("redirects an omitted agentDir away from the real user directory", () => {
		const isolatedAgentDir = process.env[ENV_AGENT_DIR];
		expect(isolatedAgentDir).toBeDefined();
		if (!isolatedAgentDir) throw new Error("Missing isolated test agent directory");
		expect(resolve(getAgentDir())).toBe(resolve(isolatedAgentDir));
		expect(resolve(getAgentDir())).not.toBe(resolve(join(homedir(), CONFIG_DIR_NAME, "agent")));

		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Missing test model");
		const authStorage = AuthStorage.inMemory();
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: "test", tools: [], thinkingLevel: "off" },
			}),
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.inMemory(),
			resourceLoader: createTestResourceLoader(),
			cwd: process.cwd(),
			modelRegistry: ModelRegistry.inMemory(authStorage),
		});

		try {
			expect(Reflect.get(session, "_agentDir")).toBe(getAgentDir());
		} finally {
			session.dispose();
		}
	});
});
