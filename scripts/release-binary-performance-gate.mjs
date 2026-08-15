#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFlagValue } from "./flag-value-args.mjs";

const DEFAULT_BUDGETS = Object.freeze({
	coldShellMedianMs: 250,
	coldShellP95Ms: 500,
	firstShellReadyMedianMs: 1_750,
	firstShellReadyP95Ms: 3_000,
	firstShellReadyMedianRatio: 1.75,
	firstShellReadyP95Ratio: 2.5,
	warmRpcMedianMs: 5,
	warmRpcP95Ms: 10,
	warmShellMedianMs: 10,
	warmShellP95Ms: 25,
});

function finiteNonNegative(value, label) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`${label} must be a finite non-negative number`);
	}
	return value;
}

function validateMetric(benchmark, metricName) {
	const metric = benchmark.metrics?.[metricName];
	if (!metric || typeof metric !== "object") throw new Error(`${benchmark.label}.${metricName} is required`);
	finiteNonNegative(metric.medianMs, `${benchmark.label}.${metricName}.medianMs`);
	finiteNonNegative(metric.p95Ms, `${benchmark.label}.${metricName}.p95Ms`);
	return metric;
}

function validateBenchmark(benchmark, expectedPlatform) {
	if (!benchmark || typeof benchmark !== "object") throw new Error(`A ${expectedPlatform} benchmark is required`);
	if (typeof benchmark.label !== "string" || benchmark.label.length === 0) {
		throw new Error(`${expectedPlatform} benchmark label is required`);
	}
	if (benchmark.schemaVersion !== 2) {
		throw new Error(`${benchmark.label} uses benchmark schema ${String(benchmark.schemaVersion)}; expected 2`);
	}
	if (benchmark.platform !== expectedPlatform) {
		throw new Error(`${benchmark.label} reports platform ${String(benchmark.platform)}; expected ${expectedPlatform}`);
	}
	for (const metricName of ["coldShell", "firstShellReady", "warmRpc", "warmShell"]) {
		validateMetric(benchmark, metricName);
	}
}

function check(name, actual, limit, unit = "ms", blocking = true) {
	return {
		name,
		actual: Math.round(actual * 1000) / 1000,
		limit: Math.round(limit * 1000) / 1000,
		unit,
		passed: actual <= limit,
		blocking,
	};
}

export function evaluateReleaseBinaryPerformance({ linux, windows, budgets = DEFAULT_BUDGETS }) {
	validateBenchmark(linux, "linux");
	if (!Array.isArray(windows) || windows.length === 0) throw new Error("At least one Windows benchmark is required");
	for (const benchmark of windows) validateBenchmark(benchmark, "win32");

	const linuxReady = linux.metrics.firstShellReady;
	const platforms = windows.map((benchmark) => {
		const checks = [
			check("coldShell.medianMs", benchmark.metrics.coldShell.medianMs, budgets.coldShellMedianMs),
			check("coldShell.p95Ms", benchmark.metrics.coldShell.p95Ms, budgets.coldShellP95Ms),
			check(
				"firstShellReady.medianMs",
				benchmark.metrics.firstShellReady.medianMs,
				budgets.firstShellReadyMedianMs,
			),
			check("firstShellReady.p95Ms", benchmark.metrics.firstShellReady.p95Ms, budgets.firstShellReadyP95Ms),
			check(
				"firstShellReady.medianRatio",
				benchmark.metrics.firstShellReady.medianMs / Math.max(linuxReady.medianMs, 0.001),
				budgets.firstShellReadyMedianRatio,
				"ratio",
				false,
			),
			check(
				"firstShellReady.p95Ratio",
				benchmark.metrics.firstShellReady.p95Ms / Math.max(linuxReady.p95Ms, 0.001),
				budgets.firstShellReadyP95Ratio,
				"ratio",
				false,
			),
			check("warmRpc.medianMs", benchmark.metrics.warmRpc.medianMs, budgets.warmRpcMedianMs),
			check("warmRpc.p95Ms", benchmark.metrics.warmRpc.p95Ms, budgets.warmRpcP95Ms),
			check("warmShell.medianMs", benchmark.metrics.warmShell.medianMs, budgets.warmShellMedianMs),
			check("warmShell.p95Ms", benchmark.metrics.warmShell.p95Ms, budgets.warmShellP95Ms),
		];
		return {
			label: benchmark.label,
			passed: checks.every((candidate) => !candidate.blocking || candidate.passed),
			checks,
		};
	});

	return {
		schemaVersion: 2,
		passed: platforms.every((platform) => platform.passed),
		linux: {
			label: linux.label,
			firstShellReadyMedianMs: linuxReady.medianMs,
			firstShellReadyP95Ms: linuxReady.p95Ms,
		},
		budgets,
		platforms,
	};
}

function parseCliArgs(argv) {
	const options = { windows: [] };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		const value = resolve(requireFlagValue(argv, index));
		switch (argument) {
			case "--linux":
				options.linux = value;
				break;
			case "--windows":
				options.windows.push(value);
				break;
			case "--output":
				options.output = value;
				break;
			default:
				throw new Error(`Unknown argument: ${argument}`);
		}
		index += 1;
	}
	if (!options.linux) throw new Error("--linux is required");
	if (options.windows.length === 0) throw new Error("At least one --windows benchmark is required");
	return options;
}

function readBenchmark(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot read benchmark ${path}: ${message}`);
	}
}

function formatCheck(checkResult) {
	const status = checkResult.passed ? "PASS" : checkResult.blocking ? "FAIL" : "WARN";
	return `${status} ${checkResult.name}: ${checkResult.actual}${checkResult.unit} <= ${checkResult.limit}${checkResult.unit}`;
}

function main() {
	const options = parseCliArgs(process.argv.slice(2));
	const report = evaluateReleaseBinaryPerformance({
		linux: readBenchmark(options.linux),
		windows: options.windows.map(readBenchmark),
	});
	const serialized = `${JSON.stringify(report, null, 2)}\n`;
	if (options.output) writeFileSync(options.output, serialized);
	for (const platform of report.platforms) {
		process.stdout.write(`${platform.label}:\n${platform.checks.map(formatCheck).join("\n")}\n`);
	}
	process.stdout.write(`PI_RELEASE_BINARY_PERFORMANCE=${JSON.stringify(report)}\n`);
	if (!report.passed) throw new Error("Native Windows release binary performance gate failed");
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
	try {
		main();
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
