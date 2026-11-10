/**
 * `pi decisions`: the maintenance command over the decision ledger. `report` totals what the ledger
 * holds for one scope, `export` writes its settled System One evaluations out as replay cases a person
 * can label. It starts no session and makes no provider request, and the process root runs it without
 * loading the session program; the reading itself lives in `decision-ledger-analysis.ts` and the ledger
 * is never written.
 */

import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getAgentDir } from "../config.ts";
import { decisionLedgerFile } from "../core/agent-paths.ts";
import {
	type DecisionAnalysisScope,
	type DecisionLedgerAnalysis,
	type DecisionReport,
	openDecisionLedgerAnalysis,
} from "../core/operator-projection/decision-ledger-analysis.ts";
import { answeringRefusals, CommandRefusal, DECISIONS_HELP } from "./maintenance-command.ts";

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 30;
const LABEL_WIDTH = 17;

interface DecisionsOptions {
	readonly all: boolean;
	readonly cwd: string;
	readonly explicitCwd: boolean;
	readonly days: number;
	readonly json: boolean;
	readonly force: boolean;
	readonly out?: string;
	readonly program?: string;
}

/** The flags each subcommand reads; anything else is an unknown argument, as `accounting-reconcile` reports it. */
const REPORT_FLAGS: ReadonlySet<string> = new Set(["--cwd", "--all", "--days", "--json"]);
const EXPORT_FLAGS: ReadonlySet<string> = new Set(["--cwd", "--all", "--days", "--program", "--out", "--force"]);
const VALUE_FLAGS: ReadonlySet<string> = new Set(["--cwd", "--days", "--program", "--out"]);

function readValue(args: readonly string[], flag: string, index: number): string {
	const value = args[index + 1];
	if (value === undefined || value.startsWith("--")) throw new CommandRefusal(`Missing value for ${flag}`);
	return value;
}

function parseOptions(command: "report" | "export", args: readonly string[]): DecisionsOptions {
	const allowed = command === "report" ? REPORT_FLAGS : EXPORT_FLAGS;
	let all = false;
	let cwd = process.cwd();
	let explicitCwd = false;
	let days = DEFAULT_DAYS;
	let json = false;
	let force = false;
	let out: string | undefined;
	let program: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (!allowed.has(arg)) throw new CommandRefusal(`Unknown or incomplete decisions argument: ${arg}`);
		if (arg === "--all") {
			all = true;
			continue;
		}
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--force") {
			force = true;
			continue;
		}
		const value = VALUE_FLAGS.has(arg) ? readValue(args, arg, index) : undefined;
		if (value === undefined) throw new CommandRefusal(`Unknown or incomplete decisions argument: ${arg}`);
		index++;
		if (arg === "--cwd") {
			cwd = resolve(value);
			explicitCwd = true;
		} else if (arg === "--days") {
			if (!/^\d+$/.test(value)) throw new CommandRefusal(`--days takes a whole number of days: ${value}`);
			days = Number(value);
		} else if (arg === "--program") program = value;
		else out = resolve(value);
	}
	if (all && explicitCwd) throw new CommandRefusal("Choose only one scope: --cwd or --all.");
	if (command === "export" && out === undefined)
		throw new CommandRefusal("decisions export needs --out <file.jsonl>.");
	return {
		all,
		cwd,
		explicitCwd,
		days,
		json,
		force,
		...(out !== undefined ? { out } : {}),
		...(program !== undefined ? { program } : {}),
	};
}

/** `since` is fixed once so the report and a counting export pass read the same window. */
function scopeOf(options: DecisionsOptions, now: number): DecisionAnalysisScope {
	return {
		...(options.all ? {} : { cwd: options.cwd }),
		...(options.days > 0 ? { since: now - options.days * DAY_MS } : {}),
		...(options.program !== undefined ? { programId: options.program } : {}),
	};
}

function scopeLabel(options: DecisionsOptions): string {
	const place = options.all ? "all projects" : options.cwd;
	const window = options.days === 0 ? "all time" : `last ${options.days} days`;
	return `${place}, ${window}`;
}

function line(label: string, value: string): string {
	return `${label.padEnd(LABEL_WIDTH)}${value}`;
}

function detail(label: string, value: string): string {
	return `  ${label.padEnd(LABEL_WIDTH - 2)}${value}`;
}

function counts(entries: Readonly<Record<string, number>>, separator: string): string {
	const pairs = Object.entries(entries);
	return pairs.length === 0 ? "none" : pairs.map(([name, count]) => `${name} ${count}`).join(separator);
}

/** The same tally with the names a person reads, in the same order. */
function namedBy(
	entries: Readonly<Record<string, number>>,
	words: Readonly<Record<string, string>>,
): Record<string, number> {
	return Object.fromEntries(Object.entries(entries).map(([name, count]) => [words[name] ?? name, count]));
}

function duration(ms: number | undefined): string | undefined {
	return ms === undefined ? undefined : `${Math.round(ms)}ms`;
}

/** A decided figure list: only what the ledger recorded, in the order the report holds it. */
function paragraph(parts: ReadonlyArray<string | undefined>): string {
	return parts.filter((part): part is string => part !== undefined && part.length > 0).join("; ");
}

function reportLines(path: string, options: DecisionsOptions, report: DecisionReport): string[] {
	const lines = [line("decision ledger", path), line("scope", scopeLabel(options)), ""];
	const evaluations = report.evaluations;
	lines.push(
		line("sessions", String(report.sessions)),
		line(
			"evaluations",
			`${evaluations.total}  (ok ${evaluations.ok}, failed ${evaluations.failed}, cancelled ${evaluations.cancelled}, unsettled ${evaluations.unsettled})`,
		),
		"",
	);
	if (report.programs.length === 0) lines.push(line("programs", "none"));
	else {
		lines.push(line("programs", `${report.programs.length}`));
		for (const program of report.programs) {
			lines.push(
				`  ${program.programId}`,
				detail(
					"evaluations",
					`${program.total}  (ok ${program.ok}, failed ${program.failed}, cancelled ${program.cancelled}, uncertain ${program.uncertain}, cached ${program.cached})`,
				),
				detail(
					"duration",
					paragraph([
						duration(program.medianMs),
						program.p90Ms !== undefined ? `p90 ${duration(program.p90Ms)}` : undefined,
					]) || "no settled row",
				),
				detail("exits", counts(program.exits, ", ")),
				detail("verdicts", counts(program.verdicts, ", ")),
			);
		}
	}
	lines.push(
		"",
		line("models", counts(report.models, ", ")),
		line(
			"operation gate",
			`${report.operationGate.total}  (${paragraph([
				`actions ${counts(report.operationGate.actions, ", ")}`,
				`sources ${counts(namedBy(report.operationGate.sources, GATE_SOURCE_WORDS), ", ")}`,
				`notable ${report.operationGate.notable}`,
				report.operationGate.medianMs !== undefined
					? `median ${duration(report.operationGate.medianMs)}`
					: undefined,
			])})`,
		),
		line(
			"routes",
			`${report.routes.total}  (${paragraph([
				`routes ${counts(report.routes.routes, ", ")}`,
				`executors ${counts(report.routes.executors, ", ")}`,
			])})`,
		),
		line("supervision", `${report.supervision.total}  (${counts(report.supervision.actions, ", ")})`),
		line("doubts", counts(report.doubts, ", ")),
		line(
			"unreadable",
			report.unreadable === 0
				? "0"
				: `${report.unreadable}  (stored JSON did not decode; counted here, left out of the export)`,
		),
	);
	return lines;
}

/** One pass: the file is opened when the first case arrives, so a scope with no case leaves no file behind. */
function writeCases(analysis: DecisionLedgerAnalysis, scope: DecisionAnalysisScope, options: DecisionsOptions): void {
	const out = options.out!;
	let handle: number | undefined;
	const open = (): number => {
		mkdirSync(dirname(out), { recursive: true });
		try {
			// The exclusive flag refuses an existing file in the same step that would create it.
			return openSync(out, options.force ? "w" : "wx");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST")
				throw new CommandRefusal(`${out} exists; pass --force to replace it.`);
			throw error;
		}
	};
	let written = 0;
	try {
		written = analysis.exportCases(scope, (replayCase) => {
			handle ??= open();
			writeSync(handle, `${JSON.stringify(replayCase)}\n`);
		});
	} finally {
		if (handle !== undefined) closeSync(handle);
	}
	console.log(
		written === 0
			? `No settled evaluations in scope; nothing written to ${out}`
			: `Wrote ${written} replay cases to ${out}`,
	);
}

/** Where a gate decision's answer came from, in the words a person reads; the ledger stores the first as `jev`. */
const GATE_SOURCE_WORDS: Readonly<Record<string, string>> = { jev: "System One" };

/** The command's process entry: the exit code, after a refusal was said on standard error. */
export function runDecisionsEntry(args: string[]): Promise<number> {
	return answeringRefusals(DECISIONS_HELP, () => runDecisionsCommand(args));
}

/** Explicit maintenance command; no session runtime, provider request, or transcript write. */
async function runDecisionsCommand(args: string[]): Promise<void> {
	const command = args[0];
	if (command === "--help" || command === "-h") {
		console.log(DECISIONS_HELP);
		return;
	}
	if (command !== "report" && command !== "export")
		throw new CommandRefusal(`Choose a decisions subcommand: report or export. Received: ${command ?? "nothing"}.`);
	const options = parseOptions(command, args.slice(1));
	const scope = scopeOf(options, Date.now());
	const path = decisionLedgerFile(getAgentDir());
	let analysis: DecisionLedgerAnalysis | undefined;
	try {
		analysis = openDecisionLedgerAnalysis(path);
	} catch (error) {
		// A ledger of another schema version is the store's state, not a defect of this command.
		throw new CommandRefusal(error instanceof Error ? error.message : String(error));
	}
	if (analysis === undefined) {
		console.log(`No decisions are recorded yet at ${path}`);
		return;
	}
	try {
		if (command === "report") {
			const report = analysis.report(scope);
			console.log(options.json ? JSON.stringify(report, null, 2) : reportLines(path, options, report).join("\n"));
		} else writeCases(analysis, scope, options);
	} finally {
		analysis.close();
	}
}
