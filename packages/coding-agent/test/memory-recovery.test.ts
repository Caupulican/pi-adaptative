import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentToolResult } from "../src/core/extensions/types.ts";
import { FileStoreProvider } from "../src/core/memory/providers/file-store.ts";

function digest(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

function execute(provider: FileStoreProvider, params: Record<string, unknown>) {
	const tool = provider.getToolDefinitions()[0];
	if (!tool) throw new Error("Memory tool missing");
	return tool.execute("memory-recovery", params, undefined, undefined, undefined as never);
}

function text(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

describe("FileStoreProvider recovery evidence", () => {
	let root: string;
	let agentDir: string;
	let memoryPath: string;
	let statePath: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-memory-recovery-"));
		agentDir = join(root, "agent");
		mkdirSync(agentDir);
		memoryPath = join(agentDir, "MEMORY.md");
		statePath = join(agentDir, "state", "memory", "file-store", "MEMORY.md.pi-managed.json");
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	async function initialize(): Promise<FileStoreProvider> {
		const provider = new FileStoreProvider();
		await provider.initialize("recovery", { agentDir, cwd: root, isChildSession: false });
		return provider;
	}

	it("lists actual external content and separate revisions without accepting drift or changing the prompt", async () => {
		const managed = "Previously managed fact.\n";
		writeFileSync(memoryPath, managed);
		const provider = await initialize();
		const stateBefore = readFileSync(statePath, "utf8");
		const external = "An external editor changed this fact.\n";
		writeFileSync(memoryPath, external);

		const listed = await execute(provider, { action: "list" });

		expect(listed.isError).not.toBe(true);
		expect(text(listed)).toContain(external.trim());
		expect(listed.details).toMatchObject({
			success: true,
			files: expect.arrayContaining([
				expect.objectContaining({
					target: "memory",
					currentDigest: digest(external),
					managedDigest: digest(managed),
					promptDigest: digest(managed),
					drift: true,
					stateStatus: "valid",
				}),
			]),
		});
		expect(text(listed)).toContain("Drift detected");
		expect(text(listed)).toContain("owner");
		expect(provider.systemPromptBlock()).toContain(managed.trim());
		expect(provider.systemPromptBlock()).not.toContain(external.trim());
		expect(readFileSync(statePath, "utf8")).toBe(stateBefore);
		expect(readdirSync(agentDir).filter((name) => name.includes(".bak."))).toEqual([]);
		const refused = await execute(provider, { action: "add", target: "memory", content: "New fact" });
		expect(refused).toMatchObject({ isError: true, errorKind: "operation_outcome", details: { success: false } });
		expect(readFileSync(memoryPath, "utf8")).toBe(external);
	});

	it("lists recognized peer writes without reporting external drift or relabeling its old prompt snapshot", async () => {
		const observer = await initialize();
		const peer = await initialize();
		expect(
			(await execute(peer, { action: "add", target: "user", content: "Prefer concise answers." })).details,
		).toMatchObject({ success: true });
		const listed = await execute(observer, { action: "list" });
		const current = readFileSync(join(agentDir, "USER.md"), "utf8");
		expect(text(listed)).toContain("Prefer concise answers.");
		expect(listed.details).toMatchObject({
			files: expect.arrayContaining([
				expect.objectContaining({
					target: "user",
					currentDigest: digest(current),
					managedDigest: digest(current),
					promptDigest: digest(""),
					drift: false,
				}),
			]),
		});
		expect(observer.systemPromptBlock()).toBe("");
	});

	it("captures prompt revision after an earlier mutation releases the file lock", async () => {
		const provider = await initialize();
		const mutation = execute(provider, { action: "add", target: "memory", content: "Queued managed fact." });
		const listing = execute(provider, { action: "list" });
		const [written, listed] = await Promise.all([mutation, listing]);
		expect(written.details).toMatchObject({ success: true });
		const currentDigest = digest(readFileSync(memoryPath, "utf8"));
		expect(listed.details).toMatchObject({
			files: expect.arrayContaining([
				expect.objectContaining({
					target: "memory",
					currentDigest,
					managedDigest: currentDigest,
					promptDigest: currentDigest,
					drift: false,
				}),
			]),
		});
	});

	it("reports pending-write recovery read-only and finalizes it only on mutation", async () => {
		const provider = await initialize();
		const pending = "Peer write awaiting state finalization.\n";
		const state = `${JSON.stringify({ version: 1, committedDigest: digest(""), pendingDigest: digest(pending) })}\n`;
		writeFileSync(statePath, state);
		writeFileSync(memoryPath, pending);
		const listed = await execute(provider, { action: "list" });
		expect(listed.details).toMatchObject({
			files: expect.arrayContaining([
				expect.objectContaining({
					target: "memory",
					currentDigest: digest(pending),
					managedDigest: digest(""),
					pendingDigest: digest(pending),
					drift: false,
				}),
			]),
		});
		expect(readFileSync(statePath, "utf8")).toBe(state);
		expect(
			(await execute(provider, { action: "add", target: "memory", content: "Another fact." })).details,
		).toMatchObject({ success: true });
		expect(readFileSync(statePath, "utf8")).not.toContain("pendingDigest");
	});

	it("retains one exact backup per distinct drift revision across repeated and concurrent refusals", async () => {
		const first = await initialize();
		const second = await initialize();
		for (const external of ["External revision one.\n", "External revision two.\n"]) {
			writeFileSync(memoryPath, external);
			const params = { action: "add", target: "memory", content: "Rejected addition." };
			const results = await Promise.all([execute(first, params), execute(second, params), execute(first, params)]);
			for (const result of results) {
				expect(result).toMatchObject({
					isError: true,
					errorKind: "operation_outcome",
					details: {
						success: false,
						error: "Drift detected",
						currentDigest: digest(external),
						managedDigest: digest(""),
						backupPath: `${memoryPath}.bak.sha256-${digest(external)}`,
					},
				});
			}
			expect(readFileSync(`${memoryPath}.bak.sha256-${digest(external)}`, "utf8")).toBe(external);
			expect(readFileSync(memoryPath, "utf8")).toBe(external);
		}
		expect(readdirSync(agentDir).filter((name) => name.includes(".bak."))).toHaveLength(2);
		expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({ version: 1, committedDigest: digest("") });
	});

	it("refuses a conflicting existing backup without overwriting either copy", async () => {
		const provider = await initialize();
		const external = "Externally edited memory.\n";
		const backupPath = `${memoryPath}.bak.sha256-${digest(external)}`;
		writeFileSync(memoryPath, external);
		writeFileSync(backupPath, "Distinct bytes already at the backup path.\n");
		const result = await execute(provider, { action: "add", target: "memory", content: "Refused." });
		expect(result).toMatchObject({ isError: true, details: { success: false } });
		expect(text(result)).toContain("backup content conflicts");
		expect(readFileSync(backupPath, "utf8")).toBe("Distinct bytes already at the backup path.\n");
		expect(readFileSync(memoryPath, "utf8")).toBe(external);
	});

	it.each(["missing", "invalid"] as const)(
		"reports %s state without adopting content or misdiagnosing an external editor",
		async (stateStatus) => {
			const provider = await initialize();
			if (stateStatus === "missing") rmSync(statePath);
			else writeFileSync(statePath, "invalid JSON");
			const listed = await execute(provider, { action: "list" });
			expect(listed.details).toMatchObject({
				files: expect.arrayContaining([
					expect.objectContaining({ target: "memory", stateStatus, currentDigest: digest(""), drift: true }),
				]),
			});
			const refused = await execute(provider, { action: "add", target: "memory", content: "Refused." });
			expect(refused).toMatchObject({ isError: true, details: { success: false, stateStatus } });
			expect(text(refused)).not.toContain("modified out-of-band by an external process");
			expect(readFileSync(memoryPath, "utf8")).toBe("");
			if (stateStatus === "missing") expect(() => readFileSync(statePath)).toThrow();
			else expect(readFileSync(statePath, "utf8")).toBe("invalid JSON");
		},
	);

	it("allows mutation after an owner restores exact managed bytes while preserving the rejected external revision", async () => {
		const managed = "Original managed preference.\n";
		writeFileSync(memoryPath, managed);
		const provider = await initialize();
		const external = "External preference pending owner review.\n";
		writeFileSync(memoryPath, external);
		const params = { action: "add", target: "memory", content: "Unrelated durable fact." };
		expect((await execute(provider, params)).isError).toBe(true);
		writeFileSync(memoryPath, managed);
		expect((await execute(provider, params)).details).toMatchObject({ success: true });
		expect(readFileSync(memoryPath, "utf8")).toContain(managed);
		expect(readFileSync(`${memoryPath}.bak.sha256-${digest(external)}`, "utf8")).toBe(external);
	});

	it.each(["remove", "replace"] as const)(
		"allows a strict %s reduction of legacy over-budget content",
		async (action) => {
			const original = `${"x".repeat(1400)}\nobsolete fact\n`;
			writeFileSync(memoryPath, original);
			const provider = await initialize();
			const result = await execute(provider, {
				action,
				target: "memory",
				oldContent: "obsolete fact",
				content: "short",
			});
			const reduced = original.replace("obsolete fact", action === "replace" ? "short" : "");
			expect(result).toMatchObject({
				details: { success: true, overBudget: true, currentChars: reduced.length, budgetChars: 1200 },
			});
			expect(result.isError).not.toBe(true);
			expect(text(result)).toContain("still over budget");
			expect(readFileSync(memoryPath, "utf8")).toBe(reduced);
			expect(provider.generalMemoryOverBudget()).toBe(true);
			expect(
				(await execute(provider, { action: "remove", target: "memory", oldContent: "x".repeat(300) })).details,
			).toMatchObject({ success: true, overBudget: false });
			expect(provider.generalMemoryOverBudget()).toBe(false);
		},
	);

	it.each([
		{ action: "add", content: "New unrelated fact." },
		{ action: "replace", oldContent: "x", content: "y" },
		{ action: "replace", oldContent: "x", content: "longer" },
		{ action: "remove", oldContent: "" },
	])("rejects non-reducing over-budget intent $action $content without changing state", async (params) => {
		const original = "x".repeat(1400);
		writeFileSync(memoryPath, original);
		const provider = await initialize();
		const state = readFileSync(statePath, "utf8");
		const result = await execute(provider, { target: "memory", ...params });
		expect(result).toMatchObject({ isError: true, details: { success: false, error: "Memory budget exceeded" } });
		expect(readFileSync(memoryPath, "utf8")).toBe(original);
		expect(readFileSync(statePath, "utf8")).toBe(state);
	});

	it.each([
		{ action: "replace", target: "memory", oldContent: "absent", content: "new" },
		{ action: "add", target: "memory", content: "hidden\u200btext" },
		{ action: "add", target: "okf", content: "incomplete metadata" },
	])("classifies semantic failures consistently: $target $action", async (params) => {
		const provider = await initialize();
		const result = await execute(provider, params);
		expect(result).toMatchObject({ isError: true, errorKind: "operation_outcome", details: { success: false } });
		expect(readFileSync(memoryPath, "utf8")).toBe("");
	});
});
