/**
 * Diagnostics reducer contract: every diagnostic of the raw report (file, position, code, message)
 * is present in the reduced text, frames survive only for errors, progress lines disappear, the
 * summary stays, and the result is byte-stable.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyCommandFamily } from "../src/core/tools/command-family.ts";
import { diagnosticsOutputReducer, reduceDiagnosticsOutput } from "../src/core/tools/diagnostics-output-reducer.ts";

const fixtures = join(import.meta.dirname, "fixtures", "tool-output");
const fixture = (name: string) => readFileSync(join(fixtures, name), "utf-8");
const reduce = (command: string, text: string) => reduceDiagnosticsOutput(classifyCommandFamily(command), text);

/** `path\0line:col` of every reduced diagnostic line, keyed under its group path. */
function reducedPositions(text: string): Set<string> {
	const positions = new Set<string>();
	let path = "";
	for (const line of text.split("\n")) {
		if (line.length === 0) continue;
		if (!line.startsWith(" ")) {
			path = line;
			continue;
		}
		const match = /^ {2}(\d+(?::\d+)?) (?:error|warning|info)/u.exec(line);
		if (match) positions.add(`${path}\0${match[1]}`);
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
		expect(reduced!.text).toContain("  20:9 warning[unused_variables]: unused variable: `tmp0`");
		expect(reduced!.text).toContain("  42:18 error[E0308]: mismatched types");
		expect(reduced!.text).toContain('    42 |     let n: u32 = "text";');
		expect(reduced!.text).toContain("expected `u32`, found `&str`");
	});

	it("keeps the cargo summary lines at the end", () => {
		const lines = reduced!.text.trimEnd().split("\n");
		expect(lines.at(-2)).toMatch(/^warning: `demo-crate` .* generated 30 warnings$/u);
		expect(lines.at(-1)).toMatch(/^error: could not compile `demo-crate`/u);
	});

	it("collapses identical diagnostics with a count", () => {
		const block = [
			"warning: unused import: `x`",
			"  --> src/lib.rs:3:5",
			"   |",
			" 3 | use x;",
			"   |     ^",
			"",
		].join("\n");
		const text = `${block}\n${block}\nwarning: \`demo\` (lib) generated 2 warnings\n`;
		expect(reduce("cargo build", text)?.text).toBe(
			"src/lib.rs\n  3:5 warning: unused import: `x` [x2]\nwarning: `demo` (lib) generated 2 warnings\n",
		);
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

	it("keeps every fixture error", () => {
		const raw = fixture("tsc.txt");
		const reduced = reduce("tsc --noEmit", raw);
		expect(reduced).toBeDefined();
		const rawPositions = new Set<string>();
		for (const match of raw.matchAll(/^(.+?)\((\d+),(\d+)\): error/gmu)) {
			rawPositions.add(`${match[1]}\0${match[2]}:${match[3]}`);
		}
		expect(reducedPositions(reduced!.text)).toEqual(rawPositions);
	});

	it("passes through output without diagnostics", () => {
		expect(reduce("tsc --noEmit", "")).toBeUndefined();
		expect(reduce("tsc --noEmit", "Version 5.9.0\n")).toBeUndefined();
	});
});

describe("reduceDiagnosticsOutput: biome", () => {
	const raw = fixture("biome.txt");
	const reduced = reduce("npx biome lint src", raw);

	it("keeps one line per diagnostic with its rule and severity", () => {
		expect(reduced).toBeDefined();
		expect(reduced!.text).toContain("src/sample.ts\n");
		expect(reduced!.text).toContain(
			"  1:10 warning[lint/suspicious/noExplicitAny]: Unexpected any. Specify a different type.",
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

describe("diagnosticsOutputReducer.applies", () => {
	const request = { tool: "bash", command: "", text: "", exitCode: 0, level: "standard" as const };
	it("applies to compiler and linter invocations, through runners and cd prefixes", () => {
		for (const command of [
			"cargo check",
			"cargo build --release",
			"cargo clippy",
			"tsc --noEmit",
			"npx biome lint src",
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
