/** Root memory owns mutation and lifecycle; workers may receive only the bounded query broker. */
export const ROOT_MEMORY_TOOL_NAME = "memory";
export const WORKER_MEMORY_READ_TOOL_NAME = "memory_read";
export const WORKER_ROOT_MEMORY_TOOL_NAMES: ReadonlySet<string> = new Set([ROOT_MEMORY_TOOL_NAME]);

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

/**
 * One worker source read's answer: the page or expansion text, or a typed refusal (`memory_source_<status>: ...`)
 * that the worker sees verbatim, exact-source pointers included, exactly as the root sees its history refusals.
 */
export type WorkerMemorySourceAnswer = { ok: true; text: string } | { ok: false; status: string; text: string };

/**
 * One delegated lane's read-only memory port. `read` returns a source-labeled snapshot; `readSource`
 * opens one transcript source page and only for a handle an earlier `read` of this same broker issued. A typed
 * refusal is an answer, never empty text; a read made stale by a memory transition rejects instead.
 */
export interface WorkerMemoryBroker {
	read(query: string): Promise<string>;
	readSource(ref: string, cursor?: number): Promise<WorkerMemorySourceAnswer>;
}
