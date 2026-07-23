import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { getModel } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { DEFAULT_ACTIVE_TOOL_NAMES } from "../src/core/default-tool-surface.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ORCHESTRATION_SCHEMA_VERSION, type OrchestrationProfile } from "../src/core/orchestration/contracts.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("SDK default tool surface", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sdk-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("keeps goal, delegation, and toolkit capabilities on capable SDK-created sessions", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Missing test model");

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model,
			settingsManager,
			resourceLoader,
			sessionManager: SessionManager.inMemory(),
		});
		try {
			expect(session.getActiveToolNames()).toEqual([
				...DEFAULT_ACTIVE_TOOL_NAMES,
				"artifact_retrieve",
				"delegate_status",
			]);
			expect(session.getActiveToolNames()).toContain("delegate");
		} finally {
			session.dispose();
		}
	});

	it("activates a complete one-shot UAC situation through the SDK", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Missing test model");

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model,
			sessionManager: SessionManager.inMemory(),
			resourceProfileDefinitions: {
				"sdk-review": {
					model: `${model.provider}/${model.id}`,
					thinking: "high",
					soul: "Review this workspace without editing it.",
					modelRouter: { enabled: true, cheapThinking: "low" },
					resources: { tools: { allow: ["read", "delegate"] } },
				},
			},
			resourceProfiles: ["sdk-review"],
		});
		try {
			expect(session.getActiveToolNames()).toEqual(["read", "delegate"]);
			expect(session.thinkingLevel).toBe("high");
			expect(session.systemPrompt).toContain("Review this workspace without editing it.");
			expect(session.settingsManager.getModelRouterSettings()).toMatchObject({
				enabled: true,
				cheapThinking: "low",
			});
		} finally {
			session.dispose();
		}
	});

	it("treats an SDK orchestration profile as an immutable model and construction boundary", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Missing test model");
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		const now = new Date().toISOString();
		const profile: OrchestrationProfile = {
			schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
			profileId: "sdk-operator",
			description: "Pinned SDK operator",
			role: "operator",
			modelPolicy: {
				mode: "fixed",
				candidates: [{ provider: model.provider, modelId: model.id, thinkingLevel: "off" }],
			},
			capabilityCeiling: ["filesystem.read", "process.exec"],
			toolNames: ["read", "run_process"],
			resourceProfileNames: [],
			dispatchProfileIds: [],
			executionPolicy: {
				allowedExecutables: [process.execPath],
				allowedEnvironmentVariables: [],
				maxOutputBytes: 16_384,
			},
			budget: { maxWallClockMs: 5_000, maxToolCalls: 4, maxTokens: 8_192, maxCostUsd: 1 },
			maxConcurrent: 1,
			leaseTtlMs: 10_000,
			requireIndependentVerification: false,
			createdAt: now,
			updatedAt: now,
		};

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			authStorage,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			orchestrationProfile: profile,
		});
		try {
			expect(session.model?.id).toBe(model.id);
			expect(session.thinkingLevel).toBe("off");
			expect(session.getActiveToolNames()).toEqual(["read", "run_process"]);
			expect(session.getToolDefinition("bash")).toBeUndefined();
		} finally {
			session.dispose();
		}

		await expect(
			createAgentSession({
				cwd: tempDir,
				agentDir,
				authStorage,
				modelRegistry,
				sessionManager: SessionManager.inMemory(),
				orchestrationProfile: profile,
				tools: ["bash"],
			}),
		).rejects.toThrow("owns model, thinking, tools, and resources");
	});

	it("lets an explicit empty SDK selection clear persisted active profiles", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Missing test model");
		const settingsManager = SettingsManager.inMemory({
			resourceProfiles: {
				locked: { resources: { tools: { allow: ["read"] } } },
			},
			activeResourceProfiles: ["locked"],
		});
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();
		const reload = vi.spyOn(resourceLoader, "reload");

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model,
			settingsManager,
			resourceLoader,
			sessionManager: SessionManager.inMemory(),
			resourceProfiles: [],
		});
		try {
			expect(reload).toHaveBeenCalledTimes(1);
			expect(settingsManager.getActiveResourceProfileNames()).toEqual([]);
			expect(session.getActiveToolNames()).toEqual([
				...DEFAULT_ACTIVE_TOOL_NAMES,
				"artifact_retrieve",
				"delegate_status",
			]);
		} finally {
			session.dispose();
		}
	});

	it("lets an explicit empty services selection clear persisted active profiles", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Missing test model");
		const settingsManager = SettingsManager.inMemory({
			resourceProfiles: {
				locked: { resources: { tools: { allow: ["read"] } } },
			},
			activeResourceProfiles: ["locked"],
		});
		const services = await createAgentSessionServices({ cwd: tempDir, agentDir, settingsManager });
		expect(settingsManager.getActiveResourceProfileNames()).toEqual(["locked"]);

		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(),
			model,
			resourceProfiles: [],
		});
		try {
			expect(settingsManager.getActiveResourceProfileNames()).toEqual([]);
			expect(session.getActiveToolNames()).toEqual([
				...DEFAULT_ACTIVE_TOOL_NAMES,
				"artifact_retrieve",
				"delegate_status",
			]);
		} finally {
			session.dispose();
		}
	});
});
