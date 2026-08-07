import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

const boundaries = [
	{
		path: "packages/coding-agent/src/core/agent-session.ts",
		maxLines: 4_000,
		required: [
			'from "./agent-session-contracts.ts"',
			'from "./goals/goal-session-controller.ts"',
			'from "./human-input-controller.ts"',
		],
		forbidden: [
			"new GoalLoopController(",
			"appendGoalStateSnapshot(",
			"beginHumanInputRequest(",
			"export interface AgentSessionConfig",
			"function parseSkillBlock(",
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

if (failures.length > 0) {
	console.error("Coordinator boundary check failed:");
	for (const failure of failures) console.error(`- ${failure}`);
	process.exitCode = 1;
}
