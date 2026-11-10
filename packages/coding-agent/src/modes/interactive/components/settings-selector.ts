import type { Transport } from "@caupulican/pi-ai";
import {
	Container,
	getCapabilities,
	getKeybindings,
	Input,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
} from "@caupulican/pi-tui";
import { type CostGuardSettings, DEFAULT_ENABLED_COST_GUARD_MAX_TURN_USD } from "../../../core/cost-guard.ts";
import type {
	HmoeIndependence,
	HmoePreference,
	HmoePreset,
	HmoeTeamStrategy,
} from "../../../core/expert-routing/vocabulary.ts";
import { formatHttpIdleTimeoutMs, HTTP_IDLE_TIMEOUT_CHOICES } from "../../../core/http-dispatcher.ts";
import { interfaceText } from "../../../core/language/interface-text.ts";
import type { LanguageSetting } from "../../../core/language/language.ts";
import { DEFAULT_AUTO_LEARN_SETTINGS, resolveAutoLearnSettings } from "../../../core/learning/auto-learn-settings.ts";
import { describeRouterCalibrationScope } from "../../../core/model-router/calibration.ts";
import {
	DEFAULT_AUTONOMY_GOAL_AUTO_CONTINUE,
	DEFAULT_AUTONOMY_GOAL_AUTO_CONTINUE_DELAY_MS,
	DEFAULT_AUTONOMY_GOAL_CONTINUE_MAX_WALL_CLOCK_MINUTES,
	DEFAULT_AUTONOMY_GOAL_CONTINUE_TURNS,
	DEFAULT_AUTONOMY_MAX_STALL_TURNS,
	DEFAULT_LEARNING_POLICY_AUTO_APPLY_ENABLED,
	DEFAULT_LEARNING_POLICY_AUTO_APPLY_SUPERSESSIONS,
	DEFAULT_LEARNING_POLICY_CONFIDENCE_THRESHOLD,
	DEFAULT_LEARNING_POLICY_ENABLED,
	DEFAULT_LEARNING_POLICY_MIN_OBSERVATIONS,
	DEFAULT_RESEARCH_LANE_ENABLED,
	DEFAULT_RESEARCH_LANE_IDLE_DELAY_MS,
	DEFAULT_RESEARCH_LANE_MAX_RUNS_PER_SESSION,
	DEFAULT_RESEARCH_LANE_MAX_USD,
	DEFAULT_RESEARCH_LANE_MAX_WALL_CLOCK_MS,
	DEFAULT_WORKER_DELEGATION_ENABLED,
	DEFAULT_WORKER_DELEGATION_MAX_USD,
	DEFAULT_WORKER_DELEGATION_MAX_WALL_CLOCK_MS,
	DEFAULT_WORKER_DELEGATION_WRITE_ENABLED,
	HMOE_INDEPENDENCE_LEVELS,
	HMOE_PREFERENCES,
	HMOE_PRESETS,
	HMOE_TEAM_STRATEGIES,
	MAX_WORKER_DELEGATION_MAX_USD,
} from "../../../core/settings/settings-rules.ts";
import type {
	AdvisorSettings,
	AutoLearnSettings,
	AutonomyMode,
	AutonomySettings,
	ContextCurationSettings,
	ContextPromptEnforcementSettings,
	LearningPolicySettings,
	MemoryRetrievalSettings,
	ModelCapabilitySettings,
	ModelRouterPoolPreference,
	ModelRouterSelectionMode,
	ModelRouterSettings,
	ResearchLaneSettings,
	SelfModificationSettings,
	SettingsScope,
	WarningSettings,
	WorkerDelegationSettings,
} from "../../../core/settings/settings-schema.ts";
import { SYSTEM_ONE_PROVIDER_CHOICES, type SystemOneProviderChoice } from "../../../core/system-one/access.ts";
import type { ThinkingLevel } from "../../../kernel/index.ts";
import { keyDisplayText } from "../../../presentation/keybinding-hints.ts";
import { getSelectListTheme, getSettingsListTheme, theme } from "../../../presentation/theme-model.ts";
import { THINKING_LEVEL_DESCRIPTIONS } from "../thinking-level-descriptions.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { languageSettingsItem } from "./language-settings-item.ts";
import { COMPACT_SELECTOR_LIST_LAYOUT, SelectorHeading } from "./selector-list.ts";
import {
	booleanSettingValue,
	normalizeOptionalString,
	numberSettingValue,
	optionalStringValue,
} from "./settings-value-text.ts";

const AUTO_LEARN_CUSTOM_MODEL_VALUE = "__custom_auto_learn_model__";
const MODEL_ROUTER_UNSET_MODEL_VALUE = "__unset_model_router_model__";
const MODEL_ROUTER_INHERIT_THINKING_VALUE = "__inherit_model_router_thinking__";

const AUTONOMY_MODES: AutonomyMode[] = ["off", "safe", "balanced", "full"];
const AUTONOMY_GOAL_CONTINUE_TURN_VALUES = ["0", "1", "3", "5", "10", "20"];
const AUTONOMY_MAX_STALL_TURN_VALUES = ["0", "5", "10", "20", "30", "50", "100"];
const AUTONOMY_GOAL_CONTINUE_MAX_WALL_CLOCK_MINUTE_VALUES = ["0", "15", "30", "60", "120", "240", "480", "1440"];
const AUTONOMY_GOAL_AUTO_CONTINUE_DELAY_MS_VALUES = ["0", "250", "1000", "5000", "30000", "60000"];

const RESEARCH_LANE_MAX_USD_VALUES = ["0.05", "0.1", "0.25", "0.5", "1", "2"];
const RESEARCH_LANE_MAX_WALL_CLOCK_MS_VALUES = ["0", "30000", "60000", "120000", "300000", "600000"];
const RESEARCH_LANE_IDLE_DELAY_MS_VALUES = ["0", "250", "1000", "5000", "30000", "60000"];
const RESEARCH_LANE_MAX_RUNS_PER_SESSION_VALUES = ["0", "1", "3", "5", "10", "25", "50"];

const CONTEXT_POLICY_PRESERVE_RECENT_MESSAGES_VALUES = ["2", "4", "8", "16", "24", "32"];
const CONTEXT_POLICY_MIN_CHARS_VALUES = ["300", "600", "1200", "2400", "4800"];

const CONTEXT_POLICY_ENFORCEMENT_DEFAULTS = {
	enabled: false,
	preserveRecentMessages: 24,
	minChars: 1200,
} as const;

const CONTEXT_MEMORY_RETRIEVAL_MAX_RESULTS_VALUES = ["1", "3", "5", "10", "20"];

const CONTEXT_MEMORY_RETRIEVAL_DEFAULTS = {
	enabled: true,
	maxResults: 5,
	includeInPrompt: true,
	allowExternalEgress: false,
} as const;

/**
 * The settings screen's words. A row stores and saves a machine value and reads the label for it here when
 * the row is drawn, so a change of language needs no restart.
 */
function screenText() {
	return interfaceText().settingsScreen;
}

function routerTierValue(
	model: string | undefined,
	thinking: ThinkingLevel | undefined,
	fallback = screenText().values.notSet,
): string {
	return screenText().summaries.routerTier(
		optionalStringValue(model, fallback),
		thinking ?? screenText().values.inherit,
	);
}

function autoLearnModelValue(settings: AutoLearnSettings): string {
	const model = optionalStringValue(settings.model, DEFAULT_AUTO_LEARN_SETTINGS.model);
	return model === DEFAULT_AUTO_LEARN_SETTINGS.model ? screenText().values.active : model;
}

function selfModificationSummary(settings: SelfModificationSettings): string {
	if (!(settings.enabled ?? false)) return screenText().summaries.disabled;
	const hasPath =
		Boolean(settings.sourcePath?.trim()) ||
		(Array.isArray(settings.sourcePaths) && settings.sourcePaths.some((candidate) => Boolean(candidate?.trim())));
	return screenText().summaries.selfModification(hasPath);
}

function costGuardSummary(settings: CostGuardSettings): string {
	if (!settings.enabled) return screenText().summaries.disabled;
	const action = screenText().valueLabels.costGuardAction[settings.action] ?? settings.action;
	return screenText().summaries.costGuard(action, settings.maxTurnUsd.toFixed(2));
}

function autonomyModeValue(settings: AutonomySettings): AutonomyMode {
	return settings.mode && AUTONOMY_MODES.includes(settings.mode) ? settings.mode : "off";
}

function autonomySummary(settings: AutonomySettings): string {
	const mode = autonomyModeValue(settings);
	const turns = settings.goalContinueTurns ?? DEFAULT_AUTONOMY_GOAL_CONTINUE_TURNS;
	const stall = settings.maxStallTurns ?? DEFAULT_AUTONOMY_MAX_STALL_TURNS;
	const autoContinue = settings.goalAutoContinue ?? DEFAULT_AUTONOMY_GOAL_AUTO_CONTINUE;
	const text = screenText();
	const modeLabel = mode === "full" ? text.values.autonomyModeFull : mode;
	const autoContinueLabel = autoContinue ? text.values.onLower : text.values.offLower;
	return text.summaries.autonomy(modeLabel, text.summaries.turns(turns), stall, autoContinueLabel);
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

function researchLaneSummary(settings: ResearchLaneSettings): string {
	if (!(settings.enabled ?? DEFAULT_RESEARCH_LANE_ENABLED)) return screenText().summaries.disabled;
	const maxUsd = settings.maxUsd ?? DEFAULT_RESEARCH_LANE_MAX_USD;
	const maxRuns = settings.maxRunsPerSession ?? DEFAULT_RESEARCH_LANE_MAX_RUNS_PER_SESSION;
	return screenText().summaries.researchLane(String(maxUsd), maxRuns);
}

function contextCurationSummary(settings: ContextCurationSettings): string {
	if (!settings.enabled) return screenText().summaries.disabled;
	return screenText().summaries.contextCuration(
		settings.model ?? screenText().values.noModel,
		settings.maxJobsPerTurn ?? 4,
	);
}

function learningPolicySummary(settings: LearningPolicySettings): string {
	const text = screenText();
	if (!(settings.enabled ?? DEFAULT_LEARNING_POLICY_ENABLED)) return text.summaries.disabledLegacyDirectApply;
	const autoApply = settings.autoApplyEnabled ?? DEFAULT_LEARNING_POLICY_AUTO_APPLY_ENABLED;
	const confidence = settings.confidenceThreshold ?? DEFAULT_LEARNING_POLICY_CONFIDENCE_THRESHOLD;
	return text.summaries.learningPolicy(autoApply ? text.values.onLower : text.values.offLower, confidence);
}

function modelCapabilitySummary(settings: ModelCapabilitySettings): string {
	const mode = settings.mode ?? "auto";
	return mode === "auto"
		? screenText().summaries.modelCapabilityAuto
		: (screenText().valueLabels.modelCapability[mode] ?? mode);
}

function workerDelegationSummary(settings: WorkerDelegationSettings): string {
	if (!(settings.enabled ?? DEFAULT_WORKER_DELEGATION_ENABLED)) return screenText().summaries.disabled;
	const maxUsd = settings.maxUsd ?? DEFAULT_WORKER_DELEGATION_MAX_USD;
	return maxUsd > 0
		? screenText().summaries.workerDelegationBudget(String(maxUsd))
		: screenText().summaries.enabledUnbounded;
}

function autoLearnSummary(settings: AutoLearnSettings, autonomyMode: AutonomyMode): string {
	const effective = resolveAutoLearnSettings(autonomyMode, settings);
	return effective.enabled ? screenText().summaries.autoLearn(effective.model) : screenText().summaries.disabled;
}

function contextPolicyEnforcementSummary(settings: ContextPromptEnforcementSettings): string {
	if (!(settings.enabled ?? CONTEXT_POLICY_ENFORCEMENT_DEFAULTS.enabled)) return screenText().summaries.disabled;
	const preserve = settings.preserveRecentMessages ?? CONTEXT_POLICY_ENFORCEMENT_DEFAULTS.preserveRecentMessages;
	const minChars = settings.minChars ?? CONTEXT_POLICY_ENFORCEMENT_DEFAULTS.minChars;
	return screenText().summaries.contextPolicy(preserve, minChars);
}

function contextMemoryRetrievalSummary(settings: MemoryRetrievalSettings): string {
	const text = screenText();
	const externalEgress = settings.allowExternalEgress ?? CONTEXT_MEMORY_RETRIEVAL_DEFAULTS.allowExternalEgress;
	const consent = text.summaries.contextMemoryExternalConsent(externalEgress);
	if (!(settings.enabled ?? CONTEXT_MEMORY_RETRIEVAL_DEFAULTS.enabled)) {
		return text.summaries.contextMemoryOff(consent);
	}
	const maxResults = settings.maxResults ?? CONTEXT_MEMORY_RETRIEVAL_DEFAULTS.maxResults;
	const includeInPrompt = settings.includeInPrompt ?? CONTEXT_MEMORY_RETRIEVAL_DEFAULTS.includeInPrompt;
	const inPrompt = includeInPrompt ? text.summaries.contextMemoryInPrompt : "";
	const external = text.summaries.contextMemoryExternal(externalEgress);
	return text.summaries.contextMemory(maxResults, inPrompt, external);
}

/**
 * The router's candidate pool as the settings screen shows it: derived by the flow from the
 * session's available favorites, optional Models scope and existing fitness evidence.
 */
export interface ModelRouterPoolView {
	customized: boolean;
	/**
	 * The pool as the router itself describes it, provenance included (`formatRouterPoolSummary`).
	 * The screen never re-derives this wording: the operator reads the same sentence here and in
	 * router diagnostics.
	 */
	summary: string;
	refs: string[];
	subscriptionRefs: string[];
	favoriteRefs: string[];
	/** One formatted calibration row per ref, same order as `refs`. */
	calibration: string[];
	/** Refs whose router evidence is missing or stale. */
	needsCalibration: string[];
}

function modelRouterPoolSummary(pool: ModelRouterPoolView | undefined): string {
	return pool ? pool.summary : screenText().values.unknown;
}

function modelRouterTierLabel(model: string | undefined, mode: ModelRouterSelectionMode | undefined): string {
	if (model) return model;
	return mode === "auto" || mode === "hybrid" ? screenText().values.auto : screenText().values.notSet;
}

function modelRouterSummary(settings: ModelRouterSettings, pool?: ModelRouterPoolView): string {
	const text = screenText();
	const state = settings.enabled ? text.summaries.enabled : text.summaries.disabled;
	const mode = text.valueLabels.routerSelection[settings.selectionMode ?? "manual"] ?? settings.selectionMode;
	const preference =
		text.valueLabels.routerPoolPreference[settings.poolPreference ?? "subscription-first"] ?? settings.poolPreference;
	const tier = (model: string | undefined) => modelRouterTierLabel(model, settings.selectionMode);
	const learn = optionalStringValue(settings.learningModel, DEFAULT_AUTO_LEARN_SETTINGS.model);
	return text.summaries.router({
		state,
		mode,
		pool: modelRouterPoolSummary(pool),
		preference,
		gate: text.summaries.routerGate(Boolean(settings.fitnessGate)),
		cheap: tier(settings.cheapModel),
		medium: tier(settings.mediumModel),
		expensive: tier(settings.expensiveModel),
		learn: learn === DEFAULT_AUTO_LEARN_SETTINGS.model ? text.values.active : learn,
	});
}

function buildAutoLearnModelOptions(
	settings: AutoLearnSettings,
	configuredModelOptions: SelectItem[] | undefined,
	currentModelPattern: string | undefined,
): SelectItem[] {
	const currentValue = autoLearnModelValue(settings);
	const options: SelectItem[] = [
		{
			value: DEFAULT_AUTO_LEARN_SETTINGS.model,
			label: screenText().values.active,
			description: currentModelPattern
				? screenText().modelPicker.activeOptionWithModel(currentModelPattern)
				: screenText().modelPicker.activeOption,
		},
	];
	const seen = new Set(options.map((option) => option.value));

	for (const option of configuredModelOptions ?? []) {
		if (seen.has(option.value)) continue;
		options.push(option);
		seen.add(option.value);
	}

	if (currentValue !== DEFAULT_AUTO_LEARN_SETTINGS.model && !seen.has(currentValue)) {
		options.push({
			value: currentValue,
			label: currentValue,
			description: screenText().modelPicker.customSetting,
		});
		seen.add(currentValue);
	}

	options.push({
		value: AUTO_LEARN_CUSTOM_MODEL_VALUE,
		label: screenText().modelPicker.manualOption,
		description: screenText().modelPicker.manualOptionDescription,
	});

	return options;
}

function buildModelRouterRoleModelOptions(options: {
	currentValue: string | undefined;
	configuredModelOptions: SelectItem[] | undefined;
	currentModelPattern: string | undefined;
	includeActive: boolean;
	unsetDescription?: string;
	/** "(AUTO)" for an auto-selected tier, "(unset)" otherwise. */
	unsetLabel?: string;
	/** The router's candidate pool; entries outside it are still selectable but marked. */
	pool?: ModelRouterPoolView;
}): SelectItem[] {
	const modelOptions: SelectItem[] = [];
	const seen = new Set<string>();

	if (options.includeActive) {
		modelOptions.push({
			value: DEFAULT_AUTO_LEARN_SETTINGS.model,
			label: screenText().values.active,
			description: options.currentModelPattern
				? screenText().modelPicker.activeOptionWithModel(options.currentModelPattern)
				: screenText().modelPicker.activeOption,
		});
		seen.add(DEFAULT_AUTO_LEARN_SETTINGS.model);
	} else {
		modelOptions.push({
			value: MODEL_ROUTER_UNSET_MODEL_VALUE,
			label: options.unsetLabel ?? screenText().values.unset,
			description: options.unsetDescription ?? screenText().modelPicker.clearModel,
		});
		seen.add(MODEL_ROUTER_UNSET_MODEL_VALUE);
	}

	// Show favorites and eligible models first; an excluded setting cannot authorize a route.
	const configured = options.configuredModelOptions ?? [];
	const pool = options.pool;
	const favorites = new Set(pool?.favoriteRefs ?? []);
	const inPool = new Set(pool?.refs ?? []);
	const ordered = pool
		? [
				...configured.filter((option) => favorites.has(option.value)),
				...configured.filter((option) => !favorites.has(option.value) && inPool.has(option.value)),
				...configured.filter((option) => !favorites.has(option.value) && !inPool.has(option.value)),
			]
		: configured;
	for (const option of ordered) {
		if (seen.has(option.value)) continue;
		const marks = [
			...(favorites.has(option.value) ? [screenText().modelPicker.favoriteMark] : []),
			...(pool && !inPool.has(option.value) ? [screenText().modelPicker.outsidePoolMark] : []),
		];
		modelOptions.push(
			marks.length > 0 ? { ...option, description: `${option.description} · ${marks.join(" · ")}` } : option,
		);
		seen.add(option.value);
	}

	const currentValue = options.currentValue?.trim();
	if (currentValue && !seen.has(currentValue)) {
		modelOptions.push({
			value: currentValue,
			label: currentValue,
			description: screenText().modelPicker.customSetting,
		});
		seen.add(currentValue);
	}

	modelOptions.push({
		value: AUTO_LEARN_CUSTOM_MODEL_VALUE,
		label: screenText().modelPicker.manualOption,
		description: screenText().modelPicker.manualOptionDescription,
	});

	return modelOptions;
}

function buildModelRouterThinkingOptions(
	inheritDescription: string,
	availableLevels: ThinkingLevel[] = Object.keys(THINKING_LEVEL_DESCRIPTIONS) as ThinkingLevel[],
): SelectItem[] {
	return [
		{
			value: MODEL_ROUTER_INHERIT_THINKING_VALUE,
			label: screenText().values.inherit,
			description: inheritDescription,
		},
		...availableLevels.map((level) => ({
			value: level,
			label: level,
			description: THINKING_LEVEL_DESCRIPTIONS[level],
		})),
	];
}

export interface SettingsConfig {
	autoCompact: boolean;
	costGuard: CostGuardSettings;
	costGuardScope?: SettingsScope;
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
	language: LanguageSetting;
	availableThemes: string[];
	hideThinkingBlock: boolean;
	projectContextFiles: "off" | "on-demand";
	projectContextFilesScope?: SettingsScope;
	collapseChangelog: boolean;
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
	researchLane: ResearchLaneSettings;
	researchLaneScope?: SettingsScope;
	workerDelegation: WorkerDelegationSettings;
	contextCuration: ContextCurationSettings;
	contextCurationScope?: SettingsScope;
	learningPolicy: LearningPolicySettings;
	learningPolicyScope?: SettingsScope;
	advisor?: AdvisorSettings & { error?: string };
	advisorScope?: SettingsScope;
	getAdvisorSettingsScope?: () => SettingsScope | undefined;
	modelCapability: ModelCapabilitySettings;
	modelCapabilityScope?: SettingsScope;
	workerDelegationScope?: SettingsScope;
	modelRouter: ModelRouterSettings;
	modelRouterScope?: SettingsScope;
	modelRouterPool?: ModelRouterPoolView;
	/** Which key System One authenticates with. */
	systemOneProvider?: SystemOneProviderChoice;
	/** What a provider choice resolves to right now (provider in force, or the key it lacks). */
	describeSystemOneAccess?: (choice: SystemOneProviderChoice) => string;
	autoLearn: AutoLearnSettings;
	autoLearnScope?: SettingsScope;
	contextPolicyEnforcement: ContextPromptEnforcementSettings;
	contextPolicyEnforcementScope?: SettingsScope;
	contextMemoryRetrieval: MemoryRetrievalSettings;
	contextMemoryRetrievalScope?: SettingsScope;
	currentModelPattern?: string;
	autoLearnModelOptions?: SelectItem[];
	/** Resolve the concrete thinking surface for a configured model pattern. */
	resolveModelThinkingLevels?: (modelPattern: string | undefined) => ThinkingLevel[] | undefined;
	/**
	 * Open the settings screen with this item already focused and its submenu open (e.g.
	 * "model-router" to land straight in Router Setup). Unknown ids leave the plain list showing.
	 */
	initialItemId?: string;
	activeProfileName?: string;
	profileOptions?: SelectItem[];
	externalResourceRoots?: string[];
	trustedResourceRoots?: string[];
}

export interface SettingsCallbacks {
	onAutoCompactChange: (enabled: boolean) => void;
	onCostGuardChange: (settings: CostGuardSettings, scope: SettingsScope) => void;
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
	onLanguageChange: (language: LanguageSetting) => void;
	onThemePreview?: (theme: string) => void;
	onHideThinkingBlockChange: (hidden: boolean) => void;
	onProjectContextFilesChange: (mode: "off" | "on-demand", scope: SettingsScope) => void;
	onCollapseChangelogChange: (collapsed: boolean) => void;
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
	onResearchLaneChange: (settings: ResearchLaneSettings, scope: SettingsScope) => void;
	onWorkerDelegationChange: (settings: WorkerDelegationSettings, scope: SettingsScope) => void;
	onContextCurationChange: (settings: ContextCurationSettings, scope: SettingsScope) => void;
	onLearningPolicyChange: (settings: LearningPolicySettings, scope: SettingsScope) => void;
	onAdvisorChange?: (settings: AdvisorSettings, scope: SettingsScope) => AdvisorSettings & { error?: string };
	onModelCapabilityChange: (settings: ModelCapabilitySettings, scope: SettingsScope) => void;
	onSystemOneProviderChange?: (choice: SystemOneProviderChoice) => void;
	onModelRouterChange: (settings: ModelRouterSettings, scope: SettingsScope) => void;
	onAutoLearnChange: (settings: AutoLearnSettings, scope: SettingsScope) => void;
	onContextPolicyEnforcementChange: (settings: ContextPromptEnforcementSettings, scope: SettingsScope) => void;
	onContextMemoryRetrievalChange: (settings: MemoryRetrievalSettings, scope: SettingsScope) => void;
	onResourcesHubAction?: (action: string) => void;
	/** Router Setup actions: configure-models, calibrate-*, preview:<task>, preview-live:<task>, diagnostics. */
	onModelRouterAction?: (action: string) => void;
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
		emptyHint = screenText().hints.emptyClearsSetting,
	) {
		super();

		this.addChild(new SelectorHeading(title, description));

		this.input = new Input();
		this.input.setValue(currentValue);
		this.input.focused = true;
		this.input.onSubmit = onSubmit;
		this.input.onEscape = onCancel;
		this.addChild(this.input);

		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", `  ${screenText().hints.textInput(emptyHint)}`), 0, 0));
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
			title: screenText().modelPicker.autoLearn.title,
			description: screenText().modelPicker.autoLearn.description,
			customTitle: screenText().modelPicker.autoLearn.customTitle,
			customDescription: screenText().modelPicker.autoLearn.customDescription,
			customEmptyHint: screenText().modelPicker.autoLearn.customEmptyHint,
			customEmptyValue: DEFAULT_AUTO_LEARN_SETTINGS.model,
		},
	) {
		super();

		this.addChild(new SelectorHeading(labels.title, labels.description));

		this.searchInput = new Input();
		this.searchInput.focused = true;
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		this.selectList = new SelectList(
			options,
			Math.min(options.length, 10),
			getSelectListTheme(),
			COMPACT_SELECTOR_LIST_LAYOUT,
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
		this.addChild(new Text(theme.fg("dim", `  ${screenText().hints.filterAndSelect}`), 0, 0));
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

class SettingsListSubmenu extends Container {
	private settingsList!: SettingsList;

	protected mountSettingsList(
		items: SettingItem[],
		onChange: (id: string, newValue: string) => void,
		onCancel: () => void,
	): void {
		this.settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			onChange,
			onCancel,
			{
			},
		);
		this.addChild(this.settingsList);
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

class CostGuardSettingsSubmenu extends SettingsListSubmenu {
	private state: CostGuardSettings;
	private scope: SettingsScope;

	constructor(
		settings: CostGuardSettings,
		onChange: (settings: CostGuardSettings, scope: SettingsScope) => void,
		onCancel: () => void,
		scope: SettingsScope = "global",
	) {
		super();
		this.state = { ...settings };
		this.scope = scope;
		this.mountSettingsList(
			[
				{
					id: "cost-guard-scope",
					label: screenText().costGuard.scope.label,
					description: screenText().costGuard.scope.description,
					currentValue: this.scope,
					values: ["global", "project"],
					valueLabels: screenText().valueLabels.scope,
				},
				{
					id: "cost-guard-enabled",
					label: screenText().costGuard.enabled.label,
					description: screenText().costGuard.enabled.description,
					currentValue: String(this.state.enabled),
					values: ["false", "true"],
					valueLabels: screenText().valueLabels.onOff,
				},
				{
					id: "cost-guard-max-turn-usd",
					label: screenText().costGuard.maxTurnUsd.label,
					description: screenText().costGuard.maxTurnUsd.description,
					currentValue: String(this.state.maxTurnUsd),
					submenu: (_currentValue, done) =>
						new TextInputSubmenu(
							screenText().costGuard.title,
							screenText().costGuard.description,
							String(this.state.maxTurnUsd),
							(value) => {
								const maxTurnUsd = Number(value.trim());
								if (!Number.isFinite(maxTurnUsd) || maxTurnUsd < 0) {
									done();
									return;
								}
								this.state = { ...this.state, maxTurnUsd };
								onChange({ ...this.state }, this.scope);
								done(String(maxTurnUsd));
							},
							() => done(),
							screenText().costGuard.hint,
						),
				},
				{
					id: "cost-guard-action",
					label: screenText().costGuard.action.label,
					description: screenText().costGuard.action.description,
					currentValue: this.state.action,
					values: ["warn", "downgrade"],
					valueLabels: screenText().valueLabels.costGuardAction,
				},
			],
			(id, newValue) => {
				switch (id) {
					case "cost-guard-scope":
						this.scope = newValue as SettingsScope;
						break;
					case "cost-guard-enabled":
						this.state = {
							...this.state,
							enabled: newValue === "true",
							maxTurnUsd:
								newValue === "true" && this.state.maxTurnUsd <= 0
									? DEFAULT_ENABLED_COST_GUARD_MAX_TURN_USD
									: this.state.maxTurnUsd,
						};
						break;
					case "cost-guard-action":
						this.state = { ...this.state, action: newValue === "downgrade" ? "downgrade" : "warn" };
						break;
					default:
						return;
				}
				onChange({ ...this.state }, this.scope);
			},
			onCancel,
		);
	}
}

const PROJECT_CONTEXT_SCOPE_VALUES = ["this-directory", "this-project", "all-projects"] as const;
type ProjectContextScopeValue = (typeof PROJECT_CONTEXT_SCOPE_VALUES)[number];

function projectContextScopeValue(scope: SettingsScope | undefined): ProjectContextScopeValue {
	if (scope === "project") return "this-project";
	if (scope === "global") return "all-projects";
	return "this-directory";
}

function projectContextScopeFromValue(value: string): SettingsScope {
	if (value === "this-project") return "project";
	if (value === "all-projects") return "global";
	return "directoryProfile";
}

function projectContextFilesSummary(mode: "off" | "on-demand", scope: SettingsScope | undefined): string {
	if (mode !== "on-demand") return "global only";
	if (scope === "project") return "this project";
	if (scope === "global") return "all projects";
	return "this directory";
}

class ProjectContextFilesSubmenu extends SettingsListSubmenu {
	private mode: "off" | "on-demand";
	private scope: SettingsScope;

	constructor(
		mode: "off" | "on-demand",
		onChange: (mode: "off" | "on-demand", scope: SettingsScope) => void,
		onCancel: () => void,
		scope: SettingsScope = "directoryProfile",
	) {
		super();
		this.mode = mode;
		this.scope = scope;
		this.mountSettingsList(
			[
				{
					id: "project-context-scope",
					label: screenText().projectContext.scope.label,
					description: screenText().projectContext.scope.description,
					currentValue: projectContextScopeValue(this.scope),
					values: [...PROJECT_CONTEXT_SCOPE_VALUES],
					valueLabels: screenText().valueLabels.projectContextScope,
				},
				{
					id: "project-context-load",
					label: screenText().projectContext.load.label,
					description: screenText().projectContext.load.description,
					currentValue: this.mode === "on-demand" ? "on-demand" : "global-only",
					values: ["global-only", "on-demand"],
					valueLabels: screenText().valueLabels.projectContextLoad,
				},
			],
			(id, newValue) => {
				if (id === "project-context-scope") {
					this.scope = projectContextScopeFromValue(newValue);
					onChange(this.mode, this.scope);
					return;
				}
				this.mode = newValue === "on-demand" ? "on-demand" : "off";
				onChange(this.mode, this.scope);
			},
			onCancel,
		);
	}
}

class SelfModificationSettingsSubmenu extends SettingsListSubmenu {
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
				label: screenText().selfModification.scope.label,
				description: screenText().selfModification.scope.description,
				currentValue: this.scope,
				values: ["global", "project"],
				valueLabels: screenText().valueLabels.scope,
			},
			{
				id: "self-modification-enabled",
				label: screenText().selfModification.enabled.label,
				description: screenText().selfModification.enabled.description,
				currentValue: booleanSettingValue(this.state.enabled),
				values: ["true", "false"],
				valueLabels: screenText().valueLabels.onOff,
			},
			{
				id: "self-modification-source-path",
				label: screenText().selfModification.sourcePath.label,
				description: screenText().selfModification.sourcePath.description,
				currentValue: optionalStringValue(this.state.sourcePath),
				submenu: (_currentValue, done) =>
					new TextInputSubmenu(
						screenText().selfModification.sourcePathTitle,
						screenText().selfModification.sourcePathDescription,
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

		this.mountSettingsList(
			items,
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
	}
}

class AutonomySettingsSubmenu extends SettingsListSubmenu {
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
				label: screenText().autonomy.scope.label,
				description: screenText().autonomy.scope.description,
				currentValue: this.scope,
				values: ["global", "project"],
				valueLabels: screenText().valueLabels.scope,
			},
			{
				id: "autonomy-mode",
				label: screenText().autonomy.mode.label,
				description: screenText().autonomy.mode.description,
				currentValue: autonomyModeValue(this.state),
				values: AUTONOMY_MODES,
				valueLabels: screenText().valueLabels.autonomyMode,
			},
			{
				id: "autonomy-goal-auto-continue",
				label: screenText().autonomy.autoContinue.label,
				description: screenText().autonomy.autoContinue.description,
				currentValue: autonomyGoalAutoContinueValue(this.state),
				values: ["true", "false"],
				valueLabels: screenText().valueLabels.onOff,
			},
			{
				id: "autonomy-goal-continue-turns",
				label: screenText().autonomy.turns.label,
				description: screenText().autonomy.turns.description,
				currentValue: autonomyGoalContinueTurnsValue(this.state),
				values: AUTONOMY_GOAL_CONTINUE_TURN_VALUES,
			},
			{
				id: "autonomy-max-stall-turns",
				label: screenText().autonomy.recoveryThreshold.label,
				description: screenText().autonomy.recoveryThreshold.description,
				currentValue: autonomyMaxStallTurnsValue(this.state),
				values: AUTONOMY_MAX_STALL_TURN_VALUES,
			},
			{
				id: "autonomy-goal-wall-clock-minutes",
				label: screenText().autonomy.maxMinutes.label,
				description: screenText().autonomy.maxMinutes.description,
				currentValue: autonomyGoalContinueMaxWallClockMinutesValue(this.state),
				values: AUTONOMY_GOAL_CONTINUE_MAX_WALL_CLOCK_MINUTE_VALUES,
			},
			{
				id: "autonomy-goal-auto-continue-delay-ms",
				label: screenText().autonomy.delayMs.label,
				description: screenText().autonomy.delayMs.description,
				currentValue: autonomyGoalAutoContinueDelayMsValue(this.state),
				values: AUTONOMY_GOAL_AUTO_CONTINUE_DELAY_MS_VALUES,
			},
		];

		this.mountSettingsList(
			items,
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
	}
}

class ResearchLaneSettingsSubmenu extends SettingsListSubmenu {
	private state: ResearchLaneSettings;
	private scope: SettingsScope;

	constructor(
		settings: ResearchLaneSettings,
		onChange: (settings: ResearchLaneSettings, scope: SettingsScope) => void,
		onCancel: () => void,
		scope: SettingsScope = "global",
	) {
		super();
		this.state = {
			...settings,
			enabled: settings.enabled ?? DEFAULT_RESEARCH_LANE_ENABLED,
			maxUsd: settings.maxUsd ?? DEFAULT_RESEARCH_LANE_MAX_USD,
			maxWallClockMs: settings.maxWallClockMs ?? DEFAULT_RESEARCH_LANE_MAX_WALL_CLOCK_MS,
			idleDelayMs: settings.idleDelayMs ?? DEFAULT_RESEARCH_LANE_IDLE_DELAY_MS,
			maxRunsPerSession: settings.maxRunsPerSession ?? DEFAULT_RESEARCH_LANE_MAX_RUNS_PER_SESSION,
		};
		this.scope = scope;

		const items: SettingItem[] = [
			{
				id: "research-lane-scope",
				label: screenText().researchLane.scope.label,
				description: screenText().researchLane.scope.description,
				currentValue: this.scope,
				values: ["global", "project"],
				valueLabels: screenText().valueLabels.scope,
			},
			{
				id: "research-lane-enabled",
				label: screenText().researchLane.enabled.label,
				description: screenText().researchLane.enabled.description,
				currentValue: String(this.state.enabled),
				values: ["true", "false"],
				valueLabels: screenText().valueLabels.onOff,
			},
			{
				id: "research-lane-max-usd",
				label: screenText().researchLane.budget.label,
				description: screenText().researchLane.budget.description,
				currentValue: String(this.state.maxUsd),
				values: RESEARCH_LANE_MAX_USD_VALUES,
			},
			{
				id: "research-lane-max-wall-clock-ms",
				label: screenText().researchLane.maxMilliseconds.label,
				description: screenText().researchLane.maxMilliseconds.description,
				currentValue: String(this.state.maxWallClockMs),
				values: RESEARCH_LANE_MAX_WALL_CLOCK_MS_VALUES,
			},
			{
				id: "research-lane-idle-delay-ms",
				label: screenText().researchLane.idleDelayMs.label,
				description: screenText().researchLane.idleDelayMs.description,
				currentValue: String(this.state.idleDelayMs),
				values: RESEARCH_LANE_IDLE_DELAY_MS_VALUES,
			},
			{
				id: "research-lane-max-runs-per-session",
				label: screenText().researchLane.runsPerSession.label,
				description: screenText().researchLane.runsPerSession.description,
				currentValue: String(this.state.maxRunsPerSession),
				values: RESEARCH_LANE_MAX_RUNS_PER_SESSION_VALUES,
			},
		];

		this.mountSettingsList(
			items,
			(id, newValue) => {
				switch (id) {
					case "research-lane-scope":
						this.scope = newValue as SettingsScope;
						break;
					case "research-lane-enabled":
						this.state = { ...this.state, enabled: newValue === "true" };
						break;
					case "research-lane-max-usd":
						this.state = { ...this.state, maxUsd: Number(newValue) };
						break;
					case "research-lane-max-wall-clock-ms":
						this.state = { ...this.state, maxWallClockMs: Number(newValue) };
						break;
					case "research-lane-idle-delay-ms":
						this.state = { ...this.state, idleDelayMs: Number(newValue) };
						break;
					case "research-lane-max-runs-per-session":
						this.state = { ...this.state, maxRunsPerSession: Number(newValue) };
						break;
					default:
						return;
				}
				onChange({ ...this.state }, this.scope);
			},
			onCancel,
		);
	}
}

class LearningPolicySettingsSubmenu extends SettingsListSubmenu {
	private state: LearningPolicySettings;
	private scope: SettingsScope;

	constructor(
		settings: LearningPolicySettings,
		onChange: (settings: LearningPolicySettings, scope: SettingsScope) => void,
		onCancel: () => void,
		scope: SettingsScope = "global",
	) {
		super();
		this.state = { ...settings };
		this.scope = scope;
		const items: SettingItem[] = [
			{
				id: "learning-policy-scope",
				label: screenText().learningPolicy.scope.label,
				description: screenText().learningPolicy.scope.description,
				currentValue: this.scope,
				values: ["global", "project"],
				valueLabels: screenText().valueLabels.scope,
			},
			{
				id: "learning-policy-enabled",
				label: screenText().learningPolicy.enabled.label,
				description: screenText().learningPolicy.enabled.description,
				currentValue: String(this.state.enabled ?? DEFAULT_LEARNING_POLICY_ENABLED),
				values: ["true", "false"],
				valueLabels: screenText().valueLabels.onOff,
			},
			{
				id: "learning-policy-auto-apply",
				label: screenText().learningPolicy.autoApply.label,
				description: screenText().learningPolicy.autoApply.description,
				currentValue: String(this.state.autoApplyEnabled ?? DEFAULT_LEARNING_POLICY_AUTO_APPLY_ENABLED),
				values: ["true", "false"],
				valueLabels: screenText().valueLabels.onOff,
			},
			{
				id: "learning-policy-auto-apply-supersessions",
				label: screenText().learningPolicy.autoApplySupersessions.label,
				description: screenText().learningPolicy.autoApplySupersessions.description,
				currentValue: String(this.state.autoApplySupersessions ?? DEFAULT_LEARNING_POLICY_AUTO_APPLY_SUPERSESSIONS),
				values: ["true", "false"],
				valueLabels: screenText().valueLabels.onOff,
			},
			{
				id: "learning-policy-confidence",
				label: screenText().learningPolicy.confidence.label,
				description: screenText().learningPolicy.confidence.description,
				currentValue: String(this.state.confidenceThreshold ?? DEFAULT_LEARNING_POLICY_CONFIDENCE_THRESHOLD),
				values: ["25", "50", "60", "75", "90"],
			},
			{
				id: "learning-policy-min-observations",
				label: screenText().learningPolicy.minObservations.label,
				description: screenText().learningPolicy.minObservations.description,
				currentValue: String(this.state.minObservations ?? DEFAULT_LEARNING_POLICY_MIN_OBSERVATIONS),
				values: ["1", "2", "3", "5"],
			},
		];
		this.mountSettingsList(
			items,
			(id, newValue) => {
				switch (id) {
					case "learning-policy-scope":
						this.scope = newValue as SettingsScope;
						break;
					case "learning-policy-enabled":
						this.state = { ...this.state, enabled: newValue === "true" };
						break;
					case "learning-policy-auto-apply":
						this.state = { ...this.state, autoApplyEnabled: newValue === "true" };
						break;
					case "learning-policy-auto-apply-supersessions":
						this.state = { ...this.state, autoApplySupersessions: newValue === "true" };
						break;
					case "learning-policy-confidence":
						this.state = { ...this.state, confidenceThreshold: Number(newValue) };
						break;
					case "learning-policy-min-observations":
						this.state = { ...this.state, minObservations: Number(newValue) };
						break;
					default:
						return;
				}
				onChange({ ...this.state }, this.scope);
			},
			onCancel,
		);
	}
}

class AdvisorSettingsSubmenu extends SettingsListSubmenu {
	constructor(
		settings: AdvisorSettings,
		modelOptions: SelectItem[],
		resolveLevels: (model?: string) => ThinkingLevel[] | undefined,
		onChange: (settings: AdvisorSettings, scope: SettingsScope) => AdvisorSettings,
		onCancel: () => void,
		scope: SettingsScope,
	) {
		super();
		let state = { ...settings };
		let saveScope = scope;
		const publish = () => {
			state = { ...onChange({ ...state }, saveScope) };
			items.find((item) => item.id === "advisor-enabled")!.currentValue = String(state.enabled ?? true);
			items.find((item) => item.id === "advisor-model")!.currentValue =
				state.model ?? screenText().values.agentChooses;
			items.find((item) => item.id === "advisor-thinking")!.currentValue =
				state.thinkingLevel ?? screenText().values.agentChooses;
		};
		const items: SettingItem[] = [
			{
				id: "advisor-scope",
				label: screenText().peer.scope.label,
				description: screenText().peer.scope.description,
				currentValue: saveScope,
				values: ["global", "project", "directoryProfile"],
				valueLabels: screenText().valueLabels.scope,
			},
			{
				id: "advisor-enabled",
				label: screenText().peer.enabled.label,
				description: screenText().peer.enabled.description,
				currentValue: String(state.enabled ?? true),
				values: ["true", "false"],
				valueLabels: screenText().valueLabels.onOff,
			},
			{
				id: "advisor-model",
				label: screenText().peer.model.label,
				description: screenText().peer.model.description,
				currentValue: state.model ?? screenText().values.agentChooses,
				submenu: (_value, done) =>
					new ModelSelectionSubmenu(
						[
							{
								value: "",
								label: screenText().values.agentChooses,
								description: screenText().peer.choosesForEachReview,
							},
							...modelOptions,
						],
						state.model ?? "",
						(value) => {
							const model = value || undefined;
							const levels = model ? resolveLevels(model) : undefined;
							state = {
								...state,
								model,
								enabled: true,
								thinkingLevel:
									state.thinkingLevel && levels?.includes(state.thinkingLevel)
										? state.thinkingLevel
										: undefined,
							};
							publish();
							done(state.model ?? screenText().values.agentChooses);
						},
						() => done(),
						{
							title: screenText().modelPicker.peer.title,
							description: screenText().modelPicker.peer.description,
							customTitle: screenText().modelPicker.peer.customTitle,
							customDescription: screenText().modelPicker.peer.customDescription,
							customEmptyHint: screenText().modelPicker.peer.customEmptyHint,
							customEmptyValue: "",
						},
					),
			},
			{
				id: "advisor-thinking",
				label: screenText().peer.thinking.label,
				description: screenText().peer.thinking.description,
				currentValue: state.thinkingLevel ?? screenText().values.agentChooses,
				submenu: (_value, done) =>
					new SelectSubmenu(
						screenText().peer.thinkingTitle,
						screenText().peer.thinkingDescription,
						[
							{ value: "", label: screenText().values.agentChooses },
							...(state.model ? (resolveLevels(state.model) ?? []) : []).map((level) => ({
								value: level,
								label: level,
							})),
						],
						state.thinkingLevel ?? "",
						(value) => {
							state = { ...state, thinkingLevel: value ? (value as ThinkingLevel) : undefined };
							publish();
							done(state.thinkingLevel ?? screenText().values.agentChooses);
						},
						() => done(),
					),
			},
		];
		this.mountSettingsList(
			items,
			(id, value) => {
				if (id === "advisor-scope") {
					saveScope = value as SettingsScope;
					return;
				} else if (id === "advisor-enabled") state = { ...state, enabled: value === "true" };
				else return;
				publish();
			},
			onCancel,
		);
	}
}

class ModelCapabilitySettingsSubmenu extends SettingsListSubmenu {
	private state: ModelCapabilitySettings;
	private scope: SettingsScope;

	constructor(
		settings: ModelCapabilitySettings,
		onChange: (settings: ModelCapabilitySettings, scope: SettingsScope) => void,
		onCancel: () => void,
		scope: SettingsScope = "global",
	) {
		super();
		this.state = { ...settings };
		this.scope = scope;
		const items: SettingItem[] = [
			{
				id: "model-capability-scope",
				label: screenText().modelCapability.scope.label,
				description: screenText().modelCapability.scope.description,
				currentValue: this.scope,
				values: ["global", "project"],
				valueLabels: screenText().valueLabels.scope,
			},
			{
				id: "model-capability-mode",
				label: screenText().modelCapability.mode.label,
				description: screenText().modelCapability.mode.description,
				currentValue: this.state.mode ?? "auto",
				values: ["auto", "off", "full", "lean", "minimal", "chat"],
				valueLabels: screenText().valueLabels.modelCapability,
			},
		];
		this.mountSettingsList(
			items,
			(id, newValue) => {
				switch (id) {
					case "model-capability-scope":
						this.scope = newValue as SettingsScope;
						break;
					case "model-capability-mode":
						this.state = { ...this.state, mode: newValue as ModelCapabilitySettings["mode"] };
						break;
					default:
						return;
				}
				onChange({ ...this.state }, this.scope);
			},
			onCancel,
		);
	}
}

class ContextCurationSettingsSubmenu extends SettingsListSubmenu {
	private state: ContextCurationSettings;
	private scope: SettingsScope;

	constructor(
		settings: ContextCurationSettings,
		modelOptions: SelectItem[] | undefined,
		onChange: (settings: ContextCurationSettings, scope: SettingsScope) => void,
		onCancel: () => void,
		scope: SettingsScope = "global",
	) {
		super();
		this.state = {
			...settings,
			enabled: settings.enabled ?? false,
			maxJobsPerTurn: settings.maxJobsPerTurn ?? 4,
		};
		this.scope = scope;

		const modelValues = ["(unset)", ...(modelOptions ?? []).map((option) => option.value).filter(Boolean)];
		const items: SettingItem[] = [
			{
				id: "context-curation-scope",
				label: screenText().contextCuration.scope.label,
				description: screenText().contextCuration.scope.description,
				currentValue: this.scope,
				values: ["global", "project"],
				valueLabels: screenText().valueLabels.scope,
			},
			{
				id: "context-curation-enabled",
				label: screenText().contextCuration.enabled.label,
				description: screenText().contextCuration.enabled.description,
				currentValue: String(this.state.enabled),
				values: ["true", "false"],
				valueLabels: screenText().valueLabels.onOff,
			},
			{
				id: "context-curation-model",
				label: screenText().contextCuration.model.label,
				description: screenText().contextCuration.model.description,
				currentValue: this.state.model ?? "(unset)",
				values: modelValues,
				valueLabels: screenText().valueLabels.unsetModel,
			},
			{
				id: "context-curation-max-jobs",
				label: screenText().contextCuration.maxJobsPerTurn.label,
				description: screenText().contextCuration.maxJobsPerTurn.description,
				currentValue: String(this.state.maxJobsPerTurn),
				values: ["1", "2", "4", "8", "16"],
			},
		];

		this.mountSettingsList(
			items,
			(id, newValue) => {
				switch (id) {
					case "context-curation-scope":
						this.scope = newValue as SettingsScope;
						break;
					case "context-curation-enabled":
						this.state = { ...this.state, enabled: newValue === "true" };
						break;
					case "context-curation-model":
						this.state = { ...this.state, model: newValue === "(unset)" ? undefined : newValue };
						break;
					case "context-curation-max-jobs":
						this.state = { ...this.state, maxJobsPerTurn: Number(newValue) };
						break;
					default:
						return;
				}
				onChange({ ...this.state }, this.scope);
			},
			onCancel,
		);
	}
}

class WorkerDelegationSettingsSubmenu extends SettingsListSubmenu {
	private state: WorkerDelegationSettings;
	private scope: SettingsScope;

	constructor(
		settings: WorkerDelegationSettings,
		onChange: (settings: WorkerDelegationSettings, scope: SettingsScope) => void,
		onCancel: () => void,
		scope: SettingsScope = "global",
	) {
		super();
		this.state = {
			...settings,
			enabled: settings.enabled ?? DEFAULT_WORKER_DELEGATION_ENABLED,
			maxUsd: settings.maxUsd ?? DEFAULT_WORKER_DELEGATION_MAX_USD,
			maxWallClockMs: settings.maxWallClockMs ?? DEFAULT_WORKER_DELEGATION_MAX_WALL_CLOCK_MS,
		};
		this.scope = scope;

		const items: SettingItem[] = [
			{
				id: "worker-delegation-scope",
				label: screenText().workerDelegation.scope.label,
				description: screenText().workerDelegation.scope.description,
				currentValue: this.scope,
				values: ["global", "project"],
				valueLabels: screenText().valueLabels.scope,
			},
			{
				id: "worker-delegation-enabled",
				label: screenText().workerDelegation.enabled.label,
				description: screenText().workerDelegation.enabled.description,
				currentValue: String(this.state.enabled),
				values: ["true", "false"],
				valueLabels: screenText().valueLabels.onOff,
			},
			{
				id: "worker-delegation-max-usd",
				label: screenText().workerDelegation.budget.label,
				description: screenText().workerDelegation.budget.description,
				currentValue: String(this.state.maxUsd),
				submenu: (_currentValue, done) =>
					new TextInputSubmenu(
						screenText().workerDelegation.budgetTitle,
						screenText().workerDelegation.budgetDescription(MAX_WORKER_DELEGATION_MAX_USD),
						String(this.state.maxUsd),
						(value) => {
							const maxUsd = Number(value.trim());
							if (Number.isFinite(maxUsd) && maxUsd >= 0 && maxUsd <= MAX_WORKER_DELEGATION_MAX_USD) {
								this.state = { ...this.state, maxUsd };
								done(String(maxUsd));
								return;
							}
							done();
						},
						() => done(),
						screenText().workerDelegation.budgetHint(MAX_WORKER_DELEGATION_MAX_USD),
					),
			},
			{
				id: "worker-delegation-max-wall-clock-ms",
				label: screenText().workerDelegation.milliseconds.label,
				description: screenText().workerDelegation.milliseconds.description,
				currentValue: String(this.state.maxWallClockMs),
				submenu: (_currentValue, done) =>
					new TextInputSubmenu(
						screenText().workerDelegation.millisecondsTitle,
						screenText().workerDelegation.millisecondsDescription,
						String(this.state.maxWallClockMs),
						(value) => {
							const maxWallClockMs = Number(value.trim());
							if (Number.isSafeInteger(maxWallClockMs) && maxWallClockMs >= 0) {
								this.state = { ...this.state, maxWallClockMs };
								done(String(maxWallClockMs));
								return;
							}
							done();
						},
						() => done(),
						screenText().workerDelegation.millisecondsHint,
					),
			},
			{
				id: "worker-delegation-write-enabled",
				label: screenText().workerDelegation.writeEnabled.label,
				description: screenText().workerDelegation.writeEnabled.description,
				currentValue: String(this.state.writeEnabled ?? DEFAULT_WORKER_DELEGATION_WRITE_ENABLED),
				values: ["true", "false"],
				valueLabels: screenText().valueLabels.onOff,
			},
		];

		this.mountSettingsList(
			items,
			(id, newValue) => {
				switch (id) {
					case "worker-delegation-scope":
						this.scope = newValue as SettingsScope;
						break;
					case "worker-delegation-enabled":
						this.state = { ...this.state, enabled: newValue === "true" };
						break;
					case "worker-delegation-max-usd":
						this.state = { ...this.state, maxUsd: Number(newValue) };
						break;
					case "worker-delegation-max-wall-clock-ms":
						this.state = { ...this.state, maxWallClockMs: Number(newValue) };
						break;
					case "worker-delegation-write-enabled":
						this.state = { ...this.state, writeEnabled: newValue === "true" };
						break;
					default:
						return;
				}
				onChange({ ...this.state }, this.scope);
			},
			onCancel,
		);
	}
}

class AutoLearnSettingsSubmenu extends SettingsListSubmenu {
	private state: AutoLearnSettings;
	private scope: SettingsScope;

	constructor(
		settings: AutoLearnSettings,
		autonomyMode: AutonomyMode,
		currentModelPattern: string | undefined,
		modelOptions: SelectItem[] | undefined,
		onChange: (settings: AutoLearnSettings, scope: SettingsScope) => void,
		onCancel: () => void,
		scope: SettingsScope = "global",
	) {
		super();

		this.state = { ...settings };
		this.scope = scope;
		const defaults = resolveAutoLearnSettings(autonomyMode, settings);
		const modelDescription = screenText().autoLearn.model.description(currentModelPattern);
		const selectableModelOptions = buildAutoLearnModelOptions(this.state, modelOptions, currentModelPattern);

		const items: SettingItem[] = [
			{
				id: "auto-learn-scope",
				label: screenText().autoLearn.scope.label,
				description: screenText().autoLearn.scope.description,
				currentValue: this.scope,
				values: ["global", "project"],
				valueLabels: screenText().valueLabels.scope,
			},
			{
				id: "auto-learn-enabled",
				label: screenText().autoLearn.enabled.label,
				description: screenText().autoLearn.enabled.description,
				currentValue: booleanSettingValue(this.state.enabled, defaults.enabled),
				values: ["true", "false"],
				valueLabels: screenText().valueLabels.onOff,
			},
			{
				id: "auto-learn-model",
				label: screenText().autoLearn.model.label,
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
				label: screenText().autoLearn.messageTrigger.label,
				description: screenText().autoLearn.messageTrigger.description,
				currentValue: numberSettingValue(this.state.longSessionMessages, defaults.longSessionMessages),
				values: ["16", "32", "64", "128", "256"],
			},
			{
				id: "auto-learn-context-percent",
				label: screenText().autoLearn.contextTrigger.label,
				description: screenText().autoLearn.contextTrigger.description,
				currentValue: numberSettingValue(this.state.longSessionContextPercent, defaults.longSessionContextPercent),
				values: ["50", "60", "70", "80", "85", "90"],
			},
			{
				id: "auto-learn-cooldown-minutes",
				label: screenText().autoLearn.cooldown.label,
				description: screenText().autoLearn.cooldown.description,
				currentValue: numberSettingValue(this.state.cooldownMinutes, defaults.cooldownMinutes),
				values: ["15", "30", "60", "120", "240", "1440"],
			},
			{
				id: "auto-learn-lease-minutes",
				label: screenText().autoLearn.lease.label,
				description: screenText().autoLearn.lease.description,
				currentValue: numberSettingValue(this.state.leaseMinutes, defaults.leaseMinutes),
				values: ["30", "60", "90", "180"],
			},
			{
				id: "auto-learn-max-concurrent",
				label: screenText().autoLearn.maxLearners.label,
				description: screenText().autoLearn.maxLearners.description,
				currentValue: numberSettingValue(this.state.maxConcurrentLearners, defaults.maxConcurrentLearners),
				values: ["1", "2", "3", "4"],
			},
			{
				id: "auto-learn-apply-high-confidence",
				label: screenText().autoLearn.applyHighConfidence.label,
				description: screenText().autoLearn.applyHighConfidence.description,
				currentValue: booleanSettingValue(this.state.applyHighConfidence, defaults.applyHighConfidence),
				values: ["false", "true"],
				valueLabels: screenText().valueLabels.onOff,
			},
			{
				id: "auto-learn-reflection-review",
				label: screenText().autoLearn.reflectionReview.label,
				description: screenText().autoLearn.reflectionReview.description,
				currentValue: booleanSettingValue(this.state.reflectionReview, defaults.reflectionReview),
				values: ["true", "false"],
				valueLabels: screenText().valueLabels.onOff,
			},
			{
				id: "auto-learn-reflection-tool-calls",
				label: screenText().autoLearn.reflectionToolTrigger.label,
				description: screenText().autoLearn.reflectionToolTrigger.description,
				currentValue: numberSettingValue(this.state.reflectionMinToolCalls, defaults.reflectionMinToolCalls),
				values: ["3", "5", "8", "12"],
			},
			{
				id: "auto-learn-reflection-cooldown",
				label: screenText().autoLearn.reflectionCooldown.label,
				description: screenText().autoLearn.reflectionCooldown.description,
				currentValue: numberSettingValue(this.state.reflectionCooldownMinutes, defaults.reflectionCooldownMinutes),
				values: ["15", "30", "60", "120", "1440"],
			},
		];

		this.mountSettingsList(
			items,
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
	}
}

class ContextPolicyEnforcementSettingsSubmenu extends SettingsListSubmenu {
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
				label: screenText().contextPolicy.scope.label,
				description: screenText().contextPolicy.scope.description,
				currentValue: this.scope,
				values: ["global", "project"],
				valueLabels: screenText().valueLabels.scope,
			},
			{
				id: "context-policy-enabled",
				label: screenText().contextPolicy.enabled.label,
				description: screenText().contextPolicy.enabled.description,
				currentValue: booleanSettingValue(this.state.enabled, CONTEXT_POLICY_ENFORCEMENT_DEFAULTS.enabled),
				values: ["false", "true"],
				valueLabels: screenText().valueLabels.onOff,
			},
			{
				id: "context-policy-preserve-recent-messages",
				label: screenText().contextPolicy.preserveRecent.label,
				description: screenText().contextPolicy.preserveRecent.description,
				currentValue: numberSettingValue(
					this.state.preserveRecentMessages,
					CONTEXT_POLICY_ENFORCEMENT_DEFAULTS.preserveRecentMessages,
				),
				values: CONTEXT_POLICY_PRESERVE_RECENT_MESSAGES_VALUES,
			},
			{
				id: "context-policy-min-chars",
				label: screenText().contextPolicy.minChars.label,
				description: screenText().contextPolicy.minChars.description,
				currentValue: numberSettingValue(this.state.minChars, CONTEXT_POLICY_ENFORCEMENT_DEFAULTS.minChars),
				values: CONTEXT_POLICY_MIN_CHARS_VALUES,
			},
		];

		this.mountSettingsList(
			items,
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
	}
}

class ContextMemoryRetrievalSettingsSubmenu extends SettingsListSubmenu {
	private state: MemoryRetrievalSettings;
	private scope: SettingsScope;

	constructor(
		settings: MemoryRetrievalSettings,
		onChange: (settings: MemoryRetrievalSettings, scope: SettingsScope) => void,
		onCancel: () => void,
		scope: SettingsScope = "global",
	) {
		super();

		this.state = {
			enabled: settings.enabled ?? CONTEXT_MEMORY_RETRIEVAL_DEFAULTS.enabled,
			maxResults: settings.maxResults ?? CONTEXT_MEMORY_RETRIEVAL_DEFAULTS.maxResults,
			includeInPrompt: settings.includeInPrompt ?? CONTEXT_MEMORY_RETRIEVAL_DEFAULTS.includeInPrompt,
			allowExternalEgress: settings.allowExternalEgress ?? CONTEXT_MEMORY_RETRIEVAL_DEFAULTS.allowExternalEgress,
		};
		this.scope = scope;

		const items: SettingItem[] = [
			{
				id: "context-memory-scope",
				label: screenText().contextMemory.scope.label,
				description: screenText().contextMemory.scope.description,
				currentValue: this.scope,
				values: ["global", "project"],
				valueLabels: screenText().valueLabels.scope,
			},
			{
				id: "context-memory-enabled",
				label: screenText().contextMemory.enabled.label,
				description: screenText().contextMemory.enabled.description,
				currentValue: booleanSettingValue(this.state.enabled, CONTEXT_MEMORY_RETRIEVAL_DEFAULTS.enabled),
				values: ["false", "true"],
				valueLabels: screenText().valueLabels.onOff,
			},
			{
				id: "context-memory-max-results",
				label: screenText().contextMemory.maxResults.label,
				description: screenText().contextMemory.maxResults.description,
				currentValue: numberSettingValue(this.state.maxResults, CONTEXT_MEMORY_RETRIEVAL_DEFAULTS.maxResults),
				values: CONTEXT_MEMORY_RETRIEVAL_MAX_RESULTS_VALUES,
			},
			{
				id: "context-memory-include-in-prompt",
				label: screenText().contextMemory.includeInPrompt.label,
				description: screenText().contextMemory.includeInPrompt.description,
				currentValue: booleanSettingValue(
					this.state.includeInPrompt,
					CONTEXT_MEMORY_RETRIEVAL_DEFAULTS.includeInPrompt,
				),
				values: ["false", "true"],
				valueLabels: screenText().valueLabels.onOff,
			},
			{
				id: "context-memory-allow-external-egress",
				label: screenText().contextMemory.externalQueries.label,
				description: screenText().contextMemory.externalQueries.description,
				currentValue: booleanSettingValue(
					this.state.allowExternalEgress,
					CONTEXT_MEMORY_RETRIEVAL_DEFAULTS.allowExternalEgress,
				),
				values: ["false", "true"],
				valueLabels: screenText().valueLabels.onOff,
			},
		];

		this.mountSettingsList(
			items,
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
					case "context-memory-include-in-prompt":
						this.state = { ...this.state, includeInPrompt: newValue === "true" };
						break;
					case "context-memory-allow-external-egress":
						this.state = { ...this.state, allowExternalEgress: newValue === "true" };
						break;
					default:
						return;
				}
				onChange({ ...this.state }, this.scope);
			},
			onCancel,
		);
	}
}

class ModelRouterSettingsSubmenu extends SettingsListSubmenu {
	private state: ModelRouterSettings;
	private scope: SettingsScope;

	constructor(
		settings: ModelRouterSettings,
		currentModelPattern: string | undefined,
		modelOptions: SelectItem[] | undefined,
		resolveModelThinkingLevels: SettingsConfig["resolveModelThinkingLevels"],
		onChange: (settings: ModelRouterSettings, scope: SettingsScope) => void,
		onCancel: () => void,
		scope: SettingsScope = "global",
		pool?: ModelRouterPoolView,
		onAction?: (action: string) => void,
	) {
		super();
		this.state = {
			...settings,
			enabled: settings.enabled ?? false,
			selectionMode: settings.selectionMode ?? "manual",
			poolPreference: settings.poolPreference ?? "subscription-first",
			learningModel: settings.learningModel ?? "active",
		};
		const manualTiers = this.state.selectionMode === "manual";
		const tierUnsetLabel = manualTiers ? screenText().values.unset : screenText().values.autoTier;
		const tierValue = (model: string | undefined, thinking: ThinkingLevel | undefined): string =>
			routerTierValue(model, thinking, manualTiers ? screenText().values.notSet : screenText().values.auto);
		const levelsForModel = (modelPattern: string | undefined): ThinkingLevel[] | undefined =>
			resolveModelThinkingLevels?.(modelPattern ?? currentModelPattern);
		const keepSupportedThinking = (
			level: ThinkingLevel | undefined,
			modelPattern: string | undefined,
		): ThinkingLevel | undefined => {
			const levels = levelsForModel(modelPattern);
			return level && levels && !levels.includes(level) ? undefined : level;
		};
		this.state.cheapThinking = keepSupportedThinking(this.state.cheapThinking, this.state.cheapModel);
		this.state.mediumThinking = keepSupportedThinking(this.state.mediumThinking, this.state.mediumModel);
		this.state.expensiveThinking = keepSupportedThinking(this.state.expensiveThinking, this.state.expensiveModel);
		this.state.executorThinking = keepSupportedThinking(this.state.executorThinking, this.state.executorModel);
		this.scope = scope;
		const cheapModelOptions = buildModelRouterRoleModelOptions({
			currentValue: this.state.cheapModel,
			configuredModelOptions: modelOptions,
			currentModelPattern,
			includeActive: false,
			unsetDescription: manualTiers ? screenText().modelRouter.clearCheap : screenText().modelRouter.autoSelectTier,
			unsetLabel: tierUnsetLabel,
			pool,
		});
		const mediumModelOptions = buildModelRouterRoleModelOptions({
			currentValue: this.state.mediumModel,
			configuredModelOptions: modelOptions,
			currentModelPattern,
			includeActive: false,
			unsetDescription: manualTiers ? screenText().modelRouter.clearMedium : screenText().modelRouter.autoSelectTier,
			unsetLabel: tierUnsetLabel,
			pool,
		});
		const expensiveModelOptions = buildModelRouterRoleModelOptions({
			currentValue: this.state.expensiveModel,
			configuredModelOptions: modelOptions,
			currentModelPattern,
			includeActive: false,
			unsetDescription: manualTiers
				? screenText().modelRouter.clearExpensive
				: screenText().modelRouter.autoSelectTier,
			unsetLabel: tierUnsetLabel,
			pool,
		});
		const executorModelOptions = buildModelRouterRoleModelOptions({
			currentValue: this.state.executorModel,
			configuredModelOptions: modelOptions,
			currentModelPattern,
			includeActive: false,
			unsetDescription: screenText().modelRouter.clearExecutor,
			pool,
		});
		const learningModelOptions = buildModelRouterRoleModelOptions({
			currentValue: this.state.learningModel,
			configuredModelOptions: modelOptions,
			currentModelPattern,
			includeActive: true,
			pool,
		});
		const routedTierThinkingOptions = (modelPattern: string | undefined) =>
			buildModelRouterThinkingOptions(screenText().modelRouter.inheritThinking, levelsForModel(modelPattern));
		this.addChild(new Text(theme.bold(theme.fg("accent", screenText().rows.modelRouter.label)), 0, 0));
		this.addChild(new Spacer(1));

		const items: SettingItem[] = [
			{
				id: "model-router-scope",
				label: screenText().modelRouter.scope.label,
				description: screenText().modelRouter.scope.description,
				currentValue: this.scope,
				values: ["global", "project"],
				valueLabels: screenText().valueLabels.scope,
			},
			{
				id: "model-router-enabled",
				label: screenText().modelRouter.enabled.label,
				description: screenText().modelRouter.enabled.description,
				currentValue: booleanSettingValue(this.state.enabled),
				values: ["false", "true"],
				valueLabels: screenText().valueLabels.onOff,
			},
			{
				id: "model-router-selection-mode",
				label: screenText().modelRouter.selectionMode.label,
				description: screenText().modelRouter.selectionMode.description,
				currentValue: this.state.selectionMode ?? "manual",
				values: ["manual", "auto", "hybrid"],
				valueLabels: screenText().valueLabels.routerSelection,
			},
			{
				id: "model-router-pool",
				label: screenText().modelRouter.pool.label,
				description: screenText().modelRouter.pool.description,
				currentValue: modelRouterPoolSummary(pool),
				submenu: (_currentValue, done) => {
					const options: SelectItem[] = [
						{
							value: "configure-models",
							label: screenText().modelRouter.configureModels.label,
							description: screenText().modelRouter.configureModels.description,
						},
						...(pool?.refs ?? []).map((ref, index) => ({
							value: `calibrate:${ref}`,
							label: ref,
							description: pool?.calibration[index] ?? ref,
						})),
					];
					return new SelectSubmenu(
						screenText().modelRouter.poolMenuTitle,
						pool
							? screenText().modelRouter.poolMenuDescription(
									modelRouterPoolSummary(pool),
									pool.subscriptionRefs.length,
								)
							: screenText().modelRouter.poolUnavailable,
						options,
						"",
						(value) => {
							done(modelRouterPoolSummary(pool));
							onAction?.(value);
						},
						() => done(modelRouterPoolSummary(pool)),
					);
				},
			},
			{
				id: "model-router-pool-preference",
				label: screenText().modelRouter.poolPreference.label,
				description: screenText().modelRouter.poolPreference.description,
				currentValue: this.state.poolPreference ?? "subscription-first",
				values: ["subscription-first", "balanced"],
				valueLabels: screenText().valueLabels.routerPoolPreference,
			},
			{
				id: "model-router-cheap",
				label: screenText().modelRouter.cheapModel.label,
				description: screenText().modelRouter.cheapModel.description,
				currentValue: tierValue(this.state.cheapModel, this.state.cheapThinking),
				submenu: (_currentValue, done) =>
					new ModelSelectionSubmenu(
						cheapModelOptions,
						this.state.cheapModel ?? MODEL_ROUTER_UNSET_MODEL_VALUE,
						(value) => {
							const cheapModel = value === MODEL_ROUTER_UNSET_MODEL_VALUE ? undefined : value;
							this.state = {
								...this.state,
								cheapModel,
								cheapThinking: keepSupportedThinking(this.state.cheapThinking, cheapModel),
							};
							onChange({ ...this.state }, this.scope);
							done(tierValue(this.state.cheapModel, this.state.cheapThinking));
						},
						() => done(),
						{
							title: screenText().modelPicker.cheap.title,
							description: screenText().modelPicker.description,
							customTitle: screenText().modelPicker.cheap.customTitle,
							customDescription: screenText().modelPicker.customDescription,
							customEmptyHint: screenText().modelPicker.emptyClears,
							customEmptyValue: MODEL_ROUTER_UNSET_MODEL_VALUE,
						},
					),
			},
			{
				id: "model-router-medium",
				label: screenText().modelRouter.mediumModel.label,
				description: screenText().modelRouter.mediumModel.description,
				currentValue: tierValue(this.state.mediumModel, this.state.mediumThinking),
				submenu: (_currentValue, done) =>
					new ModelSelectionSubmenu(
						mediumModelOptions,
						this.state.mediumModel ?? MODEL_ROUTER_UNSET_MODEL_VALUE,
						(value) => {
							const mediumModel = value === MODEL_ROUTER_UNSET_MODEL_VALUE ? undefined : value;
							this.state = {
								...this.state,
								mediumModel,
								mediumThinking: keepSupportedThinking(this.state.mediumThinking, mediumModel),
							};
							onChange({ ...this.state }, this.scope);
							done(tierValue(this.state.mediumModel, this.state.mediumThinking));
						},
						() => done(),
						{
							title: screenText().modelPicker.medium.title,
							description: screenText().modelPicker.description,
							customTitle: screenText().modelPicker.medium.customTitle,
							customDescription: screenText().modelPicker.customDescription,
							customEmptyHint: screenText().modelPicker.emptyClears,
							customEmptyValue: MODEL_ROUTER_UNSET_MODEL_VALUE,
						},
					),
			},
			{
				id: "model-router-expensive",
				label: screenText().modelRouter.expensiveModel.label,
				description: screenText().modelRouter.expensiveModel.description,
				currentValue: tierValue(this.state.expensiveModel, this.state.expensiveThinking),
				submenu: (_currentValue, done) =>
					new ModelSelectionSubmenu(
						expensiveModelOptions,
						this.state.expensiveModel ?? MODEL_ROUTER_UNSET_MODEL_VALUE,
						(value) => {
							const expensiveModel = value === MODEL_ROUTER_UNSET_MODEL_VALUE ? undefined : value;
							this.state = {
								...this.state,
								expensiveModel,
								expensiveThinking: keepSupportedThinking(this.state.expensiveThinking, expensiveModel),
							};
							onChange({ ...this.state }, this.scope);
							done(tierValue(this.state.expensiveModel, this.state.expensiveThinking));
						},
						() => done(),
						{
							title: screenText().modelPicker.expensive.title,
							description: screenText().modelPicker.description,
							customTitle: screenText().modelPicker.expensive.customTitle,
							customDescription: screenText().modelPicker.customDescription,
							customEmptyHint: screenText().modelPicker.emptyClears,
							customEmptyValue: MODEL_ROUTER_UNSET_MODEL_VALUE,
						},
					),
			},
			{
				id: "model-router-executor",
				label: screenText().modelRouter.executorModel.label,
				description: screenText().modelRouter.executorModel.description,
				currentValue: routerTierValue(this.state.executorModel, this.state.executorThinking),
				submenu: (_currentValue, done) =>
					new ModelSelectionSubmenu(
						executorModelOptions,
						this.state.executorModel ?? MODEL_ROUTER_UNSET_MODEL_VALUE,
						(value) => {
							const executorModel = value === MODEL_ROUTER_UNSET_MODEL_VALUE ? undefined : value;
							this.state = {
								...this.state,
								executorModel,
								executorThinking: keepSupportedThinking(this.state.executorThinking, executorModel),
							};
							onChange({ ...this.state }, this.scope);
							done(routerTierValue(this.state.executorModel, this.state.executorThinking));
						},
						() => done(),
						{
							title: screenText().modelPicker.executor.title,
							description: screenText().modelPicker.executorDescription,
							customTitle: screenText().modelPicker.executor.customTitle,
							customDescription: screenText().modelPicker.customDescription,
							customEmptyHint: screenText().modelPicker.emptyClears,
							customEmptyValue: MODEL_ROUTER_UNSET_MODEL_VALUE,
						},
					),
			},
			{
				id: "model-router-learning",
				label: screenText().modelRouter.learningModel.label,
				description: screenText().modelRouter.learningModel.description,
				currentValue: optionalStringValue(this.state.learningModel, "active"),
				submenu: (_currentValue, done) =>
					new ModelSelectionSubmenu(
						learningModelOptions,
						this.state.learningModel ?? DEFAULT_AUTO_LEARN_SETTINGS.model,
						(value) => {
							this.state = { ...this.state, learningModel: value };
							onChange({ ...this.state }, this.scope);
							done(optionalStringValue(this.state.learningModel, "active"));
						},
						() => done(),
						{
							title: screenText().modelPicker.learning.title,
							description: screenText().modelPicker.learning.description,
							customTitle: screenText().modelPicker.learning.customTitle,
							customDescription: screenText().modelPicker.learning.customDescription,
							customEmptyHint: screenText().modelPicker.learning.customEmptyHint,
							customEmptyValue: DEFAULT_AUTO_LEARN_SETTINGS.model,
						},
					),
			},
			{
				id: "model-router-cheap-thinking",
				label: screenText().modelRouter.cheapThinking.label,
				description: screenText().modelRouter.cheapThinking.description,
				currentValue: this.state.cheapThinking ?? screenText().values.inherit,
				submenu: (_currentValue, done) =>
					new SelectSubmenu(
						screenText().modelRouter.cheapThinkingTitle,
						screenText().modelRouter.cheapThinkingDescription,
						routedTierThinkingOptions(this.state.cheapModel),
						this.state.cheapThinking ?? MODEL_ROUTER_INHERIT_THINKING_VALUE,
						(value) => {
							this.state = {
								...this.state,
								cheapThinking:
									value === MODEL_ROUTER_INHERIT_THINKING_VALUE ? undefined : (value as ThinkingLevel),
							};
							onChange({ ...this.state }, this.scope);
							done(this.state.cheapThinking ?? screenText().values.inherit);
						},
						() => done(),
					),
			},
			{
				id: "model-router-medium-thinking",
				label: screenText().modelRouter.mediumThinking.label,
				description: screenText().modelRouter.mediumThinking.description,
				currentValue: this.state.mediumThinking ?? screenText().values.inherit,
				submenu: (_currentValue, done) =>
					new SelectSubmenu(
						screenText().modelRouter.mediumThinkingTitle,
						screenText().modelRouter.mediumThinkingDescription,
						routedTierThinkingOptions(this.state.mediumModel),
						this.state.mediumThinking ?? MODEL_ROUTER_INHERIT_THINKING_VALUE,
						(value) => {
							this.state = {
								...this.state,
								mediumThinking:
									value === MODEL_ROUTER_INHERIT_THINKING_VALUE ? undefined : (value as ThinkingLevel),
							};
							onChange({ ...this.state }, this.scope);
							done(this.state.mediumThinking ?? screenText().values.inherit);
						},
						() => done(),
					),
			},
			{
				id: "model-router-expensive-thinking",
				label: screenText().modelRouter.expensiveThinking.label,
				description: screenText().modelRouter.expensiveThinking.description,
				currentValue: this.state.expensiveThinking ?? screenText().values.inherit,
				submenu: (_currentValue, done) =>
					new SelectSubmenu(
						screenText().modelRouter.expensiveThinkingTitle,
						screenText().modelRouter.expensiveThinkingDescription,
						routedTierThinkingOptions(this.state.expensiveModel),
						this.state.expensiveThinking ?? MODEL_ROUTER_INHERIT_THINKING_VALUE,
						(value) => {
							this.state = {
								...this.state,
								expensiveThinking:
									value === MODEL_ROUTER_INHERIT_THINKING_VALUE ? undefined : (value as ThinkingLevel),
							};
							onChange({ ...this.state }, this.scope);
							done(this.state.expensiveThinking ?? screenText().values.inherit);
						},
						() => done(),
					),
			},
			{
				id: "model-router-executor-thinking",
				label: screenText().modelRouter.executorThinking.label,
				description: screenText().modelRouter.executorThinking.description,
				currentValue: this.state.executorThinking ?? screenText().values.inherit,
				submenu: (_currentValue, done) =>
					new SelectSubmenu(
						screenText().modelRouter.executorThinkingTitle,
						screenText().modelRouter.executorThinkingDescription,
						routedTierThinkingOptions(this.state.executorModel),
						this.state.executorThinking ?? MODEL_ROUTER_INHERIT_THINKING_VALUE,
						(value) => {
							this.state = {
								...this.state,
								executorThinking:
									value === MODEL_ROUTER_INHERIT_THINKING_VALUE ? undefined : (value as ThinkingLevel),
							};
							onChange({ ...this.state }, this.scope);
							done(this.state.executorThinking ?? screenText().values.inherit);
						},
						() => done(),
					),
			},
			{
				id: "model-router-fitness-gate",
				label: screenText().modelRouter.fitnessGate.label,
				description: screenText().modelRouter.fitnessGate.description,
				currentValue: booleanSettingValue(this.state.fitnessGate),
				values: ["false", "true"],
				valueLabels: screenText().valueLabels.onOff,
			},
			{
				id: "model-router-calibrate",
				label: screenText().modelRouter.calibrate.label,
				description: screenText().modelRouter.calibrate.description,
				currentValue: pool
					? screenText().modelRouter.calibrate.currentValue(pool.needsCalibration.length)
					: screenText().modelRouter.calibrate.currentValue(undefined),
				submenu: (_currentValue, done) => {
					const count = pool?.refs.length ?? 0;
					const pending = pool?.needsCalibration.length ?? 0;
					const options: SelectItem[] = [
						{
							value: "calibrate-one",
							label: screenText().modelRouter.calibrate.one.label,
							description: screenText().modelRouter.calibrate.one.description(describeRouterCalibrationScope()),
						},
						{
							value: "calibrate-unprobed",
							label: screenText().modelRouter.calibrate.unprobed.label(pending),
							description: screenText().modelRouter.calibrate.unprobed.description,
						},
						{
							value: "calibrate-all",
							label: screenText().modelRouter.calibrate.all.label(count),
							description: screenText().modelRouter.calibrate.all.description,
						},
					];
					return new SelectSubmenu(
						screenText().modelRouter.calibrate.title,
						screenText().modelRouter.calibrate.subtitle(describeRouterCalibrationScope()),
						options,
						"",
						(value) => {
							done();
							onAction?.(value);
						},
						() => done(),
					);
				},
			},
			{
				id: "model-router-preview",
				label: screenText().modelRouter.preview.label,
				description: screenText().modelRouter.preview.description,
				currentValue: screenText().values.enterTask,
				submenu: (_currentValue, done) =>
					new TextInputSubmenu(
						screenText().modelRouter.preview.title,
						screenText().modelRouter.preview.taskDescription,
						"",
						(value) => {
							done();
							const task = value.trim();
							if (!task) return;
							onAction?.(
								task.startsWith("live:")
									? `preview-live:${task.slice("live:".length).trim()}`
									: `preview:${task}`,
							);
						},
						() => done(),
						screenText().modelRouter.preview.emptyHint,
					),
			},
			{
				id: "model-router-diagnostics",
				label: screenText().modelRouter.diagnostics.label,
				description: screenText().modelRouter.diagnostics.description,
				currentValue: screenText().values.show,
				submenu: (_currentValue, done) =>
					new SelectSubmenu(
						screenText().modelRouter.diagnostics.title,
						screenText().modelRouter.diagnostics.reportInto,
						[
							{
								value: "diagnostics",
								label: screenText().modelRouter.diagnostics.show.label,
								description: screenText().modelRouter.diagnostics.show.description,
							},
						],
						"diagnostics",
						(value) => {
							done();
							onAction?.(value);
						},
						() => done(),
					),
			},
			{
				id: "model-router-hmoe-preset",
				label: screenText().modelRouter.hmoePreset.label,
				description: screenText().modelRouter.hmoePreset.description,
				currentValue: this.state.hmoePreset ?? "balanced",
				values: [...HMOE_PRESETS],
				valueLabels: screenText().valueLabels.hmoePreset,
			},
			{
				id: "model-router-hmoe-team",
				label: screenText().modelRouter.hmoeTeam.label,
				description: screenText().modelRouter.hmoeTeam.description,
				currentValue: this.state.hmoeTeamStrategy ?? "single",
				values: [...HMOE_TEAM_STRATEGIES],
				valueLabels: screenText().valueLabels.hmoeTeam,
			},
			{
				id: "model-router-hmoe-independence",
				label: screenText().modelRouter.hmoeIndependence.label,
				description: screenText().modelRouter.hmoeIndependence.description,
				currentValue: this.state.hmoeIndependence ?? "none",
				values: [...HMOE_INDEPENDENCE_LEVELS],
				valueLabels: screenText().valueLabels.hmoeIndependence,
			},
			{
				id: "model-router-hmoe-preference",
				label: screenText().modelRouter.hmoePreference.label,
				description: screenText().modelRouter.hmoePreference.description,
				currentValue: this.state.hmoePreference ?? "prefer_subscription",
				values: [...HMOE_PREFERENCES],
				valueLabels: screenText().valueLabels.hmoePreference,
			},
		];

		this.mountSettingsList(
			items,
			(id, newValue) => {
				switch (id) {
					case "model-router-scope":
						this.scope = newValue as SettingsScope;
						break;
					case "model-router-enabled":
						this.state = { ...this.state, enabled: newValue === "true" };
						break;
					case "model-router-selection-mode":
						this.state = { ...this.state, selectionMode: newValue as ModelRouterSelectionMode };
						break;
					case "model-router-pool-preference":
						this.state = { ...this.state, poolPreference: newValue as ModelRouterPoolPreference };
						break;
					case "model-router-fitness-gate":
						this.state = { ...this.state, fitnessGate: newValue === "true" };
						break;
					case "model-router-hmoe-preset":
						this.state = { ...this.state, hmoePreset: newValue as HmoePreset };
						break;
					case "model-router-hmoe-team":
						this.state = { ...this.state, hmoeTeamStrategy: newValue as HmoeTeamStrategy };
						break;
					case "model-router-hmoe-independence":
						this.state = { ...this.state, hmoeIndependence: newValue as HmoeIndependence };
						break;
					case "model-router-hmoe-preference":
						this.state = { ...this.state, hmoePreference: newValue as HmoePreference };
						break;
					default:
						return;
				}
				onChange({ ...this.state }, this.scope);
			},
			onCancel,
		);
	}
}

/**
 * A submenu component for selecting from a list of options.
 */
class WarningSettingsSubmenu extends SettingsListSubmenu {
	private state: WarningSettings;

	constructor(warnings: WarningSettings, onChange: (warnings: WarningSettings) => void, onCancel: () => void) {
		super();

		this.state = { ...warnings };

		const items: SettingItem[] = [
			{
				id: "anthropic-extra-usage",
				label: screenText().warnings.anthropicExtraUsage.label,
				description: screenText().warnings.anthropicExtraUsage.description,
				currentValue: (this.state.anthropicExtraUsage ?? true) ? "true" : "false",
				values: ["true", "false"],
				valueLabels: screenText().valueLabels.onOff,
			},
		];

		this.mountSettingsList(
			items,
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

		this.addChild(new SelectorHeading(title, description));

		// Select list
		this.selectList = new SelectList(
			options,
			Math.min(options.length, 10),
			getSelectListTheme(),
			COMPACT_SELECTOR_LIST_LAYOUT,
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
		this.addChild(new Text(theme.fg("dim", `  ${screenText().hints.select}`), 0, 0));
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
		let currentCostGuard: CostGuardSettings = { ...config.costGuard };
		let currentWarnings = { ...config.warnings };
		let currentSelfModification: SelfModificationSettings = { ...config.selfModification };
		let currentAutonomy: AutonomySettings = { ...config.autonomy };
		let currentResearchLane: ResearchLaneSettings = { ...config.researchLane };
		let currentContextCuration: ContextCurationSettings = { ...config.contextCuration };
		let currentLearningPolicy: LearningPolicySettings = { ...config.learningPolicy };
		let currentAdvisor: AdvisorSettings & { error?: string } = { ...config.advisor };
		const advisorDescription = () =>
			currentAdvisor.error ??
			screenText().peer.description(
				screenText().scopes[config.getAdvisorSettingsScope?.() ?? config.advisorScope ?? "global"],
			);
		let currentModelCapability: ModelCapabilitySettings = { ...config.modelCapability };
		let currentWorkerDelegation: WorkerDelegationSettings = { ...config.workerDelegation };
		let currentModelRouter: ModelRouterSettings = { ...config.modelRouter };
		let currentAutoLearn: AutoLearnSettings = { ...config.autoLearn };
		let currentContextPolicyEnforcement: ContextPromptEnforcementSettings = { ...config.contextPolicyEnforcement };
		let currentContextMemoryRetrieval: MemoryRetrievalSettings = { ...config.contextMemoryRetrieval };
		const items: SettingItem[] = [
			{
				id: "autocompact",
				label: screenText().rows.autoCompact.label,
				description: screenText().rows.autoCompact.description,
				currentValue: config.autoCompact ? "true" : "false",
				values: ["true", "false"],
				valueLabels: screenText().valueLabels.onOff,
			},
			{
				id: "cost-guard",
				label: screenText().rows.costGuard.label,
				description: screenText().rows.costGuard.description,
				currentValue: costGuardSummary(currentCostGuard),
				submenu: (_currentValue, done) =>
					new CostGuardSettingsSubmenu(
						currentCostGuard,
						(settings, scope) => {
							currentCostGuard = { ...settings };
							callbacks.onCostGuardChange(settings, scope);
						},
						() => done(costGuardSummary(currentCostGuard)),
						config.costGuardScope ?? "global",
					),
			},
			{
				id: "steering-mode",
				label: screenText().rows.steeringMode.label,
				description: screenText().rows.steeringMode.description,
				currentValue: config.steeringMode,
				values: ["one-at-a-time", "all"],
				valueLabels: screenText().valueLabels.delivery,
			},
			{
				id: "follow-up-mode",
				label: screenText().rows.followUpMode.label,
				description: screenText().rows.followUpMode.description(followUpKey),
				currentValue: config.followUpMode,
				values: ["one-at-a-time", "all"],
				valueLabels: screenText().valueLabels.delivery,
			},
			{
				id: "transport",
				label: screenText().rows.transport.label,
				description: screenText().rows.transport.description,
				currentValue: config.transport,
				values: ["sse", "websocket", "websocket-cached", "auto"],
				valueLabels: screenText().valueLabels.transport,
			},
			{
				id: "http-idle-timeout",
				label: screenText().rows.httpIdleTimeout.label,
				description: screenText().rows.httpIdleTimeout.description,
				currentValue: formatHttpIdleTimeoutMs(config.httpIdleTimeoutMs),
				values: HTTP_IDLE_TIMEOUT_CHOICES.map((choice) => choice.label),
				valueLabels: screenText().valueLabels.httpIdleTimeout,
			},
			{
				id: "hide-thinking",
				label: screenText().rows.hideThinking.label,
				description: screenText().rows.hideThinking.description,
				currentValue: config.hideThinkingBlock ? "true" : "false",
				values: ["true", "false"],
				valueLabels: screenText().valueLabels.onOff,
			},
			{
				id: "project-context-files",
				label: screenText().rows.projectInstructions.label,
				description: screenText().rows.projectInstructions.description,
				currentValue: projectContextFilesSummary(config.projectContextFiles, config.projectContextFilesScope),
				submenu: (_currentValue, done) =>
					new ProjectContextFilesSubmenu(
						config.projectContextFiles,
						(mode, scope) => {
							config.projectContextFiles = mode;
							config.projectContextFilesScope = scope;
							callbacks.onProjectContextFilesChange(mode, scope);
						},
						() => done(projectContextFilesSummary(config.projectContextFiles, config.projectContextFilesScope)),
						config.projectContextFilesScope ?? "directoryProfile",
					),
			},
			{
				id: "collapse-changelog",
				label: screenText().rows.collapseChangelog.label,
				description: screenText().rows.collapseChangelog.description,
				currentValue: config.collapseChangelog ? "true" : "false",
				values: ["true", "false"],
				valueLabels: screenText().valueLabels.onOff,
			},
			{
				id: "quiet-startup",
				label: screenText().rows.quietStartup.label,
				description: screenText().rows.quietStartup.description,
				currentValue: config.quietStartup ? "true" : "false",
				values: ["true", "false"],
				valueLabels: screenText().valueLabels.onOff,
			},
			{
				id: "double-escape-action",
				label: screenText().rows.doubleEscapeAction.label,
				description: screenText().rows.doubleEscapeAction.description,
				currentValue: config.doubleEscapeAction,
				values: ["tree", "fork", "none"],
				valueLabels: screenText().valueLabels.doubleEscape,
			},
			{
				id: "tree-filter-mode",
				label: screenText().rows.treeFilterMode.label,
				description: screenText().rows.treeFilterMode.description,
				currentValue: config.treeFilterMode,
				values: ["default", "no-tools", "user-only", "labeled-only", "all"],
				valueLabels: screenText().valueLabels.treeFilter,
			},
			{
				id: "self-modification",
				label: screenText().rows.selfModification.label,
				description: screenText().rows.selfModification.description,
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
				label: screenText().rows.autonomy.label,
				description: screenText().rows.autonomy.description,
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
				id: "research-lane",
				label: screenText().rows.researchLane.label,
				description: screenText().rows.researchLane.description,
				currentValue: researchLaneSummary(currentResearchLane),
				submenu: (_currentValue, done) =>
					new ResearchLaneSettingsSubmenu(
						currentResearchLane,
						(settings, scope) => {
							currentResearchLane = { ...settings };
							callbacks.onResearchLaneChange(settings, scope);
						},
						() => done(researchLaneSummary(currentResearchLane)),
						config.researchLaneScope ?? "global",
					),
			},
			{
				id: "worker-delegation",
				label: screenText().rows.workerDelegation.label,
				description: screenText().rows.workerDelegation.description,
				currentValue: workerDelegationSummary(currentWorkerDelegation),
				submenu: (_currentValue, done) =>
					new WorkerDelegationSettingsSubmenu(
						currentWorkerDelegation,
						(settings, scope) => {
							currentWorkerDelegation = { ...settings };
							callbacks.onWorkerDelegationChange(settings, scope);
						},
						() => done(workerDelegationSummary(currentWorkerDelegation)),
						config.workerDelegationScope ?? "global",
					),
			},
			{
				id: "learning-policy",
				label: screenText().rows.learningPolicy.label,
				description: screenText().rows.learningPolicy.description,
				currentValue: learningPolicySummary(currentLearningPolicy),
				submenu: (_currentValue, done) =>
					new LearningPolicySettingsSubmenu(
						currentLearningPolicy,
						(settings, scope) => {
							currentLearningPolicy = { ...settings };
							callbacks.onLearningPolicyChange(settings, scope);
						},
						() => done(learningPolicySummary(currentLearningPolicy)),
						config.learningPolicyScope ?? "global",
					),
			},
			{
				id: "model-capability",
				label: screenText().rows.modelCapability.label,
				description: screenText().rows.modelCapability.description,
				currentValue: modelCapabilitySummary(currentModelCapability),
				submenu: (_currentValue, done) =>
					new ModelCapabilitySettingsSubmenu(
						currentModelCapability,
						(settings, scope) => {
							currentModelCapability = { ...settings };
							callbacks.onModelCapabilityChange(settings, scope);
						},
						() => done(modelCapabilitySummary(currentModelCapability)),
						config.modelCapabilityScope ?? "global",
					),
			},
			{
				id: "context-curation",
				label: screenText().rows.contextCuration.label,
				description: screenText().rows.contextCuration.description,
				currentValue: contextCurationSummary(currentContextCuration),
				submenu: (_currentValue, done) =>
					new ContextCurationSettingsSubmenu(
						currentContextCuration,
						config.autoLearnModelOptions,
						(settings, scope) => {
							currentContextCuration = { ...settings };
							callbacks.onContextCurationChange(settings, scope);
						},
						() => done(contextCurationSummary(currentContextCuration)),
						config.contextCurationScope ?? "global",
					),
			},
			...(config.systemOneProvider
				? [
						{
							id: "system-one-provider",
							label: screenText().rows.systemOneProvider.label,
							description: config.describeSystemOneAccess?.(config.systemOneProvider) ?? "",
							currentValue: config.systemOneProvider,
							values: [...SYSTEM_ONE_PROVIDER_CHOICES],
							valueLabels: screenText().valueLabels.systemOneProvider,
						},
					]
				: []),
			{
				id: "advisor",
				label: screenText().rows.peer.label,
				description: advisorDescription(),
				currentValue:
					currentAdvisor.enabled === false
						? screenText().values.off
						: (currentAdvisor.model ?? screenText().values.agentChooses),
				submenu: (_value, done) =>
					new AdvisorSettingsSubmenu(
						currentAdvisor,
						config.autoLearnModelOptions ?? [],
						(model) => config.resolveModelThinkingLevels?.(model),
						(settings, scope) => {
							currentAdvisor = { ...(callbacks.onAdvisorChange?.(settings, scope) ?? settings) };
							const row = items.find((item) => item.id === "advisor");
							if (row) row.description = advisorDescription();
							return currentAdvisor;
						},
						() =>
							done(
								currentAdvisor.enabled === false
									? screenText().values.off
									: (currentAdvisor.model ?? screenText().values.agentChooses),
							),
						config.getAdvisorSettingsScope?.() ?? config.advisorScope ?? "global",
					),
			},
			{
				id: "model-router",
				label: screenText().rows.modelRouter.label,
				description: screenText().rows.modelRouter.description,
				currentValue: modelRouterSummary(currentModelRouter, config.modelRouterPool),
				submenu: (_currentValue, done) =>
					new ModelRouterSettingsSubmenu(
						currentModelRouter,
						config.currentModelPattern,
						config.autoLearnModelOptions,
						config.resolveModelThinkingLevels,
						(settings, scope) => {
							currentModelRouter = { ...settings };
							callbacks.onModelRouterChange(settings, scope);
						},
						() => done(modelRouterSummary(currentModelRouter, config.modelRouterPool)),
						config.modelRouterScope ?? "global",
						config.modelRouterPool,
						(action) => {
							done(modelRouterSummary(currentModelRouter, config.modelRouterPool));
							callbacks.onModelRouterAction?.(action);
						},
					),
			},
			{
				id: "auto-learn",
				label: screenText().rows.autoLearn.label,
				description: screenText().rows.autoLearn.description,
				currentValue: autoLearnSummary(currentAutoLearn, autonomyModeValue(currentAutonomy)),
				submenu: (_currentValue, done) =>
					new AutoLearnSettingsSubmenu(
						currentAutoLearn,
						autonomyModeValue(currentAutonomy),
						config.currentModelPattern,
						config.autoLearnModelOptions,
						(settings, scope) => {
							currentAutoLearn = { ...settings };
							callbacks.onAutoLearnChange(settings, scope);
						},
						() => done(autoLearnSummary(currentAutoLearn, autonomyModeValue(currentAutonomy))),
						config.autoLearnScope ?? "global",
					),
			},
			{
				id: "context-policy-enforcement",
				label: screenText().rows.contextPolicy.label,
				description: screenText().rows.contextPolicy.description,
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
				label: screenText().rows.contextMemory.label,
				description: screenText().rows.contextMemory.description,
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
				label: screenText().rows.warnings.label,
				description: screenText().rows.warnings.description,
				currentValue: screenText().values.configure,
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
				label: screenText().rows.thinkingLevel.label,
				description: screenText().rows.thinkingLevel.description,
				currentValue: config.thinkingLevel,
				submenu: (currentValue, done) =>
					new SelectSubmenu(
						screenText().dialogs.thinkingTitle,
						screenText().dialogs.thinkingDescription,
						config.availableThinkingLevels.map((level) => ({
							value: level,
							label: level,
							description: THINKING_LEVEL_DESCRIPTIONS[level],
						})),
						currentValue,
						(value) => {
							callbacks.onThinkingLevelChange(value as ThinkingLevel);
							done(value);
						},
						() => done(),
					),
			},
			languageSettingsItem(config.language),
			{
				id: "theme",
				label: screenText().rows.theme.label,
				description: screenText().rows.theme.description,
				currentValue: config.currentTheme,
				submenu: (currentValue, done) =>
					new SelectSubmenu(
						screenText().dialogs.themeTitle,
						screenText().dialogs.themeDescription,
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
			label: screenText().rows.resources.label,
			description: screenText().rows.resources.description,
			currentValue: config.activeProfileName ?? screenText().values.none,
			submenu: (_currentValue, done) => {
				const options: SelectItem[] = [];

				if (!hasSources && !hasProfiles) {
					options.push({
						value: "nudge-add-source",
						label: screenText().resourcesMenu.addCatalog.label,
						description: screenText().resourcesMenu.addCatalog.description,
					});
				}

				options.push({
					value: "active-profile",
					label: screenText().resourcesMenu.profile.label,
					description: screenText().resourcesMenu.profile.description(
						config.activeProfileName ?? screenText().values.none,
					),
				});

				options.push({
					value: "manage-library",
					label: screenText().resourcesMenu.library.label,
					description: screenText().resourcesMenu.library.description,
				});

				options.push({
					value: "manage-profiles",
					label: screenText().resourcesMenu.profiles.label,
					description: screenText().resourcesMenu.profiles.description,
				});

				options.push({
					value: "sources",
					label: screenText().resourcesMenu.sources.label,
					description: screenText().resourcesMenu.sources.description(externalRoots.length),
				});

				return new SelectSubmenu(
					screenText().resourcesMenu.title,
					screenText().resourcesMenu.description,
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
				label: screenText().rows.showImages.label,
				description: screenText().rows.showImages.description,
				currentValue: config.showImages ? "true" : "false",
				values: ["true", "false"],
				valueLabels: screenText().valueLabels.onOff,
			});
			items.splice(2, 0, {
				id: "image-width-cells",
				label: screenText().rows.imageWidth.label,
				description: screenText().rows.imageWidth.description,
				currentValue: String(config.imageWidthCells),
				values: ["60", "80", "120"],
			});
		}

		// Image auto-resize toggle (always available, affects both attached and read images)
		items.splice(supportsImages ? 3 : 1, 0, {
			id: "auto-resize-images",
			label: screenText().rows.autoResizeImages.label,
			description: screenText().rows.autoResizeImages.description,
			currentValue: config.autoResizeImages ? "true" : "false",
			values: ["true", "false"],
			valueLabels: screenText().valueLabels.onOff,
		});

		// Block images toggle (always available, insert after auto-resize-images)
		const autoResizeIndex = items.findIndex((item) => item.id === "auto-resize-images");
		items.splice(autoResizeIndex + 1, 0, {
			id: "block-images",
			label: screenText().rows.blockImages.label,
			description: screenText().rows.blockImages.description,
			currentValue: config.blockImages ? "true" : "false",
			values: ["true", "false"],
			valueLabels: screenText().valueLabels.onOff,
		});

		// Skill commands toggle (insert after block-images)
		const blockImagesIndex = items.findIndex((item) => item.id === "block-images");
		items.splice(blockImagesIndex + 1, 0, {
			id: "skill-commands",
			label: screenText().rows.skillCommands.label,
			description: screenText().rows.skillCommands.description,
			currentValue: config.enableSkillCommands ? "true" : "false",
			values: ["true", "false"],
			valueLabels: screenText().valueLabels.onOff,
		});

		// Hardware cursor toggle (insert after skill-commands)
		const skillCommandsIndex = items.findIndex((item) => item.id === "skill-commands");
		items.splice(skillCommandsIndex + 1, 0, {
			id: "show-hardware-cursor",
			label: screenText().rows.showHardwareCursor.label,
			description: screenText().rows.showHardwareCursor.description,
			currentValue: config.showHardwareCursor ? "true" : "false",
			values: ["true", "false"],
			valueLabels: screenText().valueLabels.onOff,
		});

		// Editor padding toggle (insert after show-hardware-cursor)
		const hardwareCursorIndex = items.findIndex((item) => item.id === "show-hardware-cursor");
		items.splice(hardwareCursorIndex + 1, 0, {
			id: "editor-padding",
			label: screenText().rows.editorPadding.label,
			description: screenText().rows.editorPadding.description,
			currentValue: String(config.editorPaddingX),
			values: ["0", "1", "2", "3"],
		});

		// Autocomplete max visible toggle (insert after editor-padding)
		const editorPaddingIndex = items.findIndex((item) => item.id === "editor-padding");
		items.splice(editorPaddingIndex + 1, 0, {
			id: "autocomplete-max-visible",
			label: screenText().rows.autocompleteMaxItems.label,
			description: screenText().rows.autocompleteMaxItems.description,
			currentValue: String(config.autocompleteMaxVisible),
			values: ["3", "5", "7", "10", "15", "20"],
		});

		// Clear on shrink toggle (insert after autocomplete-max-visible)
		const autocompleteIndex = items.findIndex((item) => item.id === "autocomplete-max-visible");
		items.splice(autocompleteIndex + 1, 0, {
			id: "clear-on-shrink",
			label: screenText().rows.clearOnShrink.label,
			description: screenText().rows.clearOnShrink.description,
			currentValue: config.clearOnShrink ? "true" : "false",
			values: ["true", "false"],
			valueLabels: screenText().valueLabels.onOff,
		});

		// Terminal progress toggle (insert after clear-on-shrink)
		const clearOnShrinkIndex = items.findIndex((item) => item.id === "clear-on-shrink");
		items.splice(clearOnShrinkIndex + 1, 0, {
			id: "terminal-progress",
			label: screenText().rows.terminalProgress.label,
			description: screenText().rows.terminalProgress.description,
			currentValue: config.showTerminalProgress ? "true" : "false",
			values: ["true", "false"],
			valueLabels: screenText().valueLabels.onOff,
		});

		// Add borders
		this.addChild(new DynamicBorder());

		this.settingsList = new SettingsList(
			items,
			10,
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "language":
						callbacks.onLanguageChange(newValue as LanguageSetting);
						break;
					case "system-one-provider": {
						const choice = newValue as SystemOneProviderChoice;
						callbacks.onSystemOneProviderChange?.(choice);
						// The row says what the new choice resolves to, not what the old one did.
						const row = items.find((item) => item.id === id);
						if (row && config.describeSystemOneAccess) row.description = config.describeSystemOneAccess(choice);
						break;
					}
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
			{
				enableSearch: true,
			},
		);

		this.addChild(this.settingsList);
		this.addChild(new DynamicBorder());

		if (config.initialItemId) this.settingsList.openItem(config.initialItemId);
	}

	getSettingsList(): SettingsList {
		return this.settingsList;
	}
}
