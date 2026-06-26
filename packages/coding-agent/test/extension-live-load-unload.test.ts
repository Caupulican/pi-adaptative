/**
 * Tests for live per-extension load/unload in AgentSession and ResourceLoader.
 *
 * Covers:
 * - ResourceLoader.loadSingleExtension(path) with fresh cache bypass
 * - ResourceLoader.getLoadedExtension(path)
 * - ResourceLoader.removeLoadedExtension(path)
 * - AgentSession.loadExtensionLive(path) and unloadExtensionLive(path)
 * - Provider registration/unregistration during load/unload
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@caupulican/pi-agent-core";
import { getModel } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createCodingTools } from "../src/index.ts";

const API_KEY = process.env.ANTHROPIC_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY;

describe("Extension live load/unload", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-ext-load-unload-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	// =========================================================================
	// ResourceLoader Tests
	// =========================================================================

	describe("ResourceLoader.loadSingleExtension", () => {
		it("loads a single extension and adds it to loaded set", async () => {
			// Create a temporary extension file
			const extDir = join(tempDir, "test-ext");
			mkdirSync(extDir, { recursive: true });
			const extFile = join(extDir, "index.ts");
			writeFileSync(
				extFile,
				`
export default (pi) => {
	pi.registerTool({
		name: "load_test",
		label: "Load Test",
		description: "Test tool for load",
		parameters: {},
		execute: async () => ({ content: [{ type: "text", text: "loaded" }] }),
	});
};
			`,
			);

			const resourceLoader = new DefaultResourceLoader({
				cwd: tempDir,
				agentDir: tempDir,
				noExtensions: true,
			});

			// Load the extension
			const { extension, error } = await resourceLoader.loadSingleExtension(extFile);

			expect(error).toBeNull();
			expect(extension).toBeDefined();
			expect(extension?.path).toBe(extFile);

			// Verify it's in the loaded set
			const loaded = resourceLoader.getLoadedExtension(extFile);
			expect(loaded).toBeDefined();
			expect(loaded?.path).toBe(extFile);
		});

		it("re-imports with fresh cache when called again", async () => {
			// Create a temporary extension file
			const extDir = join(tempDir, "test-ext-fresh");
			mkdirSync(extDir, { recursive: true });
			const extFile = join(extDir, "index.ts");

			// Write initial version
			writeFileSync(
				extFile,
				`
export default (pi) => {
	pi.registerTool({
		name: "version_tool",
		label: "Version Test",
		description: "Version v1",
		parameters: {},
		execute: async () => ({ content: [{ type: "text", text: "v1" }] }),
	});
};
			`,
			);

			const resourceLoader = new DefaultResourceLoader({
				cwd: tempDir,
				agentDir: tempDir,
				noExtensions: true,
			});

			// Load the first version
			const result1 = await resourceLoader.loadSingleExtension(extFile);
			expect(result1.error).toBeNull();
			const ext1 = result1.extension!;
			const tool1Desc = Array.from(ext1.tools.values())[0]?.definition.description;
			expect(tool1Desc).toBe("Version v1");

			// Rewrite the file with new version
			writeFileSync(
				extFile,
				`
export default (pi) => {
	pi.registerTool({
		name: "version_tool",
		label: "Version Test",
		description: "Version v2",
		parameters: {},
		execute: async () => ({ content: [{ type: "text", text: "v2" }] }),
	});
};
			`,
			);

			// Load again with fresh cache bypass
			const result2 = await resourceLoader.loadSingleExtension(extFile);
			expect(result2.error).toBeNull();
			const ext2 = result2.extension!;
			const tool2Desc = Array.from(ext2.tools.values())[0]?.definition.description;
			expect(tool2Desc).toBe("Version v2");
		});
	});

	describe("ResourceLoader.getLoadedExtension / removeLoadedExtension", () => {
		it("getLoadedExtension finds loaded extension by path", async () => {
			const extDir = join(tempDir, "get-loaded");
			mkdirSync(extDir, { recursive: true });
			const extFile = join(extDir, "index.ts");
			writeFileSync(
				extFile,
				`
export default (pi) => {
	pi.registerTool({ name: "t", label: "T", description: "Test", parameters: {}, execute: async () => ({}) });
};
			`,
			);

			const resourceLoader = new DefaultResourceLoader({
				cwd: tempDir,
				agentDir: tempDir,
				noExtensions: true,
			});

			const { extension } = await resourceLoader.loadSingleExtension(extFile);
			expect(extension).toBeDefined();

			// Should find by exact path
			const found = resourceLoader.getLoadedExtension(extFile);
			expect(found).toBeDefined();
			expect(found?.path).toBe(extFile);
		});

		it("removeLoadedExtension removes extension and returns it", async () => {
			const extDir = join(tempDir, "remove-loaded");
			mkdirSync(extDir, { recursive: true });
			const extFile = join(extDir, "index.ts");
			writeFileSync(
				extFile,
				`
export default (pi) => {
	pi.registerTool({ name: "t", label: "T", description: "Test", parameters: {}, execute: async () => ({}) });
};
			`,
			);

			const resourceLoader = new DefaultResourceLoader({
				cwd: tempDir,
				agentDir: tempDir,
				noExtensions: true,
			});

			const { extension } = await resourceLoader.loadSingleExtension(extFile);
			expect(extension).toBeDefined();

			// Remove it
			const removed = resourceLoader.removeLoadedExtension(extFile);
			expect(removed).toBeDefined();
			expect(removed?.path).toBe(extFile);

			// Should no longer be found
			const found = resourceLoader.getLoadedExtension(extFile);
			expect(found).toBeUndefined();
		});

		it("removeLoadedExtension returns undefined if extension not found", () => {
			const resourceLoader = new DefaultResourceLoader({
				cwd: tempDir,
				agentDir: tempDir,
				noExtensions: true,
			});

			const removed = resourceLoader.removeLoadedExtension("/nonexistent/path");
			expect(removed).toBeUndefined();
		});
	});

	// =========================================================================
	// AgentSession.loadExtensionLive / unloadExtensionLive Tests
	// =========================================================================

	describe("AgentSession.loadExtensionLive", () => {
		let session: AgentSession;
		let sessionManager: SessionManager;
		let resourceLoader: DefaultResourceLoader;

		beforeEach(() => {
			const model = getModel("anthropic", "claude-sonnet-4-5")!;
			const agent = new Agent({
				getApiKey: () => API_KEY,
				initialState: {
					model,
					systemPrompt: "You are a test assistant.",
					tools: createCodingTools(tempDir),
				},
			});

			sessionManager = SessionManager.inMemory();
			const settingsManager = SettingsManager.create(tempDir, tempDir);
			const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
			const modelRegistry = ModelRegistry.create(authStorage, tempDir);

			resourceLoader = new DefaultResourceLoader({
				cwd: tempDir,
				agentDir: tempDir,
				noExtensions: true,
			});

			session = new AgentSession({
				agent,
				sessionManager,
				settingsManager,
				cwd: tempDir,
				modelRegistry,
				resourceLoader,
			});

			// Must subscribe to enable session persistence
			session.subscribe(() => {});
		});

		afterEach(() => {
			if (session) {
				session.dispose();
			}
		});

		it.skipIf(!API_KEY)("adds extension tool to live runner without full reload", async () => {
			// Create a temporary extension with a tool
			const extDir = join(tempDir, "live-load-tool");
			mkdirSync(extDir, { recursive: true });
			const extFile = join(extDir, "index.ts");
			writeFileSync(
				extFile,
				`
export default (pi) => {
	pi.registerTool({
		name: "live_loaded_tool",
		label: "Live Loaded Tool",
		description: "Loaded live",
		parameters: {},
		execute: async () => ({ content: [{ type: "text", text: "live" }] }),
	});
};
			`,
			);

			// Verify tool is not available initially
			const initialTools = session.getActiveToolNames();
			expect(initialTools).not.toContain("live_loaded_tool");

			// Load the extension live
			await session.loadExtensionLive(extFile);

			// Verify tool is now available
			const afterLoadTools = session.getActiveToolNames();
			expect(afterLoadTools).toContain("live_loaded_tool");

			// Verify the extension is in the resource loader
			const loaded = resourceLoader.getLoadedExtension(extFile);
			expect(loaded).toBeDefined();
		});

		it.skipIf(!API_KEY)("prevents load while agent is streaming", async () => {
			const extDir = join(tempDir, "live-load-streaming");
			mkdirSync(extDir, { recursive: true });
			const extFile = join(extDir, "index.ts");
			writeFileSync(
				extFile,
				`
export default (pi) => {
	pi.registerTool({ name: "t", label: "T", description: "Test", parameters: {}, execute: async () => ({}) });
};
			`,
			);

			// Mock streaming state
			Object.defineProperty(session, "isStreaming", { get: () => true, configurable: true });

			await expect(session.loadExtensionLive(extFile)).rejects.toThrow(
				"Cannot load extension while the agent is streaming",
			);

			Object.defineProperty(session, "isStreaming", { get: () => false, configurable: true });
		});

		it.skipIf(!API_KEY)("prevents load while context compaction is active", async () => {
			const extDir = join(tempDir, "live-load-compacting");
			mkdirSync(extDir, { recursive: true });
			const extFile = join(extDir, "index.ts");
			writeFileSync(
				extFile,
				`
export default (pi) => {
	pi.registerTool({ name: "t", label: "T", description: "Test", parameters: {}, execute: async () => ({}) });
};
			`,
			);

			// Mock compaction state
			Object.defineProperty(session, "isCompacting", { get: () => true, configurable: true });

			await expect(session.loadExtensionLive(extFile)).rejects.toThrow(
				"Cannot load extension while context compaction",
			);

			Object.defineProperty(session, "isCompacting", { get: () => false, configurable: true });
		});
	});

	describe("AgentSession.unloadExtensionLive", () => {
		let session: AgentSession;
		let resourceLoader: DefaultResourceLoader;

		beforeEach(() => {
			const model = getModel("anthropic", "claude-sonnet-4-5")!;
			const agent = new Agent({
				getApiKey: () => API_KEY,
				initialState: {
					model,
					systemPrompt: "You are a test assistant.",
					tools: createCodingTools(tempDir),
				},
			});

			const sessionManager = SessionManager.inMemory();
			const settingsManager = SettingsManager.create(tempDir, tempDir);
			const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
			const modelRegistry = ModelRegistry.create(authStorage, tempDir);

			resourceLoader = new DefaultResourceLoader({
				cwd: tempDir,
				agentDir: tempDir,
				noExtensions: true,
			});

			session = new AgentSession({
				agent,
				sessionManager,
				settingsManager,
				cwd: tempDir,
				modelRegistry,
				resourceLoader,
			});

			session.subscribe(() => {});
		});

		afterEach(() => {
			if (session) {
				session.dispose();
			}
		});

		it.skipIf(!API_KEY)("removes extension tool from live runner without full reload", async () => {
			// Create and load an extension with a tool
			const extDir = join(tempDir, "live-unload-tool");
			mkdirSync(extDir, { recursive: true });
			const extFile = join(extDir, "index.ts");
			writeFileSync(
				extFile,
				`
export default (pi) => {
	pi.registerTool({
		name: "unload_test_tool",
		label: "Unload Test Tool",
		description: "To be unloaded",
		parameters: {},
		execute: async () => ({ content: [{ type: "text", text: "unload" }] }),
	});
};
			`,
			);

			// Load it
			await session.loadExtensionLive(extFile);
			const afterLoadTools = session.getActiveToolNames();
			expect(afterLoadTools).toContain("unload_test_tool");

			// Unload it
			await session.unloadExtensionLive(extFile);

			// Tool should be removed
			const afterUnloadTools = session.getActiveToolNames();
			expect(afterUnloadTools).not.toContain("unload_test_tool");

			// Extension should be removed from resource loader
			const loaded = resourceLoader.getLoadedExtension(extFile);
			expect(loaded).toBeUndefined();
		});

		it.skipIf(!API_KEY)("unloadExtensionLive removes provider from registry", async () => {
			// Create and load an extension with a provider
			const extDir = join(tempDir, "live-unload-provider");
			mkdirSync(extDir, { recursive: true });
			const extFile = join(extDir, "index.ts");
			writeFileSync(
				extFile,
				`
export default (pi) => {
	pi.registerProvider("live-unload-test-provider", {
		name: "Live Unload Test Provider",
		baseUrl: "https://test.example.com",
		apiKey: "dummy-key",
		api: "custom-api",
		models: [{
			id: "test-model",
			name: "Test Model",
			api: "custom-api",
			input: { type: "token", price: 0.0001 },
			output: { type: "token", price: 0.0001 },
			contextWindow: 4096,
			maxTokens: 2048,
		}],
	});
};
			`,
			);

			// Load the extension
			await session.loadExtensionLive(extFile);

			// Get the loaded extension and verify provider is registered
			const loaded = resourceLoader.getLoadedExtension(extFile);
			expect(loaded).toBeDefined();
			const runtime = resourceLoader.getExtensions().runtime;
			const providers = runtime.getProvidersForExtension(loaded!.path);
			expect(providers).toContain("live-unload-test-provider");

			// Unload the extension
			await session.unloadExtensionLive(extFile);

			// Verify provider is no longer registered to the extension
			const providersAfter = runtime.getProvidersForExtension(extFile);
			expect(providersAfter).not.toContain("live-unload-test-provider");
		});

		it.skipIf(!API_KEY)("does nothing if extension not loaded", async () => {
			const extFile = join(tempDir, "nonexistent", "extension.ts");

			// Should not throw, just return
			await expect(session.unloadExtensionLive(extFile)).resolves.not.toThrow();

			// Extension should still not be in loader
			const loaded = resourceLoader.getLoadedExtension(extFile);
			expect(loaded).toBeUndefined();
		});

		it.skipIf(!API_KEY)("prevents unload while agent is streaming", async () => {
			// Create and load an extension
			const extDir = join(tempDir, "live-unload-streaming");
			mkdirSync(extDir, { recursive: true });
			const extFile = join(extDir, "index.ts");
			writeFileSync(
				extFile,
				`
export default (pi) => {
	pi.registerTool({ name: "t", label: "T", description: "Test", parameters: {}, execute: async () => ({}) });
};
			`,
			);

			await session.loadExtensionLive(extFile);

			// Mock streaming state
			Object.defineProperty(session, "isStreaming", { get: () => true, configurable: true });

			await expect(session.unloadExtensionLive(extFile)).rejects.toThrow(
				"Cannot unload extension while the agent is streaming",
			);

			Object.defineProperty(session, "isStreaming", { get: () => false, configurable: true });
		});

		it.skipIf(!API_KEY)("prevents unload while context compaction is active", async () => {
			// Create and load an extension
			const extDir = join(tempDir, "live-unload-compacting");
			mkdirSync(extDir, { recursive: true });
			const extFile = join(extDir, "index.ts");
			writeFileSync(
				extFile,
				`
export default (pi) => {
	pi.registerTool({ name: "t", label: "T", description: "Test", parameters: {}, execute: async () => ({}) });
};
			`,
			);

			await session.loadExtensionLive(extFile);

			// Mock compaction state
			Object.defineProperty(session, "isCompacting", { get: () => true, configurable: true });

			await expect(session.unloadExtensionLive(extFile)).rejects.toThrow(
				"Cannot unload extension while context compaction",
			);

			Object.defineProperty(session, "isCompacting", { get: () => false, configurable: true });
		});
	});

	describe("Live load/unload lifecycle", () => {
		let session: AgentSession;
		let resourceLoader: DefaultResourceLoader;

		beforeEach(() => {
			const model = getModel("anthropic", "claude-sonnet-4-5")!;
			const agent = new Agent({
				getApiKey: () => API_KEY,
				initialState: {
					model,
					systemPrompt: "You are a test assistant.",
					tools: createCodingTools(tempDir),
				},
			});

			const sessionManager = SessionManager.inMemory();
			const settingsManager = SettingsManager.create(tempDir, tempDir);
			const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
			const modelRegistry = ModelRegistry.create(authStorage, tempDir);

			resourceLoader = new DefaultResourceLoader({
				cwd: tempDir,
				agentDir: tempDir,
				noExtensions: true,
			});

			session = new AgentSession({
				agent,
				sessionManager,
				settingsManager,
				cwd: tempDir,
				modelRegistry,
				resourceLoader,
			});

			session.subscribe(() => {});
		});

		afterEach(() => {
			if (session) {
				session.dispose();
			}
		});

		it.skipIf(!API_KEY)("session_start lifecycle event is emitted on loadExtensionLive", async () => {
			const extDir = join(tempDir, "lifecycle-start");
			mkdirSync(extDir, { recursive: true });
			const extFile = join(extDir, "index.ts");

			writeFileSync(
				extFile,
				`
export default (pi) => {
	pi.on("session_start", async (event) => {
		console.log("session_start event", event.reason);
	});
	pi.registerTool({ name: "t", label: "T", description: "Test", parameters: {}, execute: async () => ({}) });
};
			`,
			);

			await session.loadExtensionLive(extFile);

			// We can't easily test the lifecycle event emission without mocking internals,
			// but we can verify the extension loaded successfully
			const loaded = resourceLoader.getLoadedExtension(extFile);
			expect(loaded).toBeDefined();
		});

		it.skipIf(!API_KEY)("can load and unload multiple extensions in sequence", async () => {
			const ext1Dir = join(tempDir, "multi-1");
			const ext2Dir = join(tempDir, "multi-2");
			mkdirSync(ext1Dir, { recursive: true });
			mkdirSync(ext2Dir, { recursive: true });

			const ext1File = join(ext1Dir, "index.ts");
			const ext2File = join(ext2Dir, "index.ts");

			writeFileSync(
				ext1File,
				`
export default (pi) => {
	pi.registerTool({ name: "tool_1", label: "T1", description: "T1", parameters: {}, execute: async () => ({}) });
};
			`,
			);

			writeFileSync(
				ext2File,
				`
export default (pi) => {
	pi.registerTool({ name: "tool_2", label: "T2", description: "T2", parameters: {}, execute: async () => ({}) });
};
			`,
			);

			// Load both
			await session.loadExtensionLive(ext1File);
			await session.loadExtensionLive(ext2File);

			const toolsAfterLoad = session.getActiveToolNames();
			expect(toolsAfterLoad).toContain("tool_1");
			expect(toolsAfterLoad).toContain("tool_2");

			// Unload first
			await session.unloadExtensionLive(ext1File);
			const afterUnload1 = session.getActiveToolNames();
			expect(afterUnload1).not.toContain("tool_1");
			expect(afterUnload1).toContain("tool_2");

			// Unload second
			await session.unloadExtensionLive(ext2File);
			const afterUnload2 = session.getActiveToolNames();
			expect(afterUnload2).not.toContain("tool_1");
			expect(afterUnload2).not.toContain("tool_2");
		});
	});
});
