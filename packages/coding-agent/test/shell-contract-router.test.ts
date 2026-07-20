import { describe, expect, it } from "vitest";
import { routeShellContract } from "../src/core/tools/shell-contract-router.ts";

describe("stable Bash-like shell contract router", () => {
	it("passes commands through unchanged outside Windows", () => {
		expect(routeShellContract("printf '%s\\n' hello | head", "linux")).toEqual({
			kind: "passthrough",
			command: "printf '%s\\n' hello | head",
		});
	});

	it("translates quoted external argv to a deterministic PowerShell invocation", () => {
		const route = routeShellContract("git commit -m 'fix user''s bug'", "win32");
		expect(route).toMatchObject({ kind: "powershell", argv: ["git", "commit", "-m", "fix users bug"] });
		if (route.kind !== "powershell") throw new Error("Expected PowerShell route");
		expect(route.command).toContain("& 'git' 'commit' '-m' 'fix users bug'");
		expect(route.command).toContain("exit $LASTEXITCODE");
	});

	it("converts common Bash-like builtins without model-authored PowerShell", () => {
		const cases: Array<[string, string]> = [
			["pwd", "(Get-Location).Path"],
			["ls -la .", "Get-ChildItem -LiteralPath '.' -Force"],
			["cat 'a b.txt'", "[IO.File]::ReadAllText($path)"],
			["head -n 4 file.txt", "-TotalCount 4"],
			["tail -n 4 file.txt", "-Tail 4"],
			["grep TODO file.txt", "Select-String -LiteralPath 'file.txt' -Pattern 'TODO' -CaseSensitive"],
			["find src -type f -name '*.ts'", "Get-ChildItem -LiteralPath 'src' -Recurse -Force -File -Filter '*.ts'"],
			["mkdir -p 'a b'", "New-Item -ItemType Directory"],
			["touch 'a b.txt'", "New-Item -ItemType File"],
			["rm -rf build", "Remove-Item -LiteralPath $path -Force -Recurse"],
		];
		for (const [command, expected] of cases) {
			const route = routeShellContract(command, "win32");
			expect(route).toMatchObject({ kind: "powershell" });
			if (route.kind !== "powershell") throw new Error(`Expected PowerShell route for ${command}`);
			expect(route.command).toContain(expected);
			if (command.startsWith("ls") || command.startsWith("find")) {
				expect(route.command).toContain("[Array]::Sort");
				expect(route.command).toContain("[StringComparer]::Ordinal");
			}
		}
	});

	it("preserves Bash-like flag and exit semantics for routed builtins", () => {
		const powershellCommand = (command: string) => {
			const route = routeShellContract(command, "win32");
			expect(route).toMatchObject({ kind: "powershell" });
			if (route.kind !== "powershell") throw new Error(`Expected PowerShell route for ${command}`);
			return route.command;
		};

		expect(powershellCommand("echo -n hi")).toContain("[Console]::Out.Write((@('hi') -join ' '))");
		expect(powershellCommand("echo -nn hi")).toContain("[Console]::Out.Write((@('hi') -join ' '))");
		expect(powershellCommand("echo -value")).toContain("[Console]::Out.WriteLine((@('-value') -join ' '))");
		expect(powershellCommand("grep missing file.txt")).toContain("if ($matches.Count -eq 0) { exit 1 }");
		expect(powershellCommand("rm -f missing.txt")).not.toContain("else { throw");
		expect(powershellCommand("rm missing.txt")).toContain("else { throw");
		expect(powershellCommand("mkdir existing")).not.toContain("-Force");
		expect(powershellCommand("mkdir -p existing")).toContain("-Force");
		expect(powershellCommand("cp source-dir copied-dir")).toContain("source is a directory; use -r");
		expect(powershellCommand("ls")).not.toContain("-Force");
		expect(powershellCommand("ls")).toContain("Where-Object { -not $_.Name.StartsWith('.') }");
		expect(powershellCommand("ls -a")).toContain("-Force");
		expect(powershellCommand("ls -a")).not.toContain("Where-Object");
	});

	it("preserves empty and escaped arguments deterministically", () => {
		const route = routeShellContract("node -e \"console.log('a b')\" '' c\\ d", "win32");
		expect(route).toMatchObject({ kind: "powershell", argv: ["node", "-e", "console.log('a b')", "", "c d"] });
		if (route.kind !== "powershell") throw new Error("Expected PowerShell route");
		expect(route.command).toContain("'console.log(''a b'')' '' 'c d'");
	});

	it("preserves quoted, unquoted, and UNC Windows paths", () => {
		const cases: Array<[string, string[]]> = [
			["cat C:\\Users\\runner\\file.txt", ["cat", "C:\\Users\\runner\\file.txt"]],
			['cat "C:\\Users\\runner\\file with spaces.txt"', ["cat", "C:\\Users\\runner\\file with spaces.txt"]],
			["find \\\\server\\share\\folder -type f", ["find", "\\\\server\\share\\folder", "-type", "f"]],
		];
		for (const [command, argv] of cases) {
			expect(routeShellContract(command, "win32")).toMatchObject({ kind: "powershell", argv });
		}
	});

	it("fails closed for shell operators, expansions, nested shells, and unsupported builtin forms", () => {
		for (const command of [
			"cat file | grep x",
			"echo hi > out.txt",
			"echo $HOME",
			"echo $(whoami)",
			"echo *.txt",
			"cat ~/file.txt",
			"echo {one,two}",
			"echo -e 'one\\ttwo'",
			"FOO=bar node script.js",
			"bash -lc 'rm -rf build'",
			"sh script.sh",
			"ls --color=always",
			"./script.sh",
			"echo 'unterminated",
		]) {
			expect(routeShellContract(command, "win32")).toMatchObject({ kind: "unsupported" });
		}
	});

	describe("engine tier (options.pythonEngine)", () => {
		it("keeps the existing PowerShell floor for simple commands with the engine enabled", () => {
			for (const command of ["pwd", "ls -la .", "git commit -m 'msg'", "node --version"]) {
				const route = routeShellContract(command, "win32", { pythonEngine: true });
				expect(route).toMatchObject({ kind: "powershell" });
			}
		});

		it("routes complex Bash constructs and expansion to the engine", () => {
			for (const command of [
				"cat file | grep x",
				"echo hi > out.txt",
				"echo $HOME",
				"echo $(whoami)",
				"echo *.txt",
				"cat ~/file.txt",
				"echo one; echo two",
				"echo a && echo b",
			]) {
				expect(routeShellContract(command, "win32", { pythonEngine: true })).toMatchObject({
					kind: "python-engine",
					command,
				});
			}
		});

		it("routes state mutators to the engine", () => {
			for (const command of ["cd ..", "export FOO=bar", "unset FOO"]) {
				expect(routeShellContract(command, "win32", { pythonEngine: true })).toMatchObject({
					kind: "python-engine",
					command,
				});
			}
		});

		it("routes inline env assignments to the engine", () => {
			expect(routeShellContract("FOO=bar node script.js", "win32", { pythonEngine: true })).toMatchObject({
				kind: "python-engine",
				command: "FOO=bar node script.js",
			});
		});

		it("routes a PS-floor-rejected builtin form to the engine instead of failing closed", () => {
			expect(routeShellContract("ls --color=always", "win32", { pythonEngine: true })).toMatchObject({
				kind: "python-engine",
				command: "ls --color=always",
			});
		});

		it("keeps nested shells and POSIX scripts unsupported even with the engine enabled", () => {
			for (const command of ["bash -lc 'rm -rf build'", "sh script.sh", "./script.sh"]) {
				expect(routeShellContract(command, "win32", { pythonEngine: true })).toMatchObject({ kind: "unsupported" });
			}
		});

		it("does not change classification when pythonEngine is explicitly false", () => {
			for (const command of ["cat file | grep x", "FOO=bar node script.js", "ls --color=always"]) {
				expect(routeShellContract(command, "win32", { pythonEngine: false })).toMatchObject({
					kind: "unsupported",
				});
			}
		});
	});
});
