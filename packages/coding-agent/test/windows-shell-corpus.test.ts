import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { routeShellContract } from "../src/core/tools/shell-contract-router.ts";
import { discoverGnuToolsDir, isGnuToolsDir } from "../src/utils/shell.ts";

/**
 * The Windows shell regression wall (docs/doctrine.md, 2026-09-08).
 *
 * `test/fixtures/windows-shell-corpus/commands.json` holds every distinct command SHAPE the
 * bash tool received across the measured Windows sessions, with every path, identifier and
 * literal replaced by a synthetic token and the grammar kept byte-for-byte. Three walls run
 * over it on every host:
 *
 * 1. Router: with the engine on, every shape routes to the engine; with it off, the floor
 *    answers with a route or a named refusal, never a throw.
 * 2. Grammar: every shape's verdict matches the fixture: `expect: "ok"` shapes parse, and the
 *    few shapes the real sessions were refused for (cmd.exe/PowerShell dialect, job control,
 *    an unterminated quote) keep refusing with the same named construct.
 * 3. Execution: every shape whose command names are all owned by the harness (engine
 *    builtins, GNU tools, keywords) runs through the real executor in a sandbox with the
 *    real GNU tools (Git for Windows' usr/bin on Windows, /usr/bin on Linux). Non-zero exit
 *    codes are operation outcomes (the sandbox has no such files); an `unsupported-flag`,
 *    `malformed-syntax`, `command not found` for a harness-owned name, or a Python
 *    traceback is a defect.
 *
 * The refusal budget for supported families is zero. A live Windows shell failure is added
 * here as its failing shape before its fix lands.
 */

const ENGINE_DIR = join(import.meta.dirname, "..", "src", "bundled-resources", "runtimes", "pi-shell-engine");
const FIXTURE_PATH = join(import.meta.dirname, "fixtures", "windows-shell-corpus", "commands.json");

interface CorpusShape {
	id: string;
	family: string;
	count: number;
	/** "ok" when the grammar accepts the shape; otherwise the named refusal the real command got. */
	expect: "ok" | { construct: string; message: string };
	command: string;
}

interface CorpusFixture {
	roots: Record<string, string>;
	shapes: CorpusShape[];
}

function resolvePython(): string | null {
	const fromEnv = process.env.PI_TEST_PYTHON;
	const candidates = fromEnv ? [fromEnv, "python3", "python"] : ["python3", "python"];
	for (const candidate of candidates) {
		const probe = spawnSync(candidate, ["--version"], { encoding: "utf-8" });
		if (probe.status === 0) return candidate;
	}
	return null;
}

function loadFixture(): CorpusFixture {
	return JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as CorpusFixture;
}

// One Python process replays the whole corpus: tokenizer+parser for every shape, then the
// real executor (registry, expander, GNU dispatch) for the harness-owned shapes.
const REPLAY = `
import sys, io, json, os, time, traceback
sys.path.insert(0, ${JSON.stringify(ENGINE_DIR)})
from tokens import tokenize
from parser import parse
import exec as execmod
import proc
from context import ExecContext, STATE_BUILTINS, RUNNER_BUILTINS
from state import ShellState
from commands import REGISTRY
from errors import UnsupportedConstruct, ShellExit
from expand import expand_word, ParamExpansionError
import nodes

payload = json.load(open(sys.argv[1], encoding="utf-8"))
sandbox = payload["sandbox"]
gnu_dir = payload.get("gnuToolsDir")
roots = payload["roots"]
KEYWORDS = {"for", "do", "done", "if", "then", "else", "elif", "fi", "while", "until", "case", "esac", "in", "function", "[[", "]]", "!", "{", "}", "time"}
OWNED = set(REGISTRY) | STATE_BUILTINS | RUNNER_BUILTINS | set(proc.GNU_PREFERRED_TOOLS) | KEYWORDS

def command_names(ast):
    names = set()
    def visit_list(lst):
        for andor in lst.entries:
            for pipeline in andor.pipelines:
                for element in pipeline.elements:
                    visit_element(element)
    def visit_element(element):
        if isinstance(element, nodes.SimpleCommand):
            if element.words:
                word = element.words[0]
                text = "".join(getattr(seg, "text", "\\x00") for seg in word.segments)
                names.add(text)
        elif isinstance(element, (nodes.Subshell, nodes.BraceGroup)):
            visit_list(element.body)
        elif isinstance(element, (nodes.ForCommand, nodes.ArithmeticForCommand, nodes.WhileCommand, nodes.UntilCommand)):
            if hasattr(element, "condition"):
                visit_list(element.condition)
            visit_list(element.body)
        elif isinstance(element, nodes.IfCommand):
            for condition, body in element.branches:
                visit_list(condition); visit_list(body)
            if element.else_body is not None:
                visit_list(element.else_body)
        elif isinstance(element, nodes.CaseCommand):
            for _patterns, body, _terminator in element.clauses:
                visit_list(body)
        elif isinstance(element, nodes.FunctionDefinition):
            visit_element(element.body)
    visit_list(ast)
    return names

def substitute(command):
    for key, root in roots.items():
        command = command.replace(root, sandbox[key])
    return command

results = []
for shape in payload["shapes"]:
    entry = {"id": shape["id"]}
    try:
        ast = parse(tokenize(shape["command"]))
    except UnsupportedConstruct as exc:
        entry["refusal"] = {"construct": exc.construct, "message": exc.message}
        results.append(entry)
        continue
    except Exception:
        entry["crash"] = traceback.format_exc()
        results.append(entry)
        continue
    names = command_names(ast)
    entry["names"] = sorted(names)
    owned = all(name in OWNED for name in names)
    entry["owned"] = owned
    if not owned:
        results.append(entry)
        continue
    work = os.path.join(sandbox["work"], shape["id"])
    os.makedirs(work, exist_ok=True)
    env = {"PATH": os.environ.get("PATH", ""), "PATHEXT": os.environ.get("PATHEXT", ""), "HOME": work, "TEMP": work, "TMP": work}
    if os.environ.get("SYSTEMROOT"):
        env["SYSTEMROOT"] = os.environ["SYSTEMROOT"]
    state = ShellState(cwd=work, env=env, gnu_tools_dir=gnu_dir)
    merged = io.BytesIO()
    ctx = ExecContext(state=state, stdin=io.BytesIO(), stdout=merged, expand_word=expand_word,
                      run_command_substitution=execmod.run_command_substitution, builtins=REGISTRY,
                      deadline=time.monotonic() + 10.0, stderr=merged)
    try:
        exit_code = execmod.execute(parse(tokenize(substitute(shape["command"]))), ctx)
    except ShellExit as exc:
        exit_code = exc.exit_code
    except UnsupportedConstruct as exc:
        entry["refusal"] = {"construct": exc.construct, "message": exc.message}
        exit_code = 2
    except ParamExpansionError as exc:
        exit_code = 1
        merged.write(exc.message.encode("utf-8", "replace"))
    except Exception:
        entry["crash"] = traceback.format_exc()
        exit_code = -1
    entry["exitCode"] = exit_code
    entry["output"] = merged.getvalue().decode("utf-8", "replace")[-2000:]
    results.append(entry)
json.dump(results, open(sys.argv[2], "w", encoding="utf-8"))
`;

interface ReplayEntry {
	id: string;
	refusal?: { construct: string; message: string };
	crash?: string;
	names?: string[];
	owned?: boolean;
	exitCode?: number;
	output?: string;
}

function resolveWallGnuToolsDir(): string | null {
	if (process.platform === "win32") return discoverGnuToolsDir();
	return isGnuToolsDir("/usr/bin") ? "/usr/bin" : null;
}

describe("Windows shell corpus wall", () => {
	const fixture = loadFixture();

	it("holds a sanitized corpus: no absolute private path, hostname, or e-mail survives", () => {
		expect(fixture.shapes.length).toBeGreaterThan(3000);
		const ids = new Set(fixture.shapes.map((shape) => shape.id));
		expect(ids.size).toBe(fixture.shapes.length);
		for (const shape of fixture.shapes) {
			expect(shape.command, shape.id).not.toMatch(
				/[A-Za-z]:[\\/](?!pi-corpus|Program Files[\\/]pi-corpus)[A-Za-z]/u,
			);
			expect(shape.command, shape.id).not.toMatch(/\/mnt\/[a-z]\/(?!pi-corpus)/u);
			expect(shape.command, shape.id).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/iu);
			expect(shape.command, shape.id).not.toMatch(/https?:\/\/(?!example\.invalid)/u);
		}
	});

	it("routes every shape to the engine when it is on, and to a floor route or named refusal when it is off", () => {
		for (const shape of fixture.shapes) {
			const engineOn = routeShellContract(shape.command, "win32", { pythonEngine: true });
			expect(engineOn, shape.id).toEqual({ kind: "python-engine", command: shape.command });
			const engineOff = routeShellContract(shape.command, "win32", { pythonEngine: false });
			expect(["powershell", "unsupported"], shape.id).toContain(engineOff.kind);
			if (engineOff.kind === "unsupported") expect(engineOff.error.length, shape.id).toBeGreaterThan(20);
		}
	});

	const python = resolvePython();
	it.skipIf(!python)("parses every shape and executes every harness-owned shape with the real GNU tools", () => {
		if (!python) return;
		const gnuToolsDir = resolveWallGnuToolsDir();
		// The wall's execution leg needs real GNU tools: Git for Windows on Windows, coreutils on Linux.
		expect(gnuToolsDir, "GNU tools directory (Git for Windows usr/bin or /usr/bin)").not.toBeNull();
		const scratch = mkdtempSync(join(tmpdir(), "pi-corpus-wall-"));
		// Four levels deep so a shape's `cd ..` chains stay inside the sandbox.
		const work = join(scratch, "a", "b", "c", "work");
		mkdirSync(work, { recursive: true });
		const forward = work.replaceAll("\\", "/");
		const sandbox = {
			work,
			windows: forward,
			windowsBackslash: work.replaceAll("/", "\\"),
			gitBash: process.platform === "win32" ? `/${forward[0].toLowerCase()}${forward.slice(2)}` : forward,
			wsl: process.platform === "win32" ? `/mnt/${forward[0].toLowerCase()}${forward.slice(2)}` : forward,
			programFiles: join(forward, "Program Files"),
		};
		const payloadPath = join(scratch, "payload.json");
		const resultsPath = join(scratch, "results.json");
		writeFileSync(
			payloadPath,
			JSON.stringify({ shapes: fixture.shapes, roots: fixture.roots, sandbox, gnuToolsDir }),
		);
		try {
			const run = spawnSync(python, ["-B", "-c", REPLAY, payloadPath, resultsPath], {
				encoding: "utf-8",
				maxBuffer: 256 * 1024 * 1024,
				timeout: 15 * 60_000,
			});
			expect(run.status, `replay crashed: ${run.stderr}`).toBe(0);
			const results = JSON.parse(readFileSync(resultsPath, "utf-8")) as ReplayEntry[];
			const byId = new Map(fixture.shapes.map((shape) => [shape.id, shape]));
			const defects: string[] = [];
			let owned = 0;
			let refusedByDesign = 0;
			for (const entry of results) {
				const shape = byId.get(entry.id);
				if (!shape) throw new Error(`replay reported an unknown shape ${entry.id}`);
				if (entry.crash) {
					defects.push(`${entry.id} crashed:\n${entry.crash}\n  ${shape.command}`);
					continue;
				}
				if (shape.expect !== "ok") {
					refusedByDesign += 1;
					if (entry.refusal?.construct !== shape.expect.construct) {
						const got = entry.refusal
							? `[${entry.refusal.construct}] ${entry.refusal.message}`
							: "an accepted parse";
						defects.push(
							`${entry.id} expected the named refusal [${shape.expect.construct}] but got ${got}\n  ${shape.command}`,
						);
					}
					continue;
				}
				if (entry.refusal) {
					defects.push(
						`${entry.id} refused [${entry.refusal.construct}] ${entry.refusal.message}\n  ${shape.command}`,
					);
					continue;
				}
				if (!entry.owned) continue;
				owned += 1;
				const output = entry.output ?? "";
				const notFound = /^([^\s:]+): command not found$/mu.exec(output);
				if (notFound) defects.push(`${entry.id} lost a harness-owned command: ${notFound[0]}\n  ${shape.command}`);
				if (/Traceback \(most recent call last\)/u.test(output)) defects.push(`${entry.id} traceback:\n${output}`);
			}
			expect(owned).toBeGreaterThan(300);
			// The refusal budget for supported families is zero; only dialect mistakes are refused.
			expect(refusedByDesign).toBeLessThanOrEqual(20);
			expect(defects, `${defects.length} defect(s) in the corpus wall`).toEqual([]);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});
