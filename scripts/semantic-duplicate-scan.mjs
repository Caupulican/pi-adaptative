#!/usr/bin/env node
/**
 * Semantic duplicate scan: every production code unit judged by Jev against its closest candidates.
 * The Jev counterpart of the jscpd clone gate: it finds logic that does the same job written differently,
 * which token-level clone detection cannot see. Needs a TypeSafe key (TYPESAFE_API_KEY or
 * ~/.config/typesafe/.env) and network, so it is a report, not part of `npm run check`.
 *
 * usage: node --conditions=pi-source scripts/semantic-duplicate-scan.mjs [--out <report.md>]
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	harnessFileLister,
	isTestPath,
	JEV_SCAN_CONCURRENCY,
	SemanticUnitIndex,
	scanSemanticDuplicates,
} from "../packages/coding-agent/src/core/system-one/code-duplicates.ts";
import { JEV_LIVE_MODEL, liveSystemOneController, repositoryRoot } from "./jev-live.mjs";

const outIndex = process.argv.indexOf("--out");
const out = outIndex > 0 ? resolve(process.argv[outIndex + 1]) : undefined;
const controller = liveSystemOneController("semantic-duplicate-scan");

const production = (path) =>
	/^(packages\/[^/]+\/src\/|scripts\/)/.test(path) && !isTestPath(path) && !/\.d\.ts$|\.generated\./.test(path);
const started = Date.now();
const index = new SemanticUnitIndex(repositoryRoot, "**/*.{ts,mts,js,mjs}", async (root, glob, signal) =>
	(await harnessFileLister(root, glob, signal)).filter(production),
);
await index.refresh();
const scan = await scanSemanticDuplicates({ index, controller });
const seconds = ((Date.now() - started) / 1000).toFixed(1);
const where = (unit) => `${unit.path}:${unit.line} ${unit.name}`;
const section = (band, title) => [
	"",
	`## ${title}`,
	...scan.verdicts.filter((v) => v.band === band).map((v) => `- ${v.probability.toFixed(2)} ${where(v.unit)} <-> ${where(v.candidate)}`),
];
const counts = (band) => scan.verdicts.filter((v) => v.band === band).length;
const report = [
	"# Semantic duplicate scan",
	"",
	`${scan.units} units, ${scan.pairs} candidate pairs judged by ${JEV_LIVE_MODEL} in ${scan.requests} requests (${JEV_SCAN_CONCURRENCY} concurrent), ${seconds} s; failed requests: ${scan.failedRequests}.`,
	`Same job (hard_pass): ${counts("hard_pass")}. Provisional (soft_pass): ${counts("soft_pass")}. Unsettled: ${counts("ambiguous")}.`,
	...section("hard_pass", "Same job, written differently"),
	...section("soft_pass", "Provisional"),
].join("\n");
if (out) writeFileSync(out, `${report}\n`);
console.log(out ? report.split("\n").slice(0, 4).join("\n") : report);
process.exitCode = scan.failedRequests > 0 ? 1 : 0;
