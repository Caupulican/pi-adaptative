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

function runProgram(python: string, program: string): { stdout: string; stderr: string; status: number | null } {
	const result = spawnSync(python, ["-B", "-c", program], { encoding: "utf-8" });
	return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

const HARNESS = `
import sys, json
sys.path.insert(0, ${JSON.stringify(ENGINE_DIR)})
from tokens import tokenize
from parser import parse
from expand import expand_word, ParamExpansionError
from errors import UnsupportedConstruct

class FakeState:
    def __init__(self, env, cwd):
        self.env = dict(env)
        self.cwd = cwd

class FakeCtx:
    def __init__(self, env, cwd, sub_result=("", 0)):
        self.state = FakeState(env, cwd)
        self.stdin = None
        self.stdout = None
        self.expand_word = None
        self.run_command_substitution = lambda src, ctx: sub_result
        self.builtins = {}
        self.deadline = None

def word_of(command):
    tokens = tokenize(command)
    ast = parse(tokens)
    simple = ast.entries[0].pipelines[0].elements[0]
    return simple.words[-1]

def run(command, env, cwd, sub_result=("", 0)):
    ctx = FakeCtx(env, cwd, sub_result)
    word = word_of(command)
    try:
        result = expand_word(word, ctx)
        print(json.dumps({"ok": True, "result": result, "env": dict(ctx.state.env)}))
    except UnsupportedConstruct as e:
        print(json.dumps({"ok": False, "code": e.code, "construct": e.construct, "message": e.message}))
    except ParamExpansionError as e:
        print(json.dumps({"ok": False, "paramError": True, "name": e.name, "message": e.message}))
`;

function expand(
	python: string,
	command: string,
	env: Record<string, string>,
	cwd: string,
	subResult: [string, number] = ["", 0],
): {
	ok: boolean;
	result?: string[];
	env?: Record<string, string>;
	code?: string;
	construct?: string;
	message?: string;
	paramError?: boolean;
	name?: string;
} {
	const program = `${HARNESS}
run(${JSON.stringify(command)}, ${JSON.stringify(env)}, ${JSON.stringify(cwd)}, ${JSON.stringify(subResult)})
`;
	const { stdout, stderr, status } = runProgram(python, program);
	if (status !== 0) throw new Error(`expand probe crashed for ${JSON.stringify(command)}: ${stderr}`);
	const lines = stdout.trim().split("\n");
	return JSON.parse(lines[lines.length - 1]);
}

describe("pi-shell-engine expand_word", () => {
	const python = resolvePython();
	if (!python) {
		it.skip("no Python interpreter available", () => {});
		return;
	}

	const tmpDir = mkdtempSync(join(tmpdir(), "pi-shell-expand-"));
	writeFileSync(join(tmpDir, "a.txt"), "");
	writeFileSync(join(tmpDir, "b.txt"), "");
	writeFileSync(join(tmpDir, "c.log"), "");

	it("literal (single-quoted): no expansion, no glob, no split", () => {
		const out = expand(python, "echo 'a b $x *.txt'", {}, tmpDir);
		expect(out.ok).toBe(true);
		expect(out.result).toEqual(["a b $x *.txt"]);
	});

	it("$VAR and $" + "{VAR}", () => {
		const out1 = expand(python, "echo $VAR", { VAR: "hello" }, tmpDir);
		expect(out1.result).toEqual(["hello"]);
		const out2 = expand(python, "echo $" + "{VAR}", { VAR: "hello" }, tmpDir);
		expect(out2.result).toEqual(["hello"]);
	});

	it("unset $VAR expands to empty (zero fields when unquoted)", () => {
		const out = expand(python, "echo $UNSET", {}, tmpDir);
		expect(out.result).toEqual([]);
	});

	it("$" + "{V:-w}: default when unset/empty, else value", () => {
		expect(expand(python, "echo $" + "{V:-w}", {}, tmpDir).result).toEqual(["w"]);
		expect(expand(python, "echo $" + "{V:-w}", { V: "" }, tmpDir).result).toEqual(["w"]);
		expect(expand(python, "echo $" + "{V:-w}", { V: "set" }, tmpDir).result).toEqual(["set"]);
	});

	it("$" + "{V:=w}: assigns back to state.env when unset/empty", () => {
		const out = expand(python, "echo $" + "{V:=w}", {}, tmpDir);
		expect(out.result).toEqual(["w"]);
		expect(out.env?.V).toBe("w");
		const outSet = expand(python, "echo $" + "{V:=w}", { V: "already" }, tmpDir);
		expect(outSet.result).toEqual(["already"]);
		expect(outSet.env?.V).toBe("already");
	});

	it("$" + "{V:+w}: alt value only when set/non-empty", () => {
		expect(expand(python, "echo $" + "{V:+w}", {}, tmpDir).result).toEqual([]);
		expect(expand(python, "echo $" + "{V:+w}", { V: "x" }, tmpDir).result).toEqual(["w"]);
	});

	it("$" + "{V:?w}: raises ParamExpansionError when unset/empty", () => {
		const out = expand(python, "echo $" + "{V:?w}", {}, tmpDir);
		expect(out.ok).toBe(false);
		expect(out.paramError).toBe(true);
		expect(out.message).toBe("w");
		const outSet = expand(python, "echo $" + "{V:?w}", { V: "x" }, tmpDir);
		expect(outSet.result).toEqual(["x"]);
	});

	it("$" + "{#VAR}: character length", () => {
		expect(expand(python, "echo $" + "{#VAR}", { VAR: "hello" }, tmpDir).result).toEqual(["5"]);
		expect(expand(python, "echo $" + "{#VAR}", {}, tmpDir).result).toEqual(["0"]);
	});

	it("single vs double quoting: split vs no-split", () => {
		const unquoted = expand(python, "echo $VAR", { VAR: "a b" }, tmpDir);
		expect(unquoted.result).toEqual(["a", "b"]);
		const dq = expand(python, 'echo "$VAR"', { VAR: "a b" }, tmpDir);
		expect(dq.result).toEqual(["a b"]);
	});

	it("tilde: ~ and ~/path expand to $HOME", () => {
		const bare = expand(python, "echo ~", { HOME: "/home/x" }, tmpDir);
		expect(bare.result).toEqual(["/home/x"]);
		const withPath = expand(python, "echo ~/sub", { HOME: "/home/x" }, tmpDir);
		expect(withPath.result).toEqual(["/home/x/sub"]);
	});

	it("tilde-user: ~user raises structured refusal", () => {
		const out = expand(python, "echo ~bob", { HOME: "/home/x" }, tmpDir);
		expect(out.ok).toBe(false);
		expect(out.code).toBe("unsupported");
		expect(out.construct).toBe("tilde-user");
	});

	it("command substitution: unquoted splits, quoted stays one field", () => {
		const unquoted = expand(python, "echo $(cmd)", {}, tmpDir, ["a b\n", 0]);
		expect(unquoted.result).toEqual(["a", "b"]);
		const quoted = expand(python, 'echo "$(cmd)"', {}, tmpDir, ["a b\n", 0]);
		expect(quoted.result).toEqual(["a b"]);
	});

	it("glob: matches sorted ordinally, no-match falls back to literal", () => {
		const matched = expand(python, "echo *.txt", {}, tmpDir);
		expect(matched.result).toEqual(["a.txt", "b.txt"]);
		const noMatch = expand(python, "echo *.nope", {}, tmpDir);
		expect(noMatch.result).toEqual(["*.nope"]);
	});

	it("architect fix #12: unquoted $VAR holding a glob pattern IS glob-eligible", () => {
		const out = expand(python, "echo $PAT", { PAT: "*.txt" }, tmpDir);
		expect(out.result).toEqual(["a.txt", "b.txt"]);
	});

	it('architect fix #12: quoted "$VAR" holding a glob pattern stays literal (no glob)', () => {
		const out = expand(python, 'echo "$PAT"', { PAT: "*.txt" }, tmpDir);
		expect(out.result).toEqual(["*.txt"]);
	});

	it("architect fix #12: unquoted $(cmd) substitution result IS glob-eligible", () => {
		const out = expand(python, "echo $(cmd)", {}, tmpDir, ["*.txt", 0]);
		expect(out.result).toEqual(["a.txt", "b.txt"]);
	});
});
