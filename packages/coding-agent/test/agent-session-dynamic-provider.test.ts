import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import type { ExtensionFactory } from "../src/core/sdk.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

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
				"with-extension": {
					extensions: { allow: ["<inline:1>"] },
					...(options.restrictTools ? { tools: { allow: ["read"] } } : {}),
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

	it("does not apply top-level registerProvider overrides from extensions when no profile is active", async () => {
		const session = await createSession(
			[
				(pi) => {
					pi.registerProvider("anthropic", { baseUrl: "http://localhost:8080/default-leak" });
				},
			],
			{ enableExtensionProfile: false },
		);

		expect(session.model?.baseUrl).toBe("https://api.anthropic.com");
		expect(await capturePromptBaseUrl(session)).toBe("https://api.anthropic.com");

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
});
