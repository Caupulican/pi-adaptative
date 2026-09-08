import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverGnuToolsDir } from "../../src/utils/shell.ts";

const ENGINE_DIR = join(import.meta.dirname, "..", "..", "src", "bundled-resources", "runtimes", "pi-shell-engine");
const IS_WINDOWS = process.platform === "win32";

function resolvePython(): string | null {
	const fromEnv = process.env.PI_TEST_PYTHON;
	const candidates = fromEnv ? [fromEnv, "python3", "python"] : ["python3", "python"];
	for (const candidate of candidates) {
		const probe = spawnSync(candidate, ["--version"], { encoding: "utf-8" });
		if (probe.status === 0) return candidate;
	}
	return null;
}

// The real engine assembly (main.py's wiring: real tokenizer, parser, expander, and the full
// builtin registry) with `gnu_tools_dir` injected the way a request frame's `gnuToolsDir` is.
const HARNESS = `
import sys, io, json, os
sys.path.insert(0, ${JSON.stringify(ENGINE_DIR)})
from tokens import tokenize
from parser import parse
import exec as execmod
from context import ExecContext
from state import ShellState
from commands import REGISTRY
from errors import UnsupportedConstruct
from expand import expand_word

payload = json.loads(sys.argv[1])
state = ShellState(cwd=payload["cwd"], env=dict(payload["env"]), gnu_tools_dir=payload.get("gnuToolsDir"))
merged = io.BytesIO()
ctx = ExecContext(
    state=state,
    stdin=io.BytesIO(),
    stdout=merged,
    expand_word=expand_word,
    run_command_substitution=execmod.run_command_substitution,
    builtins=REGISTRY,
    deadline=None,
    stderr=merged,
)
try:
    exit_code = execmod.execute(parse(tokenize(payload["command"])), ctx)
except UnsupportedConstruct as exc:
    # main.py's refusal path: the named message on the merged sink, exit 2.
    merged.write(exc.message.encode("utf-8", errors="replace"))
    exit_code = 2
print(json.dumps({"stdout": merged.getvalue().decode("utf-8", errors="replace"), "exitCode": exit_code}))
`;

interface RunResult {
	stdout: string;
	exitCode: number;
}

function runEngine(
	python: string,
	command: string,
	options: { cwd: string; gnuToolsDir?: string; env?: Record<string, string> },
): RunResult {
	const payload = {
		command,
		cwd: options.cwd,
		env: { PATH: process.env.PATH ?? "", PATHEXT: process.env.PATHEXT ?? "", ...(options.env ?? {}) },
		gnuToolsDir: options.gnuToolsDir,
	};
	const result = spawnSync(python, ["-B", "-c", HARNESS, JSON.stringify(payload)], { encoding: "utf-8" });
	if (result.status !== 0) throw new Error(`engine harness failed for ${JSON.stringify(command)}: ${result.stderr}`);
	const parsed = JSON.parse(result.stdout) as RunResult;
	return { ...parsed, stdout: parsed.stdout.replace(/\r\n/g, "\n") };
}

/** A stand-in GNU tool: prints its own name, its argv, and the env probe `PI_PROBE`. */
function writeStubTool(directory: string, name: string): void {
	if (IS_WINDOWS) {
		// A .exe marker the resolver accepts plus a launcher the OS can run: the stub is the .exe
		// name only on the host layout that has real binaries; on Windows the real Git for Windows
		// tools are exercised by the host-gated suite below instead of stubs.
		throw new Error("stub tools are a POSIX-only fixture");
	}
	const path = join(directory, name);
	writeFileSync(
		path,
		`#!/bin/sh\nprintf 'STUB %s' "${name}"\nfor a in "$@"; do printf ' [%s]' "$a"; done\nprintf ' env=%s' "\${PI_PROBE:-}"\nif [ -n "\${PI_SHOW_PATH:-}" ]; then printf ' path0=%s' "\${PATH%%:*}"; fi\nprintf '\\n'\n`,
	);
	chmodSync(path, 0o755);
}

const python = resolvePython();
const describeOrSkip = python ? describe : describe.skip;

describeOrSkip("pi-shell-engine GNU-first dispatch (real tools before Python builtins)", () => {
	let root: string;
	let toolsDir: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-gnu-"));
		toolsDir = join(root, "usr", "bin");
		mkdirSync(toolsDir, { recursive: true });
		writeFileSync(join(root, "a.txt"), "alpha\nbeta\n");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	describe.skipIf(IS_WINDOWS)("with stub GNU binaries (POSIX fixture)", () => {
		it("dispatches a table name to the real binary with the full argv, and to the builtin without it", () => {
			if (!python) return;
			writeStubTool(toolsDir, "ls");
			const gnu = runEngine(python, "ls -lt --group-directories-first .", { cwd: root, gnuToolsDir: toolsDir });
			expect(gnu.exitCode).toBe(0);
			expect(gnu.stdout).toBe("STUB ls [-lt] [--group-directories-first] [.] env=\n");
			// Same command, no GNU directory: the Python builtin answers and refuses the flag by name.
			const builtin = runEngine(python, "ls -lt --group-directories-first .", { cwd: root });
			expect(builtin.exitCode).not.toBe(0);
			expect(builtin.stdout).toMatch(/unsupported/u);
			// Plain `ls` without the tool present in the directory keeps the builtin listing.
			const plain = runEngine(python, "cat a.txt", { cwd: root, gnuToolsDir: toolsDir });
			expect(plain).toEqual({ stdout: "alpha\nbeta\n", exitCode: 0 });
		});

		it("keeps engine-semantic names (echo, printf, test, pwd, which) on the engine even when a binary exists", () => {
			if (!python) return;
			for (const name of ["echo", "printf", "test", "pwd", "which", "ls"]) writeStubTool(toolsDir, name);
			const result = runEngine(python, "echo one; printf '%s\\n' two; pwd; test -f a.txt && echo yes", {
				cwd: root,
				gnuToolsDir: toolsDir,
			});
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe(`one\ntwo\n${root}\nyes\n`);
		});

		it("never rewrites an explicit path, and reports a name found nowhere", () => {
			if (!python) return;
			writeStubTool(toolsDir, "ls");
			const explicit = runEngine(python, `${join(toolsDir, "ls")} x`, { cwd: root, gnuToolsDir: toolsDir });
			expect(explicit.stdout).toBe("STUB ls [x] env=\n");
			const relative = runEngine(python, "./ls x", { cwd: root, gnuToolsDir: toolsDir });
			expect(relative).toEqual({ stdout: "./ls: command not found\n", exitCode: 127 });
			const nowhere = runEngine(python, "rg --version", {
				cwd: root,
				gnuToolsDir: toolsDir,
				env: { PATH: "/nonexistent" },
			});
			expect(nowhere).toEqual({ stdout: "rg: command not found\n", exitCode: 127 });
		});

		it("fills in a bare name PATH lacks from the GNU directory, after PATH", () => {
			if (!python) return;
			writeStubTool(toolsDir, "seq");
			const filled = runEngine(python, "seq 3", { cwd: root, gnuToolsDir: toolsDir, env: { PATH: "/nonexistent" } });
			expect(filled.stdout).toBe("STUB seq [3] env=\n");
			const shim = join(root, "shim");
			mkdirSync(shim);
			writeFileSync(join(shim, "seq"), "#!/bin/sh\necho NATIVE seq\n");
			chmodSync(join(shim, "seq"), 0o755);
			const native = runEngine(python, "seq 3", { cwd: root, gnuToolsDir: toolsDir, env: { PATH: shim } });
			expect(native.stdout).toBe("NATIVE seq\n");
		});

		it("puts the GNU directory first on a GNU tool's own PATH so its children resolve the same vocabulary", () => {
			if (!python) return;
			writeStubTool(toolsDir, "xargs");
			const gnu = runEngine(python, "PI_SHOW_PATH=1 xargs -n 1", { cwd: root, gnuToolsDir: toolsDir });
			expect(gnu.stdout).toBe(`STUB xargs [-n] [1] env= path0=${toolsDir}\n`);
			// A name PATH resolves outside the GNU directory keeps its PATH untouched.
			const shim = join(root, "shim");
			mkdirSync(shim);
			writeStubTool(shim, "rg");
			const native = runEngine(python, "PI_SHOW_PATH=1 rg", {
				cwd: root,
				gnuToolsDir: toolsDir,
				env: { PATH: shim },
			});
			expect(native.stdout).toBe(`STUB rg env= path0=${shim}\n`);
		});

		it("runs a GNU tool as an external pipeline stage with real pipes and the stage's own redirects", () => {
			if (!python) return;
			writeStubTool(toolsDir, "ls");
			const result = runEngine(python, "ls -t | tr a-z A-Z > out.txt; cat out.txt", {
				cwd: root,
				gnuToolsDir: toolsDir,
			});
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("STUB LS [-T] ENV=\n");
			expect(existsSync(join(root, "out.txt"))).toBe(true);
		});

		it("passes transient assignments and the session environment to the real tool", () => {
			if (!python) return;
			writeStubTool(toolsDir, "find");
			const transient = runEngine(python, "PI_PROBE=one find . -maxdepth 1", { cwd: root, gnuToolsDir: toolsDir });
			expect(transient.stdout).toBe("STUB find [.] [-maxdepth] [1] env=one\n");
			const exported = runEngine(python, "export PI_PROBE=two; find .", { cwd: root, gnuToolsDir: toolsDir });
			expect(exported.stdout).toBe("STUB find [.] env=two\n");
		});

		it("prefers GNU xargs over the Python runner, and the runner still dispatches GNU tools", () => {
			if (!python) return;
			writeStubTool(toolsDir, "xargs");
			const gnuXargs = runEngine(python, "printf 'a\\n' | xargs -0 -n 1 rg", { cwd: root, gnuToolsDir: toolsDir });
			expect(gnuXargs.stdout).toBe("STUB xargs [-0] [-n] [1] [rg] env=\n");
			rmSync(join(toolsDir, "xargs"));
			writeStubTool(toolsDir, "ls");
			// No GNU xargs: the Python runner batches the input and still dispatches `ls` to the real tool.
			const runner = runEngine(python, "printf 'x\\ny\\n' | xargs ls -d", { cwd: root, gnuToolsDir: toolsDir });
			expect(runner.stdout).toBe("STUB ls [-d] [x] [y] env=\n");
		});

		it("survives a GNU directory whose tool is missing: the builtin answers, nothing crashes", () => {
			if (!python) return;
			// The directory exists but carries no `wc`; the table name resolves to the Python builtin.
			const result = runEngine(python, "wc -l a.txt", { cwd: root, gnuToolsDir: toolsDir });
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toMatch(/^\s*2 a\.txt\n$/u);
		});
	});

	describe("with Git for Windows' real GNU tools (host-gated)", () => {
		const realDir = discoverGnuToolsDir();
		it("discovers usr/bin from the git on PATH on Windows and nothing elsewhere", () => {
			if (IS_WINDOWS) {
				expect(realDir).toMatch(/[\\/]usr[\\/]bin$/u);
			} else {
				expect(realDir).toBeNull();
			}
		});

		it.skipIf(!IS_WINDOWS || !realDir)(
			"runs the corpus commands that the builtins refused, with GNU semantics",
			() => {
				if (!python || !realDir) return;
				mkdirSync(join(root, "sub"));
				writeFileSync(join(root, "sub", "b.log"), "needle here\n");
				const cases: Array<[string, RegExp]> = [
					["ls -lt .", /a\.txt/u],
					["ls -d sub", /^sub\n$/u],
					["find . -maxdepth 2 -type f -name '*.log' -print", /sub[\\/]b\.log/u],
					["find . -maxdepth 2 -iname 'B.LOG' -o -name 'zzz'", /b\.log/u],
					["grep -RIn needle . --include='*.log'", /b\.log:1:needle here/u],
					["stat -c '%s %n' a.txt", /^11 a\.txt\n$/u],
					["awk '{print NR\": \"$1}' a.txt", /^1: alpha\n2: beta\n$/u],
					["sed -n '2p' a.txt", /^beta\n$/u],
					["wc -l < a.txt", /^\s*2\n$/u],
					["head -c 5 a.txt", /^alpha$/u],
					["printf 'a.txt\\0' | xargs -0 cat", /^alpha\nbeta\n$/u],
					["find . -maxdepth 1 -name a.txt -exec cat {} \\;", /^alpha\nbeta\n$/u],
					["seq 3", /^1\n2\n3\n$/u],
					["sha256sum a.txt", /^[0-9a-f]{64} {2}a\.txt\n$/u],
					["uname -s", /MINGW|MSYS/u],
					["dir sub", /b\.log/u],
				];
				for (const [command, expected] of cases) {
					const result = runEngine(python, command, { cwd: root, gnuToolsDir: realDir });
					expect(result.exitCode, `${command}\n${result.stdout}`).toBe(0);
					expect(result.stdout, command).toMatch(expected);
				}
			},
		);

		it.skipIf(!IS_WINDOWS || !realDir)(
			"accepts every drive-root spelling a model emits for a GNU tool operand",
			() => {
				if (!python || !realDir) return;
				const drive = root.slice(0, 1).toLowerCase();
				const rest = root.slice(2).replace(/\\/g, "/");
				for (const spelling of [root, root.replace(/\\/g, "/"), `/${drive}${rest}`, `/mnt/${drive}${rest}`]) {
					const result = runEngine(python, `ls "${spelling}"`, { cwd: root, gnuToolsDir: realDir });
					expect(result.exitCode, spelling).toBe(0);
					expect(result.stdout, spelling).toMatch(/a\.txt/u);
				}
			},
		);
	});
});
