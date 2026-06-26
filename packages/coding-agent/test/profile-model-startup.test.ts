import type { Model } from "@caupulican/pi-ai";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProfilesDir } from "../src/config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { resolveProfileModelSettings } from "../src/core/model-resolver.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("Profile Model and Thinking Startup Resolution", () => {
	const testDir = join(process.cwd(), "test-profile-startup-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;

	const mockModels: Model<any>[] = [
		{
			id: "claude-sonnet-4-5",
			name: "Claude Sonnet 4.5",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
			contextWindow: 200000,
			maxTokens: 8192,
		},
		{
			id: "claude-haiku-4-5",
			name: "Claude Haiku 4.5",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3 },
			contextWindow: 200000,
			maxTokens: 8192,
		},
	];

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(join(projectDir, ".pi"), { recursive: true });

		authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		// Seed models
		writeFileSync(join(agentDir, "models.json"), JSON.stringify(mockModels));
		modelRegistry.refresh();
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("resolves active profile model and thinking level at startup", async () => {
		const settingsManager = SettingsManager.create(projectDir, agentDir);
		const profilesDir = getProfilesDir(agentDir);
		mkdirSync(profilesDir, { recursive: true });
		writeFileSync(
			join(profilesDir, "test-worker.json"),
			JSON.stringify({
				model: "anthropic/claude-haiku-4-5",
				thinking: "low",
				resources: {},
			}),
		);

		// Now force reload settings/registry
		const registry = settingsManager.getProfileRegistry();
		const profile = registry.getProfile("test-worker");
		expect(profile).toBeDefined();
		expect(profile?.model).toBe("anthropic/claude-haiku-4-5");
		expect(profile?.thinking).toBe("low");

		// Resolve via helper
		const resolved = resolveProfileModelSettings({
			activeProfileNames: ["test-worker"],
			registry,
			modelRegistry,
			cwd: projectDir,
		});

		expect(resolved.model?.id).toBe("claude-haiku-4-5");
		expect(resolved.thinkingLevel).toBe("low");
	});

	it("respects CLI/options explicit overrides over profile model and thinking", async () => {
		const settingsManager = SettingsManager.create(projectDir, agentDir);
		const profilesDir = getProfilesDir(agentDir);
		mkdirSync(profilesDir, { recursive: true });
		writeFileSync(
			join(profilesDir, "test-worker.json"),
			JSON.stringify({
				model: "anthropic/claude-haiku-4-5",
				thinking: "low",
				resources: {},
			}),
		);

		// 1. Explicit model override
		const sessionResult1 = await createAgentSession({
			cwd: projectDir,
			agentDir,
			settingsManager,
			modelRegistry,
			resourceProfiles: ["test-worker"],
			model: mockModels[0], // claude-sonnet-4-5
		});
		expect(sessionResult1.session.model?.id).toBe("claude-sonnet-4-5");
		expect(sessionResult1.session.thinkingLevel).toBe("low"); // thinking from profile still applied!

		// 2. Explicit thinking override
		const sessionResult2 = await createAgentSession({
			cwd: projectDir,
			agentDir,
			settingsManager,
			modelRegistry,
			resourceProfiles: ["test-worker"],
			thinkingLevel: "high",
		});
		expect(sessionResult2.session.model?.id).toBe("claude-haiku-4-5"); // model from profile applied
		expect(sessionResult2.session.thinkingLevel).toBe("high"); // explicit thinking override wins
	});

	it("handles profile model resolution errors gracefully by warning and falling back", async () => {
		const settingsManager = SettingsManager.create(projectDir, agentDir);
		const profilesDir = getProfilesDir(agentDir);
		mkdirSync(profilesDir, { recursive: true });
		writeFileSync(
			join(profilesDir, "test-worker.json"),
			JSON.stringify({
				model: "nonexistent-provider/nonexistent-model",
				thinking: "low",
				resources: {},
			}),
		);

		const sessionResult = await createAgentSession({
			cwd: projectDir,
			agentDir,
			settingsManager,
			modelRegistry,
			resourceProfiles: ["test-worker"],
		});

		// Should fall back to the first available mock model (claude-opus-4-8) instead of crashing
		expect(sessionResult.session.model?.id).toBe("claude-opus-4-8");
		expect(sessionResult.modelFallbackMessage).toContain(
			'Profile model resolution error: Model "nonexistent-provider/nonexistent-model" not found',
		);
	});
});
