/** Live provenance for a complete worker handoff and the work reports minted by the terminal report writer. */

interface WorkerHandoff {
	readonly content: string;
	readonly attemptIds: readonly string[];
}

const handoffs = new WeakMap<object, WorkerHandoff>();
const reports = new WeakMap<object, string>();

export function recordLiveWorkerHandoff(
	details: object,
	content: string,
	records: readonly { attemptId?: string }[],
	totalCount: number,
): void {
	const attemptIds = records.flatMap(({ attemptId }) => (attemptId === undefined ? [] : [attemptId]));
	if (
		attemptIds.length === 0 ||
		attemptIds.length !== records.length ||
		attemptIds.length !== totalCount ||
		new Set(attemptIds).size !== attemptIds.length
	)
		return;
	handoffs.set(details, { content, attemptIds });
}

export function liveWorkerHandoffOf(details: unknown, content: unknown): WorkerHandoff | undefined {
	if (!details || typeof details !== "object") return undefined;
	const handoff = handoffs.get(details);
	return handoff?.content === content ? handoff : undefined;
}

export function recordLiveWorkerReport(data: { claimId: string }): void {
	reports.set(Object.freeze(data), data.claimId);
}

export function isLiveWorkerReport(data: unknown, claimId: string): boolean {
	return !!data && typeof data === "object" && reports.get(data) === claimId;
}
