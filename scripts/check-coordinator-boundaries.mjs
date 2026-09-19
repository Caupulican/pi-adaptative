import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(import.meta.dirname, "..");
// Owner-approved headroom until the next coordinator refactor. Responsibility guards still apply.
export const COORDINATOR_MAX_LINES = 8_000;

export const boundaries = [
	{
		path: "packages/coding-agent/src/core/agent-session.ts",
		required: [
			'from "./agent-session-contracts.ts"',
			'from "./goals/goal-session-controller.ts"',
			'from "./human-input-controller.ts"',
			'from "./extension-binding-controller.ts"',
		],
		forbidden: [
			"new GoalLoopController(",
			"appendGoalStateSnapshot(",
			"beginHumanInputRequest(",
			"export interface AgentSessionConfig",
			"function parseSkillBlock(",
			"private _bindExtensionCore(",
			"private _applyExtensionBindings(",
			"runner.bindCore(",
		],
	},
	{
		path: "packages/coding-agent/src/modes/interactive/interactive-mode.ts",
		required: [
			'from "./interactive-event-controller.ts"',
			'from "./loaded-resources-view.ts"',
			"handleInteractiveEvent(",
			"renderLoadedResources(",
		],
		forbidden: [
			"switch (event.type)",
			"createCompactionSummaryMessage(",
			"buildScopeGroups(",
			"formatDiagnostics(",
		],
	},
	{
		path: "packages/coding-agent/src/core/delegation/worker-attempt-executor.ts",
		// Durable callback, transcript, and checkpoint ordering remains here; reservation epochs and
		// provider-usage reconciliation must stay in the extracted protocol below this bounded ceiling.
		required: ['from "./worker-provider-turn-protocol.ts"'],
		forbidden: [
			"class WorkerCompletionProtocolError",
			"class WorkerProviderTurnProtocol",
			"class WorkerProviderReservationFence",
			"function positiveProviderUsageDelta(",
			"function recordSupplementalProviderUsage(",
		],
	},
	{
		path: "packages/coding-agent/src/core/delegation/worker-tree-budget-coordinator.ts",
		required: ['from "../orchestration/attempt-usage.ts"'],
		forbidden: ["const EMPTY_ATTEMPT_USAGE", "function gatewayUsage(", "function mergeUsage("],
	},
];

const GOAL_STATUS_SCAN_ROOT = resolve(root, "packages/coding-agent/src");
const GOAL_STATUS_EXCLUDED_DIR = resolve(root, "packages/coding-agent/src/core/goals");
const GOAL_STATUS_COMPARISON_RE = /((?:[A-Za-z_$][\w$]*)(?:\?\.[A-Za-z_$][\w$]*|\.[A-Za-z_$][\w$]*)*)\??\.status\s*(===|!==)\s*"active"/g;
const GOAL_STATUS_NON_GOAL_BASES = new Set([
	"modelpinpolicy",
]);

function listTsFiles(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		const full = resolve(dir, entry);
		const info = statSync(full);
		if (info.isDirectory()) {
			if (full === GOAL_STATUS_EXCLUDED_DIR) continue;
			if (entry === "test" || entry === "node_modules") continue;
			listTsFiles(full, out);
		} else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
			out.push(full);
		}
	}
	return out;
}

export function checkCoordinatorBoundaries(options = {}) {
	const baseRoot = options.root ?? root;
	const maxLines = options.maxLines ?? COORDINATOR_MAX_LINES;
	const boundaryList = options.boundaries ?? boundaries;
	const failures = [];

	for (const boundary of boundaryList) {
		const targetPath = resolve(baseRoot, boundary.path);
		const source = readFileSync(targetPath, "utf8");
		const lineCount = source.endsWith("\n") ? source.split(/\r?\n/).length - 1 : source.split(/\r?\n/).length;
		if (lineCount > maxLines) {
			failures.push(`${boundary.path}: ${lineCount} lines exceeds coordinator ceiling ${maxLines}`);
		}
		for (const marker of boundary.required ?? []) {
			if (!source.includes(marker)) failures.push(`${boundary.path}: missing extracted-owner marker ${JSON.stringify(marker)}`);
		}
		for (const marker of boundary.forbidden ?? []) {
			if (source.includes(marker)) failures.push(`${boundary.path}: reclaimed extracted responsibility ${JSON.stringify(marker)}`);
		}
	}

	if (!options.skipGoalStatusScan) {
		const scanRoot = options.scanRoot ?? resolve(baseRoot, "packages/coding-agent/src");
		try {
			for (const file of listTsFiles(scanRoot)) {
				const source = readFileSync(file, "utf8");
				if (!source.includes("GoalState")) continue;
				const lines = source.split(/\r?\n/);
				for (let i = 0; i < lines.length; i++) {
					for (const match of lines[i].matchAll(GOAL_STATUS_COMPARISON_RE)) {
						const base = match[1].split(/[^\w$]+/).filter(Boolean).pop() ?? "";
						if (GOAL_STATUS_NON_GOAL_BASES.has(base.toLowerCase())) continue;
						failures.push(
							`${relative(baseRoot, file)}:${i + 1}: inline goal-status-vs-"active" comparison outside core/goals/ — call isGoalExecutionActive() from core/goals/goal-state.ts instead (or add a traced, principled entry to GOAL_STATUS_NON_GOAL_BASES in this script if it is genuinely not GoalState)`,
						);
					}
				}
			}
		} catch {
			// Skip goal scan if directory does not exist in custom fixture
		}
	}

	return { failures };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { failures } = checkCoordinatorBoundaries();
	if (failures.length > 0) {
		console.error("Coordinator boundary check failed:");
		for (const failure of failures) console.error(`- ${failure}`);
		process.exitCode = 1;
	}
}
