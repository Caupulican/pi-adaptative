#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { isToolRepairCorpusRecord, replayToolRepairCorpus } = await jiti.import(
	"../packages/ai/src/utils/tool-repair/replay.ts",
);

function printHelp() {
	console.log(`Usage: node scripts/tool-repair-replay.mjs <jsonl-file> [--json] [--fixtures <path>]

Reads tool_validation records from the failure corpus, or bounced tool_argument_validation
custom entries from a session JSONL file, then replays their sanitized shapes through the
tool-repair analyzer/repairer offline.

Options:
  --json             Print the full replay report as JSON
  --fixtures <path>  Write replayable fixture JSON to the path
  -h, --help         Show this help
`);
}

function parseArgs(argv) {
	const options = { input: undefined, json: false, fixturesPath: undefined, help: false };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") options.help = true;
		else if (arg === "--json") options.json = true;
		else if (arg === "--fixtures") options.fixturesPath = argv[++index];
		else if (!options.input) options.input = arg;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return options;
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLine(line, lineNumber) {
	try {
		return JSON.parse(line);
	} catch (error) {
		throw new Error(`Invalid JSON on line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function corpusRecordFromSessionEntry(entry) {
	if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== "tool_argument_validation") return undefined;
	const data = entry.data;
	if (!isRecord(data) || data.outcome !== "bounced" || typeof data.tool !== "string" || !Array.isArray(data.failureShape)) {
		return undefined;
	}
	return {
		kind: "tool_validation",
		provider: typeof data.provider === "string" ? data.provider : undefined,
		modelId: typeof data.model === "string" ? data.model : undefined,
		tool: data.tool,
		failureModes: Array.isArray(data.failureModes) ? data.failureModes.filter((mode) => typeof mode === "string") : [],
		shape: data.failureShape,
		errorKeywords: Array.isArray(data.errorKeywords)
			? data.errorKeywords.filter((keyword) => typeof keyword === "string")
			: [],
	};
}

function loadRecords(path) {
	const records = [];
	const lines = readFileSync(path, "utf-8").split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index].trim();
		if (!line) continue;
		const parsed = parseLine(line, index + 1);
		if (isToolRepairCorpusRecord(parsed)) {
			records.push(parsed);
			continue;
		}
		const sessionRecord = corpusRecordFromSessionEntry(parsed);
		if (sessionRecord && isToolRepairCorpusRecord(sessionRecord)) records.push(sessionRecord);
	}
	return records;
}

function printTextReport(report) {
	for (const item of report) {
		const model = item.provider || item.modelId ? ` ${item.provider ?? "unknown"}/${item.modelId ?? "unknown"}` : "";
		const repairs = item.repairsApplied.length > 0 ? ` repairs=${item.repairsApplied.join(",")}` : "";
		console.log(
			`#${item.record} ${item.tool}${model}: modes=${item.classifiedModes.join(",")} outcome=${item.outcome}${repairs}`,
		);
	}
	console.log(`records=${report.length}`);
}

const options = parseArgs(process.argv.slice(2));
if (options.help || !options.input) {
	printHelp();
	process.exit(options.help ? 0 : 1);
}

const records = loadRecords(options.input);
const report = replayToolRepairCorpus(records);
if (options.fixturesPath) {
	writeFileSync(options.fixturesPath, `${JSON.stringify(report.map((item) => item.fixture), null, 2)}\n`, "utf-8");
}
if (options.json) {
	console.log(JSON.stringify(report, null, 2));
} else {
	printTextReport(report);
}
