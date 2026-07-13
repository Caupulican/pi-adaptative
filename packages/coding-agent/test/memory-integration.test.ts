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
import { getWorkerRequestSnapshots } from "../src/core/delegation/session-worker-result.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * Side M + Side H integration: the bundled file-store provider must surface the `memory` tool
 * (active/model-callable) and inject the MEMORY.md/USER.md snapshot into the system prompt; child
 * sessions must not be able to persist.
 */
describe("Memory subsystem integration (file-store)", () => {
	let tempDir: string;
	let agentDir: string;

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
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: opts.model ?? getModel("anthropic", "claude-sonnet-4-5")!,
			authStorage: opts.authStorage,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
			isChildSession: opts.isChildSession,
		});
		await session.bindExtensions({});
		return session;
	};

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-mem-int-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
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

	it("gives an orchestrator-authorized worker bounded read-only file-store memory", async () => {
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
					memorySchema = JSON.stringify(context.tools?.find((tool) => tool.name === "memory")?.parameters);
					return fauxAssistantMessage([fauxToolCall("memory", { query: "standing marker" })], {
						stopReason: "toolUse",
					});
				},
				(context) => {
					const recalled = JSON.stringify(context.messages).includes("LANE_MEMORY_READ_OK");
					return fauxAssistantMessage(
						recalled
							? '{"summary":"read-only memory recall succeeded"}'
							: '{"summary":"memory recall failed","status":"blocked","blockers":["marker absent"]}',
					);
				},
			]);

			const run = await session.runWorkerDelegationOnce({
				instructions: "Recall the standing marker",
				memoryRead: true,
			});

			expect(run.record?.status).toBe("succeeded");
			expect(run.outcome?.result.summary).toBe("read-only memory recall succeeded");
			expect(workerTools).toContain("memory");
			expect(memorySchema).toContain("query");
			expect(memorySchema).not.toContain("action");
			const request = getWorkerRequestSnapshots(session.sessionManager.getEntries()).at(-1);
			expect(request?.envelope.capabilities).toContain("memory_read");
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
				fauxAssistantMessage([fauxToolCall("memory", { query: "disabled marker" })], { stopReason: "toolUse" }),
				(context) =>
					fauxAssistantMessage(
						JSON.stringify(context.messages).includes("DISABLED_MEMORY_MARKER")
							? '{"summary":"policy bypassed","status":"blocked","blockers":["memory leaked"]}'
							: '{"summary":"memory remained disabled"}',
					),
			]);

			const run = await session.runWorkerDelegationOnce({
				instructions: "Check whether memory is enabled",
				memoryRead: true,
			});

			expect(run.outcome?.result.summary).toBe("memory remained disabled");
			expect(JSON.stringify(run.outcome?.result)).not.toContain("DISABLED_MEMORY_MARKER");
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

	it("blocks memory writes in a child session", async () => {
		const session = await newSession({ isChildSession: true });
		const memoryTool = session.getToolDefinition("memory");
		expect(memoryTool).toBeDefined();

		const result = await memoryTool!.execute(
			"call-1",
			{ action: "add", target: "memory", content: "secret" },
			new AbortController().signal,
			() => {},
			{} as never,
		);
		const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
		expect(text.toLowerCase()).toContain("child session");

		session.dispose();
	});
});
