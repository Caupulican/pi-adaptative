import { homedir } from "node:os";
import nodePath from "node:path";
import type { SessionEntry } from "@caupulican/pi-agent-core/node";
import { getAgentDir } from "../../config.ts";
import { expandPath } from "../tools/path-utils.ts";
import { parseShellCommandSequence, stripShellInvocationPrefixes } from "../tools/shell-command-parser.ts";
import { isPathWithinScope } from "./path-scope.ts";

/**
 * The edge: the operations that can need the operator, and whether they still do.
 *
 * Autonomy is provided by the harness and the agent; the human is enforced at the edge. The edge
 * is a short list of operation classes — publishing a repository, publishing or adding packages,
 * deleting outside the task, changing the harness's own authority — and whether one actually
 * stops depends on what the operator said. A class granted by the task instructions (recorded by
 * the model with the operator's exact words), by the operator in this session (`/edge allow`) or
 * by the machine's settings (`edge.allow`) never asks. An ungranted class asks once, structurally:
 * the tool call waits for a one-key answer in the workbench, or is blocked with the reason when no
 * one is at the keyboard. Nothing else in the tool layer ever asks.
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
] as const;
export type EdgeClass = (typeof EDGE_CLASSES)[number];

export const EDGE_CLASS_DESCRIPTIONS: Readonly<Record<EdgeClass, string>> = {
	"git.publish": "git push, tag, release (outward-facing repository changes)",
	"package.publish": "publishing a package or image to a registry",
	"package.install": "adding a dependency or installing a package globally",
	"destructive.fs": "irreversible deletion outside the task directory, or discarding uncommitted work",
	"settings.authority": "changing the harness's own settings, credentials or authority files",
};

export function isEdgeClass(value: unknown): value is EdgeClass {
	return typeof value === "string" && (EDGE_CLASSES as readonly string[]).includes(value);
}

export interface EdgeOperation {
	class: EdgeClass;
	/** The operation as the operator would read it (`git push origin main`). */
	operation: string;
	/** Why it is on the edge. */
	reason: string;
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
const PUBLISH_PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const INSTALL_ADD_SUBCOMMANDS = new Set(["add"]);
const NPM_INSTALL_SUBCOMMANDS = new Set(["install", "i", "add", "isntall"]);
const RECURSIVE_RM_FLAGS = /^-[a-zA-Z]*[rR][a-zA-Z]*$/;
const POWERSHELL_REMOVE = new Set(["remove-item", "ri", "rm", "del", "erase", "rd", "rmdir"]);
const AUTHORITY_FILES = new Set(["settings.json", "auth.json", "keybindings.json", "models.json"]);
const MUTATING_FILE_TOOLS = new Set([
	"sed",
	"tee",
	"cp",
	"mv",
	"rm",
	"truncate",
	"install",
	"ln",
	"dd",
	"python",
	"node",
]);

function lower(token: string | undefined): string {
	return (token ?? "").toLowerCase();
}

function isOption(token: string): boolean {
	return token.startsWith("-") && token !== "-";
}

function positional(argv: readonly string[]): string[] {
	return argv.filter((token) => !isOption(token));
}

/** `git -C dir -c k=v <subcommand> …` → the subcommand and the arguments after it. */
function gitInvocation(argv: readonly string[]): { subcommand: string; rest: string[] } | undefined {
	let index = 1;
	while (index < argv.length) {
		const token = argv[index] as string;
		if (!isOption(token)) return { subcommand: token.toLowerCase(), rest: argv.slice(index + 1) };
		if (GIT_GLOBAL_VALUE_OPTIONS.has(token)) index += 2;
		else index += 1;
	}
	return undefined;
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

/** A path the task may not delete: a root, the home directory, or anything outside the task directory. */
function isOutsideTask(target: string, cwd: string, scopeCwd: string): boolean {
	const { resolved, api } = resolveTarget(target, cwd);
	const parsed = api.parse(resolved);
	if (parsed.root === resolved || resolved === nodePath.resolve(homedir())) return true;
	return !isPathWithinScope(resolved, scopeCwd);
}

function isAuthorityFile(target: string, cwd: string, agentDir: string): boolean {
	const { resolved } = resolveTarget(target, cwd);
	const base = nodePath.basename(resolved).toLowerCase();
	if (!AUTHORITY_FILES.has(base)) return false;
	const parent = nodePath.basename(nodePath.dirname(resolved)).toLowerCase();
	return isPathWithinScope(resolved, agentDir) || parent === ".pi" || parent === "agent";
}

function classifyGit(argv: readonly string[], joined: string): EdgeOperation | undefined {
	const invocation = gitInvocation(argv);
	if (!invocation) return undefined;
	const { subcommand, rest } = invocation;
	const options = rest.filter(isOption).map((token) => token.toLowerCase());
	const targets = positional(rest);
	switch (subcommand) {
		case "push":
			return { class: "git.publish", operation: joined, reason: "pushes commits to a remote" };
		case "tag": {
			const listing = options.some((option) =>
				["-l", "--list", "-d", "--delete", "-v", "--verify", "-n", "--contains", "--points-at", "--merged"].some(
					(flag) => option === flag || option.startsWith(`${flag}=`),
				),
			);
			if (!listing && targets.length > 0) {
				return { class: "git.publish", operation: joined, reason: "creates a release tag" };
			}
			return undefined;
		}
		case "reset":
			if (options.includes("--hard") || options.includes("--merge")) {
				return { class: "destructive.fs", operation: joined, reason: "discards uncommitted work" };
			}
			return undefined;
		case "clean":
			if (options.some((option) => /^-[a-z]*f|^--force$/.test(option))) {
				return { class: "destructive.fs", operation: joined, reason: "deletes untracked files" };
			}
			return undefined;
		case "checkout":
			if (rest.includes("--") || (targets.length > 0 && targets.every((target) => target === "."))) {
				return { class: "destructive.fs", operation: joined, reason: "discards working-tree changes" };
			}
			return undefined;
		case "restore":
			if (
				targets.length > 0 &&
				!options.some((option) => option === "--staged" || option === "-s" || option === "--worktree=false")
			) {
				return { class: "destructive.fs", operation: joined, reason: "discards working-tree changes" };
			}
			return undefined;
		case "stash":
			if (targets[0] === "drop" || targets[0] === "clear") {
				return { class: "destructive.fs", operation: joined, reason: "deletes stashed work" };
			}
			return undefined;
		case "filter-branch":
		case "filter-repo":
			return { class: "destructive.fs", operation: joined, reason: "rewrites repository history" };
		case "reflog":
			if (targets[0] === "expire" || targets[0] === "delete") {
				return { class: "destructive.fs", operation: joined, reason: "expires recovery history" };
			}
			return undefined;
		case "gc":
			if (options.some((option) => option.startsWith("--prune"))) {
				return { class: "destructive.fs", operation: joined, reason: "prunes unreachable objects" };
			}
			return undefined;
		default:
			return undefined;
	}
}

function classifyPackageManager(argv: readonly string[], joined: string): EdgeOperation | undefined {
	const tool = lower(argv[0]);
	const subcommand = lower(argv[1]);
	const rest = argv.slice(2);
	const options = rest.filter(isOption).map((token) => token.toLowerCase());
	const targets = positional(rest);
	if (PUBLISH_PACKAGE_MANAGERS.has(tool)) {
		if (subcommand === "publish" || subcommand === "unpublish" || subcommand === "deprecate") {
			return { class: "package.publish", operation: joined, reason: `${tool} ${subcommand} reaches the registry` };
		}
		const global = options.some((option) => option === "-g" || option === "--global");
		if (tool === "npm" && NPM_INSTALL_SUBCOMMANDS.has(subcommand) && (targets.length > 0 || global)) {
			return {
				class: "package.install",
				operation: joined,
				reason: global ? "installs globally" : "adds a dependency",
			};
		}
		if (tool !== "npm" && (INSTALL_ADD_SUBCOMMANDS.has(subcommand) || (subcommand === "install" && global))) {
			if (targets.length > 0 || global) {
				return {
					class: "package.install",
					operation: joined,
					reason: global ? "installs globally" : "adds a dependency",
				};
			}
		}
		if (tool === "pnpm" && subcommand === "install" && targets.length > 0) {
			return { class: "package.install", operation: joined, reason: "adds a dependency" };
		}
		return undefined;
	}
	if (tool === "pip" || tool === "pip3" || tool === "pipx") {
		if (subcommand === "install") {
			const requirementsOnly = options.some((option) => option === "-r" || option === "--requirement");
			const editableOnly = targets.length === 0 || (options.includes("-e") && targets.every((t) => t === "."));
			if (!requirementsOnly && !editableOnly) {
				return { class: "package.install", operation: joined, reason: "adds a dependency" };
			}
		}
		return undefined;
	}
	if (tool === "uv") {
		if (
			subcommand === "add" ||
			(subcommand === "pip" && lower(argv[2]) === "install" && positional(argv.slice(3)).length > 0)
		) {
			return { class: "package.install", operation: joined, reason: "adds a dependency" };
		}
		if (subcommand === "publish")
			return { class: "package.publish", operation: joined, reason: "reaches the registry" };
		return undefined;
	}
	if (tool === "poetry" && subcommand === "add") {
		return { class: "package.install", operation: joined, reason: "adds a dependency" };
	}
	if (tool === "poetry" && subcommand === "publish") {
		return { class: "package.publish", operation: joined, reason: "reaches the registry" };
	}
	if (tool === "cargo") {
		if (subcommand === "add" || subcommand === "install") {
			return { class: "package.install", operation: joined, reason: "adds a dependency" };
		}
		if (subcommand === "publish")
			return { class: "package.publish", operation: joined, reason: "reaches the registry" };
		return undefined;
	}
	if (tool === "gem") {
		if (subcommand === "install") return { class: "package.install", operation: joined, reason: "installs a gem" };
		if (subcommand === "push") return { class: "package.publish", operation: joined, reason: "reaches the registry" };
		return undefined;
	}
	if (tool === "go" && (subcommand === "get" || subcommand === "install") && targets.length > 0) {
		return { class: "package.install", operation: joined, reason: "adds a dependency" };
	}
	if (tool === "twine" && subcommand === "upload") {
		return { class: "package.publish", operation: joined, reason: "reaches the registry" };
	}
	if ((tool === "docker" || tool === "podman" || tool === "helm") && subcommand === "push") {
		return { class: "package.publish", operation: joined, reason: "pushes an image or chart" };
	}
	if (
		["brew", "apt", "apt-get", "dnf", "yum", "pacman", "choco", "winget", "scoop"].includes(tool) &&
		(subcommand === "install" || (tool === "pacman" && subcommand.startsWith("-s")))
	) {
		return { class: "package.install", operation: joined, reason: "installs a system package" };
	}
	return undefined;
}

function classifyDeletion(
	argv: readonly string[],
	joined: string,
	cwd: string,
	scopeCwd: string,
): EdgeOperation | undefined {
	const tool = lower(argv[0]);
	const rest = argv.slice(1);
	const targets = positional(rest);
	if (tool === "rm" || tool === "unlink" || tool === "shred") {
		const outside = targets.filter((target) => isOutsideTask(target, cwd, scopeCwd));
		if (outside.length > 0) {
			return {
				class: "destructive.fs",
				operation: joined,
				reason: `deletes outside the task directory (${outside.join(", ")})`,
			};
		}
		return undefined;
	}
	if (POWERSHELL_REMOVE.has(tool)) {
		const recursive = rest.some((token) => /^-recurse$/i.test(token) || /^\/s$/i.test(token));
		const outside = targets.filter((target) => isOutsideTask(target, cwd, scopeCwd));
		if (outside.length > 0 || (recursive && targets.length === 0)) {
			return { class: "destructive.fs", operation: joined, reason: "deletes outside the task directory" };
		}
		return undefined;
	}
	if (tool === "find") {
		const deletes =
			rest.includes("-delete") || rest.some((token, index) => token === "-exec" && lower(rest[index + 1]) === "rm");
		if (deletes) {
			const roots = targets.filter((target) => !target.startsWith("-"));
			const outside = roots.filter((root) => isOutsideTask(root, cwd, scopeCwd));
			if (outside.length > 0) {
				return { class: "destructive.fs", operation: joined, reason: "deletes outside the task directory" };
			}
		}
		return undefined;
	}
	if ((tool === "chmod" || tool === "chown") && rest.some((token) => RECURSIVE_RM_FLAGS.test(token))) {
		const outside = targets.slice(1).filter((target) => isOutsideTask(target, cwd, scopeCwd));
		if (outside.length > 0) {
			return { class: "destructive.fs", operation: joined, reason: "changes ownership or mode outside the task" };
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

function classifyAuthorityWrite(
	argv: readonly string[],
	raw: string,
	joined: string,
	cwd: string,
	agentDir: string,
): EdgeOperation | undefined {
	const tool = lower(argv[0]);
	const mutating = MUTATING_FILE_TOOLS.has(tool) || />|\btee\b/.test(raw);
	if (!mutating) return undefined;
	const target = [...argv.slice(1), ...raw.split(/\s+/)].find((token) => isAuthorityFile(token, cwd, agentDir));
	if (!target) return undefined;
	return { class: "settings.authority", operation: joined, reason: `writes ${nodePath.basename(target)}` };
}

/** Classify one tool call; undefined means ordinary work. */
export function classifyEdgeOperation(input: ClassifyEdgeInput): EdgeOperation | undefined {
	const args = input.args && typeof input.args === "object" ? (input.args as Record<string, unknown>) : {};
	const agentDir = input.agentDir ?? getAgentDir();
	const name = input.toolName.toLowerCase();
	if (name === "write" || name === "edit" || name === "edit-diff") {
		const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : "";
		if (path && isAuthorityFile(path, input.cwd, agentDir)) {
			return {
				class: "settings.authority",
				operation: `${name} ${path}`,
				reason: `writes ${nodePath.basename(path)}`,
			};
		}
		return undefined;
	}
	if (name !== "bash" && name !== "powershell" && name !== "shell") return undefined;
	const command = typeof args.command === "string" ? args.command : "";
	if (!command.trim()) return undefined;
	for (const argv of shellInvocations(command)) {
		const joined = argv.join(" ");
		const tool = lower(argv[0]);
		const raw = command;
		const classified =
			(tool === "git" ? classifyGit(argv, joined) : undefined) ??
			(tool === "gh" && ["release", "pr", "repo"].includes(lower(argv[1])) && lower(argv[2]) !== "list"
				? classifyGh(argv, joined)
				: undefined) ??
			classifyPackageManager(argv, joined) ??
			classifyDeletion(argv, joined, input.cwd, input.scopeCwd) ??
			classifyAuthorityWrite(argv, raw, joined, input.cwd, agentDir);
		if (classified) return classified;
	}
	return undefined;
}

function classifyGh(argv: readonly string[], joined: string): EdgeOperation | undefined {
	const group = lower(argv[1]);
	const verb = lower(argv[2]);
	if (group === "release" && ["create", "upload", "delete", "edit"].includes(verb)) {
		return { class: "git.publish", operation: joined, reason: "changes a published release" };
	}
	if (group === "pr" && verb === "merge")
		return { class: "git.publish", operation: joined, reason: "merges on the remote" };
	if (group === "repo" && ["delete", "rename", "archive"].includes(verb)) {
		return { class: "git.publish", operation: joined, reason: "changes the remote repository" };
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
	grantedAt: string;
}

export interface EdgeRevokeRecord {
	version: 1;
	class: EdgeClass;
	revokedAt: string;
}

export interface EdgeGrantView {
	class: EdgeClass;
	source: EdgeGrantSource;
	quote?: string;
	note?: string;
	grantedAt?: string;
}

/** The branch entries the store reads: every session entry qualifies; only custom ones carry grants. */
export type EdgeGrantSourceEntry = { type: string; customType?: string; data?: unknown } | SessionEntry;

function grantRecord(data: unknown): EdgeGrantRecord | undefined {
	if (!data || typeof data !== "object") return undefined;
	const record = data as Record<string, unknown>;
	if (record.version !== 1 || !isEdgeClass(record.class)) return undefined;
	if (record.source !== "instructions" && record.source !== "operator") return undefined;
	return {
		version: 1,
		class: record.class,
		source: record.source,
		...(typeof record.quote === "string" ? { quote: record.quote } : {}),
		...(typeof record.messageEntryId === "string" ? { messageEntryId: record.messageEntryId } : {}),
		...(typeof record.note === "string" ? { note: record.note } : {}),
		grantedAt: typeof record.grantedAt === "string" ? record.grantedAt : "",
	};
}

/**
 * Replay the branch's grant and revoke records over the machine's standing grants. A revoke removes
 * a session or instruction grant; a settings grant is the machine's and stays until the setting
 * changes.
 */
export function collectEdgeGrants(
	entries: readonly EdgeGrantSourceEntry[],
	settingsAllow: readonly string[],
): EdgeGrantView[] {
	const grants = new Map<EdgeClass, EdgeGrantView>();
	for (const cls of settingsAllow) if (isEdgeClass(cls)) grants.set(cls, { class: cls, source: "settings" });
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		const custom = entry as { customType?: string; data?: unknown };
		if (custom.customType === EDGE_GRANT_CUSTOM_TYPE) {
			const record = grantRecord(custom.data);
			if (!record || grants.get(record.class)?.source === "settings") continue;
			grants.set(record.class, {
				class: record.class,
				source: record.source,
				...(record.quote ? { quote: record.quote } : {}),
				...(record.note ? { note: record.note } : {}),
				grantedAt: record.grantedAt,
			});
		} else if (custom.customType === EDGE_REVOKE_CUSTOM_TYPE) {
			const data = custom.data as { class?: unknown } | undefined;
			if (isEdgeClass(data?.class) && grants.get(data.class)?.source !== "settings") grants.delete(data.class);
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
}

export type EdgeConfirmationHandler = (request: EdgeConfirmationRequest, signal?: AbortSignal) => Promise<EdgeDecision>;

export const EDGE_CONFIRMATION_REQUIRED = "edge_confirmation_required";

/** The reason a blocked call carries: what stopped it and each way to grant it, pointers first. */
export function edgeBlockReason(operation: EdgeOperation, denied: boolean): string {
	const verdict = denied ? "the operator declined" : "needs the operator";
	return `Edge [${EDGE_CONFIRMATION_REQUIRED}]: ${operation.operation} — ${operation.class} (${operation.reason}) ${verdict}. Grant: /edge allow ${operation.class} (operator), or goal grant_edge with edgeClass "${operation.class}" and the operator's exact words (instructions). Do not retry unchanged.`;
}
