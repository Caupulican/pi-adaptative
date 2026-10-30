import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import type { SessionManager } from "../../kernel/session/session-manager.ts";
import { FileSnapshotChangedError } from "../../kernel/storage/bounded-file.ts";
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
	revision: number;
	retriesLeft: number;
	loading: boolean;
	loaded: boolean;
	scheduled: boolean;
	needsRefresh: boolean;
	deferred: boolean;
	failed: boolean;
	unsubscribe?: () => void;
}

/** Durable append events own refresh admission; redraws only read the cached projection. */
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
		this.state?.unsubscribe?.();
		this.state = undefined;
	}

	hasProjection(): boolean {
		return Boolean(this.state?.projection?.groups.length);
	}

	status(): "pending" | "unavailable" | undefined {
		return this.state?.loading || this.state?.deferred ? "pending" : this.state?.failed ? "unavailable" : undefined;
	}

	entries(): readonly SessionEntry[] {
		const session = this.deps.getSession();
		const file = session.getSessionFile();
		const sessionId = session.getSessionId();
		let state = this.state;
		if (!state || state.session !== session || state.file !== file || state.sessionId !== sessionId) {
			this.reset();
			state = {
				session,
				file,
				sessionId,
				entries: session.getEntries(),
				count: -1,
				revision: 0,
				retriesLeft: 1,
				loading: false,
				loaded: false,
				scheduled: false,
				needsRefresh: false,
				deferred: false,
				failed: false,
			};
			this.state = state;
			const observed = state;
			state.unsubscribe = session.onEntriesPersisted((event) => {
				if (
					!this.isCurrent(observed) ||
					event.sessionId !== observed.sessionId ||
					event.sessionFile !== observed.file
				)
					return;
				observed.revision++;
				const workerChanged = event.entryIds.some((id) => {
					const entry = session.getEntry(id);
					return entry?.type === "custom" && entry.customType === SPAWNED_USAGE_CUSTOM_TYPE;
				});
				if (!observed.loaded || observed.deferred || observed.failed || workerChanged || event.rewritten) {
					observed.needsRefresh = true;
					observed.retriesLeft = 1;
					this.schedule(observed);
				}
			});
		}
		const count = session.getEntryCount();
		if (state.count !== count) {
			state.entries = projectHistoricalAccounting(session.getEntries(), state.projection);
			state.count = count;
		}
		if (!state.loaded) this.schedule(state);
		return state.entries;
	}

	private isCurrent(state: HistoryState): boolean {
		return (
			this.state === state &&
			!this.deps.isDisposed() &&
			this.deps.getSession() === state.session &&
			state.session.getSessionId() === state.sessionId &&
			state.session.getSessionFile() === state.file
		);
	}

	private schedule(state: HistoryState): void {
		if (
			!this.isCurrent(state) ||
			state.loading ||
			state.scheduled ||
			!state.file ||
			!state.session.hasDurableSessionFile()
		)
			return;
		state.scheduled = true;
		queueMicrotask(() => {
			state.scheduled = false;
			if (this.isCurrent(state) && state.session.hasDurableSessionFile()) this.hydrate(state);
		});
	}

	private hydrate(state: HistoryState): void {
		if (!state.file || state.loading) return;
		state.loading = true;
		state.needsRefresh = false;
		const file = state.file;
		const revision = state.revision;
		let updated = false;
		void (async () => {
			const projection =
				(!state.loaded ? await readAccountingProjection(file) : undefined) ??
				(await reconcileSessionAccounting(this.deps.getAgentDir(), file));
			if (projection.sessionId !== state.sessionId)
				throw new Error("Accounting projection session identity changed.");
			if (!this.isCurrent(state)) return;
			state.projection = projection;
			state.entries = projectHistoricalAccounting(state.session.getEntries(), projection);
			state.count = state.session.getEntryCount();
			state.loaded = true;
			state.deferred = false;
			state.failed = false;
			updated = true;
		})()
			.catch((error: unknown) => {
				if (!this.isCurrent(state)) return;
				state.loaded = true;
				state.deferred = error instanceof FileSnapshotChangedError;
				state.failed = !state.deferred;
				if (state.deferred) {
					if (state.revision !== revision) state.needsRefresh = true;
					else if (state.retriesLeft > 0) {
						state.retriesLeft--;
						state.needsRefresh = true;
					}
					updated = true;
				} else this.deps.onError(error);
			})
			.finally(() => {
				state.loading = false;
				if (this.isCurrent(state) && state.needsRefresh) this.schedule(state);
				if (this.isCurrent(state) && updated) this.deps.onUpdated();
			});
	}
}
