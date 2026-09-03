/**
 * One classifier for the reduction pipeline and the census: what the runtime reduces and what the
 * census reports as passthrough must be decided by the same table.
 */
import { describe, expect, it } from "vitest";
import { classifyCommandFamily, commandFamilyLabel } from "../src/core/tools/command-family.ts";

describe("classifyCommandFamily", () => {
	it("folds cd prefixes and environment assignments away from the primary stage", () => {
		const classification = classifyCommandFamily('cd "/repo/my project" && CI=1 git -C sub diff --stat | head -20');
		expect(classification).toMatchObject({
			family: "git",
			tool: "git",
			subcommand: "diff",
			cwdPrefix: "/repo/my project",
			trailingStages: ["head"],
			verbose: false,
		});
		expect(classification.argv).toEqual(["git", "-C", "sub", "diff", "--stat"]);
		expect(commandFamilyLabel(classification)).toBe("git diff");
	});

	it("normalizes executables across platforms", () => {
		expect(classifyCommandFamily("python3 -m pytest -q").tool).toBe("python");
		expect(classifyCommandFamily("C:\\tools\\rg.exe -n needle .").tool).toBe("rg");
		expect(classifyCommandFamily("./node_modules/.bin/tsc --noEmit").tool).toBe("tsc");
		expect(classifyCommandFamily("cargo.exe check").family).toBe("diagnostics");
	});

	it("assigns the families the census measures", () => {
		const cases: [string, string][] = [
			["rg -n needle src", "search"],
			["grep -rn needle .", "search"],
			["git status", "git"],
			["cargo check", "diagnostics"],
			["cargo test -- --nocapture", "test"],
			["cargo install ripgrep", "package-manager"],
			["npx tsc --noEmit", "diagnostics"],
			["tsc --noEmit", "diagnostics"],
			["npm install", "package-manager"],
			["ls -la src", "listing"],
			["find . -name '*.ts'", "listing"],
			["nl -ba src/main.rs", "file-dump"],
			["cat package.json", "file-dump"],
			["python3 script.py", "python"],
			["pwsh -File build.ps1", "shell"],
			["./my-tool --run", "other"],
			["npx vitest run test/a.test.ts", "test"],
		];
		for (const [command, family] of cases) {
			expect(classifyCommandFamily(command).family, command).toBe(family);
		}
	});

	it("unwraps package runners to the program that produced the output", () => {
		expect(classifyCommandFamily("npx vitest run test/a.test.ts")).toMatchObject({ tool: "vitest", family: "test" });
		expect(commandFamilyLabel(classifyCommandFamily("npx vitest run"))).toBe("vitest");
		expect(classifyCommandFamily("pnpm exec eslint src").tool).toBe("eslint");
		expect(classifyCommandFamily("bunx --bun tsc --noEmit").tool).toBe("tsc");
		expect(classifyCommandFamily("npm run build").tool).toBe("npm");
	});

	it("flags explicit verbosity so reducers pass the output through", () => {
		expect(classifyCommandFamily("cargo test -- --nocapture").verbose).toBe(true);
		expect(classifyCommandFamily("npm install --verbose").verbose).toBe(true);
		expect(classifyCommandFamily("git status -v").verbose).toBe(true);
		expect(classifyCommandFamily("git status").verbose).toBe(false);
	});

	it("never throws on unparseable input and labels it as unparsed", () => {
		const classification = classifyCommandFamily("echo 'unterminated");
		expect(classification.family).toBe("other");
		expect(commandFamilyLabel(classification)).toBe("(unparsed)");
		expect(classifyCommandFamily("").family).toBe("other");
	});
});
