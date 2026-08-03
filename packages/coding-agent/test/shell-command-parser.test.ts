import { describe, expect, it } from "vitest";
import { tokenizeCommand, tokenizeShellCommand } from "../src/core/tools/shell-command-parser.ts";

describe("shell command parser dialects", () => {
	it("keeps the stable Bash-like default while preserving Windows path separators", () => {
		expect(tokenizeCommand("git add file\\ space.txt")).toEqual(["git", "add", "file space.txt"]);
		expect(tokenizeCommand('rg -n needle "C:\\Users\\Example\\file with spaces.ts"')).toEqual([
			"rg",
			"-n",
			"needle",
			"C:\\Users\\Example\\file with spaces.ts",
		]);
		expect(tokenizeCommand("cat \\\\server\\share\\file.txt")).toEqual(["cat", "\\\\server\\share\\file.txt"]);
	});

	it("preserves Windows path separators under PowerShell semantics", () => {
		expect(tokenizeCommand('rg -n "needle" C:\\Users\\Example\\src\\module.ps1', "powershell")).toEqual([
			"rg",
			"-n",
			"needle",
			"C:\\Users\\Example\\src\\module.ps1",
		]);
	});

	it("uses the dialect escape character without changing POSIX behavior", () => {
		expect(tokenizeCommand("git add file\\ space.txt", "posix")).toEqual(["git", "add", "file space.txt"]);
		expect(tokenizeCommand("rg needle file` name.txt", "powershell")).toEqual(["rg", "needle", "file name.txt"]);
	});

	it("preserves PowerShell paths across command boundaries", () => {
		expect(tokenizeShellCommand("rg needle C:\\src\\one.ps1 | Select-Object -First 1", "powershell")).toEqual([
			{ kind: "arg", value: "rg" },
			{ kind: "arg", value: "needle" },
			{ kind: "arg", value: "C:\\src\\one.ps1" },
			{ kind: "pipe", value: "|" },
			{ kind: "arg", value: "Select-Object" },
			{ kind: "arg", value: "-First" },
			{ kind: "arg", value: "1" },
		]);
	});
});
