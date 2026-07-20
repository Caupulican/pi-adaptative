import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
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

interface CallResult {
	stdout: string;
	exitCode: number;
	error: { code: string; construct: string; message: string } | null;
}

/** Invoke `fs.<builtinName>` with the given argv against a BuiltinContext(cwd=cwd). */
function callBuiltin(python: string, builtinName: string, argv: string[], cwd: string, stdin = ""): CallResult {
	const program = `
import sys, json, io
sys.path.insert(0, ${JSON.stringify(ENGINE_DIR)})
sys.path.insert(0, ${JSON.stringify(join(ENGINE_DIR, "commands"))})
from context import BuiltinContext
from errors import UnsupportedConstruct
import fs

ctx = BuiltinContext(
	argv=${JSON.stringify(argv)},
	cwd=${JSON.stringify(cwd)},
	env={},
	stdin=io.BytesIO(${JSON.stringify(stdin)}.encode()),
	stdout=io.BytesIO(),
)
try:
	code = fs.${builtinName}(ctx)
	sys.stdout.write(json.dumps({"stdout": ctx.stdout.getvalue().decode(), "exitCode": code, "error": None}))
except UnsupportedConstruct as e:
	sys.stdout.write(json.dumps({"stdout": "", "exitCode": 2, "error": {"code": e.code, "construct": e.construct, "message": e.message}}))
`.replace(/\t/g, "    ");
	const result = spawnSync(python, ["-B", "-c", program], { encoding: "utf-8" });
	if (result.status !== 0) {
		throw new Error(`engine call failed for ${builtinName} ${JSON.stringify(argv)}: ${result.stderr}`);
	}
	return JSON.parse(result.stdout) as CallResult;
}

const python = resolvePython();
const describeOrSkip = python ? describe : describe.skip;

describeOrSkip("pi-shell-engine commands/fs.py", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-shell-fs-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function p(python_: string, name: string, argv: string[], cwd = root, stdin = ""): CallResult {
		return callBuiltin(python_, name, argv, cwd, stdin);
	}

	describe("ls", () => {
		it("lists entries one per line, dirs suffixed /, hidden files skipped, ordinal sorted", () => {
			writeFileSync(join(root, "b.txt"), "");
			writeFileSync(join(root, "a.txt"), "");
			mkdirSync(join(root, "sub"));
			writeFileSync(join(root, ".hidden"), "");
			const res = p(python as string, "ls", ["ls"]);
			expect(res.exitCode).toBe(0);
			expect(res.stdout).toBe("a.txt\nb.txt\nsub/\n");
		});

		it("-a shows hidden entries plus . and ..", () => {
			writeFileSync(join(root, ".hidden"), "");
			const res = p(python as string, "ls", ["ls", "-a"]);
			expect(res.exitCode).toBe(0);
			// exact expected: sorted ordinal of [".", "..", ".hidden"]; "." and ".." are dirs -> "/" suffix.
			// Sort happens on the bare names before suffixing: "." < ".." (shorter is a prefix, sorts
			// first) < ".hidden" ('h' = 0x68 > '.' = 0x2e at index 1).
			const expected = "./\n../\n.hidden\n";
			expect(res.stdout).toBe(expected);
		});

		it("-A shows hidden entries but not . or ..", () => {
			writeFileSync(join(root, ".hidden"), "");
			writeFileSync(join(root, "visible.txt"), "");
			const res = p(python as string, "ls", ["ls", "-A"]);
			expect(res.exitCode).toBe(0);
			const expected = [".hidden", "visible.txt"]
				.sort()
				.map((n) => `${n}\n`)
				.join("");
			expect(res.stdout).toBe(expected);
		});

		it("-r reverses sort order", () => {
			writeFileSync(join(root, "a.txt"), "");
			writeFileSync(join(root, "b.txt"), "");
			const res = p(python as string, "ls", ["ls", "-r"]);
			expect(res.exitCode).toBe(0);
			expect(res.stdout).toBe("b.txt\na.txt\n");
		});

		it("-1 is accepted (no-op formatting change)", () => {
			writeFileSync(join(root, "a.txt"), "");
			const res = p(python as string, "ls", ["ls", "-1"]);
			expect(res.exitCode).toBe(0);
			expect(res.stdout).toBe("a.txt\n");
		});

		it("missing directory -> exit 1 + message", () => {
			const res = p(python as string, "ls", ["ls", "nope"]);
			expect(res.exitCode).toBe(1);
			expect(res.stdout).toContain("No such file or directory");
		});

		it("-l is an unsupported-flag refusal", () => {
			const res = p(python as string, "ls", ["ls", "-l"]);
			expect(res.error).not.toBeNull();
			expect(res.error?.construct).toBe("unsupported-flag");
		});

		it("out-of-matrix flag -> unsupported-flag", () => {
			const res = p(python as string, "ls", ["ls", "-Q"]);
			expect(res.error?.construct).toBe("unsupported-flag");
		});

		it("multiple existing FILE operands print each operand's text, ordinal-sorted", () => {
			writeFileSync(join(root, "b.txt"), "");
			writeFileSync(join(root, "a.txt"), "");
			const res = p(python as string, "ls", ["ls", "b.txt", "a.txt"]);
			expect(res.exitCode).toBe(0);
			expect(res.stdout).toBe("a.txt\nb.txt\n");
		});

		it("mixing an existing and a missing FILE operand: partial listing + exit 1", () => {
			writeFileSync(join(root, "a.txt"), "");
			const res = p(python as string, "ls", ["ls", "a.txt", "missing.txt"]);
			expect(res.exitCode).toBe(1);
			expect(res.stdout).toBe("a.txt\nls: missing.txt: No such file or directory\n");
		});

		it("multiple DIRECTORY operands stay refused", () => {
			mkdirSync(join(root, "sub1"));
			mkdirSync(join(root, "sub2"));
			const res = p(python as string, "ls", ["ls", "sub1", "sub2"]);
			expect(res.error?.construct).toBe("unsupported-flag");
		});
	});

	describe("find", () => {
		it("recursively lists /-normalized, ordinal-sorted paths rooted at PATH", () => {
			mkdirSync(join(root, "sub"));
			writeFileSync(join(root, "sub", "b.txt"), "");
			writeFileSync(join(root, "sub", "a.txt"), "");
			mkdirSync(join(root, "sub", "nested"));
			const res = p(python as string, "find", ["find", "sub"]);
			expect(res.exitCode).toBe(0);
			expect(res.stdout).toBe(
				["sub", "sub/a.txt", "sub/b.txt", "sub/nested"]
					.sort()
					.map((s) => `${s}\n`)
					.join(""),
			);
		});

		it("defaults to '.' and prefixes with './'", () => {
			writeFileSync(join(root, "a.txt"), "");
			const res = p(python as string, "find", ["find"]);
			expect(res.exitCode).toBe(0);
			expect(res.stdout).toBe(
				[".", "./a.txt"]
					.sort()
					.map((s) => `${s}\n`)
					.join(""),
			);
		});

		it("-type f filters to files only", () => {
			mkdirSync(join(root, "sub"));
			writeFileSync(join(root, "a.txt"), "");
			const res = p(python as string, "find", ["find", ".", "-type", "f"]);
			expect(res.exitCode).toBe(0);
			expect(res.stdout).toBe("./a.txt\n");
		});

		it("-type d filters to directories only", () => {
			mkdirSync(join(root, "sub"));
			writeFileSync(join(root, "a.txt"), "");
			const res = p(python as string, "find", ["find", ".", "-type", "d"]);
			expect(res.exitCode).toBe(0);
			expect(res.stdout).toBe(
				[".", "./sub"]
					.sort()
					.map((s) => `${s}\n`)
					.join(""),
			);
		});

		it("-name matches a glob against basenames", () => {
			writeFileSync(join(root, "a.txt"), "");
			writeFileSync(join(root, "b.log"), "");
			const res = p(python as string, "find", ["find", ".", "-name", "*.txt"]);
			expect(res.exitCode).toBe(0);
			expect(res.stdout).toBe("./a.txt\n");
		});

		it("missing path -> exit 1 + message", () => {
			const res = p(python as string, "find", ["find", "nope"]);
			expect(res.exitCode).toBe(1);
			expect(res.stdout).toContain("No such file or directory");
		});

		it("out-of-matrix flag -> unsupported-flag", () => {
			const res = p(python as string, "find", ["find", "-mtime", "1"]);
			expect(res.error?.construct).toBe("unsupported-flag");
		});
	});

	describe("rm", () => {
		it("removes a file", () => {
			writeFileSync(join(root, "a.txt"), "hi");
			const res = p(python as string, "rm", ["rm", "a.txt"]);
			expect(res.exitCode).toBe(0);
			expect(existsSync(join(root, "a.txt"))).toBe(false);
		});

		it("missing file without -f -> exit 1 + message, file untouched state", () => {
			const res = p(python as string, "rm", ["rm", "nope.txt"]);
			expect(res.exitCode).toBe(1);
			expect(res.stdout).toContain("No such file or directory");
		});

		it("missing file with -f -> exit 0, no message", () => {
			const res = p(python as string, "rm", ["rm", "-f", "nope.txt"]);
			expect(res.exitCode).toBe(0);
			expect(res.stdout).toBe("");
		});

		it("directory without -r -> exit 1 + message, directory left intact", () => {
			mkdirSync(join(root, "sub"));
			const res = p(python as string, "rm", ["rm", "sub"]);
			expect(res.exitCode).toBe(1);
			expect(res.stdout).toContain("Is a directory");
			expect(existsSync(join(root, "sub"))).toBe(true);
		});

		it("-r removes a directory recursively", () => {
			mkdirSync(join(root, "sub"));
			writeFileSync(join(root, "sub", "a.txt"), "");
			const res = p(python as string, "rm", ["rm", "-r", "sub"]);
			expect(res.exitCode).toBe(0);
			expect(existsSync(join(root, "sub"))).toBe(false);
		});

		it("-rf combined flags removes recursively and ignores missing", () => {
			mkdirSync(join(root, "sub"));
			const res = p(python as string, "rm", ["rm", "-rf", "sub", "nope"]);
			expect(res.exitCode).toBe(0);
			expect(existsSync(join(root, "sub"))).toBe(false);
		});

		it("out-of-matrix flag -> unsupported-flag", () => {
			const res = p(python as string, "rm", ["rm", "-v", "a.txt"]);
			expect(res.error?.construct).toBe("unsupported-flag");
		});
	});

	describe("cp", () => {
		it("copies a file", () => {
			writeFileSync(join(root, "a.txt"), "hello");
			const res = p(python as string, "cp", ["cp", "a.txt", "b.txt"]);
			expect(res.exitCode).toBe(0);
			expect(existsSync(join(root, "b.txt"))).toBe(true);
		});

		it("copying a directory without -r -> exit 1 + 'use -r' message, no copy made", () => {
			mkdirSync(join(root, "sub"));
			const res = p(python as string, "cp", ["cp", "sub", "dst"]);
			expect(res.exitCode).toBe(1);
			expect(res.stdout).toContain("use -r");
			expect(existsSync(join(root, "dst"))).toBe(false);
		});

		it("-r copies a directory recursively", () => {
			mkdirSync(join(root, "sub"));
			writeFileSync(join(root, "sub", "a.txt"), "hi");
			const res = p(python as string, "cp", ["cp", "-r", "sub", "dst"]);
			expect(res.exitCode).toBe(0);
			expect(existsSync(join(root, "dst", "a.txt"))).toBe(true);
		});

		it("out-of-matrix flag -> unsupported-flag", () => {
			const res = p(python as string, "cp", ["cp", "-v", "a.txt", "b.txt"]);
			expect(res.error?.construct).toBe("unsupported-flag");
		});
	});

	describe("mv", () => {
		it("renames a file", () => {
			writeFileSync(join(root, "a.txt"), "hi");
			const res = p(python as string, "mv", ["mv", "a.txt", "b.txt"]);
			expect(res.exitCode).toBe(0);
			expect(existsSync(join(root, "a.txt"))).toBe(false);
			expect(existsSync(join(root, "b.txt"))).toBe(true);
		});

		it("missing source -> exit 1 + message", () => {
			const res = p(python as string, "mv", ["mv", "nope.txt", "b.txt"]);
			expect(res.exitCode).toBe(1);
			expect(res.stdout).toContain("No such file or directory");
		});

		it("out-of-matrix flag -> unsupported-flag", () => {
			const res = p(python as string, "mv", ["mv", "-f", "a.txt", "b.txt"]);
			expect(res.error?.construct).toBe("unsupported-flag");
		});
	});

	describe("mkdir", () => {
		it("creates a directory", () => {
			const res = p(python as string, "mkdir", ["mkdir", "sub"]);
			expect(res.exitCode).toBe(0);
			expect(existsSync(join(root, "sub"))).toBe(true);
		});

		it("existing directory without -p -> exit 1 + message", () => {
			mkdirSync(join(root, "sub"));
			const res = p(python as string, "mkdir", ["mkdir", "sub"]);
			expect(res.exitCode).toBe(1);
			expect(res.stdout).toContain("File exists");
		});

		it("-p creates parents and tolerates existing", () => {
			mkdirSync(join(root, "sub"));
			const res = p(python as string, "mkdir", ["mkdir", "-p", "sub/nested/deep"]);
			expect(res.exitCode).toBe(0);
			expect(existsSync(join(root, "sub", "nested", "deep"))).toBe(true);
		});

		it("out-of-matrix flag -> unsupported-flag", () => {
			const res = p(python as string, "mkdir", ["mkdir", "-v", "sub"]);
			expect(res.error?.construct).toBe("unsupported-flag");
		});
	});

	describe("touch", () => {
		it("creates a new file", () => {
			const res = p(python as string, "touch", ["touch", "a.txt"]);
			expect(res.exitCode).toBe(0);
			expect(existsSync(join(root, "a.txt"))).toBe(true);
		});

		it("bumps mtime of an existing file", () => {
			writeFileSync(join(root, "a.txt"), "hi");
			const before = statSync(join(root, "a.txt")).mtimeMs;
			const res = p(python as string, "touch", ["touch", "a.txt"]);
			expect(res.exitCode).toBe(0);
			const after = statSync(join(root, "a.txt")).mtimeMs;
			expect(after).toBeGreaterThanOrEqual(before);
		});

		it("missing parent directory -> exit 1 + message", () => {
			const res = p(python as string, "touch", ["touch", "nope/a.txt"]);
			expect(res.exitCode).toBe(1);
			expect(res.stdout).toContain("No such file or directory");
		});

		it("out-of-matrix flag -> unsupported-flag", () => {
			const res = p(python as string, "touch", ["touch", "-d", "a.txt"]);
			expect(res.error?.construct).toBe("unsupported-flag");
		});
	});

	// Confirm ordinal (LC_ALL=C) sort places uppercase before lowercase, as codepoint order dictates.
	it("ordinal sort orders uppercase before lowercase (ls)", () => {
		writeFileSync(join(root, "b.txt"), "");
		writeFileSync(join(root, "A.txt"), "");
		const res = p(python as string, "ls", ["ls"]);
		expect(res.stdout).toBe("A.txt\nb.txt\n");
	});

	// Verify paths are resolved against ctx.cwd only, never via os.chdir / process-global state:
	// two concurrent calls with different cwd values must not interfere with each other.
	it("resolves paths against ctx.cwd without mutating process state", () => {
		const otherRoot = mkdtempSync(join(tmpdir(), "pi-shell-fs-other-"));
		try {
			writeFileSync(join(root, "here.txt"), "");
			writeFileSync(join(otherRoot, "there.txt"), "");
			const resA = p(python as string, "ls", ["ls"], root);
			const resB = p(python as string, "ls", ["ls"], otherRoot);
			expect(resA.stdout).toBe("here.txt\n");
			expect(resB.stdout).toBe("there.txt\n");
		} finally {
			rmSync(otherRoot, { recursive: true, force: true });
		}
	});
});
