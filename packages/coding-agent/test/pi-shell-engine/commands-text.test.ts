import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

interface RunResult {
	stdout: string;
	exitCode: number;
}

function runBuiltin(python: string, cwd: string, name: string, argv: string[], stdin: string): RunResult {
	const program = `
import sys, io, json, base64, importlib.util, os
sys.path.insert(0, ${JSON.stringify(ENGINE_DIR)})
from context import BuiltinContext
# Load commands/text.py directly, bypassing commands/__init__.py (owned by a
# concurrently-landing sibling package) so this test only depends on the
# frozen context/errors modules and this package's own file.
_spec = importlib.util.spec_from_file_location("pi_shell_text", os.path.join(${JSON.stringify(ENGINE_DIR)}, "commands", "text.py"))
_text = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_text)
${name} = _text.${name}

stdin_bytes = base64.b64decode(${JSON.stringify(Buffer.from(stdin, "utf-8").toString("base64"))})
stdin = io.BytesIO(stdin_bytes)
stdout = io.BytesIO()
ctx = BuiltinContext(argv=${JSON.stringify(argv)}, cwd=${JSON.stringify(cwd)}, env={}, stdin=stdin, stdout=stdout)
exit_code = ${name}(ctx)
print(json.dumps({"stdout": base64.b64encode(stdout.getvalue()).decode("ascii"), "exitCode": exit_code}))
`;
	const result = spawnSync(python, ["-B", "-c", program], { encoding: "utf-8", cwd });
	if (result.status !== 0) {
		throw new Error(`builtin ${name} crashed: ${result.stderr}`);
	}
	const parsed = JSON.parse(result.stdout) as { stdout: string; exitCode: number };
	return { stdout: Buffer.from(parsed.stdout, "base64").toString("utf-8"), exitCode: parsed.exitCode };
}

function runRefusal(
	python: string,
	cwd: string,
	name: string,
	argv: string[],
	stdin: string,
): { code: string; construct: string; message: string } {
	const program = `
import sys, io, json, base64, importlib.util, os
sys.path.insert(0, ${JSON.stringify(ENGINE_DIR)})
from context import BuiltinContext
from errors import UnsupportedConstruct
_spec = importlib.util.spec_from_file_location("pi_shell_text", os.path.join(${JSON.stringify(ENGINE_DIR)}, "commands", "text.py"))
_text = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_text)
${name} = _text.${name}

stdin_bytes = base64.b64decode(${JSON.stringify(Buffer.from(stdin, "utf-8").toString("base64"))})
stdin = io.BytesIO(stdin_bytes)
stdout = io.BytesIO()
ctx = BuiltinContext(argv=${JSON.stringify(argv)}, cwd=${JSON.stringify(cwd)}, env={}, stdin=stdin, stdout=stdout)
try:
	${name}(ctx)
	print(json.dumps({"refused": False}))
except UnsupportedConstruct as e:
	print(json.dumps({"refused": True, "code": e.code, "construct": e.construct, "message": e.message}))
`;
	const result = spawnSync(python, ["-B", "-c", program], { encoding: "utf-8", cwd });
	if (result.status !== 0) {
		throw new Error(`builtin ${name} refusal probe crashed: ${result.stderr}`);
	}
	const parsed = JSON.parse(result.stdout) as {
		refused: boolean;
		code?: string;
		construct?: string;
		message?: string;
	};
	if (!parsed.refused) throw new Error(`expected refusal for ${name} ${argv.join(" ")}`);
	return { code: parsed.code as string, construct: parsed.construct as string, message: parsed.message as string };
}

describe("pi-shell-engine commands/text.py", () => {
	const python = resolvePython();
	if (!python) {
		it.skip("no Python interpreter available", () => {});
		return;
	}

	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "pi-shell-text-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	describe("cat", () => {
		it("byte-exact single file", () => {
			writeFileSync(join(cwd, "a.txt"), "hello\nworld\n");
			const res = runBuiltin(python, cwd, "cat", ["cat", "a.txt"], "");
			expect(res).toEqual({ stdout: "hello\nworld\n", exitCode: 0 });
		});

		it("concatenates multiple files in argv order", () => {
			writeFileSync(join(cwd, "a.txt"), "A\n");
			writeFileSync(join(cwd, "b.txt"), "B\n");
			const res = runBuiltin(python, cwd, "cat", ["cat", "a.txt", "b.txt"], "");
			expect(res).toEqual({ stdout: "A\nB\n", exitCode: 0 });
		});

		it("reads stdin with no operand", () => {
			const res = runBuiltin(python, cwd, "cat", ["cat"], "piped\n");
			expect(res).toEqual({ stdout: "piped\n", exitCode: 0 });
		});

		it("- reads stdin", () => {
			const res = runBuiltin(python, cwd, "cat", ["cat", "-"], "piped\n");
			expect(res).toEqual({ stdout: "piped\n", exitCode: 0 });
		});

		it("unknown flag -> unsupported-flag", () => {
			const refusal = runRefusal(python, cwd, "cat", ["cat", "-n"], "");
			expect(refusal.code).toBe("unsupported");
			expect(refusal.construct).toBe("unsupported-flag");
		});
	});

	describe("head", () => {
		beforeEach(() => {
			writeFileSync(join(cwd, "lines.txt"), `${Array.from({ length: 15 }, (_, i) => `line${i + 1}`).join("\n")}\n`);
		});

		it("default 10 lines from file", () => {
			const res = runBuiltin(python, cwd, "head", ["head", "lines.txt"], "");
			expect(res.stdout).toBe(`${Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n")}\n`);
			expect(res.exitCode).toBe(0);
		});

		it("-n N from stdin", () => {
			const stdin = `${Array.from({ length: 5 }, (_, i) => `s${i + 1}`).join("\n")}\n`;
			const res = runBuiltin(python, cwd, "head", ["head", "-n", "2"], stdin);
			expect(res.stdout).toBe("s1\ns2\n");
			expect(res.exitCode).toBe(0);
		});

		it("head -n +N is out-of-matrix -> unsupported-flag", () => {
			const refusal = runRefusal(python, cwd, "head", ["head", "-n", "+3"], "a\nb\n");
			expect(refusal.construct).toBe("unsupported-flag");
		});

		it("multi-file form is out-of-matrix -> unsupported-flag", () => {
			writeFileSync(join(cwd, "b.txt"), "x\n");
			const refusal = runRefusal(python, cwd, "head", ["head", "lines.txt", "b.txt"], "");
			expect(refusal.construct).toBe("unsupported-flag");
		});
	});

	describe("tail", () => {
		beforeEach(() => {
			writeFileSync(join(cwd, "lines.txt"), `${Array.from({ length: 15 }, (_, i) => `line${i + 1}`).join("\n")}\n`);
		});

		it("default 10 lines from file", () => {
			const res = runBuiltin(python, cwd, "tail", ["tail", "lines.txt"], "");
			expect(res.stdout).toBe(`${Array.from({ length: 10 }, (_, i) => `line${i + 6}`).join("\n")}\n`);
			expect(res.exitCode).toBe(0);
		});

		it("-n N from stdin", () => {
			const stdin = `${Array.from({ length: 5 }, (_, i) => `s${i + 1}`).join("\n")}\n`;
			const res = runBuiltin(python, cwd, "tail", ["tail", "-n", "2"], stdin);
			expect(res.stdout).toBe("s4\ns5\n");
		});

		it("-f is out-of-matrix -> unsupported-flag", () => {
			const refusal = runRefusal(python, cwd, "tail", ["tail", "-f", "lines.txt"], "");
			expect(refusal.construct).toBe("unsupported-flag");
		});

		it("-n +N is out-of-matrix -> unsupported-flag", () => {
			const refusal = runRefusal(python, cwd, "tail", ["tail", "-n", "+3"], "a\nb\n");
			expect(refusal.construct).toBe("unsupported-flag");
		});
	});

	describe("wc", () => {
		it("single -l flag with stdin -> bare integer (D)", () => {
			const res = runBuiltin(python, cwd, "wc", ["wc", "-l"], "a\nb\nc\n");
			expect(res.stdout).toBe("3\n");
		});

		it("single -w flag with stdin -> bare integer (D)", () => {
			const res = runBuiltin(python, cwd, "wc", ["wc", "-w"], "one two three\n");
			expect(res.stdout).toBe("3\n");
		});

		it("single -c flag with stdin -> bare integer (D)", () => {
			const res = runBuiltin(python, cwd, "wc", ["wc", "-c"], "abcd");
			expect(res.stdout).toBe("4\n");
		});

		it("single -m flag with stdin -> bare integer (D)", () => {
			const res = runBuiltin(python, cwd, "wc", ["wc", "-m"], "café");
			expect(res.stdout).toBe("4\n");
		});

		it("bare wc on file -> GNU column form (C)", () => {
			writeFileSync(join(cwd, "f.txt"), "a b\nc d e\n");
			const res = runBuiltin(python, cwd, "wc", ["wc", "f.txt"], "");
			expect(res.stdout).toBe("      2      5     10 f.txt\n");
		});

		it("unknown flag -> unsupported-flag", () => {
			const refusal = runRefusal(python, cwd, "wc", ["wc", "-x"], "");
			expect(refusal.construct).toBe("unsupported-flag");
		});
	});

	describe("sort", () => {
		it("default ordinal ascending from stdin (D)", () => {
			const res = runBuiltin(python, cwd, "sort", ["sort"], "banana\nApple\ncherry\n");
			expect(res.stdout).toBe("Apple\nbanana\ncherry\n");
		});

		it("-r reverse", () => {
			const res = runBuiltin(python, cwd, "sort", ["sort", "-r"], "a\nb\nc\n");
			expect(res.stdout).toBe("c\nb\na\n");
		});

		it("-n numeric", () => {
			const res = runBuiltin(python, cwd, "sort", ["sort", "-n"], "10\n2\n1\n");
			expect(res.stdout).toBe("1\n2\n10\n");
		});

		it("-u unique", () => {
			const res = runBuiltin(python, cwd, "sort", ["sort", "-u"], "b\na\nb\na\n");
			expect(res.stdout).toBe("a\nb\n");
		});

		it("-f fold case", () => {
			const res = runBuiltin(python, cwd, "sort", ["sort", "-f"], "banana\nApple\ncherry\n");
			expect(res.stdout).toBe("Apple\nbanana\ncherry\n");
		});

		it("unknown flag -> unsupported-flag", () => {
			const refusal = runRefusal(python, cwd, "sort", ["sort", "-k"], "a\n");
			expect(refusal.construct).toBe("unsupported-flag");
		});
	});

	describe("uniq", () => {
		it("plain adjacent dedup from stdin (D)", () => {
			const res = runBuiltin(python, cwd, "uniq", ["uniq"], "a\na\nb\nb\nb\nc\n");
			expect(res.stdout).toBe("a\nb\nc\n");
		});

		it("-d only duplicated lines (D)", () => {
			const res = runBuiltin(python, cwd, "uniq", ["uniq", "-d"], "a\na\nb\nc\nc\n");
			expect(res.stdout).toBe("a\nc\n");
		});

		it("-u only unique lines (D)", () => {
			const res = runBuiltin(python, cwd, "uniq", ["uniq", "-u"], "a\na\nb\nc\nc\n");
			expect(res.stdout).toBe("b\n");
		});

		it("-c GNU column width (C)", () => {
			const res = runBuiltin(python, cwd, "uniq", ["uniq", "-c"], "a\na\nb\n");
			expect(res.stdout).toBe("      2 a\n      1 b\n");
		});

		it("unknown flag -> unsupported-flag", () => {
			const refusal = runRefusal(python, cwd, "uniq", ["uniq", "-z"], "a\n");
			expect(refusal.construct).toBe("unsupported-flag");
		});
	});

	describe("cut", () => {
		it("-f with default TAB delim", () => {
			const res = runBuiltin(python, cwd, "cut", ["cut", "-f", "2"], "a\tb\tc\n");
			expect(res.stdout).toBe("b\n");
		});

		it("-d DELIM -f LIST (comma list)", () => {
			const res = runBuiltin(python, cwd, "cut", ["cut", "-d", ",", "-f", "1,3"], "a,b,c\n");
			expect(res.stdout).toBe("a,c\n");
		});

		it("-f range N-M", () => {
			const res = runBuiltin(python, cwd, "cut", ["cut", "-d", ",", "-f", "2-3"], "a,b,c,d\n");
			expect(res.stdout).toBe("b,c\n");
		});

		it("-f open range N-", () => {
			const res = runBuiltin(python, cwd, "cut", ["cut", "-d", ",", "-f", "2-"], "a,b,c\n");
			expect(res.stdout).toBe("b,c\n");
		});

		it("-c LIST", () => {
			const res = runBuiltin(python, cwd, "cut", ["cut", "-c", "1-3"], "abcdef\n");
			expect(res.stdout).toBe("abc\n");
		});

		it("missing -f/-c -> unsupported-flag", () => {
			const refusal = runRefusal(python, cwd, "cut", ["cut"], "a,b\n");
			expect(refusal.construct).toBe("unsupported-flag");
		});

		it("unknown flag -> unsupported-flag", () => {
			const refusal = runRefusal(python, cwd, "cut", ["cut", "-z", "-f", "1"], "a\n");
			expect(refusal.construct).toBe("unsupported-flag");
		});
	});

	describe("tr", () => {
		it("basic SET1 SET2 translation", () => {
			const res = runBuiltin(python, cwd, "tr", ["tr", "a-z", "A-Z"], "hello");
			expect(res.stdout).toBe("HELLO");
		});

		it("-d delete", () => {
			const res = runBuiltin(python, cwd, "tr", ["tr", "-d", "aeiou"], "hello world");
			expect(res.stdout).toBe("hll wrld");
		});

		it("-s squeeze", () => {
			const res = runBuiltin(python, cwd, "tr", ["tr", "-s", "l"], "hello");
			expect(res.stdout).toBe("helo");
		});

		it("-c complement", () => {
			const res = runBuiltin(python, cwd, "tr", ["tr", "-c", "a-z", "_"], "abc123");
			expect(res.stdout).toBe("abc___");
		});

		it("character classes [:upper:]/[:lower:]", () => {
			const res = runBuiltin(python, cwd, "tr", ["tr", "[:lower:]", "[:upper:]"], "abcXYZ");
			expect(res.stdout).toBe("ABCXYZ");
		});

		it("unknown flag -> unsupported-flag", () => {
			const refusal = runRefusal(python, cwd, "tr", ["tr", "-x", "a", "b"], "abc");
			expect(refusal.construct).toBe("unsupported-flag");
		});
	});
});
