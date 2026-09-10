import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { type Static, Type } from "typebox";
import {
	configFile,
	managedMemoryStateFile,
	managedProjectMemoryStateFile,
	projectMemoryDir,
} from "../../agent-paths.ts";
import type { MemoryPromptBudget } from "../../context/memory-prompt-budget.ts";
import {
	OKF_MEMORY_LIMITS,
	PI_OKF_TYPES,
	type PiOkfType,
	validateOkfMemoryDocumentInput,
} from "../../context/okf-memory.ts";
import type { AgentToolResult, ToolDefinition } from "../../extensions/types.ts";
import {
	hasInvisibleUnicode,
	scanContextFileThreats,
	stripInvisibleUnicode,
} from "../../security/context-threat-scanner.ts";
import { getDirectoryResourceProfileInfo } from "../../settings-manager.ts";
import { jaccard, tokenize } from "../../tools/skill-audit.ts";
import { isMissingFileError, withFileLock, writeFileAtomic } from "../../util/atomic-file.ts";
import type { MemoryLifecycleContext, MemoryProvider } from "../memory-provider.ts";
import { OkfProjectMemoryStore } from "../okf-project-memory-store.ts";
import { ROOT_MEMORY_TOOL_NAME } from "../worker-memory-tools.ts";
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

const memoryFields = Type.Object({
	action: Type.Union([Type.Literal("add"), Type.Literal("replace"), Type.Literal("remove"), Type.Literal("list")], {
		description: "Action to perform: add new content, replace existing content, or remove content",
	}),
	target: Type.Optional(
		Type.Union([Type.Literal("memory"), Type.Literal("project"), Type.Literal("user"), Type.Literal("okf")], {
			description:
				"Target: 'project' (default) for this project's MEMORY.md, 'memory' for the general MEMORY.md (facts true in any task), 'user' for USER.md preferences, or 'okf' for structured project records",
		}),
	),
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

const hotMemoryTarget = Type.Optional(
	Type.Union([Type.Literal("memory"), Type.Literal("project"), Type.Literal("user")]),
);
// Encode action requirements in the advertised schema so the shared tool preflight
// classifies malformed calls as validation failures before invoking the storage adapter.
// Keep an explicit object root: subscription providers reject root-level intersections.
const memorySchema = {
	...memoryFields,
	anyOf: [
		Type.Object({ action: Type.Literal("list") }),
		Type.Object({
			action: Type.Literal("add"),
			target: hotMemoryTarget,
			...Type.Required(Type.Pick(memoryFields, ["content"])).properties,
		}),
		Type.Object({
			action: Type.Literal("replace"),
			target: hotMemoryTarget,
			...Type.Required(Type.Pick(memoryFields, ["content", "oldContent"])).properties,
		}),
		Type.Object({
			action: Type.Literal("remove"),
			target: hotMemoryTarget,
			...Type.Required(Type.Pick(memoryFields, ["oldContent"])).properties,
		}),
		Type.Object({
			action: Type.Literal("add"),
			target: Type.Literal("okf"),
			...Type.Required(Type.Pick(memoryFields, ["type", "title", "description", "scope", "content", "evidenceRefs"]))
				.properties,
		}),
		Type.Object({
			action: Type.Literal("remove"),
			target: Type.Literal("okf"),
			...Type.Required(Type.Pick(memoryFields, ["type", "title"])).properties,
		}),
	],
};

type MemoryParams = Static<typeof memoryFields>;

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

/** The hot-memory file an organize write took its source line from; rollback restores it there. */
export type HotMemoryTarget = "memory" | "project";

export interface StructuredReflectionApplyResult {
	applied: boolean;
	created: boolean;
	digest?: string;
	sourceRemoved?: boolean;
	sourceTarget?: HotMemoryTarget;
	error?: string;
}

export interface StructuredReflectionRollback {
	type: PiOkfType;
	title: string;
	expectedDigest?: string;
	sourceText?: string;
	/** Where `sourceText` came from; absent means the general file (records written before project memory). */
	sourceTarget?: HotMemoryTarget;
	removeRecord: boolean;
}

export const FILE_STORE_MEMORY_SYSTEM_NOTE =
	"[System Note: Below is a snapshot of persistent memory. Record verified reusable facts with the 'memory' tool by scope: target 'memory' = general facts true in any repo or task; target 'project' (the default) = facts true only for this project (paths, tickets, branches, build steps); target 'user' = preferences; target 'okf' = durable structured records (decisions, architecture, findings). A memory write that names a path, ticket key or branch belongs in 'project'. Never store transient noise.]";
const FILE_STORE_MEMORY_TRIAGE_NOTE =
	"[Memory triage: MEMORY.md (general) is over budget; move project-specific lines to target 'project' with memory replace/remove and keep the general lines. Never delete a line you did not move.]";
const MEMORY_DRIFT_RECOVERY =
	"The file was edited outside the managed write protocol. Repeating a mutation cannot reconcile drift and managed-state metadata must not be edited. The operator resolves it: /memory drift lists the managed files, /memory accept <memory|project|user> adopts the on-disk content as the managed revision, /memory restore <target> brings the last managed content back (the drifted file is kept as a backup). Tell the operator which one the edit deserves; do not retry.";
/** Content that reads as project-specific: a ticket key, an absolute or drive path, or a branch. */
const PROJECT_MARKER_RE = /\b[A-Z]{2,}-\d+\b|[A-Za-z]:[\\/]|(?:^|\s)\/[a-z][\w-]*\/|\bbranch\b/;

interface ManagedMemoryState {
	version: 1;
	committedDigest: string;
	pendingDigest?: string;
	/**
	 * The committed content itself, so a managed revision can be restored. Without it a drift lock
	 * had no way out: the state knew the digest of what it expected and nothing else.
	 */
	committedContent?: string;
}

export type ManagedMemoryTarget = "memory" | "project" | "user";

export interface ManagedMemoryDriftEntry {
	target: ManagedMemoryTarget;
	label: string;
	path: string;
	drift: boolean;
	emptyOnDisk: boolean;
	currentChars: number;
	currentDigest: string;
	managedDigest?: string;
	/** Chars of the stored managed content, when the state holds it. */
	managedChars?: number;
	stateStatus: ManagedMemoryStateRead["status"];
}

type ManagedMemoryStateRead =
	| { status: "missing" }
	| { status: "valid"; state: ManagedMemoryState }
	| { status: "invalid"; raw: string };

function contentDigest(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

function memoryFailure(
	error: string,
	text: string,
	details: Record<string, unknown> = {},
): AgentToolResult<Record<string, unknown>> {
	return {
		content: [{ type: "text", text }],
		details: { ...details, success: false, error },
		isError: true,
		errorKind: "operation_outcome",
	};
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
	if (record.committedContent !== undefined && typeof record.committedContent !== "string") return undefined;
	return {
		version: 1,
		committedDigest: record.committedDigest,
		...(typeof record.pendingDigest === "string" ? { pendingDigest: record.pendingDigest } : {}),
		...(typeof record.committedContent === "string" ? { committedContent: record.committedContent } : {}),
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

/** The stored managed content, only when it is really the committed revision (digest agrees). */
function storedManagedContent(state: ManagedMemoryState | undefined): string | undefined {
	if (!state || state.committedContent === undefined) return undefined;
	return contentDigest(state.committedContent) === state.committedDigest ? state.committedContent : undefined;
}

/**
 * A managed file found EMPTY while the state still holds non-empty committed content was truncated
 * outside the protocol (a sync tool, a crash between writes, a stray editor save). Nothing of
 * anyone's is in an empty file, so restoring the managed revision loses nothing and exercises no
 * authority; the alternative was a session-long lock-out on the harness's own memory. Caller holds
 * the content-file lock. Returns the restored content, or undefined when there was nothing to heal.
 */
async function healEmptyManagedFile(filePath: string, statePath: string): Promise<string | undefined> {
	let currentOnDisk: string;
	try {
		currentOnDisk = await fs.readFile(filePath, "utf8");
	} catch (error) {
		if (!isMissingFileError(error)) throw error;
		currentOnDisk = "";
	}
	if (currentOnDisk !== "") return undefined;
	const stateRead = await readManagedMemoryState(statePath);
	if (stateRead.status !== "valid") return undefined;
	const content = storedManagedContent(stateRead.state);
	if (!content) return undefined;
	await writeFileAtomic(filePath, content, { mode: 0o600 });
	return content;
}

/** Caller holds the content-file lock. Inspection never commits a pending state or adopts drift. */
async function inspectManagedMemoryFile(filePath: string, statePath: string) {
	const currentOnDisk = await fs.readFile(filePath, "utf8");
	const currentDigest = contentDigest(currentOnDisk);
	const stateRead = await readManagedMemoryState(statePath);
	const reconciled =
		stateRead.status === "valid" ? reconcileManagedMemoryState(currentDigest, stateRead.state) : undefined;
	// Recognized means the disk holds the committed revision, so the state may learn its content now.
	const managedState = reconciled?.recognized ? { ...reconciled.state, committedContent: currentOnDisk } : undefined;
	const contentLearned =
		reconciled?.recognized === true &&
		(stateRead.status !== "valid" || stateRead.state.committedContent !== currentOnDisk);
	return {
		currentOnDisk,
		managedState,
		stateChanged: (reconciled?.recognized === true && reconciled.changed) || contentLearned,
		revision: {
			currentDigest,
			stateStatus: stateRead.status,
			managedDigest: stateRead.status === "valid" ? stateRead.state.committedDigest : undefined,
			pendingDigest: stateRead.status === "valid" ? stateRead.state.pendingDigest : undefined,
			managedChars: stateRead.status === "valid" ? storedManagedContent(stateRead.state)?.length : undefined,
			drift: reconciled?.recognized !== true,
		},
	};
}

/** The single managed-content commit protocol; caller holds the content-file lock. */
async function commitManagedMemoryContent(
	filePath: string,
	statePath: string,
	managedState: ManagedMemoryState,
	newContent: string,
): Promise<void> {
	const newDigest = contentDigest(newContent);
	await writeManagedMemoryState(statePath, {
		version: 1,
		committedDigest: managedState.committedDigest,
		pendingDigest: newDigest,
		...(managedState.committedContent !== undefined ? { committedContent: managedState.committedContent } : {}),
	});
	await writeFileAtomic(filePath, newContent, { mode: 0o600 });
	await writeManagedMemoryState(statePath, { version: 1, committedDigest: newDigest, committedContent: newContent });
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
	private projectMemoryFilePath = "";
	private memoryStatePath = "";
	private userStatePath = "";
	private projectMemoryStatePath = "";
	private projectKey = "";
	private projectRoot = "";

	private lastWrittenMemory = "";
	private lastWrittenUser = "";
	private lastWrittenProjectMemory = "";
	private readonly healNotices: string[] = [];
	private userArchive?: UserMemoryArchive;
	private okfStore?: OkfProjectMemoryStore;
	private readonly options: FileStoreProviderOptions;

	// Character budgets
	/** The general file holds facts true in any task; project facts have their own file (measured live:
	 * one 2,200-char global file filled with ticket and build facts refused four writes in a row). */
	private static readonly BUDGET_MEMORY = 1200;
	private static readonly BUDGET_PROJECT = 2200;
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
		const identity = getDirectoryResourceProfileInfo(ctx.cwd, ctx.agentDir);
		this.projectKey = identity.hash;
		this.projectRoot = identity.root;
		this.projectMemoryFilePath = join(projectMemoryDir(ctx.agentDir, identity.hash), "MEMORY.md");
		this.projectMemoryStatePath = managedProjectMemoryStateFile(ctx.agentDir, identity.hash);

		await fs.mkdir(ctx.agentDir, { recursive: true });
		await fs.mkdir(projectMemoryDir(ctx.agentDir, identity.hash), { recursive: true });
		this.okfStore = new OkfProjectMemoryStore(ctx.agentDir, ctx.cwd);
		[this.lastWrittenMemory, this.lastWrittenUser, this.lastWrittenProjectMemory] = await Promise.all([
			this.initializeManagedFile(this.memoryFilePath, this.memoryStatePath),
			this.initializeManagedFile(this.userFilePath, this.userStatePath),
			this.initializeManagedFile(this.projectMemoryFilePath, this.projectMemoryStatePath),
		]);
	}

	/** Where this session's project memory lives, for hosts that render or protect it. */
	getProjectMemoryFilePath(): string {
		return this.projectMemoryFilePath;
	}

	/** The general file is over its budget: project lines must move to the project file. */
	generalMemoryOverBudget(): boolean {
		return this.lastWrittenMemory.length > FileStoreProvider.BUDGET_MEMORY;
	}

	private async initializeManagedFile(filePath: string, statePath: string): Promise<string> {
		return withFileLock(filePath, async () => {
			const healed = await healEmptyManagedFile(filePath, statePath);
			if (healed !== undefined) {
				this.healNotices.push(
					`${basename(filePath)} was empty on disk; restored ${healed.length} chars from the managed revision.`,
				);
				return healed;
			}
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
				await writeManagedMemoryState(statePath, {
					version: 1,
					committedDigest: currentDigest,
					committedContent: current,
				});
				return current;
			}
			if (stateRead.status === "invalid") {
				await writeFileAtomic(`${statePath}.bak.${Date.now()}.${randomUUID()}`, stateRead.raw, { mode: 0o600 });
				await writeManagedMemoryState(statePath, {
					version: 1,
					committedDigest: currentDigest,
					committedContent: current,
				});
				return current;
			}

			const reconciled = reconcileManagedMemoryState(currentDigest, stateRead.state);
			if (reconciled.recognized && (reconciled.changed || stateRead.state.committedContent !== current)) {
				await writeManagedMemoryState(statePath, { ...reconciled.state, committedContent: current });
			}
			return current;
		});
	}

	/** Notices the provider produced while repairing its own files; drained by whoever reports them. */
	drainHealNotices(): string[] {
		return this.healNotices.splice(0);
	}

	private managedTargets(): Array<{
		target: ManagedMemoryTarget;
		label: string;
		filePath: string;
		statePath: string;
	}> {
		return [
			{
				target: "memory",
				label: "MEMORY.md (general)",
				filePath: this.memoryFilePath,
				statePath: this.memoryStatePath,
			},
			{
				target: "project",
				label: `MEMORY.md (project ${basename(this.projectRoot) || this.projectKey})`,
				filePath: this.projectMemoryFilePath,
				statePath: this.projectMemoryStatePath,
			},
			{ target: "user", label: "USER.md", filePath: this.userFilePath, statePath: this.userStatePath },
		];
	}

	private setPromptSnapshot(target: ManagedMemoryTarget, content: string): void {
		if (target === "memory") this.lastWrittenMemory = content;
		else if (target === "project") this.lastWrittenProjectMemory = content;
		else this.lastWrittenUser = content;
	}

	/** Read-only report of every managed file's on-disk revision against its managed revision. */
	async driftReport(): Promise<ManagedMemoryDriftEntry[]> {
		if (!this.ctx) return [];
		return Promise.all(
			this.managedTargets().map(({ target, label, filePath, statePath }) =>
				withFileLock(filePath, async () => {
					const { currentOnDisk, revision } = await inspectManagedMemoryFile(filePath, statePath);
					return {
						target,
						label,
						path: filePath,
						drift: revision.drift,
						emptyOnDisk: currentOnDisk === "",
						currentChars: currentOnDisk.length,
						currentDigest: revision.currentDigest,
						...(revision.managedDigest !== undefined ? { managedDigest: revision.managedDigest } : {}),
						...(revision.managedChars !== undefined ? { managedChars: revision.managedChars } : {}),
						stateStatus: revision.stateStatus,
					};
				}),
			),
		);
	}

	/**
	 * Operator authority: adopt the on-disk content as the managed revision. The model has no path
	 * to this; it is the answer to "I edited MEMORY.md by hand and I mean it".
	 */
	async acceptDrift(target: ManagedMemoryTarget): Promise<{ ok: boolean; message: string }> {
		const entry = this.managedTargets().find((candidate) => candidate.target === target);
		if (!entry || !this.ctx) return { ok: false, message: `Unknown memory target ${target}.` };
		return withFileLock(entry.filePath, async () => {
			const { currentOnDisk, revision, managedState } = await inspectManagedMemoryFile(
				entry.filePath,
				entry.statePath,
			);
			if (managedState)
				return { ok: true, message: `${entry.label} is already the managed revision; nothing to accept.` };
			await writeManagedMemoryState(entry.statePath, {
				version: 1,
				committedDigest: revision.currentDigest,
				committedContent: currentOnDisk,
			});
			this.setPromptSnapshot(target, currentOnDisk);
			this.options.onDurableMemoryChanged?.();
			return {
				ok: true,
				message: `${entry.label}: adopted the on-disk content (${currentOnDisk.length} chars) as the managed revision.`,
			};
		});
	}

	/** Operator authority: bring the last managed content back; the drifted file stays as a backup. */
	async restoreManaged(target: ManagedMemoryTarget): Promise<{ ok: boolean; message: string }> {
		const entry = this.managedTargets().find((candidate) => candidate.target === target);
		if (!entry || !this.ctx) return { ok: false, message: `Unknown memory target ${target}.` };
		return withFileLock(entry.filePath, async () => {
			const { currentOnDisk, revision, managedState } = await inspectManagedMemoryFile(
				entry.filePath,
				entry.statePath,
			);
			if (managedState)
				return { ok: true, message: `${entry.label} already holds the managed revision; nothing to restore.` };
			const stateRead = await readManagedMemoryState(entry.statePath);
			const content = stateRead.status === "valid" ? storedManagedContent(stateRead.state) : undefined;
			if (content === undefined) {
				return {
					ok: false,
					message: `${entry.label}: the managed revision's content is not stored (state ${revision.stateStatus}); /memory accept ${target} is the only way forward.`,
				};
			}
			if (currentOnDisk !== "") {
				const backupPath = `${entry.filePath}.bak.sha256-${revision.currentDigest}`;
				await writeFileAtomic(backupPath, currentOnDisk, { mode: 0o600 });
			}
			await writeFileAtomic(entry.filePath, content, { mode: 0o600 });
			this.setPromptSnapshot(target, content);
			this.options.onDurableMemoryChanged?.();
			return {
				ok: true,
				message: `${entry.label}: restored the managed revision (${content.length} chars)${currentOnDisk !== "" ? "; the drifted content is kept beside it as a backup" : ""}.`,
			};
		});
	}

	public systemPromptBlock(budget?: MemoryPromptBudget): string {
		if (this.ctx?.isChildSession) return "";
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
		const proj = cap(sanitize(this.lastWrittenProjectMemory), FileStoreProvider.BUDGET_PROJECT);
		const usr = cap(sanitize(this.lastWrittenUser), FileStoreProvider.BUDGET_USER);

		const blocks: string[] = [];
		if (mem.trim()) {
			blocks.push(`## MEMORY.md (general):\n${mem}`);
		}
		if (proj.trim()) {
			blocks.push(`## MEMORY.md (project ${basename(this.projectRoot) || this.projectKey}):\n${proj}`);
		}
		if (usr.trim()) {
			blocks.push(`## USER.md:\n${usr}`);
		}

		if (blocks.length === 0) {
			return "";
		}

		const triage = this.generalMemoryOverBudget() ? `\n${FILE_STORE_MEMORY_TRIAGE_NOTE}` : "";
		const block = `=== Persistent Memory (file-store) ===\n${FILE_STORE_MEMORY_SYSTEM_NOTE}${triage}\n\n${blocks.join("\n\n")}`;
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

	/** Hot files an organize write may cite, project first: a project fact is the common case. */
	private hotMemoryFiles(): { target: HotMemoryTarget; filePath: string; statePath: string }[] {
		return [
			{ target: "project", filePath: this.projectMemoryFilePath, statePath: this.projectMemoryStatePath },
			{ target: "memory", filePath: this.memoryFilePath, statePath: this.memoryStatePath },
		];
	}

	private async hasExactHotMemoryItem(sourceText: string): Promise<boolean> {
		for (const file of this.hotMemoryFiles()) {
			const found = await withFileLock(file.filePath, async () => {
				const current = await fs.readFile(file.filePath, "utf8");
				return removeExactHotMemoryItem(current, sourceText) !== undefined;
			});
			if (found) return true;
		}
		return false;
	}

	/** Removes the exact item from the first hot file that holds it and names that file. */
	private async removeExactHotMemoryItem(
		sourceText: string,
	): Promise<{ success: boolean; target?: HotMemoryTarget; error?: string }> {
		let lastError: string | undefined;
		for (const file of this.hotMemoryFiles()) {
			const removed = await this.removeExactHotMemoryItemFrom(file, sourceText);
			if (removed.success) return { success: true, target: file.target };
			// Only "not found here" moves on to the next file; drift or a write failure stops here.
			if (removed.error !== "Exact hot-memory item was not found") return removed;
			lastError = removed.error;
		}
		return { success: false, error: lastError ?? "Exact hot-memory item was not found" };
	}

	private async removeExactHotMemoryItemFrom(
		file: { target: HotMemoryTarget; filePath: string; statePath: string },
		sourceText: string,
	): Promise<{ success: boolean; error?: string }> {
		try {
			return await withFileLock(file.filePath, async () => {
				const { currentOnDisk, managedState } = await inspectManagedMemoryFile(file.filePath, file.statePath);
				if (!managedState) return { success: false, error: "Drift detected" };

				const newContent = removeExactHotMemoryItem(currentOnDisk, sourceText);
				if (newContent === undefined) return { success: false, error: "Exact hot-memory item was not found" };
				await commitManagedMemoryContent(file.filePath, file.statePath, managedState, newContent);
				if (file.target === "project") this.lastWrittenProjectMemory = newContent;
				else this.lastWrittenMemory = newContent;
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
			...(removed.target ? { sourceTarget: removed.target } : {}),
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
				{ action: "add", target: rollback.sourceTarget ?? "memory", content: rollback.sourceText },
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
		if (this.ctx?.isChildSession) return [];
		return [
			{
				name: ROOT_MEMORY_TOOL_NAME,
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
					const {
						action,
						target: requestedTarget,
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
					const target = requestedTarget ?? "project";

					// Strict-scope injection guard on the high-privilege WRITE path (agy #31): a poisoned
					// memory entry persists across sessions and is injected into every future system prompt,
					// so block outright rather than strip. Hidden/bidi-control chars have no legitimate place
					// in a memory note, so reject those too.
					if ((action === "add" || action === "replace") && content !== undefined) {
						if (hasInvisibleUnicode(content)) {
							return memoryFailure(
								"Invisible unicode in memory write",
								"Error: memory write rejected — contains hidden/bidirectional control characters.",
							);
						}
						const threats = scanContextFileThreats(content, "strict");
						if (threats.length > 0) {
							return memoryFailure(
								"Threat in memory write",
								`Error: memory write rejected — potential injection/exfiltration detected (${threats.join(", ")}).`,
							);
						}
					}

					if (target === "okf") {
						if (action === "list") {
							if (this.okfStore === undefined) {
								return memoryFailure(
									"Memory provider is not initialized",
									"Error: Memory provider is not initialized.",
								);
							}
							const catalog = this.okfStore.list();
							return {
								content: [{ type: "text", text: catalog || "No structured OKF memory records found." }],
								details: { success: true },
							};
						}
						if (action !== "add" && action !== "remove") {
							return memoryFailure(
								"Unsupported OKF action",
								"Error: structured OKF memory only supports action 'add' or 'remove'.",
							);
						}
						if (action === "remove") {
							if (
								this.okfStore === undefined ||
								type === undefined ||
								title === undefined ||
								!PI_OKF_TYPES.includes(type as PiOkfType)
							) {
								return memoryFailure(
									"Incomplete OKF removal",
									"Error: OKF removal requires a valid type and title.",
								);
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
								return memoryFailure(
									/ENOENT/.test(error) ? "not found" : error,
									`Error: Failed to remove structured OKF memory: ${error}`,
								);
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
							return memoryFailure(
								"Incomplete OKF memory",
								"Error: structured OKF memory requires type, title, description, scope, content, and evidenceRefs.",
							);
						}
						if (!PI_OKF_TYPES.includes(type as PiOkfType)) {
							return memoryFailure("Unsupported OKF type", `Error: unsupported OKF type '${type}'.`);
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
							return memoryFailure(
								"Invalid OKF memory",
								`Error: Invalid structured OKF memory: ${validationErrors.join("; ")}`,
							);
						}
						const okfText = [type, title, description, scope, content, ...(tags ?? []), ...evidenceRefs].join(
							"\n",
						);
						if (hasInvisibleUnicode(okfText)) {
							return memoryFailure(
								"Invisible unicode in OKF write",
								"Error: OKF write rejected — contains hidden/bidirectional control characters.",
							);
						}
						const threats = scanContextFileThreats(okfText, "strict");
						if (threats.length > 0) {
							return memoryFailure(
								"Threat in OKF write",
								`Error: OKF write rejected — potential injection/exfiltration detected (${threats.join(", ")}).`,
							);
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
							return memoryFailure(String(err), `Error: Failed to write structured OKF memory: ${String(err)}`);
						}
					}
					if (action === "list") {
						const rows = [
							[
								"memory",
								"MEMORY.md (general)",
								this.memoryFilePath,
								this.memoryStatePath,
								FileStoreProvider.BUDGET_MEMORY,
							],
							[
								"project",
								`MEMORY.md (project ${basename(this.projectRoot) || this.projectKey})`,
								this.projectMemoryFilePath,
								this.projectMemoryStatePath,
								FileStoreProvider.BUDGET_PROJECT,
							],
							["user", "USER.md", this.userFilePath, this.userStatePath, FileStoreProvider.BUDGET_USER],
						] as const;
						try {
							const files = await Promise.all(
								rows
									.filter(([scope]) => requestedTarget === undefined || scope === requestedTarget)
									.map(async ([target, label, filePath, statePath, budgetChars]) =>
										withFileLock(filePath, async () => {
											const { currentOnDisk, revision } = await inspectManagedMemoryFile(
												filePath,
												statePath,
											);
											const prompt =
												target === "memory"
													? this.lastWrittenMemory
													: target === "project"
														? this.lastWrittenProjectMemory
														: this.lastWrittenUser;
											const promptDigest = contentDigest(prompt);
											const revisionText = `Current revision: ${revision.currentDigest}; managed revision: ${revision.managedDigest ?? revision.stateStatus}; pending revision: ${revision.pendingDigest ?? "none"}; prompt snapshot: ${promptDigest}.`;
											return {
												text: `## ${label} (${currentOnDisk.length}/${budgetChars} chars)\n${revisionText}\n${revision.drift ? `Drift detected. ${MEMORY_DRIFT_RECOVERY}\n` : ""}${currentOnDisk.trim() || "(empty)"}`,
												details: {
													target,
													path: filePath,
													...revision,
													promptDigest,
													currentChars: currentOnDisk.length,
													budgetChars,
												},
											};
										}),
									),
							);
							return {
								content: [{ type: "text", text: files.map((file) => file.text).join("\n\n") }],
								details: { success: true, files: files.map((file) => file.details) },
							};
						} catch (error) {
							return memoryFailure(String(error), `Error: Failed to inspect current memory: ${String(error)}`);
						}
					}

					const fileLabel =
						target === "memory"
							? "MEMORY.md (general)"
							: target === "project"
								? "MEMORY.md (project)"
								: "USER.md";
					const filePath =
						target === "memory"
							? this.memoryFilePath
							: target === "project"
								? this.projectMemoryFilePath
								: this.userFilePath;
					const statePath =
						target === "memory"
							? this.memoryStatePath
							: target === "project"
								? this.projectMemoryStatePath
								: this.userStatePath;
					const budget =
						target === "memory"
							? FileStoreProvider.BUDGET_MEMORY
							: target === "project"
								? FileStoreProvider.BUDGET_PROJECT
								: FileStoreProvider.BUDGET_USER;
					// A hint, never a reroute: the model decides, the harness names the better target.
					const projectHint =
						target === "memory" &&
						(action === "add" || action === "replace") &&
						content !== undefined &&
						PROJECT_MARKER_RE.test(content)
							? '\nhint: this looks project-specific; consider target "project".'
							: "";

					try {
						return await withFileLock(filePath, async () => {
							const healed = await healEmptyManagedFile(filePath, statePath);
							if (healed !== undefined)
								this.healNotices.push(
									`${basename(filePath)} was empty on disk; restored ${healed.length} chars from the managed revision.`,
								);
							const { currentOnDisk, managedState, stateChanged, revision } = await inspectManagedMemoryFile(
								filePath,
								statePath,
							);
							if (!managedState) {
								// Same observed bytes reuse one backup; distinct revisions are preserved for owner review.
								const backupPath = `${filePath}.bak.sha256-${revision.currentDigest}`;
								try {
									const backup = await fs.readFile(backupPath, "utf8");
									if (backup !== currentOnDisk)
										throw new Error(`Drift backup content conflicts at ${backupPath}.`);
								} catch (error) {
									if (!isMissingFileError(error)) throw error;
									await writeFileAtomic(backupPath, currentOnDisk, { mode: 0o600 });
								}
								return memoryFailure(
									"Drift detected",
									`Error: Drift detected. Current memory does not match a managed revision (state: ${revision.stateStatus}). Current revision: ${revision.currentDigest}; managed revision: ${revision.managedDigest ?? "unavailable"}${revision.managedChars !== undefined ? ` (${revision.managedChars} chars stored, restorable)` : " (content not stored; only accept can resolve)"}. Backup retained at ${backupPath}. Operation aborted. ${MEMORY_DRIFT_RECOVERY}`,
									{ ...revision, backupPath },
								);
							}
							if (stateChanged) await writeManagedMemoryState(statePath, managedState);

							// A peer session's committed write is authoritative. Refresh this provider's prompt
							// snapshot before applying the caller's mutation to that current content.
							if (target === "memory") this.lastWrittenMemory = currentOnDisk;
							else if (target === "project") this.lastWrittenProjectMemory = currentOnDisk;
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

							const overBudget = newContent.length > budget;
							if (overBudget && newContent.length >= currentOnDisk.length) {
								return memoryFailure(
									"Memory budget exceeded",
									`Error: Memory budget exceeded. ${fileLabel} limit is ${budget} characters. Current operation would result in ${newContent.length} characters. Remove or shorten an existing line first; already-over-budget content must strictly shrink on each repair.`,
								);
							}

							if (newContent !== currentOnDisk) {
								await commitManagedMemoryContent(filePath, statePath, managedState, newContent);
							}

							if (target === "memory") this.lastWrittenMemory = newContent;
							else if (target === "project") this.lastWrittenProjectMemory = newContent;
							else this.lastWrittenUser = newContent;
							if (archiveChanged || newContent !== currentOnDisk) this.options.onDurableMemoryChanged?.();

							return {
								content: [
									{
										type: "text",
										text: `Successfully updated ${fileLabel}.${projectHint}${overBudget ? `\nMemory is still over budget (${newContent.length}/${budget} chars); continue removing or shortening migrated facts.` : ""}`,
									},
								],
								details: { success: true, overBudget, currentChars: newContent.length, budgetChars: budget },
							};
						});
					} catch (err) {
						return memoryFailure(String(err), `Error: Failed to perform memory operation: ${String(err)}`);
					}
				},
			},
		];
	}
}
