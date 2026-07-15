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
			["cat 'a b.txt'", "Get-Content -LiteralPath @('a b.txt') -Raw"],
			["head -n 4 file.txt", "-TotalCount 4"],
			["tail -n 4 file.txt", "-Tail 4"],
			["grep TODO file.txt", "Select-String -LiteralPath 'file.txt'"],
			["find src -type f -name '*.ts'", "Get-ChildItem -LiteralPath 'src' -Recurse -Force -File -Filter '*.ts'"],
			["mkdir -p 'a b'", "New-Item -ItemType Directory"],
			["touch 'a b.txt'", "New-Item -ItemType File"],
			["rm -rf build", "Remove-Item -LiteralPath @('build') -Force -Recurse"],
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

	it("preserves empty and escaped arguments deterministically", () => {
		const route = routeShellContract("node -e \"console.log('a b')\" '' c\\ d", "win32");
		expect(route).toMatchObject({ kind: "powershell", argv: ["node", "-e", "console.log('a b')", "", "c d"] });
		if (route.kind !== "powershell") throw new Error("Expected PowerShell route");
		expect(route.command).toContain("'console.log(''a b'')' '' 'c d'");
	});

	it("fails closed for shell operators, expansions, nested shells, and unsupported builtin forms", () => {
		for (const command of [
			"cat file | grep x",
			"echo hi > out.txt",
			"echo $HOME",
			"echo $(whoami)",
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
});
