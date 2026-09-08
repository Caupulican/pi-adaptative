import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ENGINE_DIR = join(import.meta.dirname, "..", "..", "src", "bundled-resources", "runtimes", "pi-shell-engine");

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

		it("for loop: explicit values and a command-list body", () => {
			const ast = parseToDict(python, "for item in one 'two words'; do echo \"$item\"; done") as any;
			const element = ast.entries[0].pipelines[0].elements[0];
			expect(element._).toBe("ForCommand");
			expect(element.name).toBe("item");
			expect(element.items).toHaveLength(2);
			expect(element.body.entries).toHaveLength(1);
		});

		it("for loop: omitted in-list uses the positional-parameter form", () => {
			const ast = parseToDict(python, 'for item; do echo "$item"; done') as any;
			const element = ast.entries[0].pipelines[0].elements[0];
			expect(element._).toBe("ForCommand");
			expect(element.name).toBe("item");
			expect(element.items).toEqual([]);
		});

		it("for loop: arithmetic header remains structured", () => {
			const ast = parseToDict(python, 'for ((i=0; i<3; i++)); do echo "$i"; done') as any;
			const element = ast.entries[0].pipelines[0].elements[0];
			expect(element._).toBe("ArithmeticForCommand");
			expect(element.initializer).toBe("i=0");
			expect(element.condition).toBe("i<3");
			expect(element.update).toBe("i++");
			expect(element.body.entries).toHaveLength(1);
		});

		it("arithmetic expansion: $((...)) is a word segment carrying the raw expression", () => {
			const ast = parseToDict(python, 'echo $((x + 1)) "n=$(( (a+b)*2 ))" $(( $' + "{#s} ))") as any;
			const words = ast.entries[0].pipelines[0].elements[0].words;
			expect(words[1].segments).toEqual([{ _: "Arith", src: "x + 1" }]);
			expect(words[2].segments[0]._).toBe("DQ");
			expect(words[2].segments[0].segments).toEqual([
				{ _: "Lit", text: "n=" },
				{ _: "Arith", src: " (a+b)*2 " },
			]);
			expect(words[3].segments).toEqual([{ _: "Arith", src: " $" + "{#s} " }]);
		});

		it("arithmetic command: ((expr)) is a pipeline element with redirects; let is an ordinary command word", () => {
			const ast = parseToDict(python, "((i++)) > out.txt && let i+=1") as any;
			const [first, second] = ast.entries[0].pipelines;
			const element = first.elements[0];
			expect(element._).toBe("ArithmeticCommand");
			expect(element.expression).toBe("i++");
			expect(element.redirects).toHaveLength(1);
			expect(second.elements[0]._).toBe("SimpleCommand");
			expect(second.elements[0].words[0].segments).toEqual([{ _: "Raw", text: "let" }]);
		});

		it("if command: single branch, no else", () => {
			const ast = parseToDict(python, "if true; then echo yes; fi") as any;
			const element = ast.entries[0].pipelines[0].elements[0];
			expect(element._).toBe("IfCommand");
			expect(element.branches).toHaveLength(1);
			expect(element.branches[0][0].entries).toHaveLength(1);
			expect(element.branches[0][1].entries).toHaveLength(1);
			expect(element.else_body).toBeNull();
		});

		it("if command: elif chain and else, multi-line form", () => {
			const command = ["if false", "then echo a", "elif true", "then echo b", "else echo c", "fi"].join("\n");
			const ast = parseToDict(python, command) as any;
			const element = ast.entries[0].pipelines[0].elements[0];
			expect(element._).toBe("IfCommand");
			expect(element.branches).toHaveLength(2);
			expect(element.else_body.entries).toHaveLength(1);
		});

		it("if command: condition is a command list nested inside a for loop", () => {
			const command = 'for d in a b; do if [ "$d" = "a" ]; then echo "$d"; fi; done';
			const ast = parseToDict(python, command) as any;
			const forNode = ast.entries[0].pipelines[0].elements[0];
			expect(forNode._).toBe("ForCommand");
			const ifNode = forNode.body.entries[0].pipelines[0].elements[0];
			expect(ifNode._).toBe("IfCommand");
		});

		it("while loop: condition and body as command lists", () => {
			const ast = parseToDict(python, "while true; do echo x; break; done") as any;
			const element = ast.entries[0].pipelines[0].elements[0];
			expect(element._).toBe("WhileCommand");
			expect(element.condition.entries).toHaveLength(1);
			expect(element.body.entries).toHaveLength(2);
		});

		it("until loop: condition and body as command lists", () => {
			const ast = parseToDict(python, "until false; do echo x; done") as any;
			const element = ast.entries[0].pipelines[0].elements[0];
			expect(element._).toBe("UntilCommand");
			expect(element.condition.entries).toHaveLength(1);
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

	describe("functions, case, [[ ]], and brace expansion parse to structured nodes", () => {
		it("name() { … } and function name { … } become FunctionDefinition with a BraceGroup body", () => {
			const short = parseToDict(python, "greet() { echo hi; }") as {
				entries: Array<{ pipelines: Array<{ elements: unknown[] }> }>;
			};
			const definition = short.entries[0].pipelines[0].elements[0] as {
				_: string;
				name: string;
				body: { _: string };
			};
			expect(definition._).toBe("FunctionDefinition");
			expect(definition.name).toBe("greet");
			expect(definition.body._).toBe("BraceGroup");
			const keyword = parseToDict(python, "function greet {\n  echo hi\n}\ngreet") as {
				entries: Array<{ pipelines: Array<{ elements: unknown[] }> }>;
			};
			expect(keyword.entries).toHaveLength(2);
			expect((keyword.entries[0].pipelines[0].elements[0] as { _: string })._).toBe("FunctionDefinition");
		});

		it("case … in pattern|pattern) … ;; esac keeps every clause with its terminator", () => {
			const parsed = parseToDict(python, "case $x in\n a|b) echo ab ;;\n c) echo c ;&\n *) echo other\nesac") as {
				entries: Array<{ pipelines: Array<{ elements: unknown[] }> }>;
			};
			const command = parsed.entries[0].pipelines[0].elements[0] as {
				_: string;
				clauses: Array<[unknown[], unknown, string]>;
			};
			expect(command._).toBe("CaseCommand");
			expect(command.clauses).toHaveLength(3);
			expect(command.clauses[0][0]).toHaveLength(2);
			expect(command.clauses.map((clause) => clause[2])).toEqual([";;", ";&", ";;"]);
		});

		it("[[ … ]] collects operands and structural operators in source order", () => {
			const parsed = parseToDict(python, "[[ -f x && ( $y == a* || ! -z $z ) ]] && echo yes") as {
				entries: Array<{ pipelines: Array<{ elements: unknown[] }> }>;
			};
			const conditional = parsed.entries[0].pipelines[0].elements[0] as { _: string; items: unknown[] };
			expect(conditional._).toBe("ConditionalCommand");
			expect(conditional.items.filter((item) => typeof item === "string")).toEqual(["&&", "(", "||", ")"]);
			expect(parsed.entries[0].pipelines).toHaveLength(2);
		});

		it("brace expansion produces one word per alternative before any other expansion", () => {
			const parsed = parseToDict(python, "echo {a,b}{1..2} '{x,y}'") as {
				entries: Array<{ pipelines: Array<{ elements: unknown[] }> }>;
			};
			const simple = parsed.entries[0].pipelines[0].elements[0] as { words: unknown[] };
			expect(simple.words).toHaveLength(6);
		});
	});

	describe("structured refusals (§2.3)", () => {
		it.each([
			["job-control", "foo &"],
			["process-substitution", "foo <(bar)"],
			["exec-builtin", "exec foo"],
			["control-flow", "select x in a b; do echo $x; done"],
			["control-flow", "coproc cat"],
			["extended-glob", "foo @(a|b)"],
			["unsupported-builtin", "eval foo"],
			["array", "arr=(a b c)"],
			["array", "declare -a arr"],
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
			["parameter-expansion", "echo $" + "{!VAR}"],
			["array", "echo $" + "{VAR[0]}"],
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
			["malformed-syntax", "for 1item in one; do echo one; done"],
			["malformed-syntax", "for item one; do echo one; done"],
			["malformed-syntax", "for ((i=0; i<3)); do echo one; done"],
			["malformed-syntax", "for item in one; echo one; done"],
			["malformed-syntax", "for item in one; do echo one"],
			["malformed-syntax", "for item in one; do done"],
			["malformed-syntax", "for item in one; do; done"],
			["malformed-syntax", "if true; echo hi; fi"],
			["malformed-syntax", "if ; then echo hi; fi"],
			["malformed-syntax", "if true; then fi"],
			["malformed-syntax", "if true; then echo hi"],
			["malformed-syntax", "while true; echo x; done"],
			["malformed-syntax", "while true; do done"],
			["malformed-syntax", "while true; do echo x"],
			["malformed-syntax", "until false; do done"],
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
		it("scans a long drive path without rebuilding the accumulated prefix per backslash", () => {
			const program = `
import sys
sys.path.insert(0, ${JSON.stringify(ENGINE_DIR)})
from tokens import tokenize
tokens = tokenize(sys.stdin.read())
print(tokens[0].segments[0].text)
`;
			const command = `C:${"\\segment".repeat(20_000)}`;
			const result = spawnSync(python, ["-B", "-c", program], {
				encoding: "utf-8",
				input: command,
				timeout: 3_000,
			});
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(0);
			expect(result.stdout?.trim()).toBe(command);
		});

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
