#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { createJiti } from "jiti";
import { Type } from "typebox";
import { Compile } from "typebox/compile";

const jiti = createJiti(import.meta.url);
const { validateToolArguments } = await jiti.import("../packages/ai/src/utils/validation.ts");

function parseArgs(argv) {
	let iterations = 50_000;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") {
			console.log("Usage: node scripts/bench-tool-repair.mjs [--iterations N]");
			process.exit(0);
		}
		if (arg === "--iterations" && argv[index + 1]) {
			iterations = Number(argv[++index]);
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}
	if (!Number.isInteger(iterations) || iterations <= 0) throw new Error("--iterations must be a positive integer");
	return { iterations };
}

function bench(label, iterations, fn) {
	const started = performance.now();
	for (let index = 0; index < iterations; index++) fn();
	const elapsedMs = performance.now() - started;
	return { label, iterations, elapsedMs, nsPerCall: (elapsedMs * 1_000_000) / iterations };
}

const { iterations } = parseArgs(process.argv.slice(2));
const parameters = Type.Object({ count: Type.Number(), mode: Type.Optional(Type.Literal("fast")) });
const tool = { name: "count", description: "Count", parameters };
const validator = Compile(parameters);
const validArgs = { count: 1, mode: "fast" };
const invalidArgs = { count: "42", mode: "fast" };

for (let index = 0; index < 1_000; index++) {
	validator.Check(validArgs);
	validateToolArguments(tool, { type: "toolCall", id: "warm-clean", name: "count", arguments: validArgs });
	validateToolArguments(tool, { type: "toolCall", id: "warm-repair", name: "count", arguments: invalidArgs });
}

const bareCheck = bench("bare-check", iterations, () => {
	if (!validator.Check(validArgs)) throw new Error("bare Check failed");
});
const clean = bench("validate-clean", iterations, () => {
	const result = validateToolArguments(tool, { type: "toolCall", id: "clean", name: "count", arguments: validArgs });
	if (result !== validArgs) throw new Error("clean path did not return the original args object");
});
const repair = bench("validate-repair", iterations, () => {
	const result = validateToolArguments(tool, { type: "toolCall", id: "repair", name: "count", arguments: invalidArgs });
	if (result.count !== 42) throw new Error("repair path did not repair count");
});

for (const row of [bareCheck, clean, repair]) {
	console.log(
		`${row.label}: iterations=${row.iterations} elapsedMs=${row.elapsedMs.toFixed(2)} nsPerCall=${row.nsPerCall.toFixed(0)}`,
	);
}
console.log(`cleanOverBareNs=${(clean.nsPerCall - bareCheck.nsPerCall).toFixed(0)}`);
