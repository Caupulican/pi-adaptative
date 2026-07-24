const MAX_WORKER_TASK_LABEL_LENGTH = 120;

/** Produce the one bounded human label used by durable worker tasks, lane records, and UI. */
export function deriveWorkerTaskLabel(instructions: string, fallback: string): string {
	const normalized = instructions.trim().replace(/\s+/g, " ");
	if (!normalized) return fallback;
	if (normalized.length <= MAX_WORKER_TASK_LABEL_LENGTH) return normalized;
	return `${normalized.slice(0, MAX_WORKER_TASK_LABEL_LENGTH - 1).trimEnd()}…`;
}
