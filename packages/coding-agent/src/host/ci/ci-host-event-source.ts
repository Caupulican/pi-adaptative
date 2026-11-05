import { randomUUID } from "node:crypto";
import { type FSWatcher, mkdirSync } from "node:fs";
import { type CiStatusView, ciStatusViewFromRecord } from "../../core/ci-status-view.ts";
import {
	type CiSubject,
	ciSubjectKey,
	type HostEventSink,
	type HostEventSource,
} from "../../core/events/host-event-contract.ts";
import { boundedRedactedDiagnosticText } from "../../core/security/secret-text.ts";
import { closeWatcher, FS_WATCH_RETRY_DELAY_MS, watchWithErrorHandler } from "../../utils/fs-watch.ts";
import type { CiProvider, CiProviderCollection } from "./ci-provider.ts";
import { CiRunMonitor } from "./ci-run-monitor.ts";
import { CiSourceStore } from "./ci-source-store.ts";
import {
	type CiGitPaths,
	ciStatusPath,
	readCiHead,
	readCiStatusFile,
	readCiStatusRecords,
	resolveCiGitPaths,
	writeCiStatus,
} from "./ci-status-record.ts";
import { createCiCommandPort, GithubActionsCiProvider } from "./github-actions-ci-provider.ts";

// Discover upstream runs/reruns that have no local filesystem event. Known runs use terminal monitors.
const CI_DISCOVERY_INTERVAL_MS = 2 * 60 * 1000;

export interface CiHostRuntime {
	readonly source: HostEventSource;
	readStatus(): CiStatusView | undefined;
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

/** This resource's owner must stop it before disposing its session's durable event sink. */
class CiHostEventSource implements HostEventSource, CiHostRuntime {
	readonly source: HostEventSource = this;
	private readonly paths: CiGitPaths;
	private readonly provider: CiProvider;
	private readonly store: CiSourceStore;
	private readonly diagnostic: (message: string) => void;
	private readonly listeners = new Set<() => void>();
	private watchers: FSWatcher[] = [];
	private watchDirectories = "";
	private abort?: AbortController;
	private sink?: HostEventSink;
	private unsubscribeWritable?: () => void;
	private unsubscribeSubjects?: () => void;
	private subjectFingerprint = "";
	private draining?: Promise<void>;
	private dirty = false;
	private blocked = false;
	private readonly lifetimeSignal?: AbortSignal;
	private readonly getSubscribedSubjects: () => readonly CiSubject[];
	private readonly subscribeSubjects?: (listener: () => void) => () => void;
	private watchRetry?: ReturnType<typeof setTimeout>;
	private discoveryTimer?: ReturnType<typeof setTimeout>;
	private activationId?: string;
	private sourceId?: string;
	private monitor?: CiRunMonitor;
	private claimed?: { consumerId: string; activationId: string };
	private statusCache?: { at: number; view: CiStatusView | undefined };

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

	async start(sink: HostEventSink): Promise<void> {
		await this.stop();
		this.sink = sink;
		this.abort = new AbortController();
		const signal = this.lifetimeSignal
			? AbortSignal.any([this.abort.signal, this.lifetimeSignal])
			: this.abort.signal;
		const identity = this.store.identity();
		const checkpoint = await sink.checkpoint(identity.sourceId, signal);
		signal.throwIfAborted();
		const activationId = randomUUID();
		this.store.claim(sink.consumerId, activationId, checkpoint);
		this.activationId = activationId;
		this.sourceId = identity.sourceId;
		this.claimed = { consumerId: sink.consumerId, activationId };
		this.monitor = new CiRunMonitor(
			this.provider,
			signal,
			() => this.request(),
			(error) => this.report(error),
		);
		this.unsubscribeWritable = sink.subscribeWritable(() => {
			if (this.blocked) this.request();
		});
		this.subjectFingerprint = JSON.stringify(this.getSubscribedSubjects().map(ciSubjectKey).sort());
		this.unsubscribeSubjects = this.subscribeSubjects?.(() => {
			const fingerprint = JSON.stringify(this.getSubscribedSubjects().map(ciSubjectKey).sort());
			if (fingerprint === this.subjectFingerprint) return;
			this.subjectFingerprint = fingerprint;
			this.request();
		});
		mkdirSync(this.paths.statusDir, { recursive: true });
		this.armWatchers();
		this.request();
	}

	async stop(): Promise<void> {
		const sink = this.sink;
		const sourceId = this.sourceId;
		const claimed = this.claimed;
		const monitor = this.monitor;
		this.monitor = undefined;
		this.sourceId = undefined;
		this.activationId = undefined;
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
		const errors: unknown[] = [];
		try {
			if (sink && sourceId) await sink.deactivate(sourceId);
		} catch (error) {
			errors.push(error);
		}
		try {
			await monitor?.stop();
			await this.draining;
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

	readStatus(): CiStatusView | undefined {
		const now = Date.now();
		if (this.statusCache && now - this.statusCache.at < 1000) return this.statusCache.view;
		this.statusCache = { at: now, view: this.readStatusSnapshot(now) };
		return this.statusCache.view;
	}

	private readStatusSnapshot(now: number): CiStatusView | undefined {
		try {
			const head = readCiHead(this.paths);
			if (!head.branch) return undefined;
			const record = readCiStatusFile(ciStatusPath(this.paths.statusDir, head.branch));
			let watcherAlive: boolean | undefined;
			if (record?.state === "pending" && Number.isInteger(record.pid) && record.pid! > 0) {
				try {
					process.kill(record.pid!, 0);
					watcherAlive = true;
				} catch (error) {
					watcherAlive = (error as NodeJS.ErrnoException).code === "EPERM";
				}
			}
			return ciStatusViewFromRecord(record, head.branch, now, watcherAlive);
		} catch {
			return undefined;
		}
	}

	private report(error: unknown): void {
		const message =
			boundedRedactedDiagnosticText(error instanceof Error ? error.message : String(error)) ??
			"CI source unavailable";
		try {
			this.diagnostic(`CI events remain pending: ${message}`);
		} catch {
			/* Diagnostics never consume custody. */
		}
	}

	private armWatchers(): void {
		const refDirectory = readCiHead(this.paths).refDirectory;
		const directories = [...new Set([this.paths.statusDir, this.paths.gitDir, this.paths.commonDir, refDirectory])];
		const key = JSON.stringify(directories);
		if (key === this.watchDirectories) return;
		for (const watcher of this.watchers) closeWatcher(watcher);
		this.watchers = [];
		this.watchDirectories = key;
		for (const directory of directories) {
			const watcher = watchWithErrorHandler(
				directory,
				(_event, filename) => {
					if (
						directory === this.paths.statusDir &&
						filename &&
						(!filename.endsWith(".json") || filename === "source-v1.json")
					)
						return;
					if (
						directory !== this.paths.statusDir &&
						filename &&
						(filename.includes(".lock") || filename.includes(".tmp"))
					)
						return;
					if (
						directory === this.paths.commonDir &&
						directory !== refDirectory &&
						filename &&
						!["HEAD", "packed-refs", "refs"].includes(filename)
					)
						return;
					this.request();
				},
				() => {
					this.watchDirectories = "";
					this.report(
						new Error("CI filesystem observation is unavailable; retained events will replay at recovery."),
					);
					if (!this.watchRetry && this.abort) {
						this.watchRetry = setTimeout(() => {
							this.watchRetry = undefined;
							this.request();
						}, FS_WATCH_RETRY_DELAY_MS);
						this.watchRetry.unref();
					}
				},
			);
			if (watcher) this.watchers.push(watcher);
		}
	}

	private request(): void {
		if (!this.abort || !this.sink) return;
		this.statusCache = undefined;
		if (this.discoveryTimer) clearTimeout(this.discoveryTimer);
		this.discoveryTimer = undefined;
		this.dirty = true;
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				/* Independent display observer. */
			}
		}
		if (this.draining) return;
		const signal = this.lifetimeSignal
			? AbortSignal.any([this.abort.signal, this.lifetimeSignal])
			: this.abort.signal;
		const sink = this.sink;
		this.draining = Promise.resolve()
			.then(async () => {
				while (this.dirty && !signal.aborted) {
					this.dirty = false;
					this.blocked = false;
					try {
						await this.reconcile(sink, signal);
					} catch (error) {
						if (!signal.aborted) {
							this.blocked = true;
							this.report(error);
						}
					}
				}
			})
			.finally(() => {
				this.draining = undefined;
				if (this.dirty && !signal.aborted) this.request();
				else if (!signal.aborted) {
					this.discoveryTimer = setTimeout(() => {
						this.discoveryTimer = undefined;
						this.request();
					}, CI_DISCOVERY_INTERVAL_MS);
					this.discoveryTimer.unref();
				}
			});
	}

	private inputs(): { headSha?: string; shas: string[]; subscribed: readonly CiSubject[]; fingerprint: string } {
		const head = readCiHead(this.paths);
		const shas = [
			...new Set(
				readCiStatusRecords(this.paths.statusDir).flatMap((record) =>
					record.sha && /^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(record.sha) ? [record.sha] : [],
				),
			),
		].sort();
		if (head.sha && !shas.includes(head.sha)) shas.push(head.sha);
		const subscribed = this.getSubscribedSubjects().map((subject) => ({ ...subject }));
		return {
			headSha: head.sha,
			shas,
			subscribed,
			fingerprint: JSON.stringify([head.sha, shas, subscribed.map(ciSubjectKey).sort()]),
		};
	}

	private async reconcile(sink: HostEventSink, signal: AbortSignal): Promise<void> {
		const activationId = this.activationId;
		if (!activationId) throw new Error("CI event source is not active.");
		// Fence the preceding actionable seal before any fallible discovery or network read.
		const previous = this.store.snapshot();
		const previousConsumer = previous.consumers.find((consumer) => consumer.id === sink.consumerId);
		let start = previousConsumer?.subjects.length
			? this.store.begin(
					sink.consumerId,
					activationId,
					previousConsumer.watchedSubjects,
					previousConsumer.rootSubjects,
				)
			: undefined;
		if (start) {
			await this.admitStart(sink, activationId, start, signal);
		}
		this.armWatchers();
		const inputs = this.inputs();
		const repository = await this.provider.repository(signal);
		signal.throwIfAborted();
		const subjects: CiSubject[] = [];
		for (const headSha of inputs.shas) {
			const subject: CiSubject = {
				host: repository.host,
				repositoryId: repository.repositoryId,
				workflowId: repository.workflowId,
				headSha,
			};
			if (!subjects.some((existing) => ciSubjectKey(existing) === ciSubjectKey(subject))) subjects.push(subject);
		}
		for (const subject of inputs.subscribed) {
			if (
				subject.host !== repository.host ||
				subject.repositoryId !== repository.repositoryId ||
				subject.workflowId !== repository.workflowId
			)
				continue;
			if (!subjects.some((existing) => ciSubjectKey(existing) === ciSubjectKey(subject))) subjects.push(subject);
		}
		if (!subjects.length) return;
		const rootSubjects = subjects.filter((subject) => subject.headSha === inputs.headSha);
		if (
			!start ||
			JSON.stringify(start.registration.subjects.map(ciSubjectKey).sort()) !==
				JSON.stringify(subjects.map(ciSubjectKey).sort()) ||
			JSON.stringify(start.registration.rootSubjects.map(ciSubjectKey).sort()) !==
				JSON.stringify(rootSubjects.map(ciSubjectKey).sort())
		) {
			start = this.store.begin(sink.consumerId, activationId, subjects, rootSubjects);
			await this.admitStart(sink, activationId, start, signal);
		}
		this.store.watchSubjects(sink.consumerId, activationId, subjects);
		const collections: CiProviderCollection[] = [];
		for (const subject of start.registration.subjects) {
			const collection = await this.provider.collect(
				subject.headSha,
				signal,
				this.store.retainedAttempts(),
				this.store.retiredRunNumbers(subject),
			);
			if (ciSubjectKey(collection.subject) !== ciSubjectKey(subject))
				throw new Error("CI provider returned a different subject.");
			this.store.retain(collection.events);
			collections.push(collection);
		}
		signal.throwIfAborted();
		if (this.inputs().fingerprint !== inputs.fingerprint) {
			this.dirty = true;
			return;
		}
		const snapshot = this.store.snapshot();
		if (
			JSON.stringify(snapshot.subjects.map(ciSubjectKey).sort()) !==
			JSON.stringify(start.registration.subjects.map(ciSubjectKey).sort())
		) {
			this.dirty = true;
			return;
		}
		const consumer = snapshot.consumers.find((entry) => entry.id === sink.consumerId)!;
		if (consumer.generation !== start.catchUp.generation) throw new Error("CI source consumer generation changed.");
		const pending = snapshot.events.filter((event) => event.sourceSequence > consumer.acknowledged);
		for (let offset = 0; offset < pending.length; offset += 32) {
			for (const event of pending.slice(offset, offset + 32)) {
				const receipt = await sink.accept(event, signal);
				this.store.acknowledge(sink.consumerId, activationId, receipt, start.catchUp.generation);
			}
			signal.throwIfAborted();
		}
		if (this.inputs().fingerprint !== inputs.fingerprint) {
			this.dirty = true;
			return;
		}
		await sink.seal(
			{
				...start.catchUp,
				throughSequence: snapshot.nextSequence - 1,
				observations: collections.flatMap((collection) => (collection.current ? [collection.current] : [])),
				snapshots: snapshot.runs.flatMap((run) =>
					run.latest.sourceSequence < consumer.replayFloor &&
					collections.some((collection) => collection.current?.eventId === run.latest.event.eventId)
						? [run.latest]
						: [],
				),
			},
			signal,
		);
		this.store.recordSeal(
			sink.consumerId,
			activationId,
			start.catchUp.generation,
			collections.flatMap((collection) => (collection.current ? [collection.current] : [])),
		);
		this.monitor?.reconcile(collections.flatMap((collection) => (collection.current ? [collection.current] : [])));
		const throughSequence = this.store.retireAcknowledged();
		await sink.retireThrough(
			{ sourceId: snapshot.sourceId, sourceEpoch: snapshot.sourceEpoch, throughSequence },
			signal,
		);
		for (const record of readCiStatusRecords(this.paths.statusDir)) {
			const current = collections.find((collection) => collection.subject.headSha === record.sha)?.current;
			if (
				!record.branch ||
				!current ||
				current.status !== "completed" ||
				(record.state === "completed" &&
					record.runId === current.runId &&
					record.runAttempt === current.runAttempt &&
					record.conclusion === current.conclusion)
			)
				continue;
			const event = collections
				.flatMap((collection) => collection.events)
				.find((event) => event.eventId === current.eventId);
			writeCiStatus(this.paths, record.branch, {
				...record,
				state: "completed",
				conclusion: current.conclusion,
				runId: current.runId,
				runAttempt: current.runAttempt,
				runNumber: current.runNumber,
				...(event ? { url: event.runUrl } : {}),
				completedAt: new Date().toISOString(),
				reconciledBy: "pi",
			});
		}
	}

	private async admitStart(
		sink: HostEventSink,
		activationId: string,
		start: ReturnType<CiSourceStore["begin"]>,
		signal: AbortSignal,
	): Promise<void> {
		await sink.register(start.registration, signal);
		await sink.beginCatchUp(start.catchUp, signal);
		const gap = this.store.snapshot().consumers.find((consumer) => consumer.id === sink.consumerId)?.pendingGap;
		if (gap) {
			await sink.resumeGap({ ...start.catchUp, ...gap, reason: "consumer_inactive" }, signal);
			this.store.confirmGap(sink.consumerId, activationId, gap);
		}
		this.store.confirmBegin(sink.consumerId, activationId, start);
	}
}

/** Non-Git and repositories without the configured workflow remain ordinary usable sessions. */
export async function createCiHostRuntime(options: CiHostRuntimeOptions): Promise<CiHostRuntime | undefined> {
	try {
		const paths = options.paths ?? resolveCiGitPaths(options.cwd);
		const provider = options.provider ?? new GithubActionsCiProvider(createCiCommandPort(paths.root));
		await provider.repository(options.signal ?? new AbortController().signal);
		return new CiHostEventSource(
			paths,
			provider,
			options.store ?? new CiSourceStore(paths.statusDir),
			options.onDiagnostic,
			options,
		);
	} catch (error) {
		if (options.signal?.aborted) throw error;
		const message =
			boundedRedactedDiagnosticText(error instanceof Error ? error.message : String(error)) ?? "unavailable";
		options.onDiagnostic(`CI event source inactive: ${message}`);
		return undefined;
	}
}
