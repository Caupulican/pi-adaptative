/**
 * Composition root of ICM's project chat. The memory controller owns one host per ICM root session generation.
 * `open` opens the runtime, which takes the project's lease; nothing is imported,
 * subscribed or dispatched yet. `start` then finishes the legacy import, subscribes live announcements, replays the
 * durable entries and starts dispatch. Nothing else appends to the chat or dispatches its work.
 */

import { existsSync } from "node:fs";
import {
	type ParentInputConsumptionSource,
	parentInputOriginalDetails,
} from "../../kernel/session/parent-input-ledger.ts";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import type { SessionEntriesPersistedEvent } from "../../kernel/session/session-manager.ts";
import type { AgentMessage } from "../../kernel/types.ts";
import { BACKGROUND_TOOL_COMPLETION_TYPE } from "../background-tool-handoff-text.ts";
import { backgroundToolInvocationObservations } from "../background-tool-task-controller.ts";
import { liveWorkerHandoffOf } from "../delegation/worker-handoff-provenance.ts";
import type { TimerPort } from "../util/timer-port.ts";
import type { ContinuousChatCompactionAdapterPort } from "./continuous-chat-compaction-adapter.ts";
import { ContinuousChatIngestor, type LiveWorkerReportArrival } from "./continuous-chat-ingest.ts";
import {
	type ContinuousChatLegacyEntrySource,
	type ContinuousChatLegacySource,
	importContinuousChatLegacyHistory,
} from "./continuous-chat-legacy-import.ts";
import {
	ContinuousChatMigrationBlockedError,
	type ContinuousChatSessionLedger,
	type ContinuousChatSessionsState,
	createContinuousChatLegacyImportMarker,
	createContinuousChatSessionLedger,
	readContinuousChatLegacySessionFile,
} from "./continuous-chat-migration.ts";
import {
	currentParentInputSource,
	reconcileParentInputHistory,
	stageParentInputReconciliation,
} from "./continuous-chat-parent-reconciliation.ts";
import { type ContinuousChatProjectionSource, renderContinuousChatTurnState } from "./continuous-chat-projection.ts";
import {
	type ContinuousChatCompactionPrefixHead,
	ContinuousChatRuntime,
	type ContinuousChatRuntimeOptions,
	type ContinuousChatTurnBoundary,
} from "./continuous-chat-runtime.ts";
import { ContinuousChatStore } from "./continuous-chat-store.ts";
import type { ContinuousChatPort } from "./continuous-chat-tools.ts";
import { continuousChatNodeFirstMessage, continuousChatNodeMessageCount } from "./continuous-chat-tree.ts";
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
	readLiveBranchMessageEntry?(message: AgentMessage): SessionEntry | undefined;
	isLiveBranchEntry?(entryId: string): boolean;
	getParentInputConsumptionSource(): ParentInputConsumptionSource;
	/** The session's entry ids in order, and whether each one is durably written to the session file. */
	entryIds(): readonly string[];
	isEntryPersisted(entryId: string): boolean;
	/** The work-claim release backoff's timers. Absent: the system's. */
	timers?: TimerPort;
	/**
	 * Aborts when the session closes; the compaction port admits no request after it. The runtime then claims nothing new
	 * and releases a running compaction that the refusal ends, instead of recording it as failed
	 * (see `ContinuousChatRuntimeOptions.closing`).
	 */
	closing: AbortSignal;
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
	warn: ContinuousChatRuntimeOptions["warn"];
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
	private readonly startupAbort = new AbortController();
	private unsubscribe: (() => void) | undefined;
	private starting: Promise<void> | undefined;
	private disposal: Promise<void> | undefined;
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
		// Summaries wait for this host's turns: the runtime learns their phase from the coordinator that owns it.
		parts.runtime.followForeground({
			isForegroundBusy: () => parts.turns.phase() !== "idle",
			subscribeForegroundActivity: (listener) => parts.turns.subscribe(() => listener()),
		});
		this.port = parts.port;
		this.options = parts.options;
		this.started = parts.started;
		this.halt = createSettlement();
		this.stopped = this.halt.promise;
		// The runtime stops on its own only when its lease is lost; a stop through `dispose` has already closed the host.
		void parts.runtime.stopped.then(() => this.close("Continuous chat stopped with its runtime."));
	}

	/** The live projection is confined to one session generation; third-party turns never seed or extend its retained prefix. */
	projectionSource(
		sessionId: () => string,
		ownerScope: () => boolean,
		allowsHistoryTokens: ContinuousChatProjectionSource["allowsHistoryTokens"],
	): ContinuousChatProjectionSource {
		const restricted = new WeakSet<object>();
		let rendered:
			| { boundary: ContinuousChatTurnBoundary; reports: readonly LiveWorkerReportArrival[]; text: string }
			| undefined;
		return {
			current: () => {
				const handle = this.turns.current();
				if (!handle || this.closed || this.turns.phase() !== "running" || sessionId() !== this.options.sessionId)
					return undefined;
				if (!ownerScope()) restricted.add(handle);
				return { handle, stateText: renderContinuousChatTurnState(handle) };
			},
			allowsHistoryTokens,
			readLiveTerminalReceipt: (message) => {
				if (this.closed || sessionId() !== this.options.sessionId || message.role !== "custom") return undefined;
				if (message.customType !== BACKGROUND_TOOL_COMPLETION_TYPE || typeof message.content !== "string")
					return undefined;
				const entry = this.options.readLiveBranchMessageEntry?.(message);
				if (
					entry?.type !== "custom_message" ||
					entry.customType !== message.customType ||
					entry.details !== message.details ||
					entry.content !== message.content
				)
					return undefined;
				const observations = backgroundToolInvocationObservations(
					{
						customType: entry.customType,
						details: parentInputOriginalDetails(entry) ?? entry.details,
					},
					{ requireCompleteBatch: true },
				);
				return observations.length > 0 ? observations.map(({ toolCallId }) => toolCallId) : undefined;
			},
			readLiveHandoffAttempts: (message) => {
				if (this.closed || sessionId() !== this.options.sessionId || message.role !== "custom") return undefined;
				const handoff = liveWorkerHandoffOf(message.details, message.content);
				if (!handoff) return undefined;
				const canonical = this.options.readLiveBranchMessageEntry?.(message);
				return canonical?.type === "custom_message" &&
					canonical.customType === message.customType &&
					canonical.details === message.details &&
					canonical.content === message.content
					? handoff.attemptIds
					: undefined;
			},
			proveContinuation: (previous, next, history, opening) => {
				if (
					this.closed ||
					sessionId() !== this.options.sessionId ||
					!ownerScope() ||
					this.turns.current() !== next ||
					restricted.has(previous) ||
					restricted.has(next) ||
					previous.turnId + 1 !== next.turnId ||
					previous.boundary.visibility.key !== next.boundary.visibility.key ||
					!next.boundary.visibility.isCurrent() ||
					!previous.boundary.visibility.isCurrent()
				)
					return undefined;
				const handoff =
					opening?.role === "custom" ? liveWorkerHandoffOf(opening.details, opening.content) : undefined;
				const isReportOnBranch = this.options.isLiveBranchEntry;
				const reportAuthority =
					handoff && isReportOnBranch ? { attemptIds: handoff.attemptIds, isReportOnBranch } : undefined;
				const arrivals = this.ingestor.proveLiveArrivals(
					this.options.sessionId,
					previous.boundary.totalMessages,
					next.boundary.totalMessages,
					history,
					reportAuthority,
				);
				if (!arrivals) return undefined;
				if (handoff) {
					const terminal = history.at(-1);
					if (!terminal || this.options.readLiveBranchMessageEntry?.(terminal)?.type !== "message")
						return undefined;
				}
				if (!arrivals.reports.length) return {};
				const { boundary } = next;
				const { reports, isCurrent } = arrivals;
				if (
					rendered?.boundary !== boundary ||
					rendered.reports.length !== reports.length ||
					!rendered.reports.every(
						(row, i) =>
							row.id === reports[i]!.id &&
							row.attemptId === reports[i]!.attemptId &&
							row.name === reports[i]!.name,
					)
				) {
					const text = renderRetainedWorkerReports(boundary, reports);
					if (text === undefined) return undefined;
					rendered = { boundary, reports, text };
				}
				const { visibility } = boundary;
				return { work: { text: rendered.text, isCurrent: () => visibility.isCurrent() && isCurrent() } };
			},
		};
	}

	/**
	 * Opens the runtime independently of summary-model availability. Opening takes the project's lease and fails once, with the
	 * runtime's error, when a live session already holds it. A failure after the runtime opens releases the lease.
	 */
	static async open(options: ContinuousChatHostOptions, signal?: AbortSignal): Promise<ContinuousChatHost> {
		signal?.throwIfAborted();
		// Before the runtime opens: no compaction can resolve the pre-activation prefix a reloaded session accepted.
		options.resetCompactionPrefix();
		signal?.throwIfAborted();
		const store = new ContinuousChatStore({
			agentDir: options.agentDir,
			projectKey: options.projectKey,
			warn: options.warn,
		});
		// Takes the project's lease. A live owner refuses it once (`ContinuousChatLeaseHeldError`), before anything opens.
		const runtime = await ContinuousChatRuntime.open(
			{
				store,
				port: options.compaction,
				prefixHead: () => options.prefixHead(),
				warn: options.warn,
				label: options.sessionId,
				closing: options.closing,
				...(options.timers !== undefined ? { timers: options.timers } : {}),
			},
			signal,
		);
		try {
			signal?.throwIfAborted();
			const sessionLedger = createContinuousChatSessionLedger(runtime.store);
			await sessionLedger.recordAttached(options.sessionId, options.sessionFile, signal);
			signal?.throwIfAborted();
			const started = createSettlement();
			const ingestor = new ContinuousChatIngestor({
				appender: runtime,
				readEntry: (entryId) => options.readEntry(entryId),
				getParentInputConsumptionSource: () => options.getParentInputConsumptionSource(),
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
		if (this.closed) return Promise.reject(new Error("Continuous chat cannot start after it has closed."));
		this.starting ??= this.runStart();
		return this.starting;
	}

	private async runStart(): Promise<void> {
		const signal = this.startupAbort.signal;
		try {
			const marker = createContinuousChatLegacyImportMarker(this.runtime.store);
			const markerBefore = await marker.read(signal);
			const ledgerBefore = await this.sessionLedger.read(signal);
			signal.throwIfAborted();
			await stageParentInputReconciliation(this.runtime.store, signal);
			const activeIds = new Set(ledgerBefore.active.map((entry) => entry.sessionId));
			await importContinuousChatLegacyHistory({
				source: this.options.legacy,
				marker,
				currentSessionId: this.options.sessionId,
				activeSessionIds: activeIds,
				signal,
				ingestor: this.ingestor,
				now: () => new Date().toISOString(),
				note: (message) => this.options.warn(message),
			});
			if (this.closed) throw new Error("Continuous chat stopped before it started.");
			await this.recoverPriorSessions(ledgerBefore, markerBefore === undefined);
			if (this.closed) throw new Error("Continuous chat stopped before it started.");
			await reconcileParentInputHistory(
				{
					projection: this.runtime.store,
					legacy: this.options.legacy,
					ingestor: this.ingestor,
					currentSessionId: this.options.sessionId,
					openCurrent: () =>
						currentParentInputSource({
							getSource: () => this.options.getParentInputConsumptionSource(),
							entryIds: () => this.options.entryIds(),
							isEntryPersisted: (id) => this.options.isEntryPersisted(id),
							readEntry: (id) => this.options.readEntry(id),
						}),
					active: ledgerBefore.active,
					settled: (await this.sessionLedger.read(signal)).settled,
					legacyImport: await marker.read(signal),
					warn: this.options.warn,
				},
				signal,
			);
			await this.sessionLedger.recordAttached(this.options.sessionId, this.options.sessionFile, signal);
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
		const signal = this.startupAbort.signal;
		const marker = createContinuousChatLegacyImportMarker(this.runtime.store);
		const markerAfter = await marker.read(signal);
		const listing = await this.options.legacy.sessions(signal);
		signal.throwIfAborted();
		const activeIds = new Set(ledger.active.map((entry) => entry.sessionId));

		if (firstMigration) {
			const skippedIds = markerAfter?.skipped.map((s) => s.sessionId) ?? [];
			const legacySessionIds = listing.sessions
				.map((s) => s.sessionId)
				.filter((id) => !activeIds.has(id))
				.concat(skippedIds);
			await this.sessionLedger.markSettled(legacySessionIds, signal);
		}

		const toRecover = new Map<string, () => Promise<ContinuousChatLegacyEntrySource>>();

		// An attached session holds live ICM entries that no legacy note replaces. Unlike the legacy import, which records
		// a malformed source as a skip, recovery never drops such a session: a source that cannot be read now (blocked)
		// or never can (invalid) stops the start with its cause. A repaired source recovers through its repaired reader.
		for (const activeEntry of ledger.active) {
			signal.throwIfAborted();
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
				toRecover.set(activeEntry.sessionId, () => candidate.openEntries(signal));
			} else if (activeEntry.sessionFile && existsSync(activeEntry.sessionFile)) {
				const file = activeEntry.sessionFile;
				// Listed failures are keyed by file name, so the recorded file is classified here by the same reader.
				const reading = await readContinuousChatLegacySessionFile(file, signal);
				signal.throwIfAborted();
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
				toRecover.set(activeEntry.sessionId, () => session.openEntries(signal));
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
				signal.throwIfAborted();
				if (session.sessionId === this.options.sessionId) continue;
				if (settledSet.has(session.sessionId)) continue;
				if (skippedSet.has(session.sessionId)) continue;
				if (Date.parse(session.timestamp) < completedAtMs) continue;
				const forgotten = await this.options.legacy.isForgotten(session.sessionId, signal);
				signal.throwIfAborted();
				if (forgotten) continue;

				if (!toRecover.has(session.sessionId)) {
					toRecover.set(session.sessionId, () => session.openEntries(signal));
				}
			}
		}

		for (const [sessionId, openEntries] of toRecover) {
			signal.throwIfAborted();
			const source = await openEntries();
			try {
				await this.ingestor.importCanonicalSession(sessionId, source, signal);
			} finally {
				await source.close();
			}
			await this.ingestor.settled();
			signal.throwIfAborted();
			await this.sessionLedger.markSettled([sessionId], signal);
		}
		signal.throwIfAborted();
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
		const error = new Error(reason);
		this.startupAbort.abort(error);
		this.started.reject(error);
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.ingestor.dispose();
		this.halt.resolve();
	}

	/**
	 * Ends an active turn, closes the host, lets queued records finish, then stops the runtime. The runtime's stop
	 * releases the project lease on every path, including a host that never started.
	 */
	dispose(): Promise<void> {
		if (!this.disposal) {
			const disposal = createSettlement();
			this.disposal = disposal.promise;
			void this.stop().then(disposal.resolve, disposal.reject);
		}
		return this.disposal;
	}

	private async stop(): Promise<void> {
		const cleanStop = !this.closed && this.replayed;
		const active = this.turns.current();
		if (active !== undefined) this.turns.end(active);
		this.close("Continuous chat was disposed before it started.");
		try {
			// Startup also owns metadata writes that are not ingestor tasks. Keep its lease
			// until those writes settle, even when closing causes startup to reject.
			await this.starting?.catch(() => undefined);
			await this.ingestor.settled();
			if (cleanStop) await this.sessionLedger.markSettled([this.options.sessionId]);
		} catch {
			// Leave the session active in sessions.json so any unlogged durable entries are recovered next start.
		} finally {
			await this.runtime.stop();
		}
	}
}

/** Preserve the exact pinned rows covering the new work, including any built summary, once per coordinate. */
function renderRetainedWorkerReports(
	boundary: ContinuousChatTurnBoundary,
	reports: readonly LiveWorkerReportArrival[],
): string | undefined {
	const lines = boundary.view.split("\n");
	if (lines.shift() !== "<chat>" || lines.pop() !== "</chat>" || lines.length !== boundary.viewCache.lines.length)
		return undefined;
	const rows: string[] = [];
	let reportIndex = 0;
	for (const [index, coordinate] of boundary.viewCache.lines.entries()) {
		if (reportIndex === reports.length) break;
		const first = continuousChatNodeFirstMessage(coordinate);
		const end = first + continuousChatNodeMessageCount(coordinate.level);
		const nextReport = reports[reportIndex]!;
		if (nextReport.id < first) return undefined;
		if (nextReport.id >= end) continue;
		rows.push(lines[index]!);
		do {
			const report = reports[reportIndex++]!;
			rows.push(`Background work [${report.name}], chat ID ${report.id}: zoom({id:${report.id},n:1,page:0})`);
		} while (reportIndex < reports.length && reports[reportIndex]!.id < end);
	}
	return reportIndex === reports.length ? rows.join("\n") : undefined;
}
