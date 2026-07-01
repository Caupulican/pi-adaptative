import { setKeybindings } from "@caupulican/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function makeConfig(overrides: Partial<SettingsConfig> = {}): SettingsConfig {
	return {
		autoCompact: true,
		showImages: false,
		imageWidthCells: 60,
		autoResizeImages: true,
		blockImages: false,
		enableSkillCommands: true,
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		transport: "auto",
		httpIdleTimeoutMs: 300000,
		thinkingLevel: "medium",
		availableThinkingLevels: ["off", "medium", "high"],
		currentTheme: "dark",
		availableThemes: ["dark", "light"],
		hideThinkingBlock: false,
		collapseChangelog: false,
		enableInstallTelemetry: true,
		doubleEscapeAction: "tree",
		treeFilterMode: "default",
		showHardwareCursor: false,
		editorPaddingX: 0,
		autocompleteMaxVisible: 5,
		quietStartup: false,
		clearOnShrink: false,
		showTerminalProgress: false,
		warnings: {},
		selfModification: { enabled: false },
		autonomy: { mode: "off", maxStallTurns: 20 },
		researchLane: {},
		workerDelegation: {},
		modelRouter: {},
		autoLearn: {},
		contextPolicyEnforcement: {},
		contextMemoryRetrieval: {},
		currentModelPattern: "openai/gpt-5.4",
		autoLearnModelOptions: [
			{
				value: "anthropic/claude-opus-4-5",
				label: "anthropic/claude-opus-4-5",
				description: "Anthropic · subscription",
			},
			{
				value: "openai/gpt-5.4",
				label: "openai/gpt-5.4",
				description: "OpenAI · API key · current",
			},
		],
		...overrides,
	};
}

function makeCallbacks(overrides: Partial<SettingsCallbacks> = {}): SettingsCallbacks {
	return {
		onAutoCompactChange: vi.fn(),
		onShowImagesChange: vi.fn(),
		onImageWidthCellsChange: vi.fn(),
		onAutoResizeImagesChange: vi.fn(),
		onBlockImagesChange: vi.fn(),
		onEnableSkillCommandsChange: vi.fn(),
		onSteeringModeChange: vi.fn(),
		onFollowUpModeChange: vi.fn(),
		onTransportChange: vi.fn(),
		onHttpIdleTimeoutMsChange: vi.fn(),
		onThinkingLevelChange: vi.fn(),
		onThemeChange: vi.fn(),
		onHideThinkingBlockChange: vi.fn(),
		onCollapseChangelogChange: vi.fn(),
		onEnableInstallTelemetryChange: vi.fn(),
		onDoubleEscapeActionChange: vi.fn(),
		onTreeFilterModeChange: vi.fn(),
		onShowHardwareCursorChange: vi.fn(),
		onEditorPaddingXChange: vi.fn(),
		onAutocompleteMaxVisibleChange: vi.fn(),
		onQuietStartupChange: vi.fn(),
		onClearOnShrinkChange: vi.fn(),
		onShowTerminalProgressChange: vi.fn(),
		onWarningsChange: vi.fn(),
		onSelfModificationChange: vi.fn(),
		onAutonomyChange: vi.fn(),
		onResearchLaneChange: vi.fn(),
		onWorkerDelegationChange: vi.fn(),
		onModelRouterChange: vi.fn(),
		onAutoLearnChange: vi.fn(),
		onContextPolicyEnforcementChange: vi.fn(),
		onContextMemoryRetrievalChange: vi.fn(),
		onCancel: vi.fn(),
		...overrides,
	};
}

describe("settings selector", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("exposes self modification settings in the searchable settings TUI", () => {
		const selector = new SettingsSelectorComponent(
			makeConfig({ selfModification: { enabled: true, sourcePath: "/src/pi-adaptative" } }),
			makeCallbacks(),
		);

		selector.getSettingsList().handleInput("self");
		const output = selector.render(140).join("\n");

		expect(output).toContain("Self modification");
		expect(output).toContain("enabled");
	});

	it("exposes autonomy mode settings in the searchable settings TUI", () => {
		const selector = new SettingsSelectorComponent(
			makeConfig({ autonomy: { mode: "full", maxStallTurns: 20 } }),
			makeCallbacks(),
		);

		selector.getSettingsList().handleInput("autonomy");
		const output = selector.render(140).join("\n");

		expect(output).toContain("Autonomy");
		expect(output).toContain("standing autonomy");
		expect(output).toContain("20 turns, stall 20, auto on");
	});

	it("persists goal continue turns from the Autonomy submenu", () => {
		const onAutonomyChange = vi.fn();
		const selector = new SettingsSelectorComponent(
			makeConfig({ autonomy: { mode: "balanced", maxStallTurns: 20 } }),
			makeCallbacks({ onAutonomyChange }),
		);

		selector.getSettingsList().handleInput("autonomy");
		selector.getSettingsList().handleInput("\r");
		selector.getSettingsList().handleInput("\x1b[B");
		selector.getSettingsList().handleInput("\x1b[B");
		selector.getSettingsList().handleInput("\x1b[B"); // down arrow to reach goalContinueTurns
		selector.getSettingsList().handleInput("\r");

		expect(onAutonomyChange).toHaveBeenCalledWith(
			{
				mode: "balanced",
				maxStallTurns: 20,
				goalContinueTurns: 1, // 20 -> 1
				goalContinueMaxWallClockMinutes: 0,
				goalAutoContinue: true,
				goalAutoContinueDelayMs: 0,
			},
			"global",
		);
	});

	it("exposes Auto Learn model settings in the searchable settings TUI", () => {
		const selector = new SettingsSelectorComponent(
			makeConfig({ autoLearn: { enabled: true, model: "openai/gpt-5.4" } }),
			makeCallbacks(),
		);

		selector.getSettingsList().handleInput("auto");
		const output = selector.render(140).join("\n");

		expect(output).toContain("Auto Learn");
		expect(output).toContain("openai/gpt-5.4");
	});

	it("lists configured subscription and API models in Auto Learn model picker", () => {
		const selector = new SettingsSelectorComponent(
			makeConfig({ autoLearn: { enabled: true, model: "openai/gpt-5.4" } }),
			makeCallbacks(),
		);

		selector.getSettingsList().handleInput("learn");
		selector.getSettingsList().handleInput("\r");
		selector.getSettingsList().handleInput("\x1b[B");
		selector.getSettingsList().handleInput("\x1b[B");
		selector.getSettingsList().handleInput("\r");
		const output = selector.render(180).join("\n");

		expect(output).toContain("active");
		expect(output).toContain("anthropic/claude-opus-4-5");
		expect(output).toContain("subscription");
		expect(output).toContain("openai/gpt-5.4");
		expect(output).toContain("API key");
	});

	it("exposes Auto Learn reflection review settings", () => {
		const selector = new SettingsSelectorComponent(
			makeConfig({ autoLearn: { enabled: true, reflectionReview: true, reflectionMinToolCalls: 5 } }),
			makeCallbacks(),
		);

		selector.getSettingsList().handleInput("learn");
		selector.getSettingsList().handleInput("\r");
		const output = selector.render(180).join("\n");

		expect(output).toContain("Reflection review");
	});

	it("exposes context/prompt-policy enforcement settings in the searchable settings TUI", () => {
		const selector = new SettingsSelectorComponent(
			makeConfig({ contextPolicyEnforcement: { enabled: true, preserveRecentMessages: 8, minChars: 1200 } }),
			makeCallbacks(),
		);

		selector.getSettingsList().handleInput("prompt policy");
		const topLevelOutput = selector.render(180).join("\n");
		expect(topLevelOutput).toContain("Context / Prompt Policy");
		expect(topLevelOutput).toContain("enabled (preserve 8, min 1200 chars)");

		selector.getSettingsList().handleInput("\r");
		const output = selector.render(180).join("\n");

		expect(output).toContain("Prompt policy enforcement");
		expect(output).toContain("Preserve recent messages");
		expect(output).toContain("Minimum chars before stubbing");

		// The "artifact_retrieve must be active" note lives in the enabled item's
		// description, shown when that item is selected.
		selector.getSettingsList().handleInput("\x1b[B");
		const enabledItemOutput = selector.render(180).join("\n");
		expect(enabledItemOutput).toContain("artifact_retrieve");
	});

	it("shows disabled as the default summary when context/prompt-policy enforcement is not configured", () => {
		const selector = new SettingsSelectorComponent(makeConfig({ contextPolicyEnforcement: {} }), makeCallbacks());

		selector.getSettingsList().handleInput("prompt policy");
		const output = selector.render(180).join("\n");

		expect(output).toContain("disabled");
	});

	it("persists toggling context/prompt-policy enforcement on from its submenu", () => {
		const onContextPolicyEnforcementChange = vi.fn();
		const selector = new SettingsSelectorComponent(
			makeConfig({ contextPolicyEnforcement: { enabled: false, preserveRecentMessages: 8, minChars: 1200 } }),
			makeCallbacks({ onContextPolicyEnforcementChange }),
		);

		selector.getSettingsList().handleInput("prompt policy");
		selector.getSettingsList().handleInput("\r"); // open submenu
		selector.getSettingsList().handleInput("\x1b[B"); // down to "Prompt policy enforcement"
		selector.getSettingsList().handleInput("\r"); // cycle false -> true

		expect(onContextPolicyEnforcementChange).toHaveBeenCalledWith(
			{ enabled: true, preserveRecentMessages: 8, minChars: 1200 },
			"global",
		);
	});

	it("persists context/prompt-policy numeric settings only as one of the discrete safe values (no free-text entry)", () => {
		const onContextPolicyEnforcementChange = vi.fn();
		const selector = new SettingsSelectorComponent(
			makeConfig({ contextPolicyEnforcement: { enabled: true, preserveRecentMessages: 8, minChars: 1200 } }),
			makeCallbacks({ onContextPolicyEnforcementChange }),
		);

		selector.getSettingsList().handleInput("prompt policy");
		selector.getSettingsList().handleInput("\r"); // open submenu
		selector.getSettingsList().handleInput("\x1b[B"); // down to "Prompt policy enforcement"
		selector.getSettingsList().handleInput("\x1b[B"); // down to "Preserve recent messages"
		selector.getSettingsList().handleInput("\r"); // cycle 8 -> 16 (next in ["2","4","8","16","32"])

		expect(onContextPolicyEnforcementChange).toHaveBeenLastCalledWith(
			{ enabled: true, preserveRecentMessages: 16, minChars: 1200 },
			"global",
		);

		selector.getSettingsList().handleInput("\x1b[B"); // down to "Minimum chars before stubbing"
		selector.getSettingsList().handleInput("\r"); // cycle 1200 -> 2400 (next in ["300","600","1200","2400","4800"])

		expect(onContextPolicyEnforcementChange).toHaveBeenLastCalledWith(
			{ enabled: true, preserveRecentMessages: 16, minChars: 2400 },
			"global",
		);

		// Cycling can never land outside the documented discrete set -- there is no
		// free-text path for these numbers, so an invalid/out-of-range value can't be typed.
		for (const call of onContextPolicyEnforcementChange.mock.calls) {
			const [settings] = call;
			expect(["2", "4", "8", "16", "32"]).toContain(String(settings.preserveRecentMessages));
			expect(["300", "600", "1200", "2400", "4800"]).toContain(String(settings.minChars));
		}
	});

	it("does not expose retrievalToolAvailable as a configurable setting anywhere in the submenu", () => {
		const selector = new SettingsSelectorComponent(
			makeConfig({ contextPolicyEnforcement: { enabled: true, preserveRecentMessages: 8, minChars: 1200 } }),
			makeCallbacks(),
		);

		selector.getSettingsList().handleInput("prompt policy");
		selector.getSettingsList().handleInput("\r");
		const output = selector.render(180).join("\n");

		expect(output).not.toContain("retrievalToolAvailable");
		expect(output).not.toContain("retrieval tool available");
	});

	it("exposes context/memory-retrieval settings in the searchable settings TUI", () => {
		const selector = new SettingsSelectorComponent(
			makeConfig({ contextMemoryRetrieval: { enabled: true, maxResults: 5 } }),
			makeCallbacks(),
		);

		selector.getSettingsList().handleInput("memory retrieval");
		const topLevelOutput = selector.render(180).join("\n");
		expect(topLevelOutput).toContain("Context / Memory Retrieval");
		expect(topLevelOutput).toContain("enabled (max 5 results)");

		selector.getSettingsList().handleInput("\r");
		const output = selector.render(180).join("\n");

		expect(output).toContain("Local memory retrieval");
		expect(output).toContain("Max results");

		// The local-only / observe-only note lives in the enabled item's description.
		selector.getSettingsList().handleInput("\x1b[B");
		const enabledItemOutput = selector.render(180).join("\n");
		expect(enabledItemOutput).toContain("okf-memory");
		expect(enabledItemOutput).toContain("Local-only");
	});

	it("shows disabled as the default summary when context/memory-retrieval is not configured", () => {
		const selector = new SettingsSelectorComponent(makeConfig({ contextMemoryRetrieval: {} }), makeCallbacks());

		selector.getSettingsList().handleInput("memory retrieval");
		const output = selector.render(180).join("\n");

		expect(output).toContain("disabled");
	});

	it("persists toggling context/memory-retrieval on from its submenu", () => {
		const onContextMemoryRetrievalChange = vi.fn();
		const selector = new SettingsSelectorComponent(
			makeConfig({ contextMemoryRetrieval: { enabled: false, maxResults: 5 } }),
			makeCallbacks({ onContextMemoryRetrievalChange }),
		);

		selector.getSettingsList().handleInput("memory retrieval");
		selector.getSettingsList().handleInput("\r"); // open submenu
		selector.getSettingsList().handleInput("\x1b[B"); // down to "Local memory retrieval"
		selector.getSettingsList().handleInput("\r"); // cycle false -> true

		expect(onContextMemoryRetrievalChange).toHaveBeenCalledWith({ enabled: true, maxResults: 5 }, "global");
	});

	it("persists context/memory-retrieval maxResults only as one of the discrete safe values (no free-text entry)", () => {
		const onContextMemoryRetrievalChange = vi.fn();
		const selector = new SettingsSelectorComponent(
			makeConfig({ contextMemoryRetrieval: { enabled: true, maxResults: 5 } }),
			makeCallbacks({ onContextMemoryRetrievalChange }),
		);

		selector.getSettingsList().handleInput("memory retrieval");
		selector.getSettingsList().handleInput("\r"); // open submenu
		selector.getSettingsList().handleInput("\x1b[B"); // down to "Local memory retrieval"
		selector.getSettingsList().handleInput("\x1b[B"); // down to "Max results"
		selector.getSettingsList().handleInput("\r"); // cycle 5 -> 10 (next in ["1","3","5","10","20"])

		expect(onContextMemoryRetrievalChange).toHaveBeenLastCalledWith({ enabled: true, maxResults: 10 }, "global");

		// Every value ever offered by the cycling list is inside the settings-manager's
		// hard [1, 20] clamp range -- there is no way to reach an out-of-range value
		// through this menu.
		for (const call of onContextMemoryRetrievalChange.mock.calls) {
			const [settings] = call;
			expect(["1", "3", "5", "10", "20"]).toContain(String(settings.maxResults));
		}
	});

	it("does not expose any runtime-only field in the memory-retrieval submenu", () => {
		const selector = new SettingsSelectorComponent(
			makeConfig({ contextMemoryRetrieval: { enabled: true, maxResults: 5 } }),
			makeCallbacks(),
		);

		selector.getSettingsList().handleInput("memory retrieval");
		selector.getSettingsList().handleInput("\r");
		const output = selector.render(180).join("\n");

		expect(output).not.toContain("providerId");
		expect(output).not.toContain("rootDir");
	});

	it("exposes the Include in prompt toggle in the memory-retrieval submenu", () => {
		const selector = new SettingsSelectorComponent(
			makeConfig({ contextMemoryRetrieval: { enabled: true, maxResults: 5, includeInPrompt: true } }),
			makeCallbacks(),
		);

		selector.getSettingsList().handleInput("memory retrieval");
		const topLevelOutput = selector.render(180).join("\n");
		expect(topLevelOutput).toContain("enabled (max 5 results, in prompt)");

		selector.getSettingsList().handleInput("\r");
		const output = selector.render(180).join("\n");
		expect(output).toContain("Include in prompt");

		// The "requires retrieval enabled, never the transcript" note lives in this item's
		// description, shown when it's selected.
		selector.getSettingsList().handleInput("\x1b[B");
		selector.getSettingsList().handleInput("\x1b[B");
		selector.getSettingsList().handleInput("\x1b[B");
		const includeItemOutput = selector.render(180).join("\n");
		// The description may line-wrap in the rendered output, so check substrings that
		// survive wrapping rather than the exact phrase.
		expect(includeItemOutput).toContain("transcript");
		expect(includeItemOutput).toContain("untrusted-evidence");
	});

	it("persists toggling Include in prompt on from its submenu", () => {
		const onContextMemoryRetrievalChange = vi.fn();
		const selector = new SettingsSelectorComponent(
			makeConfig({ contextMemoryRetrieval: { enabled: true, maxResults: 5, includeInPrompt: false } }),
			makeCallbacks({ onContextMemoryRetrievalChange }),
		);

		selector.getSettingsList().handleInput("memory retrieval");
		selector.getSettingsList().handleInput("\r"); // open submenu
		selector.getSettingsList().handleInput("\x1b[B"); // down to "Local memory retrieval"
		selector.getSettingsList().handleInput("\x1b[B"); // down to "Max results"
		selector.getSettingsList().handleInput("\x1b[B"); // down to "Include in prompt"
		selector.getSettingsList().handleInput("\r"); // cycle false -> true

		expect(onContextMemoryRetrievalChange).toHaveBeenCalledWith(
			{ enabled: true, maxResults: 5, includeInPrompt: true },
			"global",
		);
	});

	it("exposes configurable model router settings together in the searchable settings TUI", () => {
		const selector = new SettingsSelectorComponent(
			makeConfig({
				modelRouter: {
					enabled: true,
					cheapModel: "anthropic/claude-haiku-4-5",
					mediumModel: "anthropic/claude-medium-4-5",
					expensiveModel: "anthropic/claude-sonnet-4-5",
					learningModel: "openai/gpt-5.4",
				},
			}),
			makeCallbacks(),
		);

		selector.getSettingsList().handleInput("model router");
		selector.getSettingsList().handleInput("\r");
		const output = selector.render(180).join("\n");

		expect(output).toContain("Model Router");
		expect(output).toContain("Enabled");
		expect(output).toContain("Cheap model");
		expect(output).toContain("Medium model");
		expect(output).toContain("Expensive model");
		expect(output).toContain("Learning/reflection model");
		expect(output).toContain("true");
		expect(output).toContain("anthropic/claude-haiku-4-5");
		expect(output).toContain("anthropic/claude-medium-4-5");
		expect(output).toContain("anthropic/claude-sonnet-4-5");
		expect(output).toContain("openai/gpt-5.4");
	});

	it("lists configured subscription and API models in the Model Router model pickers", () => {
		const selector = new SettingsSelectorComponent(
			makeConfig({
				modelRouter: {
					enabled: true,
					cheapModel: "anthropic/claude-opus-4-5",
					expensiveModel: "openai/gpt-5.4",
					learningModel: "active",
				},
			}),
			makeCallbacks(),
		);

		selector.getSettingsList().handleInput("model router");
		selector.getSettingsList().handleInput("\r");
		selector.getSettingsList().handleInput("\x1b[B");
		selector.getSettingsList().handleInput("\x1b[B");
		selector.getSettingsList().handleInput("\r");
		const output = selector.render(180).join("\n");

		expect(output).toContain("Cheap / Research Model");
		expect(output).toContain("anthropic/claude-opus-4-5");
		expect(output).toContain("subscription");
		expect(output).toContain("openai/gpt-5.4");
		expect(output).toContain("API key");
		expect(output).toContain("Manual / custom");
	});

	it("persists selected configured models from the Model Router picker", () => {
		const onModelRouterChange = vi.fn();
		const selector = new SettingsSelectorComponent(
			makeConfig({
				modelRouter: {
					enabled: true,
					expensiveModel: "openai/gpt-5.4",
					learningModel: "active",
				},
			}),
			makeCallbacks({ onModelRouterChange }),
		);

		selector.getSettingsList().handleInput("model router");
		selector.getSettingsList().handleInput("\r");
		selector.getSettingsList().handleInput("\x1b[B");
		selector.getSettingsList().handleInput("\x1b[B");
		selector.getSettingsList().handleInput("\r");
		selector.getSettingsList().handleInput("\x1b[B");
		selector.getSettingsList().handleInput("\r");

		expect(onModelRouterChange).toHaveBeenCalledWith(
			{
				enabled: true,
				cheapModel: "anthropic/claude-opus-4-5",
				expensiveModel: "openai/gpt-5.4",
				learningModel: "active",
			},
			"global",
		);
	});

	it("persists custom manual models from the Model Router picker fallback", () => {
		const onModelRouterChange = vi.fn();
		const selector = new SettingsSelectorComponent(
			makeConfig({
				modelRouter: {
					enabled: true,
					expensiveModel: "openai/gpt-5.4",
					learningModel: "active",
				},
			}),
			makeCallbacks({ onModelRouterChange }),
		);

		selector.getSettingsList().handleInput("model router");
		selector.getSettingsList().handleInput("\r");
		selector.getSettingsList().handleInput("\x1b[B");
		selector.getSettingsList().handleInput("\x1b[B");
		selector.getSettingsList().handleInput("\r");
		selector.getSettingsList().handleInput("\x1b[B");
		selector.getSettingsList().handleInput("\x1b[B");
		selector.getSettingsList().handleInput("\x1b[B");
		selector.getSettingsList().handleInput("\r");
		selector.getSettingsList().handleInput("custom/provider-model");
		selector.getSettingsList().handleInput("\r");

		expect(onModelRouterChange).toHaveBeenCalledWith(
			{
				enabled: true,
				cheapModel: "custom/provider-model",
				expensiveModel: "openai/gpt-5.4",
				learningModel: "active",
			},
			"global",
		);
	});

	it("clears cheap model from the Model Router picker", () => {
		const onModelRouterChange = vi.fn();
		const selector = new SettingsSelectorComponent(
			makeConfig({
				modelRouter: {
					enabled: true,
					cheapModel: "openai/gpt-5.4",
					expensiveModel: "openai/gpt-5.4",
					learningModel: "active",
				},
			}),
			makeCallbacks({ onModelRouterChange }),
		);

		selector.getSettingsList().handleInput("model router");
		selector.getSettingsList().handleInput("\r");
		selector.getSettingsList().handleInput("\x1b[B");
		selector.getSettingsList().handleInput("\x1b[B");
		selector.getSettingsList().handleInput("\r");
		selector.getSettingsList().handleInput("\x1b[A");
		selector.getSettingsList().handleInput("\x1b[A");
		selector.getSettingsList().handleInput("\r");

		expect(onModelRouterChange).toHaveBeenCalledWith(
			{
				enabled: true,
				cheapModel: undefined,
				expensiveModel: "openai/gpt-5.4",
				learningModel: "active",
			},
			"global",
		);
	});

	it("persists active for the Model Router learning model picker", () => {
		const onModelRouterChange = vi.fn();
		const selector = new SettingsSelectorComponent(
			makeConfig({
				modelRouter: {
					enabled: true,
					cheapModel: "openai/gpt-5.4",
					expensiveModel: "openai/gpt-5.4",
					learningModel: "anthropic/claude-opus-4-5",
				},
			}),
			makeCallbacks({ onModelRouterChange }),
		);

		selector.getSettingsList().handleInput("model router");
		selector.getSettingsList().handleInput("\r");
		selector.getSettingsList().handleInput("\x1b[B");
		selector.getSettingsList().handleInput("\x1b[B");
		selector.getSettingsList().handleInput("\x1b[B");
		selector.getSettingsList().handleInput("\x1b[B");
		selector.getSettingsList().handleInput("\x1b[B"); // One more Down arrow because of Medium model
		selector.getSettingsList().handleInput("\r");
		selector.getSettingsList().handleInput("\x1b[A");
		selector.getSettingsList().handleInput("\r");

		expect(onModelRouterChange).toHaveBeenCalledWith(
			{
				enabled: true,
				cheapModel: "openai/gpt-5.4",
				expensiveModel: "openai/gpt-5.4",
				learningModel: "active",
			},
			"global",
		);
	});

	it("persists selected configured model for the Medium model picker", () => {
		const onModelRouterChange = vi.fn();
		const selector = new SettingsSelectorComponent(
			makeConfig({
				modelRouter: {
					enabled: true,
					cheapModel: "anthropic/claude-opus-4-5",
					expensiveModel: "openai/gpt-5.4",
					learningModel: "active",
				},
			}),
			makeCallbacks({ onModelRouterChange }),
		);

		selector.getSettingsList().handleInput("model router");
		selector.getSettingsList().handleInput("\r");
		selector.getSettingsList().handleInput("\x1b[B");
		selector.getSettingsList().handleInput("\x1b[B");
		selector.getSettingsList().handleInput("\x1b[B"); // Select Medium model (index 3)
		selector.getSettingsList().handleInput("\r");
		selector.getSettingsList().handleInput("\x1b[B"); // Moves to "anthropic/claude-opus-4-5"
		selector.getSettingsList().handleInput("\x1b[B"); // Select the second available model ("openai/gpt-5.4")
		selector.getSettingsList().handleInput("\r");

		expect(onModelRouterChange).toHaveBeenCalledWith(
			{
				enabled: true,
				cheapModel: "anthropic/claude-opus-4-5",
				mediumModel: "openai/gpt-5.4",
				expensiveModel: "openai/gpt-5.4",
				learningModel: "active",
			},
			"global",
		);
	});

	it("clears medium model from the Model Router picker", () => {
		const onModelRouterChange = vi.fn();
		const selector = new SettingsSelectorComponent(
			makeConfig({
				modelRouter: {
					enabled: true,
					cheapModel: "openai/gpt-5.4",
					mediumModel: "openai/gpt-5.4",
					expensiveModel: "openai/gpt-5.4",
					learningModel: "active",
				},
			}),
			makeCallbacks({ onModelRouterChange }),
		);

		selector.getSettingsList().handleInput("model router");
		selector.getSettingsList().handleInput("\r");
		selector.getSettingsList().handleInput("\x1b[B");
		selector.getSettingsList().handleInput("\x1b[B");
		selector.getSettingsList().handleInput("\x1b[B"); // Select Medium model
		selector.getSettingsList().handleInput("\r");
		selector.getSettingsList().handleInput("\x1b[A"); // Clear option
		selector.getSettingsList().handleInput("\x1b[A");
		selector.getSettingsList().handleInput("\r");

		expect(onModelRouterChange).toHaveBeenCalledWith(
			{
				enabled: true,
				cheapModel: "openai/gpt-5.4",
				mediumModel: undefined,
				expensiveModel: "openai/gpt-5.4",
				learningModel: "active",
			},
			"global",
		);
	});

	it("persists model router changes from its submenu", () => {
		const onModelRouterChange = vi.fn();
		const selector = new SettingsSelectorComponent(
			makeConfig({
				modelRouter: {
					enabled: false,
					cheapModel: "anthropic/claude-haiku-4-5",
					expensiveModel: "anthropic/claude-sonnet-4-5",
					learningModel: "active",
				},
			}),
			makeCallbacks({ onModelRouterChange }),
		);

		selector.getSettingsList().handleInput("model router");
		selector.getSettingsList().handleInput("\r");
		selector.getSettingsList().handleInput("\x1b[B");
		selector.getSettingsList().handleInput("\r");

		expect(onModelRouterChange).toHaveBeenCalledWith(
			{
				enabled: true,
				cheapModel: "anthropic/claude-haiku-4-5",
				expensiveModel: "anthropic/claude-sonnet-4-5",
				learningModel: "active",
			},
			"global",
		);
	});

	it("cancels the Resources submenu with Escape and Ctrl+C", () => {
		for (const key of ["\x1b", "\x03"]) {
			const onCancel = vi.fn();
			const onResourcesHubAction = vi.fn();
			const selector = new SettingsSelectorComponent(
				makeConfig({
					activeProfileName: "reviewer",
					profileOptions: [{ value: "reviewer", label: "reviewer", description: "Reviewer situation" }],
					externalResourceRoots: ["/catalog/path1"],
					trustedResourceRoots: ["/catalog/path1"],
				}),
				makeCallbacks({ onCancel, onResourcesHubAction }),
			);

			selector.getSettingsList().handleInput("resources");
			selector.getSettingsList().handleInput("\r");
			selector.getSettingsList().handleInput(key);

			expect(onResourcesHubAction).not.toHaveBeenCalled();
			expect(onCancel).not.toHaveBeenCalled();
			expect(selector.render(140).join("\n")).toContain("Resources");
		}
	});
});
