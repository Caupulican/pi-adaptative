import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ENGINE_DIR = join(import.meta.dirname, "..", "..", "src", "bundled-resources", "runtimes", "pi-shell-engine");

function resolvePython(): string | null {
	const fromEnv = process.env.PI_TEST_PYTHON;
	const candidates = fromEnv ? [fromEnv, "python3", "python"] : ["python3", "python"];
	for (const candidate of candidates) {
		const probe = spawnSync(candidate, ["--version"], { encoding: "utf-8" });
		if (probe.status === 0) return candidate;
	}
	return null;
}

interface Invocation {
	argv: string[];
	stdin?: string;
	cwd?: string;
}

interface Result {
	stdout: string;
	exitCode: number;
	refused: false;
}

interface Refusal {
	refused: true;
	code: string;
	construct: string;
	message: string;
}

function runBuiltin(python: string, fnExpr: string, invocation: Invocation): Result | Refusal {
	const { argv, stdin = "", cwd = "." } = invocation;
	const program = `
import sys, io, json
sys.path.insert(0, ${JSON.stringify(ENGINE_DIR)})
from commands import search
from context import BuiltinContext
from errors import UnsupportedConstruct

argv = json.loads(${JSON.stringify(JSON.stringify(argv))})
stdin_bytes = json.loads(${JSON.stringify(JSON.stringify(stdin))}).encode("utf-8")
cwd = json.loads(${JSON.stringify(JSON.stringify(cwd))})

out = io.BytesIO()
ctx = BuiltinContext(argv=argv, cwd=cwd, env={}, stdin=io.BytesIO(stdin_bytes), stdout=out)
try:
	rc = (${fnExpr})(ctx)
	sys.stdout.write(json.dumps({"refused": False, "stdout": out.getvalue().decode("utf-8", errors="surrogateescape"), "exitCode": rc}))
except UnsupportedConstruct as e:
	sys.stdout.write(json.dumps({"refused": True, "code": e.code, "construct": e.construct, "message": e.message}))
`;
	const result = spawnSync(python, ["-B", "-c", program], { encoding: "utf-8", cwd });
	if (result.status !== 0) {
		throw new Error(`engine crashed: ${result.stderr}`);
	}
	return JSON.parse(result.stdout);
}

function withTmpFiles(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-shell-search-"));
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(join(dir, name), content, "utf-8");
	}
	return dir;
}

/** Runs a builtin with the Python process's OS cwd deliberately different from ctx.cwd, to
 * prove FILE-operand resolution happens against ctx.cwd (never the process's actual OS cwd). */
function runBuiltinWithDivergentProcessCwd(
	python: string,
	fnExpr: string,
	invocation: Invocation & { processCwd: string },
): Result | Refusal {
	const { argv, stdin = "", cwd = ".", processCwd } = invocation;
	const program = `
import sys, io, json
sys.path.insert(0, ${JSON.stringify(ENGINE_DIR)})
from commands import search
from context import BuiltinContext
from errors import UnsupportedConstruct

argv = json.loads(${JSON.stringify(JSON.stringify(argv))})
stdin_bytes = json.loads(${JSON.stringify(JSON.stringify(stdin))}).encode("utf-8")
cwd = json.loads(${JSON.stringify(JSON.stringify(cwd))})

out = io.BytesIO()
ctx = BuiltinContext(argv=argv, cwd=cwd, env={}, stdin=io.BytesIO(stdin_bytes), stdout=out)
try:
	rc = (${fnExpr})(ctx)
	sys.stdout.write(json.dumps({"refused": False, "stdout": out.getvalue().decode("utf-8", errors="surrogateescape"), "exitCode": rc}))
except UnsupportedConstruct as e:
	sys.stdout.write(json.dumps({"refused": True, "code": e.code, "construct": e.construct, "message": e.message}))
`;
	const result = spawnSync(python, ["-B", "-c", program], { encoding: "utf-8", cwd: processCwd });
	if (result.status !== 0) {
		throw new Error(`engine crashed: ${result.stderr}`);
	}
	return JSON.parse(result.stdout);
}

describe("pi-shell-engine commands/search.py", () => {
	const python = resolvePython();
	if (!python) {
		it.skip("no Python interpreter available", () => {});
		return;
	}

	describe("grep", () => {
		it("plain pattern matches lines (D, -F fixed)", () => {
			const r = runBuiltin(python, "search.cmd_grep", {
				argv: ["grep", "-F", "foo"],
				stdin: "foo bar\nbaz\nfoo again\n",
			}) as Result;
			expect(r.stdout).toBe("foo bar\nfoo again\n");
			expect(r.exitCode).toBe(0);
		});

		it("-i case-insensitive", () => {
			const r = runBuiltin(python, "search.cmd_grep", {
				argv: ["grep", "-i", "-F", "FOO"],
				stdin: "foo\nBAR\n",
			}) as Result;
			expect(r.stdout).toBe("foo\n");
		});

		it("-v inverts match", () => {
			const r = runBuiltin(python, "search.cmd_grep", {
				argv: ["grep", "-v", "-F", "foo"],
				stdin: "foo\nbar\n",
			}) as Result;
			expect(r.stdout).toBe("bar\n");
		});

		it("-n prefixes line numbers", () => {
			const r = runBuiltin(python, "search.cmd_grep", {
				argv: ["grep", "-n", "-F", "foo"],
				stdin: "bar\nfoo\nfoo\n",
			}) as Result;
			expect(r.stdout).toBe("2:foo\n3:foo\n");
		});

		it("-c counts matches", () => {
			const r = runBuiltin(python, "search.cmd_grep", {
				argv: ["grep", "-c", "-F", "foo"],
				stdin: "foo\nbar\nfoo\n",
			}) as Result;
			expect(r.stdout).toBe("2\n");
		});

		it("-w whole word", () => {
			const r = runBuiltin(python, "search.cmd_grep", {
				argv: ["grep", "-w", "-F", "cat"],
				stdin: "cat\ncatalog\n",
			}) as Result;
			expect(r.stdout).toBe("cat\n");
		});

		it("-l lists matching filenames, multi-file prefix format", () => {
			const dir = withTmpFiles({ "a.txt": "hello\n", "b.txt": "world\n" });
			const r = runBuiltin(python, "search.cmd_grep", {
				argv: ["grep", "-l", "-F", "hello", "a.txt", "b.txt"],
				cwd: dir,
			}) as Result;
			expect(r.stdout).toBe("a.txt\n");
		});

		it("multi-file prefix `file:line` format", () => {
			const dir = withTmpFiles({ "a.txt": "foo\nbar\n", "b.txt": "foo\nbaz\n" });
			const r = runBuiltin(python, "search.cmd_grep", {
				argv: ["grep", "-F", "foo", "a.txt", "b.txt"],
				cwd: dir,
			}) as Result;
			expect(r.stdout).toBe("a.txt:foo\nb.txt:foo\n");
		});

		it("multi-file prefix `file:line:` with -n", () => {
			const dir = withTmpFiles({ "a.txt": "x\nfoo\n", "b.txt": "foo\ny\n" });
			const r = runBuiltin(python, "search.cmd_grep", {
				argv: ["grep", "-n", "-F", "foo", "a.txt", "b.txt"],
				cwd: dir,
			}) as Result;
			expect(r.stdout).toBe("a.txt:2:foo\nb.txt:1:foo\n");
		});

		it("no match -> exit 1", () => {
			const r = runBuiltin(python, "search.cmd_grep", { argv: ["grep", "-F", "zzz"], stdin: "abc\n" }) as Result;
			expect(r.exitCode).toBe(1);
			expect(r.stdout).toBe("");
		});

		it("missing file -> exit 2", () => {
			const r = runBuiltin(python, "search.cmd_grep", {
				argv: ["grep", "-F", "foo", "/nonexistent-path-xyz.txt"],
			}) as Result;
			expect(r.exitCode).toBe(2);
		});

		it("regex form (C, documented Python re divergence)", () => {
			const r = runBuiltin(python, "search.cmd_grep", {
				argv: ["grep", "^f.o$"],
				stdin: "foo\nfzo\nbar\n",
			}) as Result;
			expect(r.stdout).toBe("foo\nfzo\n");
		});

		it("out-of-matrix refusal: unknown flag -> unsupported-flag", () => {
			const r = runBuiltin(python, "search.cmd_grep", { argv: ["grep", "-z", "foo"] }) as Refusal;
			expect(r.refused).toBe(true);
			expect(r.code).toBe("unsupported");
			expect(r.construct).toBe("unsupported-flag");
		});

		it("resolves a relative FILE operand against ctx.cwd, not the process's OS cwd", () => {
			const dir = withTmpFiles({ "g.txt": "abc\nxyz\n" });
			const processCwd = mkdtempSync(join(tmpdir(), "pi-shell-search-elsewhere-"));
			const r = runBuiltinWithDivergentProcessCwd(python, "search.cmd_grep", {
				argv: ["grep", "-F", "abc", "g.txt"],
				cwd: dir,
				processCwd,
			}) as Result;
			expect(r.stdout).toBe("abc\n");
			expect(r.exitCode).toBe(0);
		});
	});

	describe("sed", () => {
		it("s/// substitution, first occurrence only by default", () => {
			const r = runBuiltin(python, "search.cmd_sed", {
				argv: ["sed", "s/foo/bar/"],
				stdin: "foofoo\n",
			}) as Result;
			expect(r.stdout).toBe("barfoo\n");
		});

		it("prints an address range with -n, the way transcripts page files", () => {
			const text = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
			const r = runBuiltin(python, "search.cmd_sed", { argv: ["sed", "-n", "2,4p"], stdin: text }) as Result;
			expect(r.stdout).toBe("line2\nline3\nline4\n");
			const tail = runBuiltin(python, "search.cmd_sed", { argv: ["sed", "-n", "9,$p"], stdin: text }) as Result;
			expect(tail.stdout).toBe("line9\nline10\n");
			const single = runBuiltin(python, "search.cmd_sed", { argv: ["sed", "-n", "1p"], stdin: "only" }) as Result;
			expect(single.stdout).toBe("only");
		});

		it("selects by regex address, deletes, and runs several -e scripts in order", () => {
			const text = "alpha\nbeta\ngamma\ndelta\n";
			const grep = runBuiltin(python, "search.cmd_sed", { argv: ["sed", "-n", "/^[bg]/p"], stdin: text }) as Result;
			expect(grep.stdout).toBe("beta\ngamma\n");
			const range = runBuiltin(python, "search.cmd_sed", {
				argv: ["sed", "-n", "/beta/,/gamma/p"],
				stdin: text,
			}) as Result;
			expect(range.stdout).toBe("beta\ngamma\n");
			const del = runBuiltin(python, "search.cmd_sed", { argv: ["sed", "2d"], stdin: text }) as Result;
			expect(del.stdout).toBe("alpha\ngamma\ndelta\n");
			const chained = runBuiltin(python, "search.cmd_sed", {
				argv: ["sed", "-e", "s/alpha/A/", "-e", "2,3d", "-e", "s/delta/D/"],
				stdin: text,
			}) as Result;
			expect(chained.stdout).toBe("A\nD\n");
			const semicolons = runBuiltin(python, "search.cmd_sed", { argv: ["sed", "1d;s/a/X/"], stdin: text }) as Result;
			expect(semicolons.stdout).toBe("betX\ngXmma\ndeltX\n");
		});

		it("accepts -E, -ne clusters, and s///p under -n; refuses -i and unknown commands", () => {
			const ere = runBuiltin(python, "search.cmd_sed", {
				argv: ["sed", "-E", "s/(a)(b)/\\2\\1/"],
				stdin: "ab\n",
			}) as Result;
			expect(ere.stdout).toBe("ba\n");
			const cluster = runBuiltin(python, "search.cmd_sed", {
				argv: ["sed", "-ne", "2p"],
				stdin: "x\ny\n",
			}) as Result;
			expect(cluster.stdout).toBe("y\n");
			const subPrint = runBuiltin(python, "search.cmd_sed", {
				argv: ["sed", "-n", "s/foo/bar/p"],
				stdin: "foo\nbaz\nfoo\n",
			}) as Result;
			expect(subPrint.stdout).toBe("bar\nbar\n");
			const inPlace = runBuiltin(python, "search.cmd_sed", { argv: ["sed", "-i", "s/a/b/", "file"] });
			expect(inPlace).toMatchObject({ refused: true, message: "sed: unsupported flag '-i'" });
			const unknown = runBuiltin(python, "search.cmd_sed", { argv: ["sed", "1y/a/b/"], stdin: "a\n" });
			expect(unknown).toMatchObject({ refused: true, message: expect.stringContaining("unsupported command 'y'") });
		});

		it("g flag replaces all occurrences", () => {
			const r = runBuiltin(python, "search.cmd_sed", {
				argv: ["sed", "s/foo/bar/g"],
				stdin: "foofoo\n",
			}) as Result;
			expect(r.stdout).toBe("barbar\n");
		});

		it("i flag case-insensitive", () => {
			const r = runBuiltin(python, "search.cmd_sed", {
				argv: ["sed", "s/foo/bar/gi"],
				stdin: "FOOfoo\n",
			}) as Result;
			expect(r.stdout).toBe("barbar\n");
		});

		it("any delimiter, e.g. |", () => {
			const r = runBuiltin(python, "search.cmd_sed", {
				argv: ["sed", "s|/usr/bin|/opt/bin|"],
				stdin: "/usr/bin/foo\n",
			}) as Result;
			expect(r.stdout).toBe("/opt/bin/foo\n");
		});

		it("\\1 backreference with Python re groups", () => {
			const r = runBuiltin(python, "search.cmd_sed", {
				argv: ["sed", "s/(a)(b)/\\2\\1/"],
				stdin: "ab\n",
			}) as Result;
			expect(r.stdout).toBe("ba\n");
		});

		it("& refers to the whole match", () => {
			const r = runBuiltin(python, "search.cmd_sed", {
				argv: ["sed", "s/foo/[&]/"],
				stdin: "foo bar\n",
			}) as Result;
			expect(r.stdout).toBe("[foo] bar\n");
		});

		it("\\& is a literal ampersand", () => {
			const r = runBuiltin(python, "search.cmd_sed", {
				argv: ["sed", "s/foo/\\&/"],
				stdin: "foo bar\n",
			}) as Result;
			expect(r.stdout).toBe("& bar\n");
		});

		it("regex pattern (C, documented Python re divergence)", () => {
			const r = runBuiltin(python, "search.cmd_sed", {
				argv: ["sed", "s/[0-9]+/N/g"],
				stdin: "a1 b22 c333\n",
			}) as Result;
			expect(r.stdout).toBe("aN bN cN\n");
		});

		it("reads from a file operand", () => {
			const dir = withTmpFiles({ "in.txt": "foo bar\n" });
			const r = runBuiltin(python, "search.cmd_sed", {
				argv: ["sed", "s/foo/baz/", "in.txt"],
				cwd: dir,
			}) as Result;
			expect(r.stdout).toBe("baz bar\n");
		});

		it("out-of-matrix refusal: a command outside p/d/s -> unsupported-flag", () => {
			// `d` and `p` are in the matrix now; `y///` (transliterate) still is not.
			const r = runBuiltin(python, "search.cmd_sed", { argv: ["sed", "y/ab/ba/"], stdin: "x\n" }) as Refusal;
			expect(r.refused).toBe(true);
			expect(r.code).toBe("unsupported");
			expect(r.construct).toBe("unsupported-flag");
		});

		it("resolves a relative FILE operand against ctx.cwd, not the process's OS cwd", () => {
			const dir = withTmpFiles({ "in.txt": "foo bar\n" });
			const processCwd = mkdtempSync(join(tmpdir(), "pi-shell-search-elsewhere-"));
			const r = runBuiltinWithDivergentProcessCwd(python, "search.cmd_sed", {
				argv: ["sed", "s/foo/baz/", "in.txt"],
				cwd: dir,
				processCwd,
			}) as Result;
			expect(r.stdout).toBe("baz bar\n");
		});
	});
});

describe("grep coreutils surface the sessions used", () => {
	const python = resolvePython();
	if (!python) {
		it.skip("no Python interpreter available", () => {});
		return;
	}
	it("recurses with include globs, prints context, counts, only-matching, quiet and whole-line forms", () => {
		const dir = withTmpFiles({ "a.txt": "foo one\nbar\nfoo two\n", "b.log": "foo log\n" });
		mkdirSync(join(dir, "sub"));
		writeFileSync(join(dir, "sub", "c.txt"), "foo deep\n", "utf-8");
		const recursive = runBuiltin(python as string, "search.cmd_grep", {
			argv: ["grep", "-rn", "foo", "."],
			cwd: dir,
		});
		expect(recursive).toMatchObject({ refused: false, exitCode: 0 });
		if (recursive.refused) throw new Error("refused");
		expect(recursive.stdout.split("\n").filter(Boolean).sort()).toEqual([
			"a.txt:1:foo one",
			"a.txt:3:foo two",
			"b.log:1:foo log",
			"sub/c.txt:1:foo deep",
		]);
		const included = runBuiltin(python as string, "search.cmd_grep", {
			argv: ["grep", "-rl", "--include=*.txt", "foo", "."],
			cwd: dir,
		});
		if (included.refused) throw new Error("refused");
		expect(included.stdout.split("\n").filter(Boolean).sort()).toEqual(["a.txt", "sub/c.txt"]);
		const context = runBuiltin(python as string, "search.cmd_grep", {
			argv: ["grep", "-n", "-A1", "bar", "a.txt"],
			cwd: dir,
		});
		if (context.refused) throw new Error("refused");
		expect(context.stdout).toBe("2:bar\n3-foo two\n");
		const count = runBuiltin(python as string, "search.cmd_grep", { argv: ["grep", "-c", "foo", "a.txt"], cwd: dir });
		if (count.refused) throw new Error("refused");
		expect(count.stdout).toBe("2\n");
		const only = runBuiltin(python as string, "search.cmd_grep", { argv: ["grep", "-o", "fo.", "a.txt"], cwd: dir });
		if (only.refused) throw new Error("refused");
		expect(only.stdout).toBe("foo\nfoo\n");
		const quiet = runBuiltin(python as string, "search.cmd_grep", { argv: ["grep", "-q", "foo", "a.txt"], cwd: dir });
		expect(quiet).toMatchObject({ refused: false, exitCode: 0, stdout: "" });
		const wholeLine = runBuiltin(python as string, "search.cmd_grep", {
			argv: ["grep", "-x", "bar", "a.txt"],
			cwd: dir,
		});
		if (wholeLine.refused) throw new Error("refused");
		expect(wholeLine.stdout).toBe("bar\n");
		const upper = runBuiltin(python as string, "search.cmd_grep", {
			argv: ["grep", "-R", "-i", "FOO", "sub"],
			cwd: dir,
		});
		if (upper.refused) throw new Error("refused");
		expect(upper.stdout).toBe("sub/c.txt:foo deep\n");
	});

	it("-I skips binary files (a NUL in the first 8 KiB) while still matching text files, combined with -RInE", () => {
		const dir = withTmpFiles({ "readme.py": "def match_target():\n    return 1\n" });
		// A "binary" file: NUL byte in the first 8 KiB, like GNU grep's own -I heuristic.
		writeFileSync(join(dir, "blob.py"), Buffer.from("match_target\x00binary payload"));
		const withoutI = runBuiltin(python as string, "search.cmd_grep", {
			argv: ["grep", "-RnE", "match_target", ".", "--include=*.py"],
			cwd: dir,
		});
		if (withoutI.refused) throw new Error("refused");
		const withoutILines = withoutI.stdout.split("\n").filter(Boolean).sort();
		expect(withoutILines).toHaveLength(2);
		expect(withoutILines[0].startsWith("blob.py:1:match_target")).toBe(true);
		expect(withoutILines[1]).toBe("readme.py:1:def match_target():");

		const withISkipping = runBuiltin(python as string, "search.cmd_grep", {
			argv: ["grep", "-RInE", "match_target", ".", "--include=*.py"],
			cwd: dir,
		});
		if (withISkipping.refused) throw new Error("refused");
		expect(withISkipping.stdout.split("\n").filter(Boolean)).toEqual(["readme.py:1:def match_target():"]);
	});

	it("-I applied directly to a binary file target yields no match instead of garbled output", () => {
		const dir = withTmpFiles({});
		writeFileSync(join(dir, "blob.bin"), Buffer.from("needle\x00tail"));
		const r = runBuiltin(python as string, "search.cmd_grep", {
			argv: ["grep", "-I", "needle", "blob.bin"],
			cwd: dir,
		});
		if (r.refused) throw new Error("refused");
		expect(r.stdout).toBe("");
		expect(r.exitCode).toBe(1);
	});

	it("an unknown flag combined with -I is still refused (parses -I as a real flag, not silently accepted)", () => {
		const r = runBuiltin(python as string, "search.cmd_grep", { argv: ["grep", "-IZ", "foo"] }) as Refusal;
		expect(r.refused).toBe(true);
		expect(r.construct).toBe("unsupported-flag");
	});
});
