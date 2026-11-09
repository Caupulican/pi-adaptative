/**
 * `npm run eval:plan-graph [-- --dump <file>]` from packages/coding-agent: runs the labelled plan graph set against the
 * REAL System One, with the credentials a session uses, and prints agreement per question (coverage J1, dependency
 * J2 with J3, brief J4). Exits non-zero while any question is below the accept cut. Each case spends a few System One
 * requests, so the owner runs it; the judgments keep their pending-measurement status until it has.
 */
import { writeFileSync } from "node:fs";
import { createRetentionDecisionEngine } from "../../compaction/retention-decision-engine.ts";
import { TypeSafeSystemOneDecisionEngine } from "../../decision/engines/typesafe-system-one-engine.ts";
import { resolveSystemOneEvalAdapter, runEvalCliEntry } from "./eval-cli.ts";
import {
	PLAN_GRAPH_EVAL_CASES,
	PLAN_GRAPH_EVAL_THRESHOLDS,
	type PlanGraphEvalSummary,
	planGraphEvalPasses,
	runPlanGraphEval,
} from "./plan-graph-eval.ts";

function percent(value: number): string {
	return `${(value * 100).toFixed(0)}%`;
}

export function formatPlanGraphEval(summary: PlanGraphEvalSummary): string {
	const lines = summary.cases.map((score) => {
		const misses = [
			...(score.gap.correct ? [] : ["coverage"]),
			...score.pairs.filter((pair) => !pair.correct).map((pair) => `pair ${pair.pair} (${pair.reading})`),
			...score.thin.filter((entry) => !entry.correct).map((entry) => `brief ${entry.id} (${entry.reading})`),
		];
		return `${score.id.padEnd(22)} ${misses.length === 0 ? "all agree" : `differs: ${misses.join(", ")}`}`;
	});
	lines.push("");
	const rows: [string, number][] = [
		["coverage (J1)", summary.agreement.coverage],
		["dependency (J2 with J3)", summary.agreement.dependency],
		["brief (J4)", summary.agreement.brief],
	];
	for (const [name, value] of rows) {
		lines.push(
			`${name.padEnd(24)} agreement ${percent(value)} (need ${percent(PLAN_GRAPH_EVAL_THRESHOLDS.agreement)})`,
		);
	}
	lines.push(`open readings across the set: ${summary.open}`);
	return lines.join("\n");
}

async function main(argv: string[]): Promise<number> {
	const setup = await resolveSystemOneEvalAdapter();
	if (setup.kind !== "ready") {
		process.stderr.write(`System One is not configured for this user; ${setup.setup}.\n`);
		return 2;
	}
	// The executor's own engine shape: the batched-question engine over the TypeSafe System One decision engine.
	const engine = createRetentionDecisionEngine(new TypeSafeSystemOneDecisionEngine(setup.adapter));
	const summary = await runPlanGraphEval(engine, PLAN_GRAPH_EVAL_CASES);
	process.stdout.write(`${formatPlanGraphEval(summary)}\n`);
	const dumpIndex = argv.indexOf("--dump");
	if (dumpIndex >= 0)
		writeFileSync(argv[dumpIndex + 1] ?? "plan-graph-eval.json", `${JSON.stringify(summary, null, 2)}\n`);
	return planGraphEvalPasses(summary) ? 0 : 1;
}

runEvalCliEntry(import.meta.url, main);
