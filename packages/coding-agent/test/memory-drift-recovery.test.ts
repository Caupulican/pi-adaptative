import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemoryLifecycleContext } from "../src/core/memory/memory-provider.ts";
import { FileStoreProvider } from "../src/core/memory/providers/file-store.ts";

describe("managed memory drift recovery", () => {
	let testDir: string;
	let agentDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "pi-memory-drift-"));
		agentDir = join(testDir, "agent");
	});
	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	async function start(): Promise<{ provider: FileStoreProvider; add: (content: string) => Promise<any> }> {
		const provider = new FileStoreProvider();
		const ctx: MemoryLifecycleContext = { agentDir, cwd: testDir, isChildSession: false };
		await provider.initialize("drift-session", ctx);
		const tool = provider.getToolDefinitions().find((t) => t.name === "memory");
		if (!tool) throw new Error("memory tool missing");
		return {
			provider,
			add: (content: string) =>
				tool.execute("call", { action: "add", target: "memory", content }, undefined, undefined, {} as any),
		};
	}

	it("stores the committed content beside its digest and heals an emptied file on the next write and on start", async () => {
		const { provider, add } = await start();
		expect((await add("Entry one")).details.success).toBe(true);
		const memoryPath = join(agentDir, "MEMORY.md");
		const statePath = join(agentDir, "state", "memory", "file-store", "MEMORY.md.pi-managed.json");
		const state = JSON.parse(readFileSync(statePath, "utf8"));
		expect(state.committedContent).toContain("Entry one");

		// Truncated outside the protocol: the next write heals instead of locking the session out.
		writeFileSync(memoryPath, "", "utf8");
		const result = await add("Entry two");
		expect(result.details.success, JSON.stringify(result.content)).toBe(true);
		const healed = readFileSync(memoryPath, "utf8");
		expect(healed).toContain("Entry one");
		expect(healed).toContain("Entry two");
		expect(provider.drainHealNotices()).toEqual([expect.stringContaining("MEMORY.md was empty on disk; restored")]);
		expect(provider.drainHealNotices()).toEqual([]);

		// A fresh session over an emptied file heals at start, before the prompt block is built.
		writeFileSync(memoryPath, "", "utf8");
		const second = await start();
		expect(readFileSync(memoryPath, "utf8")).toContain("Entry two");
		expect(second.provider.systemPromptBlock()).toContain("Entry two");
		expect(second.provider.drainHealNotices()).toHaveLength(1);
	});

	it("refuses a real external edit with the operator's two commands, and honours accept and restore", async () => {
		const { provider, add } = await start();
		await add("Managed line");
		const memoryPath = join(agentDir, "MEMORY.md");
		writeFileSync(memoryPath, "Hand-edited line\n", "utf8");

		const refused = await add("Another line");
		expect(refused.details.success).toBe(false);
		const text = refused.content.map((c: { text?: string }) => c.text ?? "").join("");
		expect(text).toContain("Drift detected");
		expect(text).toContain("/memory accept");
		expect(text).toContain("/memory restore");
		expect(text).toContain("restorable");
		expect(readFileSync(memoryPath, "utf8")).toBe("Hand-edited line\n");

		const report = await provider.driftReport();
		const memory = report.find((entry) => entry.target === "memory");
		expect(memory).toMatchObject({ drift: true, emptyOnDisk: false, currentChars: 17 });
		expect(memory?.managedChars).toBeGreaterThan(0);
		expect(report.find((entry) => entry.target === "user")?.drift).toBe(false);

		// Restore: the managed content is back, the hand edit is kept as a backup.
		const restored = await provider.restoreManaged("memory");
		expect(restored.ok).toBe(true);
		expect(readFileSync(memoryPath, "utf8")).toContain("Managed line");
		expect(readdirSync(agentDir).some((name) => name.startsWith("MEMORY.md.bak.sha256-"))).toBe(true);
		expect((await add("After restore")).details.success).toBe(true);
		expect(provider.systemPromptBlock()).toContain("After restore");

		// Accept: the operator means the hand edit; the model's next write lands on it.
		writeFileSync(memoryPath, "Owner rewrote this\n", "utf8");
		expect((await add("Blocked again")).details.success).toBe(false);
		const accepted = await provider.acceptDrift("memory");
		expect(accepted.ok).toBe(true);
		expect((await add("Added after accept")).details.success).toBe(true);
		const final = readFileSync(memoryPath, "utf8");
		expect(final).toContain("Owner rewrote this");
		expect(final).toContain("Added after accept");
		expect(final).not.toContain("Managed line");
		expect((await provider.driftReport()).find((entry) => entry.target === "memory")?.drift).toBe(false);
		expect((await provider.acceptDrift("memory")).message).toContain("nothing to accept");
		expect(existsSync(memoryPath)).toBe(true);
	});
});
