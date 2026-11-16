/**
 * Reads a session's watches on typed GitHub sources (`github-watch-source.ts`) and records each reading in the session's
 * watch ledger through its service: a `ci` watch from the CI results the session's CI source already collects (its
 * commit is one of that source's subjects, `host/ci/ci-session-resource.ts`), a run or a release by one batched read per
 * repository every {@link GITHUB_WATCH_POLL_MS}, through the reader the host offers ({@link GithubWatchLink}). Core starts
 * no process: without a reader, or without the CI source for a `ci` watch, a read cannot be made, and that counts
 * toward the watch's failing streak as any failed read does; the armer hears a streak once, after
 * {@link GITHUB_WATCH_FAILING_AFTER} reads in a row failed.
 *
 * A watch past its end time is read once more before it ends (its deadline read, `SessionWatchService`): a run or a
 * release as above, a `ci` watch's commit straight from GitHub (`GithubWatchReader.observeCi`), since the CI source's
 * stream tells no time a result came about at. The read settles it whether it succeeded or failed. Without the host's
 * reader, which a reopening session offers only once its CI resource started, it waits up to one read interval for it,
 * then fails, so a watch nothing can read still ends.
 */
import type { CiAttemptTerminalEvent } from "../events/host-event-contract.ts";
import type { RoutineHostEventFeed } from "../routines/routine-contract.ts";
import type { TimerPort } from "../util/timer-port.ts";
import type {
	CiPushTriggers,
	GithubPolledSource,
	GithubWatchReader,
	GithubWatchSource,
} from "./github-watch-source.ts";
import type { SessionWatchService } from "./session-watch-service.ts";

/** How often a run or a release a session waits on is read. */
export const GITHUB_WATCH_POLL_MS = 60_000;
/** Reads in a row that failed before the armer is told the watch is failing, as a condition watch's checks. */
export const GITHUB_WATCH_FAILING_AFTER = 5;

/**
 * The host's side of a session's typed watches: the reader of GitHub it offers while its CI resource runs, whether the
 * checkout's CI source runs (a `ci` watch is read from it) with the reading of its workflow's triggers, and the commits
 * the session's `ci` watches wait on, which that source collects. Listeners hear every change of any of them.
 */
export class GithubWatchLink {
	private reader: GithubWatchReader | undefined;
	private readonly ciFollowers: CiPushTriggers[] = [];
	private commits: () => readonly string[] = () => [];
	private readonly listeners = new Set<() => void>();

	/** The host offers its reader of GitHub; the returned function withdraws it. */
	provideReader(reader: GithubWatchReader): () => void {
		this.reader = reader;
		this.changed();
		return () => {
			if (this.reader !== reader) return;
			this.reader = undefined;
			this.changed();
		};
	}

	/**
	 * The checkout's CI source runs, so a `ci` watch's commit is collected, and `triggers` tells whether its workflow runs
	 * for a push; the returned function ends that.
	 */
	followCi(triggers: CiPushTriggers): () => void {
		const follower = { runsOnPush: triggers.runsOnPush.bind(triggers) };
		this.ciFollowers.push(follower);
		this.changed();
		return () => {
			const index = this.ciFollowers.indexOf(follower);
			if (index < 0) return;
			this.ciFollowers.splice(index, 1);
			this.changed();
		};
	}

	get current(): GithubWatchReader | undefined {
		return this.reader;
	}

	/** Whether the host offers its reader of GitHub now. */
	get readsGithub(): boolean {
		return this.reader !== undefined;
	}

	get followsCi(): boolean {
		return this.ciFollowers.length > 0;
	}

	/** Whether the followed CI workflow runs for a push, while the CI source follows the checkout. */
	get ciTriggers(): CiPushTriggers | undefined {
		return this.ciFollowers.at(-1);
	}

	/** The commits the session's live `ci` watches wait on, for the CI source to collect as subjects of its own. */
	ciShas(): readonly string[] {
		return this.commits();
	}

	/** The poller names the commits its watches wait on; the returned function stops it. */
	watchCommits(read: () => readonly string[]): () => void {
		this.commits = read;
		return () => {
			if (this.commits === read) this.commits = () => [];
		};
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	changed(): void {
		for (const listener of [...this.listeners]) listener();
	}
}

export interface GithubWatchPollerDeps {
	readonly watches: Pick<
		SessionWatchService,
		| "githubWatches"
		| "observeGithub"
		| "noteFailing"
		| "subscribe"
		| "claimCi"
		| "ciJobsAwaited"
		| "settleFailedJob"
		| "settleDeadlineRead"
	>;
	readonly link: GithubWatchLink;
	/** The session's accepted host events; read while a `ci` watch is live or a fired one's failed job is read. */
	readonly hostEvents: { feed(): RoutineHostEventFeed; subscribe(listener: () => void): () => void };
	readonly timers: TimerPort;
	isDisposed(): boolean;
	warn(message: string): void;
}

type LiveGithubWatch = ReturnType<SessionWatchService["githubWatches"]>[number];
type PolledWatch = LiveGithubWatch & { readonly source: GithubPolledSource };

/** Why a read could not be made, in the words the armer is told. */
export const NO_READER =
	"GitHub cannot be read from this session (no GitHub checkout was found here, or the gh command is unavailable)";
export const NO_CI_SOURCE =
	"this session does not collect its checkout's CI results (proactivity.ciEvents is off, or the checkout has no CI workflow)";

export class GithubWatchPoller {
	private readonly deps: GithubWatchPollerDeps;
	private readonly abort = new AbortController();
	private started = false;
	private stopped = false;
	private timer: unknown;
	private pass: Promise<void> | undefined;
	private again = false;
	/** When each watch (by incarnation) is read next; a new one is read at once. */
	private readonly nextRead = new Map<string, number>();
	/** Reads in a row that failed, by incarnation, and whether the armer heard the streak. */
	private readonly streaks = new Map<string, { failures: number; reported: boolean }>();
	private readonly unsubscribers: (() => void)[] = [];

	constructor(deps: GithubWatchPollerDeps) {
		this.deps = deps;
	}

	start(): void {
		if (this.started || this.stopped) return;
		this.started = true;
		const request = () => this.request();
		this.unsubscribers.push(
			this.deps.link.watchCommits(() => this.ciShas()),
			this.deps.watches.subscribe(() => {
				// The CI source re-reads the commits it collects for the session's `ci` watches.
				this.deps.link.changed();
				request();
			}),
			this.deps.link.subscribe(request),
			this.deps.hostEvents.subscribe(request),
		);
		this.request();
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		this.abort.abort();
		this.clearTimer();
		for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
		await this.pass;
	}

	private get active(): boolean {
		return this.started && !this.stopped && !this.deps.isDisposed();
	}

	private ciShas(): readonly string[] {
		return (
			this.deps.watches
				.githubWatches(this.deps.timers.now())
				.flatMap(({ source }) => (source.type === "ci" ? [source.sha] : []))
				// The session's and a worker's watch may wait on one commit: the source collects it once.
				.filter((sha, index, shas) => shas.indexOf(sha) === index)
		);
	}

	/** One pass at a time; a request during a pass runs exactly one more. */
	private request(): void {
		if (!this.active) return;
		if (this.pass) {
			this.again = true;
			return;
		}
		this.pass = this.run()
			.catch((error: unknown) => {
				if (this.active)
					this.deps.warn(`GitHub watch read failed: ${error instanceof Error ? error.message : String(error)}`);
			})
			.finally(() => {
				this.pass = undefined;
				if (!this.again) return;
				this.again = false;
				this.request();
			});
	}

	private async run(): Promise<void> {
		const nowMs = this.deps.timers.now();
		const watches = this.deps.watches.githubWatches(nowMs);
		const listed = new Set(watches.map((watch) => watch.incarnationId));
		for (const map of [this.nextRead, this.streaks])
			for (const key of [...map.keys()]) if (!listed.has(key)) map.delete(key);
		const atDeadline = watches.filter((watch) => watch.deadlineReadSince !== undefined);
		const live = watches.filter((watch) => watch.deadlineReadSince === undefined);
		const followed = this.deps.link.followsCi;
		// A result the CI source collected reaches a watch past its end time too, which carries it to its deadline read.
		const ciCollected = watches.filter((watch) => watch.source.type === "ci" && followed);
		if (ciCollected.length > 0) this.readCi(ciCollected);
		const fromCi = live.filter((watch) => watch.source.type === "ci" && followed);
		await this.readFailedJobs();
		const waitingReader = await this.readAtDeadline(atDeadline, nowMs);
		if (!this.active) return;
		const due = live.filter(
			(watch) => !fromCi.includes(watch) && (this.nextRead.get(watch.incarnationId) ?? 0) <= nowMs,
		);
		for (const watch of due) this.nextRead.set(watch.incarnationId, nowMs + GITHUB_WATCH_POLL_MS);
		const polled: PolledWatch[] = [];
		for (const watch of due) {
			if (!this.active) return;
			if (isPolled(watch)) polled.push(watch);
			// A `ci` watch here is one no CI source collects for: it cannot be read.
			else this.failed(watch, NO_CI_SOURCE);
		}
		await this.readPolled(polled);
		this.followNextRead(
			live.filter((watch) => !fromCi.includes(watch)),
			waitingReader.map((watch) => (watch.deadlineReadSince ?? nowMs) + GITHUB_WATCH_POLL_MS),
		);
	}

	/**
	 * The deadline read of each watch past its end time, settled whether it read the watch or failed; returns those still
	 * waiting for the host's reader (up to one read interval after their end time was reached).
	 */
	private async readAtDeadline(watches: readonly LiveGithubWatch[], nowMs: number): Promise<LiveGithubWatch[]> {
		const reader = this.deps.link.current;
		const ready = watches.filter(
			(watch) => reader !== undefined || nowMs >= (watch.deadlineReadSince ?? nowMs) + GITHUB_WATCH_POLL_MS,
		);
		await this.readPolled(ready.filter(isPolled));
		for (const watch of ready) {
			if (!this.active) return [];
			if (watch.source.type === "ci") await this.readCiAtDeadline(watch, watch.source.sha);
		}
		if (!this.active) return [];
		for (const watch of ready) this.deps.watches.settleDeadlineRead(watch.watchId, watch.incarnationId);
		return watches.filter((watch) => !ready.includes(watch));
	}

	/** A `ci` watch's commit read straight from GitHub, as its deadline read, the completed attempt it carries timed again. */
	private async readCiAtDeadline(watch: LiveGithubWatch, sha: string): Promise<void> {
		const reader = this.deps.link.current;
		const reading = reader
			? await reader.observeCi(sha, watch.carried, this.abort.signal)
			: ({ ok: false, reason: NO_READER } as const);
		if (!this.active) return;
		if (!reading.ok) this.failed(watch, reading.reason);
		else this.deps.watches.observeGithub(watch.watchId, watch.incarnationId, reading);
	}

	/**
	 * The newest current CI result of each watched commit, from the session's accepted host events: the watches on that
	 * commit fire on it in one write (`SessionWatchService.claimCi`), as they do when the root delivery of the same result
	 * is decided first.
	 */
	private readCi(watches: readonly LiveGithubWatch[]): void {
		const results = this.ciResults();
		for (const sha of new Set(watches.flatMap(({ source }) => (source.type === "ci" ? [source.sha] : [])))) {
			const latest = results
				.filter(({ event, current }) => current && event.headSha === sha)
				.sort((a, b) => b.ordinal - a.ordinal)[0];
			if (latest) this.deps.watches.claimCi(latest.event);
		}
	}

	private ciResults(): { ordinal: number; event: CiAttemptTerminalEvent; current: boolean }[] {
		return this.deps.hostEvents
			.feed()
			.events.flatMap((fact) =>
				fact.event.kind === "ci-attempt-terminal"
					? [{ ordinal: fact.acceptedOrdinal, event: fact.event, current: fact.current }]
					: [],
			);
	}

	/**
	 * The first failed job of each failed attempt a watch fired on. The attempt's conclusion is the result the watch fired
	 * on; the wake waits for this read, which names the job, finds none, or says why it could not be read.
	 */
	private async readFailedJobs(): Promise<void> {
		const awaited = this.deps.watches.ciJobsAwaited();
		if (awaited.length === 0) return;
		const reader = this.deps.link.current;
		const results = this.ciResults();
		for (const watch of awaited) {
			if (!this.active) return;
			const attempt = results.find(
				({ event }) =>
					event.headSha === watch.sha &&
					event.identity.runId === watch.runId &&
					event.identity.runAttempt === watch.runAttempt,
			)?.event;
			let read: { job?: string } | { unread: string };
			if (!reader) read = { unread: NO_READER };
			else if (!attempt) read = { unread: "the session no longer holds the CI attempt's identity" };
			else
				try {
					const job = await reader.failedCiJob(attempt.identity, this.abort.signal);
					read = job === undefined ? {} : { job };
				} catch (error) {
					if (!this.active) return;
					read = { unread: error instanceof Error ? error.message : String(error) };
				}
			this.deps.watches.settleFailedJob(watch.watchId, watch.incarnationId, read);
		}
	}

	/** One read per repository of the runs and releases waited on in it. */
	private async readPolled(watches: readonly PolledWatch[]): Promise<void> {
		if (watches.length === 0) return;
		const reader = this.deps.link.current;
		if (!reader) {
			for (const watch of watches) this.failed(watch, NO_READER);
			return;
		}
		const byRepo = new Map<string, PolledWatch[]>();
		for (const watch of watches) {
			const key = watch.source.repo ?? "";
			byRepo.set(key, [...(byRepo.get(key) ?? []), watch]);
		}
		for (const [repo, group] of byRepo) {
			if (!this.active) return;
			try {
				const readings = await reader.observe(
					repo === "" ? undefined : repo,
					group.map((watch) => watch.source),
					this.abort.signal,
				);
				if (readings.length !== group.length) throw new Error("GitHub returned a different number of readings.");
				group.forEach((watch, index) => {
					const reading = readings[index];
					if (!reading?.ok) {
						this.failed(watch, reading?.reason ?? "no reading");
						return;
					}
					this.streaks.delete(watch.incarnationId);
					this.deps.watches.observeGithub(watch.watchId, watch.incarnationId, reading);
				});
			} catch (error) {
				if (!this.active) return;
				const reason = error instanceof Error ? error.message : String(error);
				for (const watch of group) this.failed(watch, reason);
			}
		}
	}

	/** One more failed read of a watch; the armer hears the streak once it reaches {@link GITHUB_WATCH_FAILING_AFTER}. */
	private failed(watch: LiveGithubWatch, reason: string): void {
		const streak = this.streaks.get(watch.incarnationId) ?? { failures: 0, reported: false };
		streak.failures += 1;
		this.streaks.set(watch.incarnationId, streak);
		if (streak.failures < GITHUB_WATCH_FAILING_AFTER || streak.reported) return;
		streak.reported = true;
		this.deps.watches.noteFailing({
			routineId: watch.watchId,
			incarnationId: watch.incarnationId,
			cause: "check-failed",
			failures: streak.failures,
			reason: reason.slice(0, 500),
		});
	}

	/** One timer at the next read of a watch read on a clock, or at the end of a deadline read's wait for the reader. */
	private followNextRead(watches: readonly LiveGithubWatch[], waits: readonly number[]): void {
		this.clearTimer();
		if (!this.active || watches.length + waits.length === 0) return;
		const next = Math.min(...watches.map((watch) => this.nextRead.get(watch.incarnationId) ?? 0), ...waits);
		this.timer = this.deps.timers.setTimeout(
			() => {
				this.timer = undefined;
				this.request();
			},
			Math.max(0, next - this.deps.timers.now()),
		);
	}

	private clearTimer(): void {
		if (this.timer === undefined) return;
		this.deps.timers.clearTimeout(this.timer);
		this.timer = undefined;
	}
}

function isPolled(watch: { readonly source: GithubWatchSource }): watch is PolledWatch {
	return watch.source.type !== "ci";
}
