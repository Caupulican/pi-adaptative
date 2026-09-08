import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ENGINE_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"src",
	"bundled-resources",
	"runtimes",
	"pi-shell-engine",
);
const MAIN_PY = join(ENGINE_DIR, "main.py");
const RECORD_SEPARATOR = "\x1e";

function resolvePython(): string | null {
	const fromEnv = process.env.PI_TEST_PYTHON;
	const candidates = fromEnv ? [fromEnv, "python3", "python"] : ["python3", "python"];
	for (const candidate of candidates) {
		const probe = spawnSync(candidate, ["--version"], { encoding: "utf-8" });
		if (probe.status === 0) return candidate;
	}
	return null;
}

// On Windows, the verification helper below re-prints a redirect target's file contents through
// Python's default text-mode stdout, which re-translates "\n" to "\r\n" on write — that is
// Windows Python child behavior, not the engine's (the TS bash-tool layer already strips "\r"
// before an agent ever sees output). Only assertions on output that passed through such an
// external python -c child normalize CRLF -> LF; engine-builtin output (echo/cat/etc., asserted
// directly off runEngine's own stdout field) always emits bare "\n" and stays byte-exact.
function normalizeChildOutput(text: string): string {
	return text.replace(/\r\n/g, "\n");
}

interface EngineFrame {
	exitCode: number;
	cwd: string;
	envDelta: Record<string, string | null>;
	unsupported: { code: string; construct: string; message: string } | null;
}

interface EngineResult {
	stdout: string;
	frame: EngineFrame;
	status: number | null;
	stderr: string;
}

function runEngine(
	python: string,
	command: string,
	cwd: string,
	env: Record<string, string> = {},
	timeoutMs?: number,
): EngineResult {
	const request = JSON.stringify({ command, cwd, env, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
	const result = spawnSync(python, ["-B", MAIN_PY], {
		encoding: "utf-8",
		input: request,
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.status !== 0) {
		throw new Error(`engine crashed for ${JSON.stringify(command)}: status=${result.status} stderr=${result.stderr}`);
	}
	const control = result.stderr;
	const first = control.indexOf(RECORD_SEPARATOR);
	const second = control.indexOf(RECORD_SEPARATOR, first + 1);
	if (first === -1 || second === -1) {
		throw new Error(`no parseable stderr control frame for ${JSON.stringify(command)}: ${JSON.stringify(control)}`);
	}
	const frame = JSON.parse(control.slice(first + 1, second)) as EngineFrame;
	return {
		stdout: result.stdout,
		frame,
		status: result.status,
		stderr: `${control.slice(0, first)}${control.slice(second + 1)}`,
	};
}

describe("pi-shell-engine conformance (main.py end-to-end)", () => {
	const python = resolvePython();
	if (!python) {
		it.skip("no Python interpreter available", () => {});
		return;
	}

	function withTmpDir<T>(fn: (dir: string) => T): T {
		const dir = mkdtempSync(join(tmpdir(), "pi-conformance-"));
		return fn(dir);
	}

	describe("§2.1 grammar constructs", () => {
		it("pipeline: a | b | c", () => {
			withTmpDir((dir) => {
				const { stdout, frame } = runEngine(python, 'printf "%s\\n" a b c | grep b | wc -l', dir);
				expect(stdout.trim()).toBe("1");
				expect(frame.exitCode).toBe(0);
			});
		});

		it("list - sequence: a ; b", () => {
			withTmpDir((dir) => {
				const { stdout, frame } = runEngine(python, "echo a ; echo b", dir);
				expect(stdout).toBe("a\nb\n");
				expect(frame.exitCode).toBe(0);
			});
		});

		it("list - and/or: a && b, a || b", () => {
			withTmpDir((dir) => {
				expect(runEngine(python, "true && echo yes", dir).stdout).toBe("yes\n");
				expect(runEngine(python, "false || echo yes", dir).stdout).toBe("yes\n");
			});
		});

		it("negation: ! pipeline", () => {
			withTmpDir((dir) => {
				expect(runEngine(python, "! true", dir).frame.exitCode).toBe(1);
				expect(runEngine(python, "! false", dir).frame.exitCode).toBe(0);
			});
		});

		it("subshell: cd/export do not leak", () => {
			withTmpDir((dir) => {
				const { frame } = runEngine(python, "( cd / && export FOO=bar )", dir);
				expect(frame.cwd).toBe(dir);
				expect(frame.envDelta.FOO).toBeUndefined();
			});
		});

		it("brace group: cd/export DO persist", () => {
			withTmpDir((dir) => {
				// The corpus target must be a directory guaranteed to exist on both POSIX and
				// win32 — hardcoding "/tmp" only holds on POSIX. Use a per-test tmp subdirectory
				// created by the harness and pass it into the command, quoted.
				const target = mkdtempSync(join(tmpdir(), "pi-conformance-brace-"));
				const { frame } = runEngine(python, `{ cd "${target}" ; export FOO=bar ; }`, dir);
				if (process.platform === "win32") {
					expect(frame.cwd.replace(/\//g, "\\").toLowerCase()).toBe(target.replace(/\//g, "\\").toLowerCase());
				} else {
					expect(frame.cwd).toBe(target);
				}
				expect(frame.envDelta.FOO).toBe("bar");
			});
		});

		it("for loop: explicit values expand through printf and preserve the final value", () => {
			withTmpDir((dir) => {
				const { stdout, frame } = runEngine(
					python,
					`for item in one "two words"; do printf '[%s]\\n' "$item"; done`,
					dir,
				);
				expect(stdout).toBe("[one]\n[two words]\n");
				expect(frame.exitCode).toBe(0);
				expect(frame.envDelta.item).toBe("two words");
			});
		});

		it.each([
			[">", "out.txt"],
			[">>", "out.txt"],
			["1>", "out.txt"],
			["1>>", "out.txt"],
		])("redirect out: %s", (op, file) => {
			withTmpDir((dir) => {
				const target = join(dir, file);
				const { frame } = runEngine(python, `echo hi ${op} ${target}`, dir);
				expect(frame.exitCode).toBe(0);
				const content = spawnSync(python, ["-c", `print(open(${JSON.stringify(target)}).read(), end="")`], {
					encoding: "utf-8",
				});
				expect(normalizeChildOutput(content.stdout)).toBe("hi\n");
			});
		});

		it("redirect in: <", () => {
			withTmpDir((dir) => {
				const src = join(dir, "in.txt");
				writeFileSync(src, "from-file\n");
				const { stdout } = runEngine(python, `cat < ${src}`, dir);
				expect(stdout).toBe("from-file\n");
			});
		});

		it("redirect err: 2>, 2>> (external command)", () => {
			withTmpDir((dir) => {
				const errFile = join(dir, "err.txt");
				const pyPath = python;
				runEngine(python, `${pyPath} -c 'import sys; sys.stderr.write("boom\\n")' 2> ${errFile}`, dir, {
					PATH: process.env.PATH ?? "",
				});
				const content = spawnSync(python, ["-c", `print(open(${JSON.stringify(errFile)}).read(), end="")`], {
					encoding: "utf-8",
				});
				expect(normalizeChildOutput(content.stdout)).toBe("boom\n");
			});
		});

		it("redirect dup: 2>&1", () => {
			withTmpDir((dir) => {
				const combined = join(dir, "combined.txt");
				runEngine(python, `${python} -c 'import sys; sys.stderr.write("err\\n")' > ${combined} 2>&1`, dir, {
					PATH: process.env.PATH ?? "",
				});
				const content = spawnSync(python, ["-c", `print(open(${JSON.stringify(combined)}).read(), end="")`], {
					encoding: "utf-8",
				});
				expect(normalizeChildOutput(content.stdout)).toBe("err\n");
			});
		});

		it("quote single: literal, no expansion", () => {
			withTmpDir((dir) => {
				expect(runEngine(python, "echo 'lit $HOME'", dir, { HOME: "/nope" }).stdout).toBe("lit $HOME\n");
			});
		});

		it("quote double: $-expansion yes, no glob/split", () => {
			withTmpDir((dir) => {
				expect(runEngine(python, 'echo "val: $X"', dir, { X: "a b" }).stdout).toBe("val: a b\n");
			});
		});

		it("quote backslash: \\x escapes next char", () => {
			withTmpDir((dir) => {
				expect(runEngine(python, "echo \\$HOME", dir, { HOME: "/nope" }).stdout).toBe("$HOME\n");
			});
		});

		it("ANSI-C quote: $'...'", () => {
			withTmpDir((dir) => {
				expect(runEngine(python, "echo $'a\\nb'", dir).stdout).toBe("a\nb\n");
			});
		});

		it("tilde: ~ and ~/x expand to $HOME", () => {
			withTmpDir((dir) => {
				const home = mkdtempSync(join(tmpdir(), "pi-home-"));
				expect(runEngine(python, "echo ~", dir, { HOME: home }).stdout).toBe(`${home}\n`);
				expect(runEngine(python, "echo ~/x", dir, { HOME: home }).stdout).toBe(`${home}/x\n`);
			});
		});

		it("param: $VAR, unset -> empty", () => {
			withTmpDir((dir) => {
				expect(runEngine(python, "echo $VAR", dir, { VAR: "hi" }).stdout).toBe("hi\n");
				expect(runEngine(python, "echo [$UNSET]", dir).stdout).toBe("[]\n");
			});
		});

		it.each([
			[":-", "echo ${V:-fallback}", {}, "fallback\n"],
			[":+", "echo ${V:+alt}", { V: "x" }, "alt\n"],
		])("param default/alt: %s", (_op, command, env, expected) => {
			withTmpDir((dir) => {
				expect(runEngine(python, command, dir, env as Record<string, string>).stdout).toBe(expected);
			});
		});

		it("${V:=w} assigns and reflects in envDelta", () => {
			withTmpDir((dir) => {
				const { stdout, frame } = runEngine(python, "echo ${V:=assigned}", dir);
				expect(stdout).toBe("assigned\n");
				expect(frame.envDelta.V).toBe("assigned");
			});
		});

		it("${MISSING:?msg} yields named bash-style error, exit 1, unsupported null", () => {
			withTmpDir((dir) => {
				const { stdout, frame } = runEngine(python, "echo ${MISSING:?msg}", dir);
				expect(stdout).toBe("bash: MISSING: msg\n");
				expect(frame.exitCode).toBe(1);
				expect(frame.unsupported).toBeNull();
			});
		});

		it("param length: ${#VAR}", () => {
			withTmpDir((dir) => {
				expect(runEngine(python, "echo ${#VAR}", dir, { VAR: "abcde" }).stdout).toBe("5\n");
			});
		});

		it("command sub: $(...) and `...`", () => {
			withTmpDir((dir) => {
				expect(runEngine(python, "echo $(echo inner)", dir).stdout).toBe("inner\n");
				expect(runEngine(python, "echo `echo inner`", dir).stdout).toBe("inner\n");
			});
		});

		it("glob: * ? […] final-segment", () => {
			withTmpDir((dir) => {
				writeFileSync(join(dir, "a.txt"), "");
				writeFileSync(join(dir, "b.txt"), "");
				const { stdout } = runEngine(python, "echo *.txt", dir);
				expect(stdout.trim().split(" ").sort()).toEqual(["a.txt", "b.txt"]);
			});
		});

		it("word splitting: unquoted expansion splits on IFS whitespace", () => {
			withTmpDir((dir) => {
				expect(runEngine(python, "echo $X", dir, { X: "a b c" }).stdout).toBe("a b c\n");
			});
		});

		it("assignment (shell): standalone NAME=value sets engine env", () => {
			withTmpDir((dir) => {
				const { frame } = runEngine(python, "NAME=value", dir);
				expect(frame.envDelta.NAME).toBe("value");
			});
		});

		it("assignment (transient): NAME=value cmd applies only to cmd's environment (bash-faithful: the SAME line's own $NAME expansion is computed before the prefix assignment takes effect, so it stays empty)", () => {
			withTmpDir((dir) => {
				const { stdout, frame } = runEngine(python, "NAME=value echo $NAME", dir);
				expect(stdout).toBe("\n");
				expect(frame.envDelta.NAME).toBeUndefined();
			});
		});

		it("transient assignment IS visible to a child process reading its own env (unlike the same line's $NAME expansion)", () => {
			withTmpDir((dir) => {
				const { stdout } = runEngine(
					python,
					`NAME=value ${python} -c 'import os; print(os.environ.get("NAME",""))'`,
					dir,
					{ PATH: process.env.PATH ?? "" },
				);
				expect(stdout.trim()).toBe("value");
			});
		});
	});

	describe("§2.2 builtins (C-marked and D-marked rows)", () => {
		it("cd/export/OLDPWD state carried in envDelta/cwd", () => {
			withTmpDir((dir) => {
				const sub = mkdtempSync(join(dir, "sub-"));
				const first = runEngine(python, `cd ${sub}`, dir, { HOME: dir });
				expect(first.frame.cwd).toBe(sub);
				expect(first.frame.envDelta.OLDPWD).toBe(dir);
				const back = runEngine(python, "cd -", sub, { OLDPWD: dir, HOME: dir });
				expect(back.stdout).toBe(`${dir}\n`);
				expect(back.frame.cwd).toBe(dir);
			});
		});

		it("pwd, pwd -P", () => {
			withTmpDir((dir) => {
				expect(runEngine(python, "pwd", dir).stdout).toBe(`${dir}\n`);
				expect(runEngine(python, "pwd -P", dir).stdout).toBe(`${dir}\n`);
			});
		});

		it("echo -n, -e", () => {
			withTmpDir((dir) => {
				expect(runEngine(python, "echo -n hi", dir).stdout).toBe("hi");
				expect(runEngine(python, "echo -e a\\\\nb", dir).stdout).toBe("a\nb\n");
			});
		});

		it("printf with conversions", () => {
			withTmpDir((dir) => {
				expect(runEngine(python, 'printf "%s-%d\\n" foo 3', dir).stdout).toBe("foo-3\n");
			});
		});

		it("export/unset reflected in envDelta", () => {
			withTmpDir((dir) => {
				expect(runEngine(python, "export FOO=bar", dir).frame.envDelta.FOO).toBe("bar");
				expect(runEngine(python, "unset FOO", dir, { FOO: "bar" }).frame.envDelta.FOO).toBeNull();
			});
		});

		it("true/false exit codes", () => {
			withTmpDir((dir) => {
				expect(runEngine(python, "true", dir).frame.exitCode).toBe(0);
				expect(runEngine(python, "false", dir).frame.exitCode).toBe(1);
			});
		});

		it("which resolves in PATH, not-found -> exit 1", () => {
			withTmpDir((dir) => {
				const bin = mkdtempSync(join(tmpdir(), "pi-bin-"));
				// PATHEXT gates executable resolution on win32: an extension-less file is
				// correctly rejected there (engine behavior, not a bug), so the fixture must
				// create a PATHEXT-valid executable on that platform and keep the
				// extension-less form (valid via the POSIX execute bit) on POSIX.
				const target = process.platform === "win32" ? join(bin, "mytool.bat") : join(bin, "mytool");
				if (process.platform === "win32") {
					writeFileSync(target, "@echo hi\r\n");
				} else {
					writeFileSync(target, "#!/bin/sh\necho hi\n", { mode: 0o755 });
				}
				const found = runEngine(python, "which mytool", dir, { PATH: bin });
				if (process.platform === "win32") {
					expect(found.stdout.trim().toLowerCase()).toBe(target.toLowerCase());
				} else {
					expect(found.stdout.trim()).toBe(target);
				}
				const notFound = runEngine(python, "which doesnotexist123", dir, { PATH: bin });
				expect(notFound.frame.exitCode).toBe(1);
				expect(notFound.stdout).toBe("");
			});
		});

		it("test/[ unary and string/int comparisons", () => {
			withTmpDir((dir) => {
				expect(runEngine(python, "test -d .", dir).frame.exitCode).toBe(0);
				expect(runEngine(python, "test 1 -eq 1", dir).frame.exitCode).toBe(0);
				expect(runEngine(python, "[ a = b ]", dir).frame.exitCode).toBe(1);
			});
		});

		it("ls sorted output, dirs suffixed / (C-marked divergence)", () => {
			withTmpDir((dir) => {
				writeFileSync(join(dir, "b.txt"), "");
				writeFileSync(join(dir, "a.txt"), "");
				const { stdout } = runEngine(python, "ls -1", dir);
				expect(stdout).toBe("a.txt\nb.txt\n");
			});
		});

		it("ls -la accepts the ubiquitous long/all spelling without leaving the Python tier", () => {
			withTmpDir((dir) => {
				writeFileSync(join(dir, ".hidden"), "");
				writeFileSync(join(dir, "visible"), "");
				const { frame, stdout } = runEngine(python, "ls -la", dir);
				expect(frame.exitCode).toBe(0);
				expect(frame.unsupported).toBeNull();
				// Long format now, like coreutils: one mode-led line per entry, hidden entries included.
				const lines = stdout.split("\n").filter(Boolean);
				expect(lines.map((line) => line.split(/\s+/).at(-1))).toEqual([".", "..", ".hidden", "visible"]);
				expect(lines.every((line) => /^[-dl][rwx-]{9} /.test(line))).toBe(true);
			});
		});

		it("heredocs, here-strings and nested shells run instead of refusing", () => {
			withTmpDir((dir) => {
				const heredoc = runEngine(python, "cat <<EOF\nhello\nworld\nEOF", dir);
				expect(heredoc.frame.unsupported).toBeNull();
				expect(heredoc.stdout).toBe("hello\nworld\n");
				const hereString = runEngine(python, "cat <<< 'one line'", dir);
				expect(hereString.stdout).toBe("one line\n");
				const nested = runEngine(python, "sh -c 'echo nested ok'", dir);
				expect(nested.frame.unsupported).toBeNull();
				if (nested.frame.exitCode === 0) expect(nested.stdout).toBe("nested ok\n");
				else expect(nested.frame.exitCode).toBe(127);
			});
		});

		it("cat byte-exact concatenation", () => {
			withTmpDir((dir) => {
				writeFileSync(join(dir, "f1.txt"), "one\n");
				writeFileSync(join(dir, "f2.txt"), "two\n");
				expect(runEngine(python, "cat f1.txt f2.txt", dir).stdout).toBe("one\ntwo\n");
			});
		});

		it("head/tail -n N", () => {
			withTmpDir((dir) => {
				writeFileSync(join(dir, "lines.txt"), "1\n2\n3\n4\n");
				expect(runEngine(python, "head -n 2 lines.txt", dir).stdout).toBe("1\n2\n");
				expect(runEngine(python, "tail -n 2 lines.txt", dir).stdout).toBe("3\n4\n");
			});
		});

		it("grep with a relative FILE operand resolves against ctx.cwd, not the engine process's OS cwd", () => {
			withTmpDir((dir) => {
				writeFileSync(join(dir, "g.txt"), "abc\nxyz\n");
				expect(runEngine(python, "grep -F abc g.txt", dir).stdout).toBe("abc\n");
			});
		});

		it("grep -F fixed and regex form work when the request cwd happens to equal the process cwd (C-marked regex; see FINDING above for the relative-path cwd bug)", () => {
			const dir = process.cwd();
			const marker = join(dir, `pi-conformance-grep-${process.pid}.txt`);
			writeFileSync(marker, "abc\nxyz\n");
			try {
				const relative = marker.slice(dir.length + 1);
				expect(runEngine(python, `grep -F abc ${relative}`, dir).stdout).toBe("abc\n");
				expect(runEngine(python, `grep '^a.c$' ${relative}`, dir).stdout).toBe("abc\n");
			} finally {
				spawnSync(python, ["-c", `import os; os.remove(${JSON.stringify(marker)})`]);
			}
		});

		it("find -type f -name GLOB (C-marked divergence)", () => {
			withTmpDir((dir) => {
				writeFileSync(join(dir, "a.py"), "");
				const { stdout } = runEngine(python, "find . -type f -name *.py", dir);
				expect(stdout.trim()).toBe("./a.py");
			});
		});

		it("rm -f / -r", () => {
			withTmpDir((dir) => {
				expect(runEngine(python, "rm -f nope.txt", dir).frame.exitCode).toBe(0);
				const sub = join(dir, "subdir");
				spawnSync(python, ["-c", `import os; os.mkdir(${JSON.stringify(sub)})`]);
				expect(runEngine(python, "rm -r subdir", dir).frame.exitCode).toBe(0);
			});
		});

		it("cp/mv/mkdir/touch", () => {
			withTmpDir((dir) => {
				writeFileSync(join(dir, "src.txt"), "hi");
				expect(runEngine(python, "cp src.txt dst.txt", dir).frame.exitCode).toBe(0);
				expect(runEngine(python, "mv dst.txt moved.txt", dir).frame.exitCode).toBe(0);
				expect(runEngine(python, "mkdir -p newdir/nested", dir).frame.exitCode).toBe(0);
				expect(runEngine(python, "touch touched.txt", dir).frame.exitCode).toBe(0);
			});
		});

		it("wc single-flag stdin form -> bare int (D); multi-count/file form -> columns (C)", () => {
			withTmpDir((dir) => {
				const { stdout } = runEngine(python, 'printf "a\\nb\\nc\\n" | wc -l', dir);
				expect(stdout.trim()).toBe("3");
				writeFileSync(join(dir, "wc.txt"), "a b\nc d\n");
				const multi = runEngine(python, "wc wc.txt", dir);
				expect(multi.stdout).toContain("wc.txt");
			});
		});

		it("sort default ordinal ascending, -r, -n, -u", () => {
			withTmpDir((dir) => {
				expect(runEngine(python, 'printf "b\\na\\nc\\n" | sort', dir).stdout).toBe("a\nb\nc\n");
				expect(runEngine(python, 'printf "1\\n10\\n2\\n" | sort -n', dir).stdout).toBe("1\n2\n10\n");
			});
		});

		it("uniq plain (D) and -c (C)", () => {
			withTmpDir((dir) => {
				expect(runEngine(python, 'printf "a\\na\\nb\\n" | uniq', dir).stdout).toBe("a\nb\n");
				const withCount = runEngine(python, 'printf "a\\na\\nb\\n" | uniq -c', dir);
				expect(withCount.stdout).toContain("a");
			});
		});

		it("cut -d/-f and -c", () => {
			withTmpDir((dir) => {
				expect(runEngine(python, 'printf "a,b,c\\n" | cut -d , -f 2', dir).stdout).toBe("b\n");
				expect(runEngine(python, 'printf "abcdef\\n" | cut -c 1-3', dir).stdout).toBe("abc\n");
			});
		});

		it("tr ranges, -d, -s", () => {
			withTmpDir((dir) => {
				expect(runEngine(python, 'printf "abc\\n" | tr a-c A-C', dir).stdout).toBe("ABC\n");
				expect(runEngine(python, 'printf "aabbcc\\n" | tr -s abc', dir).stdout).toBe("abc\n");
			});
		});

		it("basename/dirname", () => {
			withTmpDir((dir) => {
				expect(runEngine(python, "basename /a/b/c.txt", dir).stdout).toBe("c.txt\n");
				expect(runEngine(python, "dirname /a/b/c.txt", dir).stdout).toBe("/a/b\n");
			});
		});

		it("sed s/// fixed (D) and regex (C)", () => {
			withTmpDir((dir) => {
				expect(runEngine(python, 'printf "abc\\n" | sed s/b/X/', dir).stdout).toBe("aXc\n");
				expect(runEngine(python, 'printf "abc\\n" | sed "s/[ab]/X/g"', dir).stdout).toBe("XXc\n");
			});
		});

		it("xargs simple (D) and complex -I form (C)", () => {
			withTmpDir((dir) => {
				expect(runEngine(python, "echo one | xargs echo", dir).stdout).toBe("one\n");
				expect(runEngine(python, "echo one | xargs -I {} echo got-{}", dir).stdout).toBe("got-one\n");
			});
		});

		it("three-stage builtin pipeline (architect smoke probe)", () => {
			withTmpDir((dir) => {
				const { stdout, frame } = runEngine(python, 'printf "%s\\n" one two three | grep t | sort -r', dir);
				expect(stdout).toBe("two\nthree\n");
				expect(frame.exitCode).toBe(0);
			});
		});
	});

	describe("§2.3 structured refusals (every named id)", () => {
		it.each([
			["job-control", "foo &"],
			["process-substitution", "foo <(bar)"],
			["exec-builtin", "exec foo"],
			["control-flow", "select x in a b; do echo $x; done"],
			["extended-glob", "foo @(a|b)"],
			["unsupported-builtin", "eval foo"],
			["unsupported-flag", "ls -Z"],
			["tilde-user", "echo ~someuser"],
			["malformed-syntax", ")"],
			["malformed-syntax", "echo 'unterminated"],
			["parameter-expansion", "echo ${!VAR}"],
			["array", "arr=(a b)"],
		])("construct id: %s (%s)", (construct, command) => {
			withTmpDir((dir) => {
				const { frame, stdout } = runEngine(python, command, dir, { HOME: dir });
				expect(frame.exitCode).toBe(2);
				expect(frame.unsupported).not.toBeNull();
				expect(frame.unsupported?.code).toBe("unsupported");
				expect(frame.unsupported?.construct).toBe(construct);
				expect(stdout).toContain(frame.unsupported?.message ?? " never-matches ");
			});
		});

		it("arithmetic expansion, ((...)) commands, and let evaluate end-to-end instead of refusing", () => {
			// `arithmetic-expansion` stays in the frozen catalog, but the engine no longer raises it.
			withTmpDir((dir) => {
				const command = 'x=5; echo $((x*2+1)) "$(( x - 6 ))"; ((x>3)) && echo big; let "x+=1"; echo $x';
				const { frame, stdout } = runEngine(python, command, dir, { HOME: dir });
				expect(frame.unsupported).toBeNull();
				expect(frame.exitCode).toBe(0);
				expect(stdout).toBe("11 -1\nbig\n6\n");
			});
		});

		it("a control-flow refusal frame carries exit 2 and no partial output", () => {
			withTmpDir((dir) => {
				const { frame, stdout } = runEngine(python, "select x in a b; do echo reached; done", dir);
				expect(frame.exitCode).toBe(2);
				expect(frame.unsupported?.construct).toBe("control-flow");
				expect(stdout.length).toBeGreaterThan(0);
			});
		});

		it("functions, case, [[ ]], brace expansion, and command -v execute end-to-end instead of refusing", () => {
			withTmpDir((dir) => {
				writeFileSync(join(dir, "a.txt"), "x\n");
				const command = [
					'greet() { local who="$1"; printf "hi %s (%d)\\n" "$who" "$#"; return 3; }',
					"greet you extra; echo rc=$?; echo who=$who",
					'kind() { case "$1" in *.txt) echo text;; *.log|*.out) echo log;& *) echo tail;; esac; }',
					"kind a.txt; kind b.log; kind c.bin",
					'[[ -f a.txt && ! -d a.txt && "$PWD" == *"" ]] && echo cond',
					"v=abc123; [[ $v =~ ^[a-z]+[0-9]+$ ]] && echo re",
					"echo {a,b}{1..2} {01..03}",
					'f=/p/q/file.tar.gz; echo "${f##*/} ${f%%.*} ${f/q/Q}"',
					"command -v greet; command -v echo; command -v no-such-tool-xyz || echo missing",
				].join("\n");
				const { frame, stdout } = runEngine(python, command, dir, { HOME: dir, PATH: process.env.PATH ?? "" });
				expect(frame.unsupported).toBeNull();
				expect(frame.exitCode).toBe(0);
				expect(stdout).toBe(
					[
						"hi you (2)",
						"rc=3",
						"who=",
						"text",
						"log",
						"tail",
						"tail",
						"cond",
						"re",
						"a1 a2 b1 b2 01 02 03",
						"file.tar.gz /p/q/file /p/Q/file.tar.gz",
						"greet",
						"echo",
						"missing",
						"",
					].join("\n"),
				);
			});
		});

		it("set -e/-u/-x/-o pipefail follow bash, set -- assigns positional parameters, other options refuse by name", () => {
			withTmpDir((dir) => {
				const errexit = runEngine(python, "set -e; false; echo not-reached", dir);
				expect(errexit.frame.exitCode).toBe(1);
				expect(errexit.stdout).toBe("");
				const tested = runEngine(
					python,
					"set -e; false || echo handled; if false; then :; fi; ! false; echo after",
					dir,
				);
				expect(tested.stdout).toBe("handled\nafter\n");
				const nounset = runEngine(python, 'set -u; echo "${X:-fallback}"; echo "$UNSET_Y"; echo not-reached', dir);
				expect(nounset.stdout).toContain("fallback\n");
				expect(nounset.stdout).toContain("UNSET_Y: unbound variable");
				expect(nounset.stdout).not.toContain("not-reached");
				const pipefail = runEngine(
					python,
					"set -o pipefail; false | true; echo rc=$?; set +o pipefail; false | true; echo rc=$?",
					dir,
				);
				expect(pipefail.stdout).toBe("rc=1\nrc=0\n");
				const xtrace = runEngine(python, "set -x; echo hi", dir);
				expect(xtrace.stdout).toBe("+ echo hi\nhi\n");
				const combined = runEngine(python, "set -euo pipefail; set -- a b; echo $# $1", dir);
				expect(combined.frame.unsupported).toBeNull();
				expect(combined.stdout).toBe("2 a\n");
				const unknown = runEngine(python, "set -k", dir);
				expect(unknown.frame.unsupported?.construct).toBe("unsupported-flag");
			});
		});

		it("a redirect target that cannot be opened fails only its command with a bash-style message", () => {
			withTmpDir((dir) => {
				const missing = join(dir, "no-such-dir", "out.txt").replaceAll("\\", "/");
				const { frame, stdout } = runEngine(
					python,
					`echo hi > '${missing}'; echo rc=$?; ls . 2>'${missing}' | head -1; echo after`,
					dir,
				);
				expect(frame.unsupported).toBeNull();
				// The message names the resolved target (OS-native separators on Windows), then the reason.
				expect(stdout).toMatch(/bash: .*no-such-dir.*out\.txt: No such file or directory/u);
				expect(stdout).toContain("rc=1");
				expect(stdout).toContain("after");
				expect(stdout).not.toContain("Traceback");
			});
		});

		it("returns when the direct child exits even if a grandchild keeps the inherited output pipe open", () => {
			withTmpDir((dir) => {
				// The parent spawns a detached grandchild that inherits stdout for 6 s, prints, and exits;
				// bash returns at the parent's exit, and so must the engine (a live Windows hang).
				const command =
					`${python} -c "import subprocess, sys; ` +
					"subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(6)'], stdin=subprocess.DEVNULL); " +
					"print('parent-exiting')\"";
				const started = Date.now();
				const { frame, stdout } = runEngine(python, command, dir, { PATH: process.env.PATH ?? "" });
				expect(Date.now() - started).toBeLessThan(4_000);
				expect(frame.unsupported).toBeNull();
				expect(frame.exitCode).toBe(0);
				expect(stdout.replace(/\r\n/g, "\n")).toBe("parent-exiting\n");
			});
		}, 8_000);

		it("a leading & (PowerShell's call operator) is refused with the dialect named", () => {
			withTmpDir((dir) => {
				const { frame } = runEngine(python, '& "C:/Program Files/Tool/tool.exe" --version', dir);
				expect(frame.exitCode).toBe(2);
				expect(frame.unsupported?.construct).toBe("malformed-syntax");
				expect(frame.unsupported?.message).toContain("PowerShell's call operator");
			});
		});

		it("cwd-missing: request cwd does not exist", () => {
			const missing = join(tmpdir(), "pi-conformance-missing-dir-does-not-exist");
			const { frame } = runEngine(python, "echo hi", missing);
			expect(frame.exitCode).toBe(2);
			expect(frame.unsupported?.construct).toBe("cwd-missing");
		});
	});

	describe("process-exit contract", () => {
		it("the engine process exits 0 with a parseable frame in every non-crash case, success or refusal", () => {
			withTmpDir((dir) => {
				expect(runEngine(python, "echo ok", dir).status).toBe(0);
				expect(runEngine(python, "eval foo", dir).status).toBe(0);
			});
		});
	});
});
