import { createHash } from "node:crypto";
import { tokenizeShellCommand } from "./shell-command-parser.ts";

const DIRECT_TEST_RUNNERS = new Set([
	"ava",
	"bats",
	"jest",
	"mocha",
	"node-tap",
	"playwright",
	"pytest",
	"tap",
	"vitest",
]);

const EXECUTABLE_EXTENSIONS_RE = /\.(?:bat|cmd|exe)$/iu;
const TEST_SCRIPT_EXTENSIONS_RE = /\.(?:bat|cjs|cmd|js|mjs|ps1|py|sh|ts)$/iu;
const TEST_NAME_SEGMENT_RE = /(?:^|[.\-_:])(?:tests?|coverage|verify|verification)(?:[.\-_:]|$)/iu;
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/u;

function executableName(token: string): string {
	return (token.replace(/\\/gu, "/").split("/").at(-1) ?? token).toLowerCase();
}

function executableStem(token: string): string {
	return executableName(token).replace(EXECUTABLE_EXTENSIONS_RE, "");
}

function isNamedTestScript(token: string): boolean {
	const name = executableName(token);
	if (!TEST_SCRIPT_EXTENSIONS_RE.test(name)) return false;
	return TEST_NAME_SEGMENT_RE.test(name.replace(TEST_SCRIPT_EXTENSIONS_RE, ""));
}

function firstNonOption(tokens: string[], start: number): string | undefined {
	for (let index = start; index < tokens.length; index++) {
		if (!tokens[index].startsWith("-")) return tokens[index];
	}
	return undefined;
}

function isRunnerToken(token: string | undefined): boolean {
	if (!token) return false;
	const stem = executableStem(token);
	return DIRECT_TEST_RUNNERS.has(stem) || /(?:^|[\\/])node_modules[\\/].*(?:vitest|jest|mocha)/iu.test(token);
}

function isTestScriptName(token: string | undefined): boolean {
	if (!token) return false;
	return TEST_NAME_SEGMENT_RE.test(token.toLowerCase());
}

function isTestInvocation(args: string[], allowCheckScript = false): boolean {
	if (args.length === 0) return false;
	const executable = executableStem(args[0]);
	if (executable === "test" || executable === "[") return false;
	if (isNamedTestScript(args[0])) return true;
	if (DIRECT_TEST_RUNNERS.has(executable)) return true;

	if (executable === "node") {
		if (args.slice(1).some((token) => token === "--test" || token.startsWith("--test="))) return true;
		return isRunnerToken(firstNonOption(args, 1)) || isNamedTestScript(firstNonOption(args, 1) ?? "");
	}
	if (executable === "python" || executable === "python3" || executable === "py") {
		const moduleIndex = args.indexOf("-m");
		if (moduleIndex !== -1 && isRunnerToken(args[moduleIndex + 1])) return true;
		return isNamedTestScript(firstNonOption(args, 1) ?? "");
	}
	if (executable === "npx" || executable === "pnpx" || executable === "bunx") {
		return isRunnerToken(firstNonOption(args, 1));
	}
	if (executable === "npm") {
		const action = args[1]?.toLowerCase();
		if (action === "test" || action === "t" || action === "tst") return true;
		if (action === "run" || action === "run-script") {
			return isTestScriptName(args[2]) || (allowCheckScript && args[2]?.toLowerCase() === "check");
		}
		if (action === "exec") return isRunnerToken(firstNonOption(args, 2));
		return false;
	}
	if (executable === "pnpm" || executable === "yarn" || executable === "bun") {
		const action = args[1]?.toLowerCase();
		if (action === "test") return true;
		if (action === "run") return isTestScriptName(args[2]);
		if (action === "exec" || action === "dlx") return isRunnerToken(firstNonOption(args, 2));
		if (isRunnerToken(action)) return true;
		return false;
	}
	if (executable === "deno") return args[1]?.toLowerCase() === "test";
	if (executable === "uv" || executable === "poetry" || executable === "pipenv") {
		return args[1]?.toLowerCase() === "run" && isRunnerToken(firstNonOption(args, 2));
	}
	if (executable === "make" || executable === "just") return isTestScriptName(args[1]);
	if (executable === "cargo" || executable === "go" || executable === "dotnet") {
		return args[1]?.toLowerCase() === "test" || (executable === "dotnet" && args[1]?.toLowerCase() === "vstest");
	}
	if (executable === "mvn" || executable === "mvnw" || executable === "gradle" || executable === "gradlew") {
		return args.slice(1).some((token) => token.toLowerCase() === "test");
	}
	return false;
}

function commandArguments(command: string): string[] | undefined {
	const tokens = tokenizeShellCommand(command);
	if (!tokens || tokens.some((token) => token.kind === "operator" || token.kind === "pipe")) return undefined;

	const args: string[] = [];
	for (const token of tokens) {
		if (token.kind === "redirect") break;
		if (token.kind === "arg") args.push(token.value);
	}

	let start = 0;
	if (executableStem(args[start] ?? "") === "env") start++;
	while (start < args.length && ENV_ASSIGNMENT_RE.test(args[start])) start++;
	return args.slice(start);
}

/** Conservatively identifies commands whose stdout is owned by a test runner. */
export function isProjectableTestCommand(command: string): boolean {
	const args = commandArguments(command);
	return args !== undefined && isTestInvocation(args);
}

export interface ShellVerificationCommand {
	kind: "test";
	/** Stable, bounded identifier of one exact command in one working directory. */
	id: string;
}

interface ShellCommandSequence {
	invocations: string[][];
	connectors: string[];
}

function parseShellCommandSequence(command: string): ShellCommandSequence | undefined {
	const tokens = tokenizeShellCommand(command);
	if (!tokens) return undefined;
	const invocations: string[][] = [];
	const connectors: string[] = [];
	let invocation: string[] = [];
	for (const token of tokens) {
		if (token.kind === "redirect") return undefined;
		if (token.kind === "arg") {
			invocation.push(token.value);
			continue;
		}
		if (invocation.length === 0) return undefined;
		invocations.push(invocation);
		connectors.push(token.value);
		invocation = [];
	}
	if (invocation.length === 0) return undefined;
	invocations.push(invocation);
	return { invocations, connectors };
}

function isChangeDirectoryInvocation(args: string[]): boolean {
	return args[0] === "cd" && args.length === 2 && args[1].length > 0;
}

function isPipefailSetup(args: string[]): boolean {
	return args.length === 3 && args[0] === "set" && args[1] === "-o" && args[2] === "pipefail";
}

function isTeeInvocation(args: string[]): boolean {
	return executableStem(args[0] ?? "") === "tee";
}

function hasOnlyVerificationStages(sequence: ShellCommandSequence): boolean {
	let index = 0;
	if (isChangeDirectoryInvocation(sequence.invocations[index] ?? [])) {
		if (sequence.connectors[index] !== "&&") return false;
		index++;
	}

	let hasPipefail = false;
	if (isPipefailSetup(sequence.invocations[index] ?? [])) {
		const connector = sequence.connectors[index];
		if (connector !== ";" && connector !== "&&") return false;
		hasPipefail = true;
		index++;
	}

	for (; index < sequence.invocations.length; index++) {
		if (!isTestInvocation(sequence.invocations[index] ?? [], true)) return false;
		const connector = sequence.connectors[index];
		if (connector === undefined) return true;
		if (connector === "&&") continue;
		if (connector === "|" && hasPipefail && isTeeInvocation(sequence.invocations[index + 1] ?? [])) {
			const teeIndex = index + 1;
			const afterTee = sequence.connectors[teeIndex];
			if (afterTee === undefined) return true;
			if (afterTee !== "&&") return false;
			index = teeIndex;
			continue;
		}
		return false;
	}
	return false;
}

/**
 * Recognizes only shell shapes whose outcome proves every identified verification stage passed.
 * Arbitrary compounds remain opaque; an explicit pipefail test-to-tee pipeline is the sole output
 * pipeline admitted because its exit status remains the test's status before a following && stage.
 */
export function classifyShellVerificationCommand(command: string, cwd: string): ShellVerificationCommand | undefined {
	const sequence = parseShellCommandSequence(command);
	if (!sequence || !hasOnlyVerificationStages(sequence)) return undefined;

	return {
		kind: "test",
		id: `shell-test-${createHash("sha256").update(cwd).update("\0").update(command).digest("base64url")}`,
	};
}
