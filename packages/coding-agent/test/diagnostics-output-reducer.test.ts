/**
 * Diagnostics reducer contract: every diagnostic of the raw report (file, position, code, message)
 * is present in the reduced text, frames survive only for errors, progress lines disappear, the
 * summary stays, and the result is byte-stable.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyCommandFamily } from "../src/core/tools/command-family.ts";
import {
	diagnosticsOutputReducer,
	reduceDiagnosticsOutput,
	reducePythonTracebacks,
} from "../src/core/tools/diagnostics-output-reducer.ts";

const fixtures = join(import.meta.dirname, "fixtures", "tool-output");
const fixture = (name: string) => readFileSync(join(fixtures, name), "utf-8");
const request = { tool: "bash", command: "", text: "", exitCode: 0, level: "standard" as const };
const reduce = (command: string, text: string) => reduceDiagnosticsOutput(classifyCommandFamily(command), text);

/** `path\0line:col` of every reduced diagnostic in either layout (by file, or by message). */
function reducedPositions(text: string): Set<string> {
	const positions = new Set<string>();
	let path = "";
	let byMessage = false;
	for (const line of text.split("\n")) {
		if (line.length === 0) continue;
		if (/^(?:error|warning|info)(?:\[[^\]]+\])?: /u.test(line)) {
			byMessage = true;
			continue;
		}
		if (!line.startsWith(" ")) {
			path = line;
			byMessage = false;
			continue;
		}
		if (byMessage) {
			const fileLine = /^ {2}(\S+) ((?:\d+(?::\d+)?)(?:, \d+(?::\d+)?)*)$/u.exec(line);
			if (fileLine) for (const position of fileLine[2].split(", ")) positions.add(`${fileLine[1]}\0${position}`);
			continue;
		}
		const single = /^ {2}(\d+(?::\d+)?) (?:error|warning|info)/u.exec(line);
		if (single) {
			positions.add(`${path}\0${single[1]}`);
			continue;
		}
		const merged = /^ {2}(?:error|warning|info).* {2}at ((?:\d+(?::\d+)?)(?:, \d+(?::\d+)?)*)$/u.exec(line);
		if (merged) for (const position of merged[1].split(", ")) positions.add(`${path}\0${position}`);
	}
	return positions;
}

describe("reduceDiagnosticsOutput: cargo check", () => {
	const raw = fixture("cargo-check.txt");
	const reduced = reduce("cargo check", raw);

	it("keeps every diagnostic location and drops progress lines and warning frames", () => {
		expect(reduced).toBeDefined();
		const rawPositions = new Set<string>();
		for (const match of raw.matchAll(/^\s*-->\s+(.+?):(\d+):(\d+)\s*$/gmu)) {
			rawPositions.add(`${match[1]}\0${match[2]}:${match[3]}`);
		}
		expect(rawPositions.size).toBeGreaterThan(20);
		expect(reducedPositions(reduced!.text)).toEqual(rawPositions);
		expect(reduced!.text).not.toMatch(/Checking crate-/u);
		expect(reduced!.text).not.toMatch(/help: if this is intentional/u);
		expect(reduced!.text.length).toBeLessThan(raw.length * 0.3);
		expect(reduced!.omittedLines).toBeGreaterThan(150);
	});

	it("names the lint from the rustc note and keeps the frame of the error only", () => {
		expect(reduced!.text).toContain("  20:9 warning[unused_variables]: unused variable: `tmp0`\n");
		expect(reduced!.text).toContain("  42:18 error[E0308]: mismatched types");
		expect(reduced!.text).toContain('    42 |     let n: u32 = "text";');
		expect(reduced!.text).toContain("expected `u32`, found `&str`");
	});

	it("keeps the cargo summary lines at the end", () => {
		const lines = reduced!.text.trimEnd().split("\n");
		expect(lines.at(-2)).toMatch(/^warning: `demo-crate` .* generated 30 warnings$/u);
		expect(lines.at(-1)).toMatch(/^error: could not compile `demo-crate`/u);
	});

	it("merges diagnostics with the same message inside a file into one line listing the positions", () => {
		const block = (line: number) =>
			[
				"warning: unused import: `x`",
				`  --> src/lib.rs:${line}:5`,
				"   |",
				` ${line} | use x;`,
				"   |     ^",
				"",
			].join("\n");
		const text = `${block(3)}\n${block(9)}\nwarning: \`demo\` (lib) generated 2 warnings\n`;
		expect(reduce("cargo build", text)?.text).toBe(
			"src/lib.rs\n  warning: unused import: `x`  at 3:5, 9:5\nwarning: `demo` (lib) generated 2 warnings\n",
		);
	});

	it("frames only the first instances of a repeated error and keeps the rest as one-liners", () => {
		const errorBlock = (index: number) =>
			[
				"error[E0433]: failed to resolve: use of undeclared crate or module `store`",
				`  --> src/app/module_${index % 4}.rs:${10 + index}:5`,
				"   |",
				`${10 + index} |     store::open(path)`,
				"   |     ^^^^^ use of undeclared crate or module `store`",
				"   |",
				"help: consider importing this module",
				"   |",
				" 1 + use crate::store;",
				"   |",
				"",
			].join("\n");
		const summary = 'error: could not compile `demo` (bin "demo") due to 30 previous errors';
		const text = `${Array.from({ length: 30 }, (_, index) => errorBlock(index)).join("\n")}\n${summary}\n`;
		const standard = reduce("cargo check", text);
		expect(standard).toBeDefined();
		expect(reducedPositions(standard!.text).size).toBe(30);
		expect(standard!.text.match(/store::open\(path\)/gu)).toHaveLength(2);
		expect(standard!.text.length).toBeLessThan(text.length * 0.3);
		const compact = reduceDiagnosticsOutput(classifyCommandFamily("cargo check"), text, "compact");
		expect(compact!.text.match(/store::open\(path\)/gu)).toHaveLength(1);
		// Secondary spans stay inside the frame instead of leaking as unknown lines.
		const secondary = `${errorBlock(0).replace("   |\n", "   |\n  ::: src/store.rs:3:1\n   |\n")}\n`;
		expect(reduce("cargo check", secondary)!.text).toContain("    ::: src/store.rs:3:1");
	});

	it("reduces a progress-only build to its final line", () => {
		const text =
			"   Compiling a v0.1.0\n   Compiling b v0.1.0\n    Finished `dev` profile [unoptimized] target(s) in 1.20s\n";
		expect(reduce("cargo build", text)).toEqual({
			text: "    Finished `dev` profile [unoptimized] target(s) in 1.20s\n",
			omittedLines: 2,
		});
	});

	it("is deterministic", () => {
		expect(reduce("cargo check", raw)).toEqual(reduced);
	});
});

describe("reduceDiagnosticsOutput: tsc", () => {
	it("groups errors by file and drops the errors-per-file table", () => {
		const text = [
			"src/a.ts(10,3): error TS2322: Type 'string' is not assignable to type 'number'.",
			"src/a.ts(12,3): error TS2304: Cannot find name 'foo'.",
			"src/b.ts(1,1): error TS1005: ';' expected.",
			"",
			"",
			"Found 3 errors in 2 files.",
			"",
			"Errors  Files",
			"     2  src/a.ts:10",
			"     1  src/b.ts:1",
			"",
		].join("\n");
		expect(reduce("tsc --noEmit", text)).toEqual({
			text: [
				"src/a.ts",
				"  10:3 error[TS2322]: Type 'string' is not assignable to type 'number'.",
				"  12:3 error[TS2304]: Cannot find name 'foo'.",
				"src/b.ts",
				"  1:1 error[TS1005]: ';' expected.",
				"Found 3 errors in 2 files.",
				"",
			].join("\n"),
			omittedLines: 4,
		});
	});

	it("switches to the by-message layout when the same errors repeat across files", () => {
		const raw = fixture("tsc.txt");
		const reduced = reduce("tsc --noEmit", raw);
		expect(reduced).toBeDefined();
		const rawPositions = new Set<string>();
		for (const match of raw.matchAll(/^(.+?)\((\d+),(\d+)\): error/gmu)) {
			rawPositions.add(`${match[1]}\0${match[2]}:${match[3]}`);
		}
		expect(reducedPositions(reduced!.text)).toEqual(rawPositions);
		expect(reduced!.text).toMatch(
			/^error\[TS2322\]: Type 'string' is not assignable to type 'number'\. {2}\(\d+ places\)\n/u,
		);
		expect(reduced!.text.length).toBeLessThan(raw.length * 0.5);
	});

	it("parses the --pretty layout, keeps frames within the budget and clips huge messages", () => {
		const raw = fixture("tsc-pretty.txt");
		const stripped = raw.replace(/\u001b\[[0-9;]*m/gu, "");
		const rawPositions = new Set<string>();
		for (const match of stripped.matchAll(/^(.+?):(\d+):(\d+) - error/gmu)) {
			rawPositions.add(`${match[1]}\0${match[2]}:${match[3]}`);
		}
		expect(rawPositions.size).toBeGreaterThan(20);
		// The reducer runs after the generic stage in the pipeline; feed it the stripped text here.
		const direct = reduce("tsc -p . --pretty", stripped);
		expect(reducedPositions(direct!.text)).toEqual(rawPositions);
		expect(direct!.text.match(/~~+/gu)?.length ?? 0).toBeLessThanOrEqual(8);
		expect(direct!.text).toMatch(/Found \d+ errors in \d+ files\./u);
		expect(direct!.text.length).toBeLessThan(stripped.length * 0.35);
		const long = `src/x.ts(1,1): error TS2322: ${"T".repeat(1000)}\nFound 1 error in src/x.ts:1\n`;
		expect(reduce("tsc", long)!.text).toContain("… [+700 chars]");
	});

	it("passes through output without diagnostics", () => {
		expect(reduce("tsc --noEmit", "")).toBeUndefined();
		expect(reduce("tsc --noEmit", "Version 5.9.0\n")).toBeUndefined();
	});
});

describe("reduceDiagnosticsOutput: eslint", () => {
	it("keeps every problem with its rule, by message when a rule fires everywhere", () => {
		const raw = fixture("eslint.txt");
		const reduced = reduce("npx eslint src", raw);
		expect(reduced).toBeDefined();
		const rawPositions = new Set<string>();
		let path = "";
		for (const line of raw.split("\n")) {
			if (line.startsWith("/")) path = line;
			const match = /^\s+(\d+):(\d+)\s+(?:error|warning)/u.exec(line);
			if (match) rawPositions.add(`${path}\0${match[1]}:${match[2]}`);
		}
		expect(rawPositions.size).toBe(27);
		expect(reducedPositions(reduced!.text)).toEqual(rawPositions);
		expect(reduced!.text).toContain("warning[no-console]: Unexpected console statement  (3 places)");
		expect(reduced!.text).toContain("✖ 27 problems (24 errors, 3 warnings)");
		expect(reduced!.text).not.toMatch(/potentially fixable/u);
		// Stylish is already dense: the honest gain is the fixable line, the blanks and the repeated rule.
		expect(reduced!.text.length).toBeLessThan(raw.length * 0.8);
	});
});

describe("reduceDiagnosticsOutput: biome", () => {
	const raw = fixture("biome.txt");
	const reduced = reduce("npx biome lint src", raw);

	it("keeps one line per diagnostic with its rule and severity", () => {
		expect(reduced).toBeDefined();
		expect(reduced!.text).toContain("src/sample.ts\n");
		expect(reduced!.text).toContain(
			"  warning[lint/suspicious/noExplicitAny]: Unexpected any. Specify a different type.  at 1:10, 3:17",
		);
		expect(reduced!.text).toContain("  2:10 warning[lint/correctness/noUnusedVariables]: This function f is unused.");
		expect(reduced!.text).toContain(
			"  4:1 error[lint/suspicious/noDebugger]: This is an unexpected use of the debugger statement.",
		);
		expect(reducedPositions(reduced!.text).size).toBe(4);
	});

	it("keeps the frame of the error, drops frames, advice and fix previews of warnings", () => {
		expect(reduced!.text).toContain("    > 4 │ debugger;");
		expect(reduced!.text).not.toContain("> 1 │ const a: any = 1;");
		expect(reduced!.text).not.toMatch(/Unsafe fix/u);
		expect(reduced!.text).not.toMatch(/any disables many type checking rules/u);
		expect(reduced!.text).not.toMatch(/function·_f/u);
	});

	it("keeps the summary and the final error banner verbatim", () => {
		expect(reduced!.text).toContain("Checked 1 file in 3ms. No fixes applied.\nFound 1 error.\nFound 3 warnings.\n");
		expect(reduced!.text).toContain("  × Some errors were emitted while running checks.\n");
		expect(reduced!.text.length).toBeLessThan(raw.length * 0.4);
	});

	it("is deterministic", () => {
		expect(reduce("npx biome lint src", raw)).toEqual(reduced);
	});
});

describe("reduceDiagnosticsOutput: language-agnostic grammars", () => {
	const positionsIn = (raw: string, pattern: RegExp) => {
		const positions = new Set<string>();
		for (const match of raw.matchAll(pattern))
			positions.add(`${match[1]}\0${match[3] ? `${match[2]}:${match[3]}` : match[2]}`);
		return positions;
	};

	it("gcc through make: frames budgeted, In-function lines kept, warnings one line", () => {
		const raw = fixture("gcc.txt");
		const reduced = reduce("make -j8", raw);
		expect(reduced).toBeDefined();
		expect(reducedPositions(reduced!.text)).toEqual(
			positionsIn(raw, /^(\S+\.cpp):(\d+):(\d+): (?:error|warning)/gmu),
		);
		expect(reduced!.text).toContain("warning[-Wunused-variable]: unused variable 'tmp'");
		expect(reduced!.text).toContain("make: *** [Makefile:12: build/app] Error 1");
		expect(reduced!.text.match(/\^~+/gu)?.length ?? 0).toBeLessThanOrEqual(8);
		expect(reduced!.text.length).toBeLessThan(raw.length * 0.45);
	});

	it("go build: one message, every position, the package header kept", () => {
		const raw = fixture("go-build.txt");
		const reduced = reduce("go build ./...", raw);
		expect(reducedPositions(reduced!.text)).toEqual(positionsIn(raw, /^(\S+\.go):(\d+):(\d+): /gmu));
		expect(reduced!.text).toMatch(/^# example\.com\/app\/internal\/store$/mu);
		expect(reduced!.text).toContain("error: undefined: legacyOpen  (20 places)");
		expect(reduced!.text.length).toBeLessThan(raw.length * 0.5);
	});

	it("Free Pascal: parenthesised locations, hints as info, banner and progress dropped, fatal kept", () => {
		const raw = fixture("fpc.txt");
		const reduced = reduce("fpc program.pas", raw);
		expect(reducedPositions(reduced!.text)).toEqual(positionsIn(raw, /^(\S+\.pas)\((\d+)(?:,(\d+))?\) /gmu));
		expect(reduced!.text).toContain('info: Local variable "idx" not used');
		expect(reduced!.text).not.toMatch(/Free Pascal Compiler version|Compiling unit_/u);
		expect(reduced!.text).toContain("Fatal: Compilation aborted");
		expect(reduced!.text.length).toBeLessThan(raw.length * 0.5);
	});

	it("PHP: `in path on line N` locations become file groups", () => {
		const raw = fixture("php.txt");
		const reduced = reduce("php artisan test", raw);
		expect(reduced).toBeDefined();
		expect(reducedPositions(reduced!.text).size).toBe(25);
		expect(reduced!.text).toContain("/srv/app/src/View.php");
		expect(reduced!.text).toContain(
			"error: Uncaught TypeError: render(): Argument #1 must be of type array, null given",
		);
		expect(reduced!.text.length).toBeLessThan(raw.length * 0.7);
	});

	it("ruff: code-first lines merge by message and keep the summary", () => {
		const raw = fixture("ruff.txt");
		const reduced = reduce("ruff check src", raw);
		expect(reducedPositions(reduced!.text)).toEqual(positionsIn(raw, /^(\S+\.py):(\d+):(\d+): /gmu));
		expect(reduced!.text).toContain("error[F401]: `os.path` imported but unused  (24 places)");
		expect(reduced!.text).toContain("Found 30 errors.");
		expect(reduced!.text.length).toBeLessThan(raw.length * 0.45);
	});

	it("mypy and MSVC lines are recognized with their codes", () => {
		const mypy =
			"src/a.py:3: error: Name 'x' is not defined  [name-defined]\nsrc/a.py:9: error: Name 'y' is not defined  [name-defined]\nsrc/b.py:1: note: See https://mypy.rtfd.io\nFound 2 errors in 2 files (checked 3 source files)\n";
		const reducedMypy = reduce("mypy src", mypy);
		expect(reducedMypy!.text).toContain("3 error[name-defined]: Name 'x' is not defined");
		expect(reducedMypy!.text).toContain("1 info: See https://mypy.rtfd.io");
		const msvc =
			"main.cpp(12,5): error C2065: 'x': undeclared identifier\nmain.cpp(14,5): error C2065: 'y': undeclared identifier\nutil.cpp(3,1): warning C4100: 'argc': unreferenced formal parameter\n";
		expect(reduce("cl /nologo main.cpp", msvc)!.text).toContain("  12:5 error[C2065]: 'x': undeclared identifier");
	});

	it("collapses long Python tracebacks to the first and last frames", () => {
		const raw = fixture("traceback.txt");
		const reduced = reducePythonTracebacks(raw);
		expect(reduced).toBeDefined();
		const lines = reduced!.text.trimEnd().split("\n");
		expect(lines[0]).toBe("Traceback (most recent call last):");
		expect(lines[1]).toBe('  File "/srv/app/main.py", line 12, in <module>');
		expect(lines[3]).toBe("  [… 12 more frames]");
		expect(lines.at(-1)).toBe("KeyError: 'key'");
		expect(lines.at(-3)).toBe('  File "/srv/app/lib/final.py", line 7, in finish');
		expect(reduced!.text.length).toBeLessThan(raw.length * 0.4);
		expect(
			reducePythonTracebacks(
				'Traceback (most recent call last):\n  File "a.py", line 1, in <module>\n    x\nNameError: x\n',
			),
		).toBeUndefined();
		// Through the registered reducer on an unknown command the traceback alone is enough.
		const viaReducer = diagnosticsOutputReducer.reduce(classifyCommandFamily("python main.py"), {
			...request,
			command: "python main.py",
			text: raw,
		});
		expect(viaReducer?.kind).toBe("traceback");
	});

	it("applies to an unknown command only when the output reads as diagnostics", () => {
		const script = classifyCommandFamily("./scripts/build.sh");
		expect(diagnosticsOutputReducer.applies(script, { ...request, text: fixture("gcc.txt") })).toBe(true);
		expect(diagnosticsOutputReducer.applies(script, { ...request, text: "building\nok\n" })).toBe(false);
		expect(
			diagnosticsOutputReducer.applies(classifyCommandFamily("rg -n x:1: src"), {
				...request,
				text: fixture("gcc.txt"),
			}),
		).toBe(false);
	});
});

describe("diagnosticsOutputReducer.applies", () => {
	it("applies to compiler and linter invocations, through runners and cd prefixes", () => {
		for (const command of [
			"cargo check",
			"cargo build --release",
			"cargo clippy",
			"tsc --noEmit",
			"npx biome lint src",
			"npx eslint src",
			"cd /repo && cargo check",
		]) {
			expect(diagnosticsOutputReducer.applies(classifyCommandFamily(command), request), command).toBe(true);
		}
	});
	it("leaves test runs, searches and unknown tools alone", () => {
		for (const command of ["cargo test", "rg -n needle src", "ls -la", "npm install"]) {
			expect(diagnosticsOutputReducer.applies(classifyCommandFamily(command), request), command).toBe(false);
		}
	});
});
