import { spawnSync } from "node:child_process";
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

const TO_DICT_HELPER = `
import dataclasses, json
def to_dict(x):
	if dataclasses.is_dataclass(x):
		d = {"_": type(x).__name__}
		for f in dataclasses.fields(x): d[f.name] = to_dict(getattr(x, f.name))
		return d
	if isinstance(x, (list, tuple)): return [to_dict(i) for i in x]
	return x
`.replace(/\t/g, "    ");

function runProgram(python: string, program: string): { stdout: string; stderr: string; status: number | null } {
	const result = spawnSync(python, ["-B", "-c", program], { encoding: "utf-8" });
	return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

function parseToDict(python: string, command: string): unknown {
	const program = `
import sys, json
sys.path.insert(0, ${JSON.stringify(ENGINE_DIR)})
from tokens import tokenize
from parser import parse
${TO_DICT_HELPER}
tokens = tokenize(${JSON.stringify(command)})
ast = parse(tokens)
print(json.dumps(to_dict(ast)))
`;
	const { stdout, stderr, status } = runProgram(python, program);
	if (status !== 0) throw new Error(`engine parse failed for ${JSON.stringify(command)}: ${stderr}`);
	return JSON.parse(stdout);
}

function parseRefusal(python: string, command: string): { code: string; construct: string; message: string } {
	const program = `
import sys, json
sys.path.insert(0, ${JSON.stringify(ENGINE_DIR)})
from tokens import tokenize
from parser import parse
from errors import UnsupportedConstruct
try:
	tokens = tokenize(${JSON.stringify(command)})
	ast = parse(tokens)
	print(json.dumps({"refused": False}))
except UnsupportedConstruct as e:
	print(json.dumps({"refused": True, "code": e.code, "construct": e.construct, "message": e.message}))
`;
	const { stdout, stderr, status } = runProgram(python, program);
	if (status !== 0) throw new Error(`engine refusal probe crashed for ${JSON.stringify(command)}: ${stderr}`);
	const parsed = JSON.parse(stdout) as { refused: boolean; code?: string; construct?: string; message?: string };
	if (!parsed.refused) throw new Error(`expected a structured refusal for ${JSON.stringify(command)} but it parsed`);
	return { code: parsed.code as string, construct: parsed.construct as string, message: parsed.message as string };
}

describe("pi-shell-engine tokenizer + parser", () => {
	const python = resolvePython();
	if (!python) {
		it.skip("no Python interpreter available", () => {});
		return;
	}

	describe("grammar constructs (§2.1)", () => {
		it("simple command", () => {
			const ast = parseToDict(python, "echo hi") as { entries: unknown[] };
			expect(ast.entries).toHaveLength(1);
			const simple = (ast as any).entries[0].pipelines[0].elements[0];
			expect(simple._).toBe("SimpleCommand");
			expect(simple.words).toHaveLength(2);
			expect(simple.words[0].segments[0]).toEqual({ _: "Raw", text: "echo" });
		});

		it("pipeline: a | b | c", () => {
			const ast = parseToDict(python, "a | b | c") as any;
			const pipeline = ast.entries[0].pipelines[0];
			expect(pipeline._).toBe("Pipeline");
			expect(pipeline.elements).toHaveLength(3);
			expect(pipeline.negated).toBe(false);
		});

		it("list — sequence: a ; b", () => {
			const ast = parseToDict(python, "a ; b") as any;
			expect(ast.entries).toHaveLength(2);
			expect(ast.separators).toEqual([";"]);
		});

		it("list — sequence: newline-separated", () => {
			const ast = parseToDict(python, "a\nb") as any;
			expect(ast.entries).toHaveLength(2);
			expect(ast.separators).toEqual(["\n"]);
		});

		it("list — and/or: a && b, a || b", () => {
			const andAst = parseToDict(python, "a && b") as any;
			expect(andAst.entries[0].operators).toEqual(["&&"]);
			const orAst = parseToDict(python, "a || b") as any;
			expect(orAst.entries[0].operators).toEqual(["||"]);
		});

		it("negation: ! pipeline", () => {
			const ast = parseToDict(python, "! true") as any;
			expect(ast.entries[0].pipelines[0].negated).toBe(true);
		});

		it("subshell: ( … )", () => {
			const ast = parseToDict(python, "( echo a )") as any;
			const element = ast.entries[0].pipelines[0].elements[0];
			expect(element._).toBe("Subshell");
			expect(element.body.entries).toHaveLength(1);
		});

		it("brace group: { …; }", () => {
			const ast = parseToDict(python, "{ echo a; }") as any;
			const element = ast.entries[0].pipelines[0].elements[0];
			expect(element._).toBe("BraceGroup");
			expect(element.body.entries).toHaveLength(1);
		});

		it.each([
			[">", "echo a > out.txt"],
			[">>", "echo a >> out.txt"],
			["1>", "echo a 1> out.txt"],
			["1>>", "echo a 1>> out.txt"],
		])("redirect out: %s", (op, command) => {
			const ast = parseToDict(python, command) as any;
			const redirect = ast.entries[0].pipelines[0].elements[0].redirects[0];
			expect(redirect._).toBe("Redirect");
			expect(redirect.op).toBe(op);
		});

		it("redirect in: <", () => {
			const ast = parseToDict(python, "cat < in.txt") as any;
			const redirect = ast.entries[0].pipelines[0].elements[0].redirects[0];
			expect(redirect.op).toBe("<");
		});

		it.each([
			["2>", "app 2> err.txt"],
			["2>>", "app 2>> err.txt"],
		])("redirect err: %s", (op, command) => {
			const ast = parseToDict(python, command) as any;
			const redirect = ast.entries[0].pipelines[0].elements[0].redirects[0];
			expect(redirect.op).toBe(op);
			expect(redirect.fd).toBe(2);
		});

		it.each([
			["2>&1", "app 2>&1"],
			["&>", "app &> both.txt"],
			[">&", "app >& both.txt"],
		])("redirect dup: %s", (op, command) => {
			const ast = parseToDict(python, command) as any;
			const redirect = ast.entries[0].pipelines[0].elements[0].redirects[0];
			expect(redirect.op).toBe(op);
		});

		it("quote single: '…'", () => {
			const ast = parseToDict(python, "echo 'lit $x'") as any;
			const word = ast.entries[0].pipelines[0].elements[0].words[1];
			expect(word.segments).toEqual([{ _: "Lit", text: "lit $x" }]);
		});

		it('quote double: "…"', () => {
			const ast = parseToDict(python, 'echo "dq $x"') as any;
			const word = ast.entries[0].pipelines[0].elements[0].words[1];
			expect(word.segments[0]._).toBe("DQ");
			const inner = word.segments[0].segments;
			expect(inner).toEqual([
				{ _: "Lit", text: "dq " },
				{ _: "Param", name: "x", op: null, arg: null },
			]);
		});

		it("quote backslash: \\x", () => {
			const ast = parseToDict(python, "echo \\$x") as any;
			const word = ast.entries[0].pipelines[0].elements[0].words[1];
			expect(word.segments[0]).toEqual({ _: "Lit", text: "$" });
		});

		it("ANSI-C quote: $'…'", () => {
			const ast = parseToDict(python, "echo $'a\\nb'") as any;
			const word = ast.entries[0].pipelines[0].elements[0].words[1];
			expect(word.segments).toEqual([{ _: "Lit", text: "a\nb" }]);
		});

		it("tilde: ~ and ~/x", () => {
			const bare = parseToDict(python, "echo ~") as any;
			expect(bare.entries[0].pipelines[0].elements[0].words[1].segments[0]).toEqual({ _: "Tilde", user: "" });
			const withPath = parseToDict(python, "echo ~/x") as any;
			const segments = withPath.entries[0].pipelines[0].elements[0].words[1].segments;
			expect(segments[0]).toEqual({ _: "Tilde", user: "" });
			expect(segments[1]).toEqual({ _: "Raw", text: "/x" });
		});

		it("param: $VAR and $" + "{VAR}", () => {
			const bare = parseToDict(python, "echo $VAR") as any;
			expect(bare.entries[0].pipelines[0].elements[0].words[1].segments[0]).toEqual({
				_: "Param",
				name: "VAR",
				op: null,
				arg: null,
			});
			const braced = parseToDict(python, "echo $" + "{VAR}") as any;
			expect(braced.entries[0].pipelines[0].elements[0].words[1].segments[0]).toEqual({
				_: "Param",
				name: "VAR",
				op: null,
				arg: null,
			});
		});

		it.each([
			[":-", "echo $" + "{V:-w}"],
			[":=", "echo $" + "{V:=w}"],
			[":+", "echo $" + "{V:+w}"],
			[":?", "echo $" + "{V:?w}"],
		])("param default/assign/alt/err: %s", (op, command) => {
			const ast = parseToDict(python, command) as any;
			const param = ast.entries[0].pipelines[0].elements[0].words[1].segments[0];
			expect(param._).toBe("Param");
			expect(param.name).toBe("V");
			expect(param.op).toBe(op);
			expect(param.arg.segments).toEqual([{ _: "Raw", text: "w" }]);
		});

		it("param length: $" + "{#VAR}", () => {
			const ast = parseToDict(python, "echo $" + "{#VAR}") as any;
			const param = ast.entries[0].pipelines[0].elements[0].words[1].segments[0];
			expect(param).toEqual({ _: "Param", name: "VAR", op: "#len", arg: null });
		});

		it.each([
			["$(cmd)", "echo $(cmd)", "cmd"],
			["`cmd`", "echo `cmd`", "cmd"],
		])("command sub: %s", (_label, command, expectedSrc) => {
			const ast = parseToDict(python, command) as any;
			const seg = ast.entries[0].pipelines[0].elements[0].words[1].segments[0];
			expect(seg).toEqual({ _: "CmdSub", src: expectedSrc });
		});

		it("glob: * ? […]", () => {
			const ast = parseToDict(python, "echo *.txt") as any;
			const word = ast.entries[0].pipelines[0].elements[0].words[1];
			expect(word.segments).toEqual([{ _: "Raw", text: "*.txt" }]);
		});

		it("word splitting: unquoted expansion stays a single Raw segment (splitting happens at expand time)", () => {
			const ast = parseToDict(python, "echo a b") as any;
			const words = ast.entries[0].pipelines[0].elements[0].words;
			expect(words).toHaveLength(3);
		});

		it("assignment (shell): NAME=value standalone", () => {
			const ast = parseToDict(python, "NAME=value") as any;
			const simple = ast.entries[0].pipelines[0].elements[0];
			expect(simple.assignments).toEqual([["NAME", { _: "Word", segments: [{ _: "Raw", text: "value" }] }]]);
			expect(simple.words).toEqual([]);
		});

		it("assignment (transient): NAME=value app", () => {
			const ast = parseToDict(python, "NAME=value app") as any;
			const simple = ast.entries[0].pipelines[0].elements[0];
			expect(simple.assignments).toEqual([["NAME", { _: "Word", segments: [{ _: "Raw", text: "value" }] }]]);
			expect(simple.words).toHaveLength(1);
			expect(simple.words[0].segments[0]).toEqual({ _: "Raw", text: "app" });
		});
	});

	describe("structured refusals (§2.3)", () => {
		it.each([
			["job-control", "foo &"],
			["process-substitution", "foo <(bar)"],
			["arithmetic-expansion", "echo $((1+1))"],
			["brace-expansion", "foo {a,b,c}"],
			["nested-shell", "bash -c foo"],
			["exec-builtin", "exec foo"],
			["heredoc", "foo <<EOF"],
			["here-string", "foo <<< bar"],
			["function-definition", "name() { echo hi; }"],
			["control-flow", "if true; then echo hi; fi"],
			["extended-glob", "foo @(a|b)"],
			["unsupported-builtin", "eval foo"],
			["posix-script", "foo.sh"],
		])("construct id: %s", (construct, command) => {
			const refusal = parseRefusal(python, command);
			expect(refusal.code).toBe("unsupported");
			expect(refusal.construct).toBe(construct);
			expect(refusal.message.length).toBeGreaterThan(0);
		});

		it("cwd-missing is a §1.2 request-level refusal, not a tokenizer/parser one — asserted structurally only", () => {
			// cwd-missing is raised by main.py (WP-C) against the request's `cwd` field, not by
			// tokens.py/parser.py; WP-A only guarantees the id exists in the frozen catalog.
			const program = `
import sys
sys.path.insert(0, ${JSON.stringify(ENGINE_DIR)})
from errors import UNSUPPORTED_CONSTRUCTS
print("cwd-missing" in UNSUPPORTED_CONSTRUCTS)
`;
			const { stdout, status } = runProgram(python, program);
			expect(status).toBe(0);
			expect(stdout.trim()).toBe("True");
		});

		it("tilde-user is a §1.5/WP-B expander-time refusal, not a tokenizer/parser one — asserted structurally only", () => {
			const program = `
import sys
sys.path.insert(0, ${JSON.stringify(ENGINE_DIR)})
from errors import UNSUPPORTED_CONSTRUCTS
print("tilde-user" in UNSUPPORTED_CONSTRUCTS)
`;
			const { stdout, status } = runProgram(python, program);
			expect(status).toBe(0);
			expect(stdout.trim()).toBe("True");
		});

		it.each([
			["parameter-expansion", "echo $" + "{VAR:2:3}"],
			["parameter-expansion", "echo $" + "{V%x}"],
		])("construct id: %s (out-of-matrix param-expansion form, architect amendment §1.6)", (construct, command) => {
			const refusal = parseRefusal(python, command);
			expect(refusal.code).toBe("unsupported");
			expect(refusal.construct).toBe(construct);
			expect(refusal.message.length).toBeGreaterThan(0);
		});

		it.each([
			["malformed-syntax", ")"],
			["malformed-syntax", "a && "],
			["malformed-syntax", "| foo"],
			["malformed-syntax", "echo 'unterminated"],
		])("construct id: %s (architect amendment §1.6)", (construct, command) => {
			const refusal = parseRefusal(python, command);
			expect(refusal.code).toBe("unsupported");
			expect(refusal.construct).toBe(construct);
			expect(refusal.message.length).toBeGreaterThan(0);
		});
	});

	describe("parser bugfixes (architect review)", () => {
		it("param default arg keeps the FULL content, not just the first space-delimited token", () => {
			const ast = parseToDict(python, "echo $" + "{V:-a b}") as any;
			const param = ast.entries[0].pipelines[0].elements[0].words[1].segments[0];
			expect(param._).toBe("Param");
			expect(param.op).toBe(":-");
			expect(param.arg.segments).toEqual([{ _: "Raw", text: "a b" }]);
		});

		it("assignment-only command still parses (no refusal)", () => {
			const ast = parseToDict(python, "FOO=1") as any;
			const simple = ast.entries[0].pipelines[0].elements[0];
			expect(simple._).toBe("SimpleCommand");
			expect(simple.words).toEqual([]);
			expect(simple.assignments).toHaveLength(1);
		});

		it("redirect-only command still parses (no refusal)", () => {
			const ast = parseToDict(python, "> out.txt") as any;
			const simple = ast.entries[0].pipelines[0].elements[0];
			expect(simple._).toBe("SimpleCommand");
			expect(simple.words).toEqual([]);
			expect(simple.redirects).toHaveLength(1);
		});
	});

	describe("Windows absolute-path backslashes (CI lane fix)", () => {
		it("drive-letter path in a command word keeps its backslashes literal", () => {
			const ast = parseToDict(python, "cat C:\\Users\\me\\file.txt") as any;
			const word = ast.entries[0].pipelines[0].elements[0].words[1];
			expect(word.segments).toEqual([{ _: "Raw", text: "C:\\Users\\me\\file.txt" }]);
		});

		it("drive-letter path as a redirect target keeps its backslashes literal", () => {
			const ast = parseToDict(python, "cat > C:\\tmp\\out.txt") as any;
			const redirect = ast.entries[0].pipelines[0].elements[0].redirects[0];
			expect(redirect.op).toBe(">");
			expect(redirect.target.segments).toEqual([{ _: "Raw", text: "C:\\tmp\\out.txt" }]);
		});

		it("UNC path round-trips its backslashes intact", () => {
			const ast = parseToDict(python, "cat \\\\server\\share\\f.txt") as any;
			const word = ast.entries[0].pipelines[0].elements[0].words[1];
			expect(word.segments).toEqual([{ _: "Raw", text: "\\\\server\\share\\f.txt" }]);
		});

		it("plain backslash escape still escapes a space: a\\ b stays one word", () => {
			const ast = parseToDict(python, "echo a\\ b") as any;
			const simple = ast.entries[0].pipelines[0].elements[0];
			expect(simple.words).toHaveLength(2);
			const word = simple.words[1];
			const joined = word.segments.map((s: any) => s.text).join("");
			expect(joined).toBe("a b");
		});

		it("plain backslash escape still escapes $: \\$HOME stays a literal, not a Param", () => {
			const ast = parseToDict(python, "echo \\$HOME") as any;
			const word = ast.entries[0].pipelines[0].elements[0].words[1];
			expect(word.segments.some((s: any) => s._ === "Param")).toBe(false);
			const joined = word.segments.map((s: any) => s.text).join("");
			expect(joined).toBe("$HOME");
		});

		it("drive-letter path with a glob keeps the prefix and the glob char in a Raw segment", () => {
			const ast = parseToDict(python, "cat C:\\tmp\\*.txt") as any;
			const word = ast.entries[0].pipelines[0].elements[0].words[1];
			expect(word.segments).toEqual([{ _: "Raw", text: "C:\\tmp\\*.txt" }]);
		});
	});
});
