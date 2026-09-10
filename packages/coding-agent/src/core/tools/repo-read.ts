import { stat as fsStat } from "node:fs/promises";
import nodePath from "node:path";
import type { AgentTool } from "@caupulican/pi-agent-core";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "@caupulican/pi-agent-core/truncate";
import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { spawnProcess, waitForChildProcessWithTermination } from "../../utils/child-process.ts";
import { isPathWithinScope } from "../autonomy/path-scope.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { withoutHarnessLaunchEnv } from "../harness-environment.ts";
import { type OutputReductionDetails, reduceToolOutput } from "./output-reduction.ts";
import { resolveToCwd } from "./path-utils.ts";
import { formatCollapsibleToolResult, renderTextComponent, str, toolTextResult } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

/**
 * Read-only git for lanes without process authority.
 *
 * A read-only worker used to be unable to answer "what changed" because every git question went
 * through bash and bash needs `process.exec`. This tool runs `git` directly with an argv allow-list:
 * no shell, only read subcommands, only options that shape output, pathspecs and object paths kept
 * inside the directory it runs in, external diff/textconv drivers and the fsmonitor hook disabled,
 * no pager, no prompts, no optional index locks. It needs `repo.read`, which survives `readOnly`.
 */
export const REPO_READ_ACTIONS = ["status", "log", "diff", "show", "blame", "ls-files", "rev-parse"] as const;
export type RepoReadAction = (typeof REPO_READ_ACTIONS)[number];

const DEFAULT_LINE_LIMIT = 400;
const MAX_LINE_LIMIT = 5_000;
const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const TIMEOUT_MS = 60_000;
const KILL_GRACE_MS = 2_000;
const MAX_TOKEN_CHARS = 256;
const MAX_PATHSPEC_CHARS = 1_024;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

const repoReadSchema = Type.Object({
	action: Type.Union(
		[
			Type.Literal("status"),
			Type.Literal("log"),
			Type.Literal("diff"),
			Type.Literal("show"),
			Type.Literal("blame"),
			Type.Literal("ls-files"),
			Type.Literal("rev-parse"),
		],
		{ description: "git subcommand; every action is read-only." },
	),
	options: Type.Optional(
		Type.Array(Type.String({ maxLength: MAX_TOKEN_CHARS }), {
			maxItems: 24,
			description:
				"Subcommand options, one flag per entry with its value joined or as the next entry (`--oneline`, `-n`, `5`, `--stat`, `-p`, `-L10,20`, `--since=2.weeks`). Only output-shaping options are accepted; anything that writes, runs a program or reads outside the repository is refused with the reason.",
		}),
	),
	revisions: Type.Optional(
		Type.Array(Type.String({ maxLength: MAX_TOKEN_CHARS }), {
			maxItems: 8,
			description:
				"Revisions or ranges (`HEAD~3..HEAD`, `main...feature`, `abc123`; `HEAD:src/a.ts` for show). Never start with `-`.",
		}),
	),
	paths: Type.Optional(
		Type.Array(Type.String({ maxLength: MAX_PATHSPEC_CHARS }), {
			maxItems: 32,
			description: "Pathspecs placed after `--`, relative to `path` and kept inside it (globs allowed).",
		}),
	),
	path: Type.Optional(
		Type.String({
			maxLength: 4_096,
			description:
				"Directory to run in: the repository or one of its subdirectories. Default: the current directory.",
		}),
	),
	limit: Type.Optional(
		Type.Number({ description: `Maximum output lines (default ${DEFAULT_LINE_LIMIT}, at most ${MAX_LINE_LIMIT}).` }),
	),
});

export type RepoReadToolInput = Static<typeof repoReadSchema>;

export interface RepoReadToolDetails {
	action: RepoReadAction;
	exitCode: number | null;
	durationMs: number;
	/** Set when the byte cap stopped the process before git finished. */
	capped?: boolean;
	truncation?: TruncationResult;
	outputReduction?: OutputReductionDetails;
}

export interface RepoReadToolOptions {
	/** Test seam: the spawner used for `git`. */
	spawn?: typeof spawnProcess;
	/** Base environment; defaults to the process environment. */
	environment?: () => NodeJS.ProcessEnv;
	timeoutMs?: number;
}

type OptionValue = "none" | "required" | "optional";

interface OptionRule {
	value: OptionValue;
	/** Actions the option is accepted for; every action when absent. */
	actions?: readonly RepoReadAction[];
}

const DIFF_ACTIONS: readonly RepoReadAction[] = ["log", "show", "diff"];
const HISTORY_ACTIONS: readonly RepoReadAction[] = ["log", "show"];

/**
 * Every accepted option shapes output or selects history. Not here, and therefore refused: anything
 * writing to disk (`--output`, `--output-indicator-*`), running programs (`--ext-diff`, `--textconv`,
 * `--show-signature`, `-c`, `--exec`), reading arbitrary files (`--no-index`, `-O`, `--ignore-revs-file`,
 * `--stdin`) and every global option (`-C`, `--git-dir`, `--work-tree` belong before the subcommand).
 */
const OPTION_RULES: Readonly<Record<string, OptionRule>> = {
	// Shape of a diff or a log entry.
	"--oneline": { value: "none", actions: HISTORY_ACTIONS },
	"--stat": { value: "optional", actions: DIFF_ACTIONS },
	"--numstat": { value: "none", actions: DIFF_ACTIONS },
	"--shortstat": { value: "none", actions: DIFF_ACTIONS },
	"--name-only": { value: "none", actions: DIFF_ACTIONS },
	"--name-status": { value: "none", actions: DIFF_ACTIONS },
	"--summary": { value: "none", actions: DIFF_ACTIONS },
	"-p": { value: "none", actions: DIFF_ACTIONS },
	"--patch": { value: "none", actions: DIFF_ACTIONS },
	"--no-patch": { value: "none", actions: HISTORY_ACTIONS },
	"-U": { value: "required", actions: DIFF_ACTIONS },
	"--unified": { value: "required", actions: DIFF_ACTIONS },
	"-w": { value: "none", actions: [...DIFF_ACTIONS, "blame"] },
	"--ignore-all-space": { value: "none", actions: DIFF_ACTIONS },
	"-b": { value: "none", actions: [...DIFF_ACTIONS, "status"] },
	"--ignore-space-change": { value: "none", actions: DIFF_ACTIONS },
	"--ignore-blank-lines": { value: "none", actions: DIFF_ACTIONS },
	"--word-diff": { value: "optional", actions: DIFF_ACTIONS },
	"--full-index": { value: "none", actions: DIFF_ACTIONS },
	"--abbrev": { value: "optional" },
	"--abbrev-commit": { value: "none", actions: HISTORY_ACTIONS },
	"--no-abbrev-commit": { value: "none", actions: HISTORY_ACTIONS },
	"-M": { value: "optional", actions: [...DIFF_ACTIONS, "blame"] },
	"--find-renames": { value: "optional", actions: DIFF_ACTIONS },
	"-C": { value: "optional", actions: [...DIFF_ACTIONS, "blame"] },
	"--find-copies": { value: "optional", actions: DIFF_ACTIONS },
	"--diff-filter": { value: "required", actions: DIFF_ACTIONS },
	"-R": { value: "none", actions: ["diff"] },
	"--relative": { value: "optional", actions: DIFF_ACTIONS },
	"--ignore-submodules": { value: "optional", actions: [...DIFF_ACTIONS, "status"] },
	"--cached": { value: "none", actions: ["diff", "ls-files"] },
	"--staged": { value: "none", actions: ["diff"] },
	"--merge-base": { value: "none", actions: ["diff"] },
	// History selection.
	"-n": { value: "required", actions: HISTORY_ACTIONS },
	"--max-count": { value: "required", actions: HISTORY_ACTIONS },
	"--skip": { value: "required", actions: ["log"] },
	"--since": { value: "required", actions: ["log"] },
	"--after": { value: "required", actions: ["log"] },
	"--until": { value: "required", actions: ["log"] },
	"--before": { value: "required", actions: ["log"] },
	"--author": { value: "required", actions: ["log"] },
	"--committer": { value: "required", actions: ["log"] },
	"--grep": { value: "required", actions: ["log"] },
	"-i": { value: "none", actions: ["log"] },
	"--regexp-ignore-case": { value: "none", actions: ["log"] },
	"--all-match": { value: "none", actions: ["log"] },
	"--invert-grep": { value: "none", actions: ["log"] },
	"--first-parent": { value: "none", actions: ["log", "blame"] },
	"--merges": { value: "none", actions: ["log"] },
	"--no-merges": { value: "none", actions: ["log"] },
	"--reverse": { value: "none", actions: ["log", "blame"] },
	"--follow": { value: "none", actions: ["log"] },
	"--all": { value: "none", actions: ["log", "rev-parse"] },
	"--branches": { value: "optional", actions: ["log", "rev-parse"] },
	"--tags": { value: "optional", actions: ["log", "rev-parse"] },
	"--remotes": { value: "optional", actions: ["log", "rev-parse"] },
	"--decorate": { value: "optional", actions: ["log"] },
	"--no-decorate": { value: "none", actions: ["log"] },
	"--graph": { value: "none", actions: ["log"] },
	"--format": { value: "required", actions: HISTORY_ACTIONS },
	"--pretty": { value: "optional", actions: HISTORY_ACTIONS },
	"--date": { value: "required", actions: ["log", "blame"] },
	"--no-notes": { value: "none", actions: HISTORY_ACTIONS },
	"-S": { value: "required", actions: ["log"] },
	"-G": { value: "required", actions: ["log"] },
	"--pickaxe-regex": { value: "none", actions: ["log"] },
	"--pickaxe-all": { value: "none", actions: ["log"] },
	"-L": { value: "required", actions: ["log", "blame"] },
	// status
	"-s": { value: "none", actions: ["status", "log", "show", "ls-files"] },
	"--short": { value: "optional", actions: ["status", "rev-parse"] },
	"--long": { value: "none", actions: ["status"] },
	"--porcelain": { value: "optional", actions: ["status", "blame"] },
	"--branch": { value: "none", actions: ["status"] },
	"-u": { value: "optional", actions: ["status", "ls-files"] },
	"--untracked-files": { value: "optional", actions: ["status"] },
	"--ignored": { value: "optional", actions: ["status", "ls-files"] },
	"--show-stash": { value: "none", actions: ["status"] },
	"--ahead-behind": { value: "none", actions: ["status"] },
	"--no-ahead-behind": { value: "none", actions: ["status"] },
	"--renames": { value: "none", actions: ["status"] },
	"--no-renames": { value: "none", actions: ["status"] },
	// blame
	"-e": { value: "none", actions: ["blame"] },
	"--show-email": { value: "none", actions: ["blame"] },
	"-t": { value: "none", actions: ["blame", "ls-files"] },
	"--root": { value: "none", actions: ["blame"] },
	"--show-number": { value: "none", actions: ["blame"] },
	"-l": { value: "none", actions: ["blame"] },
	"--show-name": { value: "none", actions: ["blame"] },
	"-f": { value: "none", actions: ["blame"] },
	"--line-porcelain": { value: "none", actions: ["blame"] },
	"--incremental": { value: "none", actions: ["blame"] },
	"--ignore-rev": { value: "required", actions: ["blame"] },
	// ls-files
	"--others": { value: "none", actions: ["ls-files"] },
	"-o": { value: "none", actions: ["ls-files"] },
	"-c": { value: "none", actions: ["ls-files"] },
	"--modified": { value: "none", actions: ["ls-files"] },
	"-m": { value: "none", actions: ["ls-files"] },
	"--deleted": { value: "none", actions: ["ls-files"] },
	"-d": { value: "none", actions: ["ls-files"] },
	"--exclude-standard": { value: "none", actions: ["ls-files"] },
	"--stage": { value: "none", actions: ["ls-files"] },
	"--full-name": { value: "none", actions: ["ls-files"] },
	"--directory": { value: "none", actions: ["ls-files"] },
	"--no-empty-directory": { value: "none", actions: ["ls-files"] },
	"--unmerged": { value: "none", actions: ["ls-files"] },
	"--eol": { value: "none", actions: ["ls-files"] },
	"--exclude": { value: "required", actions: ["ls-files"] },
	"-x": { value: "required", actions: ["ls-files"] },
	// rev-parse
	"--abbrev-ref": { value: "optional", actions: ["rev-parse"] },
	"--verify": { value: "none", actions: ["rev-parse"] },
	"--quiet": { value: "none", actions: ["rev-parse"] },
	"-q": { value: "none", actions: ["rev-parse"] },
	"--symbolic": { value: "none", actions: ["rev-parse"] },
	"--symbolic-full-name": { value: "none", actions: ["rev-parse"] },
	"--show-toplevel": { value: "none", actions: ["rev-parse"] },
	"--show-prefix": { value: "none", actions: ["rev-parse"] },
	"--show-cdup": { value: "none", actions: ["rev-parse"] },
	"--git-dir": { value: "none", actions: ["rev-parse"] },
	"--git-common-dir": { value: "none", actions: ["rev-parse"] },
	"--absolute-git-dir": { value: "none", actions: ["rev-parse"] },
	"--git-path": { value: "required", actions: ["rev-parse"] },
	"--is-inside-work-tree": { value: "none", actions: ["rev-parse"] },
	"--is-inside-git-dir": { value: "none", actions: ["rev-parse"] },
	"--is-bare-repository": { value: "none", actions: ["rev-parse"] },
	"--is-shallow-repository": { value: "none", actions: ["rev-parse"] },
	"--show-object-format": { value: "optional", actions: ["rev-parse"] },
	"--not": { value: "none", actions: ["rev-parse"] },
	"--default": { value: "required", actions: ["rev-parse"] },
};

/** Options every run carries, before the subcommand: no pager, no colour, no program hooks. */
const GLOBAL_ARGV = [
	"--no-pager",
	"-c",
	"color.ui=never",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"log.showSignature=false",
	"-c",
	"core.quotePath=false",
] as const;

/** Environment keys git honours for its own configuration that a read must not lose. */
const KEPT_GIT_ENV_KEYS = new Set([
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_SYSTEM",
	"GIT_CONFIG_NOSYSTEM",
	"GIT_CEILING_DIRECTORIES",
	"GIT_EXEC_PATH",
	"GIT_TEMPLATE_DIR",
]);

export class RepoReadRefusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RepoReadRefusal";
	}
}

function refuse(message: string): never {
	throw new RepoReadRefusal(`repo_read refused: ${message}`);
}

function assertToken(kind: string, token: string, maxChars: number): void {
	if (token.length === 0) refuse(`an empty ${kind} entry`);
	if (token.length > maxChars) refuse(`${kind} '${token.slice(0, 40)}…' is longer than ${maxChars} characters`);
	if (CONTROL_CHARS_RE.test(token)) refuse(`${kind} '${token.slice(0, 40)}' contains control characters`);
}

/** Validate the options against the allow-list and return the argv they become. */
export function compileRepoReadOptions(action: RepoReadAction, options: readonly string[] | undefined): string[] {
	const argv: string[] = [];
	const entries = options ?? [];
	for (let index = 0; index < entries.length; index++) {
		const token = entries[index] as string;
		assertToken("option", token, MAX_TOKEN_CHARS);
		if (token === "--") refuse("'--' is placed by the tool; put pathspecs in paths");
		if (!token.startsWith("-")) {
			refuse(`'${token}' is not an option; put revisions in revisions and pathspecs in paths`);
		}
		let name: string;
		let joined: string | undefined;
		if (token.startsWith("--")) {
			const equals = token.indexOf("=");
			name = equals === -1 ? token : token.slice(0, equals);
			joined = equals === -1 ? undefined : token.slice(equals + 1);
		} else {
			name = token.slice(0, 2);
			joined = token.length > 2 ? token.slice(2) : undefined;
		}
		const rule = OPTION_RULES[name];
		if (!rule) refuse(`option '${name}' is not on the read-only allow-list for git ${action}`);
		if (rule.actions && !rule.actions.includes(action)) {
			refuse(`option '${name}' is not accepted for git ${action}`);
		}
		if (rule.value === "none") {
			if (joined !== undefined) refuse(`option '${name}' takes no value`);
			argv.push(name);
			continue;
		}
		let value = joined;
		if (value === undefined && rule.value === "required") {
			const next = entries[index + 1];
			if (next === undefined || next.startsWith("-")) refuse(`option '${name}' needs a value`);
			assertToken("option value", next, MAX_TOKEN_CHARS);
			value = next;
			index++;
		}
		if (value === undefined) {
			argv.push(name);
		} else if (name.startsWith("--")) {
			argv.push(`${name}=${value}`);
		} else {
			argv.push(`${name}${value}`);
		}
	}
	return argv;
}

/** Revisions never start with `-` (they would be options) or `:` (index paths the scope cannot check). */
export function validateRepoReadRevisions(revisions: readonly string[] | undefined): string[] {
	const out: string[] = [];
	for (const revision of revisions ?? []) {
		assertToken("revision", revision, MAX_TOKEN_CHARS);
		if (revision.startsWith("-")) refuse(`revision '${revision}' starts with '-'; options go in options`);
		if (revision.startsWith(":")) refuse(`revision '${revision}' addresses the index; use diff --cached`);
		if (/\s/.test(revision)) refuse(`revision '${revision}' contains whitespace`);
		out.push(revision);
	}
	return out;
}

/** The object path of a `rev:path` revision, or undefined for a plain revision. */
export function repoReadObjectPath(revision: string): string | undefined {
	const colon = revision.indexOf(":");
	return colon === -1 ? undefined : revision.slice(colon + 1);
}

function resolvePathspec(runDir: string, spec: string, kind: string): string {
	assertToken(kind, spec, MAX_PATHSPEC_CHARS);
	if (spec.startsWith("-")) refuse(`${kind} '${spec}' starts with '-'`);
	if (spec.startsWith(":")) refuse(`${kind} '${spec}' uses pathspec magic; use a plain relative path or glob`);
	const resolved = nodePath.resolve(runDir, spec);
	if (!isPathWithinScope(resolved, runDir)) refuse(`${kind} '${spec}' leaves ${runDir}`);
	return spec;
}

function repoReadEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...withoutHarnessLaunchEnv(base) };
	// GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE and friends re-point a read at another repository (a
	// hook-inherited environment did exactly that once); external-diff and pager variables run
	// programs. A read uses the repository under its directory and nothing else.
	for (const key of Object.keys(env)) {
		if (key.toUpperCase().startsWith("GIT_") && !KEPT_GIT_ENV_KEYS.has(key.toUpperCase())) delete env[key];
	}
	env.GIT_TERMINAL_PROMPT = "0";
	env.GIT_PAGER = "cat";
	env.PAGER = "cat";
	// A read never refreshes the index or takes the optional locks `status` would otherwise write.
	env.GIT_OPTIONAL_LOCKS = "0";
	return env;
}

async function runGit(
	argv: readonly string[],
	runDir: string,
	options: RepoReadToolOptions | undefined,
	signal: AbortSignal | undefined,
	stdoutCap: number,
): Promise<{ stdout: string; stderr: string; code: number | null; reason: string; capped: boolean }> {
	const spawn = options?.spawn ?? spawnProcess;
	const child = spawn("git", [...argv], {
		cwd: runDir,
		env: repoReadEnvironment(options?.environment?.() ?? process.env),
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	const stdoutChunks: Buffer[] = [];
	const stderrChunks: Buffer[] = [];
	let stdoutBytes = 0;
	let stderrBytes = 0;
	let capped = false;
	child.stdout?.on("data", (chunk: Buffer) => {
		if (capped) return;
		const room = stdoutCap - stdoutBytes;
		if (chunk.length >= room) {
			stdoutChunks.push(chunk.subarray(0, room));
			stdoutBytes += room;
			capped = true;
			// The head is all the model will see; stop paying for the rest.
			child.kill();
			return;
		}
		stdoutChunks.push(chunk);
		stdoutBytes += chunk.length;
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		const room = MAX_STDERR_BYTES - stderrBytes;
		if (room <= 0) return;
		stderrChunks.push(chunk.subarray(0, room));
		stderrBytes += Math.min(room, chunk.length);
	});
	const terminal = await waitForChildProcessWithTermination(child, {
		signal,
		timeoutMs: options?.timeoutMs ?? TIMEOUT_MS,
		killGraceMs: KILL_GRACE_MS,
	});
	return {
		stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
		stderr: Buffer.concat(stderrChunks).toString("utf-8"),
		code: terminal.code,
		reason: terminal.reason,
		capped,
	};
}

function formatRepoReadCall(args: Partial<RepoReadToolInput> | undefined, theme: Theme): string {
	const parts = [
		str(args?.action) ?? "",
		...(args?.options ?? []),
		...(args?.revisions ?? []),
		...((args?.paths?.length ?? 0) > 0 ? ["--", ...(args?.paths ?? [])] : []),
	].filter((part) => part.length > 0);
	let text = `${theme.fg("toolTitle", theme.bold("repo_read"))} ${theme.fg("toolOutput", parts.join(" "))}`;
	if (args?.path) text += theme.fg("muted", ` in ${args.path}`);
	return text;
}

function repoReadWarnings(details: RepoReadToolDetails | undefined): string[] {
	const warnings: string[] = [];
	if (!details) return warnings;
	if (details.capped) warnings.push(`output capped at ${formatSize(MAX_OUTPUT_BYTES)}`);
	if (details.truncation?.truncated) {
		warnings.push(
			details.truncation.truncatedBy === "lines"
				? `showing ${details.truncation.outputLines} of ${details.truncation.totalLines} lines`
				: `${formatSize(details.truncation.outputBytes)} of ${formatSize(details.truncation.totalBytes)}`,
		);
	}
	if (details.outputReduction && details.outputReduction.omittedLines > 0) {
		warnings.push(`${details.outputReduction.omittedLines} lines reduced`);
	}
	return warnings;
}

export function createRepoReadToolDefinition(
	cwd: string,
	options?: RepoReadToolOptions,
): ToolDefinition<typeof repoReadSchema, RepoReadToolDetails | undefined> {
	return {
		name: "repo_read",
		label: "repo_read",
		description:
			"Read-only git: status, log, diff, show, blame, ls-files, rev-parse. Runs git directly (no shell) with an option allow-list; never writes, never runs hooks, pagers or diff drivers. Use it for history and change questions instead of bash. Batchable with other independent reads.",
		promptSnippet: "Read git status, history, diffs and blame (read-only)",
		parameters: repoReadSchema,
		async execute(_toolCallId, input: RepoReadToolInput, signal?: AbortSignal) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const action = input.action;
			if (!REPO_READ_ACTIONS.includes(action)) refuse(`'${String(action)}' is not a read-only git action`);
			const runDir = resolveToCwd(input.path || ".", cwd);
			let directory: boolean;
			try {
				directory = (await fsStat(runDir)).isDirectory();
			} catch {
				throw new Error(`Path not found: ${runDir}`);
			}
			if (!directory) throw new Error(`Not a directory: ${runDir}`);
			const optionArgv = compileRepoReadOptions(action, input.options);
			const revisions = validateRepoReadRevisions(input.revisions);
			const paths = (input.paths ?? []).map((spec) => resolvePathspec(runDir, spec, "pathspec"));
			// `rev:path` object paths are repository-root-relative unless they start with `./`;
			// both forms must stay inside the run directory, which is what the scope granted.
			const objectPaths = revisions.map(repoReadObjectPath).filter((spec): spec is string => spec !== undefined);
			if (objectPaths.length > 0) {
				const top = await runGit([...GLOBAL_ARGV, "rev-parse", "--show-toplevel"], runDir, options, signal, 4_096);
				if (top.code !== 0) throw new Error(`git: ${top.stderr.trim() || `not a repository: ${runDir}`}`);
				const toplevel = top.stdout.trim();
				for (const spec of objectPaths) {
					if (spec.startsWith(":")) refuse(`object path '${spec}' uses pathspec magic`);
					const base = spec.startsWith("./") || spec.startsWith("../") ? runDir : toplevel;
					if (!isPathWithinScope(nodePath.resolve(base, spec), runDir)) {
						refuse(`object path '${spec}' leaves ${runDir}`);
					}
				}
			}
			const safety = DIFF_ACTIONS.includes(action) ? ["--no-ext-diff", "--no-textconv"] : [];
			const argv = [
				...GLOBAL_ARGV,
				action,
				...safety,
				...optionArgv,
				...revisions,
				...(paths.length > 0 ? ["--", ...paths] : []),
			];
			const startedAt = Date.now();
			const run = await runGit(argv, runDir, options, signal, MAX_OUTPUT_BYTES);
			const durationMs = Date.now() - startedAt;
			if (run.reason === "aborted") throw new Error("Operation aborted");
			const details: RepoReadToolDetails = { action, exitCode: run.code, durationMs };
			if (run.reason === "timeout") {
				throw new Error(`git ${action} timed out after ${Math.round((options?.timeoutMs ?? TIMEOUT_MS) / 1000)}s`);
			}
			if (run.code !== 0 && !run.capped) {
				const stderr = run.stderr.trim() || run.stdout.trim() || `git ${action} exited with ${run.code}`;
				return {
					content: [{ type: "text" as const, text: stderr.slice(0, 4_096) }],
					details,
					isError: true,
				};
			}
			if (run.capped) details.capped = true;
			const command = `git ${action}${optionArgv.length > 0 ? ` ${optionArgv.join(" ")}` : ""}`;
			const reduction = reduceToolOutput({
				tool: "repo_read",
				command,
				text: run.stdout,
				exitCode: run.code ?? 0,
				level: "standard",
			});
			if (reduction) details.outputReduction = reduction.details;
			const limit = Math.min(MAX_LINE_LIMIT, Math.max(1, Math.floor(input.limit ?? DEFAULT_LINE_LIMIT)));
			const truncation = truncateHead(reduction?.text ?? run.stdout, { maxLines: limit });
			let text = truncation.content;
			if (truncation.truncated) details.truncation = truncation;
			const notices: string[] = [];
			if (truncation.truncated && truncation.truncatedBy === "lines") {
				notices.push(
					`${limit} line limit reached (${truncation.totalLines} lines). Narrow with paths, -n or a range, or raise limit`,
				);
			} else if (truncation.truncated) {
				notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
			}
			if (run.capped) notices.push(`git output capped at ${formatSize(MAX_OUTPUT_BYTES)}; narrow the query`);
			if (reduction && reduction.details.omittedLines > 0) {
				notices.push(`${reduction.details.omittedLines} lines reduced (${reduction.details.kind})`);
			}
			const stderr = run.stderr.trim();
			if (stderr) notices.push(`stderr: ${stderr.slice(0, 1_024)}`);
			if (text.length === 0) text = "(no output)";
			if (notices.length > 0) text += `\n\n[${notices.join(". ")}]`;
			return toolTextResult({ text, details });
		},
		renderCall(args, theme, context) {
			return renderTextComponent(context.lastComponent, formatRepoReadCall(args, theme));
		},
		renderResult(result, renderOptions: ToolRenderResultOptions, theme, context) {
			return renderTextComponent(
				context.lastComponent,
				formatCollapsibleToolResult({
					result: result as { content: Array<{ type: string; text?: string }>; details?: RepoReadToolDetails },
					options: renderOptions,
					theme,
					showImages: context.showImages,
					collapsedLineLimit: 3,
					warnings: repoReadWarnings,
				}),
			);
		},
	};
}

export function createRepoReadTool(cwd: string, options?: RepoReadToolOptions): AgentTool<typeof repoReadSchema> {
	return wrapToolDefinition(createRepoReadToolDefinition(cwd, options));
}
