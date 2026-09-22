/**
 * Deterministic refusal of model-issued git that can sweep or rewrite the worktree.
 * This is not a shell parser. Lane sessions still refuse compound syntax outright.
 * Root bash scans each segment so `npm test && npm run lint` still runs, while
 * `npm test && git add -A` does not.
 * The typed delivery executor does not go through bash, so it is not classified here.
 */

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

function shellSegments(command: string): string[] {
	return command
		.split(/&&|\|\||[;&|\n\r]/u)
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0);
}

function tokensOf(segment: string): string[] {
	return segment.split(/\s+/u).filter((token) => token.length > 0);
}

function gitInvocation(segment: string): GitInvocation | undefined {
	const tokens = tokensOf(segment);
	let start = 0;
	while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[start] ?? "")) start += 1;
	if (tokens[start] !== "git") return undefined;
	let index = start + 1;
	while (index < tokens.length) {
		const token = tokens[index] ?? "";
		if (token === "-C" || token === "--git-dir" || token === "--work-tree") {
			index += 2;
			continue;
		}
		if (
			(token.startsWith("-C") && token !== "-C") ||
			token.startsWith("--git-dir=") ||
			token.startsWith("--work-tree=")
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

function segmentReadOnly(segment: string): boolean {
	if (/[<>]/u.test(segment)) return false;
	if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokensOf(segment)[0] ?? "")) return false;
	const invocation = gitInvocation(segment);
	if (!invocation || refusalFor(invocation)) return false;
	return READ_ONLY_GIT_SUBCOMMANDS.has(invocation.subcommand);
}

/** Refuse dangerous git anywhere in the command. Read-only means every segment is read-only git. */
export function classifyDangerousGitBash(command: string): DangerousGitBashVerdict {
	const segments = shellSegments(command);
	for (const segment of segments) {
		const invocation = gitInvocation(segment);
		if (!invocation) continue;
		const reason = refusalFor(invocation);
		if (reason) return { refused: true, reason, readOnly: false };
	}
	const readOnly = segments.length > 0 && segments.every((segment) => segmentReadOnly(segment));
	return { refused: false, readOnly };
}
