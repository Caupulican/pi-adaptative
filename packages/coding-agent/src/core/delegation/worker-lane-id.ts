/**
 * The ids a plain delegate worker is given (`worker-1`, `worker-2`, ...). A delegate worker is a child of the session that
 * started it, not a bot: this domain is minted only by the worker lifecycle, and the bot id domain excludes it
 * (`bot-runtime-bindings.ts`), so one id never names both a worker and a bot.
 */
const GENERATED_WORKER_LANE_ID = /^worker-(\d+)$/;

export function generatedWorkerLaneId(number: number): string {
	return `worker-${number}`;
}

/** The number in a generated worker lane id; undefined for any other id. */
export function generatedWorkerLaneNumber(id: string): number | undefined {
	const suffix = GENERATED_WORKER_LANE_ID.exec(id)?.[1];
	return suffix === undefined ? undefined : Number(suffix);
}

export function isGeneratedWorkerLaneId(id: string): boolean {
	return GENERATED_WORKER_LANE_ID.test(id);
}
