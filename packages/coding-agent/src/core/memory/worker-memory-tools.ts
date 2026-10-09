/** Root memory owns mutation and lifecycle; workers may receive only the bounded query broker. */
export const ROOT_MEMORY_TOOL_NAME = "memory";
export const WORKER_MEMORY_READ_TOOL_NAME = "memory_read";
export const WORKER_ROOT_MEMORY_TOOL_NAMES: ReadonlySet<string> = new Set([ROOT_MEMORY_TOOL_NAME]);

/**
 * One delegated lane's read-only memory port. `read` returns a source-labeled snapshot; `readSource`
 * opens one transcript source page and only for a handle an earlier `read` of this same broker issued.
 * Both reject (never return empty text) when the memory is unavailable, stale, or the handle is not admitted.
 */
export interface WorkerMemoryBroker {
	read(query: string): Promise<string>;
	readSource(ref: string, cursor?: number): Promise<string>;
}
