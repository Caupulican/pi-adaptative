/**
 * The host's reader of GitHub for a session's typed watches (`core/watches/github-watch-source.ts`): read-only `gh api`
 * calls from the session's working directory. The runs a session waits on in one repository are read with one listing of
 * its recent runs (a run older than the listing is read on its own), its releases with one listing of the repository's
 * releases; a failed run's first failed job is read from the attempt's jobs. A `ci` watch's commit becomes a subject of
 * the checkout's CI source (`ci-session-resource.ts`) through {@link GithubWatchHostReader.ciSubjects}, pinned to the
 * checkout's repository and CI workflow as the source's own subjects are.
 */
import type { CiAttemptIdentity, CiSubject } from "../../core/events/host-event-contract.ts";
import { monotonicNow } from "../../core/util/timer-port.ts";
import {
	type GithubCreatedRun,
	type GithubPolledSource,
	type GithubRunNarrowing,
	type GithubWatchReader,
	type GithubWatchReading,
	type GithubWatchResult,
	RELEASE_STATUS,
} from "../../core/watches/github-watch-source.ts";
import type { CiCommandPort, CiRepository } from "./ci-provider.ts";
import { GithubActionsCiProvider } from "./github-actions-ci-provider.ts";

const MAX_LISTED = 100;

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
		const stated = /^date:[ \t]*(.+?)[ \t]*\r?$/imu.exec(headers)?.[1];
		const githubNow = stated === undefined ? Number.NaN : Date.parse(stated);
		if (!Number.isFinite(githubNow)) throw new Error("GitHub's response stated no time.");
		return Math.floor((githubNow - elapsed) / 1_000) * 1_000;
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
		const runs =
			runIds.length > 1
				? new Map(
						listed(
							await this.api(host, `repos/${name}/actions/runs?per_page=${MAX_LISTED}`, signal),
							"workflow_runs",
						).map((run) => [run.id, run] as const),
					)
				: new Map<unknown, Record<string, unknown>>();
		const releases = sources.some((source) => source.type === "release")
			? listed(await this.api(host, `repos/${name}/releases?per_page=${MAX_LISTED}`, signal), "releases")
			: [];
		const readings: GithubWatchReading[] = [];
		for (const source of sources) {
			signal.throwIfAborted();
			try {
				if (source.type === "release") {
					readings.push({
						ok: true,
						result: releaseResult(releases.find((entry) => entry.tag_name === source.tag)),
					});
					continue;
				}
				const run =
					runs.get(source.runId) ??
					record(await this.api(host, `repos/${name}/actions/runs/${source.runId}`, signal));
				readings.push({ ok: true, result: await this.runResult(host, name, run, signal) });
			} catch (error) {
				signal.throwIfAborted();
				readings.push({ ok: false, reason: error instanceof Error ? error.message : String(error) });
			}
		}
		return readings;
	}

	private async runResult(
		host: string | undefined,
		name: string,
		run: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<GithubWatchResult> {
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
			observedAt: Date.now(),
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

/** A release as a watch reads it: published, a draft, or not there yet. */
function releaseResult(release: Record<string, unknown> | undefined): GithubWatchResult {
	const observedAt = Date.now();
	if (!release) return { state: "pending", status: RELEASE_STATUS.missing, observedAt };
	if (release.draft === true) return { state: "pending", status: RELEASE_STATUS.draft, observedAt };
	const url = word(release.html_url);
	return {
		state: "done",
		status: release.prerelease === true ? RELEASE_STATUS.prerelease : RELEASE_STATUS.published,
		...(url === undefined ? {} : { url }),
		observedAt,
	};
}
