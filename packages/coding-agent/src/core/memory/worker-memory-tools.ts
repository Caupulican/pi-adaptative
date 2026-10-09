/** Root memory owns mutation and lifecycle; workers may receive only the bounded query broker. */
export const ROOT_MEMORY_TOOL_NAME = "memory";
export const WORKER_MEMORY_READ_TOOL_NAME = "memory_read";
export const WORKER_ROOT_MEMORY_TOOL_NAMES: ReadonlySet<string> = new Set([ROOT_MEMORY_TOOL_NAME]);

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
 * One delegated lane's read-only memory port. `read` returns a source-labeled snapshot; `readSource`
 * opens one transcript source page and only for a handle an earlier `read` of this same broker issued.
 * Both reject (never return empty text) when the memory is unavailable, stale, or the handle is not admitted.
 */
export interface WorkerMemoryBroker {
	read(query: string): Promise<string>;
	readSource(ref: string, cursor?: number): Promise<string>;
}
