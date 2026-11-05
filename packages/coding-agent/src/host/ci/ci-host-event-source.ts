import { randomUUID } from "node:crypto";
import { existsSync, type FSWatcher, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	type CiAttemptTerminalEvent,
	type CiCurrentObservation,
	type CiSubject,
	ciEventSubject,
	ciSubjectKey,
	HostEventError,
	type HostEventSealObservation,
	type HostEventSink,
	type HostEventSource,
	type HostEventSourceConnection,
	hostEventHash,
	isCiEnvelope,
	MAX_HOST_EVENT_SUBJECTS,
} from "../../core/events/host-event-contract.ts";
import { HOST_EVENT_KINDS } from "../../core/events/host-event-kinds.ts";
import { boundedRedactedDiagnosticText } from "../../core/security/secret-text.ts";
import { closeWatcher, FS_WATCH_RETRY_DELAY_MS, watchWithErrorHandler } from "../../utils/fs-watch.ts";
import type { CiProvider, CiRepository } from "./ci-provider.ts";
import { CiRunMonitor } from "./ci-run-monitor.ts";
import {
	type CiSourceSnapshot,
	CiSourceStore,
	CiSourceVersionError,
	ciSourceRetainedAttempts,
	ciSourceRetiredRuns,
} from "./ci-source-store.ts";
import {
	CI_REGISTRATION_GRACE_MS,
	CI_WORKFLOW,
	type CiGitPaths,
	type CiStatusRecord,
	ciWatcherAlive,
	completedCiStatus,
	readCiHead,
	readCiStatusRecords,
	resolveCiGitPathsAsync,
	writeCiStatus,
} from "./ci-status-record.ts";
import { createCiCommandPort, GithubActionsCiProvider, isCiCommandMissing } from "./github-actions-ci-provider.ts";

// Discover upstream runs/reruns that have no local filesystem event. Known runs use terminal monitors.
const CI_DISCOVERY_INTERVAL_MS = 2 * 60 * 1000;
/** Consecutive failed reconciles double the discovery delay up to this bound. */
const CI_DISCOVERY_MAX_INTERVAL_MS = 30 * 60 * 1000;
/** Failed reconciles in a row, once the repository resolved, before the source reports itself suspended. */
const CI_SUSPEND_AFTER_FAILURES = 3;
const COMMIT_SHA = /^(?:[a-f\d]{40}|[a-f\d]{64})$/;
const ACCEPT_BATCH = 32;

export interface CiHostRuntime {
	readonly source: HostEventSource;
	/** Fires when a watched local CI input changed; the footer re-reads its file projection. */
	subscribeStatus(listener: () => void): () => void;
}

export interface CiHostRuntimeOptions {
	readonly cwd: string;
	readonly onDiagnostic: (message: string) => void;
	readonly provider?: CiProvider;
	readonly paths?: CiGitPaths;
	readonly store?: CiSourceStore;
	readonly signal?: AbortSignal;
	readonly getSubscribedSubjects?: () => readonly CiSubject[];
	readonly subscribeSubjects?: (listener: () => void) => () => void;
}

interface CiLocalInputs {
	readonly headSha?: string;
	readonly headBranch?: string;
	readonly refDirectory: string;
	readonly records: readonly CiStatusRecord[];
	/** Revisions whose watcher has not recorded an outcome (pending or watch_failed). */
	readonly unsettled: readonly string[];
	readonly subscribed: readonly CiSubject[];
	readonly fingerprint: string;
}

function inputFingerprint(
	head: Pick<CiLocalInputs, "headSha" | "headBranch" | "refDirectory">,
	records: readonly CiStatusRecord[],
	subscribed: readonly CiSubject[],
): string {
	return JSON.stringify([
		head.headSha,
		head.headBranch,
		head.refDirectory,
		records
			.map((record) =>
				JSON.stringify([
					record.branch,
					record.sha,
					record.state,
					record.runId,
					record.runAttempt,
					record.conclusion,
				]),
			)
			.sort(),
		subscribed.map(ciSubjectKey).sort(),
	]);
}

function sameSubjects(left: readonly CiSubject[], right: readonly CiSubject[]): boolean {
	return JSON.stringify(left.map(ciSubjectKey).sort()) === JSON.stringify(right.map(ciSubjectKey).sort());
}

function addSubject(list: CiSubject[], subject: CiSubject): void {
	if (!list.some((existing) => ciSubjectKey(existing) === ciSubjectKey(subject))) list.push(subject);
}

function errorText(error: unknown): string {
	return (
		boundedRedactedDiagnosticText(error instanceof Error ? error.message : String(error)) ?? "CI source unavailable"
	);
}

/** The repository could not be resolved upstream: the source waits for its connection. */
class CiRepositoryUnavailableError extends Error {}

/**
 * This resource's owner must stop it before disposing its session's durable event sink.
 *
 * A reconcile commits a new catch-up generation only when its scope changed, retained events are
 * pending, or the collected current observations differ from the last seal. A reconcile that
 * observes nothing new commits nothing and leaves the sealed source ready.
 */
class CiHostEventSource implements HostEventSource, CiHostRuntime {
	readonly source: HostEventSource = this;
	private readonly paths: CiGitPaths;
	private readonly provider: CiProvider;
	private readonly store: CiSourceStore;
	private readonly diagnostic: (message: string) => void;
	private readonly listeners = new Set<() => void>();
	private readonly lifetimeSignal?: AbortSignal;
	private readonly getSubscribedSubjects: () => readonly CiSubject[];
	private readonly subscribeSubjects?: (listener: () => void) => () => void;
	/** Last reported text per diagnostic key: a repeating failure is reported once until it changes. */
	private readonly reported = new Map<string, string>();
	private watchers: FSWatcher[] = [];
	private watchDirectories = "";
	private abort?: AbortController;
	private sink?: HostEventSink;
	private unsubscribeWritable?: () => void;
	private unsubscribeSubjects?: () => void;
	private subjectFingerprint = "";
	private draining?: Promise<void>;
	/** A watched file changed; reconcile only if the local inputs differ from the last reconcile. */
	private dirty = false;
	/** A trigger that needs remote discovery regardless of local inputs. */
	private forced = false;
	/** The sink refused for runtime replacement; its admission signal re-requests. */
	private sinkBlocked = false;
	/** The journal belongs to a newer release. */
	private dormant = false;
	/** Failed reconciles in a row (backoff), and those after the repository resolved (suspension). */
	private failures = 0;
	private reconcileFailures = 0;
	/** `state:reason` last reported to the sink; "" is armed, undefined nothing reported by this start. */
	private connectionKey?: string;
	private lastInputs?: string;
	private watchRetry?: ReturnType<typeof setTimeout>;
	private discoveryTimer?: ReturnType<typeof setTimeout>;
	private activationId?: string;
	private sourceId?: string;
	private monitor?: CiRunMonitor;
	private claimed?: { consumerId: string; activationId: string };
	/** This activation has begun a generation; the first reconcile of every activation begins one. */
	private opened = false;
	private sealed?: { generation: number; observed: string };
	private retiredSent?: number;

	constructor(
		paths: CiGitPaths,
		provider: CiProvider,
		store: CiSourceStore,
		diagnostic: (message: string) => void,
		options: Pick<CiHostRuntimeOptions, "signal" | "getSubscribedSubjects" | "subscribeSubjects"> = {},
	) {
		this.paths = paths;
		this.provider = provider;
		this.store = store;
		this.diagnostic = diagnostic;
		this.lifetimeSignal = options.signal;
		this.getSubscribedSubjects = options.getSubscribedSubjects ?? (() => []);
		this.subscribeSubjects = options.subscribeSubjects;
	}

	/** Local setup only: consumer activation, git reads and network discovery run in the reconcile. */
	async start(sink: HostEventSink): Promise<void> {
		await this.stop();
		this.reported.clear();
		this.sink = sink;
		this.abort = new AbortController();
		this.monitor = new CiRunMonitor(
			this.provider,
			this.signal()!,
			() => this.request(true),
			(error) => this.report("monitor", `CI run watch ended without a result: ${errorText(error)}`),
		);
		this.unsubscribeWritable = sink.subscribeWritable(() => {
			if (this.sinkBlocked) this.request(true);
		});
		this.subjectFingerprint = this.subscribedFingerprint();
		this.unsubscribeSubjects = this.subscribeSubjects?.(() => {
			const fingerprint = this.subscribedFingerprint();
			if (fingerprint === this.subjectFingerprint) return;
			this.subjectFingerprint = fingerprint;
			this.request(true);
		});
		mkdirSync(this.paths.statusDir, { recursive: true });
		this.armWatchers();
		this.request(true);
	}

	async stop(): Promise<void> {
		const sink = this.sink;
		const monitor = this.monitor;
		this.monitor = undefined;
		this.abort?.abort(new Error("CI event source stopped."));
		this.abort = undefined;
		if (this.watchRetry) clearTimeout(this.watchRetry);
		this.watchRetry = undefined;
		if (this.discoveryTimer) clearTimeout(this.discoveryTimer);
		this.discoveryTimer = undefined;
		this.sink = undefined;
		this.unsubscribeWritable?.();
		this.unsubscribeWritable = undefined;
		this.unsubscribeSubjects?.();
		this.unsubscribeSubjects = undefined;
		for (const watcher of this.watchers) closeWatcher(watcher);
		this.watchers = [];
		this.watchDirectories = "";
		this.dirty = false;
		this.forced = false;
		this.sinkBlocked = false;
		this.dormant = false;
		this.failures = 0;
		this.reconcileFailures = 0;
		this.connectionKey = undefined;
		this.lastInputs = undefined;
		this.opened = false;
		this.sealed = undefined;
		this.retiredSent = undefined;
		const errors: unknown[] = [];
		try {
			await monitor?.stop();
			await this.draining;
		} catch (error) {
			errors.push(error);
		}
		// Activation happens inside the reconcile: read custody only after it has been joined.
		const sourceId = this.sourceId;
		const claimed = this.claimed;
		this.sourceId = undefined;
		this.activationId = undefined;
		try {
			if (sink && sourceId) await sink.deactivate(sourceId);
		} catch (error) {
			errors.push(error);
		}
		if (claimed) {
			try {
				this.store.release(claimed.consumerId, claimed.activationId);
				if (this.claimed === claimed) this.claimed = undefined;
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length) throw new AggregateError(errors, "CI event source shutdown failed.");
	}

	subscribeStatus(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private signal(): AbortSignal | undefined {
		if (!this.abort) return undefined;
		return this.lifetimeSignal ? AbortSignal.any([this.abort.signal, this.lifetimeSignal]) : this.abort.signal;
	}

	private subscribedFingerprint(): string {
		return JSON.stringify(this.getSubscribedSubjects().map(ciSubjectKey).sort());
	}

	private report(key: string, message: string): void {
		const text = boundedRedactedDiagnosticText(message) ?? "CI source unavailable";
		if (this.reported.get(key) === text) return;
		this.reported.set(key, text);
		try {
			this.diagnostic(text);
		} catch {
			/* Diagnostics never consume custody. */
		}
	}

	private armWatchers(refDirectory?: string): void {
		let references = refDirectory;
		if (references === undefined) {
			try {
				references = readCiHead(this.paths).refDirectory;
			} catch {
				// An unreadable HEAD is reported by the reconcile; its directories are still observed.
				references = this.paths.commonDir;
			}
		}
		const directories = [...new Set([this.paths.statusDir, this.paths.gitDir, this.paths.commonDir, references])];
		const key = JSON.stringify(directories);
		if (key === this.watchDirectories) return;
		for (const watcher of this.watchers) closeWatcher(watcher);
		this.watchers = [];
		this.watchDirectories = key;
		for (const directory of directories) {
			const watcher = watchWithErrorHandler(
				directory,
				(_event, filename) => {
					if (filename && !this.relevant(directory, references, filename)) return;
					this.request(false);
				},
				() => {
					this.watchDirectories = "";
					this.report(
						"watch",
						"CI filesystem observation is unavailable; retained events will replay at recovery.",
					);
					if (!this.watchRetry && this.abort) {
						this.watchRetry = setTimeout(() => {
							this.watchRetry = undefined;
							this.request(true);
						}, FS_WATCH_RETRY_DELAY_MS);
						this.watchRetry.unref();
					}
				},
			);
			if (watcher) this.watchers.push(watcher);
		}
	}

	/** Only HEAD, branch references and status records are inputs; index and object writes are not. */
	private relevant(directory: string, refDirectory: string, filename: string): boolean {
		if (directory === this.paths.statusDir) return filename.endsWith(".json");
		if (filename.includes(".lock") || filename.includes(".tmp")) return false;
		// The allow-lists apply first: a detached HEAD or a packed-only branch names one of these
		// directories as its reference directory, where index, logs and fetch heads are also written.
		if (directory === this.paths.commonDir) return ["HEAD", "packed-refs", "refs"].includes(filename);
		// A linked worktree's own git directory: only its HEAD names the checked-out revision.
		if (directory === this.paths.gitDir) return filename === "HEAD";
		return directory === refDirectory;
	}

	private request(forced: boolean): void {
		if (!this.abort || !this.sink || this.dormant) return;
		if (forced) this.forced = true;
		else this.dirty = true;
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				/* Independent display observer. */
			}
		}
		if (this.draining) return;
		if (this.discoveryTimer) clearTimeout(this.discoveryTimer);
		this.discoveryTimer = undefined;
		const signal = this.signal()!;
		const sink = this.sink;
		this.draining = this.drain(sink, signal).finally(() => {
			this.draining = undefined;
			if (signal.aborted || this.dormant) return;
			if (this.dirty || this.forced) this.request(this.forced);
			else {
				this.discoveryTimer = setTimeout(
					() => {
						this.discoveryTimer = undefined;
						this.request(true);
					},
					Math.min(CI_DISCOVERY_INTERVAL_MS * 2 ** Math.max(0, this.failures - 1), CI_DISCOVERY_MAX_INTERVAL_MS),
				);
				this.discoveryTimer.unref();
			}
		});
	}

	private async drain(sink: HostEventSink, signal: AbortSignal): Promise<void> {
		while ((this.dirty || this.forced) && !signal.aborted && !this.dormant) {
			const forced = this.forced;
			this.dirty = false;
			this.forced = false;
			// Own status writes and unrelated git activity leave the inputs unchanged: no network.
			if (!forced && this.lastInputs !== undefined && this.fingerprint() === this.lastInputs) continue;
			this.sinkBlocked = false;
			try {
				await this.reconcile(sink, signal);
				this.failures = 0;
				this.reconcileFailures = 0;
				this.connect(undefined);
			} catch (error) {
				if (signal.aborted) return;
				// Any later input change or the discovery timer retries, with a growing delay; foreground activity does not.
				this.lastInputs = undefined;
				if (error instanceof CiSourceVersionError) {
					this.dormant = true;
					this.report("source", `CI event source inactive: ${errorText(error)}`);
					return;
				}
				if (error instanceof HostEventError && error.code === "runtime_replacing") {
					// Runtime replacement re-requests through the sink's admission signal; it is no upstream failure.
					this.sinkBlocked = true;
					this.report("reconcile", `CI events remain pending: ${errorText(error)}`);
					continue;
				}
				this.failures++;
				if (isCiCommandMissing(error))
					// The footer still reads local records; installing the command resumes events at the next retry.
					this.connect({
						state: "waiting",
						reason: "command-missing",
						text: "CI results are not followed: the gh command is not installed. They start by themselves once gh is installed and signed in.",
					});
				else if (error instanceof CiRepositoryUnavailableError)
					this.connect({
						state: "waiting",
						reason: "repository-unavailable",
						text: `CI results are waiting for GitHub: the repository could not be resolved (${errorText(error)}). They resume by themselves when it answers.`,
					});
				else {
					this.report("reconcile", `CI events remain pending: ${errorText(error)}`);
					if (++this.reconcileFailures >= CI_SUSPEND_AFTER_FAILURES)
						this.connect({
							state: "suspended",
							reason: "reconcile-failing",
							text: `CI results are suspended after ${this.reconcileFailures} failed checks in a row (${errorText(error)}). They retry by themselves at least once every 30 minutes.`,
						});
				}
			}
		}
	}

	/** One durable record and one sink report per connection transition. */
	private connect(connection: HostEventSourceConnection | undefined): void {
		const key = connection ? `${connection.state}:${connection.reason}` : "";
		if (key === this.connectionKey) return;
		this.connectionKey = key;
		const claimed = this.claimed;
		try {
			if (claimed) this.store.recordConnection(claimed.consumerId, claimed.activationId, connection);
		} catch (error) {
			this.report("connection", `CI connection state was not saved: ${errorText(error)}`);
		}
		this.sink?.reportConnection(HOST_EVENT_KINDS["ci-attempt-terminal"].source, connection);
	}

	private fingerprint(): string | undefined {
		try {
			return this.inputs().fingerprint;
		} catch {
			return undefined;
		}
	}

	private inputs(): CiLocalInputs {
		const head = readCiHead(this.paths);
		const records = readCiStatusRecords(this.paths.statusDir);
		const unsettled = [
			...new Set(
				records.flatMap((record) =>
					(record.state === "pending" || record.state === "watch_failed") &&
					record.sha &&
					COMMIT_SHA.test(record.sha)
						? [record.sha]
						: [],
				),
			),
		].sort();
		const subscribed = this.getSubscribedSubjects().map((subject) => ({ ...subject }));
		const local = {
			...(head.sha ? { headSha: head.sha } : {}),
			...(head.branch ? { headBranch: head.branch } : {}),
			refDirectory: head.refDirectory,
		};
		return { ...local, records, unsettled, subscribed, fingerprint: inputFingerprint(local, records, subscribed) };
	}

	private async reconcile(sink: HostEventSink, signal: AbortSignal): Promise<void> {
		const inputs = this.inputs();
		this.armWatchers(inputs.refDirectory);
		const activationId = await this.activate(sink, signal);
		let repository: CiRepository;
		try {
			repository = await this.provider.repository(signal);
		} catch (error) {
			signal.throwIfAborted();
			if (isCiCommandMissing(error)) throw error;
			throw new CiRepositoryUnavailableError(errorText(error), { cause: error });
		}
		signal.throwIfAborted();
		let snapshot = this.store.snapshot();
		let consumer = this.consumer(snapshot, sink.consumerId, activationId);
		if (!consumer) return;
		const { subjects: scope, required } = this.scope(repository, inputs, snapshot, consumer.acknowledged);
		if (!scope.length) {
			// No revision to observe (unborn HEAD, nothing subscribed or unsettled) and nothing retained.
			this.monitor?.reconcile([]);
			this.lastInputs = inputs.fingerprint;
			return;
		}
		const roots = inputs.headSha ? [this.subjectOf(repository, inputs.headSha)] : [];
		if (
			!this.opened ||
			consumer.pendingStart ||
			consumer.pendingGap ||
			!sameSubjects(consumer.subjects, scope) ||
			!sameSubjects(consumer.rootSubjects, roots)
		)
			await this.open(sink, activationId, scope, roots, signal);

		// Collection is isolated per subject: one failing revision cannot discard another's evidence.
		// Only a revision a delivery can target (HEAD, subscribed, unaccepted events) blocks the seal;
		// an unsettled watcher record that cannot be observed is reported and sealed without observation.
		const retainedAttempts = ciSourceRetainedAttempts(snapshot);
		const observations: CiCurrentObservation[] = [];
		const events = new Map<string, CiAttemptTerminalEvent>();
		const runless = new Set<string>();
		const unresolved = new Set<string>();
		const failures: string[] = [];
		for (const subject of scope) {
			if (!this.ownWorkflow(repository, subject)) continue;
			const key = ciSubjectKey(subject);
			try {
				const collection = await this.provider.collect(
					subject.headSha,
					signal,
					retainedAttempts,
					ciSourceRetiredRuns(snapshot, subject),
				);
				if (ciSubjectKey(collection.subject) !== key) throw new Error("CI provider returned a different subject.");
				this.store.retain(collection.events);
				this.reported.delete(`subject:${key}`);
				for (const event of collection.events) events.set(event.eventId, event);
				if (collection.current) observations.push(collection.current);
				else if (!collection.predatesRetention && !collection.events.length) runless.add(subject.headSha);
				if (collection.predatesRetention)
					this.report(
						`retention:${key}`,
						`CI history of ${subject.headSha.slice(0, 9)} predates the retained replay horizon; its current result is not observed.`,
					);
			} catch (error) {
				signal.throwIfAborted();
				if (isCiCommandMissing(error)) throw error;
				unresolved.add(key);
				const failure = `${subject.headSha.slice(0, 9)}: ${errorText(error)}`;
				if (required.has(key)) failures.push(failure);
				else this.report(`subject:${key}`, `CI result of an unsettled push is unavailable: ${failure}`);
			}
		}
		signal.throwIfAborted();
		this.monitor?.reconcile(observations, unresolved);
		if (failures.length) throw new Error(`CI collection failed for ${failures.join("; ")}`);
		if (this.fingerprint() !== inputs.fingerprint) {
			this.forced = true;
			return;
		}
		observations.sort((a, b) => ciSubjectKey(a.subject).localeCompare(ciSubjectKey(b.subject)));
		const observed = JSON.stringify(observations);
		snapshot = this.store.snapshot();
		consumer = this.consumer(snapshot, sink.consumerId, activationId);
		if (!consumer) return;
		let pending = snapshot.events.filter((event) => event.sourceSequence > consumer!.acknowledged);
		if (
			this.sealed &&
			this.sealed.generation === consumer.generation &&
			this.sealed.observed === observed &&
			pending.length === 0
		) {
			await this.settle(sink, snapshot, inputs, observations, events, runless, signal);
			return;
		}
		if (this.sealed) {
			// Fence the preceding seal only now that a change was observed.
			await this.open(sink, activationId, scope, roots, signal);
			snapshot = this.store.snapshot();
			consumer = this.consumer(snapshot, sink.consumerId, activationId);
			if (!consumer) return;
			pending = snapshot.events.filter((event) => event.sourceSequence > consumer!.acknowledged);
		}
		const registered = new Set(consumer.subjects.map(ciSubjectKey));
		const repositories = new Set(consumer.subjects.map((subject) => `${subject.host}/${subject.repositoryId}`));
		if (
			pending.some((event) =>
				isCiEnvelope(event)
					? !registered.has(ciSubjectKey(ciEventSubject(event.event)))
					: !repositories.has(`${event.event.repository.host}/${event.event.repository.repositoryId}`),
			)
		) {
			// Another writer retained a subject after the scope was read: widen it first.
			this.forced = true;
			return;
		}
		const generation = consumer.generation;
		const catchUp = {
			sourceId: snapshot.sourceId,
			sourceEpoch: snapshot.sourceEpoch,
			scopeVersion: consumer.scopeVersion,
			generation,
		};
		for (let offset = 0; offset < pending.length; offset += ACCEPT_BATCH) {
			for (const event of pending.slice(offset, offset + ACCEPT_BATCH)) {
				const receipt = await sink.accept(event, signal);
				this.store.acknowledge(sink.consumerId, activationId, receipt, generation);
			}
			signal.throwIfAborted();
		}
		if (this.fingerprint() !== inputs.fingerprint) {
			this.forced = true;
			return;
		}
		// A terminal observation names its occurrence's retained position, so a consumer that already
		// pruned it recognises its own history. A run cursor another writer dropped meanwhile re-collects.
		const sealed: HostEventSealObservation[] = [];
		for (const observation of observations) {
			if (observation.status !== "completed") {
				sealed.push(observation);
				continue;
			}
			const run = snapshot.runs.find((entry) => entry.latest.event.eventId === observation.eventId);
			if (!run) {
				this.forced = true;
				return;
			}
			sealed.push({ ...observation, sourceSequence: run.latest.sourceSequence });
		}
		const floor = consumer.replayFloor;
		await sink.seal(
			{
				...catchUp,
				throughSequence: snapshot.nextSequence - 1,
				observations: sealed,
				snapshots: snapshot.runs.flatMap((run) =>
					run.latest.sourceSequence < floor &&
					observations.some((observation) => observation.eventId === run.latest.event.eventId)
						? [run.latest]
						: [],
				),
			},
			signal,
		);
		this.store.recordSeal(sink.consumerId, activationId, generation, observations);
		this.sealed = { generation, observed };
		await this.settle(sink, snapshot, inputs, observations, events, runless, signal);
	}

	/** Retirement, status write-back and the input baseline after a reconcile that completed. */
	private async settle(
		sink: HostEventSink,
		snapshot: CiSourceSnapshot,
		inputs: CiLocalInputs,
		observations: readonly CiCurrentObservation[],
		events: ReadonlyMap<string, CiAttemptTerminalEvent>,
		runless: ReadonlySet<string>,
		signal: AbortSignal,
	): Promise<void> {
		const throughSequence = this.store.retireAcknowledged();
		if (throughSequence !== this.retiredSent) {
			await sink.retireThrough(
				{ sourceId: snapshot.sourceId, sourceEpoch: snapshot.sourceEpoch, throughSequence },
				signal,
			);
			this.retiredSent = throughSequence;
		}
		const written = new Map<string, CiStatusRecord>();
		const now = Date.now();
		for (const record of inputs.records) {
			// A push whose watcher is gone and that never got a run settles by the watcher's own rule,
			// so it leaves the observed scope instead of being collected forever.
			const since = Date.parse(record.startedAt ?? record.completedAt ?? "");
			if (
				record.branch &&
				record.sha &&
				(record.state === "pending" || record.state === "watch_failed") &&
				runless.has(record.sha) &&
				Number.isFinite(since) &&
				now - since > CI_REGISTRATION_GRACE_MS &&
				(record.state === "watch_failed" || ciWatcherAlive(record) !== true)
			) {
				const next: CiStatusRecord = {
					sha: record.sha,
					branch: record.branch,
					workflow: CI_WORKFLOW,
					state: "no_run",
					error: `no ${CI_WORKFLOW} run appeared for this revision`,
					completedAt: new Date(now).toISOString(),
					reconciledBy: "pi",
				};
				try {
					writeCiStatus(this.paths, record.branch, next, record.sha);
					written.set(record.branch, next);
				} catch (error) {
					this.report(`status:${record.branch}`, `CI status record not updated: ${errorText(error)}`);
				}
				continue;
			}
			const current = observations.find((observation) => observation.subject.headSha === record.sha);
			if (
				!record.branch ||
				!record.sha ||
				!current?.eventId ||
				current.status !== "completed" ||
				(record.state === "completed" &&
					record.runId === current.runId &&
					record.runAttempt === current.runAttempt &&
					record.conclusion === current.conclusion)
			)
				continue;
			const event =
				events.get(current.eventId) ??
				snapshot.runs.find((run) => run.latest.event.eventId === current.eventId)?.latest.event;
			if (!event) continue;
			try {
				const status = await completedCiStatus(
					this.provider,
					{ sha: record.sha, branch: record.branch },
					current,
					event,
					signal,
				);
				// Compare-and-set: a record another writer moved to a newer revision is never overwritten.
				const next = { ...status, reconciledBy: "pi" };
				writeCiStatus(this.paths, record.branch, next, record.sha);
				written.set(record.branch, next);
			} catch (error) {
				signal.throwIfAborted();
				this.report(`status:${record.branch}`, `CI status record not updated: ${errorText(error)}`);
			}
		}
		// The baseline is this reconcile's inputs plus its own record writes: those do not trigger another
		// reconcile, while any other change made meanwhile (or a compare-and-set skip) does.
		this.lastInputs = inputFingerprint(
			inputs,
			inputs.records.map((record) => (record.branch ? (written.get(record.branch) ?? record) : record)),
			inputs.subscribed,
		);
		if (this.fingerprint() !== this.lastInputs) this.forced = true;
		// Recovered failures report again if they recur; standing notices stay reported once.
		for (const key of [...this.reported.keys()])
			if (!key.startsWith("retention:") && !key.startsWith("subject:") && key !== "scope") this.reported.delete(key);
	}

	private subjectOf(repository: CiRepository, headSha: string): CiSubject {
		return {
			host: repository.host,
			repositoryId: repository.repositoryId,
			workflowId: repository.workflowId,
			headSha,
		};
	}

	private ownWorkflow(repository: CiRepository, subject: CiSubject): boolean {
		return (
			subject.host === repository.host &&
			subject.repositoryId === repository.repositoryId &&
			subject.workflowId === repository.workflowId
		);
	}

	/**
	 * HEAD, unacknowledged retained events, live subscriptions and unsettled watcher records.
	 * Settled historical records are never re-collected.
	 */
	private scope(
		repository: CiRepository,
		inputs: CiLocalInputs,
		snapshot: CiSourceSnapshot,
		acknowledged: number,
	): { subjects: CiSubject[]; required: ReadonlySet<string> } {
		const scope: CiSubject[] = [];
		if (inputs.headSha) addSubject(scope, this.subjectOf(repository, inputs.headSha));
		for (const event of snapshot.events)
			if (event.sourceSequence > acknowledged && isCiEnvelope(event)) addSubject(scope, ciEventSubject(event.event));
		const pinned = scope.length;
		for (const subject of inputs.subscribed) if (this.ownWorkflow(repository, subject)) addSubject(scope, subject);
		// A delivery can target only these: their observation must be current before a seal.
		const required = new Set(scope.map(ciSubjectKey));
		for (const headSha of inputs.unsettled) addSubject(scope, this.subjectOf(repository, headSha));
		if (scope.length <= MAX_HOST_EVENT_SUBJECTS) {
			this.reported.delete("scope");
			return { subjects: scope, required };
		}
		if (pinned > MAX_HOST_EVENT_SUBJECTS)
			throw new Error("Retained CI events exceed the registered subject bound; they remain retained.");
		this.report(
			"scope",
			`CI events observe ${MAX_HOST_EVENT_SUBJECTS} of ${scope.length} subscribed or unsettled revisions; the rest wait for capacity.`,
		);
		return { subjects: scope.slice(0, MAX_HOST_EVENT_SUBJECTS), required };
	}

	/** Claims custody on first use; `undefined` when another writer replaced it (re-claimed next round). */
	private async activate(sink: HostEventSink, signal: AbortSignal): Promise<string> {
		if (this.activationId) return this.activationId;
		const identity = this.store.identity();
		const checkpoint = await sink.checkpoint(identity.sourceId, signal);
		signal.throwIfAborted();
		const activationId = randomUUID();
		this.store.claim(sink.consumerId, activationId, checkpoint);
		this.activationId = activationId;
		this.sourceId = identity.sourceId;
		this.claimed = { consumerId: sink.consumerId, activationId };
		this.opened = false;
		this.sealed = undefined;
		this.retiredSent = undefined;
		return activationId;
	}

	private consumer(
		snapshot: CiSourceSnapshot,
		consumerId: string,
		activationId: string,
	): CiSourceSnapshot["consumers"][number] | undefined {
		const consumer = snapshot.consumers.find((entry) => entry.id === consumerId);
		if (consumer?.activation?.id === activationId && snapshot.sourceId === this.sourceId) return consumer;
		// A quarantined journal or an expired claim: activate again against the current source.
		this.report("custody", "CI source custody was replaced; this session registers the current source.");
		const previous = this.sourceId;
		this.activationId = undefined;
		this.claimed = undefined;
		this.sourceId = undefined;
		this.forced = true;
		// A new source id means the journal itself was replaced. Registering the successor ends it durably; until then
		// it stops counting as ready here.
		if (previous && previous !== snapshot.sourceId)
			void this.sink
				?.deactivate(previous)
				.catch((error: unknown) => this.report("custody", `CI source deactivation failed: ${errorText(error)}`));
		return undefined;
	}

	private async open(
		sink: HostEventSink,
		activationId: string,
		scope: readonly CiSubject[],
		roots: readonly CiSubject[],
		signal: AbortSignal,
	): Promise<void> {
		for (let round = 0; ; round++) {
			const start = this.store.begin(sink.consumerId, activationId, scope, roots);
			// The journal's location names its store: a successor journal there (a quarantine or a new format) ends this
			// source in every session ledger that registers the successor.
			await sink.register(
				{
					...start.registration,
					storeIdentity: hostEventHash("pi-ci-source-store-v1", [this.paths.commonDir, this.paths.statusDir]),
				},
				signal,
			);
			await sink.beginCatchUp(start.catchUp, signal);
			const gap = this.store.snapshot().consumers.find((consumer) => consumer.id === sink.consumerId)?.pendingGap;
			if (gap) {
				await sink.resumeGap(
					{
						...start.catchUp,
						afterSequence: gap.afterSequence,
						throughSequence: gap.throughSequence,
						reason: gap.cause,
					},
					signal,
				);
				this.store.confirmGap(sink.consumerId, activationId, gap);
			}
			this.store.confirmBegin(sink.consumerId, activationId, start);
			this.opened = true;
			this.sealed = undefined;
			// A replayed pending handshake may carry an older scope; begin once more with the current one.
			if (sameSubjects(start.registration.subjects, scope) && sameSubjects(start.registration.rootSubjects, roots))
				return;
			if (round > 0) throw new Error("CI source scope handshake did not converge.");
		}
	}
}

/**
 * Non-Git directories and repositories without the configured workflow remain ordinary sessions:
 * no source, no diagnostic. Repository resolution and network discovery happen in the reconcile.
 */
export async function createCiHostRuntime(options: CiHostRuntimeOptions): Promise<CiHostRuntime | undefined> {
	const signal = options.signal ?? new AbortController().signal;
	const paths = options.paths ?? (await resolveCiGitPathsAsync(options.cwd, signal));
	signal.throwIfAborted();
	if (!paths) return undefined;
	if (!options.provider && !existsSync(join(paths.root, ".github", "workflows", CI_WORKFLOW))) return undefined;
	return new CiHostEventSource(
		paths,
		options.provider ?? new GithubActionsCiProvider(createCiCommandPort(paths.root, options.onDiagnostic)),
		options.store ?? new CiSourceStore(paths.statusDir, { onDiagnostic: options.onDiagnostic }),
		options.onDiagnostic,
		options,
	);
}
