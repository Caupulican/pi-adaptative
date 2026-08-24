import { delimiter, dirname, isAbsolute } from "node:path";
import type { ManagedToolResolver } from "../../utils/tools-manager.ts";
import { resolveManagedSearchTool } from "./managed-search-tool.ts";
import { parseShellInvocationPrefixes, type ShellToken, tokenizeShellCommand } from "./shell-command-parser.ts";

function executableName(value: string): string {
	return (
		value
			.split(/[\\/]/u)
			.at(-1)
			?.replace(/\.exe$/iu, "")
			.toLowerCase() ?? ""
	);
}

function findSegmentExecutable(tokens: ShellToken[]): string | undefined {
	const args: string[] = [];
	let skipRedirectTarget = false;
	for (const token of tokens) {
		if (token.kind === "redirect") {
			skipRedirectTarget = !token.value.endsWith("&1") && !token.value.endsWith("&2");
			continue;
		}
		if (token.kind !== "arg") continue;
		if (skipRedirectTarget) {
			skipRedirectTarget = false;
			continue;
		}
		args.push(token.value);
	}
	const invocation = parseShellInvocationPrefixes(args);
	if (invocation.nonExecutingQuery) return undefined;
	const candidate = invocation.args[0];
	if (!candidate || candidate.includes("/") || candidate.includes("\\")) return undefined;
	return executableName(candidate);
}

function segments(tokens: ShellToken[]): ShellToken[][] {
	const result: ShellToken[][] = [];
	let current: ShellToken[] = [];
	for (const token of tokens) {
		if (token.kind === "operator" || token.kind === "pipe") {
			if (current.length > 0) result.push(current);
			current = [];
			continue;
		}
		current.push(token);
	}
	if (current.length > 0) result.push(current);
	return result;
}

/** Whether a Bash-like command contains an executable rg/ripgrep invocation. */
export function shellCommandRequiresManagedRipgrep(command: string): boolean {
	const tokens = tokenizeShellCommand(command);
	return (
		tokens !== null &&
		segments(tokens).some((segment) => {
			const executable = findSegmentExecutable(segment);
			return executable === "rg" || executable === "ripgrep";
		})
	);
}

/** Prepare the environment for one local shell operation without mutating its caller-owned map. */
export async function prepareManagedShellEnvironment(
	command: string,
	environment: NodeJS.ProcessEnv,
	resolver?: ManagedToolResolver,
): Promise<NodeJS.ProcessEnv> {
	if (!shellCommandRequiresManagedRipgrep(command)) return environment;
	const resolvedPath = await resolveManagedSearchTool("rg", resolver);
	if (!isAbsolute(resolvedPath)) return environment;
	const resolvedDirectory = dirname(resolvedPath);
	const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const existingPath = environment[pathKey];
	const pathEntries = existingPath?.split(delimiter) ?? [];
	if (!pathEntries.includes(resolvedDirectory)) pathEntries.unshift(resolvedDirectory);
	return { ...environment, [pathKey]: pathEntries.join(delimiter) };
}
