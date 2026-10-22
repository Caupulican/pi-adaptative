/**
 * Composition root of ICM's project chat. The memory controller owns one host per ICM root session generation.
 * `open` opens the runtime, which takes the project's lease; nothing is imported,
 * subscribed or dispatched yet. `start` then finishes the legacy import, subscribes live announcements, replays the
 * durable entries and starts dispatch. Nothing else appends to the chat or dispatches its work.
 */

import { existsSync } from "node:fs";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import type { SessionEntriesPersistedEvent } from "../../kernel/session/session-manager.ts";
import type { TimerPort } from "../util/timer-port.ts";
import type { ContinuousChatCompactionAdapterPort } from "./continuous-chat-compaction-adapter.ts";
import { ContinuousChatIngestor } from "./continuous-chat-ingest.ts";
import { type ContinuousChatLegacySource, importContinuousChatLegacyHistory } from "./continuous-chat-legacy-import.ts";
import {
	ContinuousChatMigrationBlockedError,
	type ContinuousChatSessionLedger,
	type ContinuousChatSessionsState,
	createContinuousChatLegacyImportMarker,
	createContinuousChatSessionLedger,
	readContinuousChatLegacySessionFile,
} from "./continuous-chat-migration.ts";
import { type ContinuousChatCompactionPrefixHead, ContinuousChatRuntime } from "./continuous-chat-runtime.ts";
import { ContinuousChatStore } from "./continuous-chat-store.ts";
import type { ContinuousChatPort } from "./continuous-chat-tools.ts";
import { IcmTurnCoordinator } from "./continuous-chat-turn-coordinator.ts";
import { ContinuousChatWorkerLog, type ContinuousChatWorkerTranscript } from "./continuous-chat-worker-log.ts";

/** The session-side ports a host needs. The session supplies them; the host never reaches into the session. */
export interface ContinuousChatHostPorts {
	/** Background summary execution; its availability never gates storage activation or root turns. */
	compaction: ContinuousChatCompactionAdapterPort;
	/** The foreground system prompt and tools every compaction repeats (the accepted request's, or the current ones). */
	prefixHead(): ContinuousChatCompactionPrefixHead;
	/** Forgets the accepted provider prefix, so compactions resolve the prefix the chat's activation installs. */
	resetCompactionPrefix(): void;
	resolveWorker(name: string): ContinuousChatWorkerTranscript | undefined;
	readEntry(entryId: string): SessionEntry | undefined;
	/** The session's entry ids in order, and whether each one is durably written to the session file. */
	entryIds(): readonly string[];
	isEntryPersisted(entryId: string): boolean;
	/** The work-claim release backoff's timers. Absent: the system's. */
	timers?: TimerPort;
}

export interface ContinuousChatHostOptions extends ContinuousChatHostPorts {
	agentDir: string;
	/** The 16-hex project identity the chat is stored under. */
	projectKey: string;
	/** The live session. It is logged live, so the legacy import leaves it out. */
	sessionId: string;
	sessionFile?: string;
	/** The earlier sessions and their forget evidence, imported once before the chat starts. */
	legacy: ContinuousChatLegacySource;
	/** The session's durable-write announcements. The host subscribes only in `start`, after the lease is held. */
	subscribeEntriesPersisted(listener: (event: SessionEntriesPersistedEvent) => void): () => void;
	warn(message: string): void;
}

/** A promise its owner settles once. Its rejection is observed here, so an unawaited failure is never unhandled. */
interface Settlement {
	readonly promise: Promise<void>;
	resolve(): void;
	reject(error: unknown): void;
}

function createSettlement(): Settlement {
	let resolve: () => void = () => undefined;
	let reject: (error: unknown) => void = () => undefined;
	const promise = new Promise<void>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	promise.catch(() => undefined);
	return { promise, resolve, reject };
}

export class ContinuousChatHost {
	readonly runtime: ContinuousChatRuntime;
	readonly ingestor: ContinuousChatIngestor;
	readonly turns: IcmTurnCoordinator;
	readonly workerLogs: ContinuousChatWorkerLog;
	/** The live chat as the root's tools and the ICM system block read it. */
	readonly port: ContinuousChatPort;
	/** Resolves once the host has stopped: by `dispose`, or on its own when its runtime stops (a lost lease). Never rejects. */
	readonly stopped: Promise<void>;
	private readonly options: ContinuousChatHostOptions;
	private readonly sessionLedger: ContinuousChatSessionLedger;
	private readonly started: Settlement;
	private readonly halt: Settlement;
	private unsubscribe: (() => void) | undefined;
	private starting: Promise<void> | undefined;
	private closed = false;
	private replayed = false;

	private constructor(parts: {
		runtime: ContinuousChatRuntime;
		sessionLedger: ContinuousChatSessionLedger;
		ingestor: ContinuousChatIngestor;
		turns: IcmTurnCoordinator;
		workerLogs: ContinuousChatWorkerLog;
		port: ContinuousChatPort;
		options: ContinuousChatHostOptions;
		started: Settlement;
	}) {
		this.runtime = parts.runtime;
		this.sessionLedger = parts.sessionLedger;
		this.ingestor = parts.ingestor;
		this.turns = parts.turns;
		this.workerLogs = parts.workerLogs;
		this.port = parts.port;
		this.options = parts.options;
		this.started = parts.started;
		this.halt = createSettlement();
		this.stopped = this.halt.promise;
		// The runtime stops on its own only when its lease is lost; a stop through `dispose` has already closed the host.
		void parts.runtime.stopped.then(() => this.close("Continuous chat stopped with its runtime."));
	}

	/**
	 * Opens the runtime independently of summary-model availability. Opening takes the project's lease and fails once, with the
	 * runtime's error, when a live session already holds it. A failure after the runtime opens releases the lease.
	 */
	static async open(options: ContinuousChatHostOptions): Promise<ContinuousChatHost> {
		// Before the runtime opens: no compaction can resolve the pre-activation prefix a reloaded session accepted.
		options.resetCompactionPrefix();
		const store = new ContinuousChatStore({
			agentDir: options.agentDir,
			projectKey: options.projectKey,
			warn: options.warn,
		});
		// Takes the project's lease. A live owner refuses it once (`ContinuousChatLeaseHeldError`), before anything opens.
		const runtime = await ContinuousChatRuntime.open({
			store,
			port: options.compaction,
			prefixHead: () => options.prefixHead(),
			warn: options.warn,
			label: options.sessionId,
			...(options.timers !== undefined ? { timers: options.timers } : {}),
		});
		try {
			const sessionLedger = createContinuousChatSessionLedger(runtime.store.rootDir);
			await sessionLedger.recordAttached(options.sessionId, options.sessionFile);
			const started = createSettlement();
			const ingestor = new ContinuousChatIngestor({
				appender: runtime,
				readEntry: (entryId) => options.readEntry(entryId),
				warn: options.warn,
			});
			const workerLogs = new ContinuousChatWorkerLog({ resolve: (name) => options.resolveWorker(name) });
			return new ContinuousChatHost({
				runtime,
				sessionLedger,
				ingestor,
				turns: new IcmTurnCoordinator({ runtime, ingestor, started: started.promise }),
				workerLogs,
				port: {
					navigation: runtime.navigationSource(),
					workerLogs,
					// No separate source: the base system prompt already carries AGENTS.md and the global instructions.
					userInstructions: () => undefined,
				},
				options,
				started,
			});
		} catch (error) {
			// The runtime holds the lease: release it before the failure is rethrown, so a failed host never keeps it.
			await runtime.stop().catch((stopError: unknown) => {
				options.warn(`Continuous chat could not release its runtime after a failed open: ${String(stopError)}`);
			});
			throw error;
		}
	}

	/**
	 * Finishes the legacy import, subscribes the live announcements, replays every durable entry, then starts dispatch.
	 * Turns wait for this, so none pins a history the import has not finished. Rejects with the failure; the owner then
	 * disposes the host. Nothing is started after a dispose. Idempotent: a generation that keeps a live chat activates it
	 * again without importing, subscribing or dispatching twice.
	 */
	start(): Promise<void> {
		this.starting ??= this.runStart();
		return this.starting;
	}

	private async runStart(): Promise<void> {
		try {
			const marker = createContinuousChatLegacyImportMarker(this.runtime.store.rootDir);
			const markerBefore = await marker.read();
			const ledgerBefore = await this.sessionLedger.read();
			const activeIds = new Set(ledgerBefore.active.map((entry) => entry.sessionId));
			await importContinuousChatLegacyHistory({
				source: this.options.legacy,
				marker,
				currentSessionId: this.options.sessionId,
				activeSessionIds: activeIds,
				ingestor: this.ingestor,
				now: () => new Date().toISOString(),
				note: (message) => this.options.warn(message),
			});
			if (this.closed) throw new Error("Continuous chat stopped before it started.");
			await this.recoverPriorSessions(ledgerBefore, markerBefore === undefined);
			if (this.closed) throw new Error("Continuous chat stopped before it started.");
			await this.sessionLedger.recordAttached(this.options.sessionId, this.options.sessionFile);
			if (this.closed) throw new Error("Continuous chat stopped before it started.");
			// Subscribed before the replay, so no durable write falls between the two.
			this.unsubscribe = this.options.subscribeEntriesPersisted((event) =>
				this.ingestor.notifyEntriesPersisted(event),
			);
			this.replayPersisted(this.options.sessionId);
			this.replayed = true;
			this.runtime.start();
			this.started.resolve();
		} catch (error) {
			this.started.reject(error);
			throw error;
		}
	}

	private async recoverPriorSessions(ledger: ContinuousChatSessionsState, firstMigration: boolean): Promise<void> {
		const marker = createContinuousChatLegacyImportMarker(this.runtime.store.rootDir);
		const markerAfter = await marker.read();
		const listing = await this.options.legacy.sessions();
		const activeIds = new Set(ledger.active.map((entry) => entry.sessionId));

		if (firstMigration) {
			const skippedIds = markerAfter?.skipped.map((s) => s.sessionId) ?? [];
			const legacySessionIds = listing.sessions
				.map((s) => s.sessionId)
				.filter((id) => !activeIds.has(id))
				.concat(skippedIds);
			await this.sessionLedger.markSettled(legacySessionIds);
		}

		const toRecover = new Map<string, () => AsyncIterable<SessionEntry>>();

		// An attached session holds live ICM entries that no legacy note replaces. Unlike the legacy import, which records
		// a malformed source as a skip, recovery never drops such a session: a source that cannot be read now (blocked)
		// or never can (invalid) stops the start with its cause. A repaired source recovers through its repaired reader.
		for (const activeEntry of ledger.active) {
			if (activeEntry.sessionId === this.options.sessionId) continue;
			const unreadable =
				listing.blocked.find((entry) => entry.sessionId === activeEntry.sessionId) ??
				listing.invalid.find((entry) => entry.sessionId === activeEntry.sessionId);
			if (unreadable) {
				throw new ContinuousChatMigrationBlockedError(
					`unsettled ICM session ${activeEntry.sessionId} is unreadable: ${unreadable.reason}`,
				);
			}
			const candidate = listing.sessions.find((s) => s.sessionId === activeEntry.sessionId);
			if (candidate) {
				toRecover.set(activeEntry.sessionId, () => candidate.entries());
			} else if (activeEntry.sessionFile && existsSync(activeEntry.sessionFile)) {
				const file = activeEntry.sessionFile;
				// Listed failures are keyed by file name, so the recorded file is classified here by the same reader.
				const reading = await readContinuousChatLegacySessionFile(file);
				if (reading.kind === "blocked" || reading.kind === "invalid") {
					throw new ContinuousChatMigrationBlockedError(
						`unsettled ICM session ${activeEntry.sessionId} is unreadable: ${reading.reason}`,
					);
				}
				if (reading.kind !== "session" || reading.session.sessionId !== activeEntry.sessionId) {
					throw new ContinuousChatMigrationBlockedError(
						`unsettled ICM session ${activeEntry.sessionId} has no matching session source at its recorded path`,
					);
				}
				const session = reading.session;
				toRecover.set(activeEntry.sessionId, () => session.entries());
			} else {
				throw new ContinuousChatMigrationBlockedError(
					`unsettled ICM session ${activeEntry.sessionId} is missing; restore its session source before recovery`,
				);
			}
		}

		if (!firstMigration && markerAfter !== undefined) {
			const completedAtMs = Date.parse(markerAfter.completedAt);
			const settledSet = new Set(ledger.settled);
			const skippedSet = new Set(markerAfter.skipped.map((s) => s.sessionId));

			for (const session of listing.sessions) {
				if (session.sessionId === this.options.sessionId) continue;
				if (settledSet.has(session.sessionId)) continue;
				if (skippedSet.has(session.sessionId)) continue;
				if (Number.isNaN(completedAtMs) || Date.parse(session.timestamp) < completedAtMs) continue;
				if (await this.options.legacy.isForgotten(session.sessionId)) continue;

				if (!toRecover.has(session.sessionId)) {
					toRecover.set(session.sessionId, () => session.entries());
				}
			}
		}

		for (const [sessionId, getEntries] of toRecover) {
			await this.ingestor.importCanonicalSession(sessionId, getEntries());
			await this.ingestor.settled();
			await this.sessionLedger.markSettled([sessionId]);
		}
	}

	/** The chat view a worker born now starts from: see `IcmTurnCoordinator.birthView`. */
	birthView(): { view: string; timestamp: number } | undefined {
		return this.turns.birthView();
	}

	/**
	 * Logs the session's durable entries. A crash can persist an entry before it is logged, and the live subscription
	 * never announces it again. Logging is idempotent, so replaying every durable entry is safe.
	 */
	private replayPersisted(sessionId: string): void {
		const durable = this.options.entryIds().filter((entryId) => this.options.isEntryPersisted(entryId));
		this.ingestor.ingestEntries(sessionId, durable);
	}

	/**
	 * Closes the host's own work, once however it stops: the started gate rejects, live announcements end, and ingestion
	 * refuses new records. Queued records still finish. Idempotent, so a dispose and a runtime stop never both close.
	 */
	private close(reason: string): void {
		if (this.closed) return;
		this.closed = true;
		this.started.reject(new Error(reason));
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.ingestor.dispose();
		this.halt.resolve();
	}

	/**
	 * Ends an active turn, closes the host, lets queued records finish, then stops the runtime. The runtime's stop
	 * releases the project lease on every path, including a host that never started.
	 */
	async dispose(): Promise<void> {
		const cleanStop = !this.closed && this.replayed;
		const active = this.turns.current();
		if (active !== undefined) this.turns.end(active);
		this.close("Continuous chat was disposed before it started.");
		try {
			await this.ingestor.settled();
			if (cleanStop) await this.sessionLedger.markSettled([this.options.sessionId]);
		} catch {
			// Leave the session active in sessions.json so any unlogged durable entries are recovered next start.
		} finally {
			await this.runtime.stop();
		}
	}
}
