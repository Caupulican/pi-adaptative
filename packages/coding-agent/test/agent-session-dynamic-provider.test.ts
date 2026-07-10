import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { getModel } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import type { ExtensionFactory } from "../src/core/sdk.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ProfileMenuController } from "../src/modes/interactive/profile-menu-controller.ts";

const profileMenuPrototype = ProfileMenuController.prototype as unknown as {
	deleteProfileFromSource(this: unknown, profileName: string): Promise<void>;
	saveProfileResources(
		this: unknown,
		profile: unknown,
		originalResources: unknown,
		resources: unknown,
		scope: "session" | "directory" | "project" | "global" | "reusable-file",
		isActiveProfile: boolean,
	): Promise<void>;
	rollbackValidatedProfileMutation(this: unknown, snapshot: unknown, definition?: unknown): Promise<unknown>;
	scopeForProfileSource(
		this: unknown,
		source: string,
	): "session" | "directory" | "project" | "global" | "reusable-file";
};

describe("AgentSession dynamic provider registration", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-dynamic-provider-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(
		extensionFactories: ExtensionFactory[],
		options: { enableExtensionProfile?: boolean; restrictTools?: boolean } = {},
	) {
		const settingsManager =
			options.enableExtensionProfile === false
				? SettingsManager.inMemory({ activeResourceProfiles: [] })
				: SettingsManager.create(tempDir, agentDir);
		if (options.enableExtensionProfile ?? true) {
			settingsManager.addInlineResourceProfileDefinitions({
				// Strict UAC: an active profile is a COMPLETE grant, and extension COMMAND dispatch
				// is gated through the tools filter — without a tools grant the /use-proxy command
				// below would be silently denied. These tests exercise provider propagation, not UAC.
				"with-extension": {
					extensions: { allow: ["<inline:1>"] },
					tools: { allow: options.restrictTools ? ["read"] : ["*"] },
				},
			});
			settingsManager.setRuntimeResourceProfiles(["with-extension"]);
		}
		const sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			authStorage,
			resourceLoader,
		});

		return session;
	}

	async function capturePromptBaseUrl(
		session: Awaited<ReturnType<typeof createSession>>,
	): Promise<string | undefined> {
		let baseUrl: string | undefined;
		session.agent.streamFn = async (model) => {
			baseUrl = model.baseUrl;
			throw new Error("stop");
		};
		await session.prompt("hello");
		return baseUrl;
	}

	it("applies top-level registerProvider overrides to the active model", async () => {
		const session = await createSession([
			(pi) => {
				pi.registerProvider("anthropic", { baseUrl: "http://localhost:8080/top-level" });
			},
		]);

		expect(session.model?.baseUrl).toBe("http://localhost:8080/top-level");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/top-level");

		session.dispose();
	});

	it("keeps provider-only extensions active when an explicit profile also restricts tools", async () => {
		const session = await createSession(
			[
				(pi) => {
					pi.registerProvider("anthropic", { baseUrl: "http://localhost:8080/provider-only" });
				},
			],
			{ restrictTools: true },
		);

		expect(session.model?.baseUrl).toBe("http://localhost:8080/provider-only");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/provider-only");

		session.dispose();
	});

	it("applies inline SDK extension providers when no profile filter is active", async () => {
		const session = await createSession(
			[
				(pi) => {
					pi.registerProvider("anthropic", { baseUrl: "http://localhost:8080/default-leak" });
				},
			],
			{ enableExtensionProfile: false },
		);

		expect(session.model?.baseUrl).toBe("http://localhost:8080/default-leak");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/default-leak");

		session.dispose();
	});

	it("applies session_start registerProvider overrides to the active model", async () => {
		const session = await createSession([
			(pi) => {
				pi.on("session_start", () => {
					pi.registerProvider("anthropic", { baseUrl: "http://localhost:8080/session-start" });
				});
			},
		]);

		await session.bindExtensions({});

		expect(session.model?.baseUrl).toBe("http://localhost:8080/session-start");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/session-start");

		session.dispose();
	});

	it("applies command-time registerProvider overrides without reload", async () => {
		const session = await createSession([
			(pi) => {
				pi.registerCommand("use-proxy", {
					description: "Use proxy",
					handler: async () => {
						pi.registerProvider("anthropic", { baseUrl: "http://localhost:8080/command" });
					},
				});
			},
		]);

		await session.bindExtensions({});
		await session.prompt("/use-proxy");

		expect(session.model?.baseUrl).toBe("http://localhost:8080/command");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/command");

		session.dispose();
	});

	it("resolves an active profile model after its startup extension provider is bound", async () => {
		const settingsManager = SettingsManager.inMemory({
			resourceProfiles: {
				provider: {
					model: "profile-provider/sol",
					thinking: "ultra",
					resources: {
						extensions: { allow: ["<inline:1>"] },
						tools: { allow: ["*"] },
					},
				},
			},
			activeResourceProfiles: ["provider"],
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.registerProvider("profile-provider", {
						api: "openai-responses",
						baseUrl: "https://profile-provider.test/v1",
						apiKey: "test-key",
						models: [
							{
								id: "sol",
								name: "Profile Sol",
								reasoning: true,
								defaultThinkingLevel: "low",
								thinkingLevelMap: { max: "max", ultra: "max" },
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 200_000,
								maxTokens: 32_000,
							},
						],
					});
				},
			],
		});
		await resourceLoader.reload();

		const result = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			isExplicitModel: false,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});

		try {
			expect(result.modelFallbackMessage).toBeUndefined();
			expect(result.session.model?.provider).toBe("profile-provider");
			expect(result.session.model?.id).toBe("sol");
			expect(result.session.thinkingLevel).toBe("ultra");
		} finally {
			result.session.dispose();
		}
	});

	it("registers a newly granted extension provider before resolving its profile model and removes it later", async () => {
		const settingsManager = SettingsManager.inMemory({
			resourceProfiles: {
				baseline: {
					resources: { extensions: { block: ["*"] }, tools: { allow: ["*"] } },
				},
				provider: {
					model: "profile-provider/sol",
					thinking: "ultra",
					resources: {
						extensions: { allow: ["<inline:1>"] },
						tools: { allow: ["*"] },
					},
				},
			},
			activeResourceProfiles: ["baseline"],
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.registerProvider("profile-provider", {
						api: "openai-responses",
						baseUrl: "https://profile-provider.test/v1",
						apiKey: "test-key",
						models: [
							{
								id: "sol",
								name: "Profile Sol",
								reasoning: true,
								defaultThinkingLevel: "low",
								thinkingLevelMap: { max: "max", ultra: "max" },
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 200_000,
								maxTokens: 32_000,
							},
						],
					});
				},
			],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			isExplicitModel: false,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});

		try {
			expect(session.modelRegistry.find("profile-provider", "sol")).toBeUndefined();
			settingsManager.setRuntimeResourceProfiles(["provider"]);
			await session.reload();
			expect(session.model?.provider).toBe("profile-provider");
			expect(session.model?.id).toBe("sol");
			expect(session.thinkingLevel).toBe("ultra");

			settingsManager.setRuntimeResourceProfiles(["baseline"]);
			await session.reload();
			expect(session.modelRegistry.find("profile-provider", "sol")).toBeUndefined();
		} finally {
			session.dispose();
		}
	});

	it("tracks service-startup provider ownership so a later profile removal unregisters it", async () => {
		const settingsManager = SettingsManager.inMemory({
			resourceProfiles: {
				provider: {
					resources: { extensions: { allow: ["<inline:1>"] }, tools: { allow: ["*"] } },
				},
				baseline: {
					resources: { extensions: { block: ["*"] }, tools: { allow: ["*"] } },
				},
			},
			activeResourceProfiles: ["provider"],
		});
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir,
			settingsManager,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi) => {
						pi.registerProvider("startup-provider", {
							api: "openai-responses",
							baseUrl: "https://startup-provider.test/v1",
							apiKey: "test-key",
							models: [
								{
									id: "sol",
									name: "Startup Sol",
									reasoning: false,
									input: ["text"],
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
									contextWindow: 16_000,
									maxTokens: 4_000,
								},
							],
						});
					},
				],
			},
		});
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			isExplicitModel: true,
		});

		try {
			expect(session.modelRegistry.find("startup-provider", "sol")).toBeDefined();
			settingsManager.setRuntimeResourceProfiles(["baseline"]);
			await session.reload();
			expect(session.modelRegistry.find("startup-provider", "sol")).toBeUndefined();
		} finally {
			session.dispose();
		}
	});

	it("deleting the active profile atomically removes its disk extension tool, provider, and model", async () => {
		const extensionsDir = join(agentDir, "extensions");
		mkdirSync(extensionsDir, { recursive: true });
		writeFileSync(
			join(extensionsDir, "profile-only.js"),
			[
				"export default (pi) => {",
				"  pi.registerTool({ name: 'profile_only_tool', label: 'Profile only', description: 'Profile-only tool', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }) });",
				"  pi.registerProvider('profile-provider', {",
				"    api: 'openai-responses', baseUrl: 'https://profile-provider.test/v1', apiKey: 'test-key',",
				"    models: [{ id: 'sol', name: 'Profile Sol', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 32000 }]",
				"  });",
				"};",
			].join("\n"),
			"utf-8",
		);
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		settingsManager.setDefaultModelAndProvider("anthropic", "claude-sonnet-4-5");
		settingsManager.setDefaultThinkingLevel("medium");
		settingsManager.setProfileDefinition(
			"provider",
			{
				model: "profile-provider/sol",
				thinking: "high",
				resources: {
					extensions: { allow: ["profile-only.js"] },
					tools: { allow: ["profile_only_tool"] },
				},
			},
			"global",
		);
		settingsManager.setActiveProfile("provider", "global");
		await settingsManager.flush();
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			isExplicitModel: false,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			authStorage,
			resourceLoader,
		});

		try {
			expect({
				model: session.model?.provider,
				providerRegistered: Boolean(session.modelRegistry.find("profile-provider", "sol")),
				tools: session.getAllTools().map((tool) => tool.name),
				resourceErrors: resourceLoader.getExtensions().errors,
			}).toMatchObject({ model: "profile-provider", providerRegistered: true });
			expect(session.thinkingLevel).toBe("high");
			expect(session.getAllTools().map((tool) => tool.name)).toContain("profile_only_tool");
			const showError = vi.fn();
			await profileMenuPrototype.deleteProfileFromSource.call(
				{
					settingsManager,
					scopeForProfileSource: profileMenuPrototype.scopeForProfileSource,
					sessionManager: session.sessionManager,
					session,
					ui: {
						handleReloadCommand: async () => {
							try {
								await session.reload();
								return true;
							} catch (error) {
								showError(error instanceof Error ? error.message : String(error));
								return false;
							}
						},
						footerDataProvider: { setExtensionStatus: vi.fn() },
						invalidateFooter: vi.fn(),
						updateEditorBorderColor: vi.fn(),
						showStatus: vi.fn(),
						showError,
					},
				},
				"provider",
			);
			await settingsManager.flush();

			expect(showError).not.toHaveBeenCalled();
			expect(settingsManager.getActiveResourceProfileNames()).toEqual([]);
			expect(settingsManager.getProfileRegistry().getProfile("provider")).toBeUndefined();
			expect(session.model?.provider).toBe("anthropic");
			expect(session.model?.id).toBe("claude-sonnet-4-5");
			expect(session.thinkingLevel).toBe("medium");
			expect(session.modelRegistry.find("profile-provider", "sol")).toBeUndefined();
			expect(session.getAllTools().map((tool) => tool.name)).not.toContain("profile_only_tool");
		} finally {
			session.dispose();
		}
	});

	it("rejects reload when a newly granted but unselected extension provider is invalid", async () => {
		const settingsManager = SettingsManager.inMemory({
			resourceProfiles: {
				baseline: { resources: { extensions: { block: ["*"] }, tools: { allow: ["*"] } } },
				invalid: {
					resources: { extensions: { allow: ["<inline:1>"] }, tools: { allow: ["*"] } },
				},
			},
			activeResourceProfiles: ["baseline"],
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.registerProvider("invalid-provider", {
						api: "openai-responses",
						apiKey: "test-key",
						models: [
							{
								id: "unused",
								name: "Unused Invalid Model",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 16_000,
								maxTokens: 4_000,
							},
						],
					});
				},
			],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});

		try {
			settingsManager.setRuntimeResourceProfiles(["invalid"]);
			await expect(session.reload()).rejects.toThrow(/invalid-provider.*baseUrl/i);
			expect(session.modelRegistry.find("invalid-provider", "unused")).toBeUndefined();
		} finally {
			session.dispose();
		}
	});

	it("keeps an active profile edit unpersisted when its newly granted extension throws", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		settingsManager.setProfileDefinition(
			"stable",
			{
				resources: {
					extensions: { block: ["*"] },
					tools: { allow: ["*"] },
				},
			},
			"global",
		);
		settingsManager.setActiveProfile("stable", "global");
		await settingsManager.flush();
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		const extensionsDir = join(agentDir, "extensions");
		mkdirSync(extensionsDir, { recursive: true });
		writeFileSync(join(extensionsDir, "throwing.js"), "throw new Error('profile extension exploded');\n");
		const profile = settingsManager.getProfileRegistry().getProfile("stable")!;
		const reloadError = vi.fn();
		const context = {
			settingsManager,
			rollbackValidatedProfileMutation: profileMenuPrototype.rollbackValidatedProfileMutation,
			ui: {
				handleReloadCommand: async () => {
					try {
						await session.reload();
						return true;
					} catch (error) {
						reloadError(error instanceof Error ? error.message : String(error));
						return false;
					}
				},
				footerDataProvider: { setExtensionStatus: vi.fn() },
				invalidateFooter: vi.fn(),
				updateEditorBorderColor: vi.fn(),
				requestRender: vi.fn(),
				showError: vi.fn(),
				showStatus: vi.fn(),
			},
		};

		try {
			await profileMenuPrototype.saveProfileResources.call(
				context,
				profile,
				profile.resources,
				{ extensions: { allow: ["throwing.js"] }, tools: { allow: ["*"] } },
				"global",
				true,
			);
			await settingsManager.flush();

			expect(reloadError).toHaveBeenCalledWith(expect.stringContaining("profile extension exploded"));
			expect(settingsManager.getProfileRegistry().getProfile("stable")?.resources.extensions).toEqual({
				block: ["*"],
			});
			const restarted = SettingsManager.create(tempDir, agentDir);
			expect(restarted.getProfileRegistry().getProfile("stable")?.resources.extensions).toEqual({
				block: ["*"],
			});
		} finally {
			session.dispose();
		}
	});
});
