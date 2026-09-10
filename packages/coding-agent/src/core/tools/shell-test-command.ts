import { createHash } from "node:crypto";
import {
	assertExecutionAbsolutePath,
	type ExecutionPathFlavor,
	executionPathApi,
	resolveExecutionPath,
} from "@caupulican/pi-agent-core/paths";
import {
	isChangeDirectoryInvocation,
	parseShellCommandSequence,
	type ShellCommandSequence,
	tokenizeShellCommand,
} from "./shell-command-parser.ts";
import type { VerificationRunner } from "./test-verification-output.ts";

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
	/** Every stage has an explicit evidence strategy; opaque commands remain distinct from witnessed tests. */
	runners: VerificationRunner[];
	/** Stable, bounded identity of the verification argv, stages, and execution location. */
	id: string;
	/** Equivalent literal stages within a host-specified workspace; only setup failures may use it. */
	repairGroup?: string;
	/** Expected execution directory when the command can be canonicalized without shell evaluation. */
	cwd?: string;
	/** The verification as a person would read it (stages joined by their connectors), bounded. */
	display: string;
}

const MAX_DISPLAY_LENGTH = 200;

function displayCommand(sequence: ShellCommandSequence): string {
	const parts: string[] = [];
	sequence.invocations.forEach((invocation, index) => {
		if (index > 0) parts.push(sequence.connectors[index - 1] ?? "&&");
		parts.push(invocation.join(" "));
	});
	const text = parts.join(" ").replace(/\s+/g, " ").trim();
	return text.length <= MAX_DISPLAY_LENGTH ? text : `${text.slice(0, MAX_DISPLAY_LENGTH - 1)}…`;
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

	// Every path out of this loop is a return: past the last stage `invocations[index]` is undefined,
	// which is not a test invocation, so the trailing stage decides and no statement follows the loop.
	for (; ; index++) {
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
}

/**
 * Recognizes only shell shapes whose outcome proves every identified verification stage passed.
 * Arbitrary compounds remain opaque; an explicit pipefail test-to-tee pipeline is the sole output
 * pipeline admitted because its exit status remains the test's status before a following && stage.
 */
export function classifyShellVerificationCommand(
	command: string,
	context: { cwd: string; workspaceRoot?: string; flavor: ExecutionPathFlavor },
): ShellVerificationCommand | undefined {
	const sequence = parseShellCommandSequence(command);
	if (!sequence || !hasOnlyVerificationStages(sequence)) return undefined;
	const { cwd: initialCwd, workspaceRoot, flavor } = context;
	try {
		assertExecutionAbsolutePath(initialCwd, flavor);
		if (workspaceRoot !== undefined) assertExecutionAbsolutePath(workspaceRoot, flavor);
	} catch {
		return undefined;
	}
	// The parser does not evaluate expansions or every shell escape. Preserve exact source for
	// those shapes rather than allowing a quote/escape change to certify a different operation.
	let identity: unknown = { version: 2, cwd: initialCwd, source: command };
	let executionCwd: string | undefined;
	let repairGroup: string | undefined;
	const paths = executionPathApi(flavor);
	const leadingCd = isChangeDirectoryInvocation(sequence.invocations[0]) ? sequence.invocations[0][1] : undefined;
	if (
		paths.isAbsolute(initialCwd) &&
		!/[\\$`~{}()*?[\]#!]/u.test(command) &&
		!/[^\S \t\r\n]/u.test(command) &&
		(leadingCd === undefined ||
			(!leadingCd.startsWith("-") &&
				!leadingCd.startsWith("//") &&
				!(flavor === "win32" && /^[A-Za-z]:(?![\\/])/u.test(leadingCd))))
	) {
		executionCwd = leadingCd === undefined ? initialCwd : resolveExecutionPath(leadingCd, initialCwd, flavor);
		const stages = {
			invocations: leadingCd === undefined ? sequence.invocations : sequence.invocations.slice(1),
			connectors: leadingCd === undefined ? sequence.connectors : sequence.connectors.slice(1),
		};
		identity = {
			version: 2,
			cwd: executionCwd,
			...stages,
		};
		if (workspaceRoot !== undefined && paths.isAbsolute(workspaceRoot)) {
			const relative = paths.relative(workspaceRoot, executionCwd);
			if (relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative)) {
				repairGroup = `shell-repair-${createHash("sha256")
					.update(JSON.stringify({ version: 1, workspace: paths.normalize(workspaceRoot), ...stages }))
					.digest("base64url")}`;
			}
		}
	}
	return {
		kind: "test",
		runners: sequence.invocations
			.filter((args) => isTestInvocation(args, true))
			.map((args): VerificationRunner => {
				const executable = executableStem(args[0] ?? "");
				if (executable === "node" && args.slice(1).some((arg) => arg === "--test" || arg.startsWith("--test=")))
					return "node-test";
				if (executable === "vitest") return "vitest";
				if (["npx", "pnpx", "bunx"].includes(executable))
					return executableStem(firstNonOption(args, 1) ?? "") === "vitest" ? "vitest" : "command";
				if (executable === "npm" && args[1] === "exec")
					return firstNonOption(args, 2) === "vitest" ? "vitest" : "command";
				if (["pnpm", "yarn", "bun"].includes(executable)) {
					return (args[1] === "exec" || args[1] === "dlx" ? firstNonOption(args, 2) : args[1]) === "vitest"
						? "vitest"
						: "command";
				}
				return executable === "node" &&
					/(?:^|[\\/])node_modules[\\/]vitest[\\/]/u.test(firstNonOption(args, 1) ?? "")
					? "vitest"
					: "command";
			}),
		cwd: executionCwd,
		...(repairGroup !== undefined ? { repairGroup } : {}),
		id: `shell-test-${createHash("sha256").update(JSON.stringify(identity)).digest("base64url")}`,
		display: displayCommand(sequence),
	};
}
