import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatOkfMemoryDocument } from "../src/core/context/okf-memory.ts";
import { loadOkfMemoryBundle } from "../src/core/context/okf-memory-provider.ts";
import type { ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import type { MemoryLifecycleContext } from "../src/core/memory/memory-provider.ts";
import { FileStoreProvider, supersedeNearDuplicateLine } from "../src/core/memory/providers/file-store.ts";
import { USER_ARCHIVE_POINTER, UserMemoryArchive } from "../src/core/memory/providers/user-memory-archive.ts";

interface MemoryToolDetails {
	success?: boolean;
	error?: string;
}

describe("FileStoreProvider USER.md sharding", () => {
	let testDir: string;
	let agentDir: string;

	beforeEach(() => {
		testDir = join(realpathSync.native(tmpdir()), `pi-user-memory-sharding-${Date.now()}-${Math.random()}`);
		agentDir = join(testDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
	});

	async function initializeProvider(onDurableMemoryChanged?: () => void): Promise<{
		provider: FileStoreProvider;
		memoryTool: ToolDefinition;
	}> {
		const provider = new FileStoreProvider({ onDurableMemoryChanged });
		const ctx: MemoryLifecycleContext = { agentDir, cwd: testDir, isChildSession: false };
		await provider.initialize("test-session", ctx);
		const memoryTool = provider.getToolDefinitions().find((tool) => tool.name === "memory");
		if (!memoryTool) throw new Error("Expected bundled memory tool");
		return { provider, memoryTool };
	}

	async function execute(
		memoryTool: ToolDefinition,
		params: { action: "add" | "replace" | "remove"; target: "user"; content?: string; oldContent?: string },
	): Promise<MemoryToolDetails> {
		const result = await memoryTool.execute(
			"memory-test",
			params,
			undefined,
			undefined,
			undefined as unknown as ExtensionContext,
		);
		return (result.details ?? {}) as MemoryToolDetails;
	}

	it("migrates an overflowing USER.md into indexed OKF shards without losing facts", async () => {
		const originalFacts = Array.from(
			{ length: 11 },
			(_, index) => `Preference ${index + 1}: use bounded evidence ${"x".repeat(82)}-${index}.`,
		);
		writeFileSync(join(agentDir, "USER.md"), `${originalFacts.join("\n")}\n`, "utf8");
		let changes = 0;
		const { provider, memoryTool } = await initializeProvider(() => {
			changes += 1;
		});
		const addedFact = "Preference 12: preserve exact goal continuation state through compaction.";

		const details = await execute(memoryTool, { action: "add", target: "user", content: addedFact });

		expect(details).toMatchObject({ success: true });
		expect(changes).toBe(1);
		const userIndex = readFileSync(join(agentDir, "USER.md"), "utf8");
		expect(userIndex.length).toBeLessThanOrEqual(1375);
		expect(userIndex).toContain("okf-memory/user-preferences/index.okf.md");
		expect(userIndex).not.toContain(originalFacts[0]);
		expect(userIndex).not.toContain(addedFact);

		const archiveDir = join(agentDir, "okf-memory", "user-preferences");
		expect(existsSync(join(archiveDir, "index.okf.md"))).toBe(true);
		const shardNames = readdirSync(archiveDir).filter((name) =>
			/^user-preferences-[a-f0-9]{16}\.okf\.md$/.test(name),
		);
		expect(shardNames).toHaveLength(1);
		const shardText = readFileSync(join(archiveDir, shardNames[0]), "utf8");
		for (const fact of [...originalFacts, addedFact]) expect(shardText).toContain(fact);

		const report = loadOkfMemoryBundle({ rootDir: join(agentDir, "okf-memory") });
		expect(report.diagnostics).toEqual([]);
		expect(report.entries.some((entry) => entry.parsed.item?.kind === "user_preference")).toBe(true);
		expect(provider.systemPromptBlock().length).toBeLessThan(1800);
		expect(provider.systemPromptBlock()).not.toContain(originalFacts[0]);
	});

	it("updates and removes facts after they have moved into a shard", async () => {
		const archivedFact = `Preference: keep durable goal state ${"a".repeat(1290)}`;
		writeFileSync(join(agentDir, "USER.md"), `${archivedFact}\n`, "utf8");
		const { memoryTool } = await initializeProvider();
		const overflowFact = "Preference: use compact ephemeral goal projections.";
		expect(await execute(memoryTool, { action: "add", target: "user", content: overflowFact })).toMatchObject({
			success: true,
		});

		const replacement = "Preference: preserve durable goal state across every compaction.";
		expect(
			await execute(memoryTool, {
				action: "replace",
				target: "user",
				oldContent: archivedFact,
				content: replacement,
			}),
		).toMatchObject({ success: true });
		expect(await execute(memoryTool, { action: "remove", target: "user", oldContent: overflowFact })).toMatchObject({
			success: true,
		});

		const archiveDir = join(agentDir, "okf-memory", "user-preferences");
		const archivedText = readdirSync(archiveDir)
			.filter((name) => name.endsWith(".okf.md"))
			.map((name) => readFileSync(join(archiveDir, name), "utf8"))
			.join("\n");
		expect(archivedText).toContain(replacement);
		expect(archivedText).not.toContain(archivedFact);
		expect(archivedText).not.toContain(overflowFact);
	});

	it("automatically chops a very large USER.md into deterministic bounded shards", async () => {
		const largeFacts = Array.from(
			{ length: 18 },
			(_, index) =>
				`Large preference ${index + 1}: ${Array.from({ length: 700 }, (_unused, part) => `fact${index}detail${part}`).join(" ")}`,
		);
		const originalUser = `${largeFacts.join("\n")}\n`;
		writeFileSync(join(agentDir, "USER.md"), originalUser, "utf8");
		const { memoryTool } = await initializeProvider();

		const details = await execute(memoryTool, {
			action: "add",
			target: "user",
			content: "Final preference: preserve every large-profile fact during automatic migration.",
		});

		expect(details).toMatchObject({ success: true });
		const archiveDir = join(agentDir, "okf-memory", "user-preferences");
		const shardNames = readdirSync(archiveDir).filter((name) =>
			/^user-preferences-[a-f0-9]{16}\.okf\.md$/.test(name),
		);
		expect(shardNames.length).toBeGreaterThan(1);
		const archivedText = shardNames.map((name) => readFileSync(join(archiveDir, name), "utf8")).join("\n");
		for (const fact of largeFacts) expect(archivedText).toContain(fact);
		expect(archivedText).toContain("Final preference: preserve every large-profile fact during automatic migration.");

		// Simulate a crash after shard/index writes but before USER.md becomes the pointer: retrying the
		// same migration must reuse deterministic shard identities instead of duplicating the archive.
		const archive = new UserMemoryArchive(agentDir);
		await archive.apply(
			originalUser,
			{
				action: "add",
				content: "Final preference: preserve every large-profile fact during automatic migration.",
			},
			1375,
			supersedeNearDuplicateLine,
		);
		expect(
			readdirSync(archiveDir)
				.filter((name) => /^user-preferences-[a-f0-9]{16}\.okf\.md$/.test(name))
				.sort(),
		).toEqual([...shardNames].sort());
	});

	it("rejects an archive-directory symlink before touching its target", async () => {
		const outsideDir = join(testDir, "outside");
		mkdirSync(outsideDir, { recursive: true });
		const shardName = "user-preferences-0123456789abcdef.okf.md";
		const outsideShard = join(outsideDir, shardName);
		const originalShard = formatOkfMemoryDocument({
			type: "User Preference",
			title: "Outside preference",
			description: "Must remain untouched",
			scope: "user",
			body: "Preference: outside target must remain unchanged.",
		});
		writeFileSync(outsideShard, originalShard, "utf8");
		writeFileSync(join(agentDir, "USER.md"), USER_ARCHIVE_POINTER, "utf8");
		const okfDir = join(agentDir, "okf-memory");
		mkdirSync(okfDir, { recursive: true });
		symlinkSync(outsideDir, join(okfDir, "user-preferences"), process.platform === "win32" ? "junction" : "dir");
		const { memoryTool } = await initializeProvider();

		const details = await execute(memoryTool, {
			action: "replace",
			target: "user",
			oldContent: "Preference: outside target must remain unchanged.",
			content: "Preference: redirected write succeeded.",
		});

		expect(details.success).toBe(false);
		expect(readFileSync(outsideShard, "utf8")).toBe(originalShard);
	});
});
