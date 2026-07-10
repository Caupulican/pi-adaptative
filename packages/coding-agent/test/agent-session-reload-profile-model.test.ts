import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { getModel } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * Regression: the active profile's model/thinking must be re-applied on reload() so a live
 * settings/profile edit takes effect — unless the launch used an explicit --model/--thinking,
 * which must be preserved across reloads.
 */
describe("AgentSession reload re-applies the active profile's model/thinking", () => {
	let tempDir: string;
	let agentDir: string;
	let profilePath: string;

	// Model/thinking binding lives in a profile FILE (profiles/<name>.json), not inline settings.
	const writeProfileModel = (model: string, thinking?: string) => {
		writeFileSync(
			profilePath,
			JSON.stringify({ name: "p", model, ...(thinking ? { thinking } : {}), resources: {} }),
			"utf-8",
		);
	};

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-reload-model-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(join(agentDir, "profiles"), { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ activeResourceProfile: "p" }), "utf-8");
		profilePath = join(agentDir, "profiles", "p.json");
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("switches the model on reload when the active profile's model changes (no explicit flag)", async () => {
		writeProfileModel("anthropic/claude-haiku-4-5");
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();

		// No explicit model passed → profile model applies at startup.
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		expect(session.model?.id).toBe("claude-haiku-4-5");

		// Live edit: change the profile's model, reload.
		writeProfileModel("anthropic/claude-sonnet-4-5");
		await session.reload();
		expect(session.model?.id).toBe("claude-sonnet-4-5");

		session.dispose();
	});

	it("preserves an explicit launch model across reload even if the profile differs", async () => {
		writeProfileModel("anthropic/claude-haiku-4-5");
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();

		// Explicit model wins over the profile and must survive reload.
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			isExplicitModel: true,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		expect(session.model?.id).toBe("claude-sonnet-4-5");

		writeProfileModel("anthropic/claude-haiku-4-5");
		await session.reload();
		expect(session.model?.id).toBe("claude-sonnet-4-5");

		session.dispose();
	});

	it("switches the thinking level on reload when the active profile's thinking changes (no explicit flag)", async () => {
		writeProfileModel("anthropic/claude-haiku-4-5", "low");
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();

		// No explicit thinking passed → profile thinking applies at startup.
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		expect(session.thinkingLevel).toBe("low");

		// Live edit: change the profile's thinking (model stays put), reload.
		writeProfileModel("anthropic/claude-haiku-4-5", "high");
		await session.reload();
		expect(session.thinkingLevel).toBe("high");

		session.dispose();
	});

	it("preserves an explicit launch thinking level across reload even if the profile differs", async () => {
		writeProfileModel("anthropic/claude-haiku-4-5", "low");
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();

		// Explicit thinking wins over the profile and must survive reload.
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			thinkingLevel: "medium",
			isExplicitThinking: true,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		expect(session.thinkingLevel).toBe("medium");

		writeProfileModel("anthropic/claude-haiku-4-5", "high");
		await session.reload();
		expect(session.thinkingLevel).toBe("medium");

		session.dispose();
	});

	it("loads settings exactly once and does not persist profile thinking as the global default", async () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ activeResourceProfile: "p", defaultThinkingLevel: "low" }),
			"utf-8",
		);
		writeProfileModel("anthropic/claude-haiku-4-5", "high");
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		const reloadSettings = vi.spyOn(settingsManager, "reload");

		await session.reload();

		expect(reloadSettings).toHaveBeenCalledTimes(1);
		expect(session.thinkingLevel).toBe("high");
		expect(settingsManager.getGlobalSettings().defaultThinkingLevel).toBe("low");
		session.dispose();
	});

	it("preserves non-explicit model and thinking provenance through the services startup path", async () => {
		writeProfileModel("anthropic/claude-haiku-4-5", "low");
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const services = await createAgentSessionServices({ cwd: tempDir, agentDir, settingsManager });
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(),
			model: getModel("anthropic", "claude-haiku-4-5")!,
			thinkingLevel: "low",
			isExplicitModel: false,
			isExplicitThinking: false,
		});

		writeProfileModel("anthropic/claude-sonnet-4-5", "high");
		await session.reload();

		expect(session.model?.id).toBe("claude-sonnet-4-5");
		expect(session.thinkingLevel).toBe("high");
		session.dispose();
	});

	it("serializes a follow-up reload when settings mutate during an active generation", async () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				activeResourceProfiles: ["p"],
				resourceProfiles: {
					p: {
						model: "anthropic/claude-haiku-4-5",
						thinking: "low",
						resources: {},
					},
				},
			}),
			"utf-8",
		);
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		let releaseFirstReload!: () => void;
		let firstSettingsRead!: () => void;
		const firstSettingsReadPromise = new Promise<void>((resolve) => {
			firstSettingsRead = resolve;
		});
		const releaseFirstReloadPromise = new Promise<void>((resolve) => {
			releaseFirstReload = resolve;
		});
		const reloadSettingsOriginal = settingsManager.reload.bind(settingsManager);
		const reloadSettings = vi.spyOn(settingsManager, "reload");
		reloadSettings.mockImplementationOnce(async () => {
			await reloadSettingsOriginal();
			firstSettingsRead();
			await releaseFirstReloadPromise;
		});

		const firstReload = session.reload();
		await firstSettingsReadPromise;
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				activeResourceProfiles: ["p"],
				resourceProfiles: {
					p: {
						model: "anthropic/claude-sonnet-4-5",
						thinking: "high",
						resources: {},
					},
				},
			}),
			"utf-8",
		);
		const followUpReload = session.reload();
		releaseFirstReload();
		await Promise.all([firstReload, followUpReload]);

		expect(reloadSettings).toHaveBeenCalledTimes(2);
		expect(session.model?.id).toBe("claude-sonnet-4-5");
		expect(session.thinkingLevel).toBe("high");
		session.dispose();
	});
});
