/**
 * The SystemPromptBuilder wiring for the evidence-gated tool-selection hint block. Verifies the
 * block renders only when the (optional) `getToolSelectionHints` dep supplies active hints, and that
 * it obeys the same cache-stability invariant as the rest of the appended system prompt (see
 * `system-prompt-stability.test.ts`): unchanged inputs -> byte-identical output, and — the specific
 * risk for this dep — accumulating MORE evidence for the SAME winner must NOT change the text (only
 * an actual flip in the promoted tool may).
 */
import { describe, expect, it } from "vitest";
import type { Extension } from "../src/core/extensions/types.ts";
import type { MemoryManager } from "../src/core/memory/memory-manager.ts";
import { WORK_LIFECYCLE_PHASES, WORK_LIFECYCLE_SYSTEM_RULE } from "../src/core/provider-prompt-contracts.ts";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import type { SettingsManager } from "../src/core/settings-manager.ts";
import type { Skill } from "../src/core/skills.ts";
import { SystemPromptBuilder, type SystemPromptBuilderDeps } from "../src/core/system-prompt-builder.ts";
import type { ToolSelectionHint } from "../src/core/tool-selection/promotion.ts";

function makeDeps(overrides: Partial<SystemPromptBuilderDeps> = {}): SystemPromptBuilderDeps {
	const settingsManager = {
		getActiveProfileSoul: () => undefined,
		getSelfModificationSettings: () => ({ enabled: false }),
		getAutoLearnSettings: () => ({ enabled: false }),
		getAutonomySettings: () => ({ mode: "off" }),
		getWorkerDelegationSettings: () => ({ enabled: false }),
		getProjectContextFiles: () => "off",
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
		getModelCapabilityProfile: () => ({
			class: "full",
			reasonCode: "test",
			systemPromptMaxChars: undefined,
			backgroundLanesEnabled: true,
			laneMaxOutputTokens: 2_048,
		}),
		isChildSession: () => false,
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
	it("gives a constrained root the current-session reflection contract without background lanes", () => {
		const settingsManager = {
			...makeDeps().getSettingsManager(),
			getAutoLearnSettings: () => ({ enabled: true, reflectionReview: true }),
			getAutonomySettings: () => ({ mode: "balanced" }),
		} as SettingsManager;
		const prompt = new SystemPromptBuilder(
			makeDeps({
				getSettingsManager: () => settingsManager,
				getModelCapabilityProfile: () => ({
					class: "lean",
					contextWindow: 16_384,
					reasonCode: "test",
					systemPromptMaxChars: 8_192,
					backgroundLanesEnabled: false,
					laneMaxOutputTokens: 2_048,
				}),
			}),
		).rebuildSystemPrompt(["read"]);

		expect(prompt).toContain("ROOT REFLECTION");
		expect(prompt).toContain("current root provider turn");
		expect(prompt).not.toContain("background learner");
	});

	it("never gives a child session the root autonomy or reflection contract", () => {
		const settingsManager = {
			...makeDeps().getSettingsManager(),
			getAutoLearnSettings: () => ({ enabled: true, reflectionReview: true }),
			getAutonomySettings: () => ({ mode: "full" }),
		} as SettingsManager;
		const prompt = new SystemPromptBuilder(
			makeDeps({
				getSettingsManager: () => settingsManager,
				isChildSession: () => true,
			}),
		).rebuildSystemPrompt(["read"]);

		expect(prompt).not.toContain("PI AUTONOMY");
		expect(prompt).not.toContain("ROOT REFLECTION");
	});

	it("applies global-only project instruction isolation to root and worker prompts", () => {
		const root = new SystemPromptBuilder(makeDeps()).rebuildSystemPrompt(["read", "skill"]);
		expect(root).toContain("PI PROJECT INSTRUCTION ISOLATION");
		expect(root).toContain("Never discover, read, or apply project-local AGENTS-family files or skills");

		const child = new SystemPromptBuilder(makeDeps({ isChildSession: () => true })).rebuildSystemPrompt([
			"read",
			"skill",
		]);
		expect(child).toContain("PI PROJECT INSTRUCTION ISOLATION");

		const constrained = new SystemPromptBuilder(
			makeDeps({
				getModelCapabilityProfile: () => ({
					class: "chat",
					contextWindow: 4_096,
					reasonCode: "test",
					systemPromptMaxChars: 2_048,
					backgroundLanesEnabled: false,
					laneMaxOutputTokens: 1_024,
				}),
			}),
		).rebuildSystemPrompt(["read", "skill"]);
		expect(constrained).toContain("NO PROJECT INSTRUCTIONS.");
		expect(constrained).not.toContain("PI PROJECT INSTRUCTION ISOLATION");

		const enabledSettings = {
			...makeDeps().getSettingsManager(),
			getProjectContextFiles: () => "on-demand" as const,
		} as SettingsManager;
		const enabled = new SystemPromptBuilder(
			makeDeps({ getSettingsManager: () => enabledSettings }),
		).rebuildSystemPrompt(["read", "skill"]);
		expect(enabled).not.toContain("PI PROJECT INSTRUCTION ISOLATION");
	});

	it("renders the five-step root lifecycle and gates tool-specific ownership", () => {
		expect(WORK_LIFECYCLE_PHASES).toEqual(["Survey", "Contract", "Plan/Route", "Execute", "Prove/Deliver"]);
		expect(WORK_LIFECYCLE_PHASES).toHaveLength(5);
		expect(WORK_LIFECYCLE_SYSTEM_RULE).toContain(WORK_LIFECYCLE_PHASES.join(" → "));

		const root = new SystemPromptBuilder(makeDeps()).rebuildSystemPrompt(["goal", "task_steps", "delegate"]);
		expect(root).toContain("PI WORK LIFECYCLE");
		expect(root).toContain("Survey → Contract → Plan/Route → Execute → Prove/Deliver");
		expect(root).toContain("POC/MVP proves requested capability");
		expect(root).toContain("complete means full project integration");
		expect(root).toContain(
			"affected interfaces, callers, configuration, tests, documentation, compatibility/migration, and cleanup",
		);
		expect(root).toContain(
			"risk, uncertainty, urgency, reversibility, invariant sensitivity, test strength/cost, and cognitive load",
		);
		expect(root).toContain("Local commit follows green checks");
		expect(root).toContain("push/tag/release/publish stays owner-gated");
		expect(root).toContain("goal owns outcome/contract, task_steps owns plan, delegate owns workers");

		const splitGoalSurface = new SystemPromptBuilder(makeDeps()).rebuildSystemPrompt([
			"create_goal",
			"get_goal",
			"update_goal",
		]);
		expect(splitGoalSurface).toContain("PI WORK LIFECYCLE");
		const routine = new SystemPromptBuilder(makeDeps()).rebuildSystemPrompt(["read"]);
		expect(routine).toContain("PI WORK LIFECYCLE");
		expect(routine).toContain("Survey → Contract → Plan/Route → Execute → Prove/Deliver");
		expect(routine).not.toContain("goal owns outcome/contract");
		const child = new SystemPromptBuilder(makeDeps({ isChildSession: () => true })).rebuildSystemPrompt([
			"goal",
			"task_steps",
		]);
		expect(child).not.toContain("PI WORK LIFECYCLE");
	});

	it("makes optional connector availability subordinate to current-task relevance", () => {
		const trelloExtension = {
			path: "/missing/trello/index.ts",
			tools: new Map([["trello", {}]]),
			commands: new Map(),
		} as unknown as Extension;
		const builder = new SystemPromptBuilder(
			makeDeps({
				getActiveExtensions: () => [trelloExtension],
				getToolPromptSnippet: (name) => (name === "trello" ? "Project tracker" : undefined),
				getToolPromptGuidelines: (name) =>
					name === "trello" ? ["Project start/resume, MUST sweep every active list before work."] : undefined,
			}),
		);

		const prompt = builder.rebuildSystemPrompt(["trello"]);
		const connectorGuideline = prompt.indexOf("Project start/resume, MUST sweep");
		const applicabilityRule = prompt.indexOf("PI TOOL APPLICABILITY");

		expect(connectorGuideline).toBeGreaterThanOrEqual(0);
		expect(applicabilityRule).toBeGreaterThan(connectorGuideline);
		expect(prompt).toContain("active means available, not required");
		expect(prompt).toContain("Missing optional credentials never block unrelated work");
		expect(prompt).toContain("speculative secret_store use");
		expect(builder.buildSystemPromptForToolNames(["read"])).not.toContain("PI TOOL APPLICABILITY");
	});

	it("applies the same relevance gate to the built-in credential surface", () => {
		const prompt = new SystemPromptBuilder(
			makeDeps({
				getToolPromptSnippet: (name) => (name === "secret_store" ? "Credential activation" : undefined),
			}),
		).rebuildSystemPrompt(["secret_store"]);

		expect(prompt).toContain("PI TOOL APPLICABILITY");
		expect(prompt).toContain("optional credentials");
	});

	it("uses the compact relevance gate for a constrained profile", () => {
		const prompt = new SystemPromptBuilder(
			makeDeps({
				getToolPromptSnippet: (name) => (name === "secret_store" ? "Credential activation" : undefined),
				getModelCapabilityProfile: () => ({
					class: "lean",
					contextWindow: 16_384,
					reasonCode: "test",
					systemPromptMaxChars: 8_192,
					backgroundLanesEnabled: true,
					laneMaxOutputTokens: 2_048,
				}),
			}),
		).rebuildSystemPrompt(["secret_store"]);

		expect(prompt).toContain("availability is not a mandate");
		expect(prompt).toContain("Context or guidance alone is not a trigger");
		expect(prompt).not.toContain("wildcard profile");
	});

	it("bounds aggregate constrained guidance while retaining each tool's highest-priority rule", () => {
		const criticalRule = "AUTHORIZATION: preserve this late tool's highest-priority rule.";
		const duplicateRule = "Shared safety guidance appears once.";
		const builder = new SystemPromptBuilder(
			makeDeps({
				getToolPromptGuidelines: (name) =>
					name === "early"
						? [
								"EARLY PRIORITY: preserve the first rule.",
								duplicateRule,
								...Array.from(
									{ length: 64 },
									(_, index) => `early-low-priority-${index}: ${"bounded filler ".repeat(6)}`,
								),
							]
						: [criticalRule, duplicateRule],
				getModelCapabilityProfile: () => ({
					class: "lean",
					contextWindow: 16_384,
					reasonCode: "test",
					systemPromptMaxChars: 8_192,
					backgroundLanesEnabled: false,
					laneMaxOutputTokens: 2_048,
				}),
			}),
		);

		const prompt = builder.rebuildSystemPrompt(["early", "late"]);

		expect(prompt.length).toBeLessThanOrEqual(8_192);
		expect(prompt).toContain("EARLY PRIORITY");
		expect(prompt).toContain(criticalRule);
		expect(prompt.match(new RegExp(duplicateRule, "g"))).toHaveLength(1);
		expect(prompt).not.toContain("early-low-priority-63");
		expect(prompt).toContain("Ask before destructive actions");
		expect(prompt).toContain("explicit human approval required");
	});

	it.each(["lean", "minimal"] as const)(
		"teaches the world-cursor retry rule to the %s execution profile",
		(capabilityClass) => {
			const prompt = new SystemPromptBuilder(
				makeDeps({
					getModelCapabilityProfile: () => ({
						class: capabilityClass,
						contextWindow: 16_384,
						reasonCode: "test",
						systemPromptMaxChars: 8_192,
						backgroundLanesEnabled: true,
						laneMaxOutputTokens: 2_048,
					}),
				}),
			).rebuildSystemPrompt(["read"]);

			expect(prompt).toContain("Retry unchanged only after any other tool succeeds or a new user turn.");
			expect(prompt).not.toContain("never repeat unchanged failure");
			expect(prompt).not.toContain("never repeat the same call");
		},
	);

	it("keeps skill metadata host-side for extensions without rendering a catalog", () => {
		const skill = {
			name: "secret-skill",
			description: "secret-description",
			filePath: "/secret/SKILL.md",
			baseDir: "/secret",
			disableModelInvocation: false,
			sourceInfo: {},
		} as Skill;
		const resourceLoader = {
			...makeDeps().getResourceLoader(),
			getActiveSkills: () => [skill],
		} as ResourceLoader;
		const builder = new SystemPromptBuilder(makeDeps({ getResourceLoader: () => resourceLoader }));

		const prompt = builder.rebuildSystemPrompt(["read"]);

		expect(builder.getBaseSystemPromptOptions().skills).toEqual([skill]);
		expect(prompt).not.toContain("secret-skill");
		expect(prompt).not.toContain("/secret/SKILL.md");
	});

	it("renders no hint block when there are no active hints", () => {
		const builder = new SystemPromptBuilder(makeDeps({ getToolSelectionHints: () => [] }));
		const prompt = builder.rebuildSystemPrompt(["read"]);
		expect(prompt).not.toContain("EVIDENCE-GATED TOOL SHORTLIST");
	});

	it("behaves as no hints when the dep is not supplied at all (optional, decoupled wiring)", () => {
		// makeDeps() with no override never sets getToolSelectionHints — simulates a host (e.g.
		// agent-session.ts) that has not wired the dep in yet.
		const builder = new SystemPromptBuilder(makeDeps());
		expect(() => builder.rebuildSystemPrompt(["read"])).not.toThrow();
		expect(builder.rebuildSystemPrompt(["read"])).not.toContain("EVIDENCE-GATED TOOL SHORTLIST");
	});

	it("renders a compact block naming the promoted tool once a hint is active", () => {
		const builder = new SystemPromptBuilder(makeDeps({ getToolSelectionHints: () => [readHint] }));
		const prompt = builder.rebuildSystemPrompt(["read"]);
		expect(prompt).toContain("EVIDENCE-GATED TOOL SHORTLIST");
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
