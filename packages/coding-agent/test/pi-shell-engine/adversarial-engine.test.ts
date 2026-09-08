import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Adversarial coverage for the Windows bash tool's Python shell engine
// (src/bundled-resources/runtimes/pi-shell-engine/), driven through the REAL persistent
// coordinator (main.py) rather than a fake expander, so parameter expansion, globbing,
// tilde/$HOME, and arithmetic all run through their production implementations. This is a
// deliberately different harness shape from executor.test.ts's inline HARNESS string (which
// fakes expand_word and a tiny builtin table): here we spawn the shipped `main.py` entry
// point directly and speak its real newline-delimited request / record-separator response
// protocol, so nothing here duplicates that file's embedded Python source.
const ENGINE_DIR = join(import.meta.dirname, "..", "..", "src", "bundled-resources", "runtimes", "pi-shell-engine");
const MAIN_PY = join(ENGINE_DIR, "main.py");
const RS = "\x1e";

function findPython(): string | null {
	const candidates = process.env.PI_TEST_PYTHON
		? [process.env.PI_TEST_PYTHON, "python3", "python"]
		: ["python3", "python"];
	for (const candidate of candidates) {
		if (spawnSync(candidate, ["--version"], { encoding: "utf-8" }).status === 0) return candidate;
	}
	return null;
}

interface EngineResult {
	stdout: string;
	exitCode: number;
	cwd: string;
	envDelta: Record<string, string | null>;
	refused: boolean;
	construct?: string;
	message?: string;
}

/**
 * Runs one whole command line through the shipped main.py coordinator as a single
 * newline-terminated JSON request, then parses its stderr control frame (bracketed by two
 * 0x1e record-separator bytes) back out. A frame carrying a non-null `unsupported` field is
 * surfaced as `{ refused: true, construct, message }`, matching the shape asked of every
 * assertion in this file.
 */
function runLine(python: string, command: string, cwd: string, env: Record<string, string> = {}): EngineResult {
	const request = { command, cwd, env: { PATH: process.env.PATH ?? "", ...env } };
	const proc = spawnSync(python, ["-B", MAIN_PY], {
		encoding: "utf-8",
		input: `${JSON.stringify(request)}\n`,
		maxBuffer: 16 * 1024 * 1024,
	});
	if (proc.error) throw proc.error;
	const control = proc.stderr;
	const first = control.indexOf(RS);
	const second = control.indexOf(RS, first + 1);
	if (first === -1 || second === -1) {
		throw new Error(
			`no control frame from main.py for ${JSON.stringify(command)}: stdout=${proc.stdout} stderr=${control}`,
		);
	}
	const frame = JSON.parse(control.slice(first + 1, second)) as {
		exitCode: number;
		cwd: string;
		envDelta: Record<string, string | null>;
		unsupported: { construct: string; message: string } | null;
	};
	return {
		stdout: proc.stdout,
		exitCode: frame.exitCode,
		cwd: frame.cwd,
		envDelta: frame.envDelta,
		refused: frame.unsupported !== null,
		construct: frame.unsupported?.construct,
		message: frame.unsupported?.message,
	};
}

function tempDir(prefix = "pi-adversarial-"): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function readFile(python: string, path: string): string {
	const result = spawnSync(
		python,
		["-c", `import sys; sys.stdout.write(open(${JSON.stringify(path)}, "rb").read().decode("utf-8", "replace"))`],
		{
			encoding: "utf-8",
		},
	);
	return result.stdout;
}

const python = findPython();

describe("pi-shell-engine adversarial", () => {
	if (!python) {
		it.skip("no Python interpreter available", () => {});
		return;
	}
	const py: string = python;
	const win32 = process.platform === "win32";

	function assertNoCrash(result: EngineResult): void {
		expect(result.stdout).not.toContain("Traceback");
		expect(result.stdout).not.toContain("shell engine internal error");
	}

	describe("1. quoting", () => {
		it("nested double quotes with an escaped inner quote unescape to one literal quote", () => {
			const result = runLine(py, 'echo "a\\"b"', tempDir());
			expect(result.stdout).toBe('a"b\n');
			expect(result.exitCode).toBe(0);
		});

		it("backslashes inside a double-quoted Windows-style path stay literal", () => {
			const result = runLine(py, 'echo "D:\\\\x\\\\y"', tempDir());
			expect(result.stdout).toBe("D:\\x\\y\n");
			expect(result.exitCode).toBe(0);
		});

		it("$'a\\tb' expands the ANSI-C escape to a real tab", () => {
			const result = runLine(py, "echo $'a\\tb'", tempDir());
			expect(result.stdout).toBe("a\tb\n");
			expect(result.exitCode).toBe(0);
		});

		it('a standalone escaped \\" unescapes to a literal quote character', () => {
			const result = runLine(py, 'echo \\"quoted\\"', tempDir());
			expect(result.stdout).toBe('"quoted"\n');
			expect(result.exitCode).toBe(0);
		});

		it("a single-quoted string containing $var does NOT expand", () => {
			const result = runLine(py, "A=set; echo 'value=$A'", tempDir());
			expect(result.stdout).toBe("value=$A\n");
			expect(result.exitCode).toBe(0);
		});

		it("a double-quoted string containing $var DOES expand", () => {
			const result = runLine(py, 'A=set; echo "value=$A"', tempDir());
			expect(result.stdout).toBe("value=set\n");
			expect(result.exitCode).toBe(0);
		});

		it("adjacent quoted fragments 'a'\"b\"c concatenate into one word", () => {
			const result = runLine(py, "echo 'a'\"b\"c", tempDir());
			expect(result.stdout).toBe("abc\n");
			expect(result.exitCode).toBe(0);
		});
	});

	describe("2. line endings", () => {
		it("CRLF between commands behaves like LF", () => {
			const result = runLine(py, "echo a\r\necho b\r\n", tempDir());
			expect(result.stdout).toBe("a\nb\n");
			expect(result.exitCode).toBe(0);
		});

		it("a trailing CRLF after the last command does not change behavior", () => {
			const withCrlf = runLine(py, "echo only\r\n", tempDir());
			const withLf = runLine(py, "echo only\n", tempDir());
			expect(withCrlf.stdout).toBe(withLf.stdout);
			expect(withCrlf.exitCode).toBe(withLf.exitCode);
		});

		it("CRLF-separated sequencing preserves state across commands (assignment then use)", () => {
			const result = runLine(py, "A=1\r\nexport A\r\necho $A\r\n", tempDir());
			expect(result.stdout).toBe("1\n");
			expect(result.envDelta.A).toBe("1");
		});

		it("CRLF-separated && list preserves short-circuit semantics", () => {
			const result = runLine(py, "true && echo yes\r\nfalse && echo no\r\n", tempDir());
			expect(result.stdout).toBe("yes\n");
			expect(result.exitCode).toBe(1);
		});

		it("a lone CR without LF inside an otherwise normal line does not crash the engine", () => {
			const result = runLine(py, "echo before\recho after", tempDir());
			assertNoCrash(result);
		});

		it("CRLF around a pipeline behaves like LF", () => {
			const dir = tempDir();
			const crlf = runLine(py, "echo hi\r\n | cat\r\n", dir, { PATH: process.env.PATH ?? "" });
			const lf = runLine(py, "echo hi\n | cat\n", dir, { PATH: process.env.PATH ?? "" });
			expect(crlf.stdout).toBe(lf.stdout);
		});
	});

	describe("3. paths with spaces, parentheses, and unicode", () => {
		const dir = tempDir();
		const parenDir = "(Repo 7 v7";
		const uniDir = "日本語";
		mkdirSync(join(dir, parenDir));
		mkdirSync(join(dir, uniDir));
		writeFileSync(join(dir, parenDir, "x.txt"), "hello");
		writeFileSync(join(dir, uniDir, "y.txt"), "world");

		it("ls on a bare-quoted parenthesized directory name lists its contents", () => {
			const result = runLine(py, `ls "${parenDir}"`, dir);
			expect(result.stdout).toBe("x.txt\n");
			expect(result.exitCode).toBe(0);
		});

		it("cd into the parenthesized directory then globbing *.txt finds the file", () => {
			const result = runLine(py, `cd '${parenDir}' && ls *.txt`, dir);
			expect(result.stdout).toBe("x.txt\n");
			expect(result.cwd).toBe(join(dir, parenDir));
		});

		it("cat reads a file inside the parenthesized directory via a double-quoted path", () => {
			const result = runLine(py, `cat "${parenDir}/x.txt"`, dir);
			expect(result.stdout).toBe("hello");
			expect(result.exitCode).toBe(0);
		});

		it("ls on a bare-quoted unicode directory name lists its contents", () => {
			const result = runLine(py, `ls "${uniDir}"`, dir);
			expect(result.stdout).toBe("y.txt\n");
			expect(result.exitCode).toBe(0);
		});

		it("cat reads a file inside the unicode directory", () => {
			const result = runLine(py, `cat "${uniDir}/y.txt"`, dir);
			expect(result.stdout).toBe("world");
			expect(result.exitCode).toBe(0);
		});

		it("a nonexistent path under the parenthesized directory is a plain fs error, not a crash", () => {
			const result = runLine(py, `ls "${parenDir}/missing.txt" 2>&1`, dir);
			assertNoCrash(result);
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toContain("No such file or directory");
		});
	});

	describe("4. redirections", () => {
		it("> writes into a file whose name has a space, and the content is exact", () => {
			const dir = tempDir();
			const result = runLine(py, "echo hello > 'out file.txt'", dir);
			expect(result.stdout).toBe("");
			expect(result.exitCode).toBe(0);
			expect(readFile(py, join(dir, "out file.txt"))).toBe("hello\n");
		});

		it(">> appends across two invocations", () => {
			const dir = tempDir();
			runLine(py, "echo one > out.txt", dir);
			runLine(py, "echo two >> out.txt", dir);
			expect(readFile(py, join(dir, "out.txt"))).toBe("one\ntwo\n");
		});

		it("2>&1 merges stderr into the redirected file", () => {
			const dir = tempDir();
			const command = `${py} -c 'import sys; sys.stderr.write("err\\n")' > combined.txt 2>&1`;
			runLine(py, command, dir);
			expect(readFile(py, join(dir, "combined.txt"))).toBe("err\n");
		});

		it("2>/dev/null discards stderr and keeps stdout clean", () => {
			const dir = tempDir();
			const command = `${py} -c 'import sys; sys.stderr.write("noisy\\n"); print("kept")' 2>/dev/null`;
			const result = runLine(py, command, dir);
			expect(result.stdout).toBe("kept\n");
			expect(result.exitCode).toBe(0);
		});

		it("< reads a file as stdin for an external command", () => {
			const dir = tempDir();
			writeFileSync(join(dir, "in.txt"), "from-file\n");
			const command = `${py} -c 'import sys; print(sys.stdin.read().strip())' < in.txt`;
			const result = runLine(py, command, dir);
			expect(result.stdout).toBe("from-file\n");
		});

		it("> file 2>&1 | ... redirects the producer fully to the file, leaving the pipe empty", () => {
			const dir = tempDir();
			const result = runLine(py, "echo a > out.txt 2>&1 | cat", dir);
			expect(result.stdout).toBe("");
			expect(readFile(py, join(dir, "out.txt"))).toBe("a\n");
		});

		it("> into a file inside a unicode directory writes and reads back the exact content", () => {
			const dir = tempDir();
			mkdirSync(join(dir, "日本語"));
			runLine(py, 'echo hi > "日本語/out.txt"', dir);
			expect(readFile(py, join(dir, "日本語", "out.txt"))).toBe("hi\n");
		});
	});

	describe("5. pipelines and lists", () => {
		it("builtin | external | builtin chains through the pipe correctly", () => {
			const dir = tempDir();
			const command = `printf 'l1\\nl2\\n' | ${py} -c 'import sys; print(sys.stdin.read().strip().upper())' | wc -l`;
			const result = runLine(py, command, dir);
			expect(result.stdout.trim()).toBe("2");
			expect(result.exitCode).toBe(0);
		});

		it("false | true exits 0 (status is the last pipeline element)", () => {
			const result = runLine(py, "false | true; echo $?", tempDir());
			expect(result.stdout).toBe("0\n");
		});

		it("a && b || c follows bash left-to-right precedence in both branches", () => {
			const dir = tempDir();
			expect(runLine(py, "true && echo a || echo b", dir).stdout).toBe("a\n");
			expect(runLine(py, "false && echo a || echo b", dir).stdout).toBe("b\n");
		});

		it("! negates the exit status of the following command", () => {
			const dir = tempDir();
			expect(runLine(py, "! true; echo $?", dir).stdout).toBe("1\n");
			expect(runLine(py, "! false; echo $?", dir).stdout).toBe("0\n");
		});

		it("; sequences unconditionally regardless of the first command's status", () => {
			const result = runLine(py, "false ; echo still-ran", tempDir());
			expect(result.stdout).toBe("still-ran\n");
			expect(result.exitCode).toBe(0);
		});

		it("cd sub; pwd persists the directory change across the semicolon", () => {
			const dir = tempDir();
			mkdirSync(join(dir, "sub"));
			const result = runLine(py, "cd sub; pwd", dir);
			expect(result.stdout).toBe(`${join(dir, "sub")}\n`);
			expect(result.cwd).toBe(join(dir, "sub"));
		});

		it("cd sub && pwd also persists the directory change", () => {
			const dir = tempDir();
			mkdirSync(join(dir, "sub"));
			const result = runLine(py, "cd sub && pwd", dir);
			expect(result.stdout).toBe(`${join(dir, "sub")}\n`);
			expect(result.cwd).toBe(join(dir, "sub"));
		});

		it("an empty subshell ( ) is a supported no-op, not a refusal", () => {
			const result = runLine(py, "( )", tempDir());
			expect(result.refused).toBe(false);
			expect(result.stdout).toBe("");
			expect(result.exitCode).toBe(0);
		});
	});

	describe("6. scripts and launchers", () => {
		function writeScript(dir: string, name: string, content: string): string {
			const path = join(dir, name);
			writeFileSync(path, content);
			chmodSync(path, 0o755);
			return path;
		}

		it("invokes a generated .cmd with a quoted space-containing argument", () => {
			const dir = tempDir();
			writeScript(dir, "hello.cmd", "@echo off\r\necho from cmd %1\r\n");
			const result = runLine(py, "./hello.cmd 'arg with space'", dir);
			assertNoCrash(result);
			if (win32) {
				expect(result.stdout).toContain("from cmd");
			} else {
				// No cmd.exe host on POSIX: proc.py wraps .cmd targets in `cmd /c`, which itself
				// fails to resolve, and exec.py reports the ORIGINAL argv[0] as not-found.
				expect(result.stdout).toBe("./hello.cmd: command not found\n");
				expect(result.exitCode).toBe(127);
			}
		});

		it("invokes a generated .bat with a quoted space-containing argument", () => {
			const dir = tempDir();
			writeScript(dir, "hello.bat", "@echo off\r\necho from bat %1\r\n");
			const result = runLine(py, "./hello.bat 'arg with space'", dir);
			assertNoCrash(result);
			if (win32) {
				expect(result.stdout).toContain("from bat");
			} else {
				expect(result.stdout).toBe("./hello.bat: command not found\n");
				expect(result.exitCode).toBe(127);
			}
		});

		it("invokes a generated .ps1 with a quoted space-containing argument", () => {
			const dir = tempDir();
			writeScript(dir, "hello.ps1", 'param($a)\r\nWrite-Output "from ps1 $a"\r\n');
			const result = runLine(py, "./hello.ps1 'arg with space'", dir);
			assertNoCrash(result);
			if (win32) {
				expect(result.stdout).toContain("from ps1");
			} else {
				// build_argv only routes .ps1 through a powershell host when one is configured or
				// the engine believes it's on Windows; on POSIX it direct-execs the script text,
				// which fails as a malformed executable, framed (never a traceback) as exit 1.
				expect(result.exitCode).toBe(1);
				expect(result.stdout).toContain("shell:");
			}
		});

		it("invokes a generated .py directly as an executable with a quoted space-containing argument", () => {
			const dir = tempDir();
			writeScript(dir, "hello.py", "#!/usr/bin/env python3\nimport sys\nprint('from py', sys.argv[1:])\n");
			const result = runLine(py, "./hello.py 'arg with space'", dir);
			assertNoCrash(result);
			if (win32) {
				expect(result.stdout).toContain("from py");
			} else {
				expect(result.stdout).toBe("from py ['arg with space']\n");
				expect(result.exitCode).toBe(0);
			}
		});

		it("invoking a .py through the interpreter explicitly always works, on every platform", () => {
			const dir = tempDir();
			writeFileSync(join(dir, "plain.py"), "import sys\nprint('via-interpreter', sys.argv[1:])\n");
			const result = runLine(py, `${py} plain.py 'quoted arg'`, dir);
			expect(result.stdout).toBe("via-interpreter ['quoted arg']\n");
			expect(result.exitCode).toBe(0);
		});

		it("a bare launcher name with no path separator and no PATH entry is a clean not-found, never a hang", () => {
			const dir = tempDir();
			writeScript(dir, "hello3.cmd", "@echo off\r\necho unreachable-from-bare-name\r\n");
			const result = runLine(py, "hello3.cmd", dir, { PATH: "" });
			assertNoCrash(result);
			expect(result.exitCode).not.toBe(124);
			expect(result.stdout).toContain("command not found");
		});
	});

	describe("7. environment", () => {
		it("A=1 python -c ... reads the transient assignment without leaking into the parent env", () => {
			const dir = tempDir();
			const result = runLine(py, `A=1 ${py} -c "import os; print(os.environ['A'])"`, dir);
			expect(result.stdout).toBe("1\n");
			expect(result.envDelta.A).toBeUndefined();
		});

		it("export A=1; ... persists the variable in envDelta and to a spawned child", () => {
			const dir = tempDir();
			const result = runLine(py, `export A=1; ${py} -c "import os; print(os.environ['A'])"`, dir);
			expect(result.stdout).toBe("1\n");
			expect(result.envDelta.A).toBe("1");
		});

		it("unset removes a previously-set variable (envDelta -> null)", () => {
			const result = runLine(py, "unset A", tempDir(), { A: "was-set" });
			expect(result.envDelta.A).toBeNull();
		});

		it("$HOME and ~ both expand to the HOME entry in the request env", () => {
			const dir = tempDir();
			const home = runLine(py, "echo $HOME", dir, { HOME: "/home/adversarial" });
			const tilde = runLine(py, "echo ~", dir, { HOME: "/home/adversarial" });
			expect(home.stdout).toBe("/home/adversarial\n");
			expect(tilde.stdout).toBe("/home/adversarial\n");
		});

		it("${A:-default} substitutes when unset, ${A:+alt} substitutes only when set, ${#A} is the length", () => {
			const dir = tempDir();
			expect(runLine(py, "echo ${A:-default}", dir).stdout).toBe("default\n");
			expect(runLine(py, "A=x; echo ${A:+alt}", dir).stdout).toBe("alt\n");
			expect(runLine(py, "unset A; echo ${A:+alt}", dir).stdout).toBe("\n");
			expect(runLine(py, "A=hello; echo ${#A}", dir).stdout).toBe("5\n");
		});

		it("${A#pre}, ${A%suf} and ${A/x/y} strip and substitute with GNU bash semantics", () => {
			const dir = tempDir();
			expect(runLine(py, "A=preval; echo ${A#pre}", dir).stdout).toBe("val\n");
			expect(runLine(py, "A=valsuf; echo ${A%suf}", dir).stdout).toBe("val\n");
			expect(runLine(py, "A=xyz; echo ${A/x/y}", dir).stdout).toBe("yyz\n");
			const indirection = runLine(py, "A=B; echo ${!A}", dir);
			expect(indirection.refused).toBe(true);
			expect(indirection.construct).toBe("parameter-expansion");
			assertNoCrash(indirection);
		});
	});

	describe("8. arithmetic and substitution", () => {
		it("$(( 1 + 2 )) evaluates arithmetic expansion", () => {
			const result = runLine(py, "echo $(( 1 + 2 ))", tempDir());
			expect(result.stdout).toBe("3\n");
			expect(result.exitCode).toBe(0);
		});

		it("$(echo hi) runs command substitution", () => {
			const result = runLine(py, "echo $(echo hi)", tempDir());
			expect(result.stdout).toBe("hi\n");
		});

		it("backticks run command substitution identically to $()", () => {
			const result = runLine(py, "echo `echo hi`", tempDir());
			expect(result.stdout).toBe("hi\n");
		});

		it("nested $(echo $(echo x)) resolves both levels", () => {
			const result = runLine(py, "echo $(echo $(echo x))", tempDir());
			expect(result.stdout).toBe("x\n");
		});

		it("command substitution inside a double-quoted argument interpolates in place", () => {
			const result = runLine(py, 'echo "pre-$(echo mid)-post"', tempDir());
			expect(result.stdout).toBe("pre-mid-post\n");
		});

		it("division by zero in $((...)) fails only that command and does not stop the list", () => {
			const result = runLine(py, "echo $((1/0)); echo after", tempDir());
			assertNoCrash(result);
			expect(result.stdout).toBe("bash: 1/0: division by zero\nafter\n");
		});
	});

	describe("9. limits", () => {
		it("an argument list over 8000 characters is accepted and echoed back exactly", () => {
			const arg = "a".repeat(8500);
			const result = runLine(py, `echo ${arg}`, tempDir());
			expect(result.stdout).toBe(`${arg}\n`);
			expect(result.exitCode).toBe(0);
		});

		it("200 semicolon-separated true commands all run without truncation", () => {
			const command = `${Array(200).fill("true").join(";")};echo done`;
			const result = runLine(py, command, tempDir());
			expect(result.stdout).toBe("done\n");
			expect(result.exitCode).toBe(0);
		});

		it("a 1 MB stdout from an external command passes through the pipe intact", () => {
			const dir = tempDir();
			const command = `${py} -c 'print("x"*1000000)' | wc -c`;
			const result = runLine(py, command, dir);
			expect(result.stdout.trim()).toBe("1000001");
		});

		it("an empty command is a clean no-op", () => {
			const result = runLine(py, "", tempDir());
			expect(result.stdout).toBe("");
			expect(result.exitCode).toBe(0);
			expect(result.refused).toBe(false);
		});

		it("a whitespace-only command is a clean no-op", () => {
			const result = runLine(py, "    \t  ", tempDir());
			expect(result.stdout).toBe("");
			expect(result.exitCode).toBe(0);
			expect(result.refused).toBe(false);
		});

		it("a comment-only command is a clean no-op", () => {
			const result = runLine(py, "# just a comment, nothing to run", tempDir());
			expect(result.stdout).toBe("");
			expect(result.exitCode).toBe(0);
			expect(result.refused).toBe(false);
		});
	});

	describe("10. Windows oddities (run everywhere, expectations by platform)", () => {
		it("a redirect target named NUL/CON is a plain filename on POSIX, and a device sink on win32", () => {
			const dir = tempDir();
			const result = runLine(py, "echo hi > NUL; cat NUL", dir);
			assertNoCrash(result);
			if (win32) {
				// NUL is the real null device: nothing is ever readable back from it.
				expect(result.exitCode).not.toBe(124);
			} else {
				expect(result.stdout).toBe("hi\n");
				expect(result.exitCode).toBe(0);
			}
		});

		it("/dev/null is always writable and reads back empty", () => {
			const dir = tempDir();
			const command = "echo discarded > /dev/null; cat /dev/null; echo done";
			const result = runLine(py, command, dir);
			assertNoCrash(result);
			if (!win32) {
				expect(result.stdout).toBe("done\n");
				expect(result.exitCode).toBe(0);
			}
		});

		it("trailing dots and trailing spaces in a filename round-trip through cat", () => {
			const dir = tempDir();
			writeFileSync(join(dir, "trail."), "dot\n");
			writeFileSync(join(dir, "trail "), "space\n");
			const dotResult = runLine(py, 'cat "trail."', dir);
			const spaceResult = runLine(py, 'cat "trail "', dir);
			assertNoCrash(dotResult);
			assertNoCrash(spaceResult);
			if (!win32) {
				expect(dotResult.stdout).toBe("dot\n");
				expect(spaceResult.stdout).toBe("space\n");
			}
		});

		it("dir lists the current directory as a clear success or a named refusal, never a hang", () => {
			const dir = tempDir();
			writeFileSync(join(dir, "a.txt"), "x");
			const result = runLine(py, "dir", dir);
			assertNoCrash(result);
			expect(result.exitCode).not.toBe(124);
		});

		it("a forward-slash path spelling resolves a file inside a subdirectory", () => {
			const dir = tempDir();
			mkdirSync(join(dir, "subdir"));
			writeFileSync(join(dir, "subdir", "f.txt"), "f\n");
			const result = runLine(py, "cat subdir/f.txt", dir);
			expect(result.stdout).toBe("f\n");
			expect(result.exitCode).toBe(0);
		});

		it("a backslash path spelling for the same file resolves only on win32; POSIX treats it as one literal name", () => {
			const dir = tempDir();
			mkdirSync(join(dir, "subdir"));
			writeFileSync(join(dir, "subdir", "f.txt"), "f\n");
			const result = runLine(py, "cat subdir\\f.txt", dir);
			assertNoCrash(result);
			if (win32) {
				expect(result.stdout).toBe("f\n");
				expect(result.exitCode).toBe(0);
			} else {
				expect(result.exitCode).toBe(1);
				expect(result.stdout).toContain("No such file or directory");
			}
		});
	});
});
