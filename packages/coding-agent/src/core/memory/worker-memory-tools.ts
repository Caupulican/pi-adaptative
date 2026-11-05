import type { MemoryPromptBudget } from "../context/memory-prompt-budget.ts";
import type { AgentToolResult } from "../extensions/types.ts";
import type { KnowledgeProjection } from "./knowledge-projection.ts";

/** Root memory owns mutation and lifecycle: the root `memory` tool is never a worker's. */
export const ROOT_MEMORY_TOOL_NAME = "memory";
export const WORKER_MEMORY_READ_TOOL_NAME = "memory_read";
/** The continuous chat's read-only navigation: a worker holds it through the broker, never as a mutating tool. */
export const CONTINUOUS_CHAT_ZOOM_TOOL_NAME = "zoom";
export const CONTINUOUS_CHAT_DATE_TOOL_NAME = "date";
export const CONTINUOUS_CHAT_NAVIGATION_TOOL_NAMES = [
	CONTINUOUS_CHAT_ZOOM_TOOL_NAME,
	CONTINUOUS_CHAT_DATE_TOOL_NAME,
] as const;
/** Every read tool a worker holds through the memory broker. None of them changes memory. */
export const WORKER_MEMORY_BROKER_TOOL_NAMES = [
	WORKER_MEMORY_READ_TOOL_NAME,
	...CONTINUOUS_CHAT_NAVIGATION_TOOL_NAMES,
] as const;
export const WORKER_CHAT_NAVIGATION_TOOL_NAME_SET: ReadonlySet<string> = new Set(CONTINUOUS_CHAT_NAVIGATION_TOOL_NAMES);
export const WORKER_MEMORY_BROKER_TOOL_NAME_SET: ReadonlySet<string> = new Set(WORKER_MEMORY_BROKER_TOOL_NAMES);
/** Root-only memory tools: a worker never holds these, whatever its grant names. */
export const WORKER_ROOT_MEMORY_TOOL_NAMES: ReadonlySet<string> = new Set([ROOT_MEMORY_TOOL_NAME]);

/** Root memory authority may lend its read-only broker tools; the root mutator never crosses lanes. */
export function lendsMemoryReadTool(surface: readonly string[], tool: string): boolean {
	return (
		WORKER_MEMORY_BROKER_TOOL_NAME_SET.has(tool) &&
		(surface.includes(tool) ||
			surface.includes(ROOT_MEMORY_TOOL_NAME) ||
			surface.includes(CONTINUOUS_CHAT_ZOOM_TOOL_NAME))
	);
}

/**
 * The one read/write partition of the root `memory` tool's actions. The history actions are offered in both
 * memory systems (alone in ICM); `list` and the writes belong to OKF's curated stores. The tool schemas, the
 * capability classifier and reflection's durable-write signal all derive from these lists.
 */
export const ROOT_MEMORY_HISTORY_ACTIONS = ["history_search", "history_source", "history_expand"] as const;
export type RootMemoryHistoryAction = (typeof ROOT_MEMORY_HISTORY_ACTIONS)[number];
export const ROOT_MEMORY_LIST_ACTION = "list";
/** Actions that only read memory: the curated listing and the history reads. */
export const ROOT_MEMORY_READ_ACTIONS = [ROOT_MEMORY_LIST_ACTION, ...ROOT_MEMORY_HISTORY_ACTIONS] as const;
/** Actions that change durable memory. */
export const ROOT_MEMORY_WRITE_ACTIONS = ["add", "replace", "remove"] as const;

export function isRootMemoryHistoryAction(action: unknown): action is RootMemoryHistoryAction {
	return ROOT_MEMORY_HISTORY_ACTIONS.some((candidate) => candidate === action);
}

export function isRootMemoryReadAction(action: unknown): boolean {
	return ROOT_MEMORY_READ_ACTIONS.some((candidate) => candidate === action);
}

/**
 * What the RECEIVING lane's next provider request can carry, as of its last accepted request: its own model
 * window, the request it already sent (system prompt, tool schemas, messages), the reply room that request
 * keeps free, and the tokens its grant and its tree may still spend. Never the root model's numbers.
 */
export interface LaneMemoryCapacity {
	/** The receiving model's context window in tokens. */
	contextWindow: number;
	/** Estimated tokens of the lane's last accepted request, tool schemas included. */
	currentPromptTokens: number;
	/** Tokens kept free for the lane's reply and its compaction. */
	reservedTokens: number;
	/** Tokens the lane may still spend under its grant and its tree's; absent when it has no token limit. */
	remainingTokenAllowance?: number;
	/** Advances with every accepted lane request: a read planned against an older request is not current. */
	revision: number;
}

/** The lane's live capacity, or undefined while it has sent no request (its capacity is then unknown). */
export type LaneMemoryCapacitySource = () => LaneMemoryCapacity | undefined;

export interface MemoryReadSourceReference {
	readonly kind: "transcript" | "summary" | "knowledge" | "managed" | "icm";
	readonly ref: string;
	readonly revision: string;
}

export interface MemoryReadReceipt {
	readonly id: string;
	readonly kind: "search" | "source" | "navigation";
	readonly sources: readonly MemoryReadSourceReference[];
	readonly textDigest: string;
	readonly complete: boolean;
	readonly disposition: "read" | "refused" | "unavailable";
	/** Source/policy freshness only; later receiving-request capacity revisions do not invalidate evidence. */
	isCurrent(): boolean;
	/** Caller supplies its reserved revalidation deadline. Does not issue a new evidence receipt. */
	revalidate(options: WorkerMemoryReadOptions): Promise<boolean>;
}

export interface WorkerMemoryReadOptions {
	readonly signal?: AbortSignal;
	readonly deadlineAt?: number;
	/** Host-only restriction; ordinary callers retain their existing provider behavior. */
	readonly admission?: "native-only";
	/** Maximum decoded image bytes admitted by navigation; zero retains descriptors without loading images. */
	readonly maxImageBytes?: number;
	readonly observe?: (receipt: MemoryReadReceipt) => void;
}

/**
 * One worker source read's answer: the page or expansion text, or a typed refusal (`memory_source_<status>: ...`)
 * that the worker sees verbatim, exact-source pointers included, exactly as the root sees its history refusals.
 */
export type WorkerMemorySourceAnswer = { ok: true; text: string } | { ok: false; status: string; text: string };

/**
 * One delegated lane's read-only memory port. `read` returns a source-labeled snapshot; `readSource`
 * opens one transcript source page and only for a handle an earlier `read` of this same broker issued. `navigate`
 * runs the continuous chat's `zoom` or `date` for this lane by message id only (private worker logs stay
 * root-readable), and returns the tool result (content, or a typed refusal). A read made stale by a memory transition
 * rejects instead.
 */
export interface WorkerMemoryBroker {
	/** Current exact task-selected facts, sized against the complete request being prepared. */
	projectKnowledge?(budget: MemoryPromptBudget): KnowledgeProjection;
	read(query: string, options?: WorkerMemoryReadOptions): Promise<string>;
	readSource(ref: string, cursor?: number, options?: WorkerMemoryReadOptions): Promise<WorkerMemorySourceAnswer>;
	navigate(
		tool: (typeof CONTINUOUS_CHAT_NAVIGATION_TOOL_NAMES)[number],
		args: unknown,
		signal?: AbortSignal,
		options?: WorkerMemoryReadOptions,
	): Promise<AgentToolResult<Record<string, unknown>>>;
}
