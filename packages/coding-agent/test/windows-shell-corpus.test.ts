import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

const CORPUS_TOOL = join(ENGINE_DIR, "corpus.py");

interface WallReport {
	shapes: number;
	owned: number;
	refusedByDesign: number;
	defects: Array<{ id: string; kind: string; detail: string; command: string }>;
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
	// One Python process replays every shape (about 25 s alone, longer beside a parallel suite run);
	// the vitest timeout matches the replay's own 15-minute spawn bound instead of the 30 s default.
	it.skipIf(!python)(
		"parses every shape and executes every harness-owned shape with the real GNU tools",
		() => {
			if (!python) return;
			const gnuToolsDir = resolveWallGnuToolsDir();
			// The wall's execution leg needs real GNU tools: Git for Windows on Windows, coreutils on Linux.
			expect(gnuToolsDir, "GNU tools directory (Git for Windows usr/bin or /usr/bin)").not.toBeNull();
			if (gnuToolsDir === null) throw new Error("unreachable: asserted above");
			const scratch = mkdtempSync(join(tmpdir(), "pi-corpus-wall-"));
			// Four levels deep so a shape's `cd ..` chains stay inside the sandbox.
			const sandbox = join(scratch, "a", "b", "c");
			mkdirSync(sandbox, { recursive: true });
			const reportPath = join(scratch, "report.json");
			try {
				// The same replay and classification the operator tool runs (scripts/windows-shell-corpus.mjs).
				const run = spawnSync(
					python,
					[
						"-B",
						CORPUS_TOOL,
						"replay",
						"--fixture",
						FIXTURE_PATH,
						"--sandbox",
						sandbox,
						"--gnu-tools-dir",
						gnuToolsDir,
						"--out",
						reportPath,
					],
					{ encoding: "utf-8", maxBuffer: 256 * 1024 * 1024, timeout: 15 * 60_000 },
				);
				expect(existsSync(reportPath), `replay produced no report: ${run.stderr}\n${run.stdout}`).toBe(true);
				const report = JSON.parse(readFileSync(reportPath, "utf-8")) as WallReport;
				expect(report.shapes).toBe(fixture.shapes.length);
				expect(report.owned).toBeGreaterThan(300);
				// The refusal budget for supported families is zero; only dialect mistakes are refused.
				expect(report.refusedByDesign).toBeLessThanOrEqual(20);
				const defects = report.defects.map(
					(defect) => `${defect.id} ${defect.kind}: ${defect.detail}\n  ${defect.command}`,
				);
				expect(defects, `${defects.length} defect(s) in the corpus wall`).toEqual([]);
				expect(run.status).toBe(0);
			} finally {
				rmSync(scratch, { recursive: true, force: true });
			}
		},
		16 * 60_000,
	);
});
