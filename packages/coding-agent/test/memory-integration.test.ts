import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * Side M + Side H integration: the bundled file-store provider must surface the `memory` tool
 * (active/model-callable) and inject the MEMORY.md/USER.md snapshot into the system prompt; child
 * sessions must not be able to persist.
 */
describe("Memory subsystem integration (file-store)", () => {
	let tempDir: string;
	let agentDir: string;

	const newSession = async (opts: { isChildSession?: boolean; extensionFactories?: unknown[] } = {}) => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
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
			model: getModel("anthropic", "claude-sonnet-4-5")!,
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
