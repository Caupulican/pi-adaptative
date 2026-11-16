/**
 * A session watch's typed GitHub sources: a workflow run (`github_run`), the CI of a commit (`ci`) and a published
 * release (`release`), each observed by host code as structured facts (status, conclusion, failed job, URL) instead of
 * a command whose output the model would parse. They live only in the session's watch ledger (`session-watch-ledger.ts`):
 * the routine store's watch conditions (`watch-contract.ts`), which older builds parse strictly, never hold one.
 *
 * A `ci` watch is observed on the session's CI event stream (its commit is registered as a subject of the CI source,
 * `host/ci/ci-session-resource.ts`), a run or a release by one batched read per repository
 * (`github-watch-poller.ts`). A typed source fires on its first terminal observation: unlike a condition, its first
 * sight is no starting state, since the run or release it names is the thing waited for.
 */
import { Type } from "typebox";
import type { CiAttemptIdentity } from "../events/host-event-contract.ts";
import type { InterfaceText } from "../language/interface-text.ts";
import { describeWatchCondition, type WatchCondition } from "../routines/watch-contract.ts";
import { hasOnlyKeys, isPlainRecord } from "../util/value-guards.ts";

export const GITHUB_WATCH_SOURCE_TYPES = ["github_run", "ci", "release"] as const;
export type GithubWatchSourceType = (typeof GITHUB_WATCH_SOURCE_TYPES)[number];

/** `repo` absent: the repository of the session's checkout. */
export type GithubWatchSource =
	| { readonly type: "github_run"; readonly repo: string; readonly runId: number }
	| { readonly type: "ci"; readonly sha: string }
	| { readonly type: "release"; readonly tag: string; readonly repo?: string };

/** The sources one batched read per repository observes; a `ci` source is observed on the CI event stream. */
export type GithubPolledSource = Exclude<GithubWatchSource, { readonly type: "ci" }>;

const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
/** A tag a release can be cut from: git's ref-name characters, never a path step or whitespace. */
const TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.+/-]{0,199}$/u;
const MAX_RESULT_TEXT_CHARS = 200;
const MAX_RESULT_URL_CHARS = 2_048;

/** The authored typed sources' shapes in the model's words, for the description of the tool that arms them. */
export const GITHUB_WATCH_SHAPES =
	"{type:'github_run', repo:'owner/name', runId} (a GitHub Actions run), {type:'ci', sha} (the CI workflow of a pushed commit, full 40-hex sha) or {type:'release', tag, repo?} (a release published from a tag; repo defaults to this checkout's); each is read by the host as structured status, conclusion, failed job and URL, and fires once it is done, also when it already was at arming";

/** The authored typed sources: a discriminated union on `type`. */
export const githubWatchSourceSchema = Type.Union([
	Type.Object(
		{
			type: Type.Literal("github_run"),
			repo: Type.String({ pattern: REPO_PATTERN.source, description: "The run's repository, owner/name." }),
			runId: Type.Integer({
				minimum: 1,
				description: "The run id GitHub gave the run (its URL's /actions/runs/<id>).",
			}),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("ci"),
			sha: Type.String({ pattern: SHA_PATTERN.source, description: "The full sha of the pushed commit." }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("release"),
			tag: Type.String({ pattern: TAG_PATTERN.source, description: "The tag the release is published from." }),
			repo: Type.Optional(
				Type.String({ pattern: REPO_PATTERN.source, description: "owner/name; this checkout's when omitted." }),
			),
		},
		{ additionalProperties: false },
	),
]);

export function isGithubWatchSource(value: { readonly type: string }): value is GithubWatchSource {
	return (GITHUB_WATCH_SOURCE_TYPES as readonly string[]).includes(value.type);
}

function matching(value: unknown, pattern: RegExp, label: string): string {
	if (typeof value !== "string" || !pattern.test(value) || value.includes(".."))
		throw new TypeError(`Watch ${label} is invalid.`);
	return value;
}

/** A typed source as the ledger keeps it, or a TypeError. */
export function parseGithubWatchSource(value: unknown): GithubWatchSource {
	if (!isPlainRecord(value)) throw new TypeError("Watch source is invalid.");
	if (value.type === "github_run" && hasOnlyKeys(value, ["type", "repo", "runId"])) {
		if (typeof value.runId !== "number" || !Number.isSafeInteger(value.runId) || value.runId < 1)
			throw new TypeError("Watch run id is invalid.");
		return { type: "github_run", repo: matching(value.repo, REPO_PATTERN, "repository"), runId: value.runId };
	}
	if (value.type === "ci" && hasOnlyKeys(value, ["type", "sha"]))
		return { type: "ci", sha: matching(value.sha, SHA_PATTERN, "commit") };
	if (value.type === "release" && hasOnlyKeys(value, ["type", "tag", "repo"]))
		return {
			type: "release",
			tag: matching(value.tag, TAG_PATTERN, "tag"),
			...(value.repo === undefined ? {} : { repo: matching(value.repo, REPO_PATTERN, "repository") }),
		};
	throw new TypeError("Watch source is invalid.");
}

/** One identity per thing waited on: two watches of one subject are one wait. */
export function githubWatchSubject(source: GithubWatchSource): string {
	if (source.type === "github_run") return `run:${source.repo.toLowerCase()}:${source.runId}`;
	if (source.type === "ci") return `ci:${source.sha}`;
	return `release:${source.repo?.toLowerCase() ?? ""}:${source.tag}`;
}

/**
 * What a typed source was last seen as: `pending` while the run is queued or running or the release is not published,
 * `done` once it completed or was published. `status` and `conclusion` are GitHub's own words.
 */
export interface GithubWatchResult {
	readonly state: "pending" | "done";
	readonly status: string;
	readonly conclusion?: string;
	readonly failedJob?: string;
	/** Why the first failed job of a failed attempt could not be read, when it could not: the result is told without it. */
	readonly failedJobUnread?: string;
	readonly url?: string;
	/** The run (and its attempt) the result is of; a release has none. */
	readonly runId?: number;
	readonly runAttempt?: number;
	readonly observedAt: number;
}

function resultText(value: unknown, limit: number, label: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > limit)
		throw new TypeError(`Watch ${label} is invalid.`);
	return value;
}

function positiveInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new TypeError(`Watch ${label} is invalid.`);
	return value;
}

export function parseGithubWatchResult(value: unknown): GithubWatchResult {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, [
			"state",
			"status",
			"conclusion",
			"failedJob",
			"failedJobUnread",
			"url",
			"runId",
			"runAttempt",
			"observedAt",
		]) ||
		(value.state !== "pending" && value.state !== "done")
	)
		throw new TypeError("Watch result is invalid.");
	return {
		state: value.state,
		status: resultText(value.status, MAX_RESULT_TEXT_CHARS, "result status"),
		...(value.conclusion === undefined
			? {}
			: { conclusion: resultText(value.conclusion, MAX_RESULT_TEXT_CHARS, "result conclusion") }),
		...(value.failedJob === undefined
			? {}
			: { failedJob: resultText(value.failedJob, MAX_RESULT_TEXT_CHARS, "failed job") }),
		...(value.failedJobUnread === undefined
			? {}
			: { failedJobUnread: resultText(value.failedJobUnread, MAX_RESULT_TEXT_CHARS, "failed job reason") }),
		...(value.url === undefined ? {} : { url: resultText(value.url, MAX_RESULT_URL_CHARS, "result URL") }),
		...(value.runId === undefined ? {} : { runId: positiveInteger(value.runId, "result run") }),
		...(value.runAttempt === undefined ? {} : { runAttempt: positiveInteger(value.runAttempt, "result attempt") }),
		observedAt: positiveInteger(value.observedAt, "result time"),
	};
}

/** A result's words bounded as the ledger keeps them: a GitHub field longer than the bound is cut, never refused. */
export function boundedGithubWatchResult(result: GithubWatchResult): GithubWatchResult {
	const cut = (text: string | undefined, limit: number) =>
		text === undefined || text.length === 0 ? undefined : text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
	const conclusion = cut(result.conclusion, MAX_RESULT_TEXT_CHARS);
	const failedJob = cut(result.failedJob, MAX_RESULT_TEXT_CHARS);
	const failedJobUnread = cut(result.failedJobUnread, MAX_RESULT_TEXT_CHARS);
	const url = result.url !== undefined && result.url.length <= MAX_RESULT_URL_CHARS ? result.url : undefined;
	return {
		state: result.state,
		status: cut(result.status, MAX_RESULT_TEXT_CHARS) ?? "unknown",
		...(conclusion === undefined ? {} : { conclusion }),
		...(failedJob === undefined ? {} : { failedJob }),
		...(failedJobUnread === undefined ? {} : { failedJobUnread }),
		...(url === undefined ? {} : { url }),
		...(result.runId === undefined ? {} : { runId: result.runId }),
		...(result.runAttempt === undefined ? {} : { runAttempt: result.runAttempt }),
		observedAt: result.observedAt,
	};
}

/** A typed source's firing as a wake's details carry it (`details.github`), or undefined when they hold none this build reads. */
export function parseGithubWatchWake(
	value: unknown,
): { readonly source: GithubWatchSource; readonly result: GithubWatchResult } | undefined {
	if (!isPlainRecord(value)) return undefined;
	try {
		return { source: parseGithubWatchSource(value.source), result: parseGithubWatchResult(value.result) };
	} catch {
		return undefined;
	}
}

/** What a typed source waits on, in the model's words. */
export function describeGithubWatchSource(source: GithubWatchSource): string {
	if (source.type === "github_run") return `GitHub run ${source.runId} of ${source.repo}`;
	if (source.type === "ci") return `the CI of commit ${source.sha.slice(0, 12)}`;
	return `release ${source.tag}${source.repo === undefined ? "" : ` of ${source.repo}`}`;
}

/** What a done result says, in the model's words: the run's conclusion and failed job, or the published release. */
export function describeGithubWatchResult(source: GithubWatchSource, result: GithubWatchResult): string {
	const subject = describeGithubWatchSource(source);
	if (source.type === "release") return `${subject} is ${result.status}`;
	const job =
		result.failedJob !== undefined
			? ` (failed job: ${result.failedJob})`
			: result.failedJobUnread !== undefined
				? ` (its failed job could not be read: ${result.failedJobUnread})`
				: "";
	return `${subject} ${result.status}${result.conclusion === undefined ? "" : ` with ${result.conclusion}`}${job}`;
}

/** What a typed source waits on, in the owner's words (the interface language). */
export function describeGithubWatchSourceForOwner(
	source: GithubWatchSource,
	words: InterfaceText["chat"]["watch"]["github"],
): string {
	if (source.type === "github_run") return words.run(source.runId, source.repo);
	if (source.type === "ci") return words.ci(source.sha.slice(0, 7));
	return words.release(source.tag);
}

/** What a session watch waits on, a condition or a typed source, in the owner's words. */
export function describeSessionWatchSource(
	source: WatchCondition | GithubWatchSource,
	words: InterfaceText["chat"]["watch"],
): string {
	return isGithubWatchSource(source)
		? describeGithubWatchSourceForOwner(source, words.github)
		: describeWatchCondition(source, words);
}

/** What a done result says, in the owner's words: the run's conclusion and failed job, or the published release. */
export function describeGithubWatchResultForOwner(
	source: GithubWatchSource,
	result: GithubWatchResult,
	words: InterfaceText["chat"]["watch"]["github"],
): string {
	const subject = describeGithubWatchSourceForOwner(source, words);
	if (source.type === "release") return words.released(subject);
	return words.runEnded(
		subject,
		result.conclusion ?? result.status,
		result.failedJob,
		result.failedJob === undefined && result.failedJobUnread !== undefined,
	);
}

/** Read access to GitHub for the session's typed watches; the host supplies it (core never starts a process). */
export interface GithubWatchReader {
	/**
	 * The runs and releases of one repository (`repo` absent: the checkout's) the session waits on, read together: one
	 * reading per source, in order. A read that fails as a whole rejects.
	 */
	observe(
		repo: string | undefined,
		sources: readonly GithubPolledSource[],
		signal: AbortSignal,
	): Promise<readonly GithubWatchReading[]>;
	/** The first failed job of a failed CI attempt. */
	failedCiJob(identity: CiAttemptIdentity, signal: AbortSignal): Promise<string | undefined>;
	/**
	 * The runs of one repository (`repo` absent: the checkout's) GitHub created since `since`, the newest first, at most one
	 * listing's worth; `narrow` keeps one workflow's, one branch's or one event's. `since` is an instant on the process's
	 * monotonic clock (`monotonicNow`); the reader places it on GitHub's own clock (GitHub's time read from its response,
	 * less the monotonic time elapsed since), so no clock of this machine is compared with GitHub's creation times, and a
	 * run created after `since` is never left out.
	 */
	runsCreatedSince(
		repo: string | undefined,
		since: number,
		narrow: GithubRunNarrowing,
		signal: AbortSignal,
	): Promise<readonly GithubCreatedRun[]>;
	/**
	 * Whether GitHub created the release of `tag` before `since` (a monotonic instant, placed on GitHub's clock as
	 * {@link runsCreatedSince} places it); false while there is none.
	 */
	releasedBefore(repo: string | undefined, tag: string, since: number, signal: AbortSignal): Promise<boolean>;
}

/** What a listing of runs keeps: a workflow (its id, file name or display name), a branch or tag, an event. */
export interface GithubRunNarrowing {
	readonly workflow?: string;
	readonly branch?: string;
	readonly event?: "workflow_dispatch";
}

/** A run GitHub created, with its repository (owner/name) and creation time (epoch ms, on GitHub's clock). */
export interface GithubCreatedRun {
	readonly repo: string;
	readonly runId: number;
	readonly createdAt: number;
}

/** One source's reading: what it was seen as, or why it could not be read. */
export type GithubWatchReading =
	| { readonly ok: true; readonly result: GithubWatchResult }
	| { readonly ok: false; readonly reason: string };
