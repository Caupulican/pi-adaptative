/** Root memory owns mutation and lifecycle; workers may receive only the bounded query broker. */
export const ROOT_MEMORY_TOOL_NAME = "memory";
export const WORKER_MEMORY_READ_TOOL_NAME = "memory_read";
export const WORKER_ROOT_MEMORY_TOOL_NAMES: ReadonlySet<string> = new Set([ROOT_MEMORY_TOOL_NAME]);
