/** Pure display projection. Host discovery, process liveness and subscriptions belong to host/ci. */
export type CiVerdictState = "running" | "green" | "red" | "unknown";

export interface CiStatusView {
	readonly state: CiVerdictState;
	readonly branch: string;
}

export interface CiStatusSource {
	readStatus(): CiStatusView | undefined;
	subscribeStatus(listener: () => void): () => void;
}

export function ciStatusViewFromRecord(
	record: unknown,
	branch: string,
	now = Date.now(),
	watcherAlive?: boolean,
): CiStatusView | undefined {
	if (!record || typeof record !== "object") return undefined;
	const value = record as { state?: unknown; conclusion?: unknown; startedAt?: unknown };
	if (value.state === "pending") {
		const started = typeof value.startedAt === "string" ? Date.parse(value.startedAt) : Number.NaN;
		const stale =
			watcherAlive === false ||
			(watcherAlive === undefined && Number.isFinite(started) && now - started > 15 * 60_000);
		return { state: stale ? "unknown" : "running", branch };
	}
	if (value.state !== "completed") return { state: "unknown", branch };
	return { state: value.conclusion === "success" ? "green" : "red", branch };
}
