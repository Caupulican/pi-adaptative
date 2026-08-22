import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { type Static, Type } from "typebox";
import { configFile, managedMemoryStateFile } from "../../agent-paths.ts";
import type { MemoryPromptBudget } from "../../context/memory-prompt-budget.ts";
import {
	OKF_MEMORY_LIMITS,
	PI_OKF_TYPES,
	type PiOkfType,
	validateOkfMemoryDocumentInput,
} from "../../context/okf-memory.ts";
import type { ToolDefinition } from "../../extensions/types.ts";
import {
	hasInvisibleUnicode,
	scanContextFileThreats,
	stripInvisibleUnicode,
} from "../../security/context-threat-scanner.ts";
import { jaccard, tokenize } from "../../tools/skill-audit.ts";
import { isMissingFileError, withFileLock, writeFileAtomic } from "../../util/atomic-file.ts";
import type { MemoryLifecycleContext, MemoryProvider } from "../memory-provider.ts";
import { OkfProjectMemoryStore } from "../okf-project-memory-store.ts";
import { UserMemoryArchive } from "./user-memory-archive.ts";

/**
 * Confront-before-write (anti append-rot): if `content` is a near-duplicate of an existing
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
		// silently overwrite section structure.
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
	action: Type.Union([Type.Literal("add"), Type.Literal("replace"), Type.Literal("remove"), Type.Literal("list")], {
		description: "Action to perform: add new content, replace existing content, or remove content",
	}),
	target: Type.Union([Type.Literal("memory"), Type.Literal("user"), Type.Literal("okf")], {
		description: "Target: 'memory' for MEMORY.md, 'user' for USER.md, or 'okf' for structured project memory",
	}),
	content: Type.Optional(
		Type.String({
			maxLength: OKF_MEMORY_LIMITS.bodyChars,
			description: "Content to write (required for add/replace)",
		}),
	),
	title: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: OKF_MEMORY_LIMITS.titleChars,
			description: "Structured OKF title (required when target is 'okf')",
		}),
	),
	oldContent: Type.Optional(
		Type.String({ description: "Exact substring to replace or remove (required for 'replace' or 'remove')" }),
	),
	type: Type.Optional(
		Type.Union(
			PI_OKF_TYPES.map((value) => Type.Literal(value)) as [
				ReturnType<typeof Type.Literal>,
				...ReturnType<typeof Type.Literal>[],
			],
			{
				description: "Structured OKF type (required when target is 'okf')",
			},
		),
	),
	description: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: OKF_MEMORY_LIMITS.descriptionChars,
			description: "Structured OKF summary (required when target is 'okf')",
		}),
	),
	scope: Type.Optional(Type.Literal("project", { description: "Structured OKF records are project-scoped" })),
	tags: Type.Optional(
		Type.Array(Type.String({ minLength: 1, maxLength: OKF_MEMORY_LIMITS.tagChars }), {
			maxItems: OKF_MEMORY_LIMITS.tagCount,
			uniqueItems: true,
			description: "Structured OKF tags",
		}),
	),
	evidenceRefs: Type.Optional(
		Type.Array(Type.String({ minLength: 1, maxLength: OKF_MEMORY_LIMITS.evidenceRefChars }), {
			minItems: 1,
			maxItems: OKF_MEMORY_LIMITS.evidenceRefCount,
			uniqueItems: true,
			description: "Evidence references for structured OKF",
		}),
	),
	expectedDigest: Type.Optional(
		Type.String({ pattern: "^[a-f0-9]{64}$", description: "Optional conflict guard for structured removal" }),
	),
});

type MemoryParams = Static<typeof memorySchema>;

export interface FileStoreProviderOptions {
	onDurableMemoryChanged?: () => void;
	/** Test seam between loss-safe OKF creation and exact hot-memory removal. */
	beforeOrganizeHotRemoval?: () => void | Promise<void>;
}

export type StructuredReflectionWrite =
	| {
			kind: "okf_add";
			type: PiOkfType;
			title: string;
			description: string;
			text: string;
			tags?: string[];
			evidenceRefs: string[];
	  }
	| {
			kind: "okf_organize";
			type: PiOkfType;
			title: string;
			description: string;
			text: string;
			sourceText: string;
			tags?: string[];
			evidenceRefs: string[];
	  };

export interface StructuredReflectionApplyResult {
	applied: boolean;
	created: boolean;
	digest?: string;
	sourceRemoved?: boolean;
	error?: string;
}

export interface StructuredReflectionRollback {
	type: PiOkfType;
	title: string;
	expectedDigest?: string;
	sourceText?: string;
	removeRecord: boolean;
}

export const FILE_STORE_MEMORY_SYSTEM_NOTE =
	"[System Note: Below is a snapshot of persistent memory. Proactively record verified reusable project facts and user preferences with the 'memory' tool. Keep MEMORY.md for compact hot facts, USER.md for preferences, and use target 'okf' for durable project decisions, architecture, rules, findings, and references. Never store transient noise.]";

interface ManagedMemoryState {
	version: 1;
	committedDigest: string;
	pendingDigest?: string;
}

type ManagedMemoryStateRead =
	| { status: "missing" }
	| { status: "valid"; state: ManagedMemoryState }
	| { status: "invalid"; raw: string };

function contentDigest(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

function removeExactHotMemoryItem(existing: string, sourceText: string): string | undefined {
	if (sourceText.length === 0) return undefined;
	const memoryLines = existing.split("\n");
	const sourceLines = sourceText.split("\n");
	const start = memoryLines.findIndex((_, index) =>
		sourceLines.every((line, offset) => memoryLines[index + offset] === line),
	);
	if (start === -1) return undefined;
	memoryLines.splice(start, sourceLines.length);
	return memoryLines.join("\n");
}

function parseManagedMemoryState(raw: string): ManagedMemoryState | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const record = parsed as Record<string, unknown>;
	if (record.version !== 1 || typeof record.committedDigest !== "string") return undefined;
	if (record.pendingDigest !== undefined && typeof record.pendingDigest !== "string") return undefined;
	return {
		version: 1,
		committedDigest: record.committedDigest,
		...(typeof record.pendingDigest === "string" ? { pendingDigest: record.pendingDigest } : {}),
	};
}

async function readManagedMemoryState(statePath: string): Promise<ManagedMemoryStateRead> {
	try {
		const raw = await fs.readFile(statePath, "utf8");
		const state = parseManagedMemoryState(raw);
		return state ? { status: "valid", state } : { status: "invalid", raw };
	} catch (error) {
		if (isMissingFileError(error)) return { status: "missing" };
		throw error;
	}
}

function serializeManagedMemoryState(state: ManagedMemoryState): string {
	return `${JSON.stringify(state)}\n`;
}

async function writeManagedMemoryState(statePath: string, state: ManagedMemoryState): Promise<void> {
	await writeFileAtomic(statePath, serializeManagedMemoryState(state), { mode: 0o600 });
}

function reconcileManagedMemoryState(
	currentDigest: string,
	state: ManagedMemoryState,
): { recognized: true; state: ManagedMemoryState; changed: boolean } | { recognized: false } {
	if (currentDigest === state.committedDigest) {
		if (state.pendingDigest === undefined) return { recognized: true, state, changed: false };
		return {
			recognized: true,
			state: { version: 1, committedDigest: state.committedDigest },
			changed: true,
		};
	}
	if (state.pendingDigest !== undefined && currentDigest === state.pendingDigest) {
		return {
			recognized: true,
			state: { version: 1, committedDigest: state.pendingDigest },
			changed: true,
		};
	}
	return { recognized: false };
}

function fitMemoryBlockToBudget(block: string, budget: MemoryPromptBudget | undefined): string {
	if (budget === undefined) return block;
	if (!budget.enabled || budget.maxLines <= 0 || budget.maxChars <= 0) return "";
	if (block.split("\n").length <= budget.maxLines && block.length <= budget.maxChars) return block;
	// Micro-context profiles deliberately omit a block that cannot fit whole. Larger constrained
	// profiles retain a bounded head and say explicitly that more memory exists on disk.
	if (budget.compact) return "";

	const marker = "[…memory truncated for capability budget; full files remain on disk]";
	if (budget.maxLines < 2 || budget.maxChars <= marker.length + 1) return "";
	const lines: string[] = [];
	let chars = 0;
	const contentCharLimit = budget.maxChars - marker.length - 1;
	for (const line of block.split("\n")) {
		if (lines.length >= budget.maxLines - 1) break;
		const separatorChars = lines.length > 0 ? 1 : 0;
		const remaining = contentCharLimit - chars - separatorChars;
		if (remaining <= 0) break;
		const rendered = line.length <= remaining ? line : `${line.slice(0, Math.max(0, remaining - 1))}…`;
		lines.push(rendered);
		chars += separatorChars + rendered.length;
		if (rendered.length !== line.length) break;
	}
	if (lines.length === 0) return "";
	lines.push(marker);
	return lines.join("\n");
}

export class FileStoreProvider implements MemoryProvider {
	public readonly name = "file-store";
	public readonly egress = "local";

	private ctx?: MemoryLifecycleContext;
	private memoryFilePath = "";
	private userFilePath = "";
	private memoryStatePath = "";
	private userStatePath = "";

	private lastWrittenMemory = "";
	private lastWrittenUser = "";
	private userArchive?: UserMemoryArchive;
	private okfStore?: OkfProjectMemoryStore;
	private readonly options: FileStoreProviderOptions;

	// Character budgets
	private static readonly BUDGET_MEMORY = 2200;
	private static readonly BUDGET_USER = 1375;

	constructor(options: FileStoreProviderOptions = {}) {
		this.options = options;
	}

	public isAvailable(): boolean {
		return true;
	}

	public getCapabilities() {
		return { surfaces: ["context" as const] };
	}

	public async initialize(_sessionId: string, ctx: MemoryLifecycleContext): Promise<void> {
		this.ctx = ctx;
		this.memoryFilePath = configFile(ctx.agentDir, "MEMORY.md");
		this.userFilePath = configFile(ctx.agentDir, "USER.md");
		this.memoryStatePath = managedMemoryStateFile(ctx.agentDir, "MEMORY.md");
		this.userStatePath = managedMemoryStateFile(ctx.agentDir, "USER.md");
		this.userArchive = new UserMemoryArchive(ctx.agentDir);

		await fs.mkdir(ctx.agentDir, { recursive: true });
		this.okfStore = new OkfProjectMemoryStore(ctx.agentDir, ctx.cwd);
		[this.lastWrittenMemory, this.lastWrittenUser] = await Promise.all([
			this.initializeManagedFile(this.memoryFilePath, this.memoryStatePath),
			this.initializeManagedFile(this.userFilePath, this.userStatePath),
		]);
	}

	private async initializeManagedFile(filePath: string, statePath: string): Promise<string> {
		return withFileLock(filePath, async () => {
			let current = "";
			try {
				current = await fs.readFile(filePath, "utf8");
			} catch (error) {
				if (!isMissingFileError(error)) throw error;
				await writeFileAtomic(filePath, "", { mode: 0o600 });
			}

			const currentDigest = contentDigest(current);
			const stateRead = await readManagedMemoryState(statePath);
			if (stateRead.status === "missing") {
				await writeManagedMemoryState(statePath, { version: 1, committedDigest: currentDigest });
				return current;
			}
			if (stateRead.status === "invalid") {
				await writeFileAtomic(`${statePath}.bak.${Date.now()}.${randomUUID()}`, stateRead.raw, { mode: 0o600 });
				await writeManagedMemoryState(statePath, { version: 1, committedDigest: currentDigest });
				return current;
			}

			const reconciled = reconcileManagedMemoryState(currentDigest, stateRead.state);
			if (reconciled.recognized && reconciled.changed) {
				await writeManagedMemoryState(statePath, reconciled.state);
			}
			return current;
		});
	}

	public systemPromptBlock(budget?: MemoryPromptBudget): string {
		const sanitize = (content: string) => {
			// Strip hidden/bidi-control chars before injecting memory into the prompt (defence in depth: the
			// write path already blocks them, but a file edited out-of-band could carry them). Strip #31.
			const lines = stripInvisibleUnicode(content).cleaned.split("\n");
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

		const block = `=== Persistent Memory (file-store) ===\n${FILE_STORE_MEMORY_SYSTEM_NOTE}\n\n${blocks.join("\n\n")}`;
		return fitMemoryBlockToBudget(block, budget);
	}

	public async prefetch(_query: string): Promise<string> {
		// static system prompt block is sufficient for file-store default; no-op prefetch
		return "";
	}

	public async shutdown(): Promise<void> {
		// no-op
	}

	private async executeMemoryCommand(
		params: MemoryParams,
		signal?: AbortSignal,
	): Promise<{
		details?: {
			success?: boolean;
			error?: string;
			created?: boolean;
			digest?: string;
			removed?: boolean;
		};
	}> {
		const tool = this.getToolDefinitions()[0];
		if (tool === undefined) return { details: { success: false, error: "Memory tool unavailable" } };
		const result = await tool.execute("reflection-memory", params, signal, undefined, undefined as never);
		return result as {
			details?: {
				success?: boolean;
				error?: string;
				created?: boolean;
				digest?: string;
				removed?: boolean;
			};
		};
	}

	private async hasExactHotMemoryItem(sourceText: string): Promise<boolean> {
		return withFileLock(this.memoryFilePath, async () => {
			const current = await fs.readFile(this.memoryFilePath, "utf8");
			return removeExactHotMemoryItem(current, sourceText) !== undefined;
		});
	}

	private async removeExactHotMemoryItem(sourceText: string): Promise<{ success: boolean; error?: string }> {
		try {
			return await withFileLock(this.memoryFilePath, async () => {
				const currentOnDisk = await fs.readFile(this.memoryFilePath, "utf8");
				const currentDigest = contentDigest(currentOnDisk);
				const stateRead = await readManagedMemoryState(this.memoryStatePath);
				let managedState: ManagedMemoryState | undefined;
				if (stateRead.status === "valid") {
					const reconciled = reconcileManagedMemoryState(currentDigest, stateRead.state);
					if (reconciled.recognized) {
						managedState = reconciled.state;
						if (reconciled.changed) await writeManagedMemoryState(this.memoryStatePath, reconciled.state);
					}
				}
				if (!managedState) return { success: false, error: "Drift detected" };

				const newContent = removeExactHotMemoryItem(currentOnDisk, sourceText);
				if (newContent === undefined) return { success: false, error: "Exact hot-memory item was not found" };
				const newDigest = contentDigest(newContent);
				await writeManagedMemoryState(this.memoryStatePath, {
					version: 1,
					committedDigest: managedState.committedDigest,
					pendingDigest: newDigest,
				});
				await writeFileAtomic(this.memoryFilePath, newContent, { mode: 0o600 });
				await writeManagedMemoryState(this.memoryStatePath, { version: 1, committedDigest: newDigest });
				this.lastWrittenMemory = newContent;
				this.options.onDurableMemoryChanged?.();
				return { success: true };
			});
		} catch (error) {
			return { success: false, error: String(error) };
		}
	}

	/** Reflection-owned structured write. Organization is OKF-first, then exact hot-memory removal. */
	public async applyStructuredReflectionWrite(
		write: StructuredReflectionWrite,
		signal?: AbortSignal,
	): Promise<StructuredReflectionApplyResult> {
		if (write.kind === "okf_organize" && !(await this.hasExactHotMemoryItem(write.sourceText))) {
			return {
				applied: false,
				created: false,
				sourceRemoved: false,
				error: "Exact hot-memory item was not found",
			};
		}
		const added = await this.executeMemoryCommand(
			{
				action: "add",
				target: "okf",
				type: write.type,
				title: write.title,
				description: write.description,
				scope: "project",
				content: write.text,
				tags: write.tags,
				evidenceRefs: write.evidenceRefs,
			},
			signal,
		);
		if (added.details?.success !== true) {
			return { applied: false, created: false, error: added.details?.error ?? "OKF write failed" };
		}
		const created = added.details.created === true;
		const storedDigest = added.details.digest;
		if (write.kind === "okf_add") {
			return {
				applied: created,
				created,
				...(storedDigest ? { digest: storedDigest } : {}),
				...(!created ? { error: "Exact OKF record already exists" } : {}),
			};
		}
		await this.options.beforeOrganizeHotRemoval?.();
		const removed = await this.removeExactHotMemoryItem(write.sourceText);
		const sourceRemoved = removed.success;
		return {
			// A newly-created OKF record is a real durable change even if exact hot cleanup was
			// interrupted. This records a reversible partial apply instead of hiding landed data.
			applied: created || sourceRemoved,
			created,
			...(storedDigest ? { digest: storedDigest } : {}),
			sourceRemoved,
			...(!sourceRemoved ? { error: removed.error ?? "Hot-memory removal failed" } : {}),
		};
	}

	/** Restore hot memory first, then conditionally remove the exact audited OKF bytes. */
	public async rollbackStructuredReflectionWrite(
		rollback: StructuredReflectionRollback,
		signal?: AbortSignal,
	): Promise<boolean> {
		if (rollback.sourceText !== undefined) {
			const restored = await this.executeMemoryCommand(
				{ action: "add", target: "memory", content: rollback.sourceText },
				signal,
			);
			if (restored.details?.success !== true) return false;
		}
		if (!rollback.removeRecord) return true;
		const removed = await this.executeMemoryCommand(
			{
				action: "remove",
				target: "okf",
				type: rollback.type,
				title: rollback.title,
				expectedDigest: rollback.expectedDigest,
			},
			signal,
		);
		return removed.details?.success === true;
	}

	public getContextMarkers(): string[] {
		return [];
	}

	public getToolDefinitions(): ToolDefinition[] {
		return [
			{
				name: "memory",
				label: "Persistent Memory Manager",
				description:
					"Add, replace, or remove durable facts and preferences. Use target 'okf' with structured metadata for durable project decisions, architecture, rules, debugging findings, and references; USER.md overflow is migrated into indexed OKF shards.",
				promptSnippet: "Persist verified facts; route durable project knowledge to structured OKF records.",
				promptGuidelines: [
					"OKF=project decisions/rules/findings with type,title,summary,body,evidenceRefs; MEMORY=hot facts; USER=preferences.",
					"Workers gather evidence read-only; only the parent or its reflection writes memory. Repeatable procedures become skills via skillify.",
				],
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

					const {
						action,
						target,
						content,
						oldContent,
						title,
						type,
						description,
						scope,
						tags,
						evidenceRefs,
						expectedDigest,
					} = params;

					// Strict-scope injection guard on the high-privilege WRITE path (agy #31): a poisoned
					// memory entry persists across sessions and is injected into every future system prompt,
					// so block outright rather than strip. Hidden/bidi-control chars have no legitimate place
					// in a memory note, so reject those too.
					if ((action === "add" || action === "replace") && content !== undefined) {
						if (hasInvisibleUnicode(content)) {
							return {
								content: [
									{
										type: "text",
										text: "Error: memory write rejected — contains hidden/bidirectional control characters.",
									},
								],
								details: { success: false, error: "Invisible unicode in memory write" },
							};
						}
						const threats = scanContextFileThreats(content, "strict");
						if (threats.length > 0) {
							return {
								content: [
									{
										type: "text",
										text: `Error: memory write rejected — potential injection/exfiltration detected (${threats.join(", ")}).`,
									},
								],
								details: { success: false, error: "Threat in memory write" },
							};
						}
					}

					if (target === "okf") {
						if (action === "list") {
							if (this.okfStore === undefined) {
								return {
									content: [{ type: "text", text: "Error: Memory provider is not initialized." }],
									details: { success: false },
								};
							}
							const catalog = this.okfStore.list();
							return {
								content: [{ type: "text", text: catalog || "No structured OKF memory records found." }],
								details: { success: true },
							};
						}
						if (action !== "add" && action !== "remove") {
							return {
								content: [
									{
										type: "text",
										text: "Error: structured OKF memory only supports action 'add' or 'remove'.",
									},
								],
								details: { success: false, error: "Unsupported OKF action" },
							};
						}
						if (action === "remove") {
							if (
								this.okfStore === undefined ||
								type === undefined ||
								title === undefined ||
								!PI_OKF_TYPES.includes(type as PiOkfType)
							) {
								return {
									content: [{ type: "text", text: "Error: OKF removal requires a valid type and title." }],
									details: { success: false, error: "Incomplete OKF removal" },
								};
							}
							try {
								const removed = await this.okfStore.remove(type as PiOkfType, title, expectedDigest);
								if (removed.removed) this.options.onDurableMemoryChanged?.();
								return {
									content: [
										{
											type: "text",
											text: removed.removed
												? "Successfully removed structured OKF project memory."
												: "Structured OKF project memory was already absent.",
										},
									],
									details: { success: true, removed: removed.removed },
								};
							} catch (err) {
								const error = String(err);
								return {
									content: [{ type: "text", text: `Error: Failed to remove structured OKF memory: ${error}` }],
									details: { success: false, error: /ENOENT/.test(error) ? "not found" : error },
								};
							}
						}
						if (
							type === undefined ||
							title === undefined ||
							description === undefined ||
							scope !== "project" ||
							content === undefined ||
							evidenceRefs === undefined ||
							evidenceRefs.length === 0
						) {
							return {
								content: [
									{
										type: "text",
										text: "Error: structured OKF memory requires type, title, description, scope, content, and evidenceRefs.",
									},
								],
								details: { success: false, error: "Incomplete OKF memory" },
							};
						}
						if (!PI_OKF_TYPES.includes(type as PiOkfType)) {
							return {
								content: [{ type: "text", text: `Error: unsupported OKF type '${type}'.` }],
								details: { success: false, error: "Unsupported OKF type" },
							};
						}
						const validationErrors = validateOkfMemoryDocumentInput(
							{
								type: type as PiOkfType,
								title,
								description,
								scope,
								body: content,
								tags,
								evidenceRefs,
							},
							{ projectOnly: true, requireEvidence: true },
						);
						if (validationErrors.length > 0) {
							return {
								content: [
									{
										type: "text",
										text: `Error: Invalid structured OKF memory: ${validationErrors.join("; ")}`,
									},
								],
								details: { success: false, error: "Invalid OKF memory" },
							};
						}
						const okfText = [type, title, description, scope, content, ...(tags ?? []), ...evidenceRefs].join(
							"\n",
						);
						if (hasInvisibleUnicode(okfText)) {
							return {
								content: [
									{
										type: "text",
										text: "Error: OKF write rejected — contains hidden/bidirectional control characters.",
									},
								],
								details: { success: false, error: "Invisible unicode in OKF write" },
							};
						}
						const threats = scanContextFileThreats(okfText, "strict");
						if (threats.length > 0) {
							return {
								content: [
									{
										type: "text",
										text: `Error: OKF write rejected — potential injection/exfiltration detected (${threats.join(", ")}).`,
									},
								],
								details: { success: false, error: "Threat in OKF write" },
							};
						}
						try {
							if (this.okfStore === undefined) throw new Error("Memory provider is not initialized.");
							const stored = await this.okfStore.put({
								type: type as PiOkfType,
								title,
								description,
								scope,
								body: content,
								tags,
								evidenceRefs,
							});
							if (stored.created) this.options.onDurableMemoryChanged?.();
							return {
								content: [
									{
										type: "text",
										text: stored.created
											? "Successfully added structured OKF project memory."
											: "Structured OKF project memory already contained this exact record.",
									},
								],
								details: { success: true, created: stored.created, digest: stored.digest },
							};
						} catch (err) {
							return {
								content: [
									{ type: "text", text: `Error: Failed to write structured OKF memory: ${String(err)}` },
								],
								details: { success: false, error: String(err) },
							};
						}
					}
					if (action === "list") {
						return {
							content: [{ type: "text", text: "Error: action 'list' is only supported for target 'okf'." }],
							details: { success: false, error: "Unsupported list target" },
						};
					}

					const filePath = target === "memory" ? this.memoryFilePath : this.userFilePath;
					const statePath = target === "memory" ? this.memoryStatePath : this.userStatePath;
					const budget = target === "memory" ? FileStoreProvider.BUDGET_MEMORY : FileStoreProvider.BUDGET_USER;

					try {
						return await withFileLock(filePath, async () => {
							const currentOnDisk = await fs.readFile(filePath, "utf8");
							const currentDigest = contentDigest(currentOnDisk);
							const stateRead = await readManagedMemoryState(statePath);
							let managedState: ManagedMemoryState | undefined;
							if (stateRead.status === "valid") {
								const reconciled = reconcileManagedMemoryState(currentDigest, stateRead.state);
								if (reconciled.recognized) {
									managedState = reconciled.state;
									if (reconciled.changed) await writeManagedMemoryState(statePath, reconciled.state);
								}
							}
							if (!managedState) {
								const backupPath = `${filePath}.bak.${Date.now()}`;
								await writeFileAtomic(backupPath, currentOnDisk, { mode: 0o600 });
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

							// A peer session's committed write is authoritative. Refresh this provider's prompt
							// snapshot before applying the caller's mutation to that current content.
							if (target === "memory") this.lastWrittenMemory = currentOnDisk;
							else this.lastWrittenUser = currentOnDisk;

							let newContent = currentOnDisk;
							let archiveChanged = false;
							if (target === "user") {
								if (!this.userArchive) throw new Error("User memory archive is not initialized.");
								if (action === "add") {
									if (content === undefined)
										throw new Error("Parameter 'content' is required for action 'add'.");
									const result = await this.userArchive.apply(
										currentOnDisk,
										{ action, content },
										budget,
										supersedeNearDuplicateLine,
									);
									newContent = result.userContent;
									archiveChanged = result.archiveChanged;
								} else if (action === "replace") {
									if (content === undefined || oldContent === undefined) {
										throw new Error(
											"Parameters 'content' and 'oldContent' are required for action 'replace'.",
										);
									}
									const result = await this.userArchive.apply(
										currentOnDisk,
										{ action, content, oldContent },
										budget,
										supersedeNearDuplicateLine,
									);
									newContent = result.userContent;
									archiveChanged = result.archiveChanged;
								} else {
									if (oldContent === undefined)
										throw new Error("Parameter 'oldContent' is required for action 'remove'.");
									const result = await this.userArchive.apply(
										currentOnDisk,
										{ action, oldContent },
										budget,
										supersedeNearDuplicateLine,
									);
									newContent = result.userContent;
									archiveChanged = result.archiveChanged;
								}
							} else if (action === "add") {
								if (content === undefined) {
									throw new Error("Parameter 'content' is required for action 'add'.");
								}
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

							if (newContent !== currentOnDisk) {
								const newDigest = contentDigest(newContent);
								await writeManagedMemoryState(statePath, {
									version: 1,
									committedDigest: managedState.committedDigest,
									pendingDigest: newDigest,
								});
								await writeFileAtomic(filePath, newContent, { mode: 0o600 });
								await writeManagedMemoryState(statePath, { version: 1, committedDigest: newDigest });
							}

							if (target === "memory") this.lastWrittenMemory = newContent;
							else this.lastWrittenUser = newContent;
							if (archiveChanged || newContent !== currentOnDisk) this.options.onDurableMemoryChanged?.();

							return {
								content: [
									{
										type: "text",
										text: `Successfully updated ${target === "memory" ? "MEMORY.md" : "USER.md"}.`,
									},
								],
								details: { success: true },
							};
						});
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
					}
				},
			},
		];
	}
}
