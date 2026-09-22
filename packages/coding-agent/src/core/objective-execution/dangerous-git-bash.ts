/**
 * Lane WIP git stays on `classifyDangerousGitBash`, with a quote-aware lexer.
 * Root bash uses `classifyRootGitBash` and refuses every git invocation.
 * Typed delivery and `repo_read` do not go through bash.
 */
import { isGitExecutableToken, lexShellCommand } from "./git-shell-lexer.ts";

const READ_ONLY_GIT_SUBCOMMANDS = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "blame", "grep"]);

export interface DangerousGitBashVerdict {
	readonly refused: boolean;
	readonly reason?: string;
	readonly readOnly: boolean;
}

interface GitInvocation {
	readonly subcommand: string;
	readonly rest: readonly string[];
}

const GLOBAL_VALUE = new Set(["-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix"]);

function invocationFromTokens(tokens: readonly string[]): GitInvocation | "config" | undefined {
	const gitIndex = tokens.findIndex((token) => isGitExecutableToken(token));
	if (gitIndex < 0) return undefined;
	let index = gitIndex + 1;
	while (index < tokens.length) {
		const token = tokens[index] ?? "";
		if (token === "--") {
			index += 1;
			break;
		}
		if (
			token === "-c" ||
			(token.startsWith("-c") && !token.startsWith("--")) ||
			token === "--config-env" ||
			token.startsWith("--config-env=") ||
			token === "--exec-path" ||
			token.startsWith("--exec-path=")
		) {
			return "config";
		}
		if (GLOBAL_VALUE.has(token)) {
			index += 2;
			continue;
		}
		if (
			token.startsWith("--git-dir=") ||
			token.startsWith("--work-tree=") ||
			token.startsWith("--namespace=") ||
			token.startsWith("--super-prefix=")
		) {
			index += 1;
			continue;
		}
		if (token.startsWith("-")) {
			index += 1;
			continue;
		}
		break;
	}
	return { subcommand: tokens[index] ?? "", rest: tokens.slice(index + 1) };
}

function explicitPath(token: string): boolean {
	return token.length > 0 && !token.startsWith("-") && token !== ".";
}

function shortClusterHas(token: string, flag: string): boolean {
	return token.startsWith("-") && !token.startsWith("--") && token.slice(1).includes(flag);
}

function refusalFor(invocation: GitInvocation): string | undefined {
	const { subcommand, rest } = invocation;
	if (subcommand === "add") {
		if (rest.some((token) => token === "-A" || token === "--all" || token === ".")) {
			return "git add of the whole worktree is refused; stage explicit paths";
		}
		const update = rest.some((token) => token === "-u" || token === "--update");
		if (update && !rest.some((token) => explicitPath(token))) {
			return "git add -u without explicit paths is refused";
		}
		return undefined;
	}
	if (subcommand === "commit") {
		if (rest.some((token) => token === "--no-verify" || shortClusterHas(token, "n"))) {
			return "git commit --no-verify is refused";
		}
		if (rest.some((token) => token === "--all" || token === "-a" || shortClusterHas(token, "a"))) {
			return "git commit -a is refused; commit explicit paths";
		}
		return undefined;
	}
	if (subcommand === "stash") return "git stash is refused";
	if (subcommand === "reset" && rest.some((token) => token === "--hard")) return "git reset --hard is refused";
	if (subcommand === "clean" && rest.some((token) => token === "--force" || shortClusterHas(token, "f"))) {
		return "git clean -f is refused";
	}
	if ((subcommand === "checkout" || subcommand === "restore") && rest.some((token) => token === ".")) {
		return `git ${subcommand} . is refused`;
	}
	if (subcommand === "push") return "git push is refused outside the typed delivery executor";
	return undefined;
}

function segmentIsReadOnly(tokens: readonly string[]): boolean {
	const invocation = invocationFromTokens(tokens);
	if (!invocation || invocation === "config") return false;
	if (refusalFor(invocation)) return false;
	return READ_ONLY_GIT_SUBCOMMANDS.has(invocation.subcommand);
}

/** Refuse dangerous git anywhere in the command. Read-only means every segment is read-only git. */
export function classifyDangerousGitBash(command: string): DangerousGitBashVerdict {
	const lex = lexShellCommand(command);
	if (!lex.ok) return { refused: true, reason: "shell quoting is ambiguous; git is refused", readOnly: false };
	for (const segment of lex.segments) {
		const invocation = invocationFromTokens(segment);
		if (invocation === "config") {
			return { refused: true, reason: "git config overrides are refused", readOnly: false };
		}
		if (!invocation) continue;
		const reason = refusalFor(invocation);
		if (reason) return { refused: true, reason, readOnly: false };
	}
	const readOnly = lex.segments.length > 0 && lex.segments.every((segment) => segmentIsReadOnly(segment));
	return { refused: false, readOnly };
}

const ROOT_GIT_REFUSAL =
	"root bash cannot run git; use repo_read for reads and typed delivery for commit, push, and tag";

/** Root bash admits no git invocation. Reads go through repo_read. */
export function classifyRootGitBash(command: string): DangerousGitBashVerdict {
	const lex = lexShellCommand(command);
	if (!lex.ok) {
		if (/(?:^|[\s"'/\\])git(?:\.exe)?(?=$|[\s"'/\\])/iu.test(command)) {
			return { refused: true, reason: ROOT_GIT_REFUSAL, readOnly: false };
		}
		return { refused: false, readOnly: false };
	}
	for (const segment of lex.segments) {
		if (segment.some((token) => isGitExecutableToken(token))) {
			return { refused: true, reason: ROOT_GIT_REFUSAL, readOnly: false };
		}
	}
	return { refused: false, readOnly: false };
}
