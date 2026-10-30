import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir, getSessionsDir } from "../config.ts";
import { reconcileAccountingFragment } from "../core/cost/accounting-fragments.ts";
import { readAccountedSession, reconcileSessionAccounting } from "../core/cost/accounting-history.ts";
import { aggregateCurrentSessionCostsFromEntries } from "../core/cost/cost-summary.ts";
import { computeSessionTaskAndModelMetrics } from "../core/cost/task-cost-metrics.ts";
import { getDefaultSessionDirCandidates, readSessionHeaderResult } from "../kernel/session/session-manager.ts";

export const ACCOUNTING_RECONCILE_HELP =
	"accounting-reconcile [--cwd <path> | --session <file> | --all]  Recover historical accounting without starting a model";

/** Explicit maintenance command; no session runtime, provider request, or transcript write. */
export async function runAccountingReconcileCommand(args: string[]): Promise<void> {
	let cwd = process.cwd();
	let session: string | undefined;
	let all = false;
	let explicitCwd = false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--help" || arg === "-h") {
			console.log(ACCOUNTING_RECONCILE_HELP);
			return;
		}
		if (arg === "--all") all = true;
		else if ((arg === "--cwd" || arg === "--session") && args[index + 1]) {
			if (args[index + 1]!.startsWith("--")) throw new Error(`Missing value for ${arg}`);
			const value = resolve(args[++index]!);
			if (arg === "--cwd") {
				cwd = value;
				explicitCwd = true;
			} else session = value;
		} else throw new Error(`Unknown or incomplete accounting argument: ${arg}`);
	}
	if (Number(all) + Number(session !== undefined) + Number(explicitCwd) > 1)
		throw new Error("Choose only one scope: --cwd, --session, or --all.");
	const agentDir = getAgentDir();
	const paths = new Set<string>();
	if (session) paths.add(session);
	else {
		const directories = all
			? (await readdir(getSessionsDir(), { withFileTypes: true }))
					.filter((entry) => entry.isDirectory())
					.map((entry) => join(getSessionsDir(), entry.name))
			: getDefaultSessionDirCandidates(cwd, agentDir);
		for (const directory of directories) {
			const files = await readdir(directory).catch((error: unknown) => {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
				throw error;
			});
			for (const file of files) if (file.endsWith(".jsonl")) paths.add(join(directory, file));
		}
	}
	const results: Array<Record<string, unknown>> = [];
	let failures = 0;
	for (const path of [...paths].sort()) {
		try {
			const header = readSessionHeaderResult(path);
			if (!header.ok && header.reason === "not_a_header") {
				const entries = await reconcileAccountingFragment(path);
				const costs = aggregateCurrentSessionCostsFromEntries(entries);
				results.push({
					path,
					kind: "fragment",
					records: entries.length,
					recordedUsd: costs.reportedCost,
					apiEquivalentUsd: costs.currentCost,
					apiEquivalentPartial: costs.apiEquivalentPartial ?? false,
					modelUnknownTokens: costs.modelUnknownTokens ?? 0,
					modelUnknownOperations: costs.modelUnknownOperations ?? 0,
					models: computeSessionTaskAndModelMetrics({ entries }).models,
					diagnostics: [
						"Validated accounting rows without an execution-session header; no session or task identity assigned.",
					],
				});
				continue;
			}
			if (!header.ok) throw header.reason === "unreadable" ? header.cause : new Error("Invalid session identity.");
			await reconcileSessionAccounting(agentDir, path);
			const accounted = await readAccountedSession(path);
			if (!accounted) throw new Error("Accounting evidence changed after reconciliation; retry required.");
			const { projection, entries: recovered } = accounted;
			const after = aggregateCurrentSessionCostsFromEntries(recovered);
			const metrics = computeSessionTaskAndModelMetrics({ entries: recovered });
			results.push({
				path,
				kind: "session",
				sessionId: projection.sessionId,
				source: projection.source,
				groups: projection.groups.length,
				directEntries: projection.groups.reduce((sum, group) => sum + (group.directEntries?.length ?? 0), 0),
				recoveredResponses: projection.groups.reduce((sum, group) => sum + (group.components?.length ?? 0), 0),
				recoveredDirectEntries: projection.groups.reduce(
					(sum, group) => sum + (group.directEntries?.length ?? 0),
					0,
				),
				pendingReceipts: projection.groups.reduce((sum, group) => sum + (group.pendingReports?.length ?? 0), 0),
				recordedUsd: after.reportedCost,
				apiEquivalentUsd: after.currentCost,
				apiEquivalentPartial: after.apiEquivalentPartial ?? false,
				modelUnknownTokens: after.modelUnknownTokens ?? 0,
				modelUnknownOperations: after.modelUnknownOperations ?? 0,
				activeMs: metrics.tasks.reduce((sum, task) => sum + task.activeMs, 0),
				models: metrics.models,
				diagnostics: projection.groups.flatMap((group) => (group.diagnostic ? [group.diagnostic] : [])),
			});
		} catch (error) {
			failures++;
			results.push({ path, error: error instanceof Error ? error.message : String(error) });
		}
	}
	console.log(JSON.stringify({ sources: paths.size, reconciled: paths.size - failures, failures, results }, null, 2));
	if (failures > 0) process.exitCode = 1;
}
