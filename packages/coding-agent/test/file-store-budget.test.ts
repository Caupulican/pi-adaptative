import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveMemoryPromptBudget } from "../src/core/context/memory-prompt-budget.ts";
import { FileStoreProvider } from "../src/core/memory/providers/file-store.ts";

/**
 * Read-time budget guard (cost, bug #24): the memory tool caps writes, but a MEMORY.md/USER.md bloated
 * by an external edit must NOT inject unbounded text into the system prompt on every turn. The injected
 * view is capped; the file on disk is untouched.
 */
describe("FileStoreProvider.systemPromptBlock read-time cap", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-fsbudget-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("caps an externally-bloated MEMORY.md in the injected prompt block", async () => {
		// Simulate a file edited outside the budget-enforcing memory tool.
		const huge = `- fact\n${"x".repeat(50_000)}`;
		writeFileSync(join(agentDir, "MEMORY.md"), huge, "utf-8");

		const provider = new FileStoreProvider();
		await provider.initialize("s1", { agentDir, cwd: tempDir, isChildSession: false });
		const block = provider.systemPromptBlock();

		// Bounded (well under the raw 50k), and the model is told it was truncated.
		expect(block.length).toBeLessThan(5_000);
		expect(block).toContain("truncated");
		// The file on disk is untouched.
		const onDisk = await import("node:fs").then((m) => m.readFileSync(join(agentDir, "MEMORY.md"), "utf-8"));
		expect(onDisk.length).toBe(huge.length);
	});

	it("injects a small memory file verbatim (no truncation note)", async () => {
		writeFileSync(join(agentDir, "MEMORY.md"), "- the deploy command is npm run release:patch", "utf-8");
		const provider = new FileStoreProvider();
		await provider.initialize("s1", { agentDir, cwd: tempDir, isChildSession: false });
		const block = provider.systemPromptBlock();
		expect(block).toContain("npm run release:patch");
		expect(block).not.toContain("truncated");
	});

	it("honors the normal capability budget used by an 8k model", async () => {
		writeFileSync(
			join(agentDir, "MEMORY.md"),
			Array.from({ length: 40 }, (_, index) => `- bounded fact ${index} ${"x".repeat(32)}`).join("\n"),
			"utf-8",
		);
		const provider = new FileStoreProvider();
		await provider.initialize("s1", { agentDir, cwd: tempDir, isChildSession: false });
		const budget = resolveMemoryPromptBudget({ contextWindow: 8_192, configuredMaxResults: 3 });
		const block = provider.systemPromptBlock(budget);

		expect(block.length).toBeLessThanOrEqual(budget.maxChars);
		expect(block.split("\n").length).toBeLessThanOrEqual(budget.maxLines);
		expect(block).toContain("Persistent Memory");
	});
});
