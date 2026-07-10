import type { GoalState, Requirement } from "../goals/goal-state.ts";
import type { MemoryTierCandidate } from "./memory-tier-composer.ts";

export interface CurrentWorkMemoryInput {
	goalState?: GoalState;
	activePlanPath?: string;
	latestTopic?: string;
}

function shortText(text: string, maxChars: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function requirementSummary(requirements: readonly Requirement[]): string {
	const open = requirements
		.filter((requirement) => requirement.status === "open")
		.map((requirement) => requirement.text);
	const blocked = requirements
		.filter((requirement) => requirement.status === "blocked")
		.map((requirement) => requirement.text);
	const parts: string[] = [];
	if (open.length > 0)
		parts.push(
			`open: ${open
				.slice(0, 3)
				.map((text) => shortText(text, 64))
				.join("; ")}`,
		);
	if (blocked.length > 0)
		parts.push(
			`blocked: ${blocked
				.slice(0, 2)
				.map((text) => shortText(text, 64))
				.join("; ")}`,
		);
	return parts.join(" | ");
}

export function collectCurrentWorkMemory(input: CurrentWorkMemoryInput): MemoryTierCandidate[] {
	const candidates: MemoryTierCandidate[] = [];
	if (input.goalState?.status === "active") {
		const requirementText = requirementSummary(input.goalState.requirements);
		const goalSummary = shortText(input.goalState.userGoal, 96);
		const suffix = requirementText.length > 0 ? `; ${requirementText}` : "";
		candidates.push({
			id: `goal:${input.goalState.goalId}`,
			tier: "current_work",
			sourceLabel: "work:goal",
			summary: `${input.goalState.goalId} — ${goalSummary}${suffix}`,
			score: 1,
		});
	}

	if (input.activePlanPath !== undefined && input.activePlanPath.trim().length > 0) {
		candidates.push({
			id: `plan:${input.activePlanPath}`,
			tier: "current_work",
			sourceLabel: "work:plan",
			summary: shortText(input.activePlanPath, 120),
			score: 0.9,
		});
	}

	if (input.latestTopic !== undefined && input.latestTopic.trim().length > 0) {
		candidates.push({
			id: "topic:latest",
			tier: "current_work",
			sourceLabel: "work:topic",
			summary: shortText(input.latestTopic, 120),
			score: 0.8,
		});
	}

	return candidates;
}
