import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { basename, dirname, join, relative, resolve } from "node:path";
import { PassThrough } from "node:stream";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import type { ExecResult } from "../../../src/core/exec.ts";
import { getResumableHumanInputSnapshot } from "../../../src/core/human-input.ts";
import { ModelRegistry } from "../../../src/core/model-registry.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import type { Settings } from "../../../src/core/settings/settings-schema.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { SessionManager } from "../../../src/kernel/session/session-manager.ts";
import { HARNESS_API, HARNESS_PROVIDER, ScriptedProvider } from "./scripted-provider.ts";
import { EffectGuard, VirtualFileSystem } from "./virtual-io.ts";
import { VirtualShell } from "./virtual-shell.ts";

/** Script tracks: the root session, each delegated worker, and the compaction summarizer share the root's track. */
export const SCRIPTED_TRACKS = ["root", "worker-a", "worker-b", "worker-c"] as const;
export const HARNESS_PROJECT_CWD = "/harness/project";

const TYPESAFE_FIXTURE_KEY = "apikey_harness_fixture_0001";
const HARNESS_PROVIDER_FIXTURE_KEY = "harness-fixture-credential";

/** Ordered record of what each lane reached. Failures print the last reached phase and what is still open. */
export class HarnessTrace {
	private readonly reachedPhases: string[] = [];
	private readonly openPhases = new Set<string>();
	private readonly liveWork = new Set<Promise<void>>();
	private readonly rejectedWork: unknown[] = [];

	/** Records work the body started, so the world joins it before the sessions it drives are torn down. */
	track<T>(work: Promise<T>): Promise<T> {
		const settled: Promise<void> = work.then(
			() => {
				this.liveWork.delete(settled);
			},
			(error: unknown) => {
				this.liveWork.delete(settled);
				this.rejectedWork.push(error);
			},
		);
		this.liveWork.add(settled);
		return work;
	}

	/** Waits until every tracked item settled; returns the rejections the body did not await itself. */
	async join(): Promise<unknown[]> {
		while (this.liveWork.size > 0) await Promise.all([...this.liveWork]);
		return this.rejectedWork.splice(0);
	}

	mark(lane: string, phase: string): void {
		this.reachedPhases.push(`${lane}:${phase}`);
	}

	open(lane: string, phase: string): void {
		this.openPhases.add(`${lane}:${phase}`);
	}

	close(lane: string, phase: string): void {
		this.openPhases.delete(`${lane}:${phase}`);
	}

	reached(phase: string): boolean {
		return this.reachedPhases.some((entry) => entry.endsWith(`:${phase}`));
	}

	require(phase: string): void {
		if (!this.reached(phase)) throw new Error(`Required phase was not reached: ${phase}; ${this.describe()}`);
	}

	describe(): string {
		const last = this.reachedPhases.at(-1) ?? "none";
		return `last=${last}; open=[${[...this.openPhases].join(", ")}]; reached=${this.reachedPhases.length}`;
	}
}

/** Bounded wait for a completion the scenario expects. A stall names the trace position, not a sleep. */
export async function withDeadline<T>(trace: HarnessTrace, label: string, work: Promise<T>, ms = 20_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new Error(`Deadline ${ms}ms exceeded waiting for ${label}; ${trace.describe()}`)),
			ms,
		);
	});
	try {
		return await Promise.race([work, deadline]);
	} finally {
		clearTimeout(timer);
	}
}

interface JudgeQuestion {
	type: "choice" | "noul" | "score";
	criteria?: Record<string, unknown> | unknown[];
}

interface JudgeRequestBody {
	model: string;
	questions: Record<string, JudgeQuestion>;
}

/**
 * An explicit judgment for one System One question: `noul` carries the probability that the question's
 * `true` criterion holds; `choice` names one criterion the question offers, with the confidence behind it.
 */
export type ScriptedJudgment =
	| { readonly kind: "noul"; readonly probability: number }
	| { readonly kind: "choice"; readonly choice: string; readonly confidence: number }
	/** A score question: the level the judgment puts its probability on, and the probability of that level. */
	| { readonly kind: "score"; readonly level: number; readonly confidence: number };

function judgmentAnswer(judgment: ScriptedJudgment, question: JudgeQuestion): Record<string, unknown> {
	if (judgment.kind === "noul") {
		if (question.type !== "noul") throw new Error(`scripted noul judgment does not fit a ${question.type} question`);
		return { type: "noul", noul: judgment.probability };
	}
	if (judgment.kind === "score") {
		if (question.type !== "score" || !Array.isArray(question.criteria)) {
			throw new Error(`scripted score judgment does not fit a ${question.type} question`);
		}
		const levels = question.criteria.map((_, index) => String(index));
		if (!levels.includes(String(judgment.level))) {
			throw new Error(`scripted score level ${judgment.level} is not offered (levels: ${levels.join(", ")})`);
		}
		const others = levels.filter((level) => level !== String(judgment.level));
		const probabilities: Record<string, number> = { [String(judgment.level)]: judgment.confidence };
		for (const other of others) probabilities[other] = (1 - judgment.confidence) / others.length;
		const score = Object.entries(probabilities).reduce((sum, [level, p]) => sum + Number(level) * p, 0);
		const legend = Object.fromEntries(question.criteria.map((criterion, index) => [String(index), criterion]));
		return { type: "score", score, confidence: judgment.confidence, probabilities, legend };
	}
	if (question.type !== "choice") throw new Error(`scripted choice judgment does not fit a ${question.type} question`);
	const offered = Object.keys(question.criteria ?? {});
	if (!offered.includes(judgment.choice)) {
		throw new Error(
			`scripted choice '${judgment.choice}' is not offered by the question (offered: ${offered.join(", ")})`,
		);
	}
	const others = offered.filter((choice) => choice !== judgment.choice);
	const probabilities: Record<string, number> = { [judgment.choice]: judgment.confidence };
	for (const other of others) probabilities[other] = (1 - judgment.confidence) / others.length;
	return { type: "choice", choice: judgment.choice, confidence: judgment.confidence, probabilities };
}

/**
 * Transport-boundary script for System One. A phase names exactly the questions it expects and their
 * judgments. A question outside the phase, or a judgment the question cannot take, fails the request and is
 * recorded, so the journey fails at settlement instead of answering on a guess.
 */
/** The typesafe driver's endpoints: the only System One URLs a scripted judgment may answer. */
const SYSTEM_ONE_MODELS_URL = "https://api.typesafe.ai/v1/models";
const SYSTEM_ONE_DECISIONS_URL = "https://api.typesafe.ai/v1/systemone";

export class ScriptedSystemOneTransport {
	readonly unscripted: string[] = [];
	private phase = "unentered";
	private expected = new Map<string, ScriptedJudgment>();
	/** "phase:id" pairs a production request answered. */
	private readonly consumed = new Set<string>();
	/** "phase:id" pairs a phase declared, in order. */
	private readonly declared: string[] = [];
	/** Declared pairs whose phase ended before any production request asked them. */
	private readonly unconsumed: string[] = [];

	enterPhase(name: string, judgments: Readonly<Record<string, ScriptedJudgment>>): void {
		this.closePhase();
		this.phase = name;
		this.expected = new Map(Object.entries(judgments));
		for (const id of this.expected.keys()) this.declared.push(`${name}:${id}`);
	}

	private closePhase(): void {
		for (const id of this.expected.keys()) {
			const key = `${this.phase}:${id}`;
			if (!this.consumed.has(key)) this.unconsumed.push(key);
		}
		this.expected = new Map();
	}

	/** Ends the last phase, then fails on any declared judgment no production request consumed. */
	assertConsumed(): void {
		this.closePhase();
		if (this.unconsumed.length > 0) {
			throw new Error(`Declared System One judgments never consumed: ${this.unconsumed.join(", ")}`);
		}
	}

	readonly fetch: typeof fetch = async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = init?.method ?? "GET";
		if (method === "GET" && url === SYSTEM_ONE_MODELS_URL) return Response.json({ data: [] });
		if (method !== "POST" || url !== SYSTEM_ONE_DECISIONS_URL || typeof init?.body !== "string") {
			this.unscripted.push(`${this.phase}: ${method} ${url}`);
			throw new Error(`Unscripted System One request: ${method} ${url}`);
		}
		const body = JSON.parse(init.body) as JudgeRequestBody;
		const answers: Record<string, unknown> = {};
		const rejected: string[] = [];
		for (const [id, question] of Object.entries(body.questions)) {
			const judgment = this.expected.get(id);
			if (judgment === undefined) {
				const offered = Object.keys(question.criteria ?? {}).join("|");
				rejected.push(`${id}:${question.type}[${offered}]`);
				continue;
			}
			try {
				answers[id] = judgmentAnswer(judgment, question);
				this.consumed.add(`${this.phase}:${id}`);
			} catch (error) {
				rejected.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (rejected.length > 0) {
			const detail = `${this.phase}: System One questions without an explicit judgment: ${rejected.join(", ")}`;
			this.unscripted.push(detail);
			throw new Error(detail);
		}
		return Response.json({ model: body.model, answers, usage: { input_tokens: 10, output_tokens: 5 } });
	};
}

/** One commit of the virtual repository: the full tree it records and its subject line. */
interface GitCommit {
	readonly sha: string;
	readonly parent: string | undefined;
	readonly tree: ReadonlyMap<string, string>;
	readonly subject: string;
}

type GitHead = { readonly kind: "branch"; readonly ref: string } | { readonly kind: "detached"; readonly sha: string };

/** One conflicted path as git records it in the index: stage 1 (base), 2 (ours), 3 (theirs). */
interface GitConflict {
	readonly base: string | undefined;
	readonly ours: string | undefined;
	readonly theirs: string | undefined;
}

/** A rebase in progress: commits still to replay, the replayed head, and where it stopped. */
interface GitRebase {
	readonly headName: string;
	readonly origHead: string;
	readonly total: number;
	todo: string[];
	done: number;
	replayHead: string;
	stoppedAt: string | undefined;
}

/** A checkout: its path, its git dir, what HEAD points at, the staged snapshot, and conflicts. */
interface GitWorktree {
	readonly path: string;
	readonly gitDir: string;
	head: GitHead;
	index: Map<string, string>;
	unmerged: Map<string, GitConflict>;
	rebase: GitRebase | undefined;
}

/** One index entry: the file mode and the blob that holds its content. */
interface GitIndexEntry {
	readonly mode: string;
	readonly blob: string;
}

interface GitOutcome {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

const NOT_A_REPOSITORY = "fatal: not a git repository (or any of the parent directories): .git\n";

/**
 * Stateful git for the worktree-sync engine and the SDK's own git reads. Commits, branches, worktrees, the
 * staged snapshot, merges and rebases are real state transitions; the working files and the git dirs live in
 * the world's virtual filesystem. Only the subcommands the production code issues are implemented; any other
 * command is recorded as unscripted and rejected.
 */
export class VirtualGit {
	readonly unscripted: string[] = [];
	private readonly io: VirtualFileSystem;
	private readonly root: string;
	private readonly commonDir: string;
	private readonly commits = new Map<string, GitCommit>();
	private readonly refs = new Map<string, string>();
	private readonly worktrees = new Map<string, GitWorktree>();
	private counter = 0;
	/** Blob contents by object id; tree contents by tree id; scratch index files by GIT_INDEX_FILE path. */
	private readonly blobs = new Map<string, string>();
	private readonly trees = new Map<string, ReadonlyMap<string, string>>();
	private readonly indexFiles = new Map<string, Map<string, GitIndexEntry>>();

	constructor(io: VirtualFileSystem, root: string) {
		this.io = io;
		this.root = root;
		this.commonDir = join(root, ".git");
	}

	/** Creates the repository with one commit of `committed` on `branch`, checked out at the root. */
	initialize(branch: string, committed: Readonly<Record<string, string>>): void {
		this.io.mkdirSync(this.commonDir, { recursive: true });
		const tree = new Map(Object.entries(committed));
		const sha = this.commit(tree, undefined, "Initial commit");
		this.refs.set(`refs/heads/${branch}`, sha);
		this.worktrees.set(this.root, {
			path: this.root,
			gitDir: this.commonDir,
			head: { kind: "branch", ref: `refs/heads/${branch}` },
			index: new Map(tree),
			unmerged: new Map(),
			rebase: undefined,
		});
	}

	/** The commit a ref names in the virtual repository, or undefined when the ref does not exist. */
	refSha(ref: string): string | undefined {
		return this.refs.get(ref);
	}

	/** Process exec port for the worktree-sync engine: asynchronous, results from the same state. */
	async exec(
		command: string,
		args: readonly string[],
		options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv },
	): Promise<ExecResult> {
		if (command !== "git") {
			this.unscripted.push(`${command} ${args.join(" ")} @ ${options.cwd}`);
			throw new Error(`Unscripted command: ${command}`);
		}
		const outcome = this.run(args, options.cwd, options.env ?? {});
		return {
			stdout: outcome.stdout,
			stderr: outcome.stderr,
			code: outcome.code,
			killed: false,
			stdoutTruncated: false,
			stderrTruncated: false,
		};
	}

	run(
		argv: readonly string[],
		cwd: string,
		env: Readonly<Record<string, string | undefined>> = {},
		input?: string,
	): GitOutcome {
		const args = [...argv];
		// Engine-injected `-c key=value` configuration does not change the state transitions modelled here.
		while (args[0] === "-c") args.splice(0, 2);
		// Outside any repository every git command fails the way real git fails.
		if (this.worktreeFor(cwd) === undefined) return { code: 128, stdout: "", stderr: NOT_A_REPOSITORY };
		try {
			return this.dispatch(args, cwd, env, input);
		} catch (error) {
			// Every throw is an unscripted command: it is recorded here so the close check cannot miss it.
			this.unscripted.push(
				`git ${args.join(" ")} @ ${cwd}: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw error;
		}
	}

	private dispatch(
		args: readonly string[],
		cwd: string,
		env: Readonly<Record<string, string | undefined>>,
		input: string | undefined,
	): GitOutcome {
		const [command = "", ...rest] = args;
		switch (command) {
			case "hash-object":
				return this.hashObject(rest, cwd, input);
			case "read-tree":
				return this.readTree(rest, cwd, env);
			case "update-index":
				return this.updateIndex(rest, env, input);
			case "write-tree":
				return this.writeTree(env);
			case "config":
				// git init writes core.filemode; any other unset key is exit status 1.
				if (rest[0] === "--get" && rest[1] === "core.filemode") return { code: 0, stdout: "true\n", stderr: "" };
				if (rest[0] === "--get" && rest[1] !== undefined) return { code: 1, stdout: "", stderr: "" };
				throw new Error(`Unscripted config: ${rest.join(" ")}`);
			case "rev-parse":
				return this.revParse(rest, cwd);
			case "symbolic-ref":
				return this.symbolicRef(rest, cwd);
			case "worktree":
				return this.worktreeCommand(rest, cwd);
			case "branch":
				return this.branchCommand(rest, cwd);
			case "status":
				return rest.includes("--porcelain=v2") ? this.statusHeader(cwd) : this.statusCommand(cwd);
			case "add":
				return this.addCommand(rest, cwd);
			case "commit":
				return this.commitCommand(rest, cwd);
			case "diff":
				return this.diffCommand(rest, cwd);
			case "ls-files":
				return this.lsFilesCommand(rest, cwd);
			case "merge-base":
				return this.mergeBaseCommand(rest, cwd);
			case "rev-list":
				return this.revListCommand(rest, cwd);
			case "log":
				return this.logCommand(rest, cwd);
			case "update-ref":
				return this.updateRef(rest);
			case "reset":
				return this.resetCommand(rest, cwd);
			case "rebase":
				return this.rebaseCommand(rest, cwd);
			case "remote":
				// The fixture repository has no remote: real git refuses the lookup with exit status 2.
				if (rest[0] === "get-url" && rest[1] === "origin")
					return { code: 2, stdout: "", stderr: "error: No such remote 'origin'\n" };
				throw new Error(`Unscripted remote: ${rest.join(" ")}`);
			default:
				this.unscripted.push(`git ${args.join(" ")} @ ${cwd}`);
				throw new Error(`Unscripted git command: ${command}`);
		}
	}

	private commit(tree: ReadonlyMap<string, string>, parent: string | undefined, subject: string): string {
		const sha = createHash("sha1")
			.update(JSON.stringify([parent ?? "", subject, [...tree].sort(), this.counter++]))
			.digest("hex");
		this.commits.set(sha, { sha, parent, tree: new Map(tree), subject });
		return sha;
	}

	private worktreeFor(cwd: string): GitWorktree | undefined {
		const target = resolve(cwd);
		let best: GitWorktree | undefined;
		for (const worktree of this.worktrees.values()) {
			const inside = target === worktree.path || target.startsWith(`${worktree.path}/`);
			if (inside && (best === undefined || worktree.path.length > best.path.length)) best = worktree;
		}
		return best;
	}

	private headSha(worktree: GitWorktree): string | undefined {
		if (worktree.rebase) return worktree.rebase.replayHead;
		return worktree.head.kind === "branch" ? this.refs.get(worktree.head.ref) : worktree.head.sha;
	}

	private treeOf(sha: string | undefined): ReadonlyMap<string, string> {
		return (
			(sha === undefined ? undefined : (this.commits.get(sha)?.tree ?? this.trees.get(sha))) ??
			new Map<string, string>()
		);
	}

	private resolveCommit(ref: string, cwd: string): string | undefined {
		if (this.commits.has(ref)) return ref;
		const branch = this.refs.get(`refs/heads/${ref}`);
		if (branch) return branch;
		if (ref === "HEAD") {
			const worktree = this.worktreeFor(cwd);
			return worktree ? this.headSha(worktree) : undefined;
		}
		return undefined;
	}

	private ancestorsOf(sha: string): Set<string> {
		const seen = new Set<string>();
		const queue = [sha];
		while (queue.length > 0) {
			const next = queue.shift();
			if (next === undefined || seen.has(next)) continue;
			seen.add(next);
			const parent = this.commits.get(next)?.parent;
			if (parent !== undefined) queue.push(parent);
		}
		return seen;
	}

	private isAncestor(ancestor: string, descendant: string): boolean {
		return this.ancestorsOf(descendant).has(ancestor);
	}

	private mergeBase(left: string, right: string): string | undefined {
		const fromLeft = this.ancestorsOf(left);
		let current: string | undefined = right;
		while (current !== undefined) {
			if (fromLeft.has(current)) return current;
			current = this.commits.get(current)?.parent;
		}
		return undefined;
	}

	/** Commits reachable from `tip` and not from `base`, oldest first (the rebase replay order). */
	private commitsBetween(base: string | undefined, tip: string): string[] {
		const excluded = base === undefined ? new Set<string>() : this.ancestorsOf(base);
		const collected: string[] = [];
		let current: string | undefined = tip;
		while (current !== undefined && !excluded.has(current)) {
			collected.push(current);
			current = this.commits.get(current)?.parent;
		}
		return collected.reverse();
	}

	private readWorking(worktree: GitWorktree, relative: string): string | undefined {
		const absolute = join(worktree.path, relative);
		if (!this.io.existsSync(absolute)) return undefined;
		return String(this.io.readFileSync(absolute, "utf8"));
	}

	private writeWorking(worktree: GitWorktree, relative: string, content: string | undefined): void {
		const absolute = join(worktree.path, relative);
		if (content === undefined) {
			if (this.io.existsSync(absolute)) this.io.unlinkSync(absolute);
			return;
		}
		this.io.mkdirSync(dirname(absolute), { recursive: true });
		this.io.writeFileSync(absolute, content);
	}

	/** Every regular file under the checkout except the git dir, as paths relative to the checkout. */
	private workingFiles(worktree: GitWorktree): string[] {
		const found: string[] = [];
		const visit = (directory: string): void => {
			const entries = this.io.readdirSync(directory, { withFileTypes: true }) as Array<{
				name: string;
				isDirectory(): boolean;
				isFile(): boolean;
			}>;
			for (const entry of entries) {
				if (entry.name === ".git") continue;
				const absolute = join(directory, entry.name);
				if (entry.isDirectory()) visit(absolute);
				else if (entry.isFile()) found.push(relative(worktree.path, absolute));
			}
		};
		visit(worktree.path);
		return found.sort();
	}

	/** `status --porcelain` lines: staged column, worktree column, then the path. */
	private statusLines(worktree: GitWorktree): string[] {
		const headTree = this.treeOf(this.headSha(worktree));
		const paths = new Set<string>([
			...headTree.keys(),
			...worktree.index.keys(),
			...worktree.unmerged.keys(),
			...this.workingFiles(worktree),
		]);
		const lines: string[] = [];
		for (const relative of [...paths].sort()) {
			if (worktree.unmerged.has(relative)) {
				lines.push(`UU ${relative}`);
				continue;
			}
			const indexed = worktree.index.get(relative);
			const headed = headTree.get(relative);
			const working = this.readWorking(worktree, relative);
			if (indexed === undefined && headed === undefined) {
				if (working !== undefined) lines.push(`?? ${relative}`);
				continue;
			}
			const staged = indexed === headed ? " " : indexed === undefined ? "D" : headed === undefined ? "A" : "M";
			const unstaged = working === indexed ? " " : working === undefined ? "D" : "M";
			if (staged === " " && unstaged === " ") continue;
			lines.push(`${staged}${unstaged} ${relative}`);
		}
		return lines;
	}

	private revParse(args: readonly string[], cwd: string): GitOutcome {
		const worktree = this.worktreeFor(cwd);
		const out: string[] = [];
		let verify = false;
		for (let index = 0; index < args.length; index++) {
			const arg = args[index] ?? "";
			if (arg === "--verify" || arg === "--quiet" || arg === "--path-format=absolute") {
				if (arg === "--verify") verify = true;
				continue;
			}
			if (
				arg === "--show-toplevel" ||
				arg === "--git-common-dir" ||
				arg === "--git-path" ||
				arg === "--absolute-git-dir"
			) {
				if (!worktree) return { code: 128, stdout: "", stderr: NOT_A_REPOSITORY };
				if (arg === "--show-toplevel") out.push(worktree.path);
				else if (arg === "--git-common-dir") out.push(this.commonDir);
				else if (arg === "--absolute-git-dir") out.push(worktree.gitDir);
				else out.push(join(worktree.gitDir, args[++index] ?? ""));
				continue;
			}
			if (arg === "--abbrev-ref") {
				if (!worktree) return { code: 128, stdout: "", stderr: NOT_A_REPOSITORY };
				if (args[++index] !== "HEAD") throw new Error(`Unscripted rev-parse --abbrev-ref: ${args.join(" ")}`);
				if (worktree.head.kind !== "branch")
					return { code: 128, stdout: "", stderr: "fatal: HEAD is not a branch\n" };
				out.push(worktree.head.ref.replace("refs/heads/", ""));
				continue;
			}
			if (arg === "HEAD") {
				if (!worktree) return { code: 128, stdout: "", stderr: NOT_A_REPOSITORY };
				const sha = this.headSha(worktree);
				if (sha === undefined) return { code: 128, stdout: "", stderr: "fatal: ambiguous argument 'HEAD'\n" };
				out.push(sha);
				continue;
			}
			if (arg === "HEAD^") {
				if (!worktree) return { code: 128, stdout: "", stderr: NOT_A_REPOSITORY };
				const parent = this.commits.get(this.headSha(worktree) ?? "")?.parent;
				if (parent === undefined) {
					return { code: 128, stdout: "", stderr: "fatal: ambiguous argument 'HEAD^': unknown revision\n" };
				}
				out.push(parent);
				continue;
			}
			if (arg.startsWith("refs/heads/")) {
				const sha = this.refs.get(arg);
				if (sha === undefined) {
					return verify
						? { code: 1, stdout: "", stderr: "" }
						: { code: 128, stdout: "", stderr: `fatal: ${arg}\n` };
				}
				out.push(sha);
				continue;
			}
			this.unscripted.push(`git rev-parse ${arg} @ ${cwd}`);
			throw new Error(`Unscripted rev-parse argument: ${arg}`);
		}
		return { code: 0, stdout: out.map((line) => `${line}\n`).join(""), stderr: "" };
	}

	private symbolicRef(args: readonly string[], cwd: string): GitOutcome {
		const worktree = this.worktreeFor(cwd);
		if (!worktree) return { code: 128, stdout: "", stderr: NOT_A_REPOSITORY };
		if (args[0] !== "--short" || args[1] !== "HEAD") throw new Error(`Unscripted symbolic-ref: ${args.join(" ")}`);
		if (worktree.head.kind !== "branch")
			return { code: 128, stdout: "", stderr: "fatal: ref HEAD is not a symbolic ref\n" };
		return { code: 0, stdout: `${worktree.head.ref.replace("refs/heads/", "")}\n`, stderr: "" };
	}

	private worktreeCommand(args: readonly string[], cwd: string): GitOutcome {
		const [subcommand, ...rest] = args;
		if (subcommand === "list") {
			const lines: string[] = [];
			for (const worktree of this.worktrees.values()) {
				lines.push(`worktree ${worktree.path}`);
				lines.push(`HEAD ${this.headSha(worktree) ?? "0".repeat(40)}`);
				lines.push(worktree.head.kind === "branch" ? `branch ${worktree.head.ref}` : "detached");
				lines.push("");
			}
			return { code: 0, stdout: lines.map((line) => `${line}\n`).join(""), stderr: "" };
		}
		if (subcommand === "prune") return { code: 0, stdout: "", stderr: "" };
		if (subcommand === "add") {
			const positional: string[] = [];
			let branch: string | undefined;
			for (let index = 0; index < rest.length; index++) {
				if (rest[index] === "-b") branch = rest[++index];
				else positional.push(rest[index] ?? "");
			}
			const [path, base] = positional;
			if (branch === undefined || path === undefined || base === undefined) {
				throw new Error(`Unscripted worktree add: ${args.join(" ")}`);
			}
			const absolute = resolve(cwd, path);
			if (this.worktrees.has(absolute) || this.io.existsSync(absolute)) {
				return { code: 128, stdout: "", stderr: `fatal: '${absolute}' already exists\n` };
			}
			if (this.refs.has(`refs/heads/${branch}`)) {
				return { code: 128, stdout: "", stderr: `fatal: a branch named '${branch}' already exists\n` };
			}
			const sha = this.resolveCommit(base, cwd);
			if (sha === undefined) return { code: 128, stdout: "", stderr: `fatal: invalid reference: ${base}\n` };
			this.refs.set(`refs/heads/${branch}`, sha);
			const gitDir = join(this.commonDir, "worktrees", basename(absolute));
			this.io.mkdirSync(gitDir, { recursive: true });
			const tree = this.treeOf(sha);
			const worktree: GitWorktree = {
				path: absolute,
				gitDir,
				head: { kind: "branch", ref: `refs/heads/${branch}` },
				index: new Map(tree),
				unmerged: new Map(),
				rebase: undefined,
			};
			this.io.mkdirSync(absolute, { recursive: true });
			for (const [relative, content] of tree) this.writeWorking(worktree, relative, content);
			this.worktrees.set(absolute, worktree);
			return { code: 0, stdout: "", stderr: `Preparing worktree (new branch '${branch}')\n` };
		}
		if (subcommand === "remove") {
			const force = rest.includes("--force");
			const target = resolve(cwd, rest.filter((arg) => arg !== "--force").at(-1) ?? "");
			const worktree = this.worktrees.get(target);
			if (!worktree) return { code: 128, stdout: "", stderr: `fatal: '${target}' is not a working tree\n` };
			if (worktree.path === this.root)
				return { code: 128, stdout: "", stderr: "fatal: cannot remove the main working tree\n" };
			if (!force && this.statusLines(worktree).length > 0) {
				return {
					code: 128,
					stdout: "",
					stderr: `fatal: '${target}' contains modified or untracked files, use --force to delete it\n`,
				};
			}
			this.worktrees.delete(target);
			this.io.rmSync(target, { recursive: true, force: true });
			this.io.rmSync(worktree.gitDir, { recursive: true, force: true });
			return { code: 0, stdout: "", stderr: "" };
		}
		throw new Error(`Unscripted worktree subcommand: ${subcommand ?? ""}`);
	}

	private branchCommand(args: readonly string[], cwd: string): GitOutcome {
		const [mode, name] = args;
		if ((mode !== "-d" && mode !== "-D") || name === undefined)
			throw new Error(`Unscripted branch: ${args.join(" ")}`);
		const ref = `refs/heads/${name}`;
		const sha = this.refs.get(ref);
		if (sha === undefined) return { code: 1, stdout: "", stderr: `error: branch '${name}' not found.\n` };
		for (const worktree of this.worktrees.values()) {
			if (worktree.head.kind === "branch" && worktree.head.ref === ref) {
				return {
					code: 128,
					stdout: "",
					stderr: `error: Cannot delete branch '${name}' checked out at '${worktree.path}'\n`,
				};
			}
		}
		if (mode === "-d") {
			const current = this.worktreeFor(cwd);
			const head = current ? this.headSha(current) : undefined;
			if (head === undefined || !this.isAncestor(sha, head)) {
				return { code: 1, stdout: "", stderr: `error: The branch '${name}' is not fully merged.\n` };
			}
		}
		this.refs.delete(ref);
		return { code: 0, stdout: `Deleted branch ${name} (was ${sha.slice(0, 7)}).\n`, stderr: "" };
	}

	/** The branch identity records `status --porcelain=v2 --branch` leads with; the capture reads only the head. */
	private statusHeader(cwd: string): GitOutcome {
		const worktree = this.worktreeFor(cwd);
		if (!worktree) return { code: 128, stdout: "", stderr: NOT_A_REPOSITORY };
		const head = this.headSha(worktree);
		const name = worktree.head.kind === "branch" ? worktree.head.ref.replace("refs/heads/", "") : "(detached)";
		return { code: 0, stdout: `# branch.oid ${head ?? "(initial)"}\0# branch.head ${name}\0`, stderr: "" };
	}

	private blobOf(content: string): string {
		const sha = createHash("sha1")
			.update(`blob ${Buffer.byteLength(content)}\0`)
			.update(content)
			.digest("hex");
		this.blobs.set(sha, content);
		return sha;
	}

	/** The staged snapshot as index entries; each staged blob is registered so object reads resolve. */
	private defaultIndexEntries(worktree: GitWorktree): Map<string, GitIndexEntry> {
		return new Map<string, GitIndexEntry>(
			[...worktree.index].map(([path, content]): [string, GitIndexEntry] => [
				path,
				{ mode: "100644", blob: this.blobOf(content) },
			]),
		);
	}

	private hashObject(args: readonly string[], cwd: string, input: string | undefined): GitOutcome {
		const worktree = this.worktreeFor(cwd);
		if (!worktree) return { code: 128, stdout: "", stderr: NOT_A_REPOSITORY };
		if (!args.includes("-w")) throw new Error(`Unscripted hash-object: ${args.join(" ")}`);
		if (args.includes("--stdin")) {
			if (input === undefined) throw new Error("hash-object --stdin without input");
			return { code: 0, stdout: `${this.blobOf(input)}\n`, stderr: "" };
		}
		const separator = args.indexOf("--");
		const path = separator >= 0 ? args[separator + 1] : undefined;
		if (path === undefined) throw new Error(`Unscripted hash-object: ${args.join(" ")}`);
		const content = this.readWorking(worktree, relative(worktree.path, resolve(cwd, path)));
		if (content === undefined) return { code: 128, stdout: "", stderr: `fatal: could not open '${path}'\n` };
		return { code: 0, stdout: `${this.blobOf(content)}\n`, stderr: "" };
	}

	/** `read-tree --empty` or `read-tree <commit>` into the scratch index named by GIT_INDEX_FILE. */
	private readTree(
		args: readonly string[],
		cwd: string,
		env: Readonly<Record<string, string | undefined>>,
	): GitOutcome {
		const indexFile = env.GIT_INDEX_FILE;
		if (indexFile === undefined) throw new Error(`Unscripted read-tree without a scratch index: ${args.join(" ")}`);
		if (args.includes("--empty")) {
			this.indexFiles.set(indexFile, new Map());
			return { code: 0, stdout: "", stderr: "" };
		}
		const revision = args.find((arg) => !arg.startsWith("-")) ?? "";
		const sha = this.resolveCommit(revision, cwd);
		const tree = sha === undefined ? undefined : this.commits.get(sha)?.tree;
		if (tree === undefined) return { code: 128, stdout: "", stderr: `fatal: not a valid object name: ${revision}\n` };
		this.indexFiles.set(
			indexFile,
			new Map(
				[...tree].map(([path, content]): [string, GitIndexEntry] => [
					path,
					{ mode: "100644", blob: this.blobOf(content) },
				]),
			),
		);
		return { code: 0, stdout: "", stderr: "" };
	}

	/** `update-index -z --index-info`: a `0` mode removes the path, any other mode sets its entry. */
	private updateIndex(
		args: readonly string[],
		env: Readonly<Record<string, string | undefined>>,
		input: string | undefined,
	): GitOutcome {
		const indexFile = env.GIT_INDEX_FILE;
		const entries = indexFile === undefined ? undefined : this.indexFiles.get(indexFile);
		if (entries === undefined || !args.includes("--index-info") || !args.includes("-z")) {
			throw new Error(`Unscripted update-index: ${args.join(" ")}`);
		}
		for (const record of (input ?? "").split("\0")) {
			if (record === "") continue;
			const tab = record.indexOf("\t");
			const [mode = "", blob = ""] = record.slice(0, tab).split(" ");
			const path = record.slice(tab + 1);
			if (mode === "0") entries.delete(path);
			else entries.set(path, { mode, blob });
		}
		return { code: 0, stdout: "", stderr: "" };
	}

	private writeTree(env: Readonly<Record<string, string | undefined>>): GitOutcome {
		const indexFile = env.GIT_INDEX_FILE;
		const entries = indexFile === undefined ? undefined : this.indexFiles.get(indexFile);
		if (entries === undefined) throw new Error("write-tree without a scratch index file");
		const sorted = [...entries].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
		const sha = createHash("sha1")
			.update(sorted.map(([path, entry]) => `${entry.mode} ${entry.blob} ${path}`).join("\n"))
			.digest("hex");
		const contents = new Map<string, string>();
		for (const [path, entry] of sorted) {
			const content = this.blobs.get(entry.blob);
			if (content === undefined) throw new Error(`write-tree: unknown blob ${entry.blob} for ${path}`);
			contents.set(path, content);
		}
		this.trees.set(sha, contents);
		return { code: 0, stdout: `${sha}\n`, stderr: "" };
	}

	/** The tree a diff operand names: a commit or revision names its tree, a written tree id names itself. */
	private treeFor(ref: string, cwd: string): ReadonlyMap<string, string> | undefined {
		const sha = this.resolveCommit(ref, cwd);
		return sha === undefined ? this.trees.get(ref) : this.commits.get(sha)?.tree;
	}

	private statusCommand(cwd: string): GitOutcome {
		const worktree = this.worktreeFor(cwd);
		if (!worktree) return { code: 128, stdout: "", stderr: NOT_A_REPOSITORY };
		const lines = this.statusLines(worktree);
		return { code: 0, stdout: lines.map((line) => `${line}\n`).join(""), stderr: "" };
	}

	private addCommand(args: readonly string[], cwd: string): GitOutcome {
		const worktree = this.worktreeFor(cwd);
		if (!worktree) return { code: 128, stdout: "", stderr: NOT_A_REPOSITORY };
		for (const path of args.filter((arg) => arg !== "--")) {
			const rel = relative(worktree.path, resolve(cwd, path));
			const working = this.readWorking(worktree, rel);
			if (working === undefined) worktree.index.delete(rel);
			else worktree.index.set(rel, working);
			worktree.unmerged.delete(rel);
		}
		return { code: 0, stdout: "", stderr: "" };
	}

	private commitCommand(args: readonly string[], cwd: string): GitOutcome {
		const worktree = this.worktreeFor(cwd);
		if (!worktree) return { code: 128, stdout: "", stderr: NOT_A_REPOSITORY };
		const messageIndex = args.indexOf("-m");
		const subject = messageIndex >= 0 ? (args[messageIndex + 1] ?? "") : undefined;
		if (subject === undefined || worktree.rebase) throw new Error(`Unscripted commit: ${args.join(" ")}`);
		const parent = this.headSha(worktree);
		const next = this.commit(worktree.index, parent, subject);
		if (worktree.head.kind === "branch") this.refs.set(worktree.head.ref, next);
		else worktree.head = { kind: "detached", sha: next };
		return { code: 0, stdout: "", stderr: "" };
	}

	private diffCommand(args: readonly string[], cwd: string): GitOutcome {
		const worktree = this.worktreeFor(cwd);
		if (!worktree) return { code: 128, stdout: "", stderr: NOT_A_REPOSITORY };
		if (args.includes("--quiet")) {
			const cached = args.includes("--cached");
			const dirty = this.statusLines(worktree).some((line) => {
				if (line.startsWith("UU")) return true;
				if (line.startsWith("??")) return false;
				return cached ? line[0] !== " " : line[1] !== " ";
			});
			return { code: dirty ? 1 : 0, stdout: "", stderr: "" };
		}
		if (args.includes("--diff-filter=U")) {
			const paths = [...worktree.unmerged.keys()].sort();
			return { code: 0, stdout: paths.map((path) => `${path}\n`).join(""), stderr: "" };
		}
		const dashes = args.indexOf("--");
		const operands = args.slice(0, dashes < 0 ? args.length : dashes).filter((arg) => !arg.startsWith("-"));
		const pathspecs = dashes < 0 ? [] : args.slice(dashes + 1).map((spec) => spec.replace(":(literal)", ""));
		const range = operands.find((arg) => arg.includes(".."));
		const ambiguous = (ref: string): GitOutcome => ({
			code: 128,
			stdout: "",
			stderr: `fatal: ambiguous argument '${ref}'\n`,
		});
		// `before` and `after` map path to content; without `after` the working checkout is the right side.
		let before: ReadonlyMap<string, string>;
		let after: ReadonlyMap<string, string> | undefined;
		if (range !== undefined) {
			const separator = range.includes("...") ? "..." : "..";
			const [leftRef = "", rightRef = ""] = range.split(separator);
			const right = this.resolveCommit(rightRef, cwd);
			const leftResolved = this.resolveCommit(leftRef, cwd);
			if (right === undefined || leftResolved === undefined) return ambiguous(range);
			const left = separator === "..." ? (this.mergeBase(leftResolved, right) ?? leftResolved) : leftResolved;
			before = this.treeOf(left);
			after = this.treeOf(right);
		} else if (operands.length === 2) {
			const left = this.treeFor(operands[0] ?? "", cwd);
			const right = this.treeFor(operands[1] ?? "", cwd);
			if (left === undefined || right === undefined) return ambiguous(operands.join(" "));
			before = left;
			after = right;
		} else if (operands.length === 1) {
			const left = this.treeFor(operands[0] ?? "", cwd);
			if (left === undefined) return ambiguous(operands[0] ?? "");
			before = left;
		} else {
			throw new Error(`Unscripted diff: ${args.join(" ")}`);
		}
		const readAfter = (path: string): string | undefined =>
			after ? after.get(path) : this.readWorking(worktree, path);
		const candidates = new Set([...before.keys(), ...(after ? after.keys() : worktree.index.keys())]);
		const added = args.includes("--diff-filter=A");
		const changed = [...candidates]
			.filter((path) => pathspecs.length === 0 || pathspecs.includes(path))
			.sort()
			.map((path) => ({ path, old: before.get(path), next: readAfter(path) }))
			.filter(({ old, next }) => old !== next)
			.filter(({ old, next }) => !added || (old === undefined && next !== undefined));
		if (args.includes("--name-only")) {
			const terminator = args.includes("-z") ? "\0" : "\n";
			return { code: 0, stdout: changed.map(({ path }) => `${path}${terminator}`).join(""), stderr: "" };
		}
		const patch = changed.map(({ path, old, next }) => {
			const lines = [
				`diff --git a/${path} b/${path}`,
				old === undefined ? "--- /dev/null" : `--- a/${path}`,
				next === undefined ? "+++ /dev/null" : `+++ b/${path}`,
			];
			if (old !== undefined) lines.push(...old.split("\n").map((line) => `-${line}`));
			if (next !== undefined) lines.push(...next.split("\n").map((line) => `+${line}`));
			return `${lines.join("\n")}\n`;
		});
		return { code: 0, stdout: patch.join(""), stderr: "" };
	}

	private lsFilesCommand(args: readonly string[], cwd: string): GitOutcome {
		const worktree = this.worktreeFor(cwd);
		if (!worktree) return { code: 128, stdout: "", stderr: NOT_A_REPOSITORY };
		const nul = args.includes("-z") ? "\0" : "\n";
		if (args.includes("--others")) {
			const tracked = new Set([...this.treeOf(this.headSha(worktree)).keys(), ...worktree.index.keys()]);
			const untracked = this.workingFiles(worktree).filter((path) => !tracked.has(path));
			return { code: 0, stdout: untracked.map((path) => `${path}${nul}`).join(""), stderr: "" };
		}
		if (args.includes("--stage")) {
			const entries = this.defaultIndexEntries(worktree);
			return {
				code: 0,
				stdout: [...entries].map(([path, entry]) => `${entry.mode} ${entry.blob} 0\t${path}${nul}`).join(""),
				stderr: "",
			};
		}
		if (args.includes("--cached")) {
			return {
				code: 0,
				stdout: [...worktree.index.keys()]
					.sort()
					.map((path) => `${path}${nul}`)
					.join(""),
				stderr: "",
			};
		}
		if (args[0] !== "-u") throw new Error(`Unscripted ls-files: ${args.join(" ")}`);
		const blob = (content: string): string => this.blobOf(content);
		const lines: string[] = [];
		for (const [path, conflict] of [...worktree.unmerged].sort(([left], [right]) => left.localeCompare(right))) {
			if (conflict.base !== undefined) lines.push(`100644 ${blob(conflict.base)} 1\t${path}`);
			if (conflict.ours !== undefined) lines.push(`100644 ${blob(conflict.ours)} 2\t${path}`);
			if (conflict.theirs !== undefined) lines.push(`100644 ${blob(conflict.theirs)} 3\t${path}`);
		}
		return { code: 0, stdout: lines.map((line) => `${line}\n`).join(""), stderr: "" };
	}

	private mergeBaseCommand(args: readonly string[], cwd: string): GitOutcome {
		if (args[0] === "--is-ancestor") {
			const ancestor = this.resolveCommit(args[1] ?? "", cwd);
			const descendant = this.resolveCommit(args[2] ?? "", cwd);
			if (ancestor === undefined || descendant === undefined) {
				return { code: 128, stdout: "", stderr: `fatal: Not a valid object name\n` };
			}
			return { code: this.isAncestor(ancestor, descendant) ? 0 : 1, stdout: "", stderr: "" };
		}
		const left = this.resolveCommit(args[0] ?? "", cwd);
		const right = this.resolveCommit(args[1] ?? "", cwd);
		if (left === undefined || right === undefined)
			return { code: 128, stdout: "", stderr: "fatal: Not a valid object name\n" };
		const base = this.mergeBase(left, right);
		return base === undefined ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: `${base}\n`, stderr: "" };
	}

	private revListCommand(args: readonly string[], cwd: string): GitOutcome {
		const range = args.find((arg) => arg.includes("..."));
		if (range === undefined || !args.includes("--left-right") || !args.includes("--count")) {
			throw new Error(`Unscripted rev-list: ${args.join(" ")}`);
		}
		const [leftRef = "", rightRef = ""] = range.split("...");
		const left = this.resolveCommit(leftRef, cwd);
		const right = this.resolveCommit(rightRef, cwd);
		if (left === undefined || right === undefined) return { code: 128, stdout: "", stderr: "fatal: bad revision\n" };
		const fromLeft = this.ancestorsOf(left);
		const fromRight = this.ancestorsOf(right);
		const behind = [...fromLeft].filter((sha) => !fromRight.has(sha)).length;
		const ahead = [...fromRight].filter((sha) => !fromLeft.has(sha)).length;
		return { code: 0, stdout: `${behind}\t${ahead}\n`, stderr: "" };
	}

	private logCommand(args: readonly string[], cwd: string): GitOutcome {
		const sha = args.at(-1) ?? "";
		const commit = this.commits.get(this.resolveCommit(sha, cwd) ?? "");
		if (args[0] !== "-1" || args[1] !== "--format=%s" || commit === undefined) {
			throw new Error(`Unscripted log: ${args.join(" ")}`);
		}
		return { code: 0, stdout: `${commit.subject}\n`, stderr: "" };
	}

	private updateRef(args: readonly string[]): GitOutcome {
		const [ref = "", next = "", expected] = args;
		const current = this.refs.get(ref);
		if (expected !== undefined && current !== expected) {
			return {
				code: 1,
				stdout: "",
				stderr: `error: cannot lock ref '${ref}': is at ${current ?? "nothing"} but expected ${expected}\n`,
			};
		}
		// Branches hold commits only; other refs (the work-baseline refs) may name any stored object, trees included.
		const storable = this.commits.has(next) || (!ref.startsWith("refs/heads/") && this.trees.has(next));
		if (!storable) return { code: 128, stdout: "", stderr: `fatal: invalid new value for ${ref}\n` };
		this.refs.set(ref, next);
		return { code: 0, stdout: "", stderr: "" };
	}

	private resetCommand(args: readonly string[], cwd: string): GitOutcome {
		const worktree = this.worktreeFor(cwd);
		if (!worktree) return { code: 128, stdout: "", stderr: NOT_A_REPOSITORY };
		const target = args.find((arg) => arg !== "--merge");
		const sha = target === undefined ? undefined : this.resolveCommit(target, cwd);
		if (args[0] !== "--merge" || sha === undefined) throw new Error(`Unscripted reset: ${args.join(" ")}`);
		const next = this.treeOf(sha);
		const paths = new Set([...worktree.index.keys(), ...next.keys()]);
		for (const path of paths) {
			if (worktree.index.get(path) === next.get(path)) continue;
			if (this.readWorking(worktree, path) !== worktree.index.get(path)) {
				return {
					code: 128,
					stdout: "",
					stderr: `error: Entry '${path}' would be overwritten by merge. Cannot merge.\n`,
				};
			}
		}
		for (const path of paths) {
			if (worktree.index.get(path) !== next.get(path)) this.writeWorking(worktree, path, next.get(path));
		}
		worktree.index = new Map(next);
		worktree.unmerged.clear();
		if (worktree.head.kind === "branch") this.refs.set(worktree.head.ref, sha);
		return { code: 0, stdout: "", stderr: "" };
	}

	private rebaseCommand(args: readonly string[], cwd: string): GitOutcome {
		const worktree = this.worktreeFor(cwd);
		if (!worktree) return { code: 128, stdout: "", stderr: NOT_A_REPOSITORY };
		const [first = ""] = args;
		if (first === "--continue") return this.rebaseContinue(worktree);
		if (first === "--skip") return this.rebaseSkip(worktree);
		if (first === "--abort") return this.rebaseAbort(worktree);
		if (args.length !== 1 || worktree.rebase) throw new Error(`Unscripted rebase: ${args.join(" ")}`);
		return this.rebaseStart(worktree, first, cwd);
	}

	private rebaseStart(worktree: GitWorktree, onto: string, cwd: string): GitOutcome {
		if (worktree.head.kind !== "branch")
			return { code: 128, stdout: "", stderr: "fatal: rebase requires a branch\n" };
		if (this.statusLines(worktree).some((line) => !line.startsWith("??"))) {
			return { code: 1, stdout: "", stderr: "error: cannot rebase: You have unstaged changes.\n" };
		}
		const branchSha = this.refs.get(worktree.head.ref);
		const ontoSha = this.resolveCommit(onto, cwd);
		if (branchSha === undefined || ontoSha === undefined)
			return { code: 128, stdout: "", stderr: `fatal: invalid upstream '${onto}'\n` };
		if (this.isAncestor(ontoSha, branchSha))
			return { code: 0, stdout: "Current branch is up to date.\n", stderr: "" };
		if (this.isAncestor(branchSha, ontoSha)) {
			this.refs.set(worktree.head.ref, ontoSha);
			this.adoptTree(worktree, this.treeOf(ontoSha));
			return { code: 0, stdout: "Fast-forwarded.\n", stderr: "" };
		}
		const todo = this.commitsBetween(this.mergeBase(branchSha, ontoSha), branchSha);
		this.adoptTree(worktree, this.treeOf(ontoSha));
		worktree.rebase = {
			headName: worktree.head.ref,
			origHead: branchSha,
			total: todo.length,
			todo,
			done: 0,
			replayHead: ontoSha,
			stoppedAt: undefined,
		};
		return this.drive(worktree);
	}

	/** Moves the staged snapshot and the working files of the changed paths to `tree`. */
	private adoptTree(worktree: GitWorktree, tree: ReadonlyMap<string, string>): void {
		const paths = new Set([...worktree.index.keys(), ...tree.keys()]);
		for (const path of paths) {
			if (worktree.index.get(path) !== tree.get(path)) this.writeWorking(worktree, path, tree.get(path));
		}
		worktree.index = new Map(tree);
		worktree.unmerged.clear();
	}

	/** Replays commits in order; stops at the first conflicting commit with rebase state on disk. */
	private drive(worktree: GitWorktree): GitOutcome {
		const rebase = worktree.rebase;
		if (rebase === undefined) return { code: 0, stdout: "", stderr: "" };
		while (rebase.todo.length > 0) {
			const sha = rebase.todo[0] ?? "";
			const commit = this.commits.get(sha);
			if (commit === undefined) throw new Error(`Rebase references a missing commit: ${sha}`);
			const base = this.treeOf(commit.parent);
			const ours = worktree.index;
			const theirs = commit.tree;
			const merged = new Map<string, string>();
			const conflicts = new Map<string, GitConflict>();
			for (const path of new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])) {
				const b = base.get(path);
				const o = ours.get(path);
				const t = theirs.get(path);
				if (o === t) {
					if (o !== undefined) merged.set(path, o);
				} else if (o === b) {
					if (t !== undefined) merged.set(path, t);
				} else if (t === b) {
					if (o !== undefined) merged.set(path, o);
				} else {
					conflicts.set(path, { base: b, ours: o, theirs: t });
					if (o !== undefined) merged.set(path, o);
				}
			}
			const previous = worktree.index;
			worktree.index = merged;
			for (const path of new Set([...previous.keys(), ...merged.keys()])) {
				if (previous.get(path) !== merged.get(path)) this.writeWorking(worktree, path, merged.get(path));
			}
			if (conflicts.size > 0) {
				for (const [path, conflict] of conflicts) {
					worktree.unmerged.set(path, conflict);
					this.writeWorking(worktree, path, this.conflictText(conflict, commit.subject));
				}
				rebase.stoppedAt = sha;
				this.writeRebaseState(worktree);
				const detail = [...conflicts.keys()].map((path) => `CONFLICT (content): Merge conflict in ${path}`);
				return {
					code: 1,
					stdout: "",
					stderr: `${detail.join("\n")}\nerror: could not apply ${sha.slice(0, 7)}... ${commit.subject}\n`,
				};
			}
			rebase.replayHead = this.commit(worktree.index, rebase.replayHead, commit.subject);
			rebase.todo.shift();
			rebase.done++;
		}
		this.refs.set(rebase.headName, rebase.replayHead);
		worktree.rebase = undefined;
		this.io.rmSync(join(worktree.gitDir, "rebase-merge"), { recursive: true, force: true });
		return { code: 0, stdout: `Successfully rebased and updated ${rebase.headName}.\n`, stderr: "" };
	}

	private conflictText(conflict: GitConflict, subject: string): string {
		const body = (content: string | undefined): string[] => (content ?? "").replace(/\n$/, "").split("\n");
		return `${[
			"<<<<<<< HEAD",
			...body(conflict.ours),
			"||||||| parent",
			...body(conflict.base),
			"=======",
			...body(conflict.theirs),
			`>>>>>>> ${subject}`,
		].join("\n")}\n`;
	}

	private writeRebaseState(worktree: GitWorktree): void {
		const rebase = worktree.rebase;
		if (rebase === undefined) return;
		const directory = join(worktree.gitDir, "rebase-merge");
		this.io.mkdirSync(directory, { recursive: true });
		this.io.writeFileSync(join(directory, "msgnum"), `${rebase.done + 1}\n`);
		this.io.writeFileSync(join(directory, "end"), `${rebase.total}\n`);
		this.io.writeFileSync(join(directory, "head-name"), `${rebase.headName}\n`);
		this.io.writeFileSync(join(directory, "orig-head"), `${rebase.origHead}\n`);
		if (rebase.stoppedAt !== undefined)
			this.io.writeFileSync(join(directory, "stopped-sha"), `${rebase.stoppedAt}\n`);
	}

	private rebaseContinue(worktree: GitWorktree): GitOutcome {
		const rebase = worktree.rebase;
		if (rebase === undefined || rebase.stoppedAt === undefined) {
			return { code: 128, stdout: "", stderr: "fatal: No rebase in progress?\n" };
		}
		for (const path of worktree.unmerged.keys()) {
			const working = this.readWorking(worktree, path) ?? "";
			if (working.includes("<<<<<<<")) {
				return { code: 1, stdout: "", stderr: `error: you must resolve conflicts in ${path} before continuing\n` };
			}
			worktree.index.set(path, working);
		}
		worktree.unmerged.clear();
		const subject = this.commits.get(rebase.stoppedAt)?.subject ?? "";
		rebase.replayHead = this.commit(worktree.index, rebase.replayHead, subject);
		rebase.todo.shift();
		rebase.done++;
		rebase.stoppedAt = undefined;
		return this.drive(worktree);
	}

	private rebaseSkip(worktree: GitWorktree): GitOutcome {
		const rebase = worktree.rebase;
		if (rebase === undefined || rebase.stoppedAt === undefined) {
			return { code: 128, stdout: "", stderr: "fatal: No rebase in progress?\n" };
		}
		this.adoptTree(worktree, this.treeOf(rebase.replayHead));
		rebase.todo.shift();
		rebase.done++;
		rebase.stoppedAt = undefined;
		return this.drive(worktree);
	}

	private rebaseAbort(worktree: GitWorktree): GitOutcome {
		const rebase = worktree.rebase;
		if (rebase === undefined) return { code: 128, stdout: "", stderr: "fatal: no rebase in progress\n" };
		this.adoptTree(worktree, this.treeOf(rebase.origHead));
		worktree.rebase = undefined;
		this.io.rmSync(join(worktree.gitDir, "rebase-merge"), { recursive: true, force: true });
		return { code: 0, stdout: "", stderr: "" };
	}
}

/**
 * Virtual process table. The only live identity is the in-process host pid: liveness probes (signal 0) answer
 * for it, any other pid is ESRCH, and a nonzero signal would reach a process the fixture never admitted, so it is
 * refused and recorded (the close path asserts none was attempted).
 */
export class VirtualProcessTable {
	readonly self: number = process.pid;
	readonly refused: string[] = [];

	isAlive(pid: number): boolean {
		return pid === this.self;
	}

	signal(pid: number, signal?: NodeJS.Signals | number): boolean {
		if (!this.isAlive(pid)) {
			throw Object.assign(new Error(`kill ESRCH: no virtual process ${pid}`), { code: "ESRCH", syscall: "kill" });
		}
		// Node's default signal for process.kill is SIGTERM, which is nonzero.
		if (signal === 0) return true;
		const label = `kill ${pid} ${signal ?? "SIGTERM"}`;
		this.refused.push(label);
		throw new Error(`Live signal refused: ${label}`);
	}

	assertClean(): void {
		if (this.refused.length > 0) throw new Error(`Refused virtual signals: ${this.refused.join("; ")}`);
	}
}

/**
 * Child-process boundary. `git` answers come from the stateful repository; any other command is rejected.
 * Sync results mirror the real child_process contract: a non-zero status throws with its stderr.
 */
/**
 * A git child process for `spawn`: its output and exit are the virtual repository's answer, emitted once the
 * caller has attached its listeners. Stream and event shape match what the production settlement waits on.
 */
class VirtualGitChild extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly pid: number | undefined = undefined;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;

	finish(outcome: GitOutcome): void {
		this.stdout.end(outcome.stdout);
		this.stderr.end(outcome.stderr);
		this.exitCode = outcome.code;
		this.emit("exit", outcome.code, null);
	}

	kill(): boolean {
		return false;
	}

	ref(): this {
		return this;
	}

	unref(): this {
		return this;
	}
}

/** JSON with object keys sorted, so two equal values compare equal whatever order their keys were written in. */
function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, item: unknown) =>
		item !== null && typeof item === "object" && !Array.isArray(item)
			? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
			: item,
	);
}

/**
 * The worker controller's resources, reduced to what must be zero or false once every worker is settled. An unloaded controller
 * (undefined) owns nothing, so it is null here and matches an expected null.
 */
function settledWorkers(workers: ReturnType<AgentSession["getResourceSnapshot"]>["workers"]): unknown {
	if (workers === undefined) return null;
	// Every loaded control mailbox, including mailboxes whose claims were released, is read: listeners, open obligations and pending messages.
	// Reply acknowledgements are a bounded cache, not work, so they are not required to be empty.
	const loadedMailboxes = workers.control.loadedMailboxes;
	const agents = workers.ownedProjectClaims.flatMap((claim) => claim.agents);
	// A loaded mailbox with no snapshot on its claim agent is unobserved, never quiescent: it is reported, not dropped.
	const loadedMailboxesUnobserved = agents
		.filter((agent) => agent.mailboxLoaded && agent.mailbox === undefined)
		.map((agent) => agent.agentId);
	const activeAttempts = agents
		.filter(
			(agent) =>
				agent.attemptStatus === "queued" || agent.attemptStatus === "leased" || agent.attemptStatus === "running",
		)
		.map((agent) => agent.agentId);
	// Owned claims are classified, never omitted: each is its agents' statuses, and a settled journey retains none.
	const ownedClaims = workers.ownedProjectClaims.map((claim) =>
		claim.agents.map(
			(agent) =>
				`${agent.agentId}:${agent.agentStatus}:${agent.attemptStatus ?? "none"}:holds${agent.executingHoldCount}`,
		),
	);
	return {
		ingressPromiseCount: workers.ingressPromiseCount,
		executionPromiseCount: workers.executionPromiseCount,
		executingHolds: workers.executingHolds.length,
		inFlightLedgerCount: workers.inFlightLedgerCount,
		laneAbortControllerCount: workers.laneAbortControllerCount,
		shellSessionCount: workers.shellSessionCount,
		pendingTerminalHandoffCount: workers.pendingTerminalHandoffCount,
		scheduler: {
			admissionClosed: workers.scheduler.admissionClosed,
			queuedCount: workers.scheduler.queuedCount,
			deferredCount: workers.scheduler.deferredCount,
			preflightPromiseCount: workers.scheduler.preflightPromiseCount,
			preflightTokenCount: workers.scheduler.preflightTokenCount,
			runningPromiseCount: workers.scheduler.runningPromiseCount,
			pendingCancellationCount: workers.scheduler.pendingCancellationCount,
			laneObserverCount: workers.scheduler.laneObserverCount,
			queueCapacityListenerCount: workers.scheduler.queueCapacityListenerCount,
			queueCapacityNotificationPending: workers.scheduler.queueCapacityNotificationPending,
		},
		reservations: {
			heldLeases: workers.reservations.heldLeases.length,
			watchCount: workers.reservations.watchCount,
			availabilityListenerCount: workers.reservations.availabilityListenerCount,
			availabilityDeliveryDepth: workers.reservations.availabilityDeliveryDepth,
		},
		control: {
			stateListenerCount: workers.control.stateListenerCount,
			reconcilingTaskBearingCount: workers.control.reconcilingTaskBearingCount,
			scheduledReconciliationCount: workers.control.scheduledReconciliationCount,
		},
		activeAttempts,
		mailboxListeners: loadedMailboxes.reduce((sum, mailbox) => sum + mailbox.listenerCount, 0),
		openObligations: loadedMailboxes.filter((mailbox) => mailbox.hasOpenObligation).map((mailbox) => mailbox.agentId),
		pendingMessages: loadedMailboxes
			.filter((mailbox) => mailbox.pendingMessageIds.length > 0)
			.map((mailbox) => `${mailbox.agentId}:${mailbox.pendingMessageIds.length}`),
		ownedClaims,
		loadedMailboxesUnobserved,
	};
}

/**
 * Settlement of one session's owned resources, read from the owners' fields after its disposal: nothing is active, pending, watched
 * or listening, and the background tool tasks are disposed. A value that is not settled fails with the whole snapshot.
 */
function assertResourcesSettled(snapshot: ReturnType<AgentSession["getResourceSnapshot"]>, label: string): void {
	const settled = {
		foregroundRecovery: {
			shutdown: snapshot.foregroundRecovery.shutdown,
			activeRuns: snapshot.foregroundRecovery.activeRuns,
			idleWaiters: snapshot.foregroundRecovery.idleWaiters,
			activityListeners: snapshot.foregroundRecovery.activityListeners,
			retrying: snapshot.foregroundRecovery.retrying,
			hasSubmissionLease: snapshot.foregroundRecovery.submissionEpoch !== undefined,
		},
		terminalHandoffs: {
			pendingDeliveries: snapshot.terminalHandoffs.pendingDeliveries,
			activeDeliveryIdentities: snapshot.terminalHandoffs.activeDeliveryIdentities,
		},
		backgroundToolTasks: {
			disposed: snapshot.backgroundToolTasks.disposed,
			physicalExecutions: snapshot.backgroundToolTasks.physicalExecutions,
			runningTaskIds: snapshot.backgroundToolTasks.runningTaskIds.length,
			handoffRequests: snapshot.backgroundToolTasks.handoffRequests,
			waitingConsumers: snapshot.backgroundToolTasks.waitingConsumers,
			taskWatchdogs: snapshot.backgroundToolTasks.taskWatchdogs,
			queuedNotifications: snapshot.backgroundToolTasks.queuedNotifications,
			activeNotificationRecords: snapshot.backgroundToolTasks.activeNotificationRecords,
			notificationDrainActive: snapshot.backgroundToolTasks.notificationDrainActive,
			notificationRetryActive: snapshot.backgroundToolTasks.notificationRetryActive,
		},
		eventListeners: snapshot.eventListeners,
		workers: settledWorkers(snapshot.workers),
	};
	const expectedWorkers = {
		ingressPromiseCount: 0,
		executionPromiseCount: 0,
		executingHolds: 0,
		inFlightLedgerCount: 0,
		laneAbortControllerCount: 0,
		pendingTerminalHandoffCount: 0,
		scheduler: {
			admissionClosed: true,
			queuedCount: 0,
			deferredCount: 0,
			preflightPromiseCount: 0,
			preflightTokenCount: 0,
			runningPromiseCount: 0,
			pendingCancellationCount: 0,
			laneObserverCount: 0,
			queueCapacityListenerCount: 0,
			queueCapacityNotificationPending: false,
		},
		reservations: { heldLeases: 0, watchCount: 0, availabilityListenerCount: 0, availabilityDeliveryDepth: 0 },
		control: { stateListenerCount: 0, reconcilingTaskBearingCount: 0, scheduledReconciliationCount: 0 },
		shellSessionCount: 0,
		activeAttempts: [],
		mailboxListeners: 0,
		openObligations: [],
		pendingMessages: [],
		ownedClaims: [],
		loadedMailboxesUnobserved: [],
	};
	const expected = {
		foregroundRecovery: {
			shutdown: true,
			activeRuns: 0,
			idleWaiters: 0,
			activityListeners: 0,
			retrying: false,
			hasSubmissionLease: false,
		},
		terminalHandoffs: { pendingDeliveries: 0, activeDeliveryIdentities: 0 },
		backgroundToolTasks: {
			disposed: true,
			physicalExecutions: 0,
			runningTaskIds: 0,
			handoffRequests: 0,
			waitingConsumers: 0,
			taskWatchdogs: 0,
			queuedNotifications: 0,
			activeNotificationRecords: 0,
			notificationDrainActive: false,
			notificationRetryActive: false,
		},
		eventListeners: 0,
		workers: snapshot.workers === undefined ? null : expectedWorkers,
	};
	if (canonicalJson(settled) !== canonicalJson(expected)) {
		throw new Error(`${label} resources are not settled after disposal: ${JSON.stringify(snapshot)}`);
	}
}

export class HarnessProcesses {
	readonly unscripted: string[] = [];
	private readonly settling = new Set<Promise<void>>();
	/** Child causes retained after their spawn leaves `settling`, so every later drain still reports them. */
	private readonly causes: unknown[] = [];
	private readonly git: VirtualGit;

	constructor(git: VirtualGit) {
		this.git = git;
	}

	/** Joins every spawned child: its stdio has closed and its close has fired. Failures are aggregated, never dropped. */
	async drain(): Promise<void> {
		await Promise.allSettled([...this.settling]);
		if (this.causes.length > 0)
			throw new AggregateError([...this.causes], "Virtual process children failed to settle");
	}

	run(operation: string, args: readonly unknown[]): unknown {
		const [file, argv, options] = args;
		if (operation === "spawn" && file === "git" && Array.isArray(argv)) {
			// The state is read at spawn time, as git reads its repository when it starts.
			const spawnOptions = (options ?? {}) as { cwd?: string; env?: Record<string, string | undefined> };
			const outcome = this.git.run(argv as string[], spawnOptions.cwd ?? "", spawnOptions.env ?? {});
			const child = new VirtualGitChild();
			// The stdio is consumed so both streams close; the child's close fires once both have closed, and the spawn is tracked until then.
			child.stdout.on("data", () => undefined);
			child.stderr.on("data", () => undefined);
			const streamsClosed = Promise.all([
				new Promise<void>((resolve) => child.stdout.once("close", () => resolve())),
				new Promise<void>((resolve) => child.stderr.once("close", () => resolve())),
			]).then(() => {
				child.emit("close", outcome.code, null);
			});
			const finished = new Promise<void>((resolve, reject) => {
				setImmediate(() => {
					try {
						child.finish(outcome);
						resolve();
					} catch (error) {
						// A failing finish still closes both streams, so the stdio joins and the child close are not skipped.
						child.stdout.destroy();
						child.stderr.destroy();
						reject(error);
					}
				});
			});
			// Both joins run independently: neither a rejected finish nor a throwing close listener skips the other.
			const settled = Promise.allSettled([finished, streamsClosed]).then((results) => {
				for (const result of results) if (result.status === "rejected") this.causes.push(result.reason);
			});
			this.settling.add(settled);
			void settled.then(() => this.settling.delete(settled));
			return child;
		}
		if (file === "git" && Array.isArray(argv)) {
			const cwd = (options as { cwd?: string } | undefined)?.cwd ?? "";
			const env = (options as { env?: Record<string, string | undefined> } | undefined)?.env ?? {};
			const stdin: unknown = (options as { input?: unknown } | undefined)?.input;
			const input = Buffer.isBuffer(stdin) ? stdin.toString("utf8") : typeof stdin === "string" ? stdin : undefined;
			const outcome = this.git.run(argv as string[], cwd, env, input);
			if (operation === "spawnSync") {
				return {
					status: outcome.code,
					signal: null,
					stdout: outcome.stdout,
					stderr: outcome.stderr,
					output: [null, outcome.stdout, outcome.stderr],
					pid: 0,
				};
			}
			if (outcome.code !== 0) {
				throw Object.assign(new Error(`Command failed: git ${argv.join(" ")}\n${outcome.stderr}`), {
					status: outcome.code,
					signal: null,
					stdout: outcome.stdout,
					stderr: outcome.stderr,
				});
			}
			const encoding = (options as { encoding?: string } | undefined)?.encoding;
			return encoding ? outcome.stdout : Buffer.from(outcome.stdout);
		}
		this.unscripted.push(`${operation} ${String(file)} ${JSON.stringify(argv)}`);
		throw new Error(`Unscripted process ${operation}: ${String(file)}`);
	}
}

export interface HarnessWorldOptions {
	readonly name: string;
	/** Exact warning allowances of this journey: every other captured warning fails the close, after cleanup. */
	readonly warningAllowances?: readonly RegExp[];
	readonly files?: Readonly<Record<string, string>>;
	readonly settings?: Partial<Settings>;
	/** A git repository at the project root (project-relative paths): `committed` is the initial commit; `dirty` are owner edits left unstaged. */
	readonly repository?: {
		readonly committed: Readonly<Record<string, string>>;
		readonly dirty?: Readonly<Record<string, string>>;
	};
}

/** Runs one scenario body in a fresh world and always settles it afterwards, in the order `close` defines. */
export async function runHarnessWorld(
	options: HarnessWorldOptions,
	body: (world: HarnessWorld) => Promise<void>,
): Promise<void> {
	const world = new HarnessWorld(options);
	let bodyFailure: { readonly error: unknown } | undefined;
	try {
		await body(world);
	} catch (error) {
		bodyFailure = { error };
	}
	await world.close(bodyFailure);
}

/**
 * One composed world: virtual IO, effect guard, scripted provider and System One transport, and the
 * production SDK session built on top of them. Disposal settles every resource it opened.
 */
export class HarnessWorld {
	readonly trace = new HarnessTrace();
	readonly io = new VirtualFileSystem(HARNESS_PROJECT_CWD);
	readonly systemOne = new ScriptedSystemOneTransport();
	readonly git: VirtualGit;
	readonly processTable = new VirtualProcessTable();
	readonly processes: HarnessProcesses;
	readonly guard: EffectGuard;
	readonly provider: ScriptedProvider;
	/** The scripted shell transport: bash runs through it for root and every worker lane. */
	readonly shell = new VirtualShell();
	readonly authStorage: AuthStorage;
	readonly modelRegistry: ModelRegistry;
	readonly settingsManager: SettingsManager;
	readonly sessions: AgentSession[] = [];
	/** Every warning any session of this world emitted, in order: journeys classify them before they close. */
	readonly warnings: string[] = [];
	private readonly warningAllowances: readonly RegExp[];
	private readonly everySession: AgentSession[] = [];
	private readonly everySessionManager: SessionManager[] = [];
	/** The external approval port's own callbacks (setEdgeConfirmation): asked, in flight and settled. Native human input is separate. */
	readonly externalConfirmations = { asked: 0, inFlight: 0, settled: 0 };
	private readonly warningSubscriptions: Array<() => void> = [];
	/** Per-world agent directory: stores cached by path (SQLite, host stores) never leak between journeys. */
	readonly agentDir: string;
	private disposed = false;

	constructor(options: HarnessWorldOptions) {
		this.agentDir = `/harness/agent-${options.name}`;
		this.warningAllowances = options.warningAllowances ?? [];
		this.git = new VirtualGit(this.io, HARNESS_PROJECT_CWD);
		this.processes = new HarnessProcesses(this.git);
		this.guard = new EffectGuard(this.io, {
			sqlite: "memory",
			process: (operation, args) => this.processes.run(operation, args),
			signal: (pid, signal) => this.processTable.signal(pid, signal),
			fetch: this.systemOne.fetch,
		});
		this.guard.install();
		let provider: ScriptedProvider | undefined;
		// A failure while building the world must not leave the process-wide guard or the provider registration installed.
		try {
			// Process table of the fixture: an explicit empty /proc. Worker run environments list it to reap marked
			// processes during disposal; the fixture starts no processes, so the listing is genuinely empty.
			this.io.mkdirSync("/proc", { recursive: true });
			for (const [path, text] of Object.entries(options.files ?? {})) this.io.seed(path, text);
			if (options.repository) {
				this.git.initialize("main", options.repository.committed);
				for (const [path, text] of Object.entries(options.repository.dirty ?? {})) {
					this.io.seed(join(HARNESS_PROJECT_CWD, path), text);
				}
			}
			provider = new ScriptedProvider(`harness-${options.name}`);
			this.provider = provider;
			provider.register();
			this.authStorage = AuthStorage.inMemory({
				typesafe: { type: "api_key", key: TYPESAFE_FIXTURE_KEY },
				[HARNESS_PROVIDER]: { type: "api_key", key: HARNESS_PROVIDER_FIXTURE_KEY },
			});
			this.modelRegistry = ModelRegistry.inMemory(this.authStorage);
			// Every scripted track is a registered, authenticated model, so workers select among them through the
			// production account catalog exactly as they would select real models.
			this.modelRegistry.registerProvider(HARNESS_PROVIDER, {
				api: HARNESS_API,
				baseUrl: "https://harness.invalid",
				apiKey: HARNESS_PROVIDER_FIXTURE_KEY,
				models: SCRIPTED_TRACKS.map((id) => ({
					id,
					name: `Scripted ${id}`,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 32768,
					maxTokens: 4096,
				})),
			});
			// The owner's model favorites: the router pool that delegation admits workers from is built from them.
			this.settingsManager = SettingsManager.inMemory({
				modelFavorites: SCRIPTED_TRACKS.map((modelId) => ({ provider: HARNESS_PROVIDER, modelId })),
				...options.settings,
			});
		} catch (error) {
			const failures: unknown[] = [error];
			// Registration rolls back first: the guard restore must not run while a scripted track stays registered.
			try {
				provider?.rollbackRegistration();
			} catch (cleanupError) {
				failures.push(cleanupError);
			}
			try {
				this.guard.dispose();
			} catch (cleanupError) {
				failures.push(cleanupError);
			}
			if (failures.length === 1) throw error;
			throw new AggregateError(failures, "Harness world construction failed and rollback reported evidence");
		}
	}

	/** Root session in normal user-facing mode, bound to the scripted root track `modelId`. */
	async createRootSession(
		modelId = "root",
		options: { readonly sessionManager?: SessionManager; readonly agentDir?: string } = {},
	): Promise<{ session: AgentSession; sessionManager: SessionManager }> {
		const sessionManager = options.sessionManager ?? SessionManager.inMemory(HARNESS_PROJECT_CWD);
		const { session } = await createAgentSession({
			cwd: HARNESS_PROJECT_CWD,
			agentDir: options.agentDir ?? this.agentDir,
			authStorage: this.authStorage,
			modelRegistry: this.modelRegistry,
			settingsManager: this.settingsManager,
			sessionManager,
			model: this.provider.model(modelId),
			// Worker tracks are admitted through the router pool: with routing on, delegation accepts only pool members.
			routerPool: {
				source: "sdk_models",
				models: SCRIPTED_TRACKS.map((id) => ({ model: this.provider.model(id) })),
			},
			systemOneFetch: this.systemOne.fetch,
			shellOperations: this.shell,
			// Worktree-sync git runs against the same stateful repository the SDK's own git reads see.
			worktreeSyncEnginePorts: {
				exec: (command, args, options) => this.git.exec(command, args, options),
				isPidAlive: (pid) => this.processTable.isAlive(pid),
				pid: this.processTable.self,
			},
		});
		// Caller observation of production operations only: each native method runs unchanged, and its promise (preflight and tail
		// included) is what close joins. Test synchronization gates are never tracked.
		const trace = this.trace;
		// Internal turns (reflection) are returned untouched: their lifecycle owns cancellation and catches it. Only owner work is tracked.
		const prompt = session.prompt.bind(session);
		session.prompt = (...args: Parameters<AgentSession["prompt"]>) => {
			const work = prompt(...args);
			return args[1]?.internalContextType === undefined ? trace.track(work) : work;
		};
		const compact = session.compact.bind(session);
		session.compact = (...args: Parameters<AgentSession["compact"]>) => trace.track(compact(...args));
		const executeBash = session.executeBash.bind(session);
		session.executeBash = (...args: Parameters<AgentSession["executeBash"]>) => trace.track(executeBash(...args));
		const continueGoalLoop = session.continueGoalLoop.bind(session);
		session.continueGoalLoop = (...args: Parameters<AgentSession["continueGoalLoop"]>) =>
			trace.track(continueGoalLoop(...args));
		this.warningSubscriptions.push(
			session.subscribe((event) => {
				if (event.type === "warning") this.warnings.push(event.message);
			}),
		);
		this.everySession.push(session);
		this.everySessionManager.push(sessionManager);
		this.sessions.push(session);
		return { session, sessionManager };
	}

	/** A file-backed session manager; its session file is written to the virtual tree on the first reply. */
	createSessionManager(): SessionManager {
		return SessionManager.create(HARNESS_PROJECT_CWD, this.agentDir);
	}

	/** Reopens a session file written earlier in this world, as its owner would after a restart. */
	openSessionManager(file: string): SessionManager {
		return SessionManager.open(file, this.agentDir);
	}

	/** Reads a descriptor the scenario opened earlier: a positional read sees the node the descriptor was opened on. */
	readDescriptorText(descriptor: number, length: number): string {
		const filesystem = this.io.nodeFsExports() as {
			readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
		};
		const buffer = Buffer.alloc(length);
		return buffer.subarray(0, filesystem.readSync(descriptor, buffer, 0, length, 0)).toString("utf8");
	}

	/** Closes a descriptor the scenario opened. */
	closeDescriptor(descriptor: number): void {
		const filesystem = this.io.nodeFsExports() as { closeSync(fd: number): void };
		filesystem.closeSync(descriptor);
	}

	/**
	 * Disposes one session inside the scenario body and takes its settlement out of the close list, so the body
	 * asserts exactly what this disposal rejected with. Resolves to the rejection, or undefined when it completed.
	 */
	async disposeSessionInBody(session: AgentSession): Promise<{ readonly error: unknown } | undefined> {
		if (!this.sessions.includes(session)) throw new Error("Session is not owned by this world");
		// Each disposal step is its own attempt: a failed abort or wait never skips the disposal. Ownership leaves the world only
		// after every step has been attempted, so a failure can never drop a session that is still running.
		const failures: unknown[] = [];
		const attempt = async (step: () => unknown): Promise<void> => {
			try {
				await step();
			} catch (error) {
				failures.push(error);
			}
		};
		try {
			await attempt(() => session.abort("session disposed in the scenario body"));
			await attempt(() => session.waitForForegroundIdle());
			await attempt(() => session.disposeAndWait());
		} finally {
			const index = this.sessions.indexOf(session);
			if (index >= 0) this.sessions.splice(index, 1);
		}
		if (failures.length === 0) return undefined;
		return {
			error:
				failures.length === 1 ? failures[0] : new AggregateError(failures, "Session disposal in the body failed"),
		};
	}

	/**
	 * Ordered settlement, run after the scenario body: every session is disposed and awaited, the scripted
	 * provider is closed, resources and escapes are asserted, and only then is the effect guard restored, so
	 * asynchronous production cleanup never runs outside the mock boundary. Cleanup failures are never
	 * swallowed: a body failure is rethrown with cleanup evidence attached when both failed.
	 */
	async close(body: { readonly error: unknown } | undefined): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		// Every failure is kept, and every cleanup step is attempted: a failed step never skips the step after it.
		const failures: unknown[] = body === undefined ? [] : [body.error];
		const attempt = (step: () => unknown): void => {
			try {
				step();
			} catch (error) {
				failures.push(error);
			}
		};
		const attemptAsync = async (step: () => Promise<unknown>): Promise<void> => {
			try {
				await step();
			} catch (error) {
				failures.push(error);
			}
		};
		try {
			// Cutoff: every session's root, compaction, summary and bash work is aborted without awaiting the abort; the provider then cancels
			// its uncooperative producers; only then are the cutoffs awaited and the tracked owner work joined.
			const cutoffs: Array<Promise<void>> = [];
			for (const session of this.sessions) {
				attempt(() => cutoffs.push(session.abort("harness world closed")));
				attempt(() => session.abortCompaction());
				attempt(() => session.abortBranchSummary());
				attempt(() => session.abortBash());
			}
			attempt(() => this.provider.cancelPending());
			for (const cutoff of cutoffs) await attemptAsync(() => cutoff);
			await attemptAsync(async () => {
				for (const error of await this.trace.join()) {
					if (error !== body?.error) failures.push(error);
				}
			});
			// Each session's foreground settlement and disposal are separate attempts: a failed wait never skips the disposal.
			for (const session of this.sessions) {
				await attemptAsync(() => session.waitForForegroundIdle());
				await attemptAsync(() => session.disposeAndWait());
			}
			for (const unsubscribe of this.warningSubscriptions) attempt(unsubscribe);
			await attemptAsync(() => this.provider.dispose());
			await attemptAsync(() => this.shell.dispose());
			await attemptAsync(() => this.processes.drain());
			const checks: Array<() => void> = [
				() => this.provider.assertDrained(),
				() => this.shell.assertDrained(),
				() => this.io.assertNoOpenResources(),
				// Application connections must be released by their owners after the sessions above are disposed.
				() => this.guard.assertNoOpenSqliteHandles(),
				() => this.processTable.assertClean(),
				() => this.guard.assertSqliteFaultsConsumed(),
				() => this.guard.assertNoEscapes(),
				() => {
					if (this.processes.unscripted.length)
						throw new Error(`Unscripted processes: ${this.processes.unscripted.join("; ")}`);
				},
				() => {
					if (this.systemOne.unscripted.length)
						throw new Error(`Unscripted judgment requests: ${this.systemOne.unscripted.join("; ")}`);
				},
				() => this.systemOne.assertConsumed(),
				() => {
					if (this.git.unscripted.length)
						throw new Error(`Unscripted git commands: ${this.git.unscripted.join("; ")}`);
				},
				() => {
					const unclassified = this.warnings.filter(
						(message) => !this.warningAllowances.some((pattern) => pattern.test(message)),
					);
					if (unclassified.length > 0) throw new Error(`Unclassified warnings: ${JSON.stringify(unclassified)}`);
				},
			];
			this.everySession.forEach((session, index) => {
				attempt(() => assertResourcesSettled(session.getResourceSnapshot(), `session ${index}`));
			});
			this.everySessionManager.forEach((manager, index) => {
				attempt(() => {
					const pending = getResumableHumanInputSnapshot(manager);
					if (pending !== undefined) {
						throw new Error(`session ${index} still has a pending native human input: ${pending.status}`);
					}
				});
			});
			attempt(() => {
				const { asked, inFlight, settled } = this.externalConfirmations;
				if (inFlight !== 0 || settled !== asked) {
					throw new Error(
						`external approval callbacks not settled: asked ${asked}, settled ${settled}, in flight ${inFlight}`,
					);
				}
			});
			for (const check of checks) attempt(check);
		} finally {
			// Guard restore runs after every cleanup step and classification; its own failure joins the evidence.
			try {
				this.guard.dispose();
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1)
			throw new AggregateError(failures, "Harness journey failed and cleanup reported evidence");
	}
}
