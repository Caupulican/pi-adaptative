/** Read-only, allocation-conscious projections of background tool task state. */

interface BackgroundToolTaskStateView {
	readonly record: {
		readonly taskId: string;
		readonly status: string;
	};
}

function isRunning(state: BackgroundToolTaskStateView): boolean {
	return state.record.status === "running";
}

/** Count running tasks without materializing model-facing records or the resource diagnostic snapshot. */
export function runningBackgroundToolTaskCount(states: Iterable<BackgroundToolTaskStateView>): number {
	let running = 0;
	for (const state of states) if (isRunning(state)) running++;
	return running;
}

/** Running task identities for lifecycle diagnostics. */
export function runningBackgroundToolTaskIds(states: Iterable<BackgroundToolTaskStateView>): string[] {
	const ids: string[] = [];
	for (const state of states) if (isRunning(state)) ids.push(state.record.taskId);
	return ids;
}
