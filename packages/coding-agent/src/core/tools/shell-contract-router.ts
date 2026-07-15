export type ShellContractRoute =
	| { kind: "passthrough"; command: string }
	| { kind: "powershell"; command: string; argv: readonly string[] }
	| { kind: "unsupported"; error: string };

interface TokenizeResult {
	ok: boolean;
	argv?: string[];
	error?: string;
}

const BLOCKED_NESTED_SHELLS = new Set([
	"bash",
	"sh",
	"zsh",
	"fish",
	"cmd",
	"cmd.exe",
	"powershell",
	"powershell.exe",
	"pwsh",
	"pwsh.exe",
	"wsl",
	"wsl.exe",
]);
const UNSUPPORTED_OPERATOR_MESSAGE =
	"Unsupported Bash construct on Windows. Use one simple command per call; pipelines, redirection, command substitution, variable expansion, shell chaining, and nested shells are not translated.";

function tokenizePortableCommand(command: string): TokenizeResult {
	const argv: string[] = [];
	let token = "";
	let tokenStarted = false;
	let quote: "single" | "double" | undefined;
	let escaping = false;

	const finishToken = () => {
		if (!tokenStarted) return;
		argv.push(token);
		token = "";
		tokenStarted = false;
	};

	for (const character of command.trim()) {
		if (escaping) {
			token += character;
			tokenStarted = true;
			escaping = false;
			continue;
		}
		if (quote === "single") {
			if (character === "'") quote = undefined;
			else token += character;
			tokenStarted = true;
			continue;
		}
		if (quote === "double") {
			if (character === '"') {
				quote = undefined;
				continue;
			}
			if (character === "\\") {
				escaping = true;
				continue;
			}
			if (character === "$" || character === "`") {
				return { ok: false, error: UNSUPPORTED_OPERATOR_MESSAGE };
			}
			token += character;
			tokenStarted = true;
			continue;
		}

		if (character === "'") {
			quote = "single";
			tokenStarted = true;
			continue;
		}
		if (character === '"') {
			quote = "double";
			tokenStarted = true;
			continue;
		}
		if (character === "\\") {
			escaping = true;
			tokenStarted = true;
			continue;
		}
		if (/\s/u.test(character)) {
			finishToken();
			continue;
		}
		if ("|><&;\n\r$`()".includes(character) || character === "#") {
			return { ok: false, error: UNSUPPORTED_OPERATOR_MESSAGE };
		}
		token += character;
		tokenStarted = true;
	}

	if (escaping) return { ok: false, error: "Unsupported trailing escape in Bash-like command." };
	if (quote) return { ok: false, error: "Unclosed quote in Bash-like command." };
	finishToken();
	return argv.length > 0 ? { ok: true, argv } : { ok: false, error: "Shell command is empty." };
}

function quotePowerShell(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function powershellArray(values: readonly string[]): string {
	return `@(${values.map(quotePowerShell).join(", ")})`;
}

function externalCommand(argv: readonly string[]): string {
	const invocation = `& ${argv.map(quotePowerShell).join(" ")}`;
	return `${invocation}\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }\nif (-not $?) { exit 1 }`;
}

function parseFlags(
	argv: readonly string[],
	allowedFlags: ReadonlySet<string>,
): { flags: Set<string>; operands: string[] } | undefined {
	const flags = new Set<string>();
	const operands: string[] = [];
	let optionsEnded = false;
	for (const value of argv) {
		if (!optionsEnded && value === "--") {
			optionsEnded = true;
			continue;
		}
		if (!optionsEnded && value.startsWith("-") && value !== "-") {
			if (!allowedFlags.has(value)) return undefined;
			flags.add(value);
			continue;
		}
		operands.push(value);
	}
	return { flags, operands };
}

function routeLs(argv: readonly string[]): string | undefined {
	const parsed = parseFlags(argv.slice(1), new Set(["-a", "-A", "-l", "-1", "-la", "-al"]));
	if (!parsed || parsed.operands.length > 1) return undefined;
	const target = parsed.operands[0] ?? ".";
	return `[string[]]$items = @(Get-ChildItem -LiteralPath ${quotePowerShell(target)} -Force -ErrorAction Stop | ForEach-Object { if ($_.PSIsContainer) { $_.Name + '/' } else { $_.Name } }); [Array]::Sort($items, [StringComparer]::Ordinal); $items`;
}

function routeCat(argv: readonly string[]): string | undefined {
	const parsed = parseFlags(argv.slice(1), new Set(["--"]));
	if (!parsed || parsed.operands.length === 0) return undefined;
	return `Get-Content -LiteralPath ${powershellArray(parsed.operands)} -Raw -ErrorAction Stop`;
}

function routeHeadOrTail(argv: readonly string[], tail: boolean): string | undefined {
	let count = 10;
	let operands = argv.slice(1);
	if (operands[0] === "-n") {
		const parsedCount = Number(operands[1]);
		if (!Number.isInteger(parsedCount) || parsedCount < 0) return undefined;
		count = parsedCount;
		operands = operands.slice(2);
	}
	if (operands.length !== 1 || operands[0].startsWith("-")) return undefined;
	return `Get-Content -LiteralPath ${quotePowerShell(operands[0])} ${tail ? "-Tail" : "-TotalCount"} ${count} -ErrorAction Stop`;
}

function routeGrep(argv: readonly string[]): string | undefined {
	if (argv.length !== 3 || argv[1].startsWith("-") || argv[2].startsWith("-")) return undefined;
	return `Select-String -LiteralPath ${quotePowerShell(argv[2])} -SimpleMatch -Pattern ${quotePowerShell(argv[1])} -ErrorAction Stop | ForEach-Object { $_.Line }`;
}

function routeFind(argv: readonly string[]): string | undefined {
	let searchPath = ".";
	let type: "File" | "Directory" | undefined;
	let filter: string | undefined;
	let index = 1;
	if (argv[index] && !argv[index].startsWith("-")) searchPath = argv[index++];
	while (index < argv.length) {
		const option = argv[index++];
		if (option === "-type" && (argv[index] === "f" || argv[index] === "d")) {
			type = argv[index++] === "f" ? "File" : "Directory";
			continue;
		}
		if (option === "-name" && argv[index]) {
			filter = argv[index++];
			continue;
		}
		return undefined;
	}
	const typeFlag = type ? ` -${type}` : "";
	const filterFlag = filter ? ` -Filter ${quotePowerShell(filter)}` : "";
	return `[string[]]$paths = @(Get-ChildItem -LiteralPath ${quotePowerShell(searchPath)} -Recurse -Force${typeFlag}${filterFlag} -ErrorAction Stop | ForEach-Object { $_.FullName.Replace('\\', '/') }); [Array]::Sort($paths, [StringComparer]::Ordinal); $paths`;
}

function routeRemove(argv: readonly string[]): string | undefined {
	const parsed = parseFlags(argv.slice(1), new Set(["-f", "-r", "-rf", "-fr"]));
	if (!parsed || parsed.operands.length === 0) return undefined;
	const recursive = [...parsed.flags].some((flag) => flag.includes("r"));
	return `Remove-Item -LiteralPath ${powershellArray(parsed.operands)} -Force${recursive ? " -Recurse" : ""} -ErrorAction Stop`;
}

function routeCopyOrMove(argv: readonly string[], move: boolean): string | undefined {
	const parsed = parseFlags(argv.slice(1), move ? new Set<string>() : new Set(["-r", "-R"]));
	if (!parsed || parsed.operands.length !== 2) return undefined;
	const [source, destination] = parsed.operands;
	const recurse = !move && parsed.flags.size > 0 ? " -Recurse" : "";
	return `${move ? "Move-Item" : "Copy-Item"} -LiteralPath ${quotePowerShell(source)} -Destination ${quotePowerShell(destination)}${recurse} -ErrorAction Stop`;
}

function routeMkdir(argv: readonly string[]): string | undefined {
	const parsed = parseFlags(argv.slice(1), new Set(["-p"]));
	if (!parsed || parsed.operands.length === 0) return undefined;
	return `${powershellArray(parsed.operands)} | ForEach-Object { New-Item -ItemType Directory -Path $_ -Force -ErrorAction Stop | Out-Null }`;
}

function routeTouch(argv: readonly string[]): string | undefined {
	const parsed = parseFlags(argv.slice(1), new Set());
	if (!parsed || parsed.operands.length === 0) return undefined;
	return `${powershellArray(parsed.operands)} | ForEach-Object { if (Test-Path -LiteralPath $_) { (Get-Item -LiteralPath $_ -ErrorAction Stop).LastWriteTime = Get-Date } else { New-Item -ItemType File -Path $_ -ErrorAction Stop | Out-Null } }`;
}

function routeBuiltIn(argv: readonly string[]): string | undefined {
	const command = argv[0].toLowerCase();
	if (command === "pwd" && argv.length === 1) return "(Get-Location).Path";
	if (command === "echo") return `[Console]::Out.WriteLine((${powershellArray(argv.slice(1))} -join ' '))`;
	if (command === "true" && argv.length === 1) return "exit 0";
	if (command === "false" && argv.length === 1) return "exit 1";
	if (command === "which" && argv.length === 2) {
		return `(Get-Command -Name ${quotePowerShell(argv[1])} -CommandType Application -ErrorAction Stop).Source`;
	}
	if (command === "ls") return routeLs(argv);
	if (command === "cat") return routeCat(argv);
	if (command === "head") return routeHeadOrTail(argv, false);
	if (command === "tail") return routeHeadOrTail(argv, true);
	if (command === "grep") return routeGrep(argv);
	if (command === "find") return routeFind(argv);
	if (command === "rm") return routeRemove(argv);
	if (command === "cp") return routeCopyOrMove(argv, false);
	if (command === "mv") return routeCopyOrMove(argv, true);
	if (command === "mkdir") return routeMkdir(argv);
	if (command === "touch") return routeTouch(argv);
	return undefined;
}

const ROUTED_BUILTIN_NAMES = new Set([
	"pwd",
	"echo",
	"true",
	"false",
	"which",
	"ls",
	"cat",
	"head",
	"tail",
	"grep",
	"find",
	"rm",
	"cp",
	"mv",
	"mkdir",
	"touch",
]);

export function routeShellContract(command: string, platform: NodeJS.Platform = process.platform): ShellContractRoute {
	if (platform !== "win32") return { kind: "passthrough", command };
	const tokenized = tokenizePortableCommand(command);
	if (!tokenized.ok || !tokenized.argv)
		return { kind: "unsupported", error: tokenized.error ?? UNSUPPORTED_OPERATOR_MESSAGE };
	const argv = tokenized.argv;
	const commandName = argv[0].toLowerCase();
	if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(argv[0])) {
		return {
			kind: "unsupported",
			error: "Inline environment assignments are not supported. Configure the environment outside the shell command.",
		};
	}
	if (BLOCKED_NESTED_SHELLS.has(commandName)) {
		return {
			kind: "unsupported",
			error: "Nested shell execution is not supported by the Windows shell contract router.",
		};
	}
	const builtIn = routeBuiltIn(argv);
	if (builtIn) return { kind: "powershell", command: builtIn, argv };
	if (ROUTED_BUILTIN_NAMES.has(commandName)) {
		return {
			kind: "unsupported",
			error: `Unsupported ${argv[0]} form on Windows. Use a simpler Bash-like form or Pi's dedicated read/search/edit tools.`,
		};
	}
	if (commandName.endsWith(".sh") || commandName.includes("/bin/")) {
		return {
			kind: "unsupported",
			error: "POSIX shell scripts are not supported by the Windows shell contract router.",
		};
	}
	return { kind: "powershell", command: externalCommand(argv), argv };
}
