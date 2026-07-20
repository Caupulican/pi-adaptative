import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ENGINE_DIR = join(__dirname, "..", "..", "src", "bundled-resources", "runtimes", "pi-shell-engine");
const MAIN_PY = join(ENGINE_DIR, "main.py");
const RECORD_SEPARATOR = "\x1e";

function resolvePython(): string | null {
	const fromEnv = process.env.PI_TEST_PYTHON;
	const candidates = fromEnv ? [fromEnv, "python3", "python"] : ["python3", "python"];
	for (const candidate of candidates) {
		const probe = spawnSync(candidate, ["--version"], { encoding: "utf-8" });
		if (probe.status === 0) return candidate;
	}
	return null;
}

function bashAvailable(): boolean {
	const probe = spawnSync("bash", ["--version"], { encoding: "utf-8" });
	return probe.status === 0;
}

/** Seed a small, known file tree shared by both the engine and the reference bash. */
function seedFileTree(dir: string): void {
	writeFileSync(join(dir, "a.txt"), "alpha\nbeta\ngamma\n");
	writeFileSync(join(dir, "b.txt"), "one two three\nfour five six\n");
	writeFileSync(join(dir, "c.log"), "line1\nline2\nline3\nline4\n");
	writeFileSync(join(dir, "nums.txt"), "3\n1\n10\n2\n");
	writeFileSync(join(dir, "dup.txt"), "x\nx\ny\ny\ny\nz\n");
	writeFileSync(join(dir, "csv.txt"), "a,b,c\nd,e,f\n");
	mkdirSync(join(dir, "sub"));
	writeFileSync(join(dir, "sub", "nested.txt"), "nested\n");
}

/** §WP-F: exactly PATH/HOME/LC_ALL/LANG; GREP_OPTIONS/GREP_COLORS unset. */
function scrubbedEnv(home: string): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "",
		HOME: home,
		LC_ALL: "C",
		LANG: "C",
	};
}

interface Outcome {
	output: string;
	exitCode: number;
}

function runBashReference(command: string, cwd: string, env: Record<string, string>): Outcome {
	const result = spawnSync("bash", ["--noprofile", "--norc", "-c", command], {
		cwd,
		env: { ...env, GREP_OPTIONS: undefined, GREP_COLORS: undefined } as unknown as NodeJS.ProcessEnv,
		encoding: "buffer",
	});
	return { output: (result.stdout ?? Buffer.alloc(0)).toString("utf-8"), exitCode: result.status ?? -1 };
}

function runEngine(python: string, command: string, cwd: string, env: Record<string, string>): Outcome {
	const request = JSON.stringify({ command, cwd, env });
	const result = spawnSync(python, ["-B", MAIN_PY], {
		encoding: "utf-8",
		input: request,
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.status !== 0) {
		throw new Error(`engine crashed for ${JSON.stringify(command)}: status=${result.status} stderr=${result.stderr}`);
	}
	const raw = result.stdout;
	const first = raw.indexOf(RECORD_SEPARATOR);
	const second = raw.indexOf(RECORD_SEPARATOR, first + 1);
	if (first === -1 || second === -1) {
		throw new Error(`no parseable control frame for ${JSON.stringify(command)}: ${JSON.stringify(raw)}`);
	}
	const frame = JSON.parse(raw.slice(first + 1, second)) as { exitCode: number };
	return { output: raw.slice(0, first), exitCode: frame.exitCode };
}

// Plain data array, one row per §2.1/§2.2 D-marked matrix row, kept greppable. `label` documents
// which matrix row/oracle-integrity rule the case exercises.
const DIFFERENTIAL_CORPUS: Array<{ label: string; command: string }> = [
	{ label: "grammar: pipeline a|b|c", command: "cat a.txt | grep a | wc -l" },
	{ label: "grammar: list sequence ;", command: "echo one; echo two" },
	{ label: "grammar: newline sequence", command: "echo one\necho two" },
	{ label: "grammar: and/or &&", command: "true && echo yes" },
	{ label: "grammar: and/or ||", command: "false || echo yes" },
	{ label: "grammar: negation !", command: "! false" },
	{ label: "grammar: subshell isolation", command: "(cd sub; pwd); pwd" },
	{ label: "grammar: brace group persistence", command: "{ cd sub; pwd; }" },
	{ label: "grammar: redirect out >", command: "echo hi > out1.txt; cat out1.txt" },
	{ label: "grammar: redirect append >>", command: "echo one > out2.txt; echo two >> out2.txt; cat out2.txt" },
	{ label: "grammar: redirect out 1>", command: "echo hi 1> out3.txt; cat out3.txt" },
	{ label: "grammar: redirect in <", command: "cat < a.txt" },
	// §2.4.6: builtin stderr is merged by design — 2>/pipeline-stderr differential cases use
	// EXTERNAL commands only (the un-registered /usr/bin/grep path, not the `grep` builtin).
	{
		label: "grammar: redirect err 2> (external)",
		command: "/usr/bin/grep -F nomatch missing-file.txt 2> err1.txt; cat err1.txt; true",
	},
	{
		label: "grammar: redirect dup 2>&1 (external)",
		command: "/usr/bin/grep -F nomatch missing-file.txt > both.txt 2>&1; cat both.txt; true",
	},
	{ label: "grammar: quote single literal", command: "echo 'lit $HOME *.txt'" },
	{ label: "grammar: quote double expansion", command: 'X=hi; echo "val: $X"' },
	{ label: "grammar: quote backslash", command: "echo \\$HOME" },
	{ label: "grammar: ANSI-C quote", command: "echo $'a\\nb\\tc'" },
	{ label: "grammar: tilde bare", command: "echo ~" },
	{ label: "grammar: tilde with path", command: "echo ~/x" },
	{ label: "grammar: param $VAR set", command: "X=hi; echo $X" },
	{ label: "grammar: param ${VAR} unset -> empty", command: 'echo "[${UNSET_VAR}]"' },
	{ label: "grammar: param default :-", command: 'echo "${UNSET_VAR:-fallback}"' },
	{ label: "grammar: param assign :=", command: 'echo "${V:=assigned}"; echo "$V"' },
	{ label: "grammar: param alt :+", command: 'V=x; echo "${V:+alt}"' },
	{ label: "grammar: param length #", command: "V=abcde; echo ${#V}" },
	{ label: "grammar: command sub $(...)", command: "echo $(echo inner)" },
	{ label: "grammar: command sub backtick", command: "echo `echo inner`" },
	// §2.4.7: globs stay final-segment only.
	{ label: "grammar: glob final segment *", command: "echo *.txt" },
	{ label: "grammar: glob final segment ?", command: "echo ?.txt" },
	{ label: "grammar: word splitting", command: "X='a b c'; echo $X" },
	{ label: "grammar: transient assignment scope", command: 'NAME=value true; echo "[$NAME]"' },
	{ label: "builtin: echo default join + newline", command: "echo a b c" },
	{ label: "builtin: echo -n", command: "echo -n no-newline" },
	{ label: "builtin: echo -e escapes", command: "echo -e 'a\\nb\\tc'" },
	{ label: "builtin: printf %s %d", command: "printf '%s-%d\\n' foo 3" },
	{ label: "builtin: printf recycles format", command: "printf '%s\\n' one two three" },
	{ label: "builtin: true exit code", command: "true" },
	{ label: "builtin: false exit code", command: "false" },
	{ label: "builtin: test -eq", command: "test 1 -eq 1" },
	{ label: "builtin: test string =", command: "test a = b" },
	{ label: "builtin: cat multi-file byte-exact", command: "cat a.txt b.txt" },
	{ label: "builtin: head -n N", command: "head -n 2 c.log" },
	{ label: "builtin: tail -n N", command: "tail -n 2 c.log" },
	// §2.4.8: wc -m ASCII-only.
	{ label: "builtin: wc -l stdin bare int", command: "cat a.txt | wc -l" },
	{ label: "builtin: wc -w stdin bare int", command: "cat b.txt | wc -w" },
	{ label: "builtin: wc -c stdin bare int", command: "cat a.txt | wc -c" },
	{ label: "builtin: wc -m stdin bare int (ASCII-only)", command: "cat a.txt | wc -m" },
	{ label: "builtin: sort default ordinal", command: "sort nums.txt" },
	{ label: "builtin: sort -n numeric", command: "sort -n nums.txt" },
	{ label: "builtin: sort -r reverse", command: "sort -r nums.txt" },
	{ label: "builtin: sort -u unique", command: "printf 'b\\na\\nb\\n' | sort -u" },
	{ label: "builtin: uniq plain adjacent dedup", command: "uniq dup.txt" },
	{ label: "builtin: uniq -d", command: "uniq -d dup.txt" },
	{ label: "builtin: uniq -u", command: "uniq -u dup.txt" },
	{ label: "builtin: cut -d -f", command: "cut -d , -f 2 csv.txt" },
	{ label: "builtin: cut -c", command: "cut -c 1-3 csv.txt" },
	{ label: "builtin: tr ranges", command: "printf 'abc\\n' | tr a-c A-C" },
	{ label: "builtin: tr -d delete", command: "printf 'abc\\n' | tr -d b" },
	{ label: "builtin: tr -s squeeze", command: "printf 'aabbcc\\n' | tr -s abc" },
	{ label: "builtin: basename", command: "basename /a/b/c.txt" },
	{ label: "builtin: basename with suffix", command: "basename /a/b/c.txt .txt" },
	{ label: "builtin: dirname", command: "dirname /a/b/c.txt" },
	// §WP-F: grep/sed differential cases -F/fixed-pattern only.
	{ label: "builtin: grep -F fixed pattern (stdin)", command: "cat a.txt | grep -F beta" },
	{ label: "builtin: grep -F -i", command: "cat a.txt | grep -F -i BETA" },
	{ label: "builtin: grep -F -v invert", command: "cat a.txt | grep -F -v beta" },
	{ label: "builtin: grep -F -c count", command: "cat a.txt | grep -F -c a" },
	{ label: "builtin: sed s/// fixed-ish literal substitution", command: "cat a.txt | sed 's/beta/BETA/'" },
	{ label: "builtin: sed s///g global", command: "printf 'aXaXa\\n' | sed 's/X/-/g'" },
	{ label: "builtin: xargs simple pipeline", command: "echo one | xargs echo" },
];

describe("pi-shell-engine differential oracle (D-marked corpus vs scrubbed bash)", () => {
	if (process.platform === "win32") {
		it.skip("differential oracle runs on Linux only", () => {});
		return;
	}
	const python = resolvePython();
	if (!python) {
		it.skip("no Python interpreter available", () => {});
		return;
	}
	if (!bashAvailable()) {
		it.skip("no bash reference available", () => {});
		return;
	}

	function withSeededDir<T>(fn: (dir: string) => T): T {
		const dir = mkdtempSync(join(tmpdir(), "pi-differential-"));
		seedFileTree(dir);
		return fn(dir);
	}

	it.each(DIFFERENTIAL_CORPUS.map((row) => [row.label, row.command] as const))("%s: %s", (_label, command) => {
		withSeededDir((dir) => {
			const home = mkdtempSync(join(tmpdir(), "pi-differential-home-"));
			const env = scrubbedEnv(home);
			const bashResult = runBashReference(command, dir, env);
			const engineResult = runEngine(python, command, dir, env);
			expect(engineResult.output).toBe(bashResult.output);
			expect(engineResult.exitCode).toBe(bashResult.exitCode);
		});
	});

	it("test -d/-f/-e (and other path unary operators) resolve against ctx.cwd, not the engine process's OS cwd", () => {
		withSeededDir((dir) => {
			const home = mkdtempSync(join(tmpdir(), "pi-differential-home-"));
			const env = scrubbedEnv(home);
			const bashResult = runBashReference("test -d sub", dir, env);
			const engineResult = runEngine(python, "test -d sub", dir, env);
			expect(engineResult.exitCode).toBe(bashResult.exitCode);
		});
	});

	it("[ -f FILE ] resolves a relative FILE against ctx.cwd, not the engine process's OS cwd", () => {
		withSeededDir((dir) => {
			const home = mkdtempSync(join(tmpdir(), "pi-differential-home-"));
			const env = scrubbedEnv(home);
			const bashResult = runBashReference("[ -f a.txt ]", dir, env);
			const engineResult = runEngine(python, "[ -f a.txt ]", dir, env);
			expect(engineResult.exitCode).toBe(bashResult.exitCode);
		});
	});

	it("test -d/[ -f ] work correctly when the request cwd happens to equal the process cwd (see FINDING above for the relative-path cwd bug)", () => {
		const dir = process.cwd();
		const marker = join(dir, `pi-differential-testop-${process.pid}.txt`);
		writeFileSync(marker, "x");
		try {
			const relative = marker.slice(dir.length + 1);
			const home = mkdtempSync(join(tmpdir(), "pi-differential-home-"));
			const env = scrubbedEnv(home);
			const command = `[ -f ${relative} ]`;
			const bashResult = runBashReference(command, dir, env);
			const engineResult = runEngine(python, command, dir, env);
			expect(engineResult.exitCode).toBe(bashResult.exitCode);
		} finally {
			spawnSync(python, ["-c", `import os; os.remove(${JSON.stringify(marker)})`]);
		}
	});
});
