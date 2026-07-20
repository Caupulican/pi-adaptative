import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
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

function resolveAbsolutePython(python: string): string {
	const result = spawnSync(python, ["-c", "import sys; sys.stdout.write(sys.executable)"], { encoding: "utf-8" });
	if (result.status !== 0) throw new Error(`failed to resolve absolute python path: ${result.stderr}`);
	return result.stdout.trim();
}

// Fake expand_word (identity: Raw/Lit/DQ text verbatim, no split/glob) + a small fake
// builtin registry (echo/true/false), per the WP-C acceptance spec — exec.py is
// exercised without importing expand.py or commands/*.
const HARNESS = `
import sys, io, json
sys.path.insert(0, ${JSON.stringify(ENGINE_DIR)})
from tokens import tokenize
from parser import parse
import exec as execmod
from context import ExecContext
from state import ShellState

def fake_expand_word(word, ctx):
    # Faithful enough to real expand.py for the executor's own tests: an unquoted
    # (Raw/Param/CmdSub-only) word that resolves to the empty string opens ZERO
    # fields (bash semantics for e.g. an unset "$VAR" standing alone), while a
    # quoted/literal word always opens exactly one field, even if empty.
    parts = []
    quoted_or_literal = False
    for seg in word.segments:
        cls = type(seg).__name__
        if cls == "Raw":
            parts.append(seg.text)
        elif cls == "Lit":
            parts.append(seg.text)
            quoted_or_literal = True
        elif cls == "DQ":
            quoted_or_literal = True
            for inner in seg.segments:
                if type(inner).__name__ in ("Raw", "Lit"):
                    parts.append(inner.text)
        elif cls == "Tilde":
            parts.append("~" + seg.user)
        elif cls == "Param":
            parts.append(ctx.state.env.get(seg.name, ""))
    if not word.segments:
        return []
    joined = "".join(parts)
    if joined == "" and not quoted_or_literal:
        return []
    return [joined]

def _echo(bctx):
    bctx.stdout.write((" ".join(bctx.argv[1:]) + "\\n").encode("utf-8"))
    return 0

def _true(bctx):
    return 0

def _false(bctx):
    return 1

def _boom(bctx):
    # A plain (non-refusal) stage failure, exercised only through this fake — real
    # builtins in commands/* raise UnsupportedConstruct for every bad-input path they
    # know about, so a raw exception is simulated here to prove the OTHER branch of the
    # run_inline contract: a named one-line message on the merged sink, never a
    # traceback, and exit 1 for just this stage.
    raise RuntimeError("simulated stage failure")

BUILTINS = {"echo": _echo, "true": _true, "false": _false, "boom": _boom}

def run(command, cwd, env, timeout_ms=None, session_stderr_path=None):
    state = ShellState(cwd=cwd, env=dict(env))
    original_env = dict(env)
    merged = io.BytesIO()
    session_stderr = open(session_stderr_path, "wb") if session_stderr_path else None
    ctx = ExecContext(
        state=state,
        stdin=sys.stdin.buffer,
        stdout=merged,
        expand_word=fake_expand_word,
        run_command_substitution=execmod.run_command_substitution,
        builtins=BUILTINS,
        deadline=None,
        stderr=session_stderr,
    )
    try:
        tokens = tokenize(command)
        ast = parse(tokens)
        exit_code = execmod.execute(ast, ctx)
    finally:
        if session_stderr is not None:
            session_stderr.close()
    return {
        "stdout": merged.getvalue().decode("utf-8", errors="replace"),
        "exitCode": exit_code,
        "cwd": state.cwd,
        "envDelta": state.delta(original_env),
    }

payload = json.loads(sys.argv[1])
result = run(
    payload["command"],
    payload["cwd"],
    payload.get("env", {}),
    session_stderr_path=payload.get("sessionStderrPath"),
)
print(json.dumps(result))
`;

// On Windows, any child process reading a file (or emitting to stdout) through Python's
// default text-mode I/O re-translates trailing "\n" bytes to "\r\n" — this is Windows Python
// child behavior, not the engine's: the TS bash-tool layer already strips "\r" before an agent
// ever sees output, so byte-for-byte engine assertions must normalize CRLF -> LF here to match
// what a real caller observes. This is NEVER applied to output produced directly by an engine
// builtin (echo/cd/export/etc. always emit bare "\n" on every platform) — only to output that
// passed through an external python -c child process (e.g. the verification helper that
// re-prints a redirect target's file contents).
function normalizeChildOutput(text: string): string {
	return text.replace(/\r\n/g, "\n");
}

interface RunResult {
	stdout: string;
	exitCode: number;
	cwd: string;
	envDelta: Record<string, string | null>;
}

function run(
	python: string,
	command: string,
	cwd: string,
	env: Record<string, string> = {},
	sessionStderrPath?: string,
): RunResult {
	const payload = JSON.stringify({ command, cwd, env, sessionStderrPath });
	const result = spawnSync(python, ["-B", "-c", HARNESS, payload], { encoding: "utf-8" });
	if (result.status !== 0) {
		throw new Error(`executor run failed for ${JSON.stringify(command)}: ${result.stderr}`);
	}
	return JSON.parse(result.stdout) as RunResult;
}

describe("pi-shell-engine executor (exec.py)", () => {
	const python = resolvePython();
	if (!python) {
		it.skip("no Python interpreter available", () => {});
		return;
	}
	const pyPath = resolveAbsolutePython(python);
	const baseCwd = tmpdir();

	describe("list sequencing", () => {
		it("sequence: a ; b runs both, exit = last", () => {
			const result = run(python, "echo a ; echo b", baseCwd);
			expect(result.stdout).toBe("a\nb\n");
			expect(result.exitCode).toBe(0);
		});

		it("&& short-circuits on failure", () => {
			const result = run(python, "false && echo unreached", baseCwd);
			expect(result.stdout).toBe("");
			expect(result.exitCode).toBe(1);
		});

		it("&& runs the right side on success", () => {
			const result = run(python, "true && echo reached", baseCwd);
			expect(result.stdout).toBe("reached\n");
			expect(result.exitCode).toBe(0);
		});

		it("|| short-circuits on success", () => {
			const result = run(python, "true || echo unreached", baseCwd);
			expect(result.stdout).toBe("");
			expect(result.exitCode).toBe(0);
		});

		it("|| runs the right side on failure", () => {
			const result = run(python, "false || echo reached", baseCwd);
			expect(result.stdout).toBe("reached\n");
			expect(result.exitCode).toBe(0);
		});

		it("negation inverts the final exit code", () => {
			expect(run(python, "! true", baseCwd).exitCode).toBe(1);
			expect(run(python, "! false", baseCwd).exitCode).toBe(0);
		});
	});

	describe("pipeline", () => {
		it("two-stage pipeline: real OS pipe, exit = last element", () => {
			const command = `${pyPath} -c 'print("one")' | ${pyPath} -c 'import sys; print(sys.stdin.read().strip().upper())'`;
			const result = run(python, command, baseCwd, { PATH: process.env.PATH ?? "" });
			expect(result.stdout.trim()).toBe("ONE");
			expect(result.exitCode).toBe(0);
		});

		it("pipeline exit code reflects the last element even if an earlier one fails", () => {
			const command = `${pyPath} -c 'import sys; sys.exit(1)' | ${pyPath} -c 'print("still ran")'`;
			const result = run(python, command, baseCwd, { PATH: process.env.PATH ?? "" });
			expect(result.stdout.trim()).toBe("still ran");
			expect(result.exitCode).toBe(0);
		});
	});

	describe("redirects", () => {
		it("> truncates to a file", () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-exec-"));
			const target = join(dir, "out.txt");
			const result = run(python, `echo hello > ${target}`, dir);
			expect(result.stdout).toBe("");
			expect(result.exitCode).toBe(0);
			const content = spawnSync(python, ["-c", `print(open(${JSON.stringify(target)}).read(), end="")`], {
				encoding: "utf-8",
			});
			expect(normalizeChildOutput(content.stdout)).toBe("hello\n");
		});

		it(">> appends to a file", () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-exec-"));
			const target = join(dir, "out.txt");
			run(python, `echo one > ${target}`, dir);
			run(python, `echo two >> ${target}`, dir);
			const content = spawnSync(python, ["-c", `print(open(${JSON.stringify(target)}).read(), end="")`], {
				encoding: "utf-8",
			});
			expect(normalizeChildOutput(content.stdout)).toBe("one\ntwo\n");
		});

		it("< reads a file as stdin for an external command", () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-exec-"));
			const src = join(dir, "in.txt");
			spawnSync(python, ["-c", `open(${JSON.stringify(src)}, "w").write("from-file\\n")`]);
			const command = `${pyPath} -c 'import sys; print(sys.stdin.read().strip())' < ${src}`;
			const result = run(python, command, dir, { PATH: process.env.PATH ?? "" });
			expect(result.stdout.trim()).toBe("from-file");
		});

		it("2> sends stderr only to the file, never the merged sink", () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-exec-"));
			const errFile = join(dir, "err.txt");
			const command = `${pyPath} -c 'import sys; sys.stderr.write("boom\\n")' 2> ${errFile}`;
			const result = run(python, command, dir, { PATH: process.env.PATH ?? "" });
			expect(result.stdout).toBe("");
			const content = spawnSync(python, ["-c", `print(open(${JSON.stringify(errFile)}).read(), end="")`], {
				encoding: "utf-8",
			});
			expect(normalizeChildOutput(content.stdout)).toBe("boom\n");
		});

		it("2>&1 merges stderr into stdout", () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-exec-"));
			const command = `${pyPath} -c 'import sys; sys.stderr.write("err-line\\n")' > ${join(dir, "combined.txt")} 2>&1`;
			run(python, command, dir, { PATH: process.env.PATH ?? "" });
			const content = spawnSync(
				python,
				["-c", `print(open(${JSON.stringify(join(dir, "combined.txt"))}).read(), end="")`],
				{ encoding: "utf-8" },
			);
			expect(normalizeChildOutput(content.stdout)).toBe("err-line\n");
		});
	});

	describe("subshell vs brace-group scoping", () => {
		it("subshell: cd and export do NOT leak to the parent state", () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-exec-"));
			const sub = mkdtempSync(join(dir, "sub-"));
			const result = run(python, `( cd ${sub} && export FOO=bar )`, dir);
			expect(result.cwd).toBe(dir);
			expect(result.envDelta.FOO).toBeUndefined();
		});

		it("brace group: cd and export DO persist to the parent state", () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-exec-"));
			const sub = mkdtempSync(join(dir, "sub-"));
			const result = run(python, `{ cd ${sub} ; export FOO=bar ; }`, dir);
			expect(result.cwd).toBe(sub);
			expect(result.envDelta.FOO).toBe("bar");
		});
	});

	describe("assignments", () => {
		it("standalone assignment mutates state env (reflected in envDelta)", () => {
			const result = run(python, "FOO=bar", baseCwd, {});
			expect(result.envDelta.FOO).toBe("bar");
		});

		it("transient assignment applies only to the command, not the parent state", () => {
			const result = run(python, "FOO=bar echo hi", baseCwd, {});
			expect(result.stdout).toBe("hi\n");
			expect(result.envDelta.FOO).toBeUndefined();
		});
	});

	describe("state builtins", () => {
		it("cd changes state.cwd in the frame", () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-exec-"));
			const sub = mkdtempSync(join(dir, "sub-"));
			const result = run(python, `cd ${sub}`, dir);
			expect(result.cwd).toBe(sub);
		});

		it("export reflects in envDelta", () => {
			const result = run(python, "export FOO=bar", baseCwd, {});
			expect(result.envDelta.FOO).toBe("bar");
		});

		it("unset removes a key (envDelta -> null)", () => {
			const result = run(python, "unset FOO", baseCwd, { FOO: "bar" });
			expect(result.envDelta.FOO).toBeNull();
		});

		it("cd - prints the new cwd plus newline after a successful change", () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-exec-"));
			const sub = mkdtempSync(join(dir, "sub-"));
			run(python, `cd ${sub}`, dir);
			// OLDPWD only gets set by a real `cd`; drive it explicitly via env for `cd -`.
			const result = run(python, "cd -", sub, { OLDPWD: dir });
			expect(result.stdout).toBe(`${dir}\n`);
			expect(result.cwd).toBe(dir);
		});
	});

	describe("zero-argv dispatch (architect fix #8)", () => {
		it("a command word that expands to zero argv strings is exit 0, not a malformed-syntax refusal", () => {
			const result = run(python, "$UNSET_VAR", baseCwd, {});
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("");
		});
	});

	describe("pipeline stderr routing (architect fix #3/#4/#9)", () => {
		it("an un-redirected external stage's stderr goes to the session merged sink, never the pipe", () => {
			const command = `${pyPath} -c 'import sys; sys.stderr.write("stage-err\\n"); print("stage-out")' | ${pyPath} -c 'import sys; print(sys.stdin.read().strip().upper())'`;
			const result = run(python, command, baseCwd, { PATH: process.env.PATH ?? "" });
			// The pipe carried ONLY "stage-out" downstream: had stderr leaked into the pipe,
			// the second stage would have upper-cased it too and this would read "STAGE-ERR".
			expect(result.stdout).toContain("STAGE-OUT");
			expect(result.stdout).not.toContain("STAGE-ERR");
			// stderr still lands in the session merged sink (this process's own stdout field).
			expect(result.stdout).toContain("stage-err");
		});

		it("a pipeline stage's own 2> redirect is honored (not ignored)", () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-exec-"));
			const errFile = join(dir, "stage-err.txt");
			const command = `${pyPath} -c 'import sys; sys.stderr.write("boom\\n"); print("kept")' 2> ${errFile} | ${pyPath} -c 'import sys; print(sys.stdin.read().strip())'`;
			const result = run(python, command, dir, { PATH: process.env.PATH ?? "" });
			expect(result.stdout.trim()).toBe("kept");
			const content = spawnSync(python, ["-c", `print(open(${JSON.stringify(errFile)}).read(), end="")`], {
				encoding: "utf-8",
			});
			expect(normalizeChildOutput(content.stdout)).toBe("boom\n");
		});

		it("routes an un-redirected pipeline stage's stderr to ctx.stderr when set (group-level 2>)", () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-exec-"));
			const sessionErrPath = join(dir, "session-err.txt");
			const command = `${pyPath} -c 'import sys; sys.stderr.write("group-err\\n"); print("piped")' | ${pyPath} -c 'import sys; print(sys.stdin.read().strip())'`;
			const result = run(python, command, dir, { PATH: process.env.PATH ?? "" }, sessionErrPath);
			expect(result.stdout.trim()).toBe("piped");
			const content = spawnSync(python, ["-c", `print(open(${JSON.stringify(sessionErrPath)}).read(), end="")`], {
				encoding: "utf-8",
			});
			expect(normalizeChildOutput(content.stdout)).toBe("group-err\n");
		});

		it("a command-not-found pipeline stage reports 127, closes its write end, and never crashes the engine", () => {
			const command = `definitely-not-a-real-command-xyz | ${pyPath} -c 'import sys; print("downstream:" + sys.stdin.read())'`;
			const result = run(python, command, baseCwd, { PATH: process.env.PATH ?? "" });
			expect(result.stdout).toContain("command not found");
			expect(result.stdout).toContain("downstream:");
			expect(result.exitCode).toBe(0);
		});
	});

	describe("subshell/brace-group stderr threading (architect fix #5)", () => {
		it("( ... ) 2>file captures the inner external command's un-redirected stderr", () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-exec-"));
			const errFile = join(dir, "sub-err.txt");
			const command = `( ${pyPath} -c 'import sys; sys.stderr.write("inner-err\\n")' ) 2> ${errFile}`;
			run(python, command, dir, { PATH: process.env.PATH ?? "" });
			const content = spawnSync(python, ["-c", `print(open(${JSON.stringify(errFile)}).read(), end="")`], {
				encoding: "utf-8",
			});
			expect(normalizeChildOutput(content.stdout)).toBe("inner-err\n");
		});

		it("{ ...; } 2>file captures the inner external command's un-redirected stderr", () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-exec-"));
			const errFile = join(dir, "brace-err.txt");
			const command = `{ ${pyPath} -c 'import sys; sys.stderr.write("brace-err\\n")' ; } 2> ${errFile}`;
			run(python, command, dir, { PATH: process.env.PATH ?? "" });
			const content = spawnSync(python, ["-c", `print(open(${JSON.stringify(errFile)}).read(), end="")`], {
				encoding: "utf-8",
			});
			expect(normalizeChildOutput(content.stdout)).toBe("brace-err\n");
		});
	});

	describe("xargs -I marker substitution (architect fix #7)", () => {
		it("replaces every OCCURRENCE of the marker inside an argument, not only exact-token matches", () => {
			const result = run(python, "echo one | xargs -I {} echo prefix-{}-suffix", baseCwd, {});
			expect(result.stdout).toBe("prefix-one-suffix\n");
		});
	});

	describe("xargs attached option-args (architect amendment 2026-07-19)", () => {
		it("-I{} parses identically to the separated -I {} spelling", () => {
			const separated = run(python, "echo one | xargs -I {} echo prefix-{}-suffix", baseCwd, {});
			const attached = run(python, "echo one | xargs -I{} echo prefix-{}-suffix", baseCwd, {});
			expect(attached.stdout).toBe(separated.stdout);
			expect(attached.stdout).toBe("prefix-one-suffix\n");
		});

		it("-n5 parses identically to the separated -n 5 spelling", () => {
			const separated = run(python, "echo a b c d e f g h i j | xargs -n 5 echo", baseCwd, {});
			const attached = run(python, "echo a b c d e f g h i j | xargs -n5 echo", baseCwd, {});
			expect(attached.stdout).toBe(separated.stdout);
		});

		it("an unknown attached flag is still refused", () => {
			expect(() => run(python, "echo one | xargs -x3 echo {}", baseCwd, {})).toThrow();
		});
	});

	describe("fd bookkeeping across a longer pipeline (architect fix #10)", () => {
		it("a three-stage pipeline with mixed external/inline stages completes without fd corruption", () => {
			const command = `${pyPath} -c 'print("a")' | echo relayed | ${pyPath} -c 'import sys; print(sys.stdin.read().strip())'`;
			const result = run(python, command, baseCwd, { PATH: process.env.PATH ?? "" });
			expect(result.stdout.trim()).toBe("relayed");
			expect(result.exitCode).toBe(0);
		});
	});
});

describe("pi-shell-engine main.py ParamExpansionError handling (architect fix #1)", () => {
	const python = resolvePython();
	if (!python) {
		it.skip("no Python interpreter available", () => {});
		return;
	}
	const pythonPath: string = python;

	const RECORD_SEPARATOR = "\x1e";

	function runMain(command: string, cwd: string): { stdout: string; stderr: string; frame: Record<string, unknown> } {
		const request = JSON.stringify({ command, cwd, env: { PATH: process.env.PATH ?? "" } });
		const result = spawnSync(pythonPath, ["-B", join(ENGINE_DIR, "main.py")], {
			encoding: "utf-8",
			input: request,
		});
		if (result.status !== 0) {
			throw new Error(
				`main.py crashed for ${JSON.stringify(command)}: status=${result.status} stderr=${result.stderr}`,
			);
		}
		const raw: string = result.stdout;
		const first = raw.indexOf(RECORD_SEPARATOR);
		const second = raw.indexOf(RECORD_SEPARATOR, first + 1);
		const stdoutPart = raw.slice(0, first);
		const frame = JSON.parse(raw.slice(first + 1, second));
		return { stdout: stdoutPart, stderr: result.stderr, frame };
	}

	it("$" + "{V:?word} against an unset parameter aborts the command without crashing the engine", () => {
		const { stdout, frame } = runMain("echo $" + "{V:?boom}", tmpdir());
		expect(stdout).toBe("bash: V: boom\n");
		expect(frame.exitCode).toBe(1);
		expect(frame.unsupported).toBeNull();
	});

	describe("pipeline stages through the REAL builtin registry (architect G1/G2 fix)", () => {
		it("a three-stage builtin pipeline pipes bytes correctly and exits 0", () => {
			const { stdout, stderr, frame } = runMain('printf "%s\\n" one two three | grep t | sort -r', tmpdir());
			expect(stdout).toBe("two\nthree\n");
			expect(stderr).toBe("");
			expect(frame.exitCode).toBe(0);
			expect(frame.unsupported).toBeNull();
		});

		it("a builtin mid-stage reads/writes arbitrary (non-0/1) pipe fds without crashing", () => {
			// `grep` here is neither the first nor the last element: its stdin/stdout are
			// real OS pipe fds picked by os.pipe(), never fd 0 or 1 (architect G1: the
			// executor must never infer read/write mode from the fd's numeric value).
			const { stdout, stderr, frame } = runMain('printf "%s\\n" apple banana cherry | grep an | wc -l', tmpdir());
			expect(stdout.trim()).toBe("1");
			expect(stderr).toBe("");
			expect(frame.exitCode).toBe(0);
		});

		it("an UnsupportedConstruct raised mid-pipeline surfaces as a structured refusal of the WHOLE command", () => {
			const { frame } = runMain('printf "%s\\n" one two | grep -Z t | sort', tmpdir());
			// Never a fabricated success: the refusal from the middle stage must win over
			// exit 0 / empty output (architect G2).
			expect(frame.exitCode).not.toBe(0);
			expect(frame.unsupported).not.toBeNull();
			expect((frame.unsupported as Record<string, unknown>).code).toBe("unsupported");
		});
	});
});

describe("pi-shell-engine executor inline-stage failure contract (architect G2 fix)", () => {
	const python = resolvePython();
	if (!python) {
		it.skip("no Python interpreter available", () => {});
		return;
	}
	const baseCwd = tmpdir();

	it("a non-refusal exception in an inline pipeline stage is stage exit 1 with a named message, no traceback", () => {
		const result = run(python, "echo start | boom | echo after", baseCwd, {});
		expect(result.stdout).toContain("boom: simulated stage failure");
		expect(result.stdout).not.toContain("Traceback");
		expect(result.stdout).not.toContain('File "');
		expect(result.exitCode).toBe(0);
	});
});
