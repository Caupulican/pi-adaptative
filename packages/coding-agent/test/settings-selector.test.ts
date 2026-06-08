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
		autonomy: { mode: "off" },
		autoLearn: {},
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
		onAutoLearnChange: vi.fn(),
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
		const selector = new SettingsSelectorComponent(makeConfig({ autonomy: { mode: "full" } }), makeCallbacks());

		selector.getSettingsList().handleInput("autonomy");
		const output = selector.render(140).join("\n");

		expect(output).toContain("Autonomy");
		expect(output).toContain("standing autonomy");
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
});
