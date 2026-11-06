import { createHash } from "node:crypto";
import { homedir } from "node:os";
import nodePath from "node:path";
import type { SessionEntry } from "../../kernel/node.ts";
import { MAX_TOOL_FAILURE_DIAGNOSTIC_CHARS } from "../../kernel/tool-failure-memory.ts";
import { argvExecutions, type ShellExecutions, shellExecutions } from "../model-router/read-only-shell-policy.ts";
import { matchToolkitScript, type ToolkitScript } from "../toolkit/script-registry.ts";
import { expandPath } from "../tools/path-utils.ts";
import type { ShellCommandDialect } from "../tools/shell-command-parser.ts";

/**
 * The edge: the operations that can need the operator, and whether they still do.
 *
 * Git runs. Publishing, installing, committing, and editing settings run. The operator is asked
 * only before extreme destruction: deleting the repository, a directory that contains it, or its
 * `.git` directory, deleting the home directory or a filesystem root, or formatting a disk. A
 * granted class never asks. An ungranted extreme operation asks once, or is blocked when no one
 * is at the keyboard.
 *
 * One class is conditional rather than literal. Several sessions share one worktree, so a command
 * that discards the whole tree can delete uncommitted work belonging to another session with no
 * reflog to recover it. Those commands are ordinary work when everything dirty is this session's
 * own; they reach the edge only while the tree also holds changes this session never wrote. The
 * session layer resolves that, because the classifier itself never touches the filesystem.
 *
 * Classification is deliberately narrow and literal: a real risk names itself; anything unknown
 * is ordinary work and runs.
 */
export const EDGE_CLASSES = [
	"git.publish",
	"package.publish",
	"package.install",
	"destructive.fs",
	"settings.authority",
	"toolkit.script",
	"operation.irreversible",
	"agent.delegate",
	"forge.write",
] as const;
export type EdgeClass = (typeof EDGE_CLASSES)[number];

export const EDGE_CLASS_DESCRIPTIONS: Readonly<Record<EdgeClass, string>> = {
	"git.publish": "git push, tag, and release run without asking",
	"package.publish": "publishing a package or image runs without asking",
	"package.install": "installing a package runs without asking",
	"destructive.fs":
		"deleting the repository, a directory that contains it, the home directory, a filesystem root, or a disk, or discarding a shared worktree that holds another session's uncommitted work",
	"settings.authority": "editing settings and credentials runs without asking",
	"toolkit.script": "running registered dangerous toolkit scripts",
	"operation.irreversible":
		"an operation System One finds irreversible, outward or unsettled (code piped into an interpreter, a destructive command on an unexpanded variable, sending data off the machine, a write outside the task) that the owner's request does not ask for",
	"agent.delegate": "a run carrying a third party's words hands work to another agent",
	"forge.write": "a run carrying a third party's words acts on GitHub beyond reading (gh pr, issue, api writes)",
};

/** Classes a tool call can still make the operator confirm. The other names stay for grants. */
export function edgeClassRequiresConfirmation(edgeClass: EdgeClass): boolean {
	return edgeClass === "destructive.fs" || edgeClass === "toolkit.script" || edgeClass === "operation.irreversible";
}

export function isEdgeClass(value: unknown): value is EdgeClass {
	return typeof value === "string" && (EDGE_CLASSES as readonly string[]).includes(value);
}

/**
 * A risk that only exists in some live states, resolved by the session layer before the operation
 * counts. `unowned_worktree_changes`: the worktree holds changes at paths this session never wrote,
 * so a discard would destroy work belonging to a concurrent session or to the operator.
 */
export type EdgeCondition = "unowned_worktree_changes";

export interface EdgeOperation {
	class: EdgeClass;
	/** The operation as the operator would read it (`git push origin main`). */
	operation: string;
	/** Why it is on the edge. */
	reason: string;
	/** Optional exact operation scope key (e.g. deterministic digest for narrow toolkit approvals). */
	scopeKey?: string;
	/** Present when this is only an edge operation while the condition holds. */
	condition?: EdgeCondition;
	/** No grant covers it: only the owner's own turn performs it (a third-party run writing the session store). */
	ungrantable?: true;
}

export interface ClassifyEdgeOptions {
	/**
	 * Include operations whose risk depends on live state. Only a caller that can resolve the
	 * condition passes this; every other caller sees the unconditional classification it always saw.
	 */
	includeConditional?: boolean;
}

export interface ClassifyEdgeInput {
	toolName: string;
	args: unknown;
	/** Directory the call runs in. */
	cwd: string;
	/** The task directory: deletions inside it are ordinary work. */
	scopeCwd: string;
	/** Harness state directory whose authority files are the settings edge. Default: the agent dir. */
	agentDir?: string;
	/** Paths a run carrying a third party's words may not write; read only by `classifyOutwardEdgeOperations`. */
	protectedWrites?: ProtectedWritePaths;
}

/** Harness files a third-party run writes only with a grant, and the session store it never writes. */
export interface ProtectedWritePaths {
	/** `getHarnessWriteProtectedPaths`: harness settings, state, extensions, and the files that run or configure git. */
	readonly harness: readonly string[];
	/** The session store: no grant opens it. */
	readonly sessions: readonly string[];
}

const GIT_GLOBAL_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
const POWERSHELL_REMOVE = new Set(["remove-item", "ri", "rm", "del", "erase", "rd", "rmdir"]);
/** A find expression with one of these deletes matches, not the search root. */
const FIND_NARROWING = new Set([
	"-name",
	"-iname",
	"-path",
	"-ipath",
	"-regex",
	"-iregex",
	"-wholename",
	"-iwholename",
]);

function lower(token: string | undefined): string {
	return (token ?? "").toLowerCase();
}

function commandTool(token: string | undefined): string {
	const raw = lower(token);
	const base = nodePath.basename(raw).replace(/\.exe$/i, "");
	return base || raw;
}

function isOption(token: string): boolean {
	return token.startsWith("-") && token !== "-";
}

function positional(argv: readonly string[]): string[] {
	return argv.filter((token) => !isOption(token));
}

/**
 * Every argument vector a shell line runs, read by the read-only walk's structure (`shellExecutions`): `sudo -u root
 * git push` lists the `sudo` invocation and the `git push` it runs, and `bash -c '...'`, subshells and command
 * substitutions are read as lines of their own.
 */
export function shellInvocations(command: string, dialect: ShellCommandDialect = "posix"): string[][] {
	return shellExecutions(command, dialect).invocations;
}

/** The dialect a shell tool's command is written in. */
function toolDialect(name: string): ShellCommandDialect {
	return name === "powershell" ? "powershell" : "posix";
}

const WINDOWS_ABSOLUTE_RE = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/** Resolve a target in the dialect it is written in, so a Windows path on a POSIX host is still absolute. */
function resolveTarget(target: string, cwd: string): { resolved: string; api: nodePath.PlatformPath } {
	const expanded = expandPath(target);
	if (WINDOWS_ABSOLUTE_RE.test(expanded)) return { resolved: nodePath.win32.resolve(expanded), api: nodePath.win32 };
	return { resolved: nodePath.resolve(cwd, expanded), api: nodePath };
}

/** True when `child` is `parent` or a path inside it. */
function pathContains(parent: string, child: string, api: nodePath.PlatformPath): boolean {
	const relative = api.relative(parent, child);
	return relative === "" || (!relative.startsWith(`..${api.sep}`) && relative !== ".." && !api.isAbsolute(relative));
}

/**
 * Extreme destruction: the repository, a directory that contains it, its `.git` directory,
 * the home directory, or a filesystem root.
 */
function destroysRepository(target: string, cwd: string, scopeCwd: string): boolean {
	const { resolved, api } = resolveTarget(target, cwd);
	const parsed = api.parse(resolved);
	if (parsed.root === resolved) return true;
	const home = nodePath.resolve(homedir());
	if (resolved === home || (api === nodePath && pathContains(resolved, home, api))) return true;
	const scope = api.resolve(scopeCwd);
	if (pathContains(resolved, scope, api)) return true;
	return api.basename(resolved) === ".git";
}

/** `find <root> -delete` removes the tree. A name or path predicate removes matches only. */
function findDeletesTree(rest: readonly string[]): boolean {
	const deletes =
		rest.includes("-delete") || rest.some((token, index) => token === "-exec" && lower(rest[index + 1]) === "rm");
	return deletes && !rest.some((token) => FIND_NARROWING.has(token));
}

function classifyDeletion(
	argv: readonly string[],
	joined: string,
	cwd: string,
	scopeCwd: string,
): EdgeOperation | undefined {
	const tool = commandTool(argv[0]);
	const rest = argv.slice(1);
	const targets = positional(rest);
	if (tool === "rm" || tool === "unlink" || tool === "shred") {
		const destroyed = targets.filter((target) => destroysRepository(target, cwd, scopeCwd));
		if (destroyed.length > 0) {
			return {
				class: "destructive.fs",
				operation: joined,
				reason: `deletes the repository (${destroyed.join(", ")})`,
			};
		}
		return undefined;
	}
	if (POWERSHELL_REMOVE.has(tool)) {
		const destroyed = targets.filter((target) => destroysRepository(target, cwd, scopeCwd));
		if (destroyed.length > 0) {
			return { class: "destructive.fs", operation: joined, reason: "deletes the repository" };
		}
		return undefined;
	}
	if (tool === "find") {
		if (!findDeletesTree(rest)) return undefined;
		const roots = targets.filter((target) => !target.startsWith("-"));
		const destroyed = roots.filter((root) => destroysRepository(root, cwd, scopeCwd));
		if (destroyed.length > 0) {
			return { class: "destructive.fs", operation: joined, reason: "deletes the repository" };
		}
		return undefined;
	}
	if (tool === "dd" && rest.some((token) => /^of=\/dev\//i.test(token))) {
		return { class: "destructive.fs", operation: joined, reason: "writes a raw device" };
	}
	if (tool.startsWith("mkfs") || tool === "diskpart" || tool === "format") {
		return { class: "destructive.fs", operation: joined, reason: "formats a volume" };
	}
	return undefined;
}

/** `git -C dir -c k=v <subcommand> …` → the subcommand and the arguments after it. */
function gitInvocation(argv: readonly string[]): { subcommand: string; rest: string[] } | undefined {
	let index = 1;
	while (index < argv.length) {
		const token = argv[index] as string;
		if (!isOption(token)) return { subcommand: token.toLowerCase(), rest: argv.slice(index + 1) };
		index += GIT_GLOBAL_VALUE_OPTIONS.has(token) ? 2 : 1;
	}
	return undefined;
}

/**
 * A git command that throws away working-tree state.
 *
 * Git is ordinary work and stays ungated. These commands are the exception, and only while the
 * condition holds: they discard the whole worktree, not a path the caller named, so when another
 * session's uncommitted work is sitting in the same checkout they delete it with no reflog and no
 * undo. Discarding only your own work never reaches the operator.
 */
function classifyWorktreeDiscard(argv: readonly string[], joined: string): EdgeOperation | undefined {
	const invocation = gitInvocation(argv);
	if (!invocation) return undefined;
	const { subcommand, rest } = invocation;
	const options = rest.filter(isOption).map((token) => token.toLowerCase());
	const targets = positional(rest);
	const discard = (reason: string): EdgeOperation => ({
		class: "destructive.fs",
		operation: joined,
		reason,
		condition: "unowned_worktree_changes",
	});
	switch (subcommand) {
		case "reset":
			return options.includes("--hard") || options.includes("--merge")
				? discard("discards every uncommitted change in the worktree")
				: undefined;
		case "clean":
			return options.some((option) => option === "--force" || /^-[a-z]*f/.test(option))
				? discard("deletes untracked files across the worktree")
				: undefined;
		case "checkout":
			return rest.includes("--") || (targets.length > 0 && targets.every((target) => target === "."))
				? discard("overwrites working-tree changes")
				: undefined;
		case "restore":
			return targets.length > 0 &&
				!options.some((option) => option === "--staged" || option === "-s" || option === "--worktree=false")
				? discard("overwrites working-tree changes")
				: undefined;
		case "stash": {
			const verb = targets[0]?.toLowerCase() ?? "push";
			if (verb === "drop" || verb === "clear") return discard("deletes stashed work");
			// push/save take the whole worktree away from whoever else is editing in it.
			return verb === "push" || verb === "save"
				? discard("removes every uncommitted change from the worktree")
				: undefined;
		}
		default:
			return undefined;
	}
}

function classifyInvokedArgv(argv: readonly string[], cwd: string, scopeCwd: string): EdgeOperation[] {
	if (argv.length === 0) return [];
	const joined = argv.join(" ");
	const tool = commandTool(argv[0]);
	const operations: EdgeOperation[] = [];
	if (tool === "gh") {
		const remote = classifyGh(argv, joined);
		if (remote) operations.push(remote);
	}
	if (tool === "git") {
		const discard = classifyWorktreeDiscard(argv, joined);
		if (discard) operations.push(discard);
	}
	const deletion = classifyDeletion(argv, joined, cwd, scopeCwd);
	if (deletion) operations.push(deletion);
	return operations;
}

/** Classify all edge operations in a tool call; empty array means ordinary work. */
export function classifyAllEdgeOperations(
	input: ClassifyEdgeInput,
	options: ClassifyEdgeOptions = {},
): EdgeOperation[] {
	const operations = classifyEveryEdgeOperation(input);
	return options.includeConditional ? operations : operations.filter((operation) => operation.condition === undefined);
}

function classifyEveryEdgeOperation(input: ClassifyEdgeInput): EdgeOperation[] {
	const args = input.args && typeof input.args === "object" ? (input.args as Record<string, unknown>) : {};
	const name = input.toolName.toLowerCase();
	if (name === "write" || name === "edit" || name === "edit-diff") return [];
	if (name === "run_process" || name === "run-process") {
		const executable = typeof args.executable === "string" ? args.executable.trim() : "";
		if (!executable) return [];
		const processArgs = Array.isArray(args.args)
			? args.args.filter((item): item is string => typeof item === "string")
			: [];
		return classifyInvokedArgv([executable, ...processArgs], input.cwd, input.scopeCwd);
	}
	if (name !== "bash" && name !== "powershell" && name !== "shell") return [];
	const command = typeof args.command === "string" ? args.command : "";
	if (!command.trim()) return [];
	const operations: EdgeOperation[] = [];
	for (const argv of shellInvocations(command, toolDialect(name))) {
		operations.push(...classifyInvokedArgv(argv, input.cwd, input.scopeCwd));
	}
	return operations;
}

export type YoloBoundaryDecision = { kind: "block" | "confirm"; reason: string };

// ---------------------------------------------------------------------------------------------
// Outward actions of a run that carries a third party's words

/** Publishers, the subcommands that publish, and their options that take a value (`npm --registry URL publish`). */
const PACKAGE_PUBLISHERS: Readonly<Record<string, { verbs: ReadonlySet<string>; values: ReadonlySet<string> }>> = {
	npm: {
		verbs: new Set(["publish"]),
		values: new Set([
			"--registry",
			"--otp",
			"--tag",
			"--access",
			"-w",
			"--workspace",
			"--prefix",
			"-C",
			"--userconfig",
		]),
	},
	pnpm: {
		verbs: new Set(["publish"]),
		values: new Set(["--filter", "-F", "-C", "--dir", "--registry", "--otp", "--tag", "--access"]),
	},
	yarn: { verbs: new Set(["publish"]), values: new Set(["--cwd", "--registry", "--otp", "--tag", "--access"]) },
	bun: { verbs: new Set(["publish"]), values: new Set(["--cwd", "--registry", "--otp", "--tag", "--access"]) },
	cargo: {
		verbs: new Set(["publish"]),
		values: new Set([
			"--manifest-path",
			"-p",
			"--package",
			"--config",
			"-Z",
			"-C",
			"--registry",
			"--token",
			"--index",
		]),
	},
	docker: {
		verbs: new Set(["push"]),
		values: new Set(["--context", "-c", "-H", "--host", "--config", "-l", "--log-level"]),
	},
	podman: {
		verbs: new Set(["push"]),
		values: new Set(["--connection", "-c", "--url", "--root", "--runroot", "--log-level"]),
	},
	gem: { verbs: new Set(["push"]), values: new Set(["--key", "--host", "--otp"]) },
	twine: {
		verbs: new Set(["upload"]),
		values: new Set(["-r", "--repository", "--repository-url", "-u", "-p", "--config-file"]),
	},
	poetry: {
		verbs: new Set(["publish"]),
		values: new Set(["-C", "--directory", "-P", "--project", "-r", "--repository"]),
	},
	vsce: { verbs: new Set(["publish"]), values: new Set(["-p", "--pat", "-i", "--packagePath"]) },
};
/** gh commands that only read; every other gh invocation acts on the forge (`forge.write`) or publishes a release. */
const GH_READ_ONLY: ReadonlyMap<string, ReadonlySet<string> | "every"> = new Map<string, ReadonlySet<string> | "every">(
	[
		["alias", new Set(["list"])],
		["auth", new Set(["status"])],
		["cache", new Set(["list"])],
		["completion", "every"],
		["config", new Set(["get", "list"])],
		["extension", new Set(["list", "search"])],
		["gist", new Set(["list", "view"])],
		["help", "every"],
		["issue", new Set(["list", "status", "view"])],
		["label", new Set(["list"])],
		["pr", new Set(["checks", "diff", "list", "status", "view"])],
		["release", new Set(["download", "list", "view"])],
		["repo", new Set(["list", "view"])],
		["run", new Set(["download", "list", "view", "watch"])],
		["search", "every"],
		["status", "every"],
		["variable", new Set(["get", "list"])],
		["version", "every"],
		["workflow", new Set(["list", "view"])],
	],
);
const GH_API_WRITE_OPTIONS = new Set(["-f", "-F", "--field", "--raw-field", "--input"]);
/** Tool actions that hand the run's work to another agent: its authority would leave with it. */
const DELEGATION_ACTIONS: Readonly<Record<string, ReadonlySet<string | undefined>>> = {
	delegate: new Set([undefined, "start", "send", "broadcast", "follow_up", "resume"]),
	pi_collaboration: new Set(["fire_task", "send_followup", "launch_workspace", "answer_question"]),
	goal: new Set(["dispatch_worker"]),
};
/**
 * The closed table of actions a run carrying a third party's words may take on the harness's own action tools: the
 * ones that only read. Every other action of these tools, and any action of a tool not listed here, is the owner's
 * (`ownerOnlyToolCallReason`), except the delegation launches above, which are prepared like outward actions.
 */
const THIRD_PARTY_READ_ONLY_ACTIONS: ReadonlyMap<string, ReadonlySet<string | undefined>> = new Map([
	[
		"delegate",
		new Set([
			"tasks",
			"list",
			"transcript",
			"wait",
			"wait_many",
			"inbox",
			"inbox_wait",
			"status",
			"review",
			"profile_inspect",
			"events",
		]),
	],
	[
		"pi_collaboration",
		new Set([
			"status",
			"setup_help",
			"workspace_plan",
			"job_status",
			"list_jobs",
			"list_variables",
			"list_templates",
			"show_template",
		]),
	],
	["goal", new Set(["get"])],
	["routine", new Set(["list", "get"])],
	["proactivity", new Set(["view"])],
	["repo_read", new Set(["status", "log", "diff", "show", "blame", "ls-files", "rev-parse"])],
	["decision_ledger_read", new Set(["sessions", "stages", "evaluations", "failures", "replay"])],
	["secret_store", new Set(["status", "list"])],
	["task_automation", new Set(["status", "spec", "validate"])],
	["worktree_sync", new Set(["status", "git_status", "git_diff"])],
	["pipeline", new Set(["list", "status"])],
	["task_directory", new Set(["status"])],
	["task_steps", new Set(["list"])],
	["task_events", new Set(["events"])],
	["bot_message", new Set(["list"])],
	["runtime_update", new Set(["status"])],
	["improvement_loop", new Set(["status"])],
	["skill", new Set(["search", "read"])],
	// Advisory judgments and reads; `resolve_uncertainty` records a disposition, so it stays the owner's.
	["systemone", new Set(["status", "evaluate", "review", "vision", "evidence", "uncertainties", "locate"])],
]);

/** The operands of an invocation: words that are not options or the values `values` options take. */
function operands(argv: readonly string[], values: ReadonlySet<string>): string[] {
	const words: string[] = [];
	for (let index = 1; index < argv.length; index++) {
		const word = argv[index]!;
		if (isOption(word)) {
			if (values.has(word)) index++;
			continue;
		}
		// `cargo +nightly publish` names a toolchain.
		if (!word.startsWith("+")) words.push(word);
	}
	return words.map(lower);
}

function classifyGhOutward(argv: readonly string[], joined: string): EdgeOperation | undefined {
	const [group = "", verb = ""] = operands(
		argv,
		new Set(["-R", "--repo", "-X", "--method", "-H", "--header", "-q", "--jq", "-t", "--template"]),
	);
	if (group === "api") {
		const method = argv.find((_, index) => argv[index - 1] === "-X" || argv[index - 1] === "--method");
		const writes =
			(method !== undefined && method.toUpperCase() !== "GET") ||
			argv.some(
				(word) =>
					/^--method=(?!get$)/iu.test(word) || GH_API_WRITE_OPTIONS.has(word) || /^--(?:raw-)?field=/u.test(word),
			);
		return writes ? { class: "forge.write", operation: joined, reason: "writes through the GitHub API" } : undefined;
	}
	const readOnly = GH_READ_ONLY.get(group);
	if (readOnly === "every" || readOnly?.has(verb)) return undefined;
	return group === "release"
		? { class: "git.publish", operation: joined, reason: "publishes or changes a release" }
		: { class: "forge.write", operation: joined, reason: "acts on GitHub beyond reading" };
}

function classifyOutwardArgv(argv: readonly string[]): EdgeOperation | undefined {
	const joined = argv.join(" ");
	const tool = commandTool(argv[0]);
	if (tool === "git") {
		const subcommand = gitInvocation(argv)?.subcommand;
		if (subcommand === "push" || subcommand === "send-email")
			return { class: "git.publish", operation: joined, reason: "sends commits to a remote" };
		return undefined;
	}
	if (tool === "gh") return classifyGhOutward(argv, joined);
	const publisher = PACKAGE_PUBLISHERS[tool];
	if (!publisher) return undefined;
	// `yarn workspace web publish`, `yarn npm publish`, `docker image push`: the verb within the first operands.
	const publishes =
		operands(argv, publisher.values)
			.slice(0, 3)
			.some((word) => publisher.verbs.has(word)) ||
		((tool === "docker" || tool === "podman") && argv.includes("--push"));
	return publishes
		? { class: "package.publish", operation: joined, reason: "publishes a package or image" }
		: undefined;
}

/** Files an invocation writes by its arguments: `tee` files, a `cp`/`mv`/`install`/`ln` destination, `sed -i` files, `dd of=`. */
function argvWriteTargets(argv: readonly string[]): string[] {
	const tool = commandTool(argv[0]);
	const rest = argv.slice(1);
	if (tool === "tee") return positional(rest);
	if (tool === "cp" || tool === "mv" || tool === "install" || tool === "ln") {
		const target = rest.findIndex((word) => word === "-t" || word === "--target-directory");
		if (target >= 0) return rest[target + 1] === undefined ? [] : [rest[target + 1]!];
		const attached = rest.find((word) => word.startsWith("--target-directory="));
		if (attached) return [attached.slice("--target-directory=".length)];
		const targets = positional(rest);
		return targets.length >= 2 ? [targets.at(-1)!] : [];
	}
	if (tool === "sed" && rest.some((word) => /^(?:-[a-zA-Z]*i|--in-place)/u.test(word))) {
		const files: string[] = [];
		let script = rest.some((word) => /^(?:-[a-zA-Z]*[ef]|--expression|--file)/u.test(word));
		for (let index = 0; index < rest.length; index++) {
			const word = rest[index]!;
			if (isOption(word)) {
				if (/^-[a-zA-Z]*[efl]$/u.test(word) || word === "--expression" || word === "--file") index++;
				continue;
			}
			if (!script) script = true;
			else files.push(word);
		}
		return files;
	}
	if (tool === "dd") return rest.filter((word) => word.startsWith("of=")).map((word) => word.slice(3));
	return [];
}

/** A write into a protected path: the session store is never granted; the other harness paths are settings authority. */
function protectedWriteOperation(
	target: string,
	input: ClassifyEdgeInput,
	operation: string,
): EdgeOperation | undefined {
	const paths = input.protectedWrites;
	if (!paths || !target) return undefined;
	const { resolved, api } = resolveTarget(target, input.cwd);
	const inside = (list: readonly string[]) => list.some((entry) => pathContains(api.resolve(entry), resolved, api));
	if (inside(paths.sessions))
		return {
			class: "settings.authority",
			operation,
			reason: `writes the session store (${target}), which only the owner's own turn changes`,
			ungrantable: true,
		};
	return inside(paths.harness)
		? {
				class: "settings.authority",
				operation,
				reason: `writes ${target}, a harness file or one that runs or configures the harness or git`,
			}
		: undefined;
}

/**
 * What a run carrying a third party's words may not do on its own: push, publish, act on GitHub beyond reading, hand
 * its work to another agent, write harness files or the session store, run code the gate cannot read (the python tool,
 * code given to an interpreter or `eval` as text, a shell or interpreter reading its input), and every operation the
 * edge already classifies. Literal, like the rest of the edge: a script file the run executes is not read, so what it
 * does is not classified. Only that run's gate reads this; the owner's own runs never do.
 */
export function classifyOutwardEdgeOperations(input: ClassifyEdgeInput): EdgeOperation[] {
	const operations = classifyEveryEdgeOperation(input);
	const args = input.args && typeof input.args === "object" ? (input.args as Record<string, unknown>) : {};
	const name = input.toolName.toLowerCase();
	const action = typeof args.action === "string" ? args.action : undefined;
	if (DELEGATION_ACTIONS[name]?.has(action)) {
		operations.push({
			class: "agent.delegate",
			operation: `${input.toolName} ${action ?? "start"}`,
			reason: "hands the run's work to another agent, past this gate",
		});
	}
	if (name === "python") {
		operations.push({
			class: "operation.irreversible",
			operation:
				`${input.toolName} ${typeof args.code === "string" ? args.code.slice(0, 200) : String(args.scriptPath ?? "")}`.trim(),
			reason: "runs Python code, which the gate does not read",
		});
	}
	const writes: { target: string; operation: string }[] = [];
	if (name === "write" || name === "edit" || name === "edit-diff") {
		const target =
			typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "";
		writes.push({ target, operation: `${input.toolName} ${target}` });
	}
	let executions: ShellExecutions | undefined;
	let line = "";
	if (name === "run_process" || name === "run-process") {
		const executable = typeof args.executable === "string" ? args.executable.trim() : "";
		const processArgs = Array.isArray(args.args)
			? args.args.filter((item): item is string => typeof item === "string")
			: [];
		line = [executable, ...processArgs].join(" ");
		if (executable) executions = argvExecutions([executable, ...processArgs]);
	}
	if ((name === "bash" || name === "powershell" || name === "shell") && typeof args.command === "string") {
		line = args.command;
		executions = shellExecutions(line, toolDialect(name));
	}
	for (const target of executions?.writes ?? []) writes.push({ target, operation: line });
	for (const reason of new Set(executions?.unjudged))
		operations.push({
			class: "operation.irreversible",
			operation: line,
			reason: `${reason}, which the gate cannot read`,
		});
	for (const argv of executions?.invocations ?? []) {
		const outward = classifyOutwardArgv(argv);
		if (outward) operations.push(outward);
		for (const target of argvWriteTargets(argv)) writes.push({ target, operation: argv.join(" ") });
	}
	for (const { target, operation } of writes) {
		const write = protectedWriteOperation(target, input, operation);
		if (write) operations.push(write);
	}
	return operations;
}

/**
 * Why a tool call is the owner's own decision, which a run carrying a third party's words never makes: any action of
 * `knowledge`, `memory` (the owner's private records) and `channel_reply` (the owner's channel replies); an action
 * outside `THIRD_PARTY_READ_ONLY_ACTIONS` (a tool not listed there may take no action at all), other than a delegation
 * launch, which is prepared instead; and a knowledge grant to another agent.
 */
export function ownerOnlyToolCallReason(toolName: string, args: unknown): string | undefined {
	const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	// A knowledge grant hands owner knowledge values to another agent, whatever grant covers the launch itself.
	if ((toolName === "delegate" || toolName === "pi_collaboration") && record.knowledge !== undefined)
		return `${toolName} knowledge hands the owner's recorded knowledge to another agent`;
	// The owner's private records stay out of a run that serves a third party's words, read or written: every action.
	if (toolName === "knowledge" || toolName === "memory")
		return `${toolName} reads and changes the owner's private records`;
	if (toolName === "channel_reply") return "channel_reply releases or discards the owner's channel replies";
	const action = typeof record.action === "string" ? record.action : undefined;
	if (DELEGATION_ACTIONS[toolName]?.has(action)) return undefined;
	const readOnly = THIRD_PARTY_READ_ONLY_ACTIONS.get(toolName);
	if (readOnly ? readOnly.has(action) : action === undefined) return undefined;
	return `${toolName} ${action ?? "without an action"} changes state beyond reading`;
}

/**
 * The closed table of what only the owner's own terminal turn does, which a run opened from an owner channel (the
 * owner's listed identity on a chat platform) never does: each entry names whether an action of that tool is typed-only.
 * Standing grants, routines that would later run with the owner's authority, replies to third parties, secrets, the
 * harness itself, System One dispositions that unblock later autonomy, and the owner's proactivity settings.
 */
type TypedOnlyRule = (action: string | undefined) => string | undefined;
const REMOTE_OWNER_TYPED_ONLY: ReadonlyMap<string, TypedOnlyRule> = new Map<string, TypedOnlyRule>([
	["goal", (action) => (action === "grant_edge" ? "goal grant_edge records a standing edge grant" : undefined)],
	[
		"routine",
		(action) =>
			action === "create" || action === "update" || action === "resume" || action === "run"
				? `routine ${action} sets standing work that later runs with the owner's own authority`
				: undefined,
	],
	["channel_reply", () => "channel_reply releases or discards replies to third parties"],
	[
		"secret_store",
		(action) =>
			action === "status" || action === "list"
				? undefined
				: `secret_store ${action ?? "without an action"} changes the credentials of external accounts`,
	],
	[
		"runtime_update",
		(action) =>
			action === "status" ? undefined : `runtime_update ${action ?? "without an action"} changes the harness itself`,
	],
	[
		"systemone",
		(action) =>
			action === "resolve_uncertainty"
				? "systemone resolve_uncertainty records a disposition that unblocks later autonomy"
				: undefined,
	],
	[
		"proactivity",
		(action) =>
			action === "set_preferences" || action === "clear_preferences" || action === "turn_off" || action === "turn_on"
				? `proactivity ${action} writes the owner's proactivity settings`
				: undefined,
	],
]);

/** The owner's private records, which a run opened from an owner channel reads and writes (owner decision). */
const REMOTE_OWNER_RECORD_TOOLS: ReadonlySet<string> = new Set(["memory", "knowledge"]);
/** Harness action tools that the read-only and delegation tables do not list. */
const REMOTE_OWNER_OTHER_ACTION_TOOLS: ReadonlySet<string> = new Set(["peer", "tool_task"]);

function isKnownActionTool(toolName: string): boolean {
	return (
		THIRD_PARTY_READ_ONLY_ACTIONS.has(toolName) ||
		DELEGATION_ACTIONS[toolName] !== undefined ||
		REMOTE_OWNER_TYPED_ONLY.has(toolName) ||
		REMOTE_OWNER_RECORD_TOOLS.has(toolName) ||
		REMOTE_OWNER_OTHER_ACTION_TOOLS.has(toolName)
	);
}

function toolAction(args: unknown): string | undefined {
	const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	return typeof record.action === "string" ? record.action : undefined;
}

/**
 * Why a tool call on a run opened from an owner channel is refused outright, never held: the typed-only table, and an
 * action of a tool the gate does not know (an extension tool, a tool added later), which is no more than a run carrying a
 * third party's words may do (`ownerOnlyToolCallReason` refuses every action of a tool it does not list).
 */
export function remoteOwnerTypedOnlyReason(toolName: string, args: unknown): string | undefined {
	const action = toolAction(args);
	const typedOnly = REMOTE_OWNER_TYPED_ONLY.get(toolName);
	if (typedOnly) return typedOnly(action);
	if (action !== undefined && !isKnownActionTool(toolName))
		return `${toolName} ${action} is an action of a tool the owner-channel gate does not know`;
	return undefined;
}

/** The first classified operation a run opened from an owner channel may never be approved for: settings authority. */
export function remoteOwnerTypedOnlyOperation(operations: readonly EdgeOperation[]): EdgeOperation | undefined {
	return operations.find((operation) => operation.class === "settings.authority" || operation.ungrantable === true);
}

/**
 * An action of a harness action tool that a run opened from an owner channel holds for the owner's approval: every
 * action outside the read-only table, the owner's private records and the delegation launches (which the outward
 * classifier holds as `agent.delegate`). Such an action changes state the edge does not classify (a measured command,
 * a step or event write), so the phone owner approves the exact call. A call of such a tool without a string `action`
 * is held too, as a run carrying a third party's words is refused it.
 */
export function remoteOwnerUnclassifiedAction(toolName: string, args: unknown): EdgeOperation | undefined {
	const action = toolAction(args);
	if (REMOTE_OWNER_RECORD_TOOLS.has(toolName) || !isKnownActionTool(toolName)) return undefined;
	if (DELEGATION_ACTIONS[toolName]?.has(action)) return undefined;
	if (THIRD_PARTY_READ_ONLY_ACTIONS.get(toolName)?.has(action)) return undefined;
	return {
		class: "operation.irreversible",
		operation: `${toolName} ${action ?? "without an action"}`,
		reason: "changes state the edge does not classify",
	};
}

const POSIX_SYSTEM_DIRECTORIES: ReadonlySet<string> = new Set([
	"/",
	"/home",
	"/root",
	"/etc",
	"/usr",
	"/var",
	"/bin",
	"/sbin",
	"/boot",
	"/lib",
]);

export interface YoloBoundaryInput extends ClassifyEdgeInput {
	/** Exact shell-command globs the operator has forbidden, even in YOLO. */
	denyCommands?: readonly string[];
}

function commandMatchesDeny(command: string, pattern: string): boolean {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`, "s").test(command.trim());
}

/** The small execution floor evaluated before YOLO grants or standing edge grants. */
export function classifyYoloBoundary(input: YoloBoundaryInput): YoloBoundaryDecision | undefined {
	const args = input.args && typeof input.args === "object" ? (input.args as Record<string, unknown>) : {};
	const name = input.toolName.toLowerCase();
	const command =
		name === "bash" || name === "shell" || name === "powershell"
			? typeof args.command === "string"
				? args.command
				: ""
			: name === "run_process" || name === "run-process"
				? [args.executable, ...(Array.isArray(args.args) ? args.args : [])]
						.filter((part) => typeof part === "string")
						.join(" ")
				: "";
	if (!command) return undefined;
	const invocations = shellInvocations(command, toolDialect(name));
	for (const pattern of input.denyCommands ?? []) {
		if (
			[command, ...invocations.map((argv) => argv.join(" "))].some((candidate) =>
				commandMatchesDeny(candidate, pattern),
			)
		) {
			return { kind: "block", reason: `user deny rule: ${pattern}` };
		}
	}
	if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(command)) {
		return { kind: "block", reason: "fork bomb" };
	}
	for (const argv of invocations) {
		const tool = commandTool(argv[0]);
		const rest = argv.slice(1);
		if (["shutdown", "reboot", "halt", "poweroff"].includes(tool))
			return { kind: "block", reason: "system shutdown or reboot" };
		if ((tool === "init" || tool === "telinit") && ["0", "6"].includes(rest[0] ?? ""))
			return { kind: "block", reason: "system shutdown or reboot" };
		if (tool === "systemctl" && ["poweroff", "reboot", "halt", "kexec"].includes(rest[0] ?? ""))
			return { kind: "block", reason: "system shutdown or reboot" };
		if (tool === "kill" && rest.includes("-1")) return { kind: "block", reason: "kills all processes" };
		if (tool.startsWith("mkfs") || tool === "diskpart" || tool === "format")
			return { kind: "block", reason: "formats a volume" };
		if (tool === "dd" && rest.some((part) => /^of=\/dev\/(?:sd|nvme|hd|mmcblk|vd|xvd)/i.test(part)))
			return { kind: "block", reason: "writes a raw block device" };
		if (
			(tool === "rm" || tool === "find" || POWERSHELL_REMOVE.has(tool)) &&
			(tool !== "find" || findDeletesTree(rest))
		) {
			for (const target of positional(rest)) {
				const normalized = target.replace(/\/\*$/, "");
				if (/^\$(?:HOME|\{HOME\})$/.test(target)) return { kind: "block", reason: "deletes home directory" };
				// A POSIX shell path means what the shell reads, whatever the host: on Windows the same text
				// would otherwise resolve against the current drive and miss every system directory.
				if (normalized.startsWith("/")) {
					const shellPath = nodePath.posix.normalize(normalized).replace(/(?<=.)\/+$/, "");
					if (POSIX_SYSTEM_DIRECTORIES.has(shellPath))
						return { kind: "block", reason: "deletes a system directory" };
				}
				const { resolved, api } = resolveTarget(normalized, input.cwd);
				if (api.parse(resolved).root === resolved) return { kind: "block", reason: "deletes a filesystem root" };
				if (resolved === api.resolve(homedir())) return { kind: "block", reason: "deletes home directory" };
			}
		}
	}
	const repositoryDeletion = classifyAllEdgeOperations(input).find(
		(operation) => operation.class === "destructive.fs" && operation.reason.startsWith("deletes the "),
	);
	if (repositoryDeletion) return { kind: "confirm", reason: "deletes the repository" };
	return undefined;
}

/** Classify the first edge operation for display callers; undefined means ordinary work. */
export function classifyEdgeOperation(input: ClassifyEdgeInput): EdgeOperation | undefined {
	return classifyAllEdgeOperations(input)[0];
}

function classifyGh(argv: readonly string[], joined: string): EdgeOperation | undefined {
	const group = lower(argv[1]);
	const verb = lower(argv[2]);
	if (group === "repo" && verb === "delete") {
		return { class: "destructive.fs", operation: joined, reason: "deletes the remote repository" };
	}
	return undefined;
}

// ---------------------------------------------------------------------------------------------
// Grants

export const EDGE_GRANT_CUSTOM_TYPE = "pi_edge_grant";
export const EDGE_REVOKE_CUSTOM_TYPE = "pi_edge_revoke";

export type EdgeGrantSource = "instructions" | "operator" | "settings";

export interface EdgeGrantRecord {
	version: 1;
	class: EdgeClass;
	source: Exclude<EdgeGrantSource, "settings">;
	/** The operator's exact words the grant rests on (instructions). */
	quote?: string;
	/** The user message the quote resolved to (instructions). */
	messageEntryId?: string;
	/** Free note (operator). */
	note?: string;
	/** Optional exact operation scope key for narrow grants. */
	scopeKey?: string;
	/**
	 * The owner typed it as their own edge command (`/edge allow`): it also covers a run that carries a third party's
	 * words. Absent on a grant given at a prompt (it answers the run that asked) and on a grant the model cited from the
	 * owner's words.
	 */
	standing?: true;
	/**
	 * The owner answered the edge prompt ("allow for the session"). An operator grant without it, and without `standing`,
	 * is System One's reading of the owner's words, which never covers a run opened from an owner channel.
	 */
	prompt?: true;
	grantedAt: string;
}

export interface EdgeRevokeRecord {
	version: 1;
	class: EdgeClass;
	/** Optional scope key to revoke a specific narrow grant; if omitted, revokes all grants for the class. */
	scopeKey?: string;
	revokedAt: string;
}

export interface EdgeGrantView {
	class: EdgeClass;
	source: EdgeGrantSource;
	quote?: string;
	note?: string;
	scopeKey?: string;
	grantedAt?: string;
	messageEntryId?: string;
	/** Settings grants from `edge.thirdPartyAllow` and grants the owner typed (see `EdgeGrantRecord.standing`). */
	standing?: true;
	/** The latest record of this class and scope answered the edge prompt (see `EdgeGrantRecord.prompt`). */
	prompt?: true;
}

export interface ToolkitScriptScopeInput {
	cwd: string;
	scriptPath: string;
	runner: string;
	scriptName: string;
	argv: readonly string[];
}

/** Derives a deterministic scope key from execution cwd, script path, runner, script name, and exact argv. */
export function deriveToolkitScriptScopeKey(input: ToolkitScriptScopeInput): string {
	const resolvedCwd = nodePath.resolve(input.cwd);
	const resolvedPath = nodePath.isAbsolute(input.scriptPath)
		? nodePath.resolve(input.scriptPath)
		: nodePath.resolve(resolvedCwd, input.scriptPath);
	const runner = input.runner.trim();
	const scriptName = input.scriptName.trim();
	const normalizedArgv = [...input.argv];
	const payload = JSON.stringify([resolvedCwd, resolvedPath, runner, scriptName, normalizedArgv]);
	const digest = createHash("sha256").update(payload).digest("hex");
	return `toolkit:${scriptName}:${digest}`;
}

export interface ToolkitScriptIdentity {
	name: string;
	runner: string;
	path: string;
}

export interface BuildToolkitScriptOperationOptions {
	cwd: string;
	script: ToolkitScriptIdentity;
	args: readonly string[];
}

/** Canonical constructor for toolkit.script edge operations, ensuring identical identity across runtime, goal, and workers. */
export function buildToolkitScriptOperation(options: BuildToolkitScriptOperationOptions): EdgeOperation {
	const scopeKey = deriveToolkitScriptScopeKey({
		cwd: options.cwd,
		scriptPath: options.script.path,
		runner: options.script.runner,
		scriptName: options.script.name,
		argv: options.args,
	});
	return {
		class: "toolkit.script",
		operation: `${options.script.name}${options.args.length > 0 ? ` ${options.args.join(" ")}` : ""}`,
		reason: `running dangerous toolkit script "${options.script.name}"`,
		scopeKey,
	};
}

/** Resolves a requested toolkit script and argv against registered scripts into a canonical scope key. */
export function resolveToolkitScriptScope(
	scriptName: string,
	args: readonly string[],
	scripts: readonly ToolkitScript[],
	cwd: string,
): { scopeKey: string } | { error: string } {
	if (!scriptName || scriptName.trim().length === 0) {
		return { error: "toolkit script name must be non-empty." };
	}
	if (scripts.length === 0) {
		return { error: "no toolkit scripts registered in settings." };
	}
	const match = matchToolkitScript(scriptName, [...scripts]);
	if (match.kind === "none") {
		return { error: `toolkit script "${scriptName}" is unknown.` };
	}
	if (match.kind === "ambiguous") {
		return {
			error: `toolkit script "${scriptName}" is ambiguous (${match.shortlist.map((s) => s.name).join(", ")}).`,
		};
	}
	const op = buildToolkitScriptOperation({
		cwd,
		script: match.script,
		args,
	});
	return { scopeKey: op.scopeKey! };
}

/** Check whether an edge operation is covered by active grants (broad class grant or exact scopeKey). */
export function isEdgeOperationGranted(operation: EdgeOperation, grants: readonly EdgeGrantView[]): boolean {
	if (operation.ungrantable) return false;
	return grants.some((grant) => {
		if (grant.class !== operation.class) return false;
		if (grant.scopeKey === undefined) return true;
		return operation.scopeKey !== undefined && grant.scopeKey === operation.scopeKey;
	});
}

/** The branch entries the store reads: every session entry qualifies; only custom ones carry grants. */
export type EdgeGrantSourceEntry = { type: string; customType?: string; data?: unknown } | SessionEntry;

export type ParsedEdgeScope =
	| { valid: true; narrow: false; scopeKey: undefined }
	| { valid: true; narrow: true; scopeKey: string }
	| { valid: false };

/**
 * Validate and parse a narrow or broad edge scope key.
 * Undefined is valid broad. Non-empty string is valid narrow (trimmed).
 * Empty string, whitespace-only, and non-string values are invalid.
 */
export function parseEdgeScope(value: unknown): ParsedEdgeScope {
	if (value === undefined) {
		return { valid: true, narrow: false, scopeKey: undefined };
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.length > 0) {
			return { valid: true, narrow: true, scopeKey: trimmed };
		}
	}
	return { valid: false };
}

function parseRecordScope(record: Record<string, unknown>): ParsedEdgeScope {
	if (!("scopeKey" in record)) {
		return { valid: true, narrow: false, scopeKey: undefined };
	}
	return parseEdgeScope(record.scopeKey);
}

function grantRecord(data: unknown): EdgeGrantRecord | undefined {
	if (!data || typeof data !== "object") return undefined;
	const record = data as Record<string, unknown>;
	if (record.version !== 1 || !isEdgeClass(record.class)) return undefined;
	if (record.source !== "instructions" && record.source !== "operator") return undefined;
	const scope = parseRecordScope(record);
	if (!scope.valid) return undefined;
	return {
		version: 1,
		class: record.class,
		source: record.source,
		...(typeof record.quote === "string" ? { quote: record.quote } : {}),
		...(typeof record.messageEntryId === "string" ? { messageEntryId: record.messageEntryId } : {}),
		...(typeof record.note === "string" ? { note: record.note } : {}),
		...(scope.narrow ? { scopeKey: scope.scopeKey } : {}),
		...(record.standing === true ? { standing: true as const } : {}),
		...(record.prompt === true ? { prompt: true as const } : {}),
		grantedAt: typeof record.grantedAt === "string" ? record.grantedAt : "",
	};
}

function revokeRecord(data: unknown): EdgeRevokeRecord | undefined {
	if (!data || typeof data !== "object") return undefined;
	const record = data as Record<string, unknown>;
	if (record.version !== 1 || !isEdgeClass(record.class)) return undefined;
	const scope = parseRecordScope(record);
	if (!scope.valid) return undefined;
	return {
		version: 1,
		class: record.class,
		...(scope.narrow ? { scopeKey: scope.scopeKey } : {}),
		revokedAt: typeof record.revokedAt === "string" ? record.revokedAt : "",
	};
}

/**
 * Replay the branch's grant and revoke records over the machine's standing grants. A revoke removes
 * a session or instruction grant; a settings grant is the machine's and stays until the setting
 * changes. Supports multiple scoped grants for one class, broad class grants, and scoped revocation.
 * Standing is kept per grant: a later record of the same class and scope that does not stand (a
 * prompt answer, a cited grant) never takes it away; only a revoke does.
 */
export function collectEdgeGrants(
	entries: readonly EdgeGrantSourceEntry[],
	settingsAllow: readonly string[],
	standingSettingsAllow: readonly string[] = [],
): EdgeGrantView[] {
	const grants = new Map<string, EdgeGrantView>();
	for (const cls of settingsAllow) {
		if (isEdgeClass(cls)) {
			grants.set(`${cls}:*`, {
				class: cls,
				source: "settings",
				...(standingSettingsAllow.includes(cls) ? { standing: true as const } : {}),
			});
		}
	}
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		const custom = entry as { customType?: string; data?: unknown };
		if (custom.customType === EDGE_GRANT_CUSTOM_TYPE) {
			const record = grantRecord(custom.data);
			if (!record) continue;
			const key = `${record.class}:${record.scopeKey ?? "*"}`;
			const prior = grants.get(key);
			if (prior?.source === "settings") continue;
			const standing = record.standing === true || prior?.standing === true;
			grants.set(key, {
				class: record.class,
				source: record.source,
				...(record.quote ? { quote: record.quote } : {}),
				...(record.note ? { note: record.note } : {}),
				...(record.scopeKey !== undefined ? { scopeKey: record.scopeKey } : {}),
				...(record.messageEntryId ? { messageEntryId: record.messageEntryId } : {}),
				...(standing ? { standing: true as const } : {}),
				...(record.prompt ? { prompt: true as const } : {}),
				grantedAt: record.grantedAt,
			});
		} else if (custom.customType === EDGE_REVOKE_CUSTOM_TYPE) {
			const record = revokeRecord(custom.data);
			if (!record) continue;
			const cls = record.class;
			if (record.scopeKey !== undefined) {
				const key = `${cls}:${record.scopeKey}`;
				if (grants.get(key)?.source !== "settings") grants.delete(key);
			} else {
				for (const [key, grant] of grants.entries()) {
					if (grant.class === cls && grant.source !== "settings") {
						grants.delete(key);
					}
				}
			}
		}
	}
	return [...grants.values()];
}

export type EdgeDecision = "allow-once" | "allow-session" | "deny";

export interface EdgeConfirmationRequest {
	class: EdgeClass;
	operation: string;
	reason: string;
	toolName: string;
	scopeKey?: string;
}

export type EdgeConfirmationHandler = (request: EdgeConfirmationRequest, signal?: AbortSignal) => Promise<EdgeDecision>;

export const EDGE_CONFIRMATION_REQUIRED = "edge_confirmation_required";

/** One line of at most `bound` characters: the action is shortened, never the head or the tail. */
export function boundedActionLine(head: string, action: string, tail: string, bound: number): string {
	const room = Math.max(16, bound - head.length - tail.length);
	return `${head}${action.length <= room ? action : `${action.slice(0, room - 1)}…`}${tail}`;
}

/** The classes of `operations` a grant can cover (a write into the session store never is). */
export function grantableEdgeClasses(operations: readonly EdgeOperation[]): EdgeClass[] {
	return [...new Set(operations.filter((operation) => !operation.ungrantable).map((operation) => operation.class))];
}

/** How the owner lets a run carrying a third party's words do `operations`: their own turn, or a standing grant. */
export function thirdPartyReleaseLine(operations: readonly EdgeOperation[]): string {
	const grantable = grantableEdgeClasses(operations);
	return `It runs only when the owner asks for it in their own turn${grantable.length > 0 ? `, or after they type ${grantable.map((edgeClass) => `/edge allow ${edgeClass}`).join(", ")} or list the classes in edge.thirdPartyAllow` : ""}.`;
}

/**
 * A worker's calls in a run that carries a third party's words, outside the owner's standing grants: refused, never
 * prepared (a worker keeps no drafts), and reported to the parent, which tells the owner. The reason is the failure
 * record's bounded diagnostic (`MAX_TOOL_FAILURE_DIAGNOSTIC_CHARS`); the release goes in the correction, its next action.
 */
export function thirdPartyEdgeRefusal(operations: readonly EdgeOperation[]): { reason: string; correction: string } {
	const actions = operations.map((operation) => `${operation.operation} (${operation.class}: ${operation.reason})`);
	const classes = [...new Set(operations.map((operation) => operation.class))];
	return {
		reason: boundedActionLine(
			"Not run: ",
			actions.join("; "),
			`; this run carries words written by someone else, and no standing grant of the owner covers ${classes.join(", ")}.`,
			MAX_TOOL_FAILURE_DIAGNOSTIC_CHARS,
		),
		correction: `${thirdPartyReleaseLine(operations)} Report the action in your result so the parent can tell the owner, and continue with the rest.`,
	};
}

/** The reason a blocked call carries: what stopped it and each way to grant it, pointers first. */
export function edgeBlockReason(operation: EdgeOperation, denied: boolean): string {
	const verdict = denied ? "the operator declined" : "needs the operator";
	return `Edge [${EDGE_CONFIRMATION_REQUIRED}]: ${operation.operation} — ${operation.class} (${operation.reason}) ${verdict}. Grant: /edge allow ${operation.class} (operator), or goal grant_edge with edgeClass "${operation.class}" and the operator's exact words (instructions). Do not retry unchanged.`;
}
