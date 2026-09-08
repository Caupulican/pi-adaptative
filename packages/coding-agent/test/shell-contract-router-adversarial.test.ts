import { describe, expect, it } from "vitest";
import { routeShellContract, type ShellContractRoute } from "../src/core/tools/shell-contract-router.ts";

// Mirrors the private message text in shell-contract-router.ts exactly so unsupported routes can be
// asserted on their full error text instead of a loose shape match.
const UNSUPPORTED_OPERATOR_MESSAGE =
	"Unsupported Bash construct on Windows. Use one simple command per call; pipelines, redirection, command substitution, variable expansion, shell chaining, and nested shells are not translated.";
const COMMAND_LIST_MESSAGE =
	"Multi-line command lists require the Windows Python shell engine. The PowerShell floor runs one simple command per call; a line break is a command separator, never argument whitespace.";

function expectPowershell(
	route: ShellContractRoute,
	argv: readonly string[],
): asserts route is Extract<ShellContractRoute, { kind: "powershell" }> {
	expect(route).toMatchObject({ kind: "powershell", argv });
	if (route.kind !== "powershell") throw new Error(`Expected PowerShell route, got ${route.kind}`);
}

/** Asserts the floor fails closed with the exact error text and the engine tier accepts the same raw command. */
function expectUnsupportedPair(command: string, error: string) {
	const floor = routeShellContract(command, "win32", { pythonEngine: false });
	expect(floor).toMatchObject({ kind: "unsupported" });
	if (floor.kind !== "unsupported") throw new Error("Expected unsupported floor route");
	expect(floor.error).toBe(error);
	expect(routeShellContract(command, "win32", { pythonEngine: true })).toEqual({ kind: "python-engine", command });
}

/** Asserts a nested-shell refusal (floor) vs. external-process hand-off (engine), both real behaviors of §BLOCKED_NESTED_SHELLS. */
function expectNestedShellPair(command: string, errorContains: string) {
	const floor = routeShellContract(command, "win32", { pythonEngine: false });
	expect(floor).toMatchObject({ kind: "unsupported" });
	if (floor.kind !== "unsupported") throw new Error("Expected unsupported floor route");
	expect(floor.error).toContain(errorContains);
	expect(routeShellContract(command, "win32", { pythonEngine: true })).toEqual({ kind: "python-engine", command });
}

describe("shell contract router adversarial coverage (real Windows-session command shapes)", () => {
	it("fails closed on a trailing pipeline even though the pipe pattern itself is quoted", () => {
		const command = `rg -n "a|b" "D:/Repo/src" --glob '!**/x/**' | head -60`;
		expectUnsupportedPair(command, UNSUPPORTED_OPERATOR_MESSAGE);
	});

	it("routes a git invocation with a parenthesized path and an embedded format string to PowerShell", () => {
		const route = routeShellContract(`git -C 'D:/(Repo 7 v7' log -3 --format='=== %h %s%n%b' a^..b`, "win32");
		expectPowershell(route, ["git", "-C", "D:/(Repo 7 v7", "log", "-3", "--format==== %h %s%n%b", "a^..b"]);
	});

	it("fails closed on a && chain even when the first segment quotes its path", () => {
		expectUnsupportedPair(`cd "D:/Repo" && git status --short`, UNSUPPORTED_OPERATOR_MESSAGE);
	});

	it("fails closed on a && chain between two ls invocations", () => {
		expectUnsupportedPair(`ls -la D:/Repo && ls -la "D:/Repo/logs/build/2026"`, UNSUPPORTED_OPERATOR_MESSAGE);
	});

	it("routes printf, an engine-only builtin, to the engine and refuses it on the bare floor", () => {
		expectUnsupportedPair(
			String.raw`printf '%s\n' a b c`,
			"The Bash-like 'printf' builtin requires the Windows Python shell engine. Enable windowsShell.pythonEngine to use it portably.",
		);
	});

	it("routes a single-quoted .cmd script invocation to PowerShell verbatim", () => {
		const route = routeShellContract(`'d:/scripts/hb/hbdev.cmd' build --verbose`, "win32");
		expectPowershell(route, ["d:/scripts/hb/hbdev.cmd", "build", "--verbose"]);
	});

	it("routes a real git.exe under a Windows .../bin/ directory as an ordinary external, never a POSIX script", () => {
		// A quoted, absolute Windows path to git.exe is a completely ordinary external-command
		// invocation. The floor's POSIX-script heuristic (meant to catch `/usr/bin/env`, `/bin/sh`)
		// once matched any Windows install that keeps its executable under a "bin" folder — Git for
		// Windows, Python's Scripts/bin layout, most JVM tools; it now applies to POSIX-rooted paths only.
		const route = routeShellContract(`"C:/Program Files/Git/bin/git.exe" status`, "win32", { pythonEngine: false });
		expectPowershell(route, ["C:/Program Files/Git/bin/git.exe", "status"]);
	});

	it("splits an unquoted drive-root path with a space exactly like real Bash would (model-quoting trap, not a router bug)", () => {
		// This mirrors real Bash word-splitting: an unquoted space always separates argv entries. The
		// router applying the same rule here is correct; the trap is a model emitting an unquoted
		// Windows path. Documented so a future "fix" doesn't special-case this and mask real drift.
		const route = routeShellContract(`/c/Program Files/x/tool.exe arg`, "win32");
		expectPowershell(route, ["C:/Program", "Files/x/tool.exe", "arg"]);
	});

	it("keeps a quoted drive-root path with a space intact, contrasting with the unquoted split above", () => {
		const route = routeShellContract(`"/c/Program Files/x/tool.exe" arg`, "win32");
		expectPowershell(route, ["C:/Program Files/x/tool.exe", "arg"]);
	});

	it("translates a WSL /mnt/d root to a Windows drive for a bare executable invocation", () => {
		const route = routeShellContract(`/mnt/d/repo/tool.exe`, "win32");
		expectPowershell(route, ["D:/repo/tool.exe"]);
	});

	it("refuses `cmd /c dir` as a nested shell on the floor and hands it to the engine when enabled", () => {
		expectNestedShellPair(
			String.raw`cmd /c dir /b D:\Repo`,
			"Nested shell execution is not supported by the Windows shell contract router.",
		);
	});

	it("refuses cmd.exe with a quoted wmic payload as a nested shell", () => {
		expectNestedShellPair(
			String.raw`cmd.exe /d /c "wmic /namespace:\\root path __namespace get name"`,
			"Nested shell execution is not supported by the Windows shell contract router.",
		);
	});

	it("refuses powershell.exe -File and teaches direct .ps1 invocation instead", () => {
		const command = "powershell.exe -NoProfile -File D:/x.ps1";
		const floor = routeShellContract(command, "win32", { pythonEngine: false });
		expect(floor).toMatchObject({ kind: "unsupported" });
		if (floor.kind !== "unsupported") throw new Error("Expected unsupported floor route");
		expect(floor.error).toBe(
			"Nested shell execution is not supported by the Windows shell contract router. Invoke the .ps1 path directly with its arguments, without powershell.exe -File or pwsh -File.",
		);
		expect(routeShellContract(command, "win32", { pythonEngine: true })).toEqual({ kind: "python-engine", command });
	});

	it("fails closed on an inline env assignment followed by an external command", () => {
		expectUnsupportedPair(
			"PI_ENV_TRAP=D:/x git status",
			"Inline environment assignments are not supported. Configure the environment outside the shell command.",
		);
	});

	it("fails closed on a semicolon-separated assignment/command/redirection chain at the first semicolon", () => {
		expectUnsupportedPair(`OUT='D:/Temp/r'; mkdir -p "$OUT"; git log > "$OUT/log.txt"`, UNSUPPORTED_OPERATOR_MESSAGE);
	});

	it("rejects find with an unsupported flag form (-maxdepth) instead of guessing a translation", () => {
		expectUnsupportedPair(
			`find 'D:/x' -maxdepth 2 -type f -print`,
			"Unsupported find form on Windows. Use a simpler Bash-like form or Pi's dedicated read/search/edit tools.",
		);
	});

	it("routes a supported find form (-type d, no path) to PowerShell", () => {
		const route = routeShellContract(`find D:/x -type d`, "win32");
		expectPowershell(route, ["find", "D:/x", "-type", "d"]);
	});

	it("fails closed on a real multi-line command list and hands the raw text to the engine", () => {
		const command = "echo one\necho two";
		expectUnsupportedPair(command, COMMAND_LIST_MESSAGE);
	});

	it("fails closed on a heredoc at the first redirection character, never reaching the delimiter", () => {
		const command = "cat <<'EOF'\nline\nEOF";
		expectUnsupportedPair(command, UNSUPPORTED_OPERATOR_MESSAGE);
	});

	it("fails closed on a for-in glob loop at the unquoted glob", () => {
		expectUnsupportedPair(`for f in *.txt; do echo "$f"; done`, UNSUPPORTED_OPERATOR_MESSAGE);
	});

	it("fails closed on an if/test bracket construct at the leading [", () => {
		expectUnsupportedPair(`if [ -f x ]; then echo y; fi`, UNSUPPORTED_OPERATOR_MESSAGE);
	});

	it("fails closed on echo piped into python even though the python code itself is quoted", () => {
		const command = `echo "a b" | python -c "import sys;print(sys.stdin.read())"`;
		expectUnsupportedPair(command, UNSUPPORTED_OPERATOR_MESSAGE);
	});

	it("routes where.exe as a plain external command", () => {
		const route = routeShellContract(`where.exe git`, "win32");
		expectPowershell(route, ["where.exe", "git"]);
	});

	it("routes sqlcmd with flag-heavy argv as a plain external command", () => {
		const route = routeShellContract(`sqlcmd -S 127.0.0.1 -E -h -1 -W -Q "SELECT 1"`, "win32");
		expectPowershell(route, ["sqlcmd", "-S", "127.0.0.1", "-E", "-h", "-1", "-W", "-Q", "SELECT 1"]);
	});

	it("TRAP: an unquoted registry path loses its backslashes, matching real Bash escape semantics", () => {
		// Outside quotes, backslash is Bash's escape character: it is consumed and only the next
		// character survives. Real Bash does exactly this to `HKLM\SOFTWARE\x`, so this is not a
		// router defect — it documents a genuine trap for a model that writes Windows-style unquoted
		// backslash paths on the Bash-like contract.
		const route = routeShellContract(String.raw`reg query HKLM\SOFTWARE\x /v y`, "win32");
		expectPowershell(route, ["reg", "query", "HKLMSOFTWAREx", "/v", "y"]);
	});

	it("routes tasklist with a quoted /FI filter as a plain external command", () => {
		const route = routeShellContract(`tasklist /FI "IMAGENAME eq x.exe"`, "win32");
		expectPowershell(route, ["tasklist", "/FI", "IMAGENAME eq x.exe"]);
	});

	it("routes wevtutil.exe with colon-joined flags as a plain external command", () => {
		const route = routeShellContract(`wevtutil.exe qe Application /c:5 /f:text`, "win32");
		expectPowershell(route, ["wevtutil.exe", "qe", "Application", "/c:5", "/f:text"]);
	});

	it("routes winget list --id as a plain external command", () => {
		const route = routeShellContract(`winget list --id x`, "win32");
		expectPowershell(route, ["winget", "list", "--id", "x"]);
	});

	it("fails closed on an empty or whitespace-only command on both tiers: nothing is ever started for nothing", () => {
		for (const command of ["", "   ", "\n\t"]) {
			for (const pythonEngine of [true, false]) {
				expect(routeShellContract(command, "win32", { pythonEngine })).toEqual({
					kind: "unsupported",
					error: "Shell command is empty.",
				});
			}
		}
	});

	it("fails closed on an unbalanced quote with the exact unclosed-quote message", () => {
		expectUnsupportedPair(`git commit -m 'unbalanced`, "Unclosed quote in Bash-like command.");
	});

	it("routes a 10,000-character single argument without truncation", () => {
		const huge = "x".repeat(10_000);
		const route = routeShellContract(`echo ${huge}`, "win32");
		expectPowershell(route, ["echo", huge]);
		expect(route.argv[1]).toHaveLength(10_000);
		expect(route.command).toContain(huge);
	});

	it("routes a Unicode argument byte-identical through echo", () => {
		const route = routeShellContract(`echo 日本語`, "win32");
		expectPowershell(route, ["echo", "日本語"]);
		expect(route.command).toContain("'日本語'");
	});

	it("preserves a single-quoted %PATH% literal (never expanded)", () => {
		const route = routeShellContract(`echo '%PATH%'`, "win32");
		expectPowershell(route, ["echo", "%PATH%"]);
	});

	it("preserves a single-quoted $env:X literal (never expanded, no $ failure inside single quotes)", () => {
		const route = routeShellContract(`echo '$env:X'`, "win32");
		expectPowershell(route, ["echo", "$env:X"]);
	});

	it("preserves a single-quoted & literal without triggering the chaining operator", () => {
		const route = routeShellContract(`echo '&'`, "win32");
		expectPowershell(route, ["echo", "&"]);
	});

	it("preserves a single-quoted | literal without triggering the pipe operator", () => {
		const route = routeShellContract(`echo '|'`, "win32");
		expectPowershell(route, ["echo", "|"]);
	});

	it("preserves a single-quoted < literal without triggering the redirection operator", () => {
		const route = routeShellContract(`echo '<'`, "win32");
		expectPowershell(route, ["echo", "<"]);
	});

	it("preserves a single-quoted > literal without triggering the redirection operator", () => {
		const route = routeShellContract(`echo '>'`, "win32");
		expectPowershell(route, ["echo", ">"]);
	});

	it("preserves &|<> literally inside double quotes: only $ and ` are special there", () => {
		const route = routeShellContract(`echo "&|<>"`, "win32");
		expectPowershell(route, ["echo", "&|<>"]);
	});

	it("fails closed on $env:X inside double quotes because $ is special there even though & | < > are not", () => {
		expectUnsupportedPair(`echo "$env:X"`, UNSUPPORTED_OPERATOR_MESSAGE);
	});

	it("routes a git invocation with a parenthesized quoted path as a plain external command", () => {
		const route = routeShellContract(`git -C "D:/Repo (x86)" log -1`, "win32");
		expectPowershell(route, ["git", "-C", "D:/Repo (x86)", "log", "-1"]);
	});

	it("routes rm -rf on a quoted space-containing Windows path to the routed rm builtin", () => {
		const route = routeShellContract(`rm -rf "D:/Program Files/app"`, "win32");
		expectPowershell(route, ["rm", "-rf", "D:/Program Files/app"]);
		expect(route.command).toContain("Remove-Item -LiteralPath $path -Force -Recurse");
	});

	it("routes mkdir -p on a quoted space-containing Windows path to the routed mkdir builtin", () => {
		const route = routeShellContract(`mkdir -p "D:/New Folder"`, "win32");
		expectPowershell(route, ["mkdir", "-p", "D:/New Folder"]);
		expect(route.command).toContain("-Force");
	});

	it("sends an already-supported PowerShell builtin to the engine when it is on, and to the floor only when it is off", () => {
		const command = `ls -la D:/Repo`;
		expect(routeShellContract(command, "win32", { pythonEngine: true })).toEqual({ kind: "python-engine", command });
		expectPowershell(routeShellContract(command, "win32", { pythonEngine: false }), ["ls", "-la", "D:/Repo"]);
	});

	it("sends a plain external command to the engine when it is on, and to the floor only when it is off", () => {
		const command = `where.exe node`;
		expect(routeShellContract(command, "win32", { pythonEngine: true })).toEqual({ kind: "python-engine", command });
		expectPowershell(routeShellContract(command, "win32", { pythonEngine: false }), ["where.exe", "node"]);
	});
});
