import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import type { SessionManager } from "../../kernel/session/session-manager.ts";
import { readAccountingProjection, reconcileSessionAccounting } from "./accounting-history.ts";
import { type HistoricalAccountingProjection, projectHistoricalAccounting } from "./accounting-projection.ts";
import { SPAWNED_USAGE_CUSTOM_TYPE } from "./usage-records.ts";

interface HistoryState {
	session: SessionManager;
	file: string | undefined;
	sessionId: string;
	projection?: HistoricalAccountingProjection;
	entries: readonly SessionEntry[];
	count: number;
	loading: boolean;
	loaded: boolean;
	retryAfterCount?: number;
}

/** Async disk evidence has one owner; no filesystem read or hash occurs during a redraw. */
export class SessionAccountingHistory {
	private state: HistoryState | undefined;
	private readonly deps: {
		getSession(): SessionManager;
		getAgentDir(): string;
		isDisposed(): boolean;
		onUpdated(): void;
		onError(error: unknown): void;
	};

	constructor(deps: SessionAccountingHistory["deps"]) {
		this.deps = deps;
	}

	reset(): void {
		this.state = undefined;
	}

	hasProjection(): boolean {
		return Boolean(this.state?.projection?.groups.length);
	}

	status(): "pending" | "unavailable" | undefined {
		return this.state?.loading ? "pending" : this.state?.retryAfterCount !== undefined ? "unavailable" : undefined;
	}

	entries(): readonly SessionEntry[] {
		const session = this.deps.getSession();
		const file = session.getSessionFile();
		const sessionId = session.getSessionId();
		let state = this.state;
		if (!state || state.session !== session || state.file !== file || state.sessionId !== sessionId) {
			state = { session, file, sessionId, entries: session.getEntries(), count: -1, loading: false, loaded: false };
			this.state = state;
		}
		const count = session.getEntryCount();
		if (state.count !== count) {
			const raw = session.getEntries();
			const hasNewWorkerReceipt = raw
				.slice(Math.max(0, state.count))
				.some((entry) => entry.type === "custom" && entry.customType === SPAWNED_USAGE_CUSTOM_TYPE);
			state.entries = projectHistoricalAccounting(raw, state.projection);
			state.count = count;
			if (hasNewWorkerReceipt && state.loaded && !state.loading) this.hydrate(state, true);
			else if (state.retryAfterCount !== undefined && count > state.retryAfterCount && !state.loading)
				this.hydrate(state, true);
		}
		if (!state.loaded && !state.loading && file) this.hydrate(state, false);
		return state.entries;
	}

	private hydrate(state: HistoryState, refresh: boolean): void {
		if (!state.file) return;
		state.loading = true;
		const file = state.file;
		void (async () => {
			const projection =
				(!refresh ? await readAccountingProjection(file) : undefined) ??
				(await reconcileSessionAccounting(this.deps.getAgentDir(), file));
			if (projection.sessionId !== state.sessionId)
				throw new Error("Accounting projection session identity changed.");
			if (this.state !== state || this.deps.isDisposed()) return;
			state.projection = projection;
			state.entries = projectHistoricalAccounting(state.session.getEntries(), projection);
			state.count = state.session.getEntryCount();
			state.loaded = true;
			state.retryAfterCount = undefined;
			state.loading = false;
			this.deps.onUpdated();
		})()
			.catch((error: unknown) => {
				if (this.state === state && !this.deps.isDisposed()) {
					state.loaded = true;
					state.retryAfterCount = state.session.getEntryCount();
					this.deps.onError(error);
				}
			})
			.finally(() => {
				state.loading = false;
			});
	}
}
