import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

const boundaries = [
	{
		path: "packages/coding-agent/src/core/agent-session.ts",
		// Ratchet policy: this ceiling only ever moves DOWN, as a follow-on extraction shrinks the
		// file — never raised to silence an overage. Last ratcheted after the extension-binding
		// extraction (bindExtensions/bindExtensionCore/applyExtensionBindings/resource discovery
		// moved to extension-binding-controller.ts) landed the file at 3,849 lines; 3,900 is that
		// count plus ~50 lines of headroom, rounded up to a clean number.
		maxLines: 3_900,
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
		maxLines: 3_700,
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
		maxLines: 820,
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
		maxLines: 300,
		required: ['from "../orchestration/attempt-usage.ts"'],
		forbidden: ["const EMPTY_ATTEMPT_USAGE", "function gatewayUsage(", "function mergeUsage("],
	},
];

const failures = [];

for (const boundary of boundaries) {
	const source = readFileSync(resolve(root, boundary.path), "utf8");
	const lineCount = source.endsWith("\n") ? source.split(/\r?\n/).length - 1 : source.split(/\r?\n/).length;
	if (lineCount > boundary.maxLines) {
		failures.push(`${boundary.path}: ${lineCount} lines exceeds coordinator ceiling ${boundary.maxLines}`);
	}
	for (const marker of boundary.required) {
		if (!source.includes(marker)) failures.push(`${boundary.path}: missing extracted-owner marker ${JSON.stringify(marker)}`);
	}
	for (const marker of boundary.forbidden) {
		if (source.includes(marker)) failures.push(`${boundary.path}: reclaimed extracted responsibility ${JSON.stringify(marker)}`);
	}
}

// --- Goal-status predicate centralization ------------------------------------------------------
//
// `isGoalExecutionActive()` (packages/coding-agent/src/core/goals/goal-state.ts) is the ONE owner
// of "is this goal still executing" semantics. The same bug class — a foreground-waking pathway
// forgetting to check whether a goal is still active — shipped three releases in a row because
// that two-value predicate was hand-inlined (`state.status !== "active"` / `=== "active"`) at 13+
// call sites instead of being called. This rule fails the check when a NEW inline comparison of
// that shape reappears outside the owning `core/goals/` directory (where the type is defined and
// inlining it is the implementation, not a regression).
//
// Detection is text-pattern based, like every other rule in this file — there is no type checker
// here. To keep it at zero false positives it only looks inside files that already talk about goal
// state (contain the substring "GoalState", which covers both `import type { GoalState }` and the
// `getGoalStateSnapshot()`/`saveGoalStateSnapshot()`/`synchronizeGoalState()` family of accessors) —
// that is exactly the risk zone where this bug class has actually occurred. Within those files, a
// small documented allowlist covers the base identifiers that are known, by inspection, to carry an
// unrelated `.status` field of their own (not GoalState) despite living in a goal-state-aware file.
const GOAL_STATUS_SCAN_ROOT = resolve(root, "packages/coding-agent/src");
const GOAL_STATUS_EXCLUDED_DIR = resolve(root, "packages/coding-agent/src/core/goals");
const GOAL_STATUS_COMPARISON_RE = /((?:[A-Za-z_$][\w$]*)(?:\?\.[A-Za-z_$][\w$]*|\.[A-Za-z_$][\w$]*)*)\??\.status\s*(===|!==)\s*"active"/g;
// Base identifiers (last segment of the expression immediately before `.status`) that are known,
// by inspection of the current tree, to belong to a non-goal type even in a goal-state-aware file.
// Keep this list small and add an entry only after tracing the type and confirming it is genuinely
// not GoalState — see the coder's report for the trace behind each entry.
const GOAL_STATUS_NON_GOAL_BASES = new Set([
	// WorkerModelPinPolicy.status ("active" | ...), read alongside GoalState in the same file —
	// packages/coding-agent/src/core/delegation/worker-delegation-controller.ts.
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

for (const file of listTsFiles(GOAL_STATUS_SCAN_ROOT)) {
	const source = readFileSync(file, "utf8");
	if (!source.includes("GoalState")) continue;
	const lines = source.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		for (const match of lines[i].matchAll(GOAL_STATUS_COMPARISON_RE)) {
			const base = match[1].split(/[^\w$]+/).filter(Boolean).pop() ?? "";
			if (GOAL_STATUS_NON_GOAL_BASES.has(base.toLowerCase())) continue;
			failures.push(
				`${relative(root, file)}:${i + 1}: inline goal-status-vs-"active" comparison outside core/goals/ — call isGoalExecutionActive() from core/goals/goal-state.ts instead (or add a traced, principled entry to GOAL_STATUS_NON_GOAL_BASES in this script if it is genuinely not GoalState)`,
			);
		}
	}
}

if (failures.length > 0) {
	console.error("Coordinator boundary check failed:");
	for (const failure of failures) console.error(`- ${failure}`);
	process.exitCode = 1;
}
