/**
 * The host's own arming of the session's waits on what its tool calls start outside it: a `git push` from the session's
 * checkout arms a `ci` watch on each commit it pushed (while the host's CI source follows the checkout), a pushed version
 * tag a `release` watch, and a `gh workflow run` or a release script (`npm run release*` and its pnpm, yarn and bun
 * forms) a `github_run` watch on each Actions run URL its output names that GitHub created after the call began (a run or a
 * release only while the host offers its reader of GitHub). A `gh workflow run` whose output names no run (older gh
 * prints none) is followed by listing that workflow's dispatched runs created since the call began, a few times over two
 * minutes, until GitHub lists one. A pushed tag whose release existed before the call arms nothing. Each is armed once per
 * subject (a subject the session already watches, whoever armed it, is left alone), for whoever made the call: the
 * session, under the authority of the turn the call ran in and charged to the entry it was made at (both read when the
 * call started), or a worker runtime, in its own slots, its wakes going to it. Each tells its result on the owner's phone
 * besides waking its armer. What was armed, what is still looked for and what was not armed (and why: nothing reads it,
 * it was there before the call, the slots are full) is told to the armer in one note per call.
 *
 * Arms are made one call at a time, in the order the calls ended, so two calls naming one subject arm it once; a read of
 * GitHub that waits for a run to be listed waits outside that order. A call handed off to the background is read when its
 * task reaches its terminal, from the task's output.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { englishText } from "../language/interface-text.ts";
import { lexShellCommand } from "../objective-execution/git-shell-lexer.ts";
import { toolCallPushesGitAtCwd } from "../objective-execution/local-commit-delivery.ts";
import { monotonicNow, type TimerPort } from "../util/timer-port.ts";
import { NO_CI_SOURCE, NO_READER } from "./github-watch-poller.ts";
import {
	describeGithubWatchSource,
	type GithubCreatedRun,
	type GithubWatchReader,
	type GithubWatchSource,
	githubWatchSubject,
} from "./github-watch-source.ts";
import type { SessionWatchArmer, SessionWatchServed } from "./session-watch-ledger.ts";
import type { SessionWatchView } from "./session-watch-service.ts";

/** The note telling the model which watches the host armed after one of its calls; the host's own words. */
export const WATCH_AUTO_ARM_CUSTOM_TYPE = "watch-auto-arm";

const MINUTE_MS = 60_000;
/** How long a pushed commit's CI, a dispatched run and a release are waited on. */
const CI_DEADLINE_MS = 60 * MINUTE_MS;
const DISPATCHED_RUN_DEADLINE_MS = 60 * MINUTE_MS;
const RELEASE_DEADLINE_MS = 120 * MINUTE_MS;
/** Distinct subjects one call's output arms at most; the session's watch slots bound the rest. */
const MAX_SUBJECTS_PER_CALL = 8;
const GIT_TIMEOUT_MS = 5_000;
/**
 * When GitHub is asked again for the run a `gh workflow run` started, after the call ended: GitHub creates a dispatched
 * run a few seconds after accepting the dispatch, so the first listing may hold none yet.
 */
const DISPATCH_LISTING_DELAYS_MS = [3_000, 10_000, 30_000, 60_000] as const;
const DISPATCH_LISTING_TIMEOUT_MS = 60_000;

/** A tag a release is cut from: a version, optionally v-prefixed, with a pre-release or build suffix. */
const VERSION_TAG = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/u;
/** One updated ref of `git push`'s report: its flag (fast-forward, forced, new), summary, source and destination. */
const PUSHED_REF =
	/^ ?([ +*]) +(\[new (?:branch|tag|reference)\]|[0-9a-f]{4,40}\.{2,3}([0-9a-f]{4,40})) +(\S+) -> (\S+)/gmu;
const RUN_URL = /https:\/\/[A-Za-z0-9.-]+\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/actions\/runs\/(\d{1,19})/gu;
/** A revision a push names that may be handed to `git rev-parse`: a ref name or an abbreviated sha, never an option. */
const REVISION = /^[A-Za-z0-9_][A-Za-z0-9_./+-]{0,254}$/u;
/** A repository `gh -R` names: owner/name, optionally behind a host. */
const REPO_ARGUMENT = /^(?:[A-Za-z0-9.-]+\/)?([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})$/u;
/** `gh workflow run` options that take a value, besides the ones read here (`--ref`, `--repo`). */
const DISPATCH_VALUE_OPTIONS = new Set(["-f", "--field", "-F", "--raw-field"]);
const PACKAGE_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const LEADING_WRAPPERS = new Set(["sudo", "command", "exec", "nohup", "time", "nice", "doas", "env"]);

/** One arming the host makes for the session. */
export interface AutoWatchRequest {
	readonly watchId: string;
	readonly onFire: string;
	readonly condition: GithubWatchSource;
	readonly expiresAt: number;
	readonly parentToolName: string;
}

/**
 * Whom an arming answers to, read when the call starts: the session under the authority of the turn the call runs in and
 * the transcript entry it was made at (its wakes are charged to that entry's spend window), so a call read only at its
 * background terminal still arms for the turn that made it; or the worker runtime that made the call.
 */
export interface AutoArmContext {
	readonly armer: Extract<SessionWatchArmer, { readonly kind: "auto" | "worker" }>;
	readonly served?: SessionWatchServed;
}

/** The session's watches as the host arms them (`SessionWatchService`, for the session or a worker, telling the owner). */
export interface WatchAutoArmPort {
	/** Whether the host's CI source follows the session's checkout, which a `ci` watch is read from. */
	followsCi(): boolean;
	/**
	 * The host's reader of GitHub while it offers one: a run or a release watch is read through it, and what a call started
	 * is told apart through it from what was there before the call.
	 */
	github(): GithubWatchReader | undefined;
	armingContext(): AutoArmContext;
	armedOn(source: GithubWatchSource): SessionWatchView | undefined;
	arm(request: AutoWatchRequest, context: AutoArmContext): Promise<SessionWatchView>;
	/** The session's routines clock: a watch's end time is on it, and the host's waits for a dispatched run are timed on it. */
	readonly timers: TimerPort;
}

export interface WatchAutoArmDeps {
	/** Undefined where the session holds no watches (before its routine runtime is built, or a session without one). */
	port(): WatchAutoArmPort | undefined;
	cwd(): string;
	/** Tells the armer the model-facing note; resolves once it is durable. */
	note(text: string): Promise<void>;
	/** Arming or its note failed while the session is not disposed: the owner is told. */
	failed(error: unknown): void;
	disposed(): boolean;
}

/** What a call may start outside the session that a watch can wait on. */
interface StartedCall {
	readonly toolName: string;
	/** Set when the call starts in a session that holds watches. */
	readonly context?: AutoArmContext;
	/**
	 * When the call began, on the process's monotonic clock (`monotonicNow`): the reader of GitHub places it on GitHub's clock
	 * (`GithubWatchReader.runsCreatedSince`), so a run or release GitHub created before it was not started by the call.
	 */
	readonly startedAt: number;
	readonly pushes: boolean;
	readonly dispatches: readonly DispatchedWorkflow[];
	readonly releases: boolean;
}

/** What one `gh workflow run` dispatches: the workflow, and the ref and repository when it names them. */
export interface DispatchedWorkflow {
	readonly workflow: string;
	readonly ref?: string;
	readonly repo?: string;
}

interface PlannedWatch {
	readonly source: GithubWatchSource;
	readonly deadlineMs: number;
}

/** What a call's output was read as: the watches to arm, the subjects armed nowhere and why, the dispatches looked for. */
interface CallPlan {
	readonly planned: readonly PlannedWatch[];
	readonly unwatched: readonly string[];
	readonly dispatched: readonly DispatchedWorkflow[];
}

/** The command segments a call runs: a shell call's lexed segments, or a process call's executable and arguments. */
function commandSegments(toolName: string, args: unknown): readonly (readonly string[])[] {
	const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	const name = toolName.toLowerCase();
	if (name === "bash" || name === "shell" || name === "powershell") {
		if (typeof record.command !== "string") return [];
		const lexed = lexShellCommand(record.command);
		return lexed.ok ? lexed.segments : [];
	}
	if (name === "run_process" || name === "run-process") {
		if (typeof record.executable !== "string") return [];
		const processArgs = Array.isArray(record.args)
			? record.args.filter((item): item is string => typeof item === "string")
			: [];
		return [[record.executable, ...processArgs]];
	}
	return [];
}

/** A segment's tokens past its leading wrappers (`sudo`, `env`, ...) and their options and assignments. */
function invoked(segment: readonly string[]): readonly string[] {
	let index = 0;
	let wrapped = false;
	while (index < segment.length) {
		const token = segment[index] ?? "";
		if (LEADING_WRAPPERS.has(token.toLowerCase())) wrapped = true;
		else if (!(wrapped && token.startsWith("-")) && !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token)) break;
		index += 1;
	}
	return segment.slice(index).map((token, position) => (position === 0 ? executableName(token) : token));
}

function executableName(token: string): string {
	const base = token.split(/[\\/]/u).pop() ?? token;
	return base.replace(/\.(?:exe|cmd)$/iu, "").toLowerCase();
}

/** `gh workflow run <workflow> [--ref ref] [-R repo]`: the workflow it dispatches; undefined for any other command. */
function dispatchedWorkflow(tokens: readonly string[]): DispatchedWorkflow | undefined {
	if (tokens[0] !== "gh" || tokens[1] !== "workflow" || tokens[2] !== "run") return undefined;
	let workflow: string | undefined;
	let ref: string | undefined;
	let repo: string | undefined;
	for (let index = 3; index < tokens.length; index += 1) {
		const token = tokens[index] ?? "";
		const [flag = "", inline] = token.startsWith("--") ? token.split(/=(.*)/su, 2) : [token, undefined];
		const value = () => inline ?? tokens[++index];
		if (flag === "--ref" || flag === "-r") ref = value();
		else if (flag === "--repo" || flag === "-R") repo = REPO_ARGUMENT.exec(value() ?? "")?.[1];
		else if (DISPATCH_VALUE_OPTIONS.has(flag)) value();
		else if (!flag.startsWith("-") && workflow === undefined) workflow = token;
	}
	if (workflow === undefined || workflow.length === 0) return undefined;
	return {
		workflow,
		...(ref !== undefined && REVISION.test(ref) && !ref.includes("..") ? { ref } : {}),
		...(repo === undefined ? {} : { repo }),
	};
}

/** A package script whose name starts with `release` (`npm run release:patch`, `pnpm release`, `yarn run release`). */
function runsReleaseScript(tokens: readonly string[]): boolean {
	if (!PACKAGE_RUNNERS.has(tokens[0] ?? "")) return false;
	const verb = tokens[1] ?? "";
	const script = verb === "run" || verb === "run-script" ? tokens[2] : tokens[0] === "npm" ? undefined : verb;
	return script !== undefined && /^release(?:$|[:._-])/u.test(script);
}

/** What a call starting now may start outside the session; undefined for a call that starts nothing a watch reads. */
export function classifyStartedCall(toolName: string, args: unknown): Omit<StartedCall, "startedAt"> | undefined {
	const segments = commandSegments(toolName, args).map(invoked);
	const call = {
		toolName,
		pushes: toolCallPushesGitAtCwd(toolName, args),
		dispatches: segments.flatMap((segment) => {
			const dispatch = dispatchedWorkflow(segment);
			return dispatch ? [dispatch] : [];
		}),
		releases: segments.some(runsReleaseScript),
	};
	return call.pushes || call.dispatches.length > 0 || call.releases ? call : undefined;
}

/** One ref a push updated: a version tag it created, or the revision a branch now points at. */
type PushedRef =
	| { readonly kind: "tag"; readonly tag: string }
	| { readonly kind: "commit"; readonly revision: string };

/** The refs `git push`'s report says it created or updated; rejected, deleted and up-to-date refs are none. */
export function pushedRefs(output: string): PushedRef[] {
	const refs: PushedRef[] = [];
	for (const match of output.matchAll(PUSHED_REF)) {
		const [, , summary = "", newSha, source = "", destination = ""] = match;
		const tag =
			summary === "[new tag]"
				? destination
				: destination.startsWith("refs/tags/")
					? destination.slice(10)
					: undefined;
		if (tag !== undefined) {
			refs.push({ kind: "tag", tag });
			continue;
		}
		const revision = newSha ?? source.split(":")[0] ?? "";
		if (REVISION.test(revision) && !revision.includes("..")) refs.push({ kind: "commit", revision });
	}
	return refs;
}

/** The GitHub Actions runs a call's output links to: repository and run id. */
export function actionRunsNamed(output: string): { readonly repo: string; readonly runId: number }[] {
	const runs = new Map<string, { repo: string; runId: number }>();
	for (const match of output.matchAll(RUN_URL)) {
		const [, repo = "", id = ""] = match;
		const runId = Number(id);
		if (Number.isSafeInteger(runId) && runId > 0) runs.set(`${repo}#${runId}`, { repo, runId });
	}
	return [...runs.values()];
}

/** The full sha a revision names in the checkout at `cwd`; undefined when it names no commit there. */
function resolveCommit(cwd: string, revision: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile(
			"git",
			["rev-parse", "--verify", "--quiet", "--end-of-options", `${revision}^{commit}`],
			{ cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, windowsHide: true },
			(error, stdout) => {
				const sha = error ? "" : stdout.trim();
				resolve(/^[0-9a-f]{40}$/u.test(sha) ? sha : undefined);
			},
		);
	});
}

function resultText(result: unknown): string {
	const content = result && typeof result === "object" ? Reflect.get(result, "content") : undefined;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block) =>
			block && typeof block === "object" && block.type === "text" && typeof block.text === "string"
				? [block.text]
				: [],
		)
		.join("\n");
}

/** The stub a call handed off to the background ends with (`BackgroundToolTaskController.handoff`): its task, running. */
function isBackgroundHandoff(result: unknown): boolean {
	const details = result && typeof result === "object" ? Reflect.get(result, "details") : undefined;
	return (
		details !== null &&
		typeof details === "object" &&
		typeof Reflect.get(details, "taskId") === "string" &&
		Reflect.get(details, "status") === "running"
	);
}

function shortHash(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function watchIdOf(source: GithubWatchSource): string {
	if (source.type === "ci") return `auto-ci-${source.sha.slice(0, 12)}`;
	if (source.type === "github_run") return `auto-run-${source.runId}`;
	return `auto-release-${shortHash(githubWatchSubject(source))}`;
}

/** What a source waits on, in the words of the note the armer reads. */
function subjectOf(source: GithubWatchSource): string {
	return describeGithubWatchSource(source, englishText().chat.watch.github);
}

const ON_FIRE =
	"Read the result. On a failure, inspect the failed job and repair its cause; once it succeeded, continue the work that waited on it. When the deadline passes first, find out why it has not finished.";

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function dispatchText(dispatch: DispatchedWorkflow): string {
	return `workflow ${dispatch.workflow}${dispatch.ref === undefined ? "" : ` on ${dispatch.ref}`}${dispatch.repo === undefined ? "" : ` of ${dispatch.repo}`}`;
}

export class WatchAutoArm {
	private readonly deps: WatchAutoArmDeps;
	private readonly started = new Map<string, StartedCall>();
	private queue: Promise<void> = Promise.resolve();

	constructor(deps: WatchAutoArmDeps) {
		this.deps = deps;
	}

	/** A tool call starts: one that may start outside work is remembered until it ends. */
	noteStart(toolCallId: string, toolName: string, args: unknown): void {
		const call = classifyStartedCall(toolName, args);
		const port = call && this.deps.port();
		if (call && port)
			this.started.set(toolCallId, {
				...call,
				context: port.armingContext(),
				startedAt: monotonicNow(),
			});
	}

	/**
	 * A tool call ended: what its output says it started is armed after the arms of the calls that ended before it. A call
	 * handed off to the background ended with a stub; it is read at its terminal instead ({@link noteTerminal}).
	 */
	noteEnd(toolCallId: string, result: unknown): void {
		if (!isBackgroundHandoff(result)) this.armAfter(toolCallId, resultText(result));
	}

	/** A call handed off to the background reached its terminal with `output`. */
	noteTerminal(toolCallId: string, output: string): void {
		this.armAfter(toolCallId, output);
	}

	private armAfter(toolCallId: string, output: string): void {
		const call = this.started.get(toolCallId);
		if (!call) return;
		this.started.delete(toolCallId);
		this.enqueue(() => this.armFor(call, output));
	}

	/** Runs one arming step after the ones before it; a failure is the owner's to hear, never the queue's end. */
	private enqueue(step: () => Promise<void>): void {
		this.queue = this.queue.then(step).catch((error: unknown) => {
			if (!this.deps.disposed()) this.deps.failed(error);
		});
	}

	private async armFor(call: StartedCall, output: string): Promise<void> {
		const port = this.deps.port();
		const { context } = call;
		if (!port || !context || this.deps.disposed()) return;
		const plan = await this.plan(call, output, port);
		const { armed, missed } = await this.armPlanned(plan.planned, call, port, context);
		this.tell([
			...(armed.length === 0
				? []
				: [
						`The host armed watches for what your last ${call.toolName} call started: ${armed.join("; ")}. Each result wakes you and is told to the owner; keep working instead of polling it, and arm no second watch on it.`,
					]),
			...(plan.dispatched.length === 0
				? []
				: [
						`Your ${call.toolName} call named no run it started, so the host is asking GitHub for the run of ${plan.dispatched.map(dispatchText).join("; ")} created since the call began, for up to two minutes, and arms a watch on it once listed; you are told then.`,
					]),
			...this.missedLines([...plan.unwatched, ...missed]),
		]);
		for (const dispatch of plan.dispatched) this.followDispatch(call, dispatch, 0);
	}

	private async armPlanned(
		planned: readonly PlannedWatch[],
		call: StartedCall,
		port: WatchAutoArmPort,
		context: AutoArmContext,
	): Promise<{ armed: string[]; missed: string[] }> {
		const armed: string[] = [];
		const missed: string[] = [];
		for (const { source, deadlineMs } of planned) {
			if (port.armedOn(source)) continue;
			const watchId = watchIdOf(source);
			try {
				await port.arm(
					{
						watchId,
						onFire: ON_FIRE,
						condition: source,
						expiresAt: port.timers.now() + deadlineMs,
						parentToolName: call.toolName,
					},
					context,
				);
				armed.push(`${watchId} on ${subjectOf(source)} (deadline in ${deadlineMs / MINUTE_MS} minutes)`);
			} catch (error) {
				missed.push(`${subjectOf(source)}: ${errorText(error)}`);
			}
		}
		return { armed, missed };
	}

	private missedLines(missed: readonly string[]): string[] {
		return missed.length === 0
			? []
			: [`The host armed no watch on: ${missed.join("; ")}. Wait on it yourself if your work needs its result.`];
	}

	/** Tells the armer the lines, without holding the arms of later calls: the note may land only at a later boundary. */
	private tell(lines: readonly string[]): void {
		if (lines.length === 0) return;
		void this.deps.note(lines.join("\n")).catch((error: unknown) => {
			if (!this.deps.disposed()) this.deps.failed(error);
		});
	}

	/**
	 * Asks GitHub, after the next delay, for the runs of a dispatched workflow created since the call began, outside the
	 * arming order; the oldest one no watch of the session holds yet is armed in that order. Asked again after each delay
	 * until one is listed, then the armer is told none was.
	 */
	private followDispatch(call: StartedCall, dispatch: DispatchedWorkflow, attempt: number): void {
		const port = this.deps.port();
		const delay = DISPATCH_LISTING_DELAYS_MS[attempt];
		if (!port || delay === undefined || this.deps.disposed()) return;
		port.timers.setTimeout(() => {
			void this.listDispatched(call, dispatch, attempt);
		}, delay);
	}

	private async listDispatched(call: StartedCall, dispatch: DispatchedWorkflow, attempt: number): Promise<void> {
		const port = this.deps.port();
		const reader = port?.github();
		if (!port || this.deps.disposed()) return;
		const last = attempt + 1 >= DISPATCH_LISTING_DELAYS_MS.length;
		let runs: readonly GithubCreatedRun[];
		try {
			if (!reader) throw new Error(NO_READER);
			runs = await reader.runsCreatedSince(
				dispatch.repo,
				call.startedAt,
				{
					workflow: dispatch.workflow,
					event: "workflow_dispatch",
					...(dispatch.ref === undefined ? {} : { branch: dispatch.ref }),
				},
				AbortSignal.timeout(DISPATCH_LISTING_TIMEOUT_MS),
			);
		} catch (error) {
			if (this.deps.disposed()) return;
			if (!last) this.followDispatch(call, dispatch, attempt + 1);
			else this.tell(this.missedLines([`the run of ${dispatchText(dispatch)}: ${errorText(error)}`]));
			return;
		}
		this.enqueue(async () => {
			const { context } = call;
			if (!context || this.deps.disposed()) return;
			const run = [...runs]
				.sort((a, b) => a.createdAt - b.createdAt || a.runId - b.runId)
				.map((entry): GithubWatchSource => ({ type: "github_run", repo: entry.repo, runId: entry.runId }))
				.find((source) => !port.armedOn(source));
			if (!run) {
				if (!last) this.followDispatch(call, dispatch, attempt + 1);
				else
					this.tell(
						this.missedLines([
							`the run of ${dispatchText(dispatch)}: GitHub listed none created since your ${call.toolName} call began`,
						]),
					);
				return;
			}
			const { armed, missed } = await this.armPlanned(
				[{ source: run, deadlineMs: DISPATCHED_RUN_DEADLINE_MS }],
				call,
				port,
				context,
			);
			this.tell([
				...(armed.length === 0
					? []
					: [
							`The host armed a watch on the run your earlier ${call.toolName} call started (${dispatchText(dispatch)}): ${armed.join("; ")}. Its result wakes you and is told to the owner; keep working instead of polling it.`,
						]),
				...this.missedLines(missed),
			]);
		});
	}

	/**
	 * The subjects a call's output names, at most {@link MAX_SUBJECTS_PER_CALL}, each once: a commit's CI only while the CI
	 * source follows the checkout, a run or a release only while the host offers its reader of GitHub, so no watch is armed
	 * that nothing can read; a run only when GitHub created it after the call began, a tag's release only when none existed
	 * before it. Every subject left out is named with why.
	 */
	private async plan(call: StartedCall, output: string, port: WatchAutoArmPort): Promise<CallPlan> {
		const planned = new Map<string, PlannedWatch>();
		const unwatched: string[] = [];
		const add = (source: GithubWatchSource, deadlineMs: number) => {
			const subject = githubWatchSubject(source);
			if (planned.size < MAX_SUBJECTS_PER_CALL && !planned.has(subject))
				planned.set(subject, { source, deadlineMs });
		};
		const leave = (source: GithubWatchSource, why: string) => unwatched.push(`${subjectOf(source)} (${why})`);
		const followsCi = port.followsCi();
		const reader = port.github();
		const signal = AbortSignal.timeout(DISPATCH_LISTING_TIMEOUT_MS);
		if (call.pushes || call.releases)
			for (const ref of pushedRefs(output)) {
				if (ref.kind === "tag") {
					if (!VERSION_TAG.test(ref.tag)) continue;
					const source: GithubWatchSource = { type: "release", tag: ref.tag };
					if (!reader) {
						leave(source, NO_READER);
						continue;
					}
					try {
						if (await reader.releasedBefore(undefined, ref.tag, call.startedAt, signal))
							leave(source, "it was published before your call began");
						else add(source, RELEASE_DEADLINE_MS);
					} catch (error) {
						leave(source, `whether it existed before your call could not be read: ${errorText(error)}`);
					}
					continue;
				}
				const sha = await resolveCommit(this.deps.cwd(), ref.revision);
				if (!sha) continue;
				if (followsCi) add({ type: "ci", sha }, CI_DEADLINE_MS);
				else leave({ type: "ci", sha }, NO_CI_SOURCE);
			}
		const named = call.dispatches.length > 0 || call.releases ? actionRunsNamed(output) : [];
		const deadlineMs = call.releases ? RELEASE_DEADLINE_MS : DISPATCHED_RUN_DEADLINE_MS;
		for (const repo of new Set(named.map((run) => run.repo))) {
			const runs = named
				.filter((run) => run.repo === repo)
				.map((run): GithubWatchSource => ({ type: "github_run", repo, runId: run.runId }));
			if (!reader) {
				for (const source of runs) leave(source, NO_READER);
				continue;
			}
			let created: ReadonlySet<number>;
			try {
				created = new Set(
					(await reader.runsCreatedSince(repo, call.startedAt, {}, signal)).map((run) => run.runId),
				);
			} catch (error) {
				for (const source of runs)
					leave(source, `whether GitHub created it after your call began could not be read: ${errorText(error)}`);
				continue;
			}
			for (const source of runs)
				if (source.type === "github_run" && created.has(source.runId)) add(source, deadlineMs);
				else leave(source, "GitHub created it before your call began");
		}
		// A dispatch whose output names no run (an older gh prints none) is looked for by listing its workflow's runs.
		const dispatched = named.length === 0 ? call.dispatches : [];
		if (!reader)
			for (const dispatch of dispatched) unwatched.push(`the run of ${dispatchText(dispatch)} (${NO_READER})`);
		return { planned: [...planned.values()], unwatched, dispatched: reader ? dispatched : [] };
	}
}
