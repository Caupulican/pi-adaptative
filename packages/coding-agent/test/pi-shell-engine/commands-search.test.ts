import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ENGINE_DIR = join(__dirname, "..", "..", "src", "bundled-resources", "runtimes", "pi-shell-engine");

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

		it("out-of-matrix refusal: non-s/// script -> unsupported-flag", () => {
			const r = runBuiltin(python, "search.cmd_sed", { argv: ["sed", "d"], stdin: "x\n" }) as Refusal;
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
