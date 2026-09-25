import { createHash } from "node:crypto";
import { homedir } from "node:os";
import nodePath from "node:path";
import type { SessionEntry } from "@caupulican/pi-agent-core/node";
import { matchToolkitScript, type ToolkitScript } from "../toolkit/script-registry.ts";
import { expandPath } from "../tools/path-utils.ts";
import { parseShellCommandSequence, stripShellInvocationPrefixes } from "../tools/shell-command-parser.ts";

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

function splitLoose(command: string): string[][] {
	return command
		.split(/\s*(?:&&|\|\||[;|]|\r?\n)\s*/)
		.map((segment) => segment.trim())
		.filter(Boolean)
		.map((segment) => segment.split(/\s+/));
}

const WRAPPER_VALUE_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
	sudo: new Set(["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "-D", "-R", "-T", "-U"]),
	doas: new Set(["-u", "-C"]),
	nice: new Set(["-n", "--adjustment"]),
	timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
	stdbuf: new Set(["-i", "-o", "-e"]),
};
const PLAIN_WRAPPERS = new Set(["nohup", "exec", "time", "builtin", "unbuffer", "caffeinate"]);

/** `sudo -u root git push` is a git push: privilege and timing wrappers do not change the operation. */
function stripWrappers(argv: string[]): string[] {
	let args = argv;
	for (let guard = 0; guard < 8 && args.length > 0; guard++) {
		const tool = lower(args[0]);
		if (PLAIN_WRAPPERS.has(tool)) {
			args = args.slice(1);
			continue;
		}
		const valueOptions = WRAPPER_VALUE_OPTIONS[tool];
		if (!valueOptions) break;
		let index = 1;
		if (tool === "timeout" && index < args.length && !isOption(args[index] as string)) index++;
		while (index < args.length && isOption(args[index] as string)) {
			const option = args[index] as string;
			index += valueOptions.has(option) && !option.includes("=") ? 2 : 1;
		}
		args = args.slice(index);
	}
	return args;
}

/** Simple commands of a shell line; the loose split covers what the parser refuses (subshells). */
export function shellInvocations(command: string): string[][] {
	const parsed = parseShellCommandSequence(command, { redirects: "drop" });
	const invocations = parsed ? parsed.invocations : splitLoose(command);
	return invocations
		.map((argv) => stripWrappers(stripShellInvocationPrefixes([...argv])))
		.filter((argv) => argv.length > 0);
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
	for (const argv of shellInvocations(command)) {
		operations.push(...classifyInvokedArgv(argv, input.cwd, input.scopeCwd));
	}
	return operations;
}

export type YoloBoundaryDecision = { kind: "block" | "confirm"; reason: string };

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
	const invocations = shellInvocations(command);
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
				const { resolved, api } = resolveTarget(normalized, input.cwd);
				if (
					api === nodePath &&
					["/", "/home", "/root", "/etc", "/usr", "/var", "/bin", "/sbin", "/boot", "/lib"].includes(resolved)
				) {
					return { kind: "block", reason: "deletes a system directory" };
				}
				if (api === nodePath && resolved === nodePath.resolve(homedir()))
					return { kind: "block", reason: "deletes home directory" };
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
 */
export function collectEdgeGrants(
	entries: readonly EdgeGrantSourceEntry[],
	settingsAllow: readonly string[],
): EdgeGrantView[] {
	const grants = new Map<string, EdgeGrantView>();
	for (const cls of settingsAllow) {
		if (isEdgeClass(cls)) {
			grants.set(`${cls}:*`, { class: cls, source: "settings" });
		}
	}
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		const custom = entry as { customType?: string; data?: unknown };
		if (custom.customType === EDGE_GRANT_CUSTOM_TYPE) {
			const record = grantRecord(custom.data);
			if (!record) continue;
			const key = `${record.class}:${record.scopeKey ?? "*"}`;
			if (grants.get(key)?.source === "settings") continue;
			grants.set(key, {
				class: record.class,
				source: record.source,
				...(record.quote ? { quote: record.quote } : {}),
				...(record.note ? { note: record.note } : {}),
				...(record.scopeKey !== undefined ? { scopeKey: record.scopeKey } : {}),
				...(record.messageEntryId ? { messageEntryId: record.messageEntryId } : {}),
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

/** The reason a blocked call carries: what stopped it and each way to grant it, pointers first. */
export function edgeBlockReason(operation: EdgeOperation, denied: boolean): string {
	const verdict = denied ? "the operator declined" : "needs the operator";
	return `Edge [${EDGE_CONFIRMATION_REQUIRED}]: ${operation.operation} — ${operation.class} (${operation.reason}) ${verdict}. Grant: /edge allow ${operation.class} (operator), or goal grant_edge with edgeClass "${operation.class}" and the operator's exact words (instructions). Do not retry unchanged.`;
}
