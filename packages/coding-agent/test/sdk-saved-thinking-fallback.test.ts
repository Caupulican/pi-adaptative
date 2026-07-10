import { SessionManager } from "@caupulican/pi-agent-core/node";
import { getModel } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

describe("createAgentSession saved thinking fallback", () => {
	it("uses a direct model's declared default before the generic fallback", async () => {
		const { session } = await createAgentSession({
			model: getModel("openai-codex", "gpt-5.6-sol"),
			settingsManager: SettingsManager.inMemory(),
			sessionManager: SessionManager.inMemory(),
			resourceLoader: createTestResourceLoader(),
		});

		try {
			expect(session.thinkingLevel).toBe("low");
		} finally {
			session.dispose();
		}
	});

	it("clamps Ultra to Max for a model that does not expose Ultra", async () => {
		const { session } = await createAgentSession({
			model: getModel("openai", "gpt-5.6-luna"),
			settingsManager: SettingsManager.inMemory({ defaultThinkingLevel: "ultra" }),
			sessionManager: SessionManager.inMemory(),
			resourceLoader: createTestResourceLoader(),
		});

		try {
			expect(session.thinkingLevel).toBe("max");
		} finally {
			session.dispose();
		}
	});

	it("preserves saved Ultra when a missing saved model falls back to a supported model", async () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "continue", timestamp: Date.now() });
		sessionManager.appendModelChange("missing-provider", "missing-model");
		sessionManager.appendThinkingLevelChange("ultra");
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("openai", "test-key");
		const settingsManager = SettingsManager.inMemory({
			defaultProvider: "openai",
			defaultModel: "gpt-5.6-sol",
			defaultThinkingLevel: "low",
		});

		const { session } = await createAgentSession({
			authStorage,
			settingsManager,
			sessionManager,
			resourceLoader: createTestResourceLoader(),
		});

		try {
			expect(session.model?.id).toBe("gpt-5.6-sol");
			expect(session.thinkingLevel).toBe("ultra");
		} finally {
			session.dispose();
		}
	});
});
