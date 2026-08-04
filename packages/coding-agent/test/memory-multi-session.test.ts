import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import type { MemoryLifecycleContext } from "../src/core/memory/memory-provider.ts";
import { FileStoreProvider } from "../src/core/memory/providers/file-store.ts";

function getMemoryTool(provider: FileStoreProvider): ToolDefinition {
	const tool = provider.getToolDefinitions().find((candidate) => candidate.name === "memory");
	if (!tool) throw new Error("Memory tool was not registered");
	return tool;
}

function addMemory(provider: FileStoreProvider, toolCallId: string, content: string) {
	return getMemoryTool(provider).execute(
		toolCallId,
		{ action: "add", target: "memory", content },
		undefined,
		undefined,
		{} as ExtensionContext,
	);
}

describe("FileStoreProvider multi-session ownership", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
	});

	it("serializes concurrent writes from two legitimate sessions without treating either as drift", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-memory-multi-session-"));
		tempDirs.push(root);
		const agentDir = join(root, "agent");
		const context: MemoryLifecycleContext = { agentDir, cwd: root, isChildSession: false };
		const first = new FileStoreProvider();
		const second = new FileStoreProvider();
		await Promise.all([first.initialize("session-a", context), second.initialize("session-b", context)]);

		const [firstResult, secondResult] = await Promise.all([
			addMemory(first, "first-write", "Tenant alpha owns the release checklist."),
			addMemory(second, "second-write", "Tenant beta owns the rollback checklist."),
		]);

		expect(firstResult.details).toMatchObject({ success: true });
		expect(secondResult.details).toMatchObject({ success: true });
		const stored = readFileSync(join(agentDir, "MEMORY.md"), "utf8");
		expect(stored).toContain("Tenant alpha owns the release checklist.");
		expect(stored).toContain("Tenant beta owns the rollback checklist.");
	});

	it("recovers a managed write interrupted after the content rename without reporting false drift", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-memory-pending-recovery-"));
		tempDirs.push(root);
		const agentDir = join(root, "agent");
		const context: MemoryLifecycleContext = { agentDir, cwd: root, isChildSession: false };
		const memoryPath = join(agentDir, "MEMORY.md");
		const statePath = `${memoryPath}.pi-managed.json`;
		const first = new FileStoreProvider();
		await first.initialize("session-a", context);

		const committed = JSON.parse(readFileSync(statePath, "utf8")) as { committedDigest: string };
		const interruptedContent = "A peer committed this fact before its state finalize.\n";
		const pendingDigest = createHash("sha256").update(interruptedContent, "utf8").digest("hex");
		writeFileSync(
			statePath,
			`${JSON.stringify({ version: 1, committedDigest: committed.committedDigest, pendingDigest })}\n`,
			"utf8",
		);
		writeFileSync(memoryPath, interruptedContent, "utf8");

		const recovered = new FileStoreProvider();
		await recovered.initialize("session-b", context);
		const result = await addMemory(recovered, "post-recovery-write", "Recovery accepted the managed commit.");

		expect(result.details).toMatchObject({ success: true });
		expect(readFileSync(memoryPath, "utf8")).toContain("A peer committed this fact");
		expect(readFileSync(memoryPath, "utf8")).toContain("Recovery accepted the managed commit.");
		expect(readFileSync(statePath, "utf8")).not.toContain("pendingDigest");
	});
});
