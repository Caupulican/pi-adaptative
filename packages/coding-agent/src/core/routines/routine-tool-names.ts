/** Tool identity shared by registries without loading routine execution dependencies. */
export const ROUTINE_TOOL_NAME = "routine";
/** The task-scoped watch a worker runtime arms for its own wait; it cannot read, change or delete any other routine. */
export const TASK_WATCH_TOOL_NAME = "task_watch";
/** The session's own waits: the model arms, lists, reads and cancels them in any turn (`core/watches/watch-tool.ts`). */
export const WATCH_TOOL_NAME = "watch";
