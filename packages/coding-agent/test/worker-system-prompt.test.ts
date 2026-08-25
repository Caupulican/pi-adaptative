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

	it("injects final context files with deterministic source labels and deferred project paths", () => {
		const prompt = buildWorkerSystemPrompt({
			rolePrompt: "Inspect the focused source.",
			contextFiles: [
				{ path: "C:\\Users\\Cau\\.pi\\agent\\AGENTS.md", content: "global-rule\r\napply-it\rlone-cr" },
				{ path: "C:\\repo\\AGENTS.md" },
				{ path: "C:\\Users\\Cau\\.pi\\agent\\AGENTS.md", content: "global-rule\r\napply-it\rlone-cr" },
			],
			canReadContextFiles: true,
			modelCapability: { class: "full", systemPromptMaxChars: undefined },
		});

		expect(prompt).toContain("PROJECT-SPECIFIC INSTRUCTIONS (apply in listed order)");
		expect(prompt).toContain('FILE "C:\\\\Users\\\\Cau\\\\.pi\\\\agent\\\\AGENTS.md"');
		expect(prompt).toContain("global-rule\napply-it\nlone-cr");
		expect(prompt.match(/global-rule/g)).toHaveLength(1);
		expect(prompt).toContain("PROJECT RULE PATHS — contents not preloaded.");
		expect(prompt).toContain('- "C:\\\\repo\\\\AGENTS.md"');
		expect(prompt).not.toContain("\r");
	});

	it("preserves explicit worker override authority over context layers", () => {
		const prompt = buildWorkerSystemPrompt({
			rolePrompt: "Default worker role.",
			contextFiles: [{ path: "/agent/AGENTS.md", content: "global worker rule" }],
			override: "Owner replacement prompt.",
			modelCapability: { class: "full", systemPromptMaxChars: undefined },
		});

		expect(prompt).toContain("Owner replacement prompt.");
		expect(prompt).not.toContain("Default worker role.");
		expect(prompt).not.toContain("global worker rule");
	});

	it("fails closed when context exceeds the worker model prompt budget", () => {
		expect(() =>
			buildWorkerSystemPrompt({
				rolePrompt: "Focused role.",
				contextFiles: [{ path: "/agent/AGENTS.md", content: "x".repeat(4_096) }],
				modelCapability: { class: "minimal", systemPromptMaxChars: 512 },
			}),
		).toThrow("minimal system prompt exceeds its 512-character capability budget");
	});
});
