/**
 * Pins the system-prompt cache-stability invariant documented on `buildSystemPrompt`
 * (src/core/system-prompt.ts): the built prompt is treated by providers as ONE prompt-cache
 * block. The host (SystemPromptBuilder / AgentSession) only rebuilds it when the TOOL SURFACE
 * changes, never per turn — so for a fixed tool surface the output must be byte-identical across
 * consecutive calls, including across same-day wall-clock movement (the `date` field is
 * deliberately Y-M-D granularity, not a timestamp). A tool-surface change must produce a
 * different prompt (i.e. is actually observable, so a real rebuild is worth doing).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "../src/core/system-prompt.ts";

const baseOptions: BuildSystemPromptOptions = {
	selectedTools: ["read", "bash", "edit", "write"],
	toolSnippets: {
		read: "Read file contents",
		bash: "Execute bash commands",
		edit: "Make surgical edits",
		write: "Create or overwrite files",
	},
	promptGuidelines: ["Use dynamic_tool for project summaries."],
	appendSystemPrompt: "Extra project-specific guidance.",
	contextFiles: [{ path: "/repo/AGENTS.md", content: "Project instructions." }],
	skills: [
		{
			name: "example-skill",
			description: "An example skill",
			filePath: "/skills/example/SKILL.md",
			baseDir: "/skills/example",
			sourceInfo: createSyntheticSourceInfo("/skills/example/SKILL.md", { source: "test" }),
			disableModelInvocation: false,
		},
	],
	cwd: "/repo",
};

describe("system prompt cache-stability invariant", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("is byte-identical across two consecutive builds with an unchanged tool surface", () => {
		const first = buildSystemPrompt(baseOptions);
		const second = buildSystemPrompt(baseOptions);

		expect(second).toBe(first);
	});

	it("stays byte-identical as the wall clock moves within the same calendar day", () => {
		// If a future change widened `date` to include time-of-day (or any other per-turn-volatile
		// field leaked in), this would fail: the two builds below are hours apart on the same day.
		// Constructed via the local-time Date constructor (not an ISO `Z` string) so the two
		// timestamps land on the same calendar day in whatever timezone the test runs under —
		// `buildSystemPrompt` derives its date from getFullYear/getMonth/getDate, which are local.
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 6, 18, 0, 0, 1));
		const morning = buildSystemPrompt(baseOptions);

		vi.setSystemTime(new Date(2026, 6, 18, 23, 59, 59));
		const night = buildSystemPrompt(baseOptions);

		expect(night).toBe(morning);
	});

	it("is byte-identical across two consecutive builds on the custom-prompt path too", () => {
		const customOptions: BuildSystemPromptOptions = {
			...baseOptions,
			customPrompt: "You are a custom assistant.",
		};

		const first = buildSystemPrompt(customOptions);
		const second = buildSystemPrompt(customOptions);

		expect(second).toBe(first);
	});

	it("rebuilds to a different prompt when the tool surface changes", () => {
		const before = buildSystemPrompt(baseOptions);

		const changedSurface: BuildSystemPromptOptions = {
			...baseOptions,
			selectedTools: [...baseOptions.selectedTools!, "grep"],
			toolSnippets: {
				...baseOptions.toolSnippets,
				grep: "Search file contents",
			},
		};
		const after = buildSystemPrompt(changedSurface);

		expect(after).not.toBe(before);
		expect(after).toContain("- grep: Search file contents");
	});

	it("rebuilds to a different prompt when the tool surface shrinks", () => {
		const before = buildSystemPrompt(baseOptions);

		const changedSurface: BuildSystemPromptOptions = {
			...baseOptions,
			selectedTools: ["read"],
			toolSnippets: { read: baseOptions.toolSnippets!.read },
		};
		const after = buildSystemPrompt(changedSurface);

		expect(after).not.toBe(before);
		expect(after).not.toContain("- bash:");
	});
});
