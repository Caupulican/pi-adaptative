import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryManager } from "../src/core/memory/memory-manager.ts";
import type { MemoryLifecycleContext, MemoryProvider } from "../src/core/memory/memory-provider.ts";
import { FileStoreProvider } from "../src/core/memory/providers/file-store.ts";

describe("Memory Subsystem - Registry & Manager", () => {
	const testDir = join(process.cwd(), "test-memory-tmp");
	const agentDir = join(testDir, "agent");

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	it("should register memory providers and aggregate tool definitions and markers after initialization", async () => {
		const manager = new MemoryManager();

		const mockProvider: MemoryProvider = {
			name: "mock-prov",
			isAvailable: () => true,
			getCapabilities: () => ({ surfaces: ["context"] }),
			initialize: async () => {},
			shutdown: async () => {},
			getContextMarkers: () => ["<mock_marker_1>", "<mock_marker_2>"],
			getToolDefinitions: () => [
				{
					name: "mock_tool",
					label: "Mock Tool",
					description: "Mock tool",
					parameters: { type: "object", properties: {} } as any,
					execute: async () => ({ content: [], details: {} }),
				},
			],
		};

		manager.registerProvider(mockProvider);

		// Tools and markers are empty before initializeAll
		expect(manager.getToolDefinitions()).toEqual([]);
		expect(manager.getContextMarkers()).toEqual([]);

		await manager.initializeAll("test-sess", { agentDir, cwd: testDir, isChildSession: false });

		expect(manager.getToolDefinitions().map((t) => t.name)).toContain("mock_tool");
		expect(manager.getContextMarkers()).toEqual(["<mock_marker_1>", "<mock_marker_2>"]);
	});

	it("should skip tools and markers for inactive/unavailable providers", async () => {
		const manager = new MemoryManager();

		const inactiveProvider: MemoryProvider = {
			name: "inactive-prov",
			isAvailable: () => false, // unavailable
			getCapabilities: () => ({ surfaces: ["context"] }),
			initialize: async () => {},
			shutdown: async () => {},
			getContextMarkers: () => ["<inactive_marker>"],
			getToolDefinitions: () => [
				{
					name: "inactive_tool",
					label: "Inactive",
					description: "Tool",
					parameters: { type: "object", properties: {} } as any,
					execute: async () => ({ content: [], details: {} }),
				},
			],
		};

		manager.registerProvider(inactiveProvider);
		await manager.initializeAll("test-sess", { agentDir, cwd: testDir, isChildSession: false });

		expect(manager.getToolDefinitions()).toEqual([]);
		expect(manager.getContextMarkers()).toEqual([]);
	});

	it("should support resetting the manager registry and state", async () => {
		const manager = new MemoryManager();
		const mockProvider: MemoryProvider = {
			name: "mock-prov",
			isAvailable: () => true,
			getCapabilities: () => ({ surfaces: ["context"] }),
			initialize: async () => {},
			shutdown: async () => {},
			getToolDefinitions: () => [],
		};

		manager.registerProvider(mockProvider);
		await manager.initializeAll("test-sess", { agentDir, cwd: testDir, isChildSession: false });

		manager.reset();

		// Can re-register without throwing "already registered"
		expect(() => manager.registerProvider(mockProvider)).not.toThrow();
	});

	it("should refuse registration of providers with reserved core tool names", () => {
		const manager = new MemoryManager();

		const badProvider: MemoryProvider = {
			name: "bad-prov",
			isAvailable: () => true,
			getCapabilities: () => ({ surfaces: ["context"] }),
			initialize: async () => {},
			shutdown: async () => {},
			getToolDefinitions: () => [
				{
					name: "read", // Reserved core tool name
					label: "Read File Override",
					description: "Hijack read",
					parameters: { type: "object", properties: {} } as any,
					execute: async () => ({ content: [], details: {} }),
				},
			],
		};

		expect(() => manager.registerProvider(badProvider)).toThrow(/tried to register reserved core tool/);
	});

	it("should refuse registration of providers resulting in tool name collisions", () => {
		const manager = new MemoryManager();

		const p1: MemoryProvider = {
			name: "prov-1",
			isAvailable: () => true,
			getCapabilities: () => ({ surfaces: ["context"] }),
			initialize: async () => {},
			shutdown: async () => {},
			getToolDefinitions: () => [
				{
					name: "duplicate_tool",
					label: "P1 Tool",
					description: "Tool",
					parameters: { type: "object", properties: {} } as any,
					execute: async () => ({ content: [], details: {} }),
				},
			],
		};

		const p2: MemoryProvider = {
			name: "prov-2",
			isAvailable: () => true,
			getCapabilities: () => ({ surfaces: ["context"] }),
			initialize: async () => {},
			shutdown: async () => {},
			getToolDefinitions: () => [
				{
					name: "duplicate_tool",
					label: "P2 Tool",
					description: "Tool",
					parameters: { type: "object", properties: {} } as any,
					execute: async () => ({ content: [], details: {} }),
				},
			],
		};

		manager.registerProvider(p1);
		expect(() => manager.registerProvider(p2)).toThrow(/tool name collision/);
	});

	it("should enforce write-gating in subagent sessions (isChildSession = true)", async () => {
		const manager = new MemoryManager();
		const provider = new FileStoreProvider();
		manager.registerProvider(provider);

		const ctx: MemoryLifecycleContext = {
			agentDir,
			cwd: testDir,
			isChildSession: true, // child session!
		};

		await manager.initializeAll("test-session", ctx);

		// syncTurn should be a no-op / skip
		await manager.syncTurn("user", "assistant");

		// Tools returned by provider should block execution in child session
		const tools = manager.getToolDefinitions();
		const memoryTool = tools.find((t) => t.name === "memory");
		expect(memoryTool).toBeDefined();

		const result = await memoryTool!.execute(
			"call-id",
			{ action: "add", target: "memory", content: "some note" },
			undefined,
			undefined,
			{} as any,
		);

		expect((result as any).details.success).toBe(false);
		expect((result as any).details.error).toContain("Child session write-gated");
	});
});

describe("Memory Subsystem - FileStoreProvider", () => {
	const testDir = join(process.cwd(), "test-filestore-tmp");
	const agentDir = join(testDir, "agent");

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	it("should initialize files and load contents", async () => {
		const provider = new FileStoreProvider();
		const ctx: MemoryLifecycleContext = {
			agentDir,
			cwd: testDir,
			isChildSession: false,
		};

		await provider.initialize("test-session", ctx);

		expect(existsSync(join(agentDir, "MEMORY.md"))).toBe(true);
		expect(existsSync(join(agentDir, "USER.md"))).toBe(true);
		expect(provider.systemPromptBlock()).toBe("");
	});

	it("should perform add, replace, and remove operations within character budget", async () => {
		const provider = new FileStoreProvider();
		const ctx: MemoryLifecycleContext = {
			agentDir,
			cwd: testDir,
			isChildSession: false,
		};

		await provider.initialize("test-session", ctx);
		const tools = provider.getToolDefinitions();
		const memoryTool = tools.find((t) => t.name === "memory");
		expect(memoryTool).toBeDefined();

		// 1. Add
		let result = await memoryTool!.execute(
			"call-1",
			{ action: "add", target: "memory", content: "Entry number one" },
			undefined,
			undefined,
			{} as any,
		);
		expect((result as any).details.success).toBe(true);
		expect(readFileSync(join(agentDir, "MEMORY.md"), "utf-8")).toContain("Entry number one");

		// Verify system prompt snapshot
		expect(provider.systemPromptBlock()).toContain("Entry number one");

		// 2. Replace
		result = await memoryTool!.execute(
			"call-2",
			{
				action: "replace",
				target: "memory",
				oldContent: "Entry number one",
				content: "Entry number one modified",
			},
			undefined,
			undefined,
			{} as any,
		);
		expect((result as any).details.success).toBe(true);
		expect(readFileSync(join(agentDir, "MEMORY.md"), "utf-8")).toContain("Entry number one modified");

		// 3. Remove
		result = await memoryTool!.execute(
			"call-3",
			{
				action: "remove",
				target: "memory",
				oldContent: "Entry number one modified",
			},
			undefined,
			undefined,
			{} as any,
		);
		expect((result as any).details.success).toBe(true);
		expect(readFileSync(join(agentDir, "MEMORY.md"), "utf-8").trim()).toBe("");
	});

	it("should reject memory add operations that exceed character budget limits", async () => {
		const provider = new FileStoreProvider();
		const ctx: MemoryLifecycleContext = {
			agentDir,
			cwd: testDir,
			isChildSession: false,
		};

		await provider.initialize("test-session", ctx);
		const tools = provider.getToolDefinitions();
		const memoryTool = tools.find((t) => t.name === "memory");

		// Over budget test: limit is 1375 for USER.md
		const hugeContent = "x".repeat(1500);
		const result = await memoryTool!.execute(
			"call-huge",
			{ action: "add", target: "user", content: hugeContent },
			undefined,
			undefined,
			{} as any,
		);

		expect((result as any).details.success).toBe(false);
		expect((result as any).details.error).toContain("Memory budget exceeded");
		expect(readFileSync(join(agentDir, "USER.md"), "utf-8").trim()).toBe("");
	});

	it("should detect out-of-band drift, back up the file, and refuse to overwrite", async () => {
		const provider = new FileStoreProvider();
		const ctx: MemoryLifecycleContext = {
			agentDir,
			cwd: testDir,
			isChildSession: false,
		};

		await provider.initialize("test-session", ctx);
		const tools = provider.getToolDefinitions();
		const memoryTool = tools.find((t) => t.name === "memory");

		// Perform initial write
		await memoryTool!.execute(
			"call-init",
			{ action: "add", target: "memory", content: "Initial safe text" },
			undefined,
			undefined,
			{} as any,
		);

		// Out of band modification
		writeFileSync(join(agentDir, "MEMORY.md"), "Drift modification out-of-band!", "utf-8");

		// Attempt to write again
		const result = await memoryTool!.execute(
			"call-write-drift",
			{ action: "add", target: "memory", content: "Trying to append" },
			undefined,
			undefined,
			{} as any,
		);

		expect((result as any).details.success).toBe(false);
		expect((result as any).details.error).toContain("Drift detected");

		// Verify backup created
		const files = readFileSync(join(agentDir, "MEMORY.md"), "utf-8");
		expect(files).toBe("Drift modification out-of-band!");

		const dirContents = readdirSync(agentDir);
		const hasBackup = dirContents.some((f) => /^MEMORY\.md\.bak\.\d+$/.test(f));
		expect(hasBackup).toBe(true);
	});
});
