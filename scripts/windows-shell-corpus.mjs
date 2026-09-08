#!/usr/bin/env node
/**
 * The Windows shell corpus tool: the harness evaluates and evolves its own bash contract from
 * the commands models actually wrote, on this machine or on another one, without ever storing a
 * private command. It drives the shell engine's `corpus.py` (harvest, sanitize, verdicts,
 * replay, defect classification) and reports.
 *
 *   node scripts/windows-shell-corpus.mjs harvest  [--sessions <dir|file>...] [--platform win32|posix|all] [--write]
 *   node scripts/windows-shell-corpus.mjs replay   [--fixture <path>] [--gnu-tools-dir <dir>|off]
 *   node scripts/windows-shell-corpus.mjs evaluate [--sessions <dir|file>...] [--platform ...] [--write]
 *   node scripts/windows-shell-corpus.mjs stats    [--fixture <path>]
 *
 * `harvest` reads session transcripts (default: this machine's ~/.pi/agent/sessions; pass an
 * extracted archive from another machine to learn from it), turns every `bash` tool call into a
 * sanitized SHAPE with the grammar verdict the real command got, and reports how many shapes are
 * new against the repository fixture. With `--write` the new shapes are appended to the fixture
 * (`packages/coding-agent/test/fixtures/windows-shell-corpus/commands.json`) with stable ids, which
 * is how a live failure becomes a regression shield before its fix lands (docs/doctrine.md).
 *
 * `replay` runs a fixture through the engine grammar and, for every shape whose command names the
 * harness owns, through the real executor in a sandbox with the real GNU tools (Git for Windows'
 * usr\bin on Windows, /usr/bin on Linux), and prints every defect. Exit 1 when a defect exists.
 *
 * `evaluate` is harvest + replay over the merged result: the self-evaluation loop.
 *
 * Python: `PI_TEST_PYTHON`, else `python3`, else `python` on PATH.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const enginePath = join(repositoryRoot, "packages", "coding-agent", "src", "bundled-resources", "runtimes", "pi-shell-engine", "corpus.py");
const defaultFixture = join(repositoryRoot, "packages", "coding-agent", "test", "fixtures", "windows-shell-corpus", "commands.json");
const defaultSessions = join(homedir(), ".pi", "agent", "sessions");

function usage(code) {
	console.error(
		"usage: node scripts/windows-shell-corpus.mjs <harvest|replay|evaluate|stats> [--sessions <dir|file>...] [--platform win32|posix|all] [--fixture <path>] [--gnu-tools-dir <dir>|off] [--write]",
	);
	process.exit(code);
}

function parseArgs(argv) {
	const options = { command: argv[0], sessions: [], platform: "all", fixture: defaultFixture, gnuToolsDir: undefined, write: false };
	for (let index = 1; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--write") options.write = true;
		else if (arg === "--sessions") {
			while (index + 1 < argv.length && !argv[index + 1].startsWith("--")) options.sessions.push(argv[++index]);
		} else if (arg === "--platform") options.platform = argv[++index];
		else if (arg === "--fixture") options.fixture = resolve(argv[++index]);
		else if (arg === "--gnu-tools-dir") options.gnuToolsDir = argv[++index];
		else usage(2);
	}
	if (!["harvest", "replay", "evaluate", "stats"].includes(options.command)) usage(2);
	if (!["all", "win32", "posix"].includes(options.platform)) usage(2);
	if (options.sessions.length === 0) options.sessions = [defaultSessions];
	return options;
}

function resolvePython() {
	const candidates = process.env.PI_TEST_PYTHON ? [process.env.PI_TEST_PYTHON, "python3", "python"] : ["python3", "python"];
	for (const candidate of candidates) {
		const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
		if (probe.status === 0) return candidate;
	}
	console.error("no Python interpreter on PATH (set PI_TEST_PYTHON)");
	process.exit(2);
}

function runCorpus(python, args) {
	const result = spawnSync(python, ["-B", enginePath, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
	if (result.error) throw result.error;
	if (result.stderr.trim()) process.stderr.write(result.stderr);
	return result;
}

function harvest(python, options, outPath) {
	const args = ["harvest", "--sessions", ...options.sessions, "--platform", options.platform, "--out", outPath];
	if (existsSync(options.fixture)) args.push("--fixture", options.fixture);
	const result = runCorpus(python, args);
	if (result.status !== 0) process.exit(result.status ?? 1);
	const report = JSON.parse(result.stdout.trim().split("\n").pop());
	console.log(
		`harvest: ${report.files} transcript file(s), ${report.raw} bash call(s) -> ${report.shapes ?? 0} shape(s); ` +
			`${report.added ?? 0} new, ${report.known ?? 0} known, ${report["leak-blocked"] ?? 0} blocked by the leak guard, ` +
			`${report["verdict-mismatch"] ?? 0} verdict mismatch(es), ${report.dropped ?? 0} dropped; fixture now holds ${report.total} shape(s)`,
	);
	return report;
}

function replay(python, options, fixturePath) {
	const scratch = mkdtempSync(join(tmpdir(), "pi-corpus-replay-"));
	const sandbox = join(scratch, "a", "b", "c");
	const reportPath = join(scratch, "report.json");
	try {
		// The tool discovers the real GNU tools itself (Git for Windows' usr\\bin, or /usr/bin) unless told otherwise.
		const args = ["replay", "--fixture", fixturePath, "--sandbox", sandbox, "--out", reportPath, "--gnu-tools-dir", options.gnuToolsDir ?? "auto"];
		const result = runCorpus(python, args);
		if (!existsSync(reportPath)) {
			console.error(result.stdout);
			process.exit(result.status ?? 1);
		}
		const report = JSON.parse(readFileSync(reportPath, "utf8"));
		console.log(
			`replay: ${report.shapes} shape(s) parsed, ${report.owned} harness-owned shape(s) executed with GNU tools at ${report.gnuToolsDir ?? "(engine builtins)"}, ` +
				`${report.refusedByDesign} refused by design, ${report.defects.length} defect(s)`,
		);
		for (const defect of report.defects) {
			console.log(`\n${defect.id} ${defect.kind}: ${defect.detail}\n  ${defect.command}`);
		}
		return report.defects.length;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

const options = parseArgs(process.argv.slice(2));
const python = resolvePython();
if (options.command === "stats") {
	const result = runCorpus(python, ["stats", "--fixture", options.fixture]);
	process.stdout.write(result.stdout);
	process.exit(result.status ?? 0);
}
if (options.command === "replay") {
	process.exit(replay(python, options, options.fixture) > 0 ? 1 : 0);
}
const scratch = mkdtempSync(join(tmpdir(), "pi-corpus-harvest-"));
try {
	const outPath = options.write ? options.fixture : join(scratch, "fixture.json");
	harvest(python, options, outPath);
	if (options.write) console.log(`fixture written: ${options.fixture}`);
	if (options.command === "evaluate") process.exit(replay(python, options, outPath) > 0 ? 1 : 0);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
