import type { ThinkingLevel } from "@caupulican/pi-agent-core";
import type { Transport } from "@caupulican/pi-ai";
import {
	Container,
	getCapabilities,
	getKeybindings,
	Input,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
} from "@caupulican/pi-tui";
import { formatHttpIdleTimeoutMs, HTTP_IDLE_TIMEOUT_CHOICES } from "../../../core/http-dispatcher.ts";
import type {
	AutoLearnSettings,
	AutonomyMode,
	AutonomySettings,
	ContextPromptEnforcementSettings,
	MemoryRetrievalSettings,
	ModelRouterSettings,
	SelfModificationSettings,
	SettingsScope,
	WarningSettings,
} from "../../../core/settings-manager.ts";
import {
	DEFAULT_AUTONOMY_GOAL_AUTO_CONTINUE,
	DEFAULT_AUTONOMY_GOAL_AUTO_CONTINUE_DELAY_MS,
	DEFAULT_AUTONOMY_GOAL_CONTINUE_MAX_WALL_CLOCK_MINUTES,
	DEFAULT_AUTONOMY_GOAL_CONTINUE_TURNS,
	DEFAULT_AUTONOMY_MAX_STALL_TURNS,
} from "../../../core/settings-manager.ts";
import { getSelectListTheme, getSettingsListTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyDisplayText } from "./keybinding-hints.ts";

const SETTINGS_SUBMENU_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

const AUTO_LEARN_CUSTOM_MODEL_VALUE = "__custom_auto_learn_model__";
const MODEL_ROUTER_UNSET_MODEL_VALUE = "__unset_model_router_model__";

const THINKING_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning (~1k tokens)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Maximum reasoning (~32k tokens)",
};

const AUTONOMY_MODES: AutonomyMode[] = ["off", "safe", "balanced", "full"];
const AUTONOMY_GOAL_CONTINUE_TURN_VALUES = ["1", "3", "5", "10", "20"];
const AUTONOMY_MAX_STALL_TURN_VALUES = ["0", "5", "10", "20", "30", "50", "100"];
const AUTONOMY_GOAL_CONTINUE_MAX_WALL_CLOCK_MINUTE_VALUES = ["0", "15", "30", "60", "120", "240", "480", "1440"];
const AUTONOMY_GOAL_AUTO_CONTINUE_DELAY_MS_VALUES = ["0", "250", "1000", "5000", "30000", "60000"];

const CONTEXT_POLICY_PRESERVE_RECENT_MESSAGES_VALUES = ["2", "4", "8", "16", "32"];
const CONTEXT_POLICY_MIN_CHARS_VALUES = ["300", "600", "1200", "2400", "4800"];

const CONTEXT_POLICY_ENFORCEMENT_DEFAULTS = {
	enabled: false,
	preserveRecentMessages: 8,
	minChars: 1200,
} as const;

const CONTEXT_MEMORY_RETRIEVAL_MAX_RESULTS_VALUES = ["1", "3", "5", "10", "20"];

const CONTEXT_MEMORY_RETRIEVAL_DEFAULTS = {
	enabled: false,
	maxResults: 5,
} as const;

const AUTO_LEARN_DEFAULTS = {
	model: "active",
	longSessionMessages: 32,
	longSessionContextPercent: 70,
	cooldownMinutes: 120,
	leaseMinutes: 90,
	maxConcurrentLearners: 2,
	applyHighConfidence: false,
	reflectionReview: true,
	reflectionMinToolCalls: 5,
	reflectionCooldownMinutes: 60,
} as const;

function booleanSettingValue(value: boolean | undefined, defaultValue = false): string {
	return (value ?? defaultValue) ? "true" : "false";
}

function optionalStringValue(value: string | undefined, fallback = "(not set)"): string {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function normalizeOptionalString(value: string): string | undefined {
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function numberSettingValue(value: number | undefined, defaultValue: number): string {
	return String(value ?? defaultValue);
}

function autoLearnModelValue(settings: AutoLearnSettings): string {
	return optionalStringValue(settings.model, AUTO_LEARN_DEFAULTS.model);
}

function selfModificationSummary(settings: SelfModificationSettings): string {
	if (!(settings.enabled ?? false)) return "disabled";
	const hasPath =
		Boolean(settings.sourcePath?.trim()) ||
		(Array.isArray(settings.sourcePaths) && settings.sourcePaths.some((candidate) => Boolean(candidate?.trim())));
	return hasPath ? "enabled" : "enabled (missing path)";
}

function autonomyModeValue(settings: AutonomySettings): AutonomyMode {
	return settings.mode && AUTONOMY_MODES.includes(settings.mode) ? settings.mode : "off";
}

function autonomySummary(settings: AutonomySettings): string {
	const mode = autonomyModeValue(settings);
	const turns = settings.goalContinueTurns ?? DEFAULT_AUTONOMY_GOAL_CONTINUE_TURNS;
	const stall = settings.maxStallTurns ?? DEFAULT_AUTONOMY_MAX_STALL_TURNS;
	const autoContinue = settings.goalAutoContinue ?? DEFAULT_AUTONOMY_GOAL_AUTO_CONTINUE;
	const modeLabel = mode === "full" ? "standing autonomy" : mode;
	return `${modeLabel}, ${turns} turns, stall ${stall}, auto ${autoContinue ? "on" : "off"}`;
}

function autonomyGoalContinueTurnsValue(settings: AutonomySettings): string {
	return String(settings.goalContinueTurns ?? DEFAULT_AUTONOMY_GOAL_CONTINUE_TURNS);
}

function autonomyMaxStallTurnsValue(settings: AutonomySettings): string {
	return String(settings.maxStallTurns ?? DEFAULT_AUTONOMY_MAX_STALL_TURNS);
}

function autonomyGoalContinueMaxWallClockMinutesValue(settings: AutonomySettings): string {
	return String(settings.goalContinueMaxWallClockMinutes ?? DEFAULT_AUTONOMY_GOAL_CONTINUE_MAX_WALL_CLOCK_MINUTES);
}

function autonomyGoalAutoContinueValue(settings: AutonomySettings): string {
	return String(settings.goalAutoContinue ?? DEFAULT_AUTONOMY_GOAL_AUTO_CONTINUE);
}

function autonomyGoalAutoContinueDelayMsValue(settings: AutonomySettings): string {
	return String(settings.goalAutoContinueDelayMs ?? DEFAULT_AUTONOMY_GOAL_AUTO_CONTINUE_DELAY_MS);
}

function autoLearnSummary(settings: AutoLearnSettings): string {
	return settings.enabled ? `enabled (${autoLearnModelValue(settings)})` : "disabled";
}

function contextPolicyEnforcementSummary(settings: ContextPromptEnforcementSettings): string {
	if (!(settings.enabled ?? CONTEXT_POLICY_ENFORCEMENT_DEFAULTS.enabled)) return "disabled";
	const preserve = settings.preserveRecentMessages ?? CONTEXT_POLICY_ENFORCEMENT_DEFAULTS.preserveRecentMessages;
	const minChars = settings.minChars ?? CONTEXT_POLICY_ENFORCEMENT_DEFAULTS.minChars;
	return `enabled (preserve ${preserve}, min ${minChars} chars)`;
}

function contextMemoryRetrievalSummary(settings: MemoryRetrievalSettings): string {
	if (!(settings.enabled ?? CONTEXT_MEMORY_RETRIEVAL_DEFAULTS.enabled)) return "disabled";
	const maxResults = settings.maxResults ?? CONTEXT_MEMORY_RETRIEVAL_DEFAULTS.maxResults;
	return `enabled (max ${maxResults} results)`;
}

function modelRouterSummary(settings: ModelRouterSettings): string {
	const state = settings.enabled ? "enabled" : "disabled";
	return `${state} · cheap: ${optionalStringValue(settings.cheapModel)} · medium: ${optionalStringValue(settings.mediumModel)} · expensive: ${optionalStringValue(settings.expensiveModel)} · learn: ${optionalStringValue(settings.learningModel, "active")}`;
}

function buildAutoLearnModelOptions(
	settings: AutoLearnSettings,
	configuredModelOptions: SelectItem[] | undefined,
	currentModelPattern: string | undefined,
): SelectItem[] {
	const currentValue = autoLearnModelValue(settings);
	const options: SelectItem[] = [
		{
			value: AUTO_LEARN_DEFAULTS.model,
			label: "active",
			description: currentModelPattern
				? `Use the current session model (${currentModelPattern})`
				: "Use the current session model",
		},
	];
	const seen = new Set(options.map((option) => option.value));

	for (const option of configuredModelOptions ?? []) {
		if (seen.has(option.value)) continue;
		options.push(option);
		seen.add(option.value);
	}

	if (currentValue !== AUTO_LEARN_DEFAULTS.model && !seen.has(currentValue)) {
		options.push({
			value: currentValue,
			label: currentValue,
			description: "Current custom setting",
		});
		seen.add(currentValue);
	}

	options.push({
		value: AUTO_LEARN_CUSTOM_MODEL_VALUE,
		label: "Manual / custom…",
		description: "Type a model pattern not listed above",
	});

	return options;
}

function buildModelRouterRoleModelOptions(options: {
	currentValue: string | undefined;
	configuredModelOptions: SelectItem[] | undefined;
	currentModelPattern: string | undefined;
	includeActive: boolean;
	unsetDescription?: string;
}): SelectItem[] {
	const modelOptions: SelectItem[] = [];
	const seen = new Set<string>();

	if (options.includeActive) {
		modelOptions.push({
			value: AUTO_LEARN_DEFAULTS.model,
			label: "active",
			description: options.currentModelPattern
				? `Use the current session model (${options.currentModelPattern})`
				: "Use the current session model",
		});
		seen.add(AUTO_LEARN_DEFAULTS.model);
	} else {
		modelOptions.push({
			value: MODEL_ROUTER_UNSET_MODEL_VALUE,
			label: "(unset)",
			description: options.unsetDescription ?? "Clear this model setting",
		});
		seen.add(MODEL_ROUTER_UNSET_MODEL_VALUE);
	}

	for (const option of options.configuredModelOptions ?? []) {
		if (seen.has(option.value)) continue;
		modelOptions.push(option);
		seen.add(option.value);
	}

	const currentValue = options.currentValue?.trim();
	if (currentValue && !seen.has(currentValue)) {
		modelOptions.push({
			value: currentValue,
			label: currentValue,
			description: "Current custom setting",
		});
		seen.add(currentValue);
	}

	modelOptions.push({
		value: AUTO_LEARN_CUSTOM_MODEL_VALUE,
		label: "Manual / custom…",
		description: "Type a model pattern not listed above",
	});

	return modelOptions;
}

export interface SettingsConfig {
	autoCompact: boolean;
	showImages: boolean;
	imageWidthCells: number;
	autoResizeImages: boolean;
	blockImages: boolean;
	enableSkillCommands: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	transport: Transport;
	httpIdleTimeoutMs: number;
	thinkingLevel: ThinkingLevel;
	availableThinkingLevels: ThinkingLevel[];
	currentTheme: string;
	availableThemes: string[];
	hideThinkingBlock: boolean;
	collapseChangelog: boolean;
	enableInstallTelemetry: boolean;
	doubleEscapeAction: "fork" | "tree" | "none";
	treeFilterMode: "default" | "no-tools" | "user-only" | "labeled-only" | "all";
	showHardwareCursor: boolean;
	editorPaddingX: number;
	autocompleteMaxVisible: number;
	quietStartup: boolean;
	clearOnShrink: boolean;
	showTerminalProgress: boolean;
	warnings: WarningSettings;
	selfModification: {
		enabled: boolean;
		sourcePath?: string;
		sourcePaths?: string[];
	};
	selfModificationScope?: SettingsScope;
	autonomy: AutonomySettings;
	autonomyScope?: SettingsScope;
	modelRouter: ModelRouterSettings;
	modelRouterScope?: SettingsScope;
	autoLearn: AutoLearnSettings;
	autoLearnScope?: SettingsScope;
	contextPolicyEnforcement: ContextPromptEnforcementSettings;
	contextPolicyEnforcementScope?: SettingsScope;
	contextMemoryRetrieval: MemoryRetrievalSettings;
	contextMemoryRetrievalScope?: SettingsScope;
	currentModelPattern?: string;
	autoLearnModelOptions?: SelectItem[];
	activeProfileName?: string;
	profileOptions?: SelectItem[];
	externalResourceRoots?: string[];
	trustedResourceRoots?: string[];
}

export interface SettingsCallbacks {
	onAutoCompactChange: (enabled: boolean) => void;
	onShowImagesChange: (enabled: boolean) => void;
	onImageWidthCellsChange: (width: number) => void;
	onAutoResizeImagesChange: (enabled: boolean) => void;
	onBlockImagesChange: (blocked: boolean) => void;
	onEnableSkillCommandsChange: (enabled: boolean) => void;
	onSteeringModeChange: (mode: "all" | "one-at-a-time") => void;
	onFollowUpModeChange: (mode: "all" | "one-at-a-time") => void;
	onTransportChange: (transport: Transport) => void;
	onHttpIdleTimeoutMsChange: (timeoutMs: number) => void;
	onThinkingLevelChange: (level: ThinkingLevel) => void;
	onThemeChange: (theme: string) => void;
	onThemePreview?: (theme: string) => void;
	onHideThinkingBlockChange: (hidden: boolean) => void;
	onCollapseChangelogChange: (collapsed: boolean) => void;
	onEnableInstallTelemetryChange: (enabled: boolean) => void;
	onDoubleEscapeActionChange: (action: "fork" | "tree" | "none") => void;
	onTreeFilterModeChange: (mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all") => void;
	onShowHardwareCursorChange: (enabled: boolean) => void;
	onEditorPaddingXChange: (padding: number) => void;
	onAutocompleteMaxVisibleChange: (maxVisible: number) => void;
	onQuietStartupChange: (enabled: boolean) => void;
	onClearOnShrinkChange: (enabled: boolean) => void;
	onShowTerminalProgressChange: (enabled: boolean) => void;
	onWarningsChange: (warnings: WarningSettings) => void;
	onSelfModificationChange: (settings: SelfModificationSettings, scope: SettingsScope) => void;
	onAutonomyChange: (settings: AutonomySettings, scope: SettingsScope) => void;
	onModelRouterChange: (settings: ModelRouterSettings, scope: SettingsScope) => void;
	onAutoLearnChange: (settings: AutoLearnSettings, scope: SettingsScope) => void;
	onContextPolicyEnforcementChange: (settings: ContextPromptEnforcementSettings, scope: SettingsScope) => void;
	onContextMemoryRetrievalChange: (settings: MemoryRetrievalSettings, scope: SettingsScope) => void;
	onResourcesHubAction?: (action: string) => void;
	onCancel: () => void;
}

class TextInputSubmenu extends Container {
	private input: Input;

	constructor(
		title: string,
		description: string,
		currentValue: string,
		onSubmit: (value: string) => void,
		onCancel: () => void,
		emptyHint = "empty clears the setting",
	) {
		super();

		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}
		this.addChild(new Spacer(1));

		this.input = new Input();
		this.input.setValue(currentValue);
		this.input.focused = true;
		this.input.onSubmit = onSubmit;
		this.input.onEscape = onCancel;
		this.addChild(this.input);

		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", `  Enter to save · Esc to go back · ${emptyHint}`), 0, 0));
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}
}

class ModelSelectionSubmenu extends Container {
	private searchInput: Input;
	private selectList: SelectList;
	private customInput: TextInputSubmenu | null = null;

	constructor(
		options: SelectItem[],
		currentValue: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
		labels: {
			title: string;
			description: string;
			customTitle: string;
			customDescription: string;
			customEmptyHint: string;
			customEmptyValue: string | undefined;
		} = {
			title: "Auto Learn Scavenger Model",
			description:
				"Choose active or a model from currently configured subscription/API accounts. Type to filter; choose manual for a custom pattern.",
			customTitle: "Custom Auto Learn Model",
			customDescription: 'Enter "active" or a provider/model pattern like "openai/gpt-5.4".',
			customEmptyHint: 'empty uses "active"',
			customEmptyValue: AUTO_LEARN_DEFAULTS.model,
		},
	) {
		super();

		this.addChild(new Text(theme.bold(theme.fg("accent", labels.title)), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", labels.description), 0, 0));
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		this.searchInput.focused = true;
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		this.selectList = new SelectList(
			options,
			Math.min(options.length, 10),
			getSelectListTheme(),
			SETTINGS_SUBMENU_SELECT_LIST_LAYOUT,
		);

		const currentIndex = options.findIndex((option) => option.value === currentValue);
		if (currentIndex !== -1) {
			this.selectList.setSelectedIndex(currentIndex);
		}

		this.selectList.onSelect = (item) => {
			if (item.value === AUTO_LEARN_CUSTOM_MODEL_VALUE) {
				this.customInput = new TextInputSubmenu(
					labels.customTitle,
					labels.customDescription,
					currentValue === labels.customEmptyValue ? "" : currentValue,
					(value) => {
						onSelect(normalizeOptionalString(value) ?? labels.customEmptyValue ?? "");
					},
					() => {
						this.customInput = null;
					},
					labels.customEmptyHint,
				);
				return;
			}
			onSelect(item.value);
		};
		this.selectList.onCancel = onCancel;
		this.addChild(this.selectList);

		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Type to filter · Enter to select · Esc to go back"), 0, 0));
	}

	handleInput(data: string): void {
		if (this.customInput) {
			this.customInput.handleInput(data);
			return;
		}

		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
			this.selectList.handleInput(data);
			return;
		}
		if (kb.matches(data, "tui.select.confirm") || kb.matches(data, "tui.select.cancel")) {
			this.selectList.handleInput(data);
			return;
		}

		this.searchInput.handleInput(data);
		this.selectList.setFilter(this.searchInput.getValue());
	}

	render(width: number): string[] {
		return this.customInput ? this.customInput.render(width) : super.render(width);
	}

	invalidate(): void {
		super.invalidate();
		this.customInput?.invalidate?.();
	}
}

class SelfModificationSettingsSubmenu extends Container {
	private settingsList: SettingsList;
	private state: SelfModificationSettings;
	private scope: SettingsScope;

	constructor(
		settings: SelfModificationSettings,
		onChange: (settings: SelfModificationSettings, scope: SettingsScope) => void,
		onCancel: () => void,
		scope: SettingsScope = "global",
	) {
		super();

		this.state = { ...settings, enabled: settings.enabled ?? false };
		this.scope = scope;

		const items: SettingItem[] = [
			{
				id: "self-modification-scope",
				label: "Save scope",
				description:
					"Save this self-modification configuration globally or in the current project's .pi/settings.json",
				currentValue: this.scope,
				values: ["global", "project"],
			},
			{
				id: "self-modification-enabled",
				label: "Enabled",
				description: "Allow agents to modify Pi's own source/harness only when explicitly tasked",
				currentValue: booleanSettingValue(this.state.enabled),
				values: ["true", "false"],
			},
			{
				id: "self-modification-source-path",
				label: "Source path",
				description: "Path to the pi-adaptative source checkout agents may edit for self-evolution",
				currentValue: optionalStringValue(this.state.sourcePath),
				submenu: (_currentValue, done) =>
					new TextInputSubmenu(
						"Pi-adaptative Source Path",
						"Set the source checkout path used by self-evolution guardrails. Empty clears it.",
						this.state.sourcePath ?? "",
						(value) => {
							const sourcePath = normalizeOptionalString(value);
							this.state = { ...this.state, sourcePath };
							onChange({ ...this.state }, this.scope);
							done(optionalStringValue(sourcePath));
						},
						() => done(),
					),
			},
		];

		this.settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "self-modification-scope":
						this.scope = newValue as SettingsScope;
						onChange({ ...this.state }, this.scope);
						break;
					case "self-modification-enabled":
						this.state = { ...this.state, enabled: newValue === "true" };
						onChange({ ...this.state }, this.scope);
						break;
				}
			},
			onCancel,
		);

		this.addChild(this.settingsList);
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

class AutonomySettingsSubmenu extends Container {
	private settingsList: SettingsList;
	private state: AutonomySettings;
	private scope: SettingsScope;

	constructor(
		settings: AutonomySettings,
		onChange: (settings: AutonomySettings, scope: SettingsScope) => void,
		onCancel: () => void,
		scope: SettingsScope = "global",
	) {
		super();
		this.state = {
			mode: autonomyModeValue(settings),
			maxStallTurns: settings.maxStallTurns ?? DEFAULT_AUTONOMY_MAX_STALL_TURNS,
			goalContinueTurns: settings.goalContinueTurns ?? DEFAULT_AUTONOMY_GOAL_CONTINUE_TURNS,
			goalContinueMaxWallClockMinutes:
				settings.goalContinueMaxWallClockMinutes ?? DEFAULT_AUTONOMY_GOAL_CONTINUE_MAX_WALL_CLOCK_MINUTES,
			goalAutoContinue: settings.goalAutoContinue ?? DEFAULT_AUTONOMY_GOAL_AUTO_CONTINUE,
			goalAutoContinueDelayMs: settings.goalAutoContinueDelayMs ?? DEFAULT_AUTONOMY_GOAL_AUTO_CONTINUE_DELAY_MS,
		};
		this.scope = scope;

		const items: SettingItem[] = [
			{
				id: "autonomy-scope",
				label: "Save scope",
				description: "Save this autonomy preset globally or in the current project's .pi/settings.json",
				currentValue: this.scope,
				values: ["global", "project"],
			},
			{
				id: "autonomy-mode",
				label: "Mode",
				description: "One preset for background learning: off, safe, balanced, or standing autonomy",
				currentValue: autonomyModeValue(this.state),
				values: AUTONOMY_MODES,
			},
			{
				id: "autonomy-goal-auto-continue",
				label: "Goal auto-continue",
				description: "Inject bounded continuation prompts when Pi becomes idle with an active open goal",
				currentValue: autonomyGoalAutoContinueValue(this.state),
				values: ["true", "false"],
			},
			{
				id: "autonomy-goal-continue-turns",
				label: "Goal turns",
				description: "Maximum continuation prompts in one idle or explicit goal loop",
				currentValue: autonomyGoalContinueTurnsValue(this.state),
				values: AUTONOMY_GOAL_CONTINUE_TURN_VALUES,
			},
			{
				id: "autonomy-max-stall-turns",
				label: "Goal stall limit",
				description: "Maximum no-progress rounds before Pi stops continuing and asks the user",
				currentValue: autonomyMaxStallTurnsValue(this.state),
				values: AUTONOMY_MAX_STALL_TURN_VALUES,
			},
			{
				id: "autonomy-goal-wall-clock-minutes",
				label: "Goal max minutes",
				description: "Wall-clock budget per goal continuation loop; 0 disables the time budget",
				currentValue: autonomyGoalContinueMaxWallClockMinutesValue(this.state),
				values: AUTONOMY_GOAL_CONTINUE_MAX_WALL_CLOCK_MINUTE_VALUES,
			},
			{
				id: "autonomy-goal-auto-continue-delay-ms",
				label: "Goal delay ms",
				description: "Delay before idle auto-continuation starts; 0 starts immediately after idle",
				currentValue: autonomyGoalAutoContinueDelayMsValue(this.state),
				values: AUTONOMY_GOAL_AUTO_CONTINUE_DELAY_MS_VALUES,
			},
		];

		this.settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "autonomy-scope":
						this.scope = newValue as SettingsScope;
						break;
					case "autonomy-mode":
						this.state = { ...this.state, mode: newValue as AutonomyMode };
						break;
					case "autonomy-goal-auto-continue":
						this.state = { ...this.state, goalAutoContinue: newValue === "true" };
						break;
					case "autonomy-goal-continue-turns":
						this.state = { ...this.state, goalContinueTurns: Number(newValue) };
						break;
					case "autonomy-max-stall-turns":
						this.state = { ...this.state, maxStallTurns: Number(newValue) };
						break;
					case "autonomy-goal-wall-clock-minutes":
						this.state = { ...this.state, goalContinueMaxWallClockMinutes: Number(newValue) };
						break;
					case "autonomy-goal-auto-continue-delay-ms":
						this.state = { ...this.state, goalAutoContinueDelayMs: Number(newValue) };
						break;
					default:
						return;
				}
				onChange({ ...this.state }, this.scope);
			},
			onCancel,
		);

		this.addChild(this.settingsList);
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

class AutoLearnSettingsSubmenu extends Container {
	private settingsList: SettingsList;
	private state: AutoLearnSettings;
	private scope: SettingsScope;

	constructor(
		settings: AutoLearnSettings,
		currentModelPattern: string | undefined,
		modelOptions: SelectItem[] | undefined,
		onChange: (settings: AutoLearnSettings, scope: SettingsScope) => void,
		onCancel: () => void,
		scope: SettingsScope = "global",
	) {
		super();

		this.state = { ...settings };
		this.scope = scope;
		const modelDescription = currentModelPattern
			? `Model for background learning. "active" uses ${currentModelPattern}; configured subscription/API models are listed first.`
			: 'Model for background learning. Use "active" for the current session model, or choose a configured subscription/API model.';
		const selectableModelOptions = buildAutoLearnModelOptions(this.state, modelOptions, currentModelPattern);

		const items: SettingItem[] = [
			{
				id: "auto-learn-scope",
				label: "Save scope",
				description: "Save this Auto Learn configuration globally or in the current project's .pi/settings.json",
				currentValue: this.scope,
				values: ["global", "project"],
			},
			{
				id: "auto-learn-enabled",
				label: "Enabled",
				description: "Autonomously trigger background history scavenging for long sessions",
				currentValue: booleanSettingValue(this.state.enabled),
				values: ["true", "false"],
			},
			{
				id: "auto-learn-model",
				label: "Scavenger model",
				description: modelDescription,
				currentValue: autoLearnModelValue(this.state),
				submenu: (_currentValue, done) =>
					new ModelSelectionSubmenu(
						selectableModelOptions,
						autoLearnModelValue(this.state),
						(value) => {
							this.state = { ...this.state, model: value };
							onChange({ ...this.state }, this.scope);
							done(autoLearnModelValue(this.state));
						},
						() => done(),
					),
			},
			{
				id: "auto-learn-long-session-messages",
				label: "Message trigger",
				description: "Trigger after this many message entries in the active branch",
				currentValue: numberSettingValue(this.state.longSessionMessages, AUTO_LEARN_DEFAULTS.longSessionMessages),
				values: ["16", "32", "64", "128", "256"],
			},
			{
				id: "auto-learn-context-percent",
				label: "Context trigger %",
				description: "Trigger when current context usage reaches this percentage",
				currentValue: numberSettingValue(
					this.state.longSessionContextPercent,
					AUTO_LEARN_DEFAULTS.longSessionContextPercent,
				),
				values: ["50", "60", "70", "80", "90"],
			},
			{
				id: "auto-learn-cooldown-minutes",
				label: "Cooldown minutes",
				description: "Per-session-tenant cooldown between learner launches",
				currentValue: numberSettingValue(this.state.cooldownMinutes, AUTO_LEARN_DEFAULTS.cooldownMinutes),
				values: ["15", "30", "60", "120", "240"],
			},
			{
				id: "auto-learn-lease-minutes",
				label: "Lease minutes",
				description: "Shared-state lease duration for a running background learner",
				currentValue: numberSettingValue(this.state.leaseMinutes, AUTO_LEARN_DEFAULTS.leaseMinutes),
				values: ["30", "60", "90", "180"],
			},
			{
				id: "auto-learn-max-concurrent",
				label: "Max learners",
				description: "Maximum running Auto Learn background learners per session tenant",
				currentValue: numberSettingValue(
					this.state.maxConcurrentLearners,
					AUTO_LEARN_DEFAULTS.maxConcurrentLearners,
				),
				values: ["1", "2", "3", "4"],
			},
			{
				id: "auto-learn-apply-high-confidence",
				label: "Apply high confidence",
				description:
					"Allow high-confidence memory candidates to be applied automatically; broader write authority follows autonomy.mode",
				currentValue: booleanSettingValue(this.state.applyHighConfidence, AUTO_LEARN_DEFAULTS.applyHighConfidence),
				values: ["false", "true"],
			},
			{
				id: "auto-learn-reflection-review",
				label: "Reflection review",
				description: "After corrective or complex turns, launch a bounded background learning review",
				currentValue: booleanSettingValue(this.state.reflectionReview, AUTO_LEARN_DEFAULTS.reflectionReview),
				values: ["true", "false"],
			},
			{
				id: "auto-learn-reflection-tool-calls",
				label: "Reflection tool trigger",
				description: "Trigger reflection review after this many tool calls in one completed turn",
				currentValue: numberSettingValue(
					this.state.reflectionMinToolCalls,
					AUTO_LEARN_DEFAULTS.reflectionMinToolCalls,
				),
				values: ["3", "5", "8", "12"],
			},
			{
				id: "auto-learn-reflection-cooldown",
				label: "Reflection cooldown",
				description: "Per-session-tenant cooldown between reflection-review launches",
				currentValue: numberSettingValue(
					this.state.reflectionCooldownMinutes,
					AUTO_LEARN_DEFAULTS.reflectionCooldownMinutes,
				),
				values: ["15", "30", "60", "120"],
			},
		];

		this.settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "auto-learn-scope":
						this.scope = newValue as SettingsScope;
						break;
					case "auto-learn-enabled":
						this.state = { ...this.state, enabled: newValue === "true" };
						break;
					case "auto-learn-long-session-messages":
						this.state = { ...this.state, longSessionMessages: parseInt(newValue, 10) };
						break;
					case "auto-learn-context-percent":
						this.state = { ...this.state, longSessionContextPercent: parseInt(newValue, 10) };
						break;
					case "auto-learn-cooldown-minutes":
						this.state = { ...this.state, cooldownMinutes: parseInt(newValue, 10) };
						break;
					case "auto-learn-lease-minutes":
						this.state = { ...this.state, leaseMinutes: parseInt(newValue, 10) };
						break;
					case "auto-learn-max-concurrent":
						this.state = { ...this.state, maxConcurrentLearners: parseInt(newValue, 10) };
						break;
					case "auto-learn-apply-high-confidence":
						this.state = { ...this.state, applyHighConfidence: newValue === "true" };
						break;
					case "auto-learn-reflection-review":
						this.state = { ...this.state, reflectionReview: newValue === "true" };
						break;
					case "auto-learn-reflection-tool-calls":
						this.state = { ...this.state, reflectionMinToolCalls: parseInt(newValue, 10) };
						break;
					case "auto-learn-reflection-cooldown":
						this.state = { ...this.state, reflectionCooldownMinutes: parseInt(newValue, 10) };
						break;
					default:
						return;
				}
				onChange({ ...this.state }, this.scope);
			},
			onCancel,
		);

		this.addChild(this.settingsList);
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

class ContextPolicyEnforcementSettingsSubmenu extends Container {
	private settingsList: SettingsList;
	private state: ContextPromptEnforcementSettings;
	private scope: SettingsScope;

	constructor(
		settings: ContextPromptEnforcementSettings,
		onChange: (settings: ContextPromptEnforcementSettings, scope: SettingsScope) => void,
		onCancel: () => void,
		scope: SettingsScope = "global",
	) {
		super();

		this.state = { ...settings };
		this.scope = scope;

		const items: SettingItem[] = [
			{
				id: "context-policy-scope",
				label: "Save scope",
				description:
					"Save this context/prompt-policy configuration globally or in the current project's .pi/settings.json",
				currentValue: this.scope,
				values: ["global", "project"],
			},
			{
				id: "context-policy-enabled",
				label: "Prompt policy enforcement",
				description:
					"Opt-in: stub stale artifact-backed grep/find output in the model-visible prompt only. Never touches transcript/session history. Requires the artifact_retrieve tool to be active this turn (not configurable here -- it's a runtime fact, not a setting).",
				currentValue: booleanSettingValue(this.state.enabled, CONTEXT_POLICY_ENFORCEMENT_DEFAULTS.enabled),
				values: ["false", "true"],
			},
			{
				id: "context-policy-preserve-recent-messages",
				label: "Preserve recent messages",
				description: "Never stub a tool result within this many of the most recent messages",
				currentValue: numberSettingValue(
					this.state.preserveRecentMessages,
					CONTEXT_POLICY_ENFORCEMENT_DEFAULTS.preserveRecentMessages,
				),
				values: CONTEXT_POLICY_PRESERVE_RECENT_MESSAGES_VALUES,
			},
			{
				id: "context-policy-min-chars",
				label: "Minimum chars before stubbing",
				description:
					"Only stub a tool result whose original provider-visible text is at least this many characters",
				currentValue: numberSettingValue(this.state.minChars, CONTEXT_POLICY_ENFORCEMENT_DEFAULTS.minChars),
				values: CONTEXT_POLICY_MIN_CHARS_VALUES,
			},
		];

		this.settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "context-policy-scope":
						this.scope = newValue as SettingsScope;
						break;
					case "context-policy-enabled":
						this.state = { ...this.state, enabled: newValue === "true" };
						break;
					case "context-policy-preserve-recent-messages":
						this.state = { ...this.state, preserveRecentMessages: parseInt(newValue, 10) };
						break;
					case "context-policy-min-chars":
						this.state = { ...this.state, minChars: parseInt(newValue, 10) };
						break;
					default:
						return;
				}
				onChange({ ...this.state }, this.scope);
			},
			onCancel,
		);

		this.addChild(this.settingsList);
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

class ContextMemoryRetrievalSettingsSubmenu extends Container {
	private settingsList: SettingsList;
	private state: MemoryRetrievalSettings;
	private scope: SettingsScope;

	constructor(
		settings: MemoryRetrievalSettings,
		onChange: (settings: MemoryRetrievalSettings, scope: SettingsScope) => void,
		onCancel: () => void,
		scope: SettingsScope = "global",
	) {
		super();

		this.state = { ...settings };
		this.scope = scope;

		const items: SettingItem[] = [
			{
				id: "context-memory-scope",
				label: "Save scope",
				description:
					"Save this local memory-retrieval configuration globally or in the current project's .pi/settings.json",
				currentValue: this.scope,
				values: ["global", "project"],
			},
			{
				id: "context-memory-enabled",
				label: "Local memory retrieval",
				description:
					"Opt-in, observe-only: each turn, search local Pi OKF memory documents (under <agent dir>/okf-memory) for evidence related to the latest message. Results are recorded for inspection only -- nothing is added to the model-visible prompt or transcript yet. Local-only; never queries an external provider.",
				currentValue: booleanSettingValue(this.state.enabled, CONTEXT_MEMORY_RETRIEVAL_DEFAULTS.enabled),
				values: ["false", "true"],
			},
			{
				id: "context-memory-max-results",
				label: "Max results",
				description: "Maximum number of memory items to retrieve per query (1-20)",
				currentValue: numberSettingValue(this.state.maxResults, CONTEXT_MEMORY_RETRIEVAL_DEFAULTS.maxResults),
				values: CONTEXT_MEMORY_RETRIEVAL_MAX_RESULTS_VALUES,
			},
		];

		this.settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "context-memory-scope":
						this.scope = newValue as SettingsScope;
						break;
					case "context-memory-enabled":
						this.state = { ...this.state, enabled: newValue === "true" };
						break;
					case "context-memory-max-results":
						this.state = { ...this.state, maxResults: parseInt(newValue, 10) };
						break;
					default:
						return;
				}
				onChange({ ...this.state }, this.scope);
			},
			onCancel,
		);

		this.addChild(this.settingsList);
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

class ModelRouterSettingsSubmenu extends Container {
	private settingsList: SettingsList;
	private state: ModelRouterSettings;
	private scope: SettingsScope;

	constructor(
		settings: ModelRouterSettings,
		currentModelPattern: string | undefined,
		modelOptions: SelectItem[] | undefined,
		onChange: (settings: ModelRouterSettings, scope: SettingsScope) => void,
		onCancel: () => void,
		scope: SettingsScope = "global",
	) {
		super();
		this.state = {
			...settings,
			enabled: settings.enabled ?? false,
			learningModel: settings.learningModel ?? "active",
		};
		this.scope = scope;
		const cheapModelOptions = buildModelRouterRoleModelOptions({
			currentValue: this.state.cheapModel,
			configuredModelOptions: modelOptions,
			currentModelPattern,
			includeActive: false,
			unsetDescription: "Clear cheap routing model; research turns fall back to the active session model",
		});
		const mediumModelOptions = buildModelRouterRoleModelOptions({
			currentValue: this.state.mediumModel,
			configuredModelOptions: modelOptions,
			currentModelPattern,
			includeActive: false,
			unsetDescription: "Clear medium routing model; implementation turns fall back according to router policy",
		});
		const expensiveModelOptions = buildModelRouterRoleModelOptions({
			currentValue: this.state.expensiveModel,
			configuredModelOptions: modelOptions,
			currentModelPattern,
			includeActive: false,
			unsetDescription: "Clear expensive routing model; modify turns fall back to the active session model",
		});
		const learningModelOptions = buildModelRouterRoleModelOptions({
			currentValue: this.state.learningModel,
			configuredModelOptions: modelOptions,
			currentModelPattern,
			includeActive: true,
		});
		this.addChild(new Text(theme.bold(theme.fg("accent", "Model Router")), 0, 0));
		this.addChild(new Spacer(1));

		const items: SettingItem[] = [
			{
				id: "model-router-scope",
				label: "Save scope",
				description: "Save this routing configuration globally or in the current project's .pi/settings.json",
				currentValue: this.scope,
				values: ["global", "project"],
			},
			{
				id: "model-router-enabled",
				label: "Enabled",
				description: "Route read-only/research turns to cheap model and modify/tool-heavy turns to expensive model",
				currentValue: booleanSettingValue(this.state.enabled),
				values: ["false", "true"],
			},
			{
				id: "model-router-cheap",
				label: "Cheap model",
				description: "Pick the model for read-only, research, explanation, and question turns",
				currentValue: optionalStringValue(this.state.cheapModel),
				submenu: (_currentValue, done) =>
					new ModelSelectionSubmenu(
						cheapModelOptions,
						this.state.cheapModel ?? MODEL_ROUTER_UNSET_MODEL_VALUE,
						(value) => {
							this.state = {
								...this.state,
								cheapModel: value === MODEL_ROUTER_UNSET_MODEL_VALUE ? undefined : value,
							};
							onChange({ ...this.state }, this.scope);
							done(optionalStringValue(this.state.cheapModel));
						},
						() => done(),
						{
							title: "Cheap / Research Model",
							description:
								"Choose from models available through configured subscription/API accounts. Type to filter; manual is fallback.",
							customTitle: "Custom Cheap / Research Model",
							customDescription: "Enter a provider/model pattern from pi --list-models.",
							customEmptyHint: "empty clears the setting",
							customEmptyValue: MODEL_ROUTER_UNSET_MODEL_VALUE,
						},
					),
			},
			{
				id: "model-router-medium",
				label: "Medium model",
				description: "Pick the model for normal scoped implementation, edits, tests, and mechanical refactors",
				currentValue: optionalStringValue(this.state.mediumModel),
				submenu: (_currentValue, done) =>
					new ModelSelectionSubmenu(
						mediumModelOptions,
						this.state.mediumModel ?? MODEL_ROUTER_UNSET_MODEL_VALUE,
						(value) => {
							this.state = {
								...this.state,
								mediumModel: value === MODEL_ROUTER_UNSET_MODEL_VALUE ? undefined : value,
							};
							onChange({ ...this.state }, this.scope);
							done(optionalStringValue(this.state.mediumModel));
						},
						() => done(),
						{
							title: "Medium / Implementation Model",
							description:
								"Choose from models available through configured subscription/API accounts. Type to filter; manual is fallback.",
							customTitle: "Custom Medium / Implementation Model",
							customDescription: "Enter a provider/model pattern from pi --list-models.",
							customEmptyHint: "empty clears the setting",
							customEmptyValue: MODEL_ROUTER_UNSET_MODEL_VALUE,
						},
					),
			},
			{
				id: "model-router-expensive",
				label: "Expensive model",
				description: "Pick the model for modify, implementation, and escalated tool-heavy turns",
				currentValue: optionalStringValue(this.state.expensiveModel),
				submenu: (_currentValue, done) =>
					new ModelSelectionSubmenu(
						expensiveModelOptions,
						this.state.expensiveModel ?? MODEL_ROUTER_UNSET_MODEL_VALUE,
						(value) => {
							this.state = {
								...this.state,
								expensiveModel: value === MODEL_ROUTER_UNSET_MODEL_VALUE ? undefined : value,
							};
							onChange({ ...this.state }, this.scope);
							done(optionalStringValue(this.state.expensiveModel));
						},
						() => done(),
						{
							title: "Expensive / Modify Model",
							description:
								"Choose from models available through configured subscription/API accounts. Type to filter; manual is fallback.",
							customTitle: "Custom Expensive / Modify Model",
							customDescription: "Enter a provider/model pattern from pi --list-models.",
							customEmptyHint: "empty clears the setting",
							customEmptyValue: MODEL_ROUTER_UNSET_MODEL_VALUE,
						},
					),
			},
			{
				id: "model-router-learning",
				label: "Learning/reflection model",
				description:
					"Pick the model for background reflection, learn, and skill-creator work; active uses the session model",
				currentValue: optionalStringValue(this.state.learningModel, "active"),
				submenu: (_currentValue, done) =>
					new ModelSelectionSubmenu(
						learningModelOptions,
						this.state.learningModel ?? AUTO_LEARN_DEFAULTS.model,
						(value) => {
							this.state = { ...this.state, learningModel: value };
							onChange({ ...this.state }, this.scope);
							done(optionalStringValue(this.state.learningModel, "active"));
						},
						() => done(),
						{
							title: "Learning / Reflection Model",
							description:
								"Choose active or a model from configured subscription/API accounts. Type to filter; manual is fallback.",
							customTitle: "Custom Learning / Reflection Model",
							customDescription: 'Enter "active" or a provider/model pattern from pi --list-models.',
							customEmptyHint: 'empty uses "active"',
							customEmptyValue: AUTO_LEARN_DEFAULTS.model,
						},
					),
			},
		];

		this.settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "model-router-scope":
						this.scope = newValue as SettingsScope;
						break;
					case "model-router-enabled":
						this.state = { ...this.state, enabled: newValue === "true" };
						break;
					default:
						return;
				}
				onChange({ ...this.state }, this.scope);
			},
			onCancel,
		);

		this.addChild(this.settingsList);
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

/**
 * A submenu component for selecting from a list of options.
 */
class WarningSettingsSubmenu extends Container {
	private settingsList: SettingsList;
	private state: WarningSettings;

	constructor(warnings: WarningSettings, onChange: (warnings: WarningSettings) => void, onCancel: () => void) {
		super();

		this.state = { ...warnings };

		const items: SettingItem[] = [
			{
				id: "anthropic-extra-usage",
				label: "Anthropic extra usage",
				description: "Warn when Anthropic subscription auth may use paid extra usage",
				currentValue: (this.state.anthropicExtraUsage ?? true) ? "true" : "false",
				values: ["true", "false"],
			},
		];

		this.settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "anthropic-extra-usage":
						this.state = { ...this.state, anthropicExtraUsage: newValue === "true" };
						onChange({ ...this.state });
						break;
				}
			},
			onCancel,
		);

		this.addChild(this.settingsList);
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

export class SelectSubmenu extends Container {
	private selectList: SelectList;

	getSelectList(): SelectList {
		return this.selectList;
	}

	constructor(
		title: string,
		description: string,
		options: SelectItem[],
		currentValue: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
		onSelectionChange?: (value: string) => void,
	) {
		super();

		// Title
		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));

		// Description
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}

		// Spacer
		this.addChild(new Spacer(1));

		// Select list
		this.selectList = new SelectList(
			options,
			Math.min(options.length, 10),
			getSelectListTheme(),
			SETTINGS_SUBMENU_SELECT_LIST_LAYOUT,
		);

		// Pre-select current value
		const currentIndex = options.findIndex((o) => o.value === currentValue);
		if (currentIndex !== -1) {
			this.selectList.setSelectedIndex(currentIndex);
		}

		this.selectList.onSelect = (item) => {
			onSelect(item.value);
		};

		this.selectList.onCancel = onCancel;

		if (onSelectionChange) {
			this.selectList.onSelectionChange = (item) => {
				onSelectionChange(item.value);
			};
		}

		this.addChild(this.selectList);

		// Hint
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to select · Esc to go back"), 0, 0));
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "app.interrupt") || kb.matches(data, "app.clear")) {
			this.selectList.onCancel?.();
			return;
		}
		this.selectList.handleInput(data);
	}
}

/**
 * Main settings selector component.
 */
export class SettingsSelectorComponent extends Container {
	private settingsList: SettingsList;

	constructor(config: SettingsConfig, callbacks: SettingsCallbacks) {
		super();

		const supportsImages = getCapabilities().images;
		const followUpKey = keyDisplayText("app.message.followUp");
		let currentWarnings = { ...config.warnings };
		let currentSelfModification: SelfModificationSettings = { ...config.selfModification };
		let currentAutonomy: AutonomySettings = { ...config.autonomy };
		let currentModelRouter: ModelRouterSettings = { ...config.modelRouter };
		let currentAutoLearn: AutoLearnSettings = { ...config.autoLearn };
		let currentContextPolicyEnforcement: ContextPromptEnforcementSettings = { ...config.contextPolicyEnforcement };
		let currentContextMemoryRetrieval: MemoryRetrievalSettings = { ...config.contextMemoryRetrieval };
		const items: SettingItem[] = [
			{
				id: "autocompact",
				label: "Auto-compact",
				description: "Automatically compact context when it gets too large",
				currentValue: config.autoCompact ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "steering-mode",
				label: "Steering mode",
				description:
					"Enter while streaming queues steering messages. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.",
				currentValue: config.steeringMode,
				values: ["one-at-a-time", "all"],
			},
			{
				id: "follow-up-mode",
				label: "Follow-up mode",
				description: `${followUpKey} queues follow-up messages until agent stops. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.`,
				currentValue: config.followUpMode,
				values: ["one-at-a-time", "all"],
			},
			{
				id: "transport",
				label: "Transport",
				description: "Preferred transport for providers that support multiple transports",
				currentValue: config.transport,
				values: ["sse", "websocket", "websocket-cached", "auto"],
			},
			{
				id: "http-idle-timeout",
				label: "HTTP idle timeout",
				description:
					"Maximum idle gap while waiting for HTTP headers or body chunks. Disable for local models that pause longer than five minutes.",
				currentValue: formatHttpIdleTimeoutMs(config.httpIdleTimeoutMs),
				values: HTTP_IDLE_TIMEOUT_CHOICES.map((choice) => choice.label),
			},
			{
				id: "hide-thinking",
				label: "Hide thinking",
				description: "Hide thinking blocks in assistant responses",
				currentValue: config.hideThinkingBlock ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "collapse-changelog",
				label: "Collapse changelog",
				description: "Show condensed changelog after updates",
				currentValue: config.collapseChangelog ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "quiet-startup",
				label: "Quiet startup",
				description: "Disable verbose printing at startup",
				currentValue: config.quietStartup ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "install-telemetry",
				label: "Install telemetry",
				description: "Send an anonymous version/update ping after changelog-detected updates",
				currentValue: config.enableInstallTelemetry ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "double-escape-action",
				label: "Double-escape action",
				description: "Action when pressing Escape twice with empty editor",
				currentValue: config.doubleEscapeAction,
				values: ["tree", "fork", "none"],
			},
			{
				id: "tree-filter-mode",
				label: "Tree filter mode",
				description: "Default filter when opening /tree",
				currentValue: config.treeFilterMode,
				values: ["default", "no-tools", "user-only", "labeled-only", "all"],
			},
			{
				id: "self-modification",
				label: "Self modification",
				description: "Enable Pi self-evolution guardrails and configure the editable pi-adaptative source checkout",
				currentValue: selfModificationSummary(currentSelfModification),
				submenu: (_currentValue, done) =>
					new SelfModificationSettingsSubmenu(
						currentSelfModification,
						(settings, scope) => {
							currentSelfModification = { ...settings };
							callbacks.onSelfModificationChange(settings, scope);
						},
						() => done(selfModificationSummary(currentSelfModification)),
						config.selfModificationScope ?? "global",
					),
			},
			{
				id: "autonomy",
				label: "Autonomy",
				description: "Choose one autonomy preset instead of tuning many background-learning knobs",
				currentValue: autonomySummary(currentAutonomy),
				submenu: (_currentValue, done) =>
					new AutonomySettingsSubmenu(
						currentAutonomy,
						(settings, scope) => {
							currentAutonomy = { ...settings };
							callbacks.onAutonomyChange(settings, scope);
						},
						() => done(autonomySummary(currentAutonomy)),
						config.autonomyScope ?? "global",
					),
			},
			{
				id: "model-router",
				label: "Model Router",
				description:
					"Configure models for cheap research, expensive modify/escalation, and background learning/reflection",
				currentValue: modelRouterSummary(currentModelRouter),
				submenu: (_currentValue, done) =>
					new ModelRouterSettingsSubmenu(
						currentModelRouter,
						config.currentModelPattern,
						config.autoLearnModelOptions,
						(settings, scope) => {
							currentModelRouter = { ...settings };
							callbacks.onModelRouterChange(settings, scope);
						},
						() => done(modelRouterSummary(currentModelRouter)),
						config.modelRouterScope ?? "global",
					),
			},
			{
				id: "auto-learn",
				label: "Auto Learn Advanced",
				description: "Advanced overrides for autonomous background learning/scavenging",
				currentValue: autoLearnSummary(currentAutoLearn),
				submenu: (_currentValue, done) =>
					new AutoLearnSettingsSubmenu(
						currentAutoLearn,
						config.currentModelPattern,
						config.autoLearnModelOptions,
						(settings, scope) => {
							currentAutoLearn = { ...settings };
							callbacks.onAutoLearnChange(settings, scope);
						},
						() => done(autoLearnSummary(currentAutoLearn)),
						config.autoLearnScope ?? "global",
					),
			},
			{
				id: "context-policy-enforcement",
				label: "Context / Prompt Policy",
				description:
					"Opt-in artifact-stub prompt-policy enforcement: stubs stale artifact-backed tool output in the model-visible prompt only, never the transcript. Requires the artifact_retrieve tool to be active.",
				currentValue: contextPolicyEnforcementSummary(currentContextPolicyEnforcement),
				submenu: (_currentValue, done) =>
					new ContextPolicyEnforcementSettingsSubmenu(
						currentContextPolicyEnforcement,
						(settings, scope) => {
							currentContextPolicyEnforcement = { ...settings };
							callbacks.onContextPolicyEnforcementChange(settings, scope);
						},
						() => done(contextPolicyEnforcementSummary(currentContextPolicyEnforcement)),
						config.contextPolicyEnforcementScope ?? "global",
					),
			},
			{
				id: "context-memory-retrieval",
				label: "Context / Memory Retrieval",
				description:
					"Opt-in, observe-only local memory retrieval: searches local Pi OKF memory documents each turn and records source-labeled evidence for inspection. Never injects results into the model-visible prompt yet, and never queries an external provider.",
				currentValue: contextMemoryRetrievalSummary(currentContextMemoryRetrieval),
				submenu: (_currentValue, done) =>
					new ContextMemoryRetrievalSettingsSubmenu(
						currentContextMemoryRetrieval,
						(settings, scope) => {
							currentContextMemoryRetrieval = { ...settings };
							callbacks.onContextMemoryRetrievalChange(settings, scope);
						},
						() => done(contextMemoryRetrievalSummary(currentContextMemoryRetrieval)),
						config.contextMemoryRetrievalScope ?? "global",
					),
			},
			{
				id: "warnings",
				label: "Warnings",
				description: "Enable or disable individual warnings",
				currentValue: "configure",
				submenu: (_currentValue, done) =>
					new WarningSettingsSubmenu(
						currentWarnings,
						(warnings) => {
							currentWarnings = warnings;
							callbacks.onWarningsChange(warnings);
						},
						() => done(),
					),
			},
			{
				id: "thinking",
				label: "Thinking level",
				description: "Reasoning depth for thinking-capable models",
				currentValue: config.thinkingLevel,
				submenu: (currentValue, done) =>
					new SelectSubmenu(
						"Thinking Level",
						"Select reasoning depth for thinking-capable models",
						config.availableThinkingLevels.map((level) => ({
							value: level,
							label: level,
							description: THINKING_DESCRIPTIONS[level],
						})),
						currentValue,
						(value) => {
							callbacks.onThinkingLevelChange(value as ThinkingLevel);
							done(value);
						},
						() => done(),
					),
			},
			{
				id: "theme",
				label: "Theme",
				description: "Color theme for the interface",
				currentValue: config.currentTheme,
				submenu: (currentValue, done) =>
					new SelectSubmenu(
						"Theme",
						"Select color theme",
						config.availableThemes.map((t) => ({
							value: t,
							label: t,
						})),
						currentValue,
						(value) => {
							callbacks.onThemeChange(value);
							done(value);
						},
						() => {
							// Restore original theme on cancel
							callbacks.onThemePreview?.(currentValue);
							done();
						},
						(value) => {
							// Preview theme on selection change
							callbacks.onThemePreview?.(value);
						},
					),
			},
		];

		const externalRoots = config.externalResourceRoots ?? [];
		const hasSources = externalRoots.length > 0;
		const hasProfiles = (config.profileOptions ?? []).filter((o) => o.value !== "(none)").length > 0;

		items.push({
			id: "resources",
			label: "Resources",
			description: "Manage profiles/situations, library, and external resource sources.",
			currentValue: config.activeProfileName ?? "(none)",
			submenu: (_currentValue, done) => {
				const options: SelectItem[] = [];

				if (!hasSources && !hasProfiles) {
					options.push({
						value: "nudge-add-source",
						label: "Add your catalog directory →",
						description: "First-run nudge: Add a directory of shared skills, extensions, profiles, and agents.",
					});
				}

				options.push({
					value: "active-profile",
					label: "Profile / Situation",
					description: `Select the active profile/situation. Current: ${config.activeProfileName ?? "(none)"}`,
				});

				options.push({
					value: "manage-library",
					label: "Manage Library",
					description: "Toggle allowed tools/skills/extensions in the active profile/scope.",
				});

				options.push({
					value: "manage-profiles",
					label: "Manage Profiles / Situations",
					description: "Create, delete, or persist profile/situation definitions.",
				});

				options.push({
					value: "sources",
					label: "Sources",
					description: `Manage external resource roots (${externalRoots.length} registered).`,
				});

				return new SelectSubmenu(
					"Resources Hub",
					"Configure profiles/situations and external resource catalogs.",
					options,
					"",
					(value) => {
						done();
						callbacks.onResourcesHubAction?.(value);
					},
					() => done(),
				);
			},
		});

		// Only show image toggle if terminal supports it
		if (supportsImages) {
			// Insert after autocompact
			items.splice(1, 0, {
				id: "show-images",
				label: "Show images",
				description: "Render images inline in terminal",
				currentValue: config.showImages ? "true" : "false",
				values: ["true", "false"],
			});
			items.splice(2, 0, {
				id: "image-width-cells",
				label: "Image width",
				description: "Preferred inline image width in terminal cells",
				currentValue: String(config.imageWidthCells),
				values: ["60", "80", "120"],
			});
		}

		// Image auto-resize toggle (always available, affects both attached and read images)
		items.splice(supportsImages ? 3 : 1, 0, {
			id: "auto-resize-images",
			label: "Auto-resize images",
			description: "Resize large images to 2000x2000 max for better model compatibility",
			currentValue: config.autoResizeImages ? "true" : "false",
			values: ["true", "false"],
		});

		// Block images toggle (always available, insert after auto-resize-images)
		const autoResizeIndex = items.findIndex((item) => item.id === "auto-resize-images");
		items.splice(autoResizeIndex + 1, 0, {
			id: "block-images",
			label: "Block images",
			description: "Prevent images from being sent to LLM providers",
			currentValue: config.blockImages ? "true" : "false",
			values: ["true", "false"],
		});

		// Skill commands toggle (insert after block-images)
		const blockImagesIndex = items.findIndex((item) => item.id === "block-images");
		items.splice(blockImagesIndex + 1, 0, {
			id: "skill-commands",
			label: "Skill commands",
			description: "Register skills as /skill:name commands",
			currentValue: config.enableSkillCommands ? "true" : "false",
			values: ["true", "false"],
		});

		// Hardware cursor toggle (insert after skill-commands)
		const skillCommandsIndex = items.findIndex((item) => item.id === "skill-commands");
		items.splice(skillCommandsIndex + 1, 0, {
			id: "show-hardware-cursor",
			label: "Show hardware cursor",
			description: "Show the terminal cursor while still positioning it for IME support",
			currentValue: config.showHardwareCursor ? "true" : "false",
			values: ["true", "false"],
		});

		// Editor padding toggle (insert after show-hardware-cursor)
		const hardwareCursorIndex = items.findIndex((item) => item.id === "show-hardware-cursor");
		items.splice(hardwareCursorIndex + 1, 0, {
			id: "editor-padding",
			label: "Editor padding",
			description: "Horizontal padding for input editor (0-3)",
			currentValue: String(config.editorPaddingX),
			values: ["0", "1", "2", "3"],
		});

		// Autocomplete max visible toggle (insert after editor-padding)
		const editorPaddingIndex = items.findIndex((item) => item.id === "editor-padding");
		items.splice(editorPaddingIndex + 1, 0, {
			id: "autocomplete-max-visible",
			label: "Autocomplete max items",
			description: "Max visible items in autocomplete dropdown (3-20)",
			currentValue: String(config.autocompleteMaxVisible),
			values: ["3", "5", "7", "10", "15", "20"],
		});

		// Clear on shrink toggle (insert after autocomplete-max-visible)
		const autocompleteIndex = items.findIndex((item) => item.id === "autocomplete-max-visible");
		items.splice(autocompleteIndex + 1, 0, {
			id: "clear-on-shrink",
			label: "Clear on shrink",
			description: "Clear empty rows when content shrinks (may cause flicker)",
			currentValue: config.clearOnShrink ? "true" : "false",
			values: ["true", "false"],
		});

		// Terminal progress toggle (insert after clear-on-shrink)
		const clearOnShrinkIndex = items.findIndex((item) => item.id === "clear-on-shrink");
		items.splice(clearOnShrinkIndex + 1, 0, {
			id: "terminal-progress",
			label: "Terminal progress",
			description: "Show OSC 9;4 progress indicators in the terminal tab bar",
			currentValue: config.showTerminalProgress ? "true" : "false",
			values: ["true", "false"],
		});

		// Add borders
		this.addChild(new DynamicBorder());

		this.settingsList = new SettingsList(
			items,
			10,
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "autocompact":
						callbacks.onAutoCompactChange(newValue === "true");
						break;
					case "show-images":
						callbacks.onShowImagesChange(newValue === "true");
						break;
					case "image-width-cells":
						callbacks.onImageWidthCellsChange(parseInt(newValue, 10));
						break;
					case "auto-resize-images":
						callbacks.onAutoResizeImagesChange(newValue === "true");
						break;
					case "block-images":
						callbacks.onBlockImagesChange(newValue === "true");
						break;
					case "skill-commands":
						callbacks.onEnableSkillCommandsChange(newValue === "true");
						break;
					case "steering-mode":
						callbacks.onSteeringModeChange(newValue as "all" | "one-at-a-time");
						break;
					case "follow-up-mode":
						callbacks.onFollowUpModeChange(newValue as "all" | "one-at-a-time");
						break;
					case "transport":
						callbacks.onTransportChange(newValue as Transport);
						break;
					case "http-idle-timeout": {
						const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.label === newValue);
						if (choice) {
							callbacks.onHttpIdleTimeoutMsChange(choice.timeoutMs);
						}
						break;
					}
					case "hide-thinking":
						callbacks.onHideThinkingBlockChange(newValue === "true");
						break;
					case "collapse-changelog":
						callbacks.onCollapseChangelogChange(newValue === "true");
						break;
					case "quiet-startup":
						callbacks.onQuietStartupChange(newValue === "true");
						break;
					case "install-telemetry":
						callbacks.onEnableInstallTelemetryChange(newValue === "true");
						break;
					case "double-escape-action":
						callbacks.onDoubleEscapeActionChange(newValue as "fork" | "tree");
						break;
					case "tree-filter-mode":
						callbacks.onTreeFilterModeChange(
							newValue as "default" | "no-tools" | "user-only" | "labeled-only" | "all",
						);
						break;
					case "show-hardware-cursor":
						callbacks.onShowHardwareCursorChange(newValue === "true");
						break;
					case "editor-padding":
						callbacks.onEditorPaddingXChange(parseInt(newValue, 10));
						break;
					case "autocomplete-max-visible":
						callbacks.onAutocompleteMaxVisibleChange(parseInt(newValue, 10));
						break;
					case "clear-on-shrink":
						callbacks.onClearOnShrinkChange(newValue === "true");
						break;
					case "terminal-progress":
						callbacks.onShowTerminalProgressChange(newValue === "true");
						break;
				}
			},
			callbacks.onCancel,
			{ enableSearch: true },
		);

		this.addChild(this.settingsList);
		this.addChild(new DynamicBorder());
	}

	getSettingsList(): SettingsList {
		return this.settingsList;
	}
}
