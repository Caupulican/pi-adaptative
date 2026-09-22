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
] as const;
export type EdgeClass = (typeof EDGE_CLASSES)[number];

export const EDGE_CLASS_DESCRIPTIONS: Readonly<Record<EdgeClass, string>> = {
	"git.publish": "git push, tag, and release run without asking",
	"package.publish": "publishing a package or image runs without asking",
	"package.install": "installing a package runs without asking",
	"destructive.fs":
		"deleting the repository, a directory that contains it, the home directory, a filesystem root, or a disk",
	"settings.authority": "editing settings and credentials runs without asking",
	"toolkit.script": "running registered dangerous toolkit scripts",
};

/** Classes a tool call can still make the operator confirm. The other names stay for grants. */
export function edgeClassRequiresConfirmation(edgeClass: EdgeClass): boolean {
	return edgeClass === "destructive.fs" || edgeClass === "toolkit.script";
}

export function isEdgeClass(value: unknown): value is EdgeClass {
	return typeof value === "string" && (EDGE_CLASSES as readonly string[]).includes(value);
}

export interface EdgeOperation {
	class: EdgeClass;
	/** The operation as the operator would read it (`git push origin main`). */
	operation: string;
	/** Why it is on the edge. */
	reason: string;
	/** Optional exact operation scope key (e.g. deterministic digest for narrow toolkit approvals). */
	scopeKey?: string;
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

function classifyInvokedArgv(argv: readonly string[], cwd: string, scopeCwd: string): EdgeOperation[] {
	if (argv.length === 0) return [];
	const joined = argv.join(" ");
	const tool = commandTool(argv[0]);
	const operations: EdgeOperation[] = [];
	if (tool === "gh") {
		const remote = classifyGh(argv, joined);
		if (remote) operations.push(remote);
	}
	const deletion = classifyDeletion(argv, joined, cwd, scopeCwd);
	if (deletion) operations.push(deletion);
	return operations;
}

/** Classify all edge operations in a tool call; empty array means ordinary work. */
export function classifyAllEdgeOperations(input: ClassifyEdgeInput): EdgeOperation[] {
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
