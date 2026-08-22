import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

	it("bounds a hung lifecycle hook and abandons that provider for later hooks", async () => {
		vi.useFakeTimers();
		const calls: string[] = [];
		const manager = new MemoryManager({ lifecycleTimeoutMs: 10 });
		const provider: MemoryProvider = {
			name: "hung-lifecycle",
			isAvailable: () => true,
			getCapabilities: () => ({ surfaces: ["context"] }),
			initialize: async () => {},
			syncTurn: () => new Promise<void>(() => {}),
			onPreCompress: async () => {
				calls.push("pre-compress");
				return "should not run";
			},
			onSessionEnd: async () => {
				calls.push("session-end");
			},
			shutdown: async () => {
				calls.push("shutdown");
			},
		};

		try {
			manager.registerProvider(provider);
			await manager.initializeAll("test-sess", { agentDir, cwd: testDir, isChildSession: false });

			const sync = manager.syncTurn("user", "assistant");
			await vi.advanceTimersByTimeAsync(10);
			await expect(sync).resolves.toBeUndefined();
			await expect(manager.onPreCompress()).resolves.toBe("");
			await expect(manager.onSessionEnd()).resolves.toBeUndefined();
			await expect(manager.shutdownAll()).resolves.toBeUndefined();

			expect(calls).toEqual([]);
			expect(manager.getLifecycleDiagnostics()).toEqual([
				expect.objectContaining({
					provider: "hung-lifecycle",
					operation: "syncTurn",
					status: "timeout",
				}),
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("bounds a hung prefetch and keeps a healthy provider result available", async () => {
		vi.useFakeTimers();
		const manager = new MemoryManager({ lifecycleTimeoutMs: 10 });
		const hungProvider: MemoryProvider = {
			name: "hung-prefetch",
			egress: "local",
			isAvailable: () => true,
			getCapabilities: () => ({ surfaces: ["context"] }),
			initialize: async () => {},
			prefetch: () => new Promise<string>(() => {}),
			shutdown: async () => {},
		};
		const healthyProvider: MemoryProvider = {
			name: "healthy-prefetch",
			egress: "local",
			isAvailable: () => true,
			getCapabilities: () => ({ surfaces: ["context"] }),
			initialize: async () => {},
			prefetch: async () => "healthy result",
			shutdown: async () => {},
		};

		try {
			manager.registerProvider(hungProvider);
			manager.registerProvider(healthyProvider);
			await manager.initializeAll("test-sess", { agentDir, cwd: testDir, isChildSession: false });

			const prefetch = manager.prefetch("query");
			await vi.advanceTimersByTimeAsync(10);
			await expect(prefetch).resolves.toContain("healthy result");
			expect(manager.getLifecycleDiagnostics()).toEqual([
				expect.objectContaining({
					provider: "hung-prefetch",
					operation: "prefetch",
					status: "timeout",
				}),
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps the lifecycle timeout referenced until the terminal diagnostic is emitted", async () => {
		vi.useFakeTimers();
		const manager = new MemoryManager({ lifecycleTimeoutMs: 10 });
		const provider: MemoryProvider = {
			name: "referenced-timeout",
			isAvailable: () => true,
			getCapabilities: () => ({ surfaces: ["context"] }),
			initialize: async () => {},
			syncTurn: () => new Promise<void>(() => {}),
			shutdown: async () => {},
		};
		manager.registerProvider(provider);
		await manager.initializeAll("test-sess", { agentDir, cwd: testDir, isChildSession: false });

		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		try {
			const sync = manager.syncTurn("user", "assistant");
			const timeoutHandle = setTimeoutSpy.mock.results[0]?.value;
			expect(timeoutHandle).toBeDefined();
			expect((timeoutHandle as NodeJS.Timeout).hasRef()).toBe(true);
			await vi.advanceTimersByTimeAsync(10);
			await sync;
		} finally {
			setTimeoutSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	it("does not re-admit a provider object abandoned by an earlier manager generation", async () => {
		vi.useFakeTimers();
		let initializeCalls = 0;
		let resolveSync: () => void = () => {};
		const provider: MemoryProvider = {
			name: "cross-generation-abandoned",
			isAvailable: () => true,
			getCapabilities: () => ({ surfaces: ["context"] }),
			initialize: async () => {
				initializeCalls += 1;
			},
			syncTurn: () =>
				new Promise<void>((resolve) => {
					resolveSync = resolve;
				}),
			shutdown: async () => {},
		};

		try {
			const firstManager = new MemoryManager({ lifecycleTimeoutMs: 10 });
			firstManager.registerProvider(provider);
			await firstManager.initializeAll("first-generation", { agentDir, cwd: testDir, isChildSession: false });
			const sync = firstManager.syncTurn("user", "assistant");
			await vi.advanceTimersByTimeAsync(10);
			await sync;

			const reloadedManager = new MemoryManager({ lifecycleTimeoutMs: 10 });
			reloadedManager.registerProvider(provider);
			await reloadedManager.initializeAll("second-generation", { agentDir, cwd: testDir, isChildSession: false });

			expect(initializeCalls).toBe(1);
			expect(reloadedManager.getLifecycleDiagnostics()).toEqual([
				expect.objectContaining({
					provider: "cross-generation-abandoned",
					operation: "initialize",
					status: "abandoned",
				}),
			]);
			await expect(reloadedManager.syncTurn("user", "assistant")).resolves.toBeUndefined();

			resolveSync();
			await vi.advanceTimersByTimeAsync(0);
			const recoveredManager = new MemoryManager({ lifecycleTimeoutMs: 10 });
			recoveredManager.registerProvider(provider);
			await recoveredManager.initializeAll("recovered-generation", {
				agentDir,
				cwd: testDir,
				isChildSession: false,
			});
			expect(initializeCalls).toBe(2);
		} finally {
			vi.useRealTimers();
		}
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

	it("should keep the bounded MEMORY.md hot store and reject oversized project-memory writes", async () => {
		const provider = new FileStoreProvider();
		const ctx: MemoryLifecycleContext = {
			agentDir,
			cwd: testDir,
			isChildSession: false,
		};

		await provider.initialize("test-session", ctx);
		const tools = provider.getToolDefinitions();
		const memoryTool = tools.find((t) => t.name === "memory");

		// USER.md overflow migrates to OKF shards; MEMORY.md remains a deliberately bounded hot store.
		const hugeContent = "x".repeat(2300);
		const result = await memoryTool!.execute(
			"call-huge",
			{ action: "add", target: "memory", content: hugeContent },
			undefined,
			undefined,
			{} as any,
		);

		expect((result as any).details.success).toBe(false);
		expect((result as any).details.error).toContain("Memory budget exceeded");
		expect(readFileSync(join(agentDir, "MEMORY.md"), "utf-8").trim()).toBe("");
	});

	it("should author structured project OKF memory without funneling it into MEMORY.md", async () => {
		const provider = new FileStoreProvider();
		const ctx: MemoryLifecycleContext = {
			agentDir,
			cwd: testDir,
			isChildSession: false,
		};

		await provider.initialize("test-session", ctx);
		const memoryTool = provider.getToolDefinitions().find((tool) => tool.name === "memory");
		const result = await memoryTool!.execute(
			"call-okf",
			{
				action: "add",
				target: "okf",
				type: "Design Decision",
				title: "Use bounded hot memory",
				description: "Project decisions live in indexed OKF records.",
				scope: "project",
				content: "Keep MEMORY.md small and put durable design decisions in OKF.",
				tags: ["memory", "architecture"],
				evidenceRefs: ["transcript:decision-1"],
			},
			undefined,
			undefined,
			{} as never,
		);

		expect(result.details).toEqual(expect.objectContaining({ success: true }));
		expect(readFileSync(join(agentDir, "MEMORY.md"), "utf-8").trim()).toBe("");
		const okfFiles = readdirSync(join(agentDir, "okf-memory"), { recursive: true }).filter((entry) =>
			String(entry).endsWith(".okf.md"),
		);
		expect(okfFiles).toHaveLength(1);
		const okfPath = join(agentDir, "okf-memory", String(okfFiles[0]));
		expect(readFileSync(okfPath, "utf-8")).toContain("type: Design Decision");
	});

	it("isolates same-title structured records for different project roots", async () => {
		const firstCwd = join(testDir, "project-a");
		const secondCwd = join(testDir, "project-b");
		mkdirSync(join(firstCwd, ".git"), { recursive: true });
		mkdirSync(join(secondCwd, ".git"), { recursive: true });
		const first = new FileStoreProvider();
		const second = new FileStoreProvider();
		await first.initialize("first", { agentDir, cwd: firstCwd, isChildSession: false });
		await second.initialize("second", { agentDir, cwd: secondCwd, isChildSession: false });
		const write = async (provider: FileStoreProvider, content: string) =>
			provider.getToolDefinitions()[0]!.execute(
				"call-okf",
				{
					action: "add",
					target: "okf",
					type: "Design Decision",
					title: "Shared title",
					description: content,
					scope: "project",
					content,
					evidenceRefs: ["transcript:project-isolation"],
				},
				undefined,
				undefined,
				{} as never,
			);

		expect((await write(first, "first project")).details).toEqual(expect.objectContaining({ success: true }));
		expect((await write(second, "second project")).details).toEqual(expect.objectContaining({ success: true }));
		const okfFiles = readdirSync(join(agentDir, "okf-memory"), { recursive: true }).filter((entry) =>
			String(entry).endsWith(".okf.md"),
		);
		expect(okfFiles).toHaveLength(2);
	});

	it("rejects oversized structured fields even when execute is called directly", async () => {
		const provider = new FileStoreProvider();
		await provider.initialize("test-session", { agentDir, cwd: testDir, isChildSession: false });
		const result = await provider.getToolDefinitions()[0]!.execute(
			"call-oversized-okf",
			{
				action: "add",
				target: "okf",
				type: "Design Decision",
				title: "x".repeat(300),
				description: "bounded",
				scope: "project",
				content: "body",
				evidenceRefs: ["transcript:bounds"],
			},
			undefined,
			undefined,
			{} as never,
		);

		expect(result.details).toEqual(expect.objectContaining({ success: false }));
		expect(readdirSync(agentDir, { recursive: true }).filter((entry) => String(entry).endsWith(".okf.md"))).toEqual(
			[],
		);
	});

	it.skipIf(process.platform === "win32")("rejects an OKF root symlink that escapes the agent directory", async () => {
		const outside = join(testDir, "outside");
		mkdirSync(outside, { recursive: true });
		symlinkSync(outside, join(agentDir, "okf-memory"), "dir");
		const provider = new FileStoreProvider();
		await provider.initialize("test-session", { agentDir, cwd: testDir, isChildSession: false });
		const result = await provider.getToolDefinitions()[0]!.execute(
			"call-symlink-okf",
			{
				action: "add",
				target: "okf",
				type: "Design Decision",
				title: "Escape attempt",
				description: "Must stay inside the agent root.",
				scope: "project",
				content: "body",
				evidenceRefs: ["transcript:symlink"],
			},
			undefined,
			undefined,
			{} as never,
		);

		expect(result.details).toEqual(expect.objectContaining({ success: false }));
		expect(readdirSync(outside)).toEqual([]);
	});

	it("keeps both copies when hot-memory cleanup is interrupted after the OKF write", async () => {
		const provider = new FileStoreProvider({
			beforeOrganizeHotRemoval: () => {
				const memoryPath = join(agentDir, "MEMORY.md");
				writeFileSync(memoryPath, `${readFileSync(memoryPath, "utf-8")}Concurrent edit\n`, "utf-8");
			},
		});
		await provider.initialize("test-session", { agentDir, cwd: testDir, isChildSession: false });
		await provider
			.getToolDefinitions()[0]!
			.execute(
				"seed-hot-memory",
				{ action: "add", target: "memory", content: "Decision to organize" },
				undefined,
				undefined,
				{} as never,
			);

		const result = await provider.applyStructuredReflectionWrite({
			kind: "okf_organize",
			type: "Design Decision",
			title: "Loss-safe organization",
			description: "OKF creation precedes exact hot-memory cleanup.",
			text: "Structured decision body.",
			sourceText: "Decision to organize",
			evidenceRefs: ["transcript:loss-safe"],
		});

		expect(result).toEqual(expect.objectContaining({ applied: true, created: true, sourceRemoved: false }));
		expect(readFileSync(join(agentDir, "MEMORY.md"), "utf-8")).toContain("Decision to organize");
		expect(
			readdirSync(join(agentDir, "okf-memory"), { recursive: true }).filter((entry) =>
				String(entry).endsWith(".okf.md"),
			),
		).toHaveLength(1);
	});

	it("organizes one exact hot-memory item without touching neighboring facts", async () => {
		const provider = new FileStoreProvider();
		await provider.initialize("test-session", { agentDir, cwd: testDir, isChildSession: false });
		const memoryTool = provider.getToolDefinitions()[0]!;
		for (const content of ["Decision: use artifacts", "Unrelated fact"]) {
			await memoryTool.execute(
				`seed-${content}`,
				{ action: "add", target: "memory", content },
				undefined,
				undefined,
				{} as never,
			);
		}

		const result = await provider.applyStructuredReflectionWrite({
			kind: "okf_organize",
			type: "Design Decision",
			title: "Artifact output",
			description: "Large output uses artifacts.",
			text: "Store large output as artifacts.",
			sourceText: "Decision: use artifacts",
			evidenceRefs: ["transcript:exact-organization"],
		});

		expect(result).toEqual(expect.objectContaining({ applied: true, created: true, sourceRemoved: true }));
		expect(readFileSync(join(agentDir, "MEMORY.md"), "utf8")).toBe("Unrelated fact\n");
		expect(
			readdirSync(join(agentDir, "okf-memory"), { recursive: true }).filter((entry) =>
				String(entry).endsWith(".okf.md"),
			),
		).toHaveLength(1);
	});

	it("rejects OKF organization when sourceText is only a hot-memory substring", async () => {
		const provider = new FileStoreProvider();
		await provider.initialize("test-session", { agentDir, cwd: testDir, isChildSession: false });
		const memoryTool = provider.getToolDefinitions()[0]!;
		await memoryTool.execute(
			"seed-hot-memory",
			{ action: "add", target: "memory", content: "Decision: use artifacts" },
			undefined,
			undefined,
			{} as never,
		);

		const result = await provider.applyStructuredReflectionWrite({
			kind: "okf_organize",
			type: "Design Decision",
			title: "Artifact output",
			description: "Large output uses artifacts.",
			text: "Store large output as artifacts.",
			sourceText: "Decision",
			evidenceRefs: ["transcript:substring-guard"],
		});

		expect(result).toEqual(expect.objectContaining({ applied: false, created: false, sourceRemoved: false }));
		expect(readFileSync(join(agentDir, "MEMORY.md"), "utf8")).toBe("Decision: use artifacts\n");
		expect(
			existsSync(join(agentDir, "okf-memory"))
				? readdirSync(join(agentDir, "okf-memory"), { recursive: true }).filter((entry) =>
						String(entry).endsWith(".okf.md"),
					)
				: [],
		).toHaveLength(0);
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
