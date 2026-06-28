import { existsSync, promises as fs, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import lockfile from "proper-lockfile";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../../extensions/types.ts";
import { scanContextFileThreats } from "../../resource-loader.ts";
import { jaccard, tokenize } from "../../tools/skill-audit.ts";
import type { MemoryLifecycleContext, MemoryProvider } from "../memory-provider.ts";

/**
 * R5 confront-before-write (anti append-rot): if `content` is a near-duplicate of an existing
 * non-empty line (token Jaccard ≥ threshold — i.e. the same fact reworded), supersede that line in
 * place and return the rewritten file; otherwise return null (the caller appends normally).
 */
export function supersedeNearDuplicateLine(existing: string, content: string): string | null {
	const NEAR_DUP_THRESHOLD = 0.6;
	const contentTokens = tokenize(content);
	if (contentTokens.length === 0) return null;
	const lines = existing.split("\n");
	let bestIdx = -1;
	let bestScore = NEAR_DUP_THRESHOLD;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line) continue;
		// Never supersede structural Markdown (headings, list markers as headings) — a fact must not
		// silently overwrite section structure (Bug #15).
		if (line.startsWith("#")) continue;
		const score = jaccard(contentTokens, tokenize(line));
		if (score >= bestScore) {
			bestScore = score;
			bestIdx = i;
		}
	}
	if (bestIdx === -1) return null;
	lines[bestIdx] = content;
	return lines.join("\n");
}

const memorySchema = Type.Object({
	action: Type.Union([Type.Literal("add"), Type.Literal("replace"), Type.Literal("remove")], {
		description: "Action to perform: add new content, replace existing content, or remove content",
	}),
	target: Type.Union([Type.Literal("memory"), Type.Literal("user")], {
		description: "Target file: 'memory' for MEMORY.md, 'user' for USER.md",
	}),
	content: Type.Optional(Type.String({ description: "Content to write (required for 'add' or 'replace')" })),
	oldContent: Type.Optional(
		Type.String({ description: "Exact substring to replace or remove (required for 'replace' or 'remove')" }),
	),
});

type MemoryParams = Static<typeof memorySchema>;

export class FileStoreProvider implements MemoryProvider {
	public readonly name = "file-store";

	private ctx?: MemoryLifecycleContext;
	private memoryFilePath = "";
	private userFilePath = "";

	private lastWrittenMemory = "";
	private lastWrittenUser = "";

	// Character budgets
	private static readonly BUDGET_MEMORY = 2200;
	private static readonly BUDGET_USER = 1375;

	public isAvailable(): boolean {
		return true;
	}

	public getCapabilities() {
		return { surfaces: ["context" as const] };
	}

	public async initialize(_sessionId: string, ctx: MemoryLifecycleContext): Promise<void> {
		this.ctx = ctx;
		this.memoryFilePath = join(ctx.agentDir, "MEMORY.md");
		this.userFilePath = join(ctx.agentDir, "USER.md");

		// Ensure agentDir exists
		if (!existsSync(ctx.agentDir)) {
			mkdirSync(ctx.agentDir, { recursive: true });
		}

		// Initialize files if they do not exist
		if (!existsSync(this.memoryFilePath)) {
			writeFileSync(this.memoryFilePath, "", "utf-8");
		}
		if (!existsSync(this.userFilePath)) {
			writeFileSync(this.userFilePath, "", "utf-8");
		}

		// Load initial contents
		this.lastWrittenMemory = await fs.readFile(this.memoryFilePath, "utf-8");
		this.lastWrittenUser = await fs.readFile(this.userFilePath, "utf-8");
	}

	public systemPromptBlock(): string {
		const sanitize = (content: string) => {
			const lines = content.split("\n");
			const sanitizedLines = lines.map((line) => {
				const threats = scanContextFileThreats(line);
				if (threats.length > 0) {
					return `[BLOCKED: potential threat detected (${threats.join(", ")})]`;
				}
				return line;
			});
			return sanitizedLines.join("\n");
		};

		// Read-time budget guard (cost): the memory tool already caps writes at BUDGET_*, but a file edited
		// externally (or by any path that bypasses the tool) could be arbitrarily large and would then
		// bloat the system prompt on EVERY turn. Cap the injected view to the same budget so the per-turn
		// cost stays bounded; the file on disk is untouched and the model is told it was truncated.
		const cap = (content: string, limit: number) => {
			if (content.length <= limit) return content;
			return `${content.slice(0, limit)}\n[…truncated to ${limit} chars for the prompt; full file is on disk]`;
		};

		const mem = cap(sanitize(this.lastWrittenMemory), FileStoreProvider.BUDGET_MEMORY);
		const usr = cap(sanitize(this.lastWrittenUser), FileStoreProvider.BUDGET_USER);

		const blocks: string[] = [];
		if (mem.trim()) {
			blocks.push(`## MEMORY.md:\n${mem}`);
		}
		if (usr.trim()) {
			blocks.push(`## USER.md:\n${usr}`);
		}

		if (blocks.length === 0) {
			return "";
		}

		return `=== Persistent Memory (file-store) ===\n[System Note: Below is a snapshot of your persistent memory. You can update these using the 'memory' tool.]\n\n${blocks.join("\n\n")}`;
	}

	public async prefetch(_query: string): Promise<string> {
		// static system prompt block is sufficient for file-store default; no-op prefetch
		return "";
	}

	public async shutdown(): Promise<void> {
		// no-op
	}

	public getContextMarkers(): string[] {
		return [];
	}

	public getToolDefinitions(): ToolDefinition[] {
		return [
			{
				name: "memory",
				label: "Persistent Memory Manager",
				description: "Add, replace, or remove contents in persistent memory files (MEMORY.md/USER.md).",
				parameters: memorySchema,
				execute: async (_toolCallId, params: MemoryParams, _signal, _onUpdate, _execCtx) => {
					if (this.ctx?.isChildSession) {
						return {
							content: [
								{
									type: "text",
									text: "Error: Writes to persistent memory are not allowed in child sessions (subagents).",
								},
							],
							details: { success: false, error: "Child session write-gated" },
						};
					}

					const { action, target, content, oldContent } = params;
					const filePath = target === "memory" ? this.memoryFilePath : this.userFilePath;
					const budget = target === "memory" ? FileStoreProvider.BUDGET_MEMORY : FileStoreProvider.BUDGET_USER;

					let release: (() => Promise<void>) | undefined;
					try {
						// File lock
						release = await lockfile.lock(filePath, { realpath: false, retries: 5 });

						const lastWritten = target === "memory" ? this.lastWrittenMemory : this.lastWrittenUser;
						// Read current file content on disk for drift detection
						const currentOnDisk = await fs.readFile(filePath, "utf-8");
						if (currentOnDisk !== lastWritten) {
							// Drift detected. Backup current file and refuse write.
							const backupPath = `${filePath}.bak.${Date.now()}`;
							await fs.writeFile(backupPath, currentOnDisk, "utf-8");
							return {
								content: [
									{
										type: "text",
										text: `Error: Drift detected. The memory file has been modified out-of-band by an external process. A backup was created at ${backupPath}. Operation aborted.`,
									},
								],
								details: { success: false, error: "Drift detected" },
							};
						}

						let newContent = currentOnDisk;
						if (action === "add") {
							if (content === undefined) {
								throw new Error("Parameter 'content' is required for action 'add'.");
							}
							// R5: confront before write. If this fact is a near-duplicate of an existing line,
							// supersede it in place instead of appending a redundant copy (prevents append-rot).
							const superseded = supersedeNearDuplicateLine(currentOnDisk, content);
							if (superseded !== null) {
								newContent = superseded;
							} else {
								newContent =
									newContent.endsWith("\n") || newContent === ""
										? `${newContent}${content}\n`
										: `${newContent}\n${content}\n`;
							}
						} else if (action === "replace") {
							if (content === undefined || oldContent === undefined) {
								throw new Error("Parameters 'content' and 'oldContent' are required for action 'replace'.");
							}
							if (!currentOnDisk.includes(oldContent)) {
								throw new Error(`The content to replace ('oldContent') was not found in the file.`);
							}
							newContent = currentOnDisk.replace(oldContent, content);
						} else if (action === "remove") {
							if (oldContent === undefined) {
								throw new Error("Parameter 'oldContent' is required for action 'remove'.");
							}
							if (!currentOnDisk.includes(oldContent)) {
								throw new Error(`The content to remove ('oldContent') was not found in the file.`);
							}
							newContent = currentOnDisk.replace(oldContent, "");
						}

						// Budget check
						if (newContent.length > budget) {
							return {
								content: [
									{
										type: "text",
										text: `Error: Memory budget exceeded. ${target === "memory" ? "MEMORY.md" : "USER.md"} limit is ${budget} characters. Current operation would result in ${newContent.length} characters.`,
									},
								],
								details: { success: false, error: "Memory budget exceeded" },
							};
						}

						// Atomic write
						const tmpPath = `${filePath}.tmp`;
						await fs.writeFile(tmpPath, newContent, "utf-8");
						await fs.rename(tmpPath, filePath);

						// Update in-memory tracker
						if (target === "memory") {
							this.lastWrittenMemory = newContent;
						} else {
							this.lastWrittenUser = newContent;
						}

						return {
							content: [
								{
									type: "text",
									text: `Successfully updated ${target === "memory" ? "MEMORY.md" : "USER.md"}.`,
								},
							],
							details: { success: true },
						};
					} catch (err) {
						return {
							content: [
								{
									type: "text",
									text: `Error: Failed to perform memory operation: ${String(err)}`,
								},
							],
							details: { success: false, error: String(err) },
						};
					} finally {
						if (release) {
							await release();
						}
					}
				},
			},
		];
	}
}
