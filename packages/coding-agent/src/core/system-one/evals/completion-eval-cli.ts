/**
 * `npm run eval:completion [-- --repeats N] [-- --case <id>]` from packages/coding-agent: runs the
 * completion reliability evaluation against the REAL System One, with the credentials a session
 * uses, and prints per-case verdicts plus the release thresholds. Exits non-zero below them.
 *
 * It spends System One evaluations (two per attempt), so the default is 5 repeats per case.
 */
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { AuthStorage } from "../../auth-storage.ts";
import { TypeSafeReviewer } from "../../review/typesafe-reviewer.ts";
import { SettingsManager } from "../../settings-manager.ts";
import { systemOneAccessFromSession } from "../access.ts";
import { SystemOneJevAdapter } from "../adapter.ts";
import { createSystemOneConfig } from "../config.ts";
import {
	COMPLETION_EVAL_CASES,
	COMPLETION_EVAL_HELDOUT_CASES,
	type CompletionEvalSummary,
	runCompletionEval,
} from "./completion-eval.ts";

/** Release thresholds (outcome-completion plan, WO-9). */
export const COMPLETION_EVAL_THRESHOLDS = Object.freeze({ doneAccepted: 0.95, incompleteRejected: 1 });

function percent(value: number): string {
	return Number.isNaN(value) ? "n/a" : `${(value * 100).toFixed(0)}%`;
}

export function formatCompletionEval(summary: CompletionEvalSummary): string {
	const lines = summary.runs.map(
		(run) =>
			`${run.done ? "done      " : "incomplete"} ${run.kind.padEnd(11)} ${run.caseId.padEnd(34)} ${run.verdicts.join(", ")}`,
	);
	lines.push("");
	for (const [kind, rates] of Object.entries(summary.byKind)) {
		lines.push(
			`${kind.padEnd(11)} done accepted ${percent(rates.doneAccepted)}, incomplete rejected ${percent(rates.incompleteRejected)}`,
		);
	}
	lines.push(
		`overall     done accepted ${percent(summary.doneAccepted)} (need ${percent(COMPLETION_EVAL_THRESHOLDS.doneAccepted)}), incomplete rejected ${percent(summary.incompleteRejected)} (need ${percent(COMPLETION_EVAL_THRESHOLDS.incompleteRejected)})`,
	);
	const firstReasons = summary.runs
		.filter((run) => run.done && run.verdicts.some((verdict) => verdict !== "complete"))
		.map(
			(run) =>
				`  ${run.caseId}: ${run.reasons.find((reasons) => reasons.length > 0)?.join(" | ") ?? run.verdicts.find((v) => v !== "complete")}`,
		);
	if (firstReasons.length > 0) lines.push("", "rejected done cases (first reason):", ...firstReasons);
	return lines.join("\n");
}

async function main(argv: string[]): Promise<number> {
	const repeatsIndex = argv.indexOf("--repeats");
	const repeats = repeatsIndex >= 0 ? Number(argv[repeatsIndex + 1]) : 5;
	const setIndex = argv.indexOf("--set");
	const pool =
		setIndex >= 0 && argv[setIndex + 1] === "heldout" ? COMPLETION_EVAL_HELDOUT_CASES : COMPLETION_EVAL_CASES;
	const caseIndex = argv.indexOf("--case");
	const cases =
		caseIndex >= 0
			? [...COMPLETION_EVAL_CASES, ...COMPLETION_EVAL_HELDOUT_CASES].filter(
					(testCase) => testCase.id === argv[caseIndex + 1],
				)
			: pool;
	const settings = SettingsManager.create(process.cwd());
	const access = systemOneAccessFromSession(settings, AuthStorage.create());
	if ((await access.resolve()).kind !== "ready") {
		process.stderr.write("System One is not configured for this user; log in with /login typesafe first.\n");
		return 2;
	}
	const adapter = new SystemOneJevAdapter(new TypeSafeReviewer({ access }), createSystemOneConfig({ enabled: true }), {
		access,
		getUserKeys: () => access.keys(),
	});
	const summary = await runCompletionEval(adapter, {
		repeats,
		cases,
		onRun: (run) => process.stderr.write(`${run.caseId}: ${run.verdicts.join(", ")}\n`),
	});
	process.stdout.write(`${formatCompletionEval(summary)}\n`);
	const dumpIndex = argv.indexOf("--dump");
	if (dumpIndex >= 0)
		writeFileSync(argv[dumpIndex + 1] ?? "completion-eval.json", `${JSON.stringify(summary, null, 2)}\n`);
	const passed =
		summary.doneAccepted >= COMPLETION_EVAL_THRESHOLDS.doneAccepted &&
		summary.incompleteRejected >= COMPLETION_EVAL_THRESHOLDS.incompleteRejected;
	return passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(error) => {
			process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
			process.exit(2);
		},
	);
}
