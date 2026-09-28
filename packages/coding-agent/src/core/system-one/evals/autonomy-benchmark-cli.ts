/**
 * `npm run eval:autonomy -- <paired-observations.json>` validates recorded autonomous task runs.
 * The input contains `cases` and one `enabled` plus one `unavailable` observation per case.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
	evaluateSystemOneAutonomyBenchmark,
	type SystemOneAutonomyBenchmarkCase,
	type SystemOneAutonomyBenchmarkObservation,
} from "./autonomy-benchmark.ts";

interface AutonomyBenchmarkInput {
	cases: SystemOneAutonomyBenchmarkCase[];
	observations: SystemOneAutonomyBenchmarkObservation[];
}

function readInput(path: string): AutonomyBenchmarkInput {
	const value = JSON.parse(readFileSync(path, "utf8")) as Partial<AutonomyBenchmarkInput>;
	if (!Array.isArray(value.cases) || !Array.isArray(value.observations))
		throw new Error("Autonomy benchmark input requires cases and observations arrays");
	return { cases: value.cases, observations: value.observations };
}

function formatNumber(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(6);
}

export function formatSystemOneAutonomyBenchmark(path: string): string {
	const report = evaluateSystemOneAutonomyBenchmark(readInput(path));
	const lines = (["enabled", "unavailable"] as const).map((mode) => {
		const summary = report.modes[mode];
		return `${mode.padEnd(11)} success ${summary.successes}/${summary.cases}, unsafe ${summary.unsafeActions}, false blocks ${summary.falseBlocks}, owner interventions ${summary.ownerInterventions}, root tokens ${summary.rootTokens}, semantic tokens ${summary.semanticTokens}, cost $${summary.costUsd.toFixed(6)}, latency ${summary.latencyMs} ms`;
	});
	lines.push(
		`delta       root tokens ${formatNumber(report.delta.rootTokens)}, semantic tokens ${formatNumber(report.delta.semanticTokens)}, cost $${report.delta.costUsd.toFixed(6)}, latency ${formatNumber(report.delta.latencyMs)} ms`,
	);
	if (report.failures.length > 0) lines.push("", ...report.failures.map((failure) => `FAIL ${failure}`));
	lines.push("", report.passed ? "PASS autonomy capability parity" : "FAIL autonomy capability parity");
	return lines.join("\n");
}

function main(argv: readonly string[]): number {
	const path = argv[0];
	if (!path) throw new Error("Usage: npm run eval:autonomy -- <paired-observations.json>");
	const output = formatSystemOneAutonomyBenchmark(path);
	process.stdout.write(`${output}\n`);
	return output.endsWith("PASS autonomy capability parity") ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		process.exit(main(process.argv.slice(2)));
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
		process.exit(2);
	}
}
