import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import {
	type Api,
	fauxAssistantMessage,
	fauxToolCall,
	getModel,
	type Model,
	registerFauxProvider,
} from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { getWorkerRequestSnapshots } from "../src/core/delegation/session-worker-claim.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	createTestWorkerOrchestrationProfile,
	saveTestWorkerOrchestrationProfile,
} from "./orchestration-profile-fixture.ts";
import { completedWorkerOutput } from "./worker-output-fixture.ts";

/**
 * Side M + Side H integration: the bundled file-store provider must surface the root `memory` tool
 * (active/model-callable) and inject the MEMORY.md/USER.md snapshot into the root system prompt;
 * child sessions receive neither root memory surface.
 */
describe("Memory subsystem integration (file-store)", () => {
	let tempDir: string;
	let agentDir: string;
	const sessions: Array<{ disposeAndWait(): Promise<void> }> = [];

	const newSession = async (
		opts: {
			isChildSession?: boolean;
			extensionFactories?: unknown[];
			model?: Model<Api>;
			authStorage?: AuthStorage;
			memoryEnabled?: boolean;
		} = {},
	) => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const selectedModel = opts.model ?? getModel("anthropic", "claude-sonnet-4-5")!;
		settingsManager.setWorkerDelegationSettings({
			enabled: true,
			orchestrationProfile: "memory-worker-profile",
		});
		saveTestWorkerOrchestrationProfile({
			agentDir,
			cwd: tempDir,
			profile: createTestWorkerOrchestrationProfile({
				profileId: "memory-worker-profile",
				model: selectedModel,
				capabilityCeiling: ["filesystem.read", "memory.query"],
				toolNames: ["read", "memory_read"],
			}),
		});
		if (opts.memoryEnabled !== undefined) {
			settingsManager.setMemoryRetrievalSettings({ enabled: opts.memoryEnabled });
		}
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: opts.extensionFactories as any,
		});
		await resourceLoader.reload();
		const authStorage = opts.authStorage ?? AuthStorage.inMemory();
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		if (opts.model) {
			modelRegistry.registerProvider(selectedModel.provider, {
				baseUrl: selectedModel.baseUrl,
				apiKey: "faux-key",
				api: selectedModel.api,
				models: [
					{
						id: selectedModel.id,
						name: selectedModel.name,
						api: selectedModel.api,
						reasoning: selectedModel.reasoning,
						input: selectedModel.input,
						cost: selectedModel.cost,
						contextWindow: selectedModel.contextWindow,
						maxTokens: selectedModel.maxTokens,
						baseUrl: selectedModel.baseUrl,
					},
				],
			});
		}
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: selectedModel,
			authStorage,
			modelRegistry,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
			isChildSession: opts.isChildSession,
		});
		sessions.push(session);
		await session.bindExtensions({});
		return session;
	};

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-mem-int-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(async () => {
		while (sessions.length > 0) await sessions.pop()?.disposeAndWait();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	it("surfaces the `memory` tool (active) and injects MEMORY.md into the system prompt", async () => {
		writeFileSync(join(agentDir, "MEMORY.md"), "The deploy command is `npm run release:patch`.", "utf-8");

		const session = await newSession();

		const allToolNames = session.getAllTools().map((t) => t.name);
		expect(allToolNames).toContain("memory");
		expect(session.getActiveToolNames()).toContain("memory");
		expect(session.systemPrompt).toContain("The deploy command is `npm run release:patch`.");

		session.dispose();
	});

	it("gives a delegated worker only the bounded memory_read adapter", async () => {
		writeFileSync(join(agentDir, "MEMORY.md"), "LANE_MEMORY_READ_OK is the standing marker.\n", "utf-8");
		writeFileSync(join(agentDir, "USER.md"), "", "utf-8");
		const faux = registerFauxProvider({ models: [{ id: "memory-worker", contextWindow: 128_000 }] });
		const model = faux.getModel("memory-worker");
		if (!model) throw new Error("Expected faux memory worker model");
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const session = await newSession({ model, authStorage });
		let workerTools: string[] = [];
		let memorySchema = "";
		try {
			faux.setResponses([
				(context) => {
					workerTools = context.tools?.map((tool) => tool.name) ?? [];
					memorySchema = JSON.stringify(context.tools?.find((tool) => tool.name === "memory_read")?.parameters);
					return fauxAssistantMessage([fauxToolCall("memory_read", { query: "standing marker" })], {
						stopReason: "toolUse",
					});
				},
				(context) => {
					const recalled = JSON.stringify(context.messages).includes("LANE_MEMORY_READ_OK");
					return fauxAssistantMessage(
						recalled
							? completedWorkerOutput("bounded memory_read recall succeeded")
							: '{"summary":"memory recall failed","status":"blocked","blockers":["marker absent"]}',
					);
				},
			]);

			const run = await session.runWorkerDelegationOnce({
				instructions: "Recall the standing marker",
			});

			expect(run.record?.status).toBe("succeeded");
			expect(run.outcome?.claim.summary).toBe("bounded memory_read recall succeeded");
			expect(workerTools).toContain("memory_read");
			expect(workerTools).not.toContain("memory");
			expect(memorySchema).toContain("query");
			expect(memorySchema).not.toContain("action");
			const request = getWorkerRequestSnapshots(session.sessionManager.getEntries()).at(-1);
			expect(request?.envelope.allowedTools).toContain("memory_read");
			expect(request?.envelope.allowedTools).not.toContain("memory");
			expect(request?.envelope.capabilities).toContain("memory.query");
			expect(readFileSync(join(agentDir, "MEMORY.md"), "utf-8")).toBe(
				"LANE_MEMORY_READ_OK is the standing marker.\n",
			);
		} finally {
			session.dispose();
			faux.unregister();
		}
	});

	it("keeps delegated memory unavailable when memory retrieval is disabled globally", async () => {
		writeFileSync(join(agentDir, "MEMORY.md"), "DISABLED_MEMORY_MARKER must not be returned.\n", "utf-8");
		writeFileSync(join(agentDir, "USER.md"), "", "utf-8");
		const faux = registerFauxProvider({ models: [{ id: "disabled-memory-worker", contextWindow: 128_000 }] });
		const model = faux.getModel("disabled-memory-worker");
		if (!model) throw new Error("Expected faux disabled-memory worker model");
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const session = await newSession({ model, authStorage, memoryEnabled: false });
		try {
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("memory_read", { query: "disabled marker" })], {
					stopReason: "toolUse",
				}),
				(context) =>
					fauxAssistantMessage(
						JSON.stringify(context.messages).includes("DISABLED_MEMORY_MARKER")
							? '{"summary":"policy bypassed","status":"blocked","blockers":["memory leaked"]}'
							: completedWorkerOutput("memory remained disabled"),
					),
			]);

			const run = await session.runWorkerDelegationOnce({
				instructions: "Check whether memory is enabled",
			});

			expect(run.outcome?.claim.summary).toBe("memory remained disabled");
			expect(JSON.stringify(run.outcome?.claim)).not.toContain("DISABLED_MEMORY_MARKER");
		} finally {
			session.dispose();
			faux.unregister();
		}
	});

	it("lets an extension register a memory provider via pi.registerMemoryProvider", async () => {
		const customProvider = {
			name: "test-mem",
			isAvailable: () => true,
			getCapabilities: () => ({ surfaces: ["context" as const] }),
			initialize: async () => {},
			shutdown: async () => {},
			systemPromptBlock: () => "CUSTOM-MEMORY-BLOCK-XYZ",
		};
		const session = await newSession({
			extensionFactories: [
				(pi: any) => {
					pi.on("session_start", () => {
						pi.registerMemoryProvider(customProvider);
					});
				},
			],
		});

		expect(session.systemPrompt).toContain("CUSTOM-MEMORY-BLOCK-XYZ");

		session.dispose();
	});

	it("omits root memory tools and prompt snapshots from child sessions", async () => {
		writeFileSync(join(agentDir, "MEMORY.md"), "CHILD_MEMORY_MUST_STAY_PRIVATE\n", "utf-8");
		const session = await newSession({ isChildSession: true });
		expect(session.getToolDefinition("memory")).toBeUndefined();
		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("memory");
		expect(session.systemPrompt).not.toContain("CHILD_MEMORY_MUST_STAY_PRIVATE");
		expect(session.systemPrompt).not.toContain("Persistent Memory (file-store)");

		session.dispose();
	});
});
