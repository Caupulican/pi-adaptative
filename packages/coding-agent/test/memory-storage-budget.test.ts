import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStoreProvider } from "../src/core/memory/providers/file-store.ts";

describe("memory storage budget regressions", () => {
	let root: string;
	let agentDir: string;
	let provider: FileStoreProvider;

	beforeEach(() => {
		root = join(tmpdir(), `pi-mem-budget-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		provider = new FileStoreProvider();
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("general file persisted beyond old 1200 chars stays within prompt budget", async () => {
		await provider.initialize("session", { agentDir, cwd: root, isChildSession: false });
		const memoryTool = provider.getToolDefinitions().find((t) => t.name === "memory")!;
		const largeContent = "x".repeat(2000);
		const result = await memoryTool.execute(
			"add-memory",
			{ action: "add", target: "memory", content: largeContent },
			undefined,
			undefined,
			{} as any,
		);
		expect((result as any).details.success).toBe(true);
		const prompt = provider.systemPromptBlock();
		expect(prompt).toContain("MEMORY.md (general)");
		expect(prompt).toContain("more fact lines on disk");
	});

	it("project file persisted beyond old 2200 chars stays within prompt budget", async () => {
		await provider.initialize("session", { agentDir, cwd: root, isChildSession: false });
		const memoryTool = provider.getToolDefinitions().find((t) => t.name === "memory")!;
		const largeContent = "y".repeat(3000);
		const result = await memoryTool.execute(
			"add-project",
			{ action: "add", target: "project", content: largeContent },
			undefined,
			undefined,
			{} as any,
		);
		expect((result as any).details.success).toBe(true);
		const prompt = provider.systemPromptBlock();
		expect(prompt).toContain("MEMORY.md (project");
		expect(prompt).toContain("more fact lines on disk");
	});

	it("prompt remains bounded and whole including footer", async () => {
		await provider.initialize("session", { agentDir, cwd: root, isChildSession: false });
		const emptyPrompt = provider.systemPromptBlock({
			enabled: true,
			compact: false,
			maxLines: 0,
			maxEstimatedTokens: 0,
			maxChars: 0,
			maxResults: 0,
		});
		expect(emptyPrompt).toBe("");
		const prompt = provider.systemPromptBlock();
		expect(typeof prompt).toBe("string");
	});

	it("UTF8 byte overflow is rejected", async () => {
		await provider.initialize("session", { agentDir, cwd: root, isChildSession: false });
		const memoryTool = provider.getToolDefinitions().find((t) => t.name === "memory")!;
		const overBudgetContent = "ü".repeat(256001);
		const result = await memoryTool.execute(
			"overflow",
			{ action: "add", target: "memory", content: overBudgetContent },
			undefined,
			undefined,
			{} as any,
		);
		expect((result as any).isError).toBe(true);
		expect((result as any).content[0].text).toContain("Resource overflow");
		expect((result as any).content[0].text).toContain("512000");
	});

	it("strict shrink: reducing over-budget content is allowed", async () => {
		const largeContent = "x".repeat(512001);
		writeFileSync(join(agentDir, "MEMORY.md"), largeContent);
		await provider.initialize("session", { agentDir, cwd: root, isChildSession: false });
		const memoryTool = provider.getToolDefinitions().find((t) => t.name === "memory")!;
		const result = await memoryTool.execute(
			"shrink",
			{ action: "replace", target: "memory", oldContent: largeContent, content: "short" },
			undefined,
			undefined,
			{} as any,
		);
		expect((result as any).details.success).toBe(true);
		expect(provider.generalMemoryOverBudget()).toBe(false);
	});

	it("strict shrink: non-reducing over-budget writes are rejected", async () => {
		writeFileSync(join(agentDir, "MEMORY.md"), "x".repeat(512001));
		await provider.initialize("session", { agentDir, cwd: root, isChildSession: false });
		const memoryTool = provider.getToolDefinitions().find((t) => t.name === "memory")!;
		const result = await memoryTool.execute(
			"overflow-add",
			{ action: "add", target: "memory", content: "extra" },
			undefined,
			undefined,
			{} as any,
		);
		expect((result as any).details.success).toBe(false);
		expect((result as any).content[0].text).toContain("Resource overflow");
	});

	it("prompt allocation tokens and resource ceiling shown in list", async () => {
		await provider.initialize("session", { agentDir, cwd: root, isChildSession: false });
		const memoryTool = provider.getToolDefinitions().find((t) => t.name === "memory")!;
		await memoryTool.execute(
			"add",
			{ action: "add", target: "memory", content: "test fact" },
			undefined,
			undefined,
			{} as any,
		);
		const listed = await memoryTool.execute("list", { action: "list" }, undefined, undefined, {} as any);
		const text = (listed as any).content[0].text as string;
		expect(text).toContain("prompt allocation");
		expect(text).toContain("resource ceiling");
		expect(text).toContain("512000");
		expect(text).toContain("approximate tokens");
	});

	it("USER archive threshold (1375 chars) remains for compatibility", async () => {
		await provider.initialize("session", { agentDir, cwd: root, isChildSession: false });
		const memoryTool = provider.getToolDefinitions().find((t) => t.name === "memory")!;
		const largeUserContent = "pref key: value\n".repeat(150);
		const result = await memoryTool.execute(
			"add-user",
			{ action: "add", target: "user", content: largeUserContent },
			undefined,
			undefined,
			{} as any,
		);
		expect((result as any).details.success).toBe(true);
	});
});
