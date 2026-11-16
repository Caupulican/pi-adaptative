/**
 * The host's own arming of the session's waits on what its tool calls start outside it: a `git push` from the session's
 * checkout arms a `ci` watch on each commit it pushed (while the host's CI source follows the checkout), a pushed version
 * tag a `release` watch, and a `gh workflow run` or a release script (`npm run release*` and its pnpm, yarn and bun
 * forms) a `github_run` watch on each Actions run URL its output names (a run or a release only while the host offers its
 * reader of GitHub). Each is armed once per subject (a subject the session already watches, whoever armed it, is left
 * alone), under the authority of the turn the call ran in and charged to the entry it was made at (both read when the call
 * started), and
 * tells its result on the owner's phone besides waking the session. What was armed, and what could not be (the session's
 * watch slots are full), is told to the model in one note per call, steered into the running turn.
 *
 * Arms are made one call at a time, in the order the calls ended, so two calls naming one subject arm it once. A call
 * handed off to the background is read when its task reaches its terminal, from the task's output.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lexShellCommand } from "../objective-execution/git-shell-lexer.ts";
import { toolCallPushesGitAtCwd } from "../objective-execution/local-commit-delivery.ts";
import type { TurnAuthority } from "../turn-origin.ts";
import { describeGithubWatchSource, type GithubWatchSource, githubWatchSubject } from "./github-watch-source.ts";
import type { SessionWatchServed } from "./session-watch-ledger.ts";
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

/** A tag a release is cut from: a version, optionally v-prefixed, with a pre-release or build suffix. */
const VERSION_TAG = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/u;
/** One updated ref of `git push`'s report: its flag (fast-forward, forced, new), summary, source and destination. */
const PUSHED_REF =
	/^ ?([ +*]) +(\[new (?:branch|tag|reference)\]|[0-9a-f]{4,40}\.{2,3}([0-9a-f]{4,40})) +(\S+) -> (\S+)/gmu;
const RUN_URL = /https:\/\/[A-Za-z0-9.-]+\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/actions\/runs\/(\d{1,19})/gu;
/** A revision a push names that may be handed to `git rev-parse`: a ref name or an abbreviated sha, never an option. */
const REVISION = /^[A-Za-z0-9_][A-Za-z0-9_./+-]{0,254}$/u;
const PACKAGE_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const LEADING_WRAPPERS = new Set(["sudo", "command", "exec", "nohup", "time", "nice", "doas", "env"]);

/** One arming the host makes for the session. */
export interface AutoWatchRequest {
	readonly watchId: string;
	readonly purpose: string;
	readonly onFire: string;
	readonly condition: GithubWatchSource;
	readonly expiresAt: number;
	readonly parentToolName: string;
}

/**
 * Whom an arming answers to, read when the call starts: the authority of the turn the call runs in and the transcript
 * entry it was made at (its wakes are charged to that entry's spend window), so a call read only at its background
 * terminal still arms for the turn that made it.
 */
export interface AutoArmContext {
	readonly authority: TurnAuthority;
	readonly served?: SessionWatchServed;
}

/** The session's watches as the host arms them (`SessionWatchService` under an `auto` armer that tells the owner). */
export interface WatchAutoArmPort {
	/** Whether the host's CI source follows the session's checkout, which a `ci` watch is read from. */
	followsCi(): boolean;
	/** Whether the host offers its reader of GitHub, which a run or a release watch is read through. */
	readsGithub(): boolean;
	armingContext(): AutoArmContext;
	armedOn(source: GithubWatchSource): SessionWatchView | undefined;
	arm(request: AutoWatchRequest, context: AutoArmContext): Promise<SessionWatchView>;
	now(): number;
}

export interface WatchAutoArmDeps {
	/** Undefined where the session holds no watches (a worker, or before its routine runtime is built). */
	port(): WatchAutoArmPort | undefined;
	cwd(): string;
	/** Steers the model-facing note into the running turn; resolves once it is durable. */
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
	readonly pushes: boolean;
	readonly dispatches: boolean;
	readonly releases: boolean;
}

interface PlannedWatch {
	readonly source: GithubWatchSource;
	readonly deadlineMs: number;
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

/** `gh workflow run ...`: a workflow dispatch, whose output names the run it started. */
function dispatchesWorkflow(tokens: readonly string[]): boolean {
	return tokens[0] === "gh" && tokens[1] === "workflow" && tokens[2] === "run";
}

/** A package script whose name starts with `release` (`npm run release:patch`, `pnpm release`, `yarn run release`). */
function runsReleaseScript(tokens: readonly string[]): boolean {
	if (!PACKAGE_RUNNERS.has(tokens[0] ?? "")) return false;
	const verb = tokens[1] ?? "";
	const script = verb === "run" || verb === "run-script" ? tokens[2] : tokens[0] === "npm" ? undefined : verb;
	return script !== undefined && /^release(?:$|[:._-])/u.test(script);
}

/** What a call starting now may start outside the session; undefined for a call that starts nothing a watch reads. */
export function classifyStartedCall(toolName: string, args: unknown): StartedCall | undefined {
	const segments = commandSegments(toolName, args).map(invoked);
	const call: StartedCall = {
		toolName,
		pushes: toolCallPushesGitAtCwd(toolName, args),
		dispatches: segments.some(dispatchesWorkflow),
		releases: segments.some(runsReleaseScript),
	};
	return call.pushes || call.dispatches || call.releases ? call : undefined;
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

function purposeOf(source: GithubWatchSource): string {
	const subject = describeGithubWatchSource(source);
	if (source.type === "ci") return `${subject}, pushed by this session`;
	if (source.type === "github_run") return `${subject}, started by this session`;
	return `${subject}, whose tag this session pushed`;
}

const ON_FIRE =
	"Read the result. On a failure, inspect the failed job and repair its cause; once it succeeded, continue the work that waited on it. When the deadline passes first, find out why it has not finished.";

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
		if (call && port) this.started.set(toolCallId, { ...call, context: port.armingContext() });
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
		this.queue = this.queue
			.then(() => this.armFor(call, output))
			.catch((error: unknown) => {
				if (!this.deps.disposed()) this.deps.failed(error);
			});
	}

	private async armFor(call: StartedCall, output: string): Promise<void> {
		const port = this.deps.port();
		const { context } = call;
		if (!port || !context || this.deps.disposed()) return;
		const planned = await this.plan(call, output, port);
		const armed: string[] = [];
		const missed: string[] = [];
		for (const { source, deadlineMs } of planned) {
			if (port.armedOn(source)) continue;
			const watchId = watchIdOf(source);
			try {
				await port.arm(
					{
						watchId,
						purpose: purposeOf(source),
						onFire: ON_FIRE,
						condition: source,
						expiresAt: port.now() + deadlineMs,
						parentToolName: call.toolName,
					},
					context,
				);
				armed.push(
					`${watchId} on ${describeGithubWatchSource(source)} (deadline in ${deadlineMs / MINUTE_MS} minutes)`,
				);
			} catch (error) {
				missed.push(
					`${describeGithubWatchSource(source)}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		if (armed.length === 0 && missed.length === 0) return;
		const lines = [
			...(armed.length === 0
				? []
				: [
						`The host armed watches for what your last ${call.toolName} call started: ${armed.join("; ")}. Each result wakes you and is told to the owner; keep working instead of polling it, and arm no second watch on it.`,
					]),
			...(missed.length === 0
				? []
				: [
						`The host could not arm a watch on: ${missed.join("; ")}. Wait on it yourself if your work needs its result.`,
					]),
		];
		// The note lands at the session's next provider boundary, which may be the next run's; the arms of later calls never
		// wait for it.
		void this.deps.note(lines.join("\n")).catch((error: unknown) => {
			if (!this.deps.disposed()) this.deps.failed(error);
		});
	}

	/**
	 * The subjects a call's output names, at most {@link MAX_SUBJECTS_PER_CALL}, each once: a commit's CI only while the CI
	 * source follows the checkout, a run or a release only while the host offers its reader of GitHub, so no watch is armed
	 * that nothing can read.
	 */
	private async plan(call: StartedCall, output: string, port: WatchAutoArmPort): Promise<PlannedWatch[]> {
		const planned = new Map<string, PlannedWatch>();
		const add = (source: GithubWatchSource, deadlineMs: number) => {
			const subject = githubWatchSubject(source);
			if (planned.size < MAX_SUBJECTS_PER_CALL && !planned.has(subject))
				planned.set(subject, { source, deadlineMs });
		};
		const followsCi = port.followsCi();
		const readsGithub = port.readsGithub();
		if (call.pushes || call.releases)
			for (const ref of pushedRefs(output)) {
				if (ref.kind === "tag") {
					if (readsGithub && VERSION_TAG.test(ref.tag))
						add({ type: "release", tag: ref.tag }, RELEASE_DEADLINE_MS);
					continue;
				}
				if (!followsCi) continue;
				const sha = await resolveCommit(this.deps.cwd(), ref.revision);
				if (sha) add({ type: "ci", sha }, CI_DEADLINE_MS);
			}
		if (readsGithub && (call.dispatches || call.releases))
			for (const { repo, runId } of actionRunsNamed(output))
				add({ type: "github_run", repo, runId }, call.releases ? RELEASE_DEADLINE_MS : DISPATCHED_RUN_DEADLINE_MS);
		return [...planned.values()];
	}
}
