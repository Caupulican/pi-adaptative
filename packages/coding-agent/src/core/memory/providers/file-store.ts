import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { TRANSIENT_RECORD_SUPERSEDING_NOTE } from "@caupulican/pi-agent-core";
import { type Static, Type } from "typebox";
import {
	configFile,
	managedMemoryStateFile,
	managedProjectMemoryStateFile,
	projectMemoryDir,
} from "../../agent-paths.ts";
import { estimateTokensFromText } from "../../context/context-item.ts";
import type { MemoryPromptBudget } from "../../context/memory-prompt-budget.ts";
import { memoryTextFitsBudget } from "../../context/memory-prompt-budget.ts";
import {
	OKF_MEMORY_LIMITS,
	PI_OKF_TYPES,
	type PiOkfType,
	validateOkfMemoryDocumentInput,
} from "../../context/okf-memory.ts";
import type { AgentToolResult, ToolDefinition } from "../../extensions/types.ts";
import { PERSONA_PROJECTION_RULE } from "../../provider-prompt-contracts.ts";
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
import {
	collectUserPreferenceEntries,
	formatUserPreferenceLine,
	formatUserPreferenceScope,
	isUserPreferenceApplicable,
	newUserPreferenceId,
	type ParsedUserPreferenceLine,
	parseUserPreferenceLine,
	parseUserPreferenceScope,
	renderUserPreferenceForPrompt,
	sameUserPreferenceScope,
	stripUserPreferenceMetadata,
	type UserPreferenceAdmissionRequest,
	type UserPreferenceAdmissionResult,
	type UserPreferenceCommitReport,
	type UserPreferenceEvidenceCitation,
	type UserPreferenceMetadata,
	type UserPreferenceScope,
} from "../user-preference-metadata.ts";
import { ROOT_MEMORY_TOOL_NAME } from "../worker-memory-tools.ts";
import { USER_ARCHIVE_POINTER, UserMemoryArchive } from "./user-memory-archive.ts";

const NEAR_DUP_THRESHOLD = 0.6;

/**
 * Confront-before-write (anti append-rot): if `content` is a near-duplicate of an existing
 * non-empty line (token Jaccard ≥ threshold — i.e. the same fact reworded), supersede that line in
 * place and return the rewritten file; otherwise return null (the caller appends normally).
 */
export function supersedeNearDuplicateLine(existing: string, content: string): string | null {
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
	scope: Type.Optional(
		Type.Union([Type.Literal("project"), Type.Literal("global")], {
			description:
				"Structured OKF records are project-scoped. For target 'user': 'global' (default) applies everywhere, 'project' only inside this repository",
		}),
	),
	basis: Type.Optional(
		Type.Union([Type.Literal("explicit"), Type.Literal("inferred")], {
			description:
				"Target 'user' only: 'explicit' when the owner's own cited words ask for the preference, otherwise 'inferred'",
		}),
	),
	evidence: Type.Optional(
		Type.Array(
			Type.Object({
				source: Type.String({
					minLength: 1,
					maxLength: 96,
					description: "Owner evidence source id from the reflection cue",
				}),
				quote: Type.Optional(Type.String({ minLength: 1, maxLength: 400, description: "Verbatim owner words" })),
			}),
			{ maxItems: 16, description: "Target 'user' only: owner sources supporting the preference" },
		),
	),
	expectedRevision: Type.Optional(
		Type.Integer({ minimum: 1, description: "Target 'user' replace/remove: the revision the write is based on" }),
	),
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
// Keep an explicit object root and parent properties for subscription-provider projection.
const memorySchema = {
	...memoryFields,
	// Evidence has different authority in each target. Reject a misplaced citation instead
	// of silently passing an empty evidence set to USER admission or discarding it from OKF.
	allOf: [
		{
			if: Type.Object({ target: Type.Literal("user") }),
			else: Type.Object({ evidence: Type.Optional(Type.Never()) }),
		},
		{
			if: Type.Object({ target: Type.Literal("okf") }),
			else: Type.Object({ evidenceRefs: Type.Optional(Type.Never()) }),
		},
	],
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
	/**
	 * Admission for a USER.md preference write (the reflection controller). Absent in narrow hosts:
	 * the write then lands labelled `unverified`, never as an evidence-backed fact.
	 */
	admitUserPreference?: (request: UserPreferenceAdmissionRequest) => Promise<UserPreferenceAdmissionResult>;
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

/**
 * Tail of the read-time omitted-fact note. The prompt view selects WHOLE fact lines and counts the
 * rest: nothing is cut mid-line, so a reader is told what is missing rather than shown a fragment.
 * Exported so a consumer pins this contract instead of a copied literal.
 */
export const MEMORY_OMITTED_FACTS_NOTE = "not shown within this model's approximate token budget";

export const FILE_STORE_MEMORY_SYSTEM_NOTE =
	"[System Note: Below is a snapshot of persistent memory. Record verified reusable facts with the 'memory' tool by scope: target 'memory' = general facts true in any repo or task; target 'project' (the default) = facts true only for this project (paths, tickets, branches, build steps); target 'user' = preferences; target 'okf' = durable structured records (decisions, architecture, findings). A memory write that names a path, ticket key or branch belongs in 'project'. Never store transient noise.]";
/** Generous UTF-8 byte safety ceiling for stored memory files; rejects only resource-overflow writes. */
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

/**
 * A fact the provider learned about a managed file while starting or repairing it, drained by the
 * memory controller and reported once per target and revision through the session warning path.
 */
export interface ManagedMemoryNotice {
	target: ManagedMemoryTarget;
	kind: "healed" | "drift";
	/** Digest of the on-disk content the notice describes; the dedupe key beside target and kind. */
	revision: string;
	message: string;
}

/** The current USER.md working preferences, ready for one provider request (see `userPersonaProjection`). */
export interface UserPersonaProjection {
	/** Short digest of the current USER.md preference lines. */
	revision: string;
	/** True when the current preferences differ from what the installed static block renders. */
	changed: boolean;
	/**
	 * When `changed`: the bounded record text, or undefined when not even a one-line record fits the
	 * budget. When unchanged: the text that clears an earlier record (only recorded over one).
	 */
	content: string | undefined;
}

/** How much of USER.md the installed static block renders: everything, a truncated head, or nothing. */
type FrozenUserCoverage = "full" | "partial" | "omitted";

export const USER_PERSONA_CUSTOM_TYPE = "user_persona";
const USER_SECTION_HEADER = "## USER.md:";

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
	private readonly managedNotices: ManagedMemoryNotice[] = [];
	/** USER.md as the installed static block renders it; undefined until the block is first frozen. */
	private frozenUser: { content: string; coverage: FrozenUserCoverage } | undefined;
	/** Trimmed MEMORY.md lines from the installed frozen static prompt block; undefined before freeze/reset. */
	private frozenPromptLines: ReadonlySet<string> | undefined;
	/** Preference lines held by the USER archive shards (with their heading context), refreshed at init and after any archive change. */
	private archivedUserEntries: Array<{ line: string; section?: string }> = [];
	private userArchive?: UserMemoryArchive;
	private okfStore?: OkfProjectMemoryStore;
	private readonly options: FileStoreProviderOptions;

	/**
	 * Prompt allocation budgets: estimated-token caps for prompt views.
	 * Storage capacity is governed by RESOURCE_CEILING (512000 UTF-8 bytes).
	 * USER retains a chars quota (1375) for write-admission compatibility.
	 */
	public static readonly BUDGET_MEMORY = { tokens: 300 };
	public static readonly BUDGET_PROJECT = { tokens: 550 };
	public static readonly BUDGET_USER = { tokens: 344, chars: 1375 };
	/** Generous UTF-8 byte resource ceiling for stored memory files; rejects only resource-overflow writes. */
	public static readonly RESOURCE_CEILING = 512_000;

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
			this.initializeManagedFile("memory", this.memoryFilePath, this.memoryStatePath),
			this.initializeManagedFile("user", this.userFilePath, this.userStatePath),
			this.initializeManagedFile("project", this.projectMemoryFilePath, this.projectMemoryStatePath),
		]);
		this.frozenUser = undefined;
		this.frozenPromptLines = undefined;
		await this.refreshArchivedUserLines();
	}

	private async refreshArchivedUserLines(): Promise<void> {
		try {
			this.archivedUserEntries = this.userArchive ? await this.userArchive.archivedEntries() : [];
		} catch {
			this.archivedUserEntries = [];
		}
	}

	/** Where this session's project memory lives, for hosts that render or protect it. */
	getProjectMemoryFilePath(): string {
		return this.projectMemoryFilePath;
	}

	/**
	 * Compatibility alias: documented as prompt overflow, not storage capacity.
	 * With the resource-separation design, the general file is no longer capped
	 * the prompt view selects whole fact lines under the
	 * approximate token budget. Returns true when the general file content
	 * exceeds the approximate token budget for the prompt view.
	 */
	generalMemoryOverBudget(): boolean {
		return estimateTokensFromText(this.lastWrittenMemory) > FileStoreProvider.BUDGET_MEMORY.tokens;
	}

	private async initializeManagedFile(
		target: ManagedMemoryTarget,
		filePath: string,
		statePath: string,
	): Promise<string> {
		return withFileLock(filePath, async () => {
			const healed = await healEmptyManagedFile(filePath, statePath);
			if (healed !== undefined) {
				this.managedNotices.push({
					target,
					kind: "healed",
					revision: contentDigest(healed),
					message: `${basename(filePath)} was empty on disk; restored ${healed.length} chars from the managed revision.`,
				});
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
			if (!reconciled.recognized) {
				// Drift is fenced, never adopted: the on-disk bytes are rendered as they are and every
				// write to this target is refused until the operator decides. The notice is the
				// operator's only signal; the refusal itself surfaces only inside the model's tool errors.
				const stored = storedManagedContent(stateRead.state);
				this.managedNotices.push({
					target,
					kind: "drift",
					revision: currentDigest,
					message: `${basename(filePath)} differs from its managed revision (on disk ${currentDigest.slice(0, 8)}, managed ${stateRead.state.committedDigest.slice(0, 8)}${stored === undefined ? ", managed content not stored" : ""}); writes to memory target '${target}' are refused until /memory accept ${target} adopts the file${stored === undefined ? "" : ` or /memory restore ${target} brings the managed content back`}.`,
				});
			}
			return current;
		});
	}

	/** Notices the provider produced while starting or repairing its files; drained by whoever reports them. */
	drainManagedNotices(): ManagedMemoryNotice[] {
		return this.managedNotices.splice(0);
	}

	/**
	 * The memory manager is installing `renderedBlock` as the static system-prompt block. From here
	 * on `userPersonaProjection` measures USER.md against what that block renders: everything, a
	 * truncated head (a constrained budget kept only the top of the block), or nothing (a compact
	 * budget omitted the block). Cached reads with another budget never call this.
	 */
	onSystemPromptBlockFrozen(renderedBlock: string): void {
		if (this.ctx?.isChildSession) return;
		const selection = this.selectApplicablePreferenceLines();
		const usr = selection.text;
		const content = selection.kept.join("\n");
		let coverage: FrozenUserCoverage = "full";
		if (usr.trim()) {
			if (!renderedBlock.includes(FileStoreProvider.userSection(usr))) {
				coverage = renderedBlock.includes(USER_SECTION_HEADER) ? "partial" : "omitted";
			}
		}
		this.frozenUser = { content, coverage };
		const lines = new Set<string>();
		let inMemorySection = false;
		for (const line of renderedBlock.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.startsWith("## MEMORY.md")) {
				inMemorySection = true;
				continue;
			}
			if (trimmed.startsWith("## ")) {
				inMemorySection = false;
				continue;
			}
			if (inMemorySection && trimmed.length > 0 && !trimmed.startsWith("[")) {
				lines.add(trimmed);
			}
		}
		this.frozenPromptLines = lines;
	}

	/** Returns the trimmed MEMORY.md lines from the installed frozen static prompt block, or undefined before freeze/reset. */
	getFrozenPromptLines(): ReadonlySet<string> | undefined {
		return this.frozenPromptLines;
	}

	/**
	 * USER.md as the next provider request should see it. `changed` compares the current committed
	 * preference lines (kept in memory by every write, accept and restore; never re-read from disk
	 * here) with the lines the installed static block renders: none when that block omitted or
	 * truncated USER.md. The record text carries the projection rule and the current lines, bounded
	 * to whole lines within the memory prompt budget (the planner's superseding note counts against
	 * it), or says that USER.md is empty so a removed preference cannot be resurrected by the static
	 * block. When nothing changed, `content` is the text that clears an earlier record. Child
	 * sessions have no persona projection.
	 */
	userPersonaProjection(budget?: MemoryPromptBudget): UserPersonaProjection | undefined {
		if (!this.ctx || this.ctx.isChildSession) return undefined;
		const currentLines = this.selectApplicablePreferenceLines().kept;
		const current = currentLines.join("\n");
		const revision = contentDigest(current).slice(0, 8);
		const frozen = this.frozenUser ?? { content: "", coverage: "omitted" as const };
		const frozenRendered =
			frozen.coverage === "full" ? FileStoreProvider.preferenceLines(frozen.content).join("\n") : "";
		if (current === frozenRendered) {
			const cleared =
				current === ""
					? `USER PERSONA: USER.md is empty (revision ${revision}); no standing preferences apply and earlier persona records are stale.`
					: `USER PERSONA: the USER.md section of the static memory block is current again (revision ${revision}); earlier persona records are stale. ${PERSONA_PROJECTION_RULE}`;
			return {
				revision,
				changed: false,
				content: FileStoreProvider.fitsPersonaBudget(cleared, budget) ? cleared : undefined,
			};
		}
		if (currentLines.length === 0) {
			const empty = `USER PERSONA (USER.md revision ${revision}): USER.md is empty; no standing preferences apply and the USER.md section of the static memory block is superseded. ${PERSONA_PROJECTION_RULE}`;
			return {
				revision,
				changed: true,
				content: FileStoreProvider.fitsPersonaBudget(empty, budget) ? empty : undefined,
			};
		}
		const header = [
			`USER PERSONA (USER.md revision ${revision}): ${PERSONA_PROJECTION_RULE}`,
			frozen.coverage === "omitted"
				? "The static memory block carries no USER.md section on this model; these are the current preferences."
				: "This record supersedes the USER.md section of the static memory block.",
		];
		return { revision, changed: true, content: FileStoreProvider.boundPersonaRecord(header, currentLines, budget) };
	}

	/** Non-empty, trimmed, threat-sanitized USER.md lines: the unit a preference is compared and delivered in. */
	private static preferenceLines(content: string): string[] {
		return FileStoreProvider.sanitizeMemory(content)
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
	}

	/**
	 * The write-side allowance every USER.md projection shares when no model budget applies: the same
	 * token cap `selectApplicablePreferenceLines` spends on preference lines, with storage as the byte
	 * ceiling. One owner, so the read and write sides cannot drift apart.
	 */
	private static personaWriteAllowance(): MemoryPromptBudget {
		return {
			enabled: true,
			compact: false,
			maxLines: 20,
			maxEstimatedTokens: FileStoreProvider.BUDGET_USER.tokens,
			maxChars: FileStoreProvider.RESOURCE_CEILING,
			maxResults: 10,
		};
	}

	/**
	 * Does a persona record fit? A MODEL budget must cover everything actually sent, so `content`
	 * plus the planner's superseding note is charged against it in full.
	 *
	 * Without a model budget the write-side allowance applies to `measured` — the preference lines
	 * alone for a bounded record. The header, the omitted-count note and the superseding note are
	 * harness framing, and charging them against the same BUDGET_USER.tokens the write side spends on
	 * lines alone made a legally written USER.md unprojectable: ten 103-char preferences are 258
	 * estimated tokens (accepted by the write path) but 379 once framed, so the record silently
	 * dropped to seven lines and claimed the rest were over budget.
	 */
	private static fitsPersonaBudget(
		content: string,
		budget: MemoryPromptBudget | undefined,
		measured: string = content,
	): boolean {
		if (budget === undefined) return memoryTextFitsBudget(measured, FileStoreProvider.personaWriteAllowance());
		return memoryTextFitsBudget(`${content}${TRANSIENT_RECORD_SUPERSEDING_NOTE}`, budget);
	}

	/**
	 * Whole preference lines only, in file order, as many as the budget admits after the header;
	 * a line never appears cut in half as a misleading partial instruction. Omitted lines are
	 * counted so the model knows USER.md holds more. Without a budget the write-side cap applies.
	 */
	private static boundPersonaRecord(
		header: string[],
		lines: string[],
		budget: MemoryPromptBudget | undefined,
	): string | undefined {
		const omittedNote = (count: number) =>
			`(${count} more preference line${count === 1 ? "" : "s"} on disk; not shown within this model's memory budget)`;
		const noneNote = (count: number) =>
			`(USER.md holds ${count} preference line${count === 1 ? "" : "s"} that exceed this model's memory budget; read USER.md when preferences matter.)`;
		const render = (kept: string[]) =>
			[
				...header,
				...kept,
				...(kept.length < lines.length
					? [kept.length === 0 ? noneNote(lines.length) : omittedNote(lines.length - kept.length)]
					: []),
			].join("\n");
		for (let keep = lines.length; keep >= 0; keep--) {
			const kept = lines.slice(0, keep);
			const candidate = render(kept);
			// Framing counts against a model budget and never against the write-side allowance.
			if (FileStoreProvider.fitsPersonaBudget(candidate, budget, kept.join("\n"))) return candidate;
		}
		return undefined;
	}

	/** The USER.md section of the static block, headed by the projection rule. */
	private static userSection(renderedUser: string): string {
		return `${USER_SECTION_HEADER}\n${PERSONA_PROJECTION_RULE}\n${renderedUser}`;
	}

	/** Preference lines of a USER.md body with the heading path each sits under; blanks and the archive pointer skipped. */
	private static activePreferenceEntries(content: string): Array<{ line: string; section?: string }> {
		const body = content.startsWith(USER_ARCHIVE_POINTER) ? content.slice(USER_ARCHIVE_POINTER.length) : content;
		return collectUserPreferenceEntries(body);
	}

	/** Every preference this session can see (active file plus archive shards), parsed, in file order. */
	private allPreferences(): Array<{ parsed: ParsedUserPreferenceLine; section?: string }> {
		return [...FileStoreProvider.activePreferenceEntries(this.lastWrittenUser), ...this.archivedUserEntries].map(
			(entry) => ({
				parsed: parseUserPreferenceLine(entry.line),
				...(entry.section ? { section: entry.section } : {}),
			}),
		);
	}

	/** Host-checked applicability: global lines plus the lines scoped to this project's key. */
	private applicablePreferences(): Array<{ parsed: ParsedUserPreferenceLine; section?: string }> {
		return this.allPreferences().filter((entry) =>
			isUserPreferenceApplicable(entry.parsed.metadata, this.projectKey),
		);
	}

	/**
	 * Whole lines within a token/char bound, framing included: as many leading lines as fit
	 * beside the footer that counts the rest. A line is never cut in half into a misleading partial
	 * instruction; the caller sees exactly which lines were kept.
	 */
	private static selectWholeLines(
		lines: readonly string[],
		budget: MemoryPromptBudget,
		framing: { header?: string; footer: (omitted: number) => string },
	): { kept: string[]; omitted: number; text: string } {
		const maxKeep = Math.min(lines.length, budget.maxLines);
		for (let keep = maxKeep; keep >= 0; keep--) {
			const omitted = lines.length - keep;
			const parts = [
				...(framing.header ? [framing.header] : []),
				...lines.slice(0, keep),
				...(omitted > 0 ? [framing.footer(omitted)] : []),
			];
			const text = parts.join("\n");
			if (memoryTextFitsBudget(text, budget)) return { kept: lines.slice(0, keep), omitted, text };
		}
		return { kept: [], omitted: lines.length, text: "" };
	}

	private static preferenceFooter(omitted: number): string {
		return `(${omitted} more preference line${omitted === 1 ? "" : "s"} in USER.md)`;
	}

	/**
	 * The one selection every USER.md projection shares (static block, worker snapshot, persona
	 * record): applicable preferences as sanitized prompt lines with an honest strength label,
	 * trailers removed, whole lines within the write budget, the rest counted.
	 */
	private selectApplicablePreferenceLines(): { kept: string[]; omitted: number; text: string } {
		const rendered = this.applicablePreferences()
			.map((entry) => renderUserPreferenceForPrompt(entry.parsed, entry.section))
			.join("\n");
		const lines = rendered.length === 0 ? [] : FileStoreProvider.sanitizeMemory(rendered).split("\n");
		return FileStoreProvider.selectWholeLines(lines, FileStoreProvider.personaWriteAllowance(), {
			footer: FileStoreProvider.preferenceFooter,
		});
	}

	/** The USER.md text of the static block: the selected whole lines plus the footer when lines were left out. */
	private renderUserMemory(): string {
		return this.selectApplicablePreferenceLines().text;
	}

	/**
	 * Applicable owner working preferences for a handoff: the rule, then explicit, well-supported
	 * inferred (two or more independent observations) and legacy lines, whole lines within a fixed
	 * bound. Unverified and single-observation inferred lines stay out of a handoff.
	 */
	getHandoffPersonaGuidance(): string | undefined {
		if (!this.ctx || this.ctx.isChildSession) return undefined;
		const lines = this.applicablePreferences()
			.filter(
				({ parsed }) =>
					parsed.metadata === undefined ||
					parsed.metadata.basis === "explicit" ||
					(parsed.metadata.basis === "inferred" && parsed.metadata.observations >= 2),
			)
			.map((entry) => renderUserPreferenceForPrompt(entry.parsed, entry.section));
		if (lines.length === 0) return undefined;
		const header = `OWNER WORKING PREFERENCES (guidance, not grants): ${PERSONA_PROJECTION_RULE}`;
		const selection = FileStoreProvider.selectWholeLines(
			FileStoreProvider.sanitizeMemory(lines.join("\n")).split("\n"),
			{
				enabled: true,
				compact: false,
				maxLines: 20,
				maxEstimatedTokens: 200,
				maxChars: FileStoreProvider.RESOURCE_CEILING,
				maxResults: 5,
			},
			{ header, footer: FileStoreProvider.preferenceFooter },
		);
		// Header and footer count against the bound; with no room for even one line there is no guidance.
		return selection.kept.length > 0 ? selection.text : undefined;
	}

	private static sanitizeMemory(content: string): string {
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
	}

	/** The note that counts fact lines the prompt view left on disk; one owner for every read-time cap. */
	private static factFooter(omitted: number): string {
		return `(${omitted} more fact line${omitted === 1 ? "" : "s"} on disk; ${MEMORY_OMITTED_FACTS_NOTE})`;
	}

	// Read-time budget guard (cost): the memory tool already caps writes at BUDGET_*, but a file edited
	// externally (or by any path that bypasses the tool) could be arbitrarily large and would then
	// bloat the system prompt on EVERY turn. Cap the injected view to the same budget so the per-turn
	// cost stays bounded; the file on disk is untouched and the omitted lines are counted for the model.
	// Reuses selectWholeLines when practical; never truncates mid-line.
	private static selectWholeFacts(content: string, budget: MemoryPromptBudget): { text: string; omitted: number } {
		const lines = FileStoreProvider.sanitizeMemory(content).split("\n");
		const result = FileStoreProvider.selectWholeLines(lines, budget, {
			header: undefined,
			footer: FileStoreProvider.factFooter,
		});
		return { text: result.text, omitted: result.omitted };
	}

	/**
	 * Fit a block of text within the memory prompt budget using memoryTextFitsBudget.
	 * Fits the FULL final text including the omitted-count footer, never truncates mid-line,
	 * and restores compact-budget all-or-nothing behavior when nothing fits.
	 */
	private static fitMemoryBlockToBudget(block: string, budget: MemoryPromptBudget | undefined): string {
		if (budget === undefined) return block;
		if (!budget.enabled || budget.maxLines <= 0) return "";
		if (memoryTextFitsBudget(block, budget)) return block;
		if (budget.compact) return "";

		const lines = block.split("\n");
		// Fit the complete text including footer against the full budget; a line is never
		// cut in half as a misleading partial instruction. Returns "" when even one line
		// exceeds the compact budget (all-or-nothing).
		const result = FileStoreProvider.selectWholeLines(lines, budget, {
			footer: FileStoreProvider.factFooter,
		});
		return result.text;
	}

	private static capMemory(content: string, budget: MemoryPromptBudget): string {
		return FileStoreProvider.selectWholeFacts(content, budget).text;
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
		return this.withDriftedTarget(
			target,
			"is already the managed revision; nothing to accept",
			async (entry, drift) => {
				await writeManagedMemoryState(entry.statePath, {
					version: 1,
					committedDigest: drift.revision.currentDigest,
					committedContent: drift.currentOnDisk,
				});
				this.setPromptSnapshot(target, drift.currentOnDisk);
				this.options.onDurableMemoryChanged?.();
				return {
					ok: true,
					message: `${entry.label}: adopted the on-disk content (${Buffer.byteLength(drift.currentOnDisk, "utf8")} bytes) as the managed revision.`,
				};
			},
		);
	}

	/** Operator authority: bring the last managed content back; the drifted file stays as a backup. */
	async restoreManaged(target: ManagedMemoryTarget): Promise<{ ok: boolean; message: string }> {
		return this.withDriftedTarget(
			target,
			"already holds the managed revision; nothing to restore",
			async (entry, drift) => {
				const { currentOnDisk, revision } = drift;
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
					message: `${entry.label}: restored the managed revision (${Buffer.byteLength(content, "utf8")} bytes)${currentOnDisk !== "" ? "; the drifted content is kept beside it as a backup" : ""}.`,
				};
			},
		);
	}

	/**
	 * The prologue both operator recoveries share: resolve the target, hold its file lock, inspect
	 * it, and answer at once when the file already is the managed revision.
	 */
	private async withDriftedTarget(
		target: ManagedMemoryTarget,
		alreadyManaged: string,
		recover: (
			entry: ReturnType<FileStoreProvider["managedTargets"]>[number],
			drift: Pick<Awaited<ReturnType<typeof inspectManagedMemoryFile>>, "currentOnDisk" | "revision">,
		) => Promise<{ ok: boolean; message: string }>,
	): Promise<{ ok: boolean; message: string }> {
		const entry = this.managedTargets().find((candidate) => candidate.target === target);
		if (!entry || !this.ctx) return { ok: false, message: `Unknown memory target ${target}.` };
		return withFileLock(entry.filePath, async () => {
			const { currentOnDisk, revision, managedState } = await inspectManagedMemoryFile(
				entry.filePath,
				entry.statePath,
			);
			if (managedState) return { ok: true, message: `${entry.label} ${alreadyManaged}.` };
			return recover(entry, { currentOnDisk, revision });
		});
	}

	public systemPromptBlock(budget?: MemoryPromptBudget): string {
		if (this.ctx?.isChildSession) return "";
		const mem = FileStoreProvider.capMemory(FileStoreProvider.sanitizeMemory(this.lastWrittenMemory), {
			enabled: true,
			compact: false,
			maxLines: 20,
			maxEstimatedTokens: FileStoreProvider.BUDGET_MEMORY.tokens,
			maxChars: FileStoreProvider.RESOURCE_CEILING,
			maxResults: 10,
		});
		const proj = FileStoreProvider.capMemory(FileStoreProvider.sanitizeMemory(this.lastWrittenProjectMemory), {
			enabled: true,
			compact: false,
			maxLines: 20,
			maxEstimatedTokens: FileStoreProvider.BUDGET_PROJECT.tokens,
			maxChars: FileStoreProvider.RESOURCE_CEILING,
			maxResults: 10,
		});
		const usr = this.renderUserMemory();

		const blocks: string[] = [];
		if (mem.trim()) {
			blocks.push(`## MEMORY.md (general):\n${mem}`);
		}
		if (proj.trim()) {
			blocks.push(`## MEMORY.md (project ${basename(this.projectRoot) || this.projectKey}):\n${proj}`);
		}
		if (usr.trim()) {
			// The projection rule travels with the preferences themselves: every reader of this block
			// (the frozen root prompt, the fresh worker snapshot) gets the same single sentence.
			blocks.push(FileStoreProvider.userSection(usr));
		}

		if (blocks.length === 0) {
			return "";
		}

		const block = `=== Persistent Memory (file-store) ===\n${FILE_STORE_MEMORY_SYSTEM_NOTE}\n\n${blocks.join("\n\n")}`;
		return FileStoreProvider.fitMemoryBlockToBudget(block, budget);
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

	/**
	 * The USER.md write transaction with learning metadata. Locates the line a write supersedes (the
	 * line holding `oldContent`, or for an add the near-duplicate by text with trailers ignored),
	 * refuses a stale revision, asks the admission owner, and only then hands the archive one
	 * line-level mutation so the preference and its trailer land together. A candidate outcome
	 * changes nothing and says so. Without an admission owner the line is labelled unverified.
	 */
	private async applyUserPreferenceWrite(input: {
		action: "add" | "replace" | "remove";
		currentOnDisk: string;
		content: string | undefined;
		oldContent: string | undefined;
		requestedScope: "global" | "project" | undefined;
		requestedBasis: "explicit" | "inferred" | undefined;
		requestedEvidence: UserPreferenceEvidenceCitation[];
		expectedRevision: number | undefined;
		budget: number;
	}): Promise<
		| {
				kind: "applied";
				userContent: string;
				archiveChanged: boolean;
				preference: UserPreferenceMetadata | undefined;
				/** The admission owner's publication boundary; called once with the terminal result. */
				commit: ((report: UserPreferenceCommitReport) => void) | undefined;
		  }
		| { kind: "refused"; result: AgentToolResult<Record<string, unknown>> }
	> {
		if (!this.userArchive) throw new Error("User memory archive is not initialized.");
		const { action, currentOnDisk, content, oldContent } = input;
		if (action !== "remove" && content === undefined) {
			throw new Error(`Parameter 'content' is required for action '${action}'.`);
		}
		if (action !== "add" && oldContent === undefined) {
			throw new Error(`Parameter 'oldContent' is required for action '${action}'.`);
		}
		const text = action === "remove" ? "" : stripUserPreferenceMetadata(content ?? "").trim();
		// The caller holds the USER.md lock: read the archive as it is NOW, not as this provider last
		// saw it, so a peer session's archive change cannot make a write match a stale line.
		await this.refreshArchivedUserLines();
		// Literal lines: matching and mutation never see the rendered, heading-qualified form.
		const candidates = [...FileStoreProvider.activePreferenceEntries(currentOnDisk), ...this.archivedUserEntries].map(
			(entry) => entry.line,
		);
		const requestedScope =
			input.requestedScope !== undefined
				? parseUserPreferenceScope(input.requestedScope, this.projectKey)
				: undefined;
		const lineScope = (line: string): UserPreferenceScope =>
			parseUserPreferenceLine(line).metadata?.scope ?? { kind: "global" };
		// Scope identity: a fact belongs to one applicability set. An add supersedes only a line of the
		// scope it targets (global by default; legacy lines are global); a replace or remove never
		// touches another project's line just because the words match.
		const inScope = (line: string): boolean => {
			const scope = lineScope(line);
			if (requestedScope) return sameUserPreferenceScope(scope, requestedScope);
			return scope.kind === "global" || scope.projectKey === this.projectKey;
		};
		let existingLine: string | undefined;
		if (action === "add") {
			const target: UserPreferenceScope = requestedScope ?? { kind: "global" };
			const tokens = tokenize(text);
			let best = NEAR_DUP_THRESHOLD;
			for (const line of candidates) {
				if (!sameUserPreferenceScope(lineScope(line), target)) continue;
				const score = jaccard(tokens, tokenize(stripUserPreferenceMetadata(line)));
				if (score >= best) {
					best = score;
					existingLine = line;
				}
			}
		} else {
			const needle = stripUserPreferenceMetadata(oldContent ?? "").trim();
			const scoped = candidates.filter(inScope);
			const matches =
				scoped.filter((line) => line === oldContent).length > 0
					? scoped.filter((line) => line === oldContent)
					: scoped.filter((line) => stripUserPreferenceMetadata(line) === needle).length > 0
						? scoped.filter((line) => stripUserPreferenceMetadata(line) === needle)
						: scoped.filter((line) => line.includes(needle));
			if (matches.length === 0) {
				throw new Error(`The content to ${action} ('oldContent') was not found in the file or its archive.`);
			}
			if (
				matches.length > 1 &&
				new Set(matches.map((line) => formatUserPreferenceScope(lineScope(line)))).size > 1
			) {
				throw new Error(
					`The content to ${action} ('oldContent') matches both a global and a project preference; pass scope to name the one you mean.`,
				);
			}
			existingLine = matches[0];
		}
		const existing = existingLine === undefined ? undefined : parseUserPreferenceLine(existingLine);
		if (
			input.expectedRevision !== undefined &&
			existing?.metadata !== undefined &&
			existing.metadata.revision !== input.expectedRevision
		) {
			return {
				kind: "refused",
				result: memoryFailure(
					"Stale revision",
					`Error: USER.md preference ${existing.metadata.id} is at revision ${existing.metadata.revision}, not ${input.expectedRevision}; re-read it before updating. Nothing changed.`,
					{ reasonCode: "stale_revision", currentRevision: existing.metadata.revision },
				),
			};
		}
		const scope: UserPreferenceScope = requestedScope ?? existing?.metadata?.scope ?? { kind: "global" };
		const request: UserPreferenceAdmissionRequest = {
			action,
			text,
			...(existing ? { existing } : {}),
			scope,
			basis: input.requestedBasis ?? "inferred",
			evidence: input.requestedEvidence,
		};
		const admission: UserPreferenceAdmissionResult = this.options.admitUserPreference
			? await this.options.admitUserPreference(request)
			: {
					outcome: "apply",
					reasonCode: "no_admission_owner",
					metadata: {
						id: existing?.metadata?.id ?? newUserPreferenceId(text || existing?.text || "", scope),
						scope,
						basis: "unverified",
						observations: 0,
						revision: (existing?.metadata?.revision ?? 0) + 1,
						sources: [],
					},
				};
		if (admission.outcome === "candidate") {
			return {
				kind: "refused",
				result: memoryFailure(
					"Learning candidate",
					`Not applied: recorded as a learning candidate (${admission.reasonCode}): ${admission.message} USER.md is unchanged; no approval is requested.`,
					{ candidate: true, reasonCode: admission.reasonCode },
				),
			};
		}
		const newLine = action === "remove" ? undefined : formatUserPreferenceLine(text, admission.metadata);
		const mutation =
			existingLine !== undefined
				? newLine !== undefined
					? { action: "replace" as const, oldContent: existingLine, content: newLine }
					: { action: "remove" as const, oldContent: existingLine }
				: newLine !== undefined
					? { action: "add" as const, content: newLine }
					: undefined;
		if (mutation === undefined) throw new Error("The content to remove ('oldContent') was not found in the file.");
		// Near-duplicate supersession was resolved above with trailers ignored; the archive applies one exact mutation.
		let result: Awaited<ReturnType<UserMemoryArchive["apply"]>>;
		try {
			result = await this.userArchive.apply(currentOnDisk, mutation, input.budget, () => null);
		} catch (error) {
			admission.commit?.({ persisted: false, error: String(error) });
			throw error;
		}
		return {
			kind: "applied",
			userContent: result.userContent,
			archiveChanged: result.archiveChanged,
			preference: action === "remove" ? undefined : admission.metadata,
			commit: admission.commit,
		};
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
					"USER writes carry scope (global|project), basis (explicit only for the owner's own cited words, else inferred) and evidence [{source, quote}] from the owner evidence ids in the reflection cue; a one-off task instruction is not a preference.",
					"Workers gather evidence read-only; only the parent or its reflection writes memory. Repeatable procedures become skills via skillify.",
				],
				parameters: memorySchema,
				execute: async (_toolCallId, params: MemoryParams, _signal, _onUpdate, _execCtx) => {
					const {
						action,
						target: requestedTarget,
						content,
						oldContent,
						basis: requestedBasis,
						evidence: requestedEvidence,
						expectedRevision,
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
							["memory", "MEMORY.md (general)", this.memoryFilePath, this.memoryStatePath],
							[
								"project",
								`MEMORY.md (project ${basename(this.projectRoot) || this.projectKey})`,
								this.projectMemoryFilePath,
								this.projectMemoryStatePath,
							],
							["user", "USER.md", this.userFilePath, this.userStatePath],
						] as const;
						try {
							const files = await Promise.all(
								rows
									.filter(([scope]) => requestedTarget === undefined || scope === requestedTarget)
									.map(async ([target, label, filePath, statePath]) =>
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
											const promptTokens =
												target === "memory"
													? FileStoreProvider.BUDGET_MEMORY.tokens
													: target === "project"
														? FileStoreProvider.BUDGET_PROJECT.tokens
														: FileStoreProvider.BUDGET_USER.tokens;
											const revisionText = `Current revision: ${revision.currentDigest}; managed revision: ${revision.managedDigest ?? revision.stateStatus}; pending revision: ${revision.pendingDigest ?? "none"}; prompt snapshot: ${promptDigest}.`;
											return {
												text: `## ${label} (${Buffer.byteLength(currentOnDisk, "utf8")} bytes, ${estimateTokensFromText(currentOnDisk)} approximate tokens, prompt allocation ${promptTokens} tokens, resource ceiling ${FileStoreProvider.RESOURCE_CEILING} bytes)\n${revisionText}\n${revision.drift ? `Drift detected. ${MEMORY_DRIFT_RECOVERY}\n` : ""}${currentOnDisk.trim() || "(empty)"}`,
												details: {
													target,
													path: filePath,
													...revision,
													promptDigest,
													currentBytes: Buffer.byteLength(currentOnDisk, "utf8"),
													currentChars: Buffer.byteLength(currentOnDisk, "utf8"),
													promptTokens,
													resourceCeilingBytes: FileStoreProvider.RESOURCE_CEILING,
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
							? FileStoreProvider.RESOURCE_CEILING
							: target === "project"
								? FileStoreProvider.RESOURCE_CEILING
								: FileStoreProvider.BUDGET_USER.chars;
					// The admitted USER write's publication boundary: reported once, after the bytes landed
					// or the write failed, so the learning audit never claims an apply that did not persist.
					let pendingCommit: ((report: UserPreferenceCommitReport) => void) | undefined;
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
								this.managedNotices.push({
									target,
									kind: "healed",
									revision: contentDigest(healed),
									message: `${basename(filePath)} was empty on disk; restored ${healed.length} chars from the managed revision.`,
								});
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
							let preference: UserPreferenceMetadata | undefined;
							if (target === "user") {
								if (!this.userArchive) throw new Error("User memory archive is not initialized.");
								const outcome = await this.applyUserPreferenceWrite({
									action,
									currentOnDisk,
									content,
									oldContent,
									requestedScope: scope,
									requestedBasis,
									requestedEvidence: requestedEvidence ?? [],
									expectedRevision,
									budget,
								});
								if (outcome.kind === "refused") return outcome.result;
								pendingCommit = outcome.commit;
								newContent = outcome.userContent;
								archiveChanged = outcome.archiveChanged;
								if (archiveChanged) await this.refreshArchivedUserLines();
								preference = outcome.preference;
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

							const overBudget = Buffer.byteLength(newContent, "utf8") > FileStoreProvider.RESOURCE_CEILING;
							if (
								overBudget &&
								Buffer.byteLength(newContent, "utf8") >= Buffer.byteLength(currentOnDisk, "utf8")
							) {
								pendingCommit?.({ persisted: false, error: "Resource overflow" });
								pendingCommit = undefined;
								return memoryFailure(
									"Resource overflow",
									`Error: Resource overflow. ${fileLabel} storage ceiling is ${FileStoreProvider.RESOURCE_CEILING} UTF-8 bytes. Current operation would result in ${Buffer.byteLength(newContent, "utf8")} bytes. Remove or shorten an existing line first; already-over-budget content must strictly shrink on each repair.`,
								);
							}

							if (newContent !== currentOnDisk) {
								await commitManagedMemoryContent(filePath, statePath, managedState, newContent);
							}

							if (target === "memory") this.lastWrittenMemory = newContent;
							else if (target === "project") this.lastWrittenProjectMemory = newContent;
							else this.lastWrittenUser = newContent;
							if (archiveChanged || newContent !== currentOnDisk) this.options.onDurableMemoryChanged?.();
							// The managed file and its state are committed; the archive (when touched) was written
							// before them. A crash between those writes is recovered by the drift/heal protocol,
							// not by this report, which only ever describes what completed.
							pendingCommit?.({ persisted: true });
							pendingCommit = undefined;

							return {
								content: [
									{
										type: "text",
										text: `Successfully updated ${fileLabel}.${projectHint}${overBudget ? `\nResource ceiling exceeded (${Buffer.byteLength(newContent, "utf8")}/${FileStoreProvider.RESOURCE_CEILING} bytes); the file on disk is preserved; remove or shorten facts to comply.` : ""}`,
									},
								],
								details: {
									success: true,
									overBudget,
									currentBytes: Buffer.byteLength(newContent, "utf8"),
									resourceCeilingBytes: FileStoreProvider.RESOURCE_CEILING,
									...(preference
										? {
												preference: {
													id: preference.id,
													scope: formatUserPreferenceScope(preference.scope),
													basis: preference.basis,
													observations: preference.observations,
													revision: preference.revision,
												},
											}
										: {}),
								},
							};
						});
					} catch (err) {
						pendingCommit?.({ persisted: false, error: String(err) });
						pendingCommit = undefined;
						return memoryFailure(String(err), `Error: Failed to perform memory operation: ${String(err)}`);
					}
				},
			},
		];
	}
}
