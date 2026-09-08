import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The corpus tool (`pi-shell-engine/corpus.py`, driven by `scripts/windows-shell-corpus.mjs`)
 * lets the harness evaluate and evolve its bash contract from its own session transcripts, here
 * or from another machine, without ever storing a private command. These cases feed it a
 * synthetic transcript full of private-looking names and prove: every `bash` call is harvested,
 * the shapes keep their grammar and lose every private token, the grammar verdict of the real
 * command travels with the shape, merging keeps ids stable, and a replay reports no defect.
 */

const ENGINE_DIR = join(import.meta.dirname, "..", "src", "bundled-resources", "runtimes", "pi-shell-engine");
const CORPUS = join(ENGINE_DIR, "corpus.py");
const PRIVATE_TOKENS = ["Acme", "Salon", "Payroll", "Ledger", "SecretToken", "hbdevtool", "Contoso", "stylist"];

function resolvePython(): string | null {
	const fromEnv = process.env.PI_TEST_PYTHON;
	const candidates = fromEnv ? [fromEnv, "python3", "python"] : ["python3", "python"];
	for (const candidate of candidates) {
		const probe = spawnSync(candidate, ["--version"], { encoding: "utf-8" });
		if (probe.status === 0) return candidate;
	}
	return null;
}

function transcript(id: string, cwd: string, commands: string[]): string {
	const lines = [JSON.stringify({ type: "session", version: 4, id, timestamp: "2026-09-08T00:00:00.000Z", cwd })];
	commands.forEach((command, index) => {
		lines.push(
			JSON.stringify({
				type: "message",
				id: `m${index}`,
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: `call-${index}`, name: "bash", arguments: JSON.stringify({ command }) },
					],
				},
			}),
		);
		lines.push(
			JSON.stringify({
				type: "message",
				id: `r${index}`,
				message: {
					role: "toolResult",
					toolCallId: `call-${index}`,
					toolName: "bash",
					content: [{ type: "text", text: "…" }],
				},
			}),
		);
	});
	return `${lines.join("\n")}\n`;
}

const WINDOWS_COMMANDS = [
	`cd "D:/Acme Salon 7/Repo" && rg -n "PayrollLedger|SecretToken" "D:/Acme Salon 7/Repo/src/PayrollLedger.cs" -g '*.cs' | head -40`,
	`for f in D:/Acme/logs/*.log; do printf '%s\\n' "$f"; done`,
	`case "$STYLIST_MODE" in stylist) echo stylist;; *) echo other;; esac`,
	`'D:/Acme/tools/hbdevtool.cmd' build -ContosoTarget`,
	`dir /w D:\\Acme\\Repo & find /i "Ledger" D:\\Acme\\Repo\\notes.txt`,
];

interface Fixture {
	roots: Record<string, string>;
	shapes: Array<{ id: string; family: string; count: number; expect: "ok" | { construct: string }; command: string }>;
}

function run(python: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(python, ["-B", CORPUS, ...args], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const python = resolvePython();

describe.skipIf(!python)("Windows shell corpus tool", () => {
	let root: string;
	let sessions: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-corpus-tool-"));
		sessions = join(root, "sessions", "--D%3A%5CAcme--");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(
			join(sessions, "2026-09-08T00-00-00-000Z_s1.jsonl"),
			transcript("s1", "D:\\Acme Salon 7\\Repo", WINDOWS_COMMANDS),
		);
		writeFileSync(
			join(sessions, "2026-09-08T00-00-01-000Z_s2.jsonl"),
			transcript("s2", "/home/stylist/Contoso", ["ls -la /home/stylist/Contoso/src", WINDOWS_COMMANDS[0]]),
		);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("harvests every bash call into sanitized shapes that keep the grammar and lose every private token", () => {
		if (!python) return;
		const out = join(root, "fixture.json");
		const result = run(python, ["harvest", "--sessions", join(root, "sessions"), "--out", out]);
		expect(result.status, result.stderr).toBe(0);
		const report = JSON.parse(result.stdout.trim());
		expect(report.files).toBe(2);
		expect(report.raw).toBe(7);
		const fixture = JSON.parse(readFileSync(out, "utf-8")) as Fixture;
		expect(fixture.roots.windows).toBe("D:/pi-corpus");
		const text = fixture.shapes.map((shape) => shape.command).join("\n");
		for (const token of PRIVATE_TOKENS) expect(text.toLowerCase(), token).not.toContain(token.toLowerCase());
		expect(text).not.toMatch(/[A-Za-z]:[\\/](?!pi-corpus|Program Files[\\/]pi-corpus)/u);
		// The grammar survives: the rg pipeline, the for loop, the case command, the .cmd launcher.
		expect(text).toContain(
			'cd "D:/pi-corpus/p1 sp/p2" && rg -n "w1|w2" "D:/pi-corpus/p1 sp/p2/p3/p4.cs" -g \'*.w3\' | head -40',
		);
		expect(text).toContain("for v1 in D:/pi-corpus/p1/p2/*.log; do printf '%s\\n' \"$v1\"; done");
		expect(text).toContain('case "$v1" in w1) echo w1;; *) echo w2;; esac');
		expect(text).toContain("'D:/pi-corpus/p1/p2/p3.cmd' build -Flag1");
		// The dedupe folds the command both sessions issued; the cmd-dialect command keeps its verdict.
		const first = fixture.shapes.find((shape) => shape.command.includes("| head -40"));
		expect(first?.count).toBe(2);
		const cmdDialect = fixture.shapes.find((shape) => shape.expect !== "ok");
		expect(cmdDialect?.expect).toMatchObject({ construct: "job-control" });
		expect(fixture.shapes.filter((shape) => shape.expect === "ok").length).toBe(fixture.shapes.length - 1);
	});

	it("filters by the transcript's platform and merges into an existing fixture with stable ids", () => {
		if (!python) return;
		const first = join(root, "first.json");
		expect(run(python, ["harvest", "--sessions", sessions, "--platform", "win32", "--out", first]).status).toBe(0);
		const before = JSON.parse(readFileSync(first, "utf-8")) as Fixture;
		expect(before.shapes.length).toBe(WINDOWS_COMMANDS.length);
		expect(before.shapes.map((shape) => shape.id)).toEqual(
			before.shapes.map((_shape, index) => `s${String(index + 1).padStart(4, "0")}`),
		);
		// A posix-only harvest of the same directory sees only the second machine's transcript.
		const posix = join(root, "posix.json");
		expect(run(python, ["harvest", "--sessions", sessions, "--platform", "posix", "--out", posix]).status).toBe(0);
		expect((JSON.parse(readFileSync(posix, "utf-8")) as Fixture).shapes.map((shape) => shape.family)).toEqual([
			"cd",
			"ls",
		]);
		// Merging the second machine's transcripts adds only the unknown shape and bumps the known count.
		const merged = join(root, "merged.json");
		const result = run(python, [
			"harvest",
			"--sessions",
			join(root, "sessions"),
			"--fixture",
			first,
			"--out",
			merged,
		]);
		expect(result.status).toBe(0);
		const report = JSON.parse(result.stdout.trim());
		expect(report.added).toBe(1);
		expect(report.known).toBe(WINDOWS_COMMANDS.length);
		const after = JSON.parse(readFileSync(merged, "utf-8")) as Fixture;
		expect(after.shapes.slice(0, before.shapes.length).map((shape) => shape.id)).toEqual(
			before.shapes.map((shape) => shape.id),
		);
		expect(after.shapes.at(-1)?.id).toBe(`s${String(before.shapes.length + 1).padStart(4, "0")}`);
		expect(after.shapes.find((shape) => shape.command.includes("| head -40"))?.count).toBe(3);
	});

	it("replays a fixture and classifies defects: none for a healthy fixture, one when an expected refusal disappears", () => {
		if (!python) return;
		const fixturePath = join(root, "fixture.json");
		expect(run(python, ["harvest", "--sessions", sessions, "--out", fixturePath]).status).toBe(0);
		const sandbox = join(root, "sandbox", "a", "b", "c");
		mkdirSync(sandbox, { recursive: true });
		const report = join(root, "report.json");
		const gnuArgs = process.platform === "win32" ? [] : ["--gnu-tools-dir", "/usr/bin"];
		const healthy = run(python, [
			"replay",
			"--fixture",
			fixturePath,
			"--sandbox",
			sandbox,
			"--out",
			report,
			...gnuArgs,
		]);
		expect(healthy.status, healthy.stderr).toBe(0);
		const verdict = JSON.parse(readFileSync(report, "utf-8"));
		expect(verdict.defects).toEqual([]);
		expect(verdict.owned).toBeGreaterThanOrEqual(2);
		expect(verdict.refusedByDesign).toBe(1);
		// A shape recorded as refused-by-design that the grammar now accepts is a defect: a named
		// refusal silently became an approximation.
		const fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as Fixture;
		const shape = fixture.shapes.find((candidate) => candidate.expect === "ok");
		if (!shape) throw new Error("expected an accepted shape");
		shape.expect = { construct: "job-control" };
		writeFileSync(fixturePath, JSON.stringify(fixture));
		const broken = run(python, [
			"replay",
			"--fixture",
			fixturePath,
			"--sandbox",
			sandbox,
			"--out",
			report,
			...gnuArgs,
		]);
		expect(broken.status).toBe(1);
		const defects = JSON.parse(readFileSync(report, "utf-8")).defects as Array<{ id: string; kind: string }>;
		expect(defects).toEqual([
			{ id: shape.id, kind: "expected-refusal-changed", detail: expect.any(String), command: shape.command },
		]);
	});
});
