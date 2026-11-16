/**
 * The host's reader of GitHub for a session's typed watches (`core/watches/github-watch-source.ts`): read-only `gh api`
 * calls from the session's working directory. The runs a session waits on in one repository are read with one listing of
 * its recent runs (a run older than the listing is read on its own), its releases with one listing of the repository's
 * releases; a failed run's first failed job is read from the attempt's jobs. A `ci` watch's commit becomes a subject of
 * the checkout's CI source (`ci-session-resource.ts`) through {@link GithubWatchHostReader.ciSubjects}, pinned to the
 * checkout's repository and CI workflow as the source's own subjects are; once its end time passed it is read here, from
 * the CI workflow's runs on the commit. A done result's time is GitHub's own: a completed run's `updated_at` (a run
 * carries no completion time of its own, and its last change is its completion: a rerun makes it pending again) and a
 * release's `published_at`, told as its age on GitHub's clock (the response's `Date` less that time), never compared
 * with a clock of this machine.
 */
import type { CiAttemptIdentity, CiSubject } from "../../core/events/host-event-contract.ts";
import { monotonicNow } from "../../core/util/timer-port.ts";
import {
	type GithubCreatedRun,
	type GithubPolledSource,
	type GithubRunAttempt,
	type GithubRunNarrowing,
	type GithubWatchReader,
	type GithubWatchReading,
	type GithubWatchResult,
	type GithubWatchSeen,
	RELEASE_STATUS,
} from "../../core/watches/github-watch-source.ts";
import type { CiCommandPort, CiRepository } from "./ci-provider.ts";
import { GithubActionsCiProvider } from "./github-actions-ci-provider.ts";

const MAX_LISTED = 100;
/** The status a `ci` watch's commit is read as while GitHub lists no run of the CI workflow on it. */
const NO_RUN = "no run";

/** A response's body with GitHub's time it states (its `Date`, whole seconds) and when it arrived (`monotonicNow`). */
interface Dated {
	readonly body: unknown;
	readonly githubNow: number;
	readonly receivedAt: number;
}

/** A reading, with when its done result came about on the monotonic clock (its age is taken when it is returned). */
interface Found {
	readonly reading: GithubWatchReading;
	readonly doneAt?: number;
}

interface Checkout {
	readonly host: string;
	readonly nameWithOwner: string;
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid GitHub object.");
	return value as Record<string, unknown>;
}

function listed(value: unknown, key: string): Record<string, unknown>[] {
	const entries = Array.isArray(value) ? value : record(value)[key];
	if (!Array.isArray(entries)) throw new Error("Invalid GitHub listing.");
	return entries.map(record);
}

function word(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** GitHub's time a response's headers state (its `Date`). */
function statedTime(headers: string): number {
	const stated = /^date:[ \t]*(.+?)[ \t]*\r?$/imu.exec(headers)?.[1];
	const time = stated === undefined ? Number.NaN : Date.parse(stated);
	if (!Number.isFinite(time)) throw new Error("GitHub's response stated no time.");
	return time;
}

/** When GitHub's `time` was, on the monotonic clock: its age at the response, on GitHub's clock, before the response arrived. */
function doneAtOf(response: Dated, time: unknown): number | undefined {
	const at = typeof time === "string" ? Date.parse(time) : Number.NaN;
	return Number.isFinite(at) ? response.receivedAt - Math.max(0, response.githubNow - at) : undefined;
}

/** The readings with each done result's age, taken now: how long before they are returned it came about. */
function aged(found: readonly Found[]): GithubWatchReading[] {
	const now = monotonicNow();
	return found.map(({ reading, doneAt }) =>
		reading.ok && doneAt !== undefined ? { ...reading, doneAgoMs: Math.max(0, Math.floor(now - doneAt)) } : reading,
	);
}

export class GithubWatchHostReader implements GithubWatchReader {
	private readonly port: CiCommandPort;
	private readonly ci: GithubActionsCiProvider;
	private checkoutRead: Promise<Checkout> | undefined;
	private ciRepository: CiRepository | undefined;
	private ciRepositoryRead = false;
	private readonly listeners = new Set<() => void>();

	constructor(port: CiCommandPort) {
		this.port = port;
		this.ci = new GithubActionsCiProvider(port);
	}

	private async api(host: string | undefined, path: string, signal: AbortSignal): Promise<unknown> {
		return JSON.parse(
			await this.port.run("gh", ["api", ...(host === undefined ? [] : ["--hostname", host]), path], signal),
		);
	}

	/** One read of `path` with GitHub's time its response states. */
	private async dated(host: string | undefined, path: string, signal: AbortSignal): Promise<Dated> {
		const response = await this.port.run(
			"gh",
			["api", "--include", ...(host === undefined ? [] : ["--hostname", host]), path],
			signal,
		);
		const receivedAt = monotonicNow();
		const gap = /\r?\n\r?\n/u.exec(response);
		if (!gap) throw new Error("GitHub's response holds no body.");
		return {
			body: JSON.parse(response.slice(gap.index + gap[0].length)),
			githubNow: statedTime(response.slice(0, gap.index)),
			receivedAt,
		};
	}

	/** The checkout's GitHub repository, read once; a failed read is read again by the next call. */
	private checkout(signal: AbortSignal): Promise<Checkout> {
		this.checkoutRead ??= (async () => {
			const view = record(
				JSON.parse(await this.port.run("gh", ["repo", "view", "--json", "nameWithOwner,url"], signal)),
			);
			const nameWithOwner = word(view.nameWithOwner);
			if (!nameWithOwner || !/^[\w.-]+\/[\w.-]+$/u.test(nameWithOwner))
				throw new Error("Invalid GitHub repository name.");
			return { host: new URL(String(view.url)).host.toLowerCase(), nameWithOwner };
		})();
		const read = this.checkoutRead;
		read.catch(() => {
			if (this.checkoutRead === read) this.checkoutRead = undefined;
		});
		return read;
	}

	/**
	 * The host and name a repository is read under: a named repository on the checkout's host, or on gh's own default host
	 * where the session's working directory is no GitHub checkout; the checkout's own repository needs the checkout.
	 */
	private async repository(
		repo: string | undefined,
		signal: AbortSignal,
	): Promise<{ readonly host: string | undefined; readonly name: string }> {
		const checkout =
			repo === undefined ? await this.checkout(signal) : await this.checkout(signal).catch(() => undefined);
		const name = repo ?? checkout?.nameWithOwner;
		if (name === undefined) throw new Error("No GitHub repository to read.");
		return { host: checkout?.host, name };
	}

	/**
	 * `instant` (on the process's monotonic clock, `monotonicNow`) on GitHub's own clock: GitHub's time as a response it
	 * sends now states it (its `Date`, whole seconds), less the time elapsed on the monotonic clock since `instant`. GitHub
	 * stamped that time at or before the response arrived, so the result is never later than GitHub's time at `instant`:
	 * what GitHub created after `instant` is never taken for older. No wall clock of this machine is read, so a jump of the
	 * system clock moves nothing.
	 */
	private async githubInstant(
		host: string | undefined,
		name: string,
		instant: number,
		signal: AbortSignal,
	): Promise<number> {
		const response = await this.port.run(
			"gh",
			["api", "--include", ...(host === undefined ? [] : ["--hostname", host]), `repos/${name}`],
			signal,
		);
		const elapsed = Math.max(0, monotonicNow() - instant);
		const [headers = ""] = response.split(/\r?\n\r?\n/u, 1);
		return Math.floor((statedTime(headers) - elapsed) / 1_000) * 1_000;
	}

	async runsCreatedSince(
		repo: string | undefined,
		since: number,
		narrow: GithubRunNarrowing,
		signal: AbortSignal,
	): Promise<readonly GithubCreatedRun[]> {
		const { host, name } = await this.repository(repo, signal);
		const githubSince = await this.githubInstant(host, name, since, signal);
		const query = new URLSearchParams({
			per_page: String(MAX_LISTED),
			// GitHub's own search syntax over its creation time, whose timestamps are whole seconds.
			created: `>=${new Date(githubSince).toISOString().replace(/\.\d{3}Z$/u, "Z")}`,
			...(narrow.branch === undefined ? {} : { branch: narrow.branch }),
			...(narrow.event === undefined ? {} : { event: narrow.event }),
		});
		const workflowId =
			narrow.workflow === undefined ? undefined : await this.workflowId(host, name, narrow.workflow, signal);
		const path =
			workflowId === undefined
				? `repos/${name}/actions/runs?${query}`
				: `repos/${name}/actions/workflows/${workflowId}/runs?${query}`;
		return listed(await this.api(host, path, signal), "workflow_runs").flatMap((run) => {
			const createdAt = Date.parse(String(run.created_at));
			return typeof run.id === "number" && Number.isFinite(createdAt)
				? [{ repo: name, runId: run.id, createdAt }]
				: [];
		});
	}

	/** The id of the workflow `gh workflow run` names: by its id, its file's name or path, or its display name. */
	private async workflowId(
		host: string | undefined,
		name: string,
		workflow: string,
		signal: AbortSignal,
	): Promise<number> {
		const wanted = workflow.toLowerCase();
		const match = listed(
			await this.api(host, `repos/${name}/actions/workflows?per_page=${MAX_LISTED}`, signal),
			"workflows",
		).find(
			(entry) =>
				String(entry.id) === workflow ||
				String(entry.name).toLowerCase() === wanted ||
				String(entry.path).toLowerCase() === wanted ||
				String(entry.path).toLowerCase().split("/").pop() === wanted,
		);
		if (typeof match?.id !== "number") throw new Error(`No workflow ${workflow} in ${name}.`);
		return match.id;
	}

	async releasedBefore(repo: string | undefined, tag: string, since: number, signal: AbortSignal): Promise<boolean> {
		const { host, name } = await this.repository(repo, signal);
		const githubSince = await this.githubInstant(host, name, since, signal);
		const release = listed(
			await this.api(host, `repos/${name}/releases?per_page=${MAX_LISTED}`, signal),
			"releases",
		).find((entry) => entry.tag_name === tag);
		if (!release) return false;
		const createdAt = Date.parse(String(release.created_at));
		if (!Number.isFinite(createdAt)) throw new Error("Invalid GitHub release.");
		return createdAt < githubSince;
	}

	async observe(
		repo: string | undefined,
		sources: readonly GithubPolledSource[],
		signal: AbortSignal,
	): Promise<readonly GithubWatchReading[]> {
		const { host, name } = await this.repository(repo, signal);
		const runIds = sources.flatMap((source) => (source.type === "github_run" ? [source.runId] : []));
		const listing =
			runIds.length > 1
				? await this.dated(host, `repos/${name}/actions/runs?per_page=${MAX_LISTED}`, signal)
				: undefined;
		const runs = new Map(listing ? listed(listing.body, "workflow_runs").map((run) => [run.id, run] as const) : []);
		const releases = sources.some((source) => source.type === "release")
			? await this.dated(host, `repos/${name}/releases?per_page=${MAX_LISTED}`, signal)
			: undefined;
		const releaseList = releases ? listed(releases.body, "releases") : [];
		const found: Found[] = [];
		for (const source of sources) {
			signal.throwIfAborted();
			try {
				if (source.type === "release") {
					found.push(releaseFound(releases, releaseList, source.tag));
					continue;
				}
				const listedRun = listing ? runs.get(source.runId) : undefined;
				const response =
					listing && listedRun
						? listing
						: await this.dated(host, `repos/${name}/actions/runs/${source.runId}`, signal);
				found.push(await this.runFound(host, name, listedRun ?? record(response.body), response, signal));
			} catch (error) {
				signal.throwIfAborted();
				found.push({ reading: { ok: false, reason: error instanceof Error ? error.message : String(error) } });
			}
		}
		return aged(found);
	}

	async observeCi(
		sha: string,
		carried: GithubRunAttempt | undefined,
		signal: AbortSignal,
	): Promise<GithubWatchReading> {
		try {
			const { host, nameWithOwner: name, workflowId } = await this.ci.repository(signal);
			const response = await this.dated(
				host,
				`repos/${name}/actions/workflows/${workflowId}/runs?head_sha=${sha}&per_page=${MAX_LISTED}`,
				signal,
			);
			// The newest run is the commit's current CI, its latest attempt the run's own status and conclusion.
			const newest = listed(response.body, "workflow_runs").reduce<Record<string, unknown> | undefined>(
				(found, run) => (found === undefined || Number(run.run_number) > Number(found.run_number) ? run : found),
				undefined,
			);
			const current: Found = newest
				? await this.runFound(host, name, newest, response, signal)
				: { reading: { ok: true, result: { state: "pending", status: NO_RUN } } };
			const again =
				carried === undefined ||
				(current.reading.ok &&
					current.reading.result.runId === carried.runId &&
					current.reading.result.runAttempt === carried.runAttempt)
					? undefined
					: await this.attemptFound(host, name, carried, signal);
			const [reading, carriedReading] = aged(again === undefined ? [current] : [current, again]);
			if (!reading?.ok) throw new Error("No reading of the commit's CI.");
			return carriedReading?.ok
				? { ...reading, carried: { result: carriedReading.result, doneAgoMs: carriedReading.doneAgoMs } }
				: reading;
		} catch (error) {
			signal.throwIfAborted();
			return { ok: false, reason: error instanceof Error ? error.message : String(error) };
		}
	}

	/**
	 * One attempt of a run, read on its own with when it completed on the monotonic clock; a read that fails is told as a
	 * failed reading, which leaves the attempt untimed.
	 */
	private async attemptFound(
		host: string | undefined,
		name: string,
		{ runId, runAttempt }: GithubRunAttempt,
		signal: AbortSignal,
	): Promise<Found> {
		try {
			const response = await this.dated(host, `repos/${name}/actions/runs/${runId}/attempts/${runAttempt}`, signal);
			return await this.runFound(host, name, record(response.body), response, signal);
		} catch (error) {
			signal.throwIfAborted();
			return { reading: { ok: false, reason: error instanceof Error ? error.message : String(error) } };
		}
	}

	/** A run as a watch reads it, with when it completed (its last change) on the monotonic clock. */
	private async runFound(
		host: string | undefined,
		name: string,
		run: Record<string, unknown>,
		response: Dated,
		signal: AbortSignal,
	): Promise<Found> {
		const result = await this.runResult(host, name, run, signal);
		const doneAt = result.state === "done" ? doneAtOf(response, run.updated_at) : undefined;
		return { reading: { ok: true, result }, ...(doneAt === undefined ? {} : { doneAt }) };
	}

	private async runResult(
		host: string | undefined,
		name: string,
		run: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<GithubWatchSeen> {
		const status = word(run.status);
		const runId = run.id;
		const runAttempt = run.run_attempt;
		if (!status || typeof runId !== "number" || typeof runAttempt !== "number")
			throw new Error("Invalid GitHub run.");
		const conclusion = status === "completed" ? word(run.conclusion) : undefined;
		const job = conclusion === "failure" ? await this.failedJobOf(host, name, runId, runAttempt, signal) : {};
		const url = word(run.html_url);
		return {
			state: status === "completed" ? "done" : "pending",
			status,
			...(conclusion === undefined ? {} : { conclusion }),
			...job,
			...(url === undefined ? {} : { url }),
			runId,
			runAttempt,
		};
	}

	/**
	 * The first failed job of a failed attempt, or why it could not be read: the run's own status and conclusion read
	 * without it, so a failed read of its jobs is said in the result, never a failed reading of the run.
	 */
	private async failedJobOf(
		host: string | undefined,
		name: string,
		runId: number,
		runAttempt: number,
		signal: AbortSignal,
	): Promise<Pick<GithubWatchResult, "failedJob" | "failedJobUnread">> {
		let jobs: Record<string, unknown>[];
		try {
			jobs = listed(
				await this.api(
					host,
					`repos/${name}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=${MAX_LISTED}`,
					signal,
				),
				"jobs",
			);
		} catch (error) {
			signal.throwIfAborted();
			return { failedJobUnread: error instanceof Error ? error.message : String(error) };
		}
		const failedJob = jobs.find((job) => job.conclusion === "failure")?.name;
		return typeof failedJob === "string" && failedJob.length > 0 ? { failedJob } : {};
	}

	async failedCiJob(identity: CiAttemptIdentity, signal: AbortSignal): Promise<string | undefined> {
		return (await this.ci.failedJobs(identity, signal))[0];
	}

	/**
	 * The CI subjects of commits the session's `ci` watches wait on: none until the checkout's CI repository is read
	 * (the first call starts that read, and listeners hear when it lands), then one per commit.
	 */
	ciSubjects(shas: readonly string[]): readonly CiSubject[] {
		const repository = this.ciRepository;
		if (!repository) {
			if (shas.length > 0) this.readCiRepository();
			return [];
		}
		return shas.map((headSha) => ({
			host: repository.host,
			repositoryId: repository.repositoryId,
			workflowId: repository.workflowId,
			headSha,
		}));
	}

	private readCiRepository(): void {
		if (this.ciRepositoryRead) return;
		this.ciRepositoryRead = true;
		void this.ci.repository(AbortSignal.timeout(60_000)).then(
			(repository) => {
				this.ciRepository = repository;
				for (const listener of [...this.listeners]) listener();
			},
			() => {
				// The CI source reads the same repository; the next change of the watched commits asks again.
				this.ciRepositoryRead = false;
			},
		);
	}

	/** Hears when the checkout's CI repository was read, so the CI source re-reads its subjects. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}

/** The release of `tag` in a listing, with when it was published on the monotonic clock. */
function releaseFound(response: Dated | undefined, releases: readonly Record<string, unknown>[], tag: string): Found {
	const release = releases.find((entry) => entry.tag_name === tag);
	const result = releaseResult(release);
	const doneAt = response && result.state === "done" ? doneAtOf(response, release?.published_at) : undefined;
	return { reading: { ok: true, result }, ...(doneAt === undefined ? {} : { doneAt }) };
}

/** A release as a watch reads it: published, a draft, or not there yet. */
function releaseResult(release: Record<string, unknown> | undefined): GithubWatchSeen {
	if (!release) return { state: "pending", status: RELEASE_STATUS.missing };
	if (release.draft === true) return { state: "pending", status: RELEASE_STATUS.draft };
	const url = word(release.html_url);
	return {
		state: "done",
		status: release.prerelease === true ? RELEASE_STATUS.prerelease : RELEASE_STATUS.published,
		...(url === undefined ? {} : { url }),
	};
}
