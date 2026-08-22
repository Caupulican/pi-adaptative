import { describe, expect, it } from "vitest";
import {
	buildWorkerSystemPrompt,
	formatWorkerModelGuidancePrompt,
	formatWorkerModelRef,
	type WorkerModelGuidance,
} from "../src/core/delegation/worker-system-prompt.ts";

describe("worker-system-prompt", () => {
	it("formats modelRef key correctly", () => {
		expect(formatWorkerModelRef("anthropic", "claude-3-5-sonnet-20241022")).toBe(
			"anthropic/claude-3-5-sonnet-20241022",
		);
	});

	it("formats guidance prompt blocks when rules and observations exist", () => {
		const guidance: WorkerModelGuidance = {
			rules: [
				{
					mode: "propertyCaseNormalize",
					text: "Argument property: exact schema name/case.",
					addedAt: "2026-08-01T00:00:00Z",
					lastFiredAt: "2026-08-01T00:00:00Z",
				},
			],
			toolProbeStatus: "native",
			toolProbeGrade: "task",
			protocolStatus: "calibrated",
			teachStats: {
				propertyCaseNormalize: { taught: 3, recurrenceBefore: 3, recurrenceAfter: 0 },
			},
		};

		const formatted = formatWorkerModelGuidancePrompt(guidance);
		expect(formatted).toContain("MODEL TOOL SHAPE RULES");
		expect(formatted).toContain("Argument property: exact schema name/case.");
		expect(formatted).toContain("MODEL TOOL-RECOVERY OBSERVATIONS");
		expect(formatted).toContain("Tool probe verdict: native (grade: task)");
		expect(formatted).toContain("Calibrated repair mode propertyCaseNormalize: taught=3");
	});

	it("returns undefined formatted prompt when guidance is empty", () => {
		const guidance: WorkerModelGuidance = {
			rules: [],
		};
		expect(formatWorkerModelGuidancePrompt(guidance)).toBeUndefined();
	});

	it("builds worker system prompt with level-0 subagent core header and situational role prompt", () => {
		const prompt = buildWorkerSystemPrompt({
			soul: "Expert Refactoring Specialist",
			rolePrompt: "Analyze dependency graphs.",
			workerResourceSystemPrompt: "Tool: edit.",
		});

		expect(prompt).toContain("Autonomous leaf worker");
		expect(prompt).toContain("Expert Refactoring Specialist");
		expect(prompt).toContain("Analyze dependency graphs.");
		expect(prompt).toContain("Tool: edit.");
	});
});
