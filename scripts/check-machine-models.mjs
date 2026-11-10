#!/usr/bin/env node
/**
 * Machine-model checks, the kernel model checker (D3). The models are plain data: the remote-job delivery model in
 * core/remote and the kernel vocabulary in kernel/machine-model*.ts. Two modes:
 *
 *   node --conditions=pi-source scripts/check-machine-models.mjs --static
 *       shape, coverage and symbols, then a bounded search of the real model (invariants, deadlocks, liveness) under
 *       reduced budgets (check:static)
 *   node --conditions=pi-source scripts/check-machine-models.mjs --explore
 *       exhaustive search of the real model at full bounds, the projection, and every variant (CI only)
 *
 * The models are imported from source, and the kernel imports workspace packages: `--conditions=pi-source` resolves those
 * to their sources too, so the check needs no build and never reads a `dist` that lags behind the sources.
 *
 * --explore fails when the search is not exhausted, when the real model breaks an invariant, deadlocks, or fails a liveness
 * property, when a declared action or crash never fires (so no model is vacuous), when the machine projection is ambiguous, and
 * when a variant does not break the property that names it, or breaks a property no cascade allows. A variant's deadlock is
 * printed, not failed: it is the stall of the property the variant names (spec 4.3).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DELIVERY_CASCADES,
	remoteJobDeliveryModel,
} from "../packages/coding-agent/src/core/remote/remote-job-delivery-model.ts";
import { exploreGraph, summarizeModel } from "../packages/coding-agent/src/kernel/machine-model-explore.ts";
import { checkLiveness, livenessShapeFailures } from "../packages/coding-agent/src/kernel/machine-model-liveness.ts";
import { crashLabel, modelShapeFailures, projectMachine } from "../packages/coding-agent/src/kernel/machine-model.ts";

const mode = process.argv[2];
if (mode !== "--static" && mode !== "--explore") {
	console.error("usage: node --conditions=pi-source scripts/check-machine-models.mjs --static | --explore");
	process.exit(2);
}

const root = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = join(root, "packages/coding-agent/src");

/** Every model this script checks, with the properties a variant may break beyond its own. */
const MODELS = [{ spec: remoteJobDeliveryModel, cascades: DELIVERY_CASCADES }];

/** The budgets `--static` searches under. A breach found under them is a breach of the model; a clean run proves nothing more. */
const STATIC_BOUNDS = { maxStates: 20000, maxCrashes: 1, maxDrops: 1 };

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Shape rules, the liveness fair lists, the coverage of real code, and the variant wiring. */
function shapeFailures(spec) {
	const failures = [...modelShapeFailures(spec), ...livenessShapeFailures(spec)];
	for (const cover of spec.covers) {
		const file = join(sourceRoot, cover.path);
		if (!existsSync(file)) {
			failures.push(`covered path "${cover.path}" does not exist`);
			continue;
		}
		const text = readFileSync(file, "utf8");
		for (const symbol of cover.symbols) {
			if (!new RegExp(`\\b${escapeRegExp(symbol)}\\b`).test(text))
				failures.push(`"${cover.path}" has no symbol "${symbol}"`);
		}
	}
	const named = new Set([...spec.invariants, ...(spec.liveness ?? [])].map((property) => property.brokenVariant));
	for (const key of Object.keys(spec.variants)) {
		if (!named.has(key)) failures.push(`variant "${key}" is named by no property`);
		for (const failure of modelShapeFailures(spec.variants[key](spec))) failures.push(`variant "${key}": ${failure}`);
	}
	return failures;
}

/** Searches one model under `bounds` and runs its liveness check. Nothing is judged here. */
function explore(spec, bounds = spec.bounds) {
	const bounded = { ...spec, bounds };
	const graph = exploreGraph(bounded);
	const report = summarizeModel(bounded, graph);
	const liveness = checkLiveness(bounded, graph);
	console.log(`${spec.name}: ${report.states} states, exhausted=${graph.exhausted}`);
	return { graph, report, liveness };
}

/** The breaches a search found, as one line each: an invariant, a liveness failure (with its loop), or a deadlock. */
function breachLines(outcome) {
	const lines = outcome.report.broken.map((breach) => `invariant "${breach.invariant}" breaks: ${breach.path.join(" > ")}`);
	for (const breach of outcome.liveness) {
		const cycle = breach.cycle.length > 0 ? ` then loops ${breach.cycle.join(" > ")}` : " then stalls";
		lines.push(`liveness "${breach.name}" fails: ${breach.path.join(" > ")}${cycle}`);
	}
	for (const deadlock of outcome.report.deadlocks) lines.push(`deadlock: ${deadlock.join(" > ")}`);
	return lines;
}

/** The gates of the full search: an exhausted search and every declared action and crash firing, so no model is vacuous. */
function coverageFailures(spec, outcome) {
	const failures = [];
	if (!outcome.graph.exhausted) failures.push(`the search stopped at ${spec.bounds.maxStates} states; it proves nothing`);
	const declared = [
		...spec.actions.map((action) => action.name),
		...(spec.crashes ?? []).map((crash) => crashLabel(crash.actor)),
	];
	for (const name of declared) {
		if (!outcome.report.fired.includes(name)) failures.push(`"${name}" never fires, so the model is vacuous there`);
	}
	return failures;
}

/** The real model at full bounds: no breach, no deadlock, and the machine projection is unambiguous. */
function baseFailures(spec, outcome) {
	const failures = [...coverageFailures(spec, outcome), ...breachLines(outcome)];
	try {
		projectMachine(spec, outcome.graph);
	} catch (error) {
		failures.push(`the machine projection is ambiguous: ${error.message}`);
	}
	return failures;
}

/** A variant must break every property that names it, and no property outside the cascade list its reason allows. */
function variantFailures(key, spec, cascades, outcome) {
	const failures = coverageFailures(spec, outcome);
	const failing = new Set([
		...outcome.report.broken.map((breach) => breach.invariant),
		...outcome.liveness.map((breach) => breach.name),
	]);
	const properties = [...spec.invariants, ...(spec.liveness ?? [])];
	const named = properties.filter((property) => property.brokenVariant === key).map((property) => property.name);
	const allowed = new Set([...named, ...(cascades[key] ?? [])]);
	for (const name of named) {
		if (!failing.has(name)) failures.push(`does not break "${name}", the property that names it`);
	}
	for (const name of failing) {
		if (!allowed.has(name)) failures.push(`breaks "${name}", which it does not name`);
	}
	return failures;
}

const problems = [];
for (const { spec, cascades } of MODELS) {
	if (mode === "--static") {
		for (const failure of shapeFailures(spec)) problems.push(`${spec.name}: ${failure}`);
		const bounded = explore(spec, { ...spec.bounds, ...STATIC_BOUNDS });
		for (const line of breachLines(bounded)) problems.push(`${spec.name} (bounded): ${line}`);
		continue;
	}
	const base = explore(spec);
	for (const failure of baseFailures(spec, base)) problems.push(`${spec.name}: ${failure}`);
	for (const key of Object.keys(spec.variants)) {
		const variant = spec.variants[key](spec);
		const outcome = explore(variant);
		for (const failure of variantFailures(key, variant, cascades, outcome)) {
			problems.push(`${spec.name} variant "${key}": ${failure}`);
		}
		for (const deadlock of outcome.report.deadlocks) {
			console.log(`  variant "${key}" stalls (printed, not failed; spec 4.3): ${deadlock.join(" > ")}`);
		}
	}
}

if (problems.length > 0) {
	for (const problem of problems) console.error(`check-machine-models: ${problem}`);
	process.exit(1);
}
console.log(
	mode === "--static"
		? `machine models: static checks and bounded search passed for ${MODELS.length} model(s)`
		: `machine models: exhaustive checks passed for ${MODELS.length} model(s)`,
);
