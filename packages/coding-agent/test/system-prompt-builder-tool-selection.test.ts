/**
 * The SystemPromptBuilder wiring for the evidence-gated tool-selection hint block. Verifies the
 * block renders only when the (optional) `getToolSelectionHints` dep supplies active hints, and that
 * it obeys the same cache-stability invariant as the rest of the appended system prompt (see
 * `system-prompt-stability.test.ts`): unchanged inputs -> byte-identical output, and — the specific
 * risk for this dep — accumulating MORE evidence for the SAME winner must NOT change the text (only
 * an actual flip in the promoted tool may).
 */
import { describe, expect, it } from "vitest";
import type { MemoryManager } from "../src/core/memory/memory-manager.ts";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import type { SettingsManager } from "../src/core/settings-manager.ts";
import { SystemPromptBuilder, type SystemPromptBuilderDeps } from "../src/core/system-prompt-builder.ts";
import type { ToolSelectionHint } from "../src/core/tool-selection/promotion.ts";

function makeDeps(overrides: Partial<SystemPromptBuilderDeps> = {}): SystemPromptBuilderDeps {
	const settingsManager = {
		getActiveProfileSoul: () => undefined,
		getSelfModificationSettings: () => ({ enabled: false }),
		getAutoLearnSettings: () => ({ enabled: false }),
		getAutonomySettings: () => ({ mode: "off" }),
		getWorkerDelegationSettings: () => ({ enabled: false }),
	} as unknown as SettingsManager;
	const resourceLoader = {
		getSystemPrompt: () => undefined,
		getAppendSystemPrompt: () => [],
		getActiveSkills: () => [],
		getAgentsFiles: () => ({ agentsFiles: [] }),
	} as unknown as ResourceLoader;
	const memoryManager = {
		buildSystemPromptBlock: () => "",
	} as unknown as MemoryManager;

	return {
		getCwd: () => "/repo",
		getSettingsManager: () => settingsManager,
		getResourceLoader: () => resourceLoader,
		getMemoryManager: () => memoryManager,
		hasTool: () => true,
		getToolPromptSnippet: () => undefined,
		getToolPromptGuidelines: () => undefined,
		getModelAdaptationRules: () => [],
		getActiveExtensions: () => [],
		getContextWindow: () => undefined,
		getThinkingLevel: () => "medium",
		...overrides,
	};
}

const readHint: ToolSelectionHint = {
	modelRef: "faux/model",
	intentClass: "read",
	tool: "read_file",
	sampleCount: 3,
	margin: 0.5,
	entropy: 0,
};

describe("SystemPromptBuilder — evidence-gated tool-selection hint", () => {
	it("renders no hint block when there are no active hints", () => {
		const builder = new SystemPromptBuilder(makeDeps({ getToolSelectionHints: () => [] }));
		const prompt = builder.rebuildSystemPrompt(["read"]);
		expect(prompt).not.toContain("Learned tool preferences");
	});

	it("behaves as no hints when the dep is not supplied at all (optional, decoupled wiring)", () => {
		// makeDeps() with no override never sets getToolSelectionHints — simulates a host (e.g.
		// agent-session.ts) that has not wired the dep in yet.
		const builder = new SystemPromptBuilder(makeDeps());
		expect(() => builder.rebuildSystemPrompt(["read"])).not.toThrow();
		expect(builder.rebuildSystemPrompt(["read"])).not.toContain("Learned tool preferences");
	});

	it("renders a compact block naming the promoted tool once a hint is active", () => {
		const builder = new SystemPromptBuilder(makeDeps({ getToolSelectionHints: () => [readHint] }));
		const prompt = builder.rebuildSystemPrompt(["read"]);
		expect(prompt).toContain("Learned tool preferences");
		expect(prompt).toContain("read_file");
	});

	it("is byte-identical across two consecutive builds with an unchanged hint set (cache stability)", () => {
		const builder = new SystemPromptBuilder(makeDeps({ getToolSelectionHints: () => [readHint] }));
		const first = builder.rebuildSystemPrompt(["read"]);
		const second = builder.rebuildSystemPrompt(["read"]);
		expect(second).toBe(first);
	});

	it("does NOT change when the same tool accumulates more evidence — only a flip in the winner changes the text", () => {
		const early = new SystemPromptBuilder(
			makeDeps({ getToolSelectionHints: () => [{ ...readHint, sampleCount: 3, margin: 0.12, entropy: 0.4 }] }),
		).rebuildSystemPrompt(["read"]);
		const later = new SystemPromptBuilder(
			makeDeps({ getToolSelectionHints: () => [{ ...readHint, sampleCount: 5_000, margin: 0.95, entropy: 0.01 }] }),
		).rebuildSystemPrompt(["read"]);
		expect(later).toBe(early);
	});

	it("changes when the promoted tool for the intent actually flips", () => {
		const before = new SystemPromptBuilder(makeDeps({ getToolSelectionHints: () => [readHint] })).rebuildSystemPrompt(
			["read"],
		);
		const after = new SystemPromptBuilder(
			makeDeps({ getToolSelectionHints: () => [{ ...readHint, tool: "cat_file" }] }),
		).rebuildSystemPrompt(["read"]);
		expect(after).not.toBe(before);
	});
});
