import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { getModel } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("model routing default", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-router-default-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		vi.stubEnv("TYPESAFE_API_KEY", "");
		vi.stubEnv("OPENROUTER_API_KEY", "");
		vi.stubEnv("PI_SYSTEM_ONE_DISABLED", "");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	async function routerEnabled(authStorage: AuthStorage, settingsManager: SettingsManager): Promise<boolean> {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Missing test model");
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model,
			authStorage,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
		});
		try {
			return session.settingsManager.getModelRouterSettings().enabled;
		} finally {
			await session.disposeAndWait();
		}
	}

	it("is on when the session has System One and off without it", async () => {
		expect(await routerEnabled(AuthStorage.inMemory(), SettingsManager.inMemory())).toBe(false);
		const withKey = AuthStorage.inMemory({ typesafe: { type: "api_key", key: "ts-test-key" } });
		expect(await routerEnabled(withKey, SettingsManager.inMemory())).toBe(true);
	});

	it("keeps an explicit setting either way", async () => {
		const withKey = AuthStorage.inMemory({ typesafe: { type: "api_key", key: "ts-test-key" } });
		expect(await routerEnabled(withKey, SettingsManager.inMemory({ modelRouter: { enabled: false } }))).toBe(false);
		expect(
			await routerEnabled(AuthStorage.inMemory(), SettingsManager.inMemory({ modelRouter: { enabled: true } })),
		).toBe(true);
	});
});
