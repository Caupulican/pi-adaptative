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
	env?: Record<string, string>;
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
	const { argv, stdin = "", cwd = ".", env = {} } = invocation;
	const program = `
import sys, io, json
sys.path.insert(0, ${JSON.stringify(ENGINE_DIR)})
from commands import strings
from context import BuiltinContext
from errors import UnsupportedConstruct

argv = json.loads(${JSON.stringify(JSON.stringify(argv))})
stdin_bytes = json.loads(${JSON.stringify(JSON.stringify(stdin))}).encode("utf-8")
env = json.loads(${JSON.stringify(JSON.stringify(env))})
cwd = json.loads(${JSON.stringify(JSON.stringify(cwd))})

out = io.BytesIO()
ctx = BuiltinContext(argv=argv, cwd=cwd, env=env, stdin=io.BytesIO(stdin_bytes), stdout=out)
try:
	rc = (${fnExpr})(ctx)
	sys.stdout.write(json.dumps({"refused": False, "stdout": out.getvalue().decode("utf-8", errors="surrogateescape"), "exitCode": rc}))
except UnsupportedConstruct as e:
	sys.stdout.write(json.dumps({"refused": True, "code": e.code, "construct": e.construct, "message": e.message}))
`;
	const result = spawnSync(python, ["-B", "-c", program], { encoding: "utf-8" });
	if (result.status !== 0) {
		throw new Error(`engine crashed: ${result.stderr}`);
	}
	return JSON.parse(result.stdout);
}

describe("pi-shell-engine commands/strings.py", () => {
	const python = resolvePython();
	if (!python) {
		it.skip("no Python interpreter available", () => {});
		return;
	}

	describe("echo", () => {
		it("plain args, space-joined, trailing newline", () => {
			const r = runBuiltin(python, "strings.cmd_echo", { argv: ["echo", "hi", "there"] }) as Result;
			expect(r.stdout).toBe("hi there\n");
			expect(r.exitCode).toBe(0);
		});

		it("-n suppresses trailing newline", () => {
			const r = runBuiltin(python, "strings.cmd_echo", { argv: ["echo", "-n", "hi"] }) as Result;
			expect(r.stdout).toBe("hi");
		});

		it("-e enables the full escape set", () => {
			const r = runBuiltin(python, "strings.cmd_echo", {
				argv: ["echo", "-e", "a\\tb\\n\\a\\\\\\e\\0101"],
			}) as Result;
			expect(r.stdout).toBe("a\tb\n\x07\\\x1bA\n");
		});

		it("without -e, escapes print literally", () => {
			const r = runBuiltin(python, "strings.cmd_echo", { argv: ["echo", "a\\tb"] }) as Result;
			expect(r.stdout).toBe("a\\tb\n");
		});

		it("\\c stops output early under -e", () => {
			const r = runBuiltin(python, "strings.cmd_echo", { argv: ["echo", "-e", "abc\\cdef"] }) as Result;
			expect(r.stdout).toBe("abc");
		});

		it("\\xHH hex escape", () => {
			const r = runBuiltin(python, "strings.cmd_echo", { argv: ["echo", "-e", "\\x41\\x42"] }) as Result;
			expect(r.stdout).toBe("AB\n");
		});
	});

	describe("printf", () => {
		it("%s %d %% conversions", () => {
			const r = runBuiltin(python, "strings.cmd_printf", {
				argv: ["printf", "%s-%d-%%\n", "hi", "5"],
			}) as Result;
			expect(r.stdout).toBe("hi-5-%\n");
		});

		it("recycles FORMAT until ARGS exhausted", () => {
			const r = runBuiltin(python, "strings.cmd_printf", {
				argv: ["printf", "%d\n", "1", "2", "3"],
			}) as Result;
			expect(r.stdout).toBe("1\n2\n3\n");
		});

		it("missing args -> empty/0", () => {
			const r = runBuiltin(python, "strings.cmd_printf", { argv: ["printf", "[%s][%d]\n"] }) as Result;
			expect(r.stdout).toBe("[][0]\n");
		});

		it("width/precision on %f", () => {
			const r = runBuiltin(python, "strings.cmd_printf", {
				argv: ["printf", "%6.2f\n", "3.14159"],
			}) as Result;
			expect(r.stdout).toBe("  3.14\n");
		});

		it("format escapes \\n \\t", () => {
			const r = runBuiltin(python, "strings.cmd_printf", { argv: ["printf", "a\\tb\\n"] }) as Result;
			expect(r.stdout).toBe("a\tb\n");
		});

		it("invalid-number case: stderr-in-stdout text + exit 1 (C)", () => {
			const r = runBuiltin(python, "strings.cmd_printf", { argv: ["printf", "%d\n", "not-a-number"] }) as Result;
			expect(r.exitCode).toBe(1);
		});
	});

	describe("basename / dirname", () => {
		it("basename strips dir", () => {
			const r = runBuiltin(python, "strings.cmd_basename", { argv: ["basename", "/a/b/c.txt"] }) as Result;
			expect(r.stdout).toBe("c.txt\n");
		});

		it("basename strips optional suffix", () => {
			const r = runBuiltin(python, "strings.cmd_basename", {
				argv: ["basename", "/a/b/c.txt", ".txt"],
			}) as Result;
			expect(r.stdout).toBe("c\n");
		});

		it("dirname returns directory portion", () => {
			const r = runBuiltin(python, "strings.cmd_dirname", { argv: ["dirname", "/a/b/c.txt"] }) as Result;
			expect(r.stdout).toBe("/a/b\n");
		});

		it("dirname with no slash -> .", () => {
			const r = runBuiltin(python, "strings.cmd_dirname", { argv: ["dirname", "file.txt"] }) as Result;
			expect(r.stdout).toBe(".\n");
		});
	});

	describe("which", () => {
		it("resolves in PATH, prints path, exit 0", () => {
			const r = runBuiltin(python, "strings.cmd_which", {
				argv: ["which", "python3"],
				env: { PATH: process.env.PATH ?? "" },
			}) as Result;
			if (process.platform !== "win32") {
				expect(r.exitCode).toBe(0);
				expect(r.stdout.trim().endsWith("python3")).toBe(true);
			}
		});

		it("not found -> no stdout + exit 1", () => {
			const r = runBuiltin(python, "strings.cmd_which", {
				argv: ["which", "definitely-not-a-real-binary-xyz"],
				env: { PATH: "/nonexistent" },
			}) as Result;
			expect(r.stdout).toBe("");
			expect(r.exitCode).toBe(1);
		});
	});

	describe("true / false / pwd", () => {
		it("true -> exit 0", () => {
			const r = runBuiltin(python, "strings.cmd_true", { argv: ["true"] }) as Result;
			expect(r.exitCode).toBe(0);
		});

		it("false -> exit 1", () => {
			const r = runBuiltin(python, "strings.cmd_false", { argv: ["false"] }) as Result;
			expect(r.exitCode).toBe(1);
		});

		it("pwd prints state.cwd", () => {
			const r = runBuiltin(python, "strings.cmd_pwd", { argv: ["pwd"], cwd: "/tmp/somewhere" }) as Result;
			expect(r.stdout).toBe("/tmp/somewhere\n");
		});

		it("pwd -P prints the same resolved cwd", () => {
			const r = runBuiltin(python, "strings.cmd_pwd", { argv: ["pwd", "-P"], cwd: "/tmp/somewhere" }) as Result;
			expect(r.stdout).toBe("/tmp/somewhere\n");
		});
	});

	describe("test / [", () => {
		it("string equality", () => {
			const r = runBuiltin(python, "strings.cmd_test", { argv: ["test", "abc", "=", "abc"] }) as Result;
			expect(r.exitCode).toBe(0);
		});

		it("string inequality", () => {
			const r = runBuiltin(python, "strings.cmd_test", { argv: ["test", "abc", "!=", "abc"] }) as Result;
			expect(r.exitCode).toBe(1);
		});

		it("integer comparisons", () => {
			expect((runBuiltin(python, "strings.cmd_test", { argv: ["test", "3", "-eq", "3"] }) as Result).exitCode).toBe(
				0,
			);
			expect((runBuiltin(python, "strings.cmd_test", { argv: ["test", "3", "-lt", "5"] }) as Result).exitCode).toBe(
				0,
			);
			expect((runBuiltin(python, "strings.cmd_test", { argv: ["test", "3", "-gt", "5"] }) as Result).exitCode).toBe(
				1,
			);
		});

		it("-z / -n unary", () => {
			expect((runBuiltin(python, "strings.cmd_test", { argv: ["test", "-z", ""] }) as Result).exitCode).toBe(0);
			expect((runBuiltin(python, "strings.cmd_test", { argv: ["test", "-n", "x"] }) as Result).exitCode).toBe(0);
		});

		it("-e/-f/-d filesystem unary", () => {
			expect((runBuiltin(python, "strings.cmd_test", { argv: ["test", "-d", "/tmp"] }) as Result).exitCode).toBe(0);
			expect(
				(runBuiltin(python, "strings.cmd_test", { argv: ["test", "-e", "/nonexistent-xyz-abc"] }) as Result)
					.exitCode,
			).toBe(1);
		});

		it("-e/-f/-d resolve a relative operand against ctx.cwd, not the process cwd", () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-strings-test-"));
			writeFileSync(join(dir, "a.txt"), "hi");
			expect(
				(runBuiltin(python, "strings.cmd_test", { argv: ["test", "-f", "a.txt"], cwd: dir }) as Result).exitCode,
			).toBe(0);
			expect(
				(
					runBuiltin(python, "strings.cmd_test", {
						argv: ["test", "-f", "a.txt"],
						cwd: process.cwd(),
					}) as Result
				).exitCode,
			).toBe(1);
		});

		it("leading ! negates", () => {
			const r = runBuiltin(python, "strings.cmd_test", { argv: ["test", "!", "abc", "=", "abc"] }) as Result;
			expect(r.exitCode).toBe(1);
		});

		it("[ requires closing ]", () => {
			const r = runBuiltin(python, "strings.cmd_test", { argv: ["[", "1", "-eq", "1"] }) as Refusal;
			expect(r.refused).toBe(true);
			expect(r.code).toBe("unsupported");
			expect(r.construct).toBe("malformed-syntax");
		});

		it("[ 1 -eq 1 ] with closing bracket works", () => {
			const r = runBuiltin(python, "strings.cmd_test", { argv: ["[", "1", "-eq", "1", "]"] }) as Result;
			expect(r.exitCode).toBe(0);
		});

		it("-a / -o combiners -> unsupported-flag refusal", () => {
			const r = runBuiltin(python, "strings.cmd_test", {
				argv: ["test", "1", "-eq", "1", "-a", "2", "-eq", "2"],
			}) as Refusal;
			expect(r.refused).toBe(true);
			expect(r.code).toBe("unsupported");
			expect(r.construct).toBe("unsupported-flag");
		});
	});

	describe("out-of-matrix refusals (one per builtin)", () => {
		it("basename: unknown flag -> unsupported-flag", () => {
			const r = runBuiltin(python, "strings.cmd_basename", { argv: ["basename", "--weird", "/a/b"] }) as Refusal;
			expect(r.refused).toBe(true);
			expect(r.construct).toBe("unsupported-flag");
		});

		it("dirname: unknown flag -> unsupported-flag", () => {
			const r = runBuiltin(python, "strings.cmd_dirname", { argv: ["dirname", "-x", "/a/b"] }) as Refusal;
			expect(r.refused).toBe(true);
			expect(r.construct).toBe("unsupported-flag");
		});

		it("which: unknown flag -> unsupported-flag", () => {
			const r = runBuiltin(python, "strings.cmd_which", { argv: ["which", "-a", "ls"] }) as Refusal;
			expect(r.refused).toBe(true);
			expect(r.construct).toBe("unsupported-flag");
		});

		it("pwd: unknown flag -> unsupported-flag", () => {
			const r = runBuiltin(python, "strings.cmd_pwd", { argv: ["pwd", "-x"] }) as Refusal;
			expect(r.refused).toBe(true);
			expect(r.construct).toBe("unsupported-flag");
		});

		it("echo: printf missing FORMAT -> unsupported-flag", () => {
			const r = runBuiltin(python, "strings.cmd_printf", { argv: ["printf"] }) as Refusal;
			expect(r.refused).toBe(true);
			expect(r.construct).toBe("unsupported-flag");
		});
	});
});
