import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resourceDir } from "../src/core/agent-paths.ts";
import { IcmProvider } from "../src/core/memory/providers/icm.ts";

describe("icm memory provider", () => {
	let tempDir: string;
	let provider: IcmProvider;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-icm-memory-"));
		provider = new IcmProvider();
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("implements MemoryProvider with name icm and local egress", () => {
		expect(provider.name).toBe("icm");
		expect(provider.egress).toBe("local");
		expect(provider.isAvailable()).toBe(true);
	});

	it("routes to existing workspace and pipeline paths without inventing a store", async () => {
		await provider.initialize("test-session", {
			agentDir: tempDir,
			cwd: "/workspace/project",
			isChildSession: false,
		});
		const block = provider.systemPromptBlock();
		expect(block).toContain(JSON.stringify("/workspace/project"));
		expect(block).toContain(JSON.stringify(resourceDir("pipelines", tempDir)));
		expect(block).not.toContain(`${tempDir}/icm/`);
	});

	it("does not create directories on initialize", async () => {
		await provider.initialize("test-session", {
			agentDir: tempDir,
			cwd: "/workspace/project",
			isChildSession: false,
		});
		expect(readdirSync(tempDir)).toEqual([]);
	});

	it("generates a system prompt block with ICM mode active", async () => {
		await provider.initialize("test-session", {
			agentDir: tempDir,
			cwd: "/workspace/project",
			isChildSession: false,
		});
		const block = provider.systemPromptBlock?.();
		expect(block).toContain("ICM memory:");
		expect(block).toContain("on demand with native tools");
		expect(block).toContain("do not eagerly load their bodies");
	});

	it("systemPromptBlock fails closed when budget is too small", async () => {
		await provider.initialize("test-session", {
			agentDir: tempDir,
			cwd: "/workspace/project",
			isChildSession: false,
		});
		const tinyBudget = {
			enabled: true,
			compact: false,
			maxLines: 0,
			maxEstimatedTokens: 0,
			maxChars: 0,
			maxResults: 0,
		};
		expect(provider.systemPromptBlock(tinyBudget)).toBe("");
	});

	it("systemPromptBlock respects budget when it fits", async () => {
		await provider.initialize("test-session", {
			agentDir: tempDir,
			cwd: "/workspace/project",
			isChildSession: false,
		});
		const budget = {
			enabled: true,
			compact: false,
			maxLines: 20,
			maxEstimatedTokens: 800,
			maxChars: 64_000,
			maxResults: 10,
		};
		const block = provider.systemPromptBlock?.(budget);
		expect(block).toBeDefined();
		expect(block?.length).toBeLessThanOrEqual(budget.maxChars);
	});

	it("children are read-only with no scaffold writes", async () => {
		await provider.initialize("test-session", {
			agentDir: tempDir,
			cwd: "/workspace/project",
			isChildSession: true,
		});
		const block = provider.systemPromptBlock();
		expect(block).toContain("ICM memory:");
	});

	it("getCapabilities returns context and routing surfaces", () => {
		const caps = provider.getCapabilities();
		expect(caps.surfaces).toContain("context");
		expect(caps.surfaces).toContain("routing");
	});
});
