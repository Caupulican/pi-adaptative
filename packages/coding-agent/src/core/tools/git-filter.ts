import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { waitForChildProcess } from "../../utils/child-process.ts";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../../utils/shell.ts";

const SUPPORTED_SUBCOMMANDS = new Set([
	"status",
	"log",
	"diff",
	"show",
	"add",
	"commit",
	"push",
	"pull",
	"branch",
	"fetch",
	"stash",
	"worktree",
]);

export interface FilterResult {
	output: string;
	exitCode: number;
	rawOut: string;
	rawBytes?: Buffer;
}

interface GitQueryResult {
	stdout: string;
	stderr: string;
	status: number | null;
	rawBytes: Buffer;
}

interface GitFilterOptions {
	signal?: AbortSignal;
	timeout?: number;
}

export function unicodeTruncate(str: string, maxLength: number): string {
	const chars = Array.from(str);
	if (chars.length <= maxLength) return str;
	return `${chars.slice(0, maxLength).join("")}...`;
}

export function tokenizeCommand(command: string): string[] | null {
	const args: string[] = [];
	let current = "";
	let inDoubleQuotes = false;
	let inSingleQuotes = false;
	let escapeNext = false;

	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		if (escapeNext) {
			current += char;
			escapeNext = false;
			continue;
		}
		if (char === "\\" && !inSingleQuotes) {
			escapeNext = true;
			continue;
		}
		if (char === '"' && !inSingleQuotes) {
			inDoubleQuotes = !inDoubleQuotes;
		} else if (char === "'" && !inDoubleQuotes) {
			inSingleQuotes = !inSingleQuotes;
		} else if (/\s/.test(char) && !inDoubleQuotes && !inSingleQuotes) {
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}
	if (inDoubleQuotes || inSingleQuotes || escapeNext) return null;
	if (current) args.push(current);
	return args;
}

export interface ParsedCommand {
	envVars: Record<string, string>;
	coreCommandTokens: string[];
}

export function parseCommandPrefixes(command: string): ParsedCommand | null {
	const tokens = tokenizeCommand(command);
	if (!tokens || tokens.length === 0) return null;

	const envVars: Record<string, string> = {};
	let i = 0;
	const envPattern = /^([a-zA-Z_][a-zA-Z0-9_]*)=(.*)$/;

	while (i < tokens.length) {
		const token = tokens[i];
		const match = token.match(envPattern);
		if (!match) break;
		let value = match[2];
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		envVars[match[1]] = value;
		i++;
	}

	return { envVars, coreCommandTokens: tokens.slice(i) };
}

export function isComplexShellCommand(command: string): boolean {
	return /[|><&;\n\r$`()*?[\]#]/.test(command);
}

function quoteForShell(arg: string): string {
	if (/^[A-Za-z0-9_./:=+-]+$/.test(arg)) return arg;
	return `'${arg.replace(/'/g, `'"'"'`)}'`;
}

function gitCommand(globalOptions: string[], args: string[]): string {
	return ["git", ...globalOptions, ...args].map(quoteForShell).join(" ");
}

function rawText(res: GitQueryResult, combine = false): string {
	if (combine) return `${res.stderr}${res.stderr && res.stdout ? "\n" : ""}${res.stdout}`;
	return res.stderr || res.stdout;
}

function resultFromQuery(res: GitQueryResult, output: string, exitCode = res.status ?? 0): FilterResult {
	return { output, exitCode, rawOut: rawText(res), rawBytes: res.rawBytes };
}

export async function runGitQuery(
	cwd: string,
	globalOptions: string[],
	args: string[],
	options?: GitFilterOptions,
): Promise<GitQueryResult> {
	if (options?.signal?.aborted) throw new Error("aborted");

	const child = spawn("git", [...globalOptions, ...args], {
		cwd,
		detached: process.platform !== "win32",
		env: { ...process.env, LC_ALL: "C" },
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	if (child.pid) trackDetachedChildPid(child.pid);

	const stdoutChunks: Buffer[] = [];
	const stderrChunks: Buffer[] = [];
	let timedOut = false;
	const timeoutSeconds = options?.timeout;
	let timeoutHandle: NodeJS.Timeout | undefined;
	const killChild = () => {
		if (child.pid) killProcessTree(child.pid);
	};

	try {
		if (timeoutSeconds !== undefined && timeoutSeconds > 0) {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				killChild();
			}, timeoutSeconds * 1000);
		}
		if (options?.signal) {
			if (options.signal.aborted) killChild();
			else options.signal.addEventListener("abort", killChild, { once: true });
		}

		child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
		const status = await waitForChildProcess(child);
		if (options?.signal?.aborted) throw new Error("aborted");
		if (timedOut) throw new Error(`timeout:${timeoutSeconds}`);
		const stdoutBuffer = Buffer.concat(stdoutChunks);
		const stderrBuffer = Buffer.concat(stderrChunks);
		const rawBytes = Buffer.concat([stderrBuffer, stdoutBuffer]);
		return {
			stdout: stdoutBuffer.toString("utf-8"),
			stderr: stderrBuffer.toString("utf-8"),
			status,
			rawBytes,
		};
	} finally {
		if (child.pid) untrackDetachedChildPid(child.pid);
		if (timeoutHandle) clearTimeout(timeoutHandle);
		if (options?.signal) options.signal.removeEventListener("abort", killChild);
	}
}

export function classifyGitCommand(
	command: string,
	parentEnv?: NodeJS.ProcessEnv,
): {
	eligible: boolean;
	subcommand?: string;
	globalOptions?: string[];
	subcommandArgs?: string[];
	localEnv?: Record<string, string>;
} {
	if (isComplexShellCommand(command)) return { eligible: false };

	const parsed = parseCommandPrefixes(command);
	if (!parsed || parsed.coreCommandTokens.length === 0) return { eligible: false };

	const { envVars, coreCommandTokens } = parsed;
	const toolFilterDisabled =
		process.env.PI_TOOL_FILTER_DISABLED === "1" ||
		parentEnv?.PI_TOOL_FILTER_DISABLED === "1" ||
		envVars.PI_TOOL_FILTER_DISABLED === "1";
	const gitFilterDisabled =
		process.env.PI_GIT_FILTER_DISABLED === "1" ||
		parentEnv?.PI_GIT_FILTER_DISABLED === "1" ||
		envVars.PI_GIT_FILTER_DISABLED === "1";
	if (toolFilterDisabled || gitFilterDisabled) return { eligible: false };

	const envKeys = Object.keys(envVars).filter(
		(key) => key !== "PI_TOOL_FILTER_DISABLED" && key !== "PI_GIT_FILTER_DISABLED",
	);
	if (envKeys.length > 0) return { eligible: false };

	const cmdName = coreCommandTokens[0];
	if (cmdName !== "git" && cmdName !== "yadm") return { eligible: false };

	let idx = 1;
	const globalOptions: string[] = [];
	while (idx < coreCommandTokens.length) {
		const token = coreCommandTokens[idx];
		if (token === "-C" || token === "-c" || token === "--git-dir" || token === "--work-tree") {
			if (idx + 1 >= coreCommandTokens.length) return { eligible: false };
			globalOptions.push(token, coreCommandTokens[idx + 1]);
			idx += 2;
		} else if (token.startsWith("--git-dir=") || token.startsWith("--work-tree=")) {
			globalOptions.push(token);
			idx++;
		} else if (
			token === "--no-pager" ||
			token === "--no-optional-locks" ||
			token === "--bare" ||
			token === "--literal-pathspecs"
		) {
			globalOptions.push(token);
			idx++;
		} else {
			break;
		}
	}

	if (idx === coreCommandTokens.length) return { eligible: false };
	const subcommand = coreCommandTokens[idx];
	if (!SUPPORTED_SUBCOMMANDS.has(subcommand)) return { eligible: false };

	return {
		eligible: true,
		subcommand,
		globalOptions,
		subcommandArgs: coreCommandTokens.slice(idx + 1),
		localEnv: envVars,
	};
}

export function detectGitState(gitDir: string): string[] {
	const states: string[] = [];
	if (!gitDir) return states;
	if (existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"))) {
		states.push("rebase in progress");
	}
	if (existsSync(join(gitDir, "MERGE_HEAD"))) states.push("merge in progress");
	if (existsSync(join(gitDir, "CHERRY_PICK_HEAD"))) states.push("cherry-pick in progress");
	if (existsSync(join(gitDir, "REVERT_HEAD"))) states.push("revert in progress");
	if (existsSync(join(gitDir, "BISECT_LOG"))) states.push("bisect in progress");
	if (existsSync(join(gitDir, "applying"))) states.push("am in progress");
	return states;
}

async function handleStatus(
	cwd: string,
	globalOptions: string[],
	args: string[],
	options?: GitFilterOptions,
): Promise<FilterResult> {
	const isSimple =
		args.length === 0 || args.every((arg) => arg === "-s" || arg === "--short" || arg === "-b" || arg === "--branch");

	if (!isSimple) {
		const res = await runGitQuery(cwd, globalOptions, ["status", ...args], options);
		const rawOut = rawText(res);
		if (res.status !== 0) return { output: rawOut, exitCode: res.status ?? 1, rawOut, rawBytes: res.rawBytes };
		const cleanedLines = res.stdout
			.split("\n")
			.map((line) => line.trimEnd())
			.filter((line) => line.length > 0 && !line.trim().startsWith("(use "));
		const output = cleanedLines.join("\n");
		return resultFromQuery(res, output || "success", 0);
	}

	const res = await runGitQuery(cwd, globalOptions, ["status", "--porcelain=v1", "-b"], options);
	let rawOut = rawText(res);
	if (res.status !== 0) {
		if (rawOut.includes("not a git repository")) rawOut = "fatal: not a git repository";
		return { output: rawOut.trim(), exitCode: res.status ?? 1, rawOut, rawBytes: res.rawBytes };
	}

	const lines = res.stdout.split("\n").filter((line) => line.trim().length > 0);
	let branchLine = "";
	const fileLines: string[] = [];
	for (const line of lines) {
		if (line.startsWith("##")) branchLine = line;
		else fileLines.push(line);
	}

	let statePrefix = "";
	const gitDirRes = await runGitQuery(cwd, globalOptions, ["rev-parse", "--git-dir"], options);
	if (gitDirRes.status === 0) {
		const gitDir = resolve(cwd, gitDirRes.stdout.trim());
		const states = detectGitState(gitDir);
		if (states.length > 0) statePrefix = `[${states.join(", ")}]\n`;
	}

	if (branchLine.includes("HEAD (no branch)")) {
		const headHashRes = await runGitQuery(cwd, globalOptions, ["rev-parse", "--short", "HEAD"], options);
		const hash = headHashRes.status === 0 ? headHashRes.stdout.trim() : "unknown";
		branchLine = `## HEAD (detached at ${hash})`;
	}

	if (fileLines.length === 0) {
		return resultFromQuery(res, `${statePrefix}${branchLine}\nnothing to commit, working tree clean`, 0);
	}
	return resultFromQuery(res, `${statePrefix}${branchLine}\n${fileLines.join("\n")}`, 0);
}

async function handleLog(
	cwd: string,
	globalOptions: string[],
	args: string[],
	options?: GitFilterOptions,
): Promise<FilterResult> {
	const hasLimit = args.some(
		(arg) => /^-n\d+$/.test(arg) || arg === "-n" || /^-?\d+$/.test(arg) || arg.startsWith("--max-count"),
	);
	const hasPretty = args.some(
		(arg) => arg.startsWith("--pretty") || arg.startsWith("--format") || arg === "--oneline",
	);

	if (hasLimit || hasPretty) {
		const res = await runGitQuery(cwd, globalOptions, ["log", ...args], options);
		return resultFromQuery(res, rawText(res), res.status ?? 0);
	}

	const res = await runGitQuery(cwd, globalOptions, ["log", "-n", "10", "--no-merges"], options);
	const rawOut = rawText(res);
	if (res.status !== 0) return { output: rawOut, exitCode: res.status ?? 1, rawOut, rawBytes: res.rawBytes };

	const commits = res.stdout.split(/(?=^commit [0-9a-f]{7,40})/m).filter((commit) => commit.trim().length > 0);
	const compactedCommits: string[] = [];
	const trailerPrefixes = [
		"Signed-off-by:",
		"Co-authored-by:",
		"Reported-by:",
		"Reviewed-by:",
		"Tested-by:",
		"Suggested-by:",
		"CC:",
	];

	for (const commit of commits) {
		const lines = commit.split("\n");
		const commitLine = lines[0];
		if (!commitLine) continue;
		const shortCommitLine = commitLine.replace(/^commit ([0-9a-f]{7})[0-9a-f]+/, "commit $1");
		const bodyLines: string[] = [];
		for (let i = 1; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trim();
			if (!trimmed) continue;
			if (line.startsWith("Author:") || line.startsWith("Date:") || line.startsWith("Merge:")) continue;
			if (trailerPrefixes.some((prefix) => trimmed.startsWith(prefix))) continue;
			bodyLines.push(line);
		}
		const displayBody = bodyLines.slice(0, 3).map((line) => unicodeTruncate(line, 160));
		const omitted = bodyLines.length - displayBody.length;
		if (omitted > 0) displayBody.push(`    ... (${omitted} lines omitted)`);
		compactedCommits.push(`${shortCommitLine}\n${displayBody.join("\n")}`);
	}

	return resultFromQuery(res, compactedCommits.join("\n\n"), 0);
}

export function compactDiff(diffOutput: string, maxLines = 150): { compacted: string; truncated: boolean } {
	const lines = diffOutput.split("\n");
	const output: string[] = [];
	let linesCount = 0;
	let truncated = false;
	let contextBuffer: string[] = [];
	let trailingContextRemaining = 0;

	for (const line of lines) {
		if (linesCount >= maxLines) {
			truncated = true;
			break;
		}
		if (
			line.startsWith("diff --git") ||
			line.startsWith("--- ") ||
			line.startsWith("+++ ") ||
			line.startsWith("index ")
		) {
			contextBuffer = [];
			trailingContextRemaining = 0;
			output.push(line);
			linesCount++;
			continue;
		}
		if (line.startsWith("@@ ")) {
			contextBuffer = [];
			trailingContextRemaining = 0;
			output.push(line);
			linesCount++;
			continue;
		}
		if (line.startsWith("+") || line.startsWith("-")) {
			for (const ctx of contextBuffer) {
				if (linesCount >= maxLines) {
					truncated = true;
					break;
				}
				output.push(ctx);
				linesCount++;
			}
			contextBuffer = [];
			if (truncated) break;
			output.push(line);
			linesCount++;
			trailingContextRemaining = 3;
			continue;
		}
		if (line.startsWith(" ")) {
			if (trailingContextRemaining > 0) {
				output.push(line);
				linesCount++;
				trailingContextRemaining--;
			} else {
				contextBuffer.push(line);
				if (contextBuffer.length > 3) contextBuffer.shift();
			}
		} else {
			output.push(line);
			linesCount++;
		}
	}

	return { compacted: output.join("\n"), truncated };
}

async function handleDiff(
	cwd: string,
	globalOptions: string[],
	args: string[],
	options?: GitFilterOptions,
): Promise<FilterResult> {
	const cleanArgs = [...args];
	const noCompactIndex = cleanArgs.indexOf("--no-compact");
	const optOut = noCompactIndex !== -1;
	if (optOut) cleanArgs.splice(noCompactIndex, 1);

	const statFlags = ["--stat", "--numstat", "--shortstat", "--summary", "--name-only", "--name-status", "--check"];
	const isStatOnly = cleanArgs.some((arg) => statFlags.includes(arg));
	if (optOut || isStatOnly) {
		const res = await runGitQuery(cwd, globalOptions, ["diff", ...cleanArgs], options);
		return resultFromQuery(res, rawText(res), res.status ?? 0);
	}

	const hasDoubleDash = cleanArgs.includes("--");
	if (!hasDoubleDash) {
		const pathIdx = cleanArgs.findIndex((arg) => {
			if (arg.startsWith("-")) return false;
			if (!(arg.includes("/") || arg.includes(".") || existsSync(join(cwd, arg)))) return false;
			return existsSync(resolve(cwd, arg));
		});
		if (pathIdx !== -1) cleanArgs.splice(pathIdx, 0, "--");
	}

	const statRes = await runGitQuery(cwd, globalOptions, ["diff", "--stat", ...cleanArgs], options);
	if (statRes.status !== 0) return resultFromQuery(statRes, rawText(statRes), statRes.status ?? 1);
	const diffRes = await runGitQuery(cwd, globalOptions, ["diff", ...cleanArgs], options);
	if (diffRes.status !== 0) return resultFromQuery(diffRes, rawText(diffRes), diffRes.status ?? 1);

	const { compacted, truncated } = compactDiff(diffRes.stdout);
	let output = `${statRes.stdout.trimEnd()}\n\n${compacted}`.trim();
	if (truncated) output += "\n\n[Diff truncated. Re-run with: git diff --no-compact]";
	return { output, exitCode: 0, rawOut: diffRes.stdout, rawBytes: diffRes.rawBytes };
}

async function handleShow(
	cwd: string,
	globalOptions: string[],
	args: string[],
	options?: GitFilterOptions,
): Promise<FilterResult> {
	const statFlags = ["--stat", "--numstat", "--shortstat", "--summary", "--name-only", "--name-status", "--check"];
	const hasStatOnly = args.some((arg) => statFlags.includes(arg));
	const hasPretty = args.some(
		(arg) => arg.startsWith("--pretty") || arg.startsWith("--format") || arg === "--oneline",
	);
	const hasBlob = args.some((arg) => !arg.startsWith("-") && arg.includes(":"));
	if (hasStatOnly || hasPretty || hasBlob) {
		const res = await runGitQuery(cwd, globalOptions, ["show", ...args], options);
		return resultFromQuery(res, rawText(res), res.status ?? 0);
	}

	const showRes = await runGitQuery(cwd, globalOptions, ["show", ...args], options);
	const rawOut = rawText(showRes);
	if (showRes.status !== 0)
		return { output: rawOut, exitCode: showRes.status ?? 1, rawOut, rawBytes: showRes.rawBytes };

	const lines = showRes.stdout.split("\n");
	const diffStart = lines.findIndex((line) => line.startsWith("diff --git"));
	const headerLines = diffStart === -1 ? lines : lines.slice(0, diffStart);
	const diffLines = diffStart === -1 ? [] : lines.slice(diffStart);
	const summaryLines = headerLines.filter((line) => {
		const trimmed = line.trim();
		if (!trimmed) return false;
		if (line.startsWith("Author:") || line.startsWith("Date:") || line.startsWith("Merge:")) return false;
		return true;
	});
	const shortSummary = summaryLines
		.slice(0, 4)
		.map((line) => unicodeTruncate(line.replace(/^commit ([0-9a-f]{7})[0-9a-f]+/, "commit $1"), 160));
	const { compacted, truncated } = compactDiff(diffLines.join("\n"));
	let output = shortSummary.join("\n");
	if (compacted.trim()) output += `\n\n${compacted}`;
	if (truncated) output += "\n\n[Diff truncated.]";
	return resultFromQuery(showRes, output.trim(), 0);
}

async function handlePassthroughGit(
	cwd: string,
	globalOptions: string[],
	args: string[],
	options?: GitFilterOptions,
): Promise<FilterResult> {
	const res = await runGitQuery(cwd, globalOptions, args, options);
	return resultFromQuery(res, rawText(res, true).trim(), res.status ?? 0);
}

async function handleAdd(
	cwd: string,
	globalOptions: string[],
	args: string[],
	options?: GitFilterOptions,
): Promise<FilterResult> {
	if (args.length === 0) return handlePassthroughGit(cwd, globalOptions, ["add"], options);
	const addRes = await runGitQuery(cwd, globalOptions, ["add", ...args], options);
	const rawOut = rawText(addRes);
	if (addRes.status !== 0) return { output: rawOut, exitCode: addRes.status ?? 1, rawOut, rawBytes: addRes.rawBytes };
	const statRes = await runGitQuery(cwd, globalOptions, ["diff", "--cached", "--stat"], options);
	if (statRes.status === 0 && statRes.stdout.trim().length > 0) {
		return { output: `Staged changes:\n${statRes.stdout.trim()}`, exitCode: 0, rawOut, rawBytes: addRes.rawBytes };
	}
	return { output: rawOut.trim() || "Successfully staged.", exitCode: 0, rawOut, rawBytes: addRes.rawBytes };
}

async function handleCommit(
	cwd: string,
	globalOptions: string[],
	args: string[],
	options?: GitFilterOptions,
): Promise<FilterResult> {
	const hasMsg = args.some(
		(arg) => arg === "-m" || arg === "-F" || arg.startsWith("--message") || arg.startsWith("--file"),
	);
	if (!hasMsg) return { output: "", exitCode: -100, rawOut: "" };
	const res = await runGitQuery(cwd, globalOptions, ["commit", ...args], options);
	const rawOut = rawText(res, true);
	if (res.status !== 0) return { output: rawOut, exitCode: res.status ?? 1, rawOut, rawBytes: res.rawBytes };
	if (rawOut.includes("nothing to commit") || rawOut.includes("working tree clean")) {
		return { output: "nothing to commit, working tree clean", exitCode: 0, rawOut, rawBytes: res.rawBytes };
	}
	const firstLine = rawOut
		.split("\n")
		.find((line) => line.trim().length > 0)
		?.trim();
	return { output: firstLine || "Committed successfully.", exitCode: 0, rawOut, rawBytes: res.rawBytes };
}

async function handlePush(
	cwd: string,
	globalOptions: string[],
	args: string[],
	options?: GitFilterOptions,
): Promise<FilterResult> {
	const res = await runGitQuery(cwd, globalOptions, ["push", ...args], options);
	const rawOut = rawText(res, true);
	const outputLines = rawOut
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => {
			const trimmed = line.trim();
			if (!trimmed) return false;
			return !["Writing objects:", "Counting objects:", "Delta compression", "Compressing objects:", "Total "].some(
				(prefix) => trimmed.startsWith(prefix),
			);
		});
	if (res.status !== 0)
		return { output: outputLines.join("\n"), exitCode: res.status ?? 1, rawOut, rawBytes: res.rawBytes };
	if (outputLines.some((line) => line.includes("Everything up-to-date"))) {
		return { output: "Everything up-to-date.", exitCode: 0, rawOut, rawBytes: res.rawBytes };
	}
	const remoteMessages = outputLines.filter((line) => line.trim().startsWith("remote:"));
	const pushDetail = outputLines.find((line) => line.includes("->"));
	const summary = pushDetail ? `Pushed: ${pushDetail.trim()}` : "Push successful.";
	return { output: [...remoteMessages, summary].join("\n"), exitCode: 0, rawOut, rawBytes: res.rawBytes };
}

async function handlePull(
	cwd: string,
	globalOptions: string[],
	args: string[],
	options?: GitFilterOptions,
): Promise<FilterResult> {
	const res = await runGitQuery(cwd, globalOptions, ["pull", ...args], options);
	const rawOut = rawText(res, true);
	if (res.status !== 0) return { output: rawOut, exitCode: res.status ?? 1, rawOut, rawBytes: res.rawBytes };
	if (rawOut.includes("Already up to date."))
		return { output: "Already up to date.", exitCode: 0, rawOut, rawBytes: res.rawBytes };
	const lines = rawOut.split("\n");
	const summary = lines.filter(
		(line) => line.includes("Fast-forward") || line.includes("file changed") || line.includes("files changed"),
	);
	return { output: summary.join("\n") || "Pull successful.", exitCode: 0, rawOut, rawBytes: res.rawBytes };
}

async function handleFetch(
	cwd: string,
	globalOptions: string[],
	args: string[],
	options?: GitFilterOptions,
): Promise<FilterResult> {
	const res = await runGitQuery(cwd, globalOptions, ["fetch", ...args], options);
	const rawOut = rawText(res, true);
	if (res.status !== 0) return { output: rawOut, exitCode: res.status ?? 1, rawOut, rawBytes: res.rawBytes };
	const refs = rawOut
		.split("\n")
		.filter((line) => line.includes("[new branch]") || line.includes("[new tag]") || line.includes("->"));
	return {
		output: refs.length
			? `Fetched:\n${refs.map((line) => line.trim()).join("\n")}`
			: "Fetch successful (no new refs).",
		exitCode: 0,
		rawOut,
		rawBytes: res.rawBytes,
	};
}

async function handleBranch(
	cwd: string,
	globalOptions: string[],
	args: string[],
	options?: GitFilterOptions,
): Promise<FilterResult> {
	if (args.includes("--show-current")) {
		const res = await runGitQuery(cwd, globalOptions, ["branch", "--show-current"], options);
		return { output: res.stdout.trim(), exitCode: res.status ?? 0, rawOut: rawText(res), rawBytes: res.rawBytes };
	}
	const isWrite = args.some(
		(arg) =>
			arg === "-d" || arg === "-D" || arg === "-m" || arg === "-M" || (!arg.startsWith("-") && args.length === 1),
	);
	if (isWrite) {
		const res = await runGitQuery(cwd, globalOptions, ["branch", ...args], options);
		const rawOut = rawText(res);
		if (res.status !== 0) return { output: rawOut, exitCode: res.status ?? 1, rawOut, rawBytes: res.rawBytes };
		return { output: rawOut.trim() || "Branch updated successfully.", exitCode: 0, rawOut, rawBytes: res.rawBytes };
	}
	const res = await runGitQuery(cwd, globalOptions, ["branch", "--no-color", ...args], options);
	const rawOut = rawText(res);
	if (res.status !== 0) return { output: rawOut, exitCode: res.status ?? 1, rawOut, rawBytes: res.rawBytes };
	const lines = res.stdout.split("\n").filter((line) => line.trim().length > 0);
	const remoteBranches = lines.filter((line) => line.includes("remotes/"));
	const localBranches = lines.filter((line) => !line.includes("remotes/"));
	const remoteDisplay = remoteBranches.slice(0, 5);
	const omitted = remoteBranches.length - remoteDisplay.length;
	if (omitted > 0) remoteDisplay.push(`  remotes/... (${omitted} more remote branches)`);
	return { output: [...localBranches, ...remoteDisplay].join("\n"), exitCode: 0, rawOut, rawBytes: res.rawBytes };
}

async function handleStash(
	cwd: string,
	globalOptions: string[],
	args: string[],
	options?: GitFilterOptions,
): Promise<FilterResult> {
	const sub = args[0] || "push";
	const res = await runGitQuery(cwd, globalOptions, ["stash", ...args], options);
	const rawOut = rawText(res);
	if (res.status !== 0) return { output: rawOut, exitCode: res.status ?? 1, rawOut, rawBytes: res.rawBytes };
	if (sub === "list")
		return { output: res.stdout.trim() || "No stashes found.", exitCode: 0, rawOut, rawBytes: res.rawBytes };
	if (sub === "show") {
		const { compacted, truncated } = compactDiff(res.stdout);
		return {
			output: `${compacted.trim()}${truncated ? "\n\n[Diff truncated.]" : ""}`,
			exitCode: 0,
			rawOut,
			rawBytes: res.rawBytes,
		};
	}
	if (res.stdout.includes("No local changes to save"))
		return { output: "No local changes to save.", exitCode: 0, rawOut, rawBytes: res.rawBytes };
	const firstLine = res.stdout
		.split("\n")
		.find((line) => line.trim().length > 0)
		?.trim();
	return { output: firstLine || "Stash successful.", exitCode: 0, rawOut, rawBytes: res.rawBytes };
}

async function handleWorktree(
	cwd: string,
	globalOptions: string[],
	args: string[],
	options?: GitFilterOptions,
): Promise<FilterResult> {
	const sub = args[0] || "list";
	const res = await runGitQuery(cwd, globalOptions, ["worktree", ...(sub === "list" ? ["list"] : args)], options);
	const rawOut = rawText(res, true);
	if (res.status !== 0) return { output: rawOut, exitCode: res.status ?? 1, rawOut, rawBytes: res.rawBytes };
	if (sub !== "list") return { output: rawOut.trim(), exitCode: 0, rawOut, rawBytes: res.rawBytes };
	const home = process.env.HOME || "";
	const output = res.stdout
		.split("\n")
		.map((line) => (home && line.startsWith(home) ? `~${line.slice(home.length)}` : line))
		.join("\n")
		.trim();
	return { output, exitCode: 0, rawOut, rawBytes: res.rawBytes };
}

export async function executeFilteredGit(
	cwd: string,
	subcommand: string,
	globalOptions: string[],
	subcommandArgs: string[],
	options?: GitFilterOptions,
): Promise<FilterResult> {
	switch (subcommand) {
		case "status":
			return handleStatus(cwd, globalOptions, subcommandArgs, options);
		case "log":
			return handleLog(cwd, globalOptions, subcommandArgs, options);
		case "diff":
			return handleDiff(cwd, globalOptions, subcommandArgs, options);
		case "show":
			return handleShow(cwd, globalOptions, subcommandArgs, options);
		case "add":
			return handleAdd(cwd, globalOptions, subcommandArgs, options);
		case "commit":
			return handleCommit(cwd, globalOptions, subcommandArgs, options);
		case "push":
			return handlePush(cwd, globalOptions, subcommandArgs, options);
		case "pull":
			return handlePull(cwd, globalOptions, subcommandArgs, options);
		case "branch":
			return handleBranch(cwd, globalOptions, subcommandArgs, options);
		case "fetch":
			return handleFetch(cwd, globalOptions, subcommandArgs, options);
		case "stash":
			return handleStash(cwd, globalOptions, subcommandArgs, options);
		case "worktree":
			return handleWorktree(cwd, globalOptions, subcommandArgs, options);
		default:
			return { output: "", exitCode: -100, rawOut: "" };
	}
}

export function makeGitCommandForDisplay(globalOptions: string[], subcommand: string, args: string[]): string {
	return gitCommand(globalOptions, [subcommand, ...args]);
}
