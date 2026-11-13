import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { getAgentDir } from "../config.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../kernel/compaction/compaction.ts";
import { harnessLog, type LogLevel } from "../kernel/harness-log.ts";
import { normalizePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import { type ChannelPolicyResolution, resolveChannelPolicies } from "./channels/channel-policy.ts";
import { resolveSelfCompactionSettings, type SelfCompactionSettings } from "./compaction/self-compaction.ts";
import type { CostGuardSettings } from "./cost-guard.ts";
import type {
	HmoeIndependence,
	HmoePreference,
	HmoePreset,
	HmoeTeamStrategy,
	HmoeWeights,
} from "./expert-routing/vocabulary.ts";
import type { FastModePreference } from "./fast-mode.ts";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS } from "./http-dispatcher.ts";
import { compileWorkerModelPinPolicy, type WorkerModelPinPolicy } from "./orchestration/worker-model-pins.ts";
import { resolveActAheadSettings, resolveProactivityFeedbackSettings } from "./proactivity/proactivity-settings.ts";
import { ProfileRegistry } from "./profile-registry.ts";
import { normalizeSteStrictness } from "./provider-prompt-contracts.ts";
import { mergeResourceProfileMap, mergeResourceProfileSettings } from "./resource-profile-blocks.ts";
import { isWorkerSession } from "./session-role.ts";
import {
	resolveAutonomySettings,
	resolveEdgeSettings,
	resolveLearningPolicySettings,
} from "./settings/autonomy-edge-settings.ts";
import {
	normalizeMemoryHistorySettings,
	normalizeMemoryRetrievalSettings,
	resolveContextCurationSettings,
	resolveContextGcSettings,
	resolveContextPromptEnforcementSettings,
	resolveMemoryHistorySettings,
	resolveMemoryRetrievalSettings,
} from "./settings/context-memory-settings.ts";
import {
	resolveFleetSettings,
	resolveProcessMatrixSettings,
	resolveProviderAdmissionSettings,
	resolveWorktreeSyncSettings,
} from "./settings/fleet-capacity-settings.ts";
import {
	normalizeModelRouterSettings,
	resolveAdvisorSettings,
	resolveBedrockScopeSettings,
	resolveModelCapabilitySettings,
	resolveModelFavorites,
	resolveModelFavoritesIncluding,
	resolveModelRouterSettings,
	resolveSystemOneSettings,
} from "./settings/model-routing-settings.ts";
import { resolveLeaderSettings, resolveOrchestrationRetention } from "./settings/orchestration-settings.ts";
import {
	resolveProactivitySettings,
	resolveResearchLaneSettings,
	resolveRoutineAwaySettings,
	resolveRoutinesSettings,
} from "./settings/proactivity-lane-settings.ts";
import {
	encodeStoredProfileDefinition,
	mergeProfileDefinition,
	normalizeProfileName,
	normalizeProfileSelection,
	renameStoredProfileDefinition,
	rewriteActiveProfileReference,
	sanitizeProfileResources,
	setActiveProfileInSettings,
	updateStoredProfileDefinition,
} from "./settings/profile-definition-rules.ts";
import {
	normalizeCostGuardSettings,
	resolveCostGuardSettings,
	resolveCuratorSettings,
	resolveLoggingSettings,
	resolveProviderRetrySettings,
	resolveSelfModificationSettings,
	resolveStreamStallSettings,
	resolveWorkbenchSettings,
} from "./settings/session-runtime-settings.ts";
import { migrateSettings } from "./settings/settings-migration.ts";
import {
	appendFilter,
	collectLegacyDisabledFilterFromSettings,
	DEFAULT_MAX_OUTPUT_TOKENS,
	DEFAULT_REVIEW_WAITING_NOTICE_AT,
	deepMergeSettings,
	hasExplicitActiveResourceProfileSelection,
	hasExplicitEmptyActiveResourceProfileSelection,
	hasLegacyStreamStallBounds,
	isResourceDisabledByTopLevelOverrides,
	isThinkingLevel,
	isValidMemorySystem,
	MAX_REVIEW_WAITING_NOTICE_AT,
	matchesResourceProfilePattern,
	mergeResourceProfileFilters,
	mergeWorkerDelegationLayers,
	normalizeActiveResourceProfiles,
	normalizeBedrockScopeSettings,
	normalizeResourceProfileNames,
	normalizeWorkerDelegationLayer,
	parseProfileFileDefinition,
	parseTimeoutSetting,
	RETIRED_WORKER_DELEGATION_KEYS,
	resolveMemorySystem,
	sanitizeIntegerSetting,
} from "./settings/settings-rules.ts";
import type {
	AdvisorSettings,
	AutoLearnSettings,
	AutonomySettings,
	BedrockScopeSettings,
	ContextCurationSettings,
	ContextPromptEnforcementSettings,
	DirectoryResourceProfileInfo,
	FailoverSettings,
	FleetSettings,
	GlobalResourceProfileConfiguration,
	LeaderSettings,
	LearningPolicySettings,
	LocalRuntimesSettings,
	MemoryHistorySettings,
	MemoryRetrievalSettings,
	MemorySystem,
	ModelCapabilitySettings,
	ModelFavorite,
	ModelRouterPoolPreference,
	ModelRouterSelectionMode,
	ModelRouterSettings,
	PackageSource,
	ProactivitySettings,
	ProfileDefinitionInput,
	ProfilePersistenceScope,
	ResearchLaneSettings,
	ResolvedActAheadSettings,
	ResolvedBackgroundToolSettings,
	ResolvedEdgeSettings,
	ResolvedFleetSettings,
	ResolvedLearningPolicySettings,
	ResolvedProactivityFeedbackSettings,
	ResolvedProactivitySettings,
	ResolvedProcessMatrixSettings,
	ResolvedProviderAdmissionSettings,
	ResolvedResearchLaneSettings,
	ResolvedRoutineAwaySettings,
	ResolvedToolExecutionSettings,
	ResolvedToolOutputSettings,
	ResolvedWindowsShellSettings,
	ResolvedWorkerDelegationSettings,
	ResolvedWorktreeSyncSettings,
	ResourceProfileFilterSettings,
	ResourceProfileKind,
	ResourceProfileSettings,
	RoutineAwayAutostart,
	RoutinesSettings,
	ScoutSettings,
	SelfModificationSettings,
	Settings,
	SettingsError,
	SettingsErrorScope,
	SettingsReloadSnapshot,
	SettingsScope,
	StreamStallModelClass,
	StreamStallSettings,
	SystemOneSettings,
	ThinkingBudgetsSettings,
	ThinkingLevel,
	ToolkitSettings,
	TransportSetting,
	WarningSettings,
	WorkbenchSettings,
	WorkerAccountRouting,
	WorkerDelegationSettings,
	WorkerThinkingPolicy,
} from "./settings/settings-schema.ts";
import { FileSettingsStorage, InMemorySettingsStorage, type SettingsStorage } from "./settings/settings-storage.ts";
import {
	resolveBackgroundToolSettings,
	resolveFileEncodingRules,
	resolveToolExecutionSettings,
	resolveToolkitScripts,
	resolveToolOutputSettings,
	resolveWindowsShellSettings,
} from "./settings/tool-runtime-settings.ts";
import {
	resolveWorkerAccountRouting,
	resolveWorkerDelegationSettings,
	resolveWorkerThinkingPolicy,
} from "./settings/worker-delegation-settings.ts";
import {
	type ResolvedWorkerOutcomeSettings,
	resolveWorkerOutcomeSettings,
} from "./settings/worker-outcome-settings.ts";
import { isSystemOneEnabled, type SystemOneProviderChoice } from "./system-one/access.ts";
import type { ToolkitScript } from "./toolkit/script-registry.ts";
import type { FileEncodingRule } from "./tools/file-encoding-metadata.ts";
import { isPlainRecord } from "./util/value-guards.ts";

/** The retired worker concurrency keys are reported once per process, however many settings layers or reloads carry them. */
let retiredWorkerDelegationKeysReported = false;

/**
 * The top-level settings whose value is a string, a number or a boolean. These need no rule of their own, so they are
 * read and written through the generic pair below instead of one hand-written getter and setter each. A setting whose
 * value is an object or an array is not in this set and can never be reached through the pair.
 */
export type PlainSettingKey = {
	[K in keyof Settings]-?: NonNullable<Settings[K]> extends string | number | boolean ? K : never;
}[keyof Settings];

export interface SettingsManagerCreateOptions {
	projectTrusted?: boolean;
}

export {
	FileSettingsStorage,
	InMemorySettingsStorage,
	type SettingsSnapshot,
	type SettingsStorage,
} from "./settings/settings-storage.ts";

export class SettingsManager {
	private storage: SettingsStorage;
	private globalSettings: Settings;
	private projectSettings: Settings;
	private directoryProfileSettings: Settings;
	private runtimeResourceProfiles: string[] | undefined;
	private inlineResourceProfileDefinitions: Record<string, ProfileDefinitionInput> = {};
	private discoveredResourceProfileDefinitions: Record<string, ResourceProfileSettings> = {};
	settings: Settings;
	private projectTrusted: boolean;
	private modifiedFields = new Set<keyof Settings>(); // Track global fields modified during session
	private modifiedNestedFields = new Map<keyof Settings, Set<string>>(); // Track global nested field modifications
	private modifiedProjectFields = new Set<keyof Settings>(); // Track project fields modified during session
	private modifiedProjectNestedFields = new Map<keyof Settings, Set<string>>(); // Track project nested field modifications
	private globalSettingsLoadError: Error | null = null; // Track if global settings file had parse errors
	/** An unset `modelRouter.enabled`: off until the session reports that it has System One. */
	private modelRouterDefaultEnabled = false;
	private projectSettingsLoadError: Error | null = null; // Track if project settings file had parse errors
	private resolvedSelfCompaction: { key: string; value: SelfCompactionSettings } | undefined;
	private advisorSettingsRevision = 0;
	private observedAdvisorSettings = "";
	private directoryProfileSettingsLoadError: Error | null = null;
	private directoryProfileInfo: DirectoryResourceProfileInfo | null = null;
	private profileRegistry!: ProfileRegistry;
	private writeQueue: Promise<void> = Promise.resolve();
	private errors: SettingsError[];
	private readonly changeListeners = new Set<() => void>();

	private constructor(
		storage: SettingsStorage,
		initialGlobal: Settings,
		initialProject: Settings,
		initialDirectoryProfile: Settings = {},
		globalLoadError: Error | null = null,
		projectLoadError: Error | null = null,
		initialErrors: SettingsError[] = [],
		projectTrusted = true,
		directoryProfileInfo: DirectoryResourceProfileInfo | null = null,
		directoryProfileLoadError: Error | null = null,
	) {
		this.storage = storage;
		this.globalSettings = initialGlobal;
		this.projectSettings = initialProject;
		this.directoryProfileSettings = initialDirectoryProfile;
		this.projectTrusted = projectTrusted;
		this.globalSettingsLoadError = globalLoadError;
		this.projectSettingsLoadError = projectLoadError;
		this.directoryProfileSettingsLoadError = directoryProfileLoadError;
		this.directoryProfileInfo = directoryProfileInfo;
		this.errors = [...initialErrors];
		this.reportWorkerDelegationDiagnostics("global", this.globalSettings);
		this.reportWorkerDelegationDiagnostics("project", this.projectSettings);
		this.reportWorkerDelegationDiagnostics("directoryProfile", this.directoryProfileSettings);
		this.settings = this.mergeEffectiveSettings();
		this.observedAdvisorSettings = JSON.stringify(this.getAdvisorSettings());
		// Reported at construction as well as from the getter so the startup drain in main.ts
		// shows it, rather than only a later request-time read.
		this.reportLegacyStreamStallScopeDiagnostic();
		this.refreshProfileRegistry();
	}

	private createProfileRegistry(): ProfileRegistry {
		return new ProfileRegistry({
			globalSettings: this.globalSettings,
			projectSettings: this.projectSettings,
			directoryProfileSettings: this.directoryProfileSettings,
			inlineResourceProfileDefinitions: this.inlineResourceProfileDefinitions,
			discoveredResourceProfileDefinitions: this.discoveredResourceProfileDefinitions,
			profilesDir: this.storage.getProfilesDir?.(),
			externalResourceRoots: this.getEffectiveExternalResourceRoots(),
		});
	}

	private profileDiagnosticKeys = new Set<string>();
	private reportProfileDiagnostic(scope: SettingsErrorScope, message: string): void {
		const key = `${scope}:${message}`;
		if (this.profileDiagnosticKeys.has(key)) {
			return;
		}
		this.profileDiagnosticKeys.add(key);
		this.errors.push({ scope, error: new Error(message) });
	}

	private reportWorkerDelegationDiagnostics(scope: SettingsErrorScope, settings: Settings): void {
		const retired = RETIRED_WORKER_DELEGATION_KEYS.filter(
			(key) => settings.workerDelegation !== undefined && Object.hasOwn(settings.workerDelegation, key),
		);
		if (retired.length > 0 && !retiredWorkerDelegationKeysReported) {
			retiredWorkerDelegationKeysReported = true;
			harnessLog.info("settings", "retired worker concurrency settings are ignored; the fleet computes room", {
				scope,
				keys: retired.join(","),
			});
		}
		const diagnostics: string[] = [];
		normalizeWorkerDelegationLayer(settings.workerDelegation, (message) => diagnostics.push(message));
		const pinPolicy = compileWorkerModelPinPolicy({ [scope]: settings.workerDelegation?.modelPins });
		if (pinPolicy.status === "invalid") diagnostics.push(...pinPolicy.diagnostics);
		if (diagnostics.length > 0) {
			this.recordError(scope, new Error(`Worker delegation settings: ${diagnostics.join("; ")}`));
		}
	}

	private legacyStreamStallScopeReported = false;

	/**
	 * `retry.stall.{connectMs,activeIdleMs,quietIdleMs}` used to govern every provider. They now
	 * govern local and pi-managed models only, so a file raised for a CPU-served model no longer
	 * silently leaves a dead cloud stream running for its quiet bound. Reported once, through the
	 * same channel the other settings diagnostics use, and only while no cloud budget is set (once
	 * the user writes one, the split is deliberate and there is nothing to warn about).
	 */
	private reportLegacyStreamStallScopeDiagnostic(): void {
		if (this.legacyStreamStallScopeReported) return;
		const stall = this.settings.retry?.stall;
		if (!hasLegacyStreamStallBounds(stall) || stall?.cloud !== undefined) return;
		this.legacyStreamStallScopeReported = true;
		const scope: SettingsErrorScope = hasLegacyStreamStallBounds(this.projectSettings.retry?.stall)
			? "project"
			: hasLegacyStreamStallBounds(this.directoryProfileSettings.retry?.stall)
				? "directoryProfile"
				: "global";
		this.recordError(
			scope,
			new Error(
				"retry.stall.connectMs/activeIdleMs/quietIdleMs now apply to local and pi-managed models only; " +
					"cloud providers use retry.stall.cloud (defaults: connect 120000ms, active idle 120000ms, quiet idle 300000ms). " +
					"Move them under retry.stall.local, and set retry.stall.cloud, to make the split explicit.",
			),
		);
	}

	private getActiveProfileNamesForDiagnostics(): string[] {
		// Mirror getActiveResourceProfileNames()'s source precedence (runtime profiles from
		// --resource-profile take priority) so a bad runtime profile name still surfaces a
		// "profile not found" diagnostic instead of silently applying zero filtering.
		if (this.runtimeResourceProfiles !== undefined) {
			return normalizeResourceProfileNames(this.runtimeResourceProfiles);
		}
		// `/profiles none` is persisted globally as an explicit empty array. It is a durable
		// user-level off switch and must dominate project/directory/default/external fallbacks until
		// the user explicitly selects another profile.
		if (hasExplicitEmptyActiveResourceProfileSelection(this.globalSettings)) {
			return [];
		}
		const explicitProfiles =
			this.settings.activeResourceProfiles && this.settings.activeResourceProfiles.length > 0
				? this.settings.activeResourceProfiles
				: this.settings.activeResourceProfile
					? [this.settings.activeResourceProfile]
					: [];
		const names = normalizeResourceProfileNames(explicitProfiles);
		return names.length > 0 || hasExplicitActiveResourceProfileSelection(this.settings)
			? names
			: this.getExternalRootActiveResourceProfileNames();
	}

	private getExternalRootActiveResourceProfileNames(): string[] {
		const names: string[] = [];
		for (const root of this.getEffectiveExternalResourceRoots()) {
			try {
				const settingsPath = join(root, "settings.json");
				if (!existsSync(settingsPath)) continue;
				const parsed = JSON.parse(stripBom(readFileSync(settingsPath, "utf-8"))) as Settings;
				names.push(...normalizeActiveResourceProfiles(parsed));
			} catch {
				// External-root settings are optional; ignore malformed files for active-profile fallback.
			}
		}
		return [...new Set(names)];
	}

	private refreshProfileRegistry(): void {
		this.profileDiagnosticKeys.clear();
		this.profileRegistry = this.createProfileRegistry();
		const registryDiagnostics = this.profileRegistry.listDiagnostics();
		for (const diagnostic of registryDiagnostics) {
			const path = diagnostic.path ? ` (${diagnostic.path})` : "";
			this.reportProfileDiagnostic("global", `Profile diagnostic${path}: ${diagnostic.message}`);
		}
		for (const profileName of this.getActiveProfileNamesForDiagnostics()) {
			if (!this.resolveProfileFromRegistry(this.profileRegistry, profileName)) {
				this.reportProfileDiagnostic("global", `Active profile not found: ${profileName}`);
			}
		}
	}

	private resolveProfileFromRegistry(registry: ProfileRegistry, profileRef: string) {
		return profileRef.startsWith("./") || profileRef.startsWith("../")
			? registry.resolveProfileRef(profileRef, this.storage.getProfileResolutionBaseDir?.() ?? process.cwd())
			: registry.getProfile(profileRef);
	}

	private mergeEffectiveSettings(globalSettings: Settings = this.globalSettings): Settings {
		let merged = deepMergeSettings(globalSettings, this.projectSettings);
		merged = deepMergeSettings(merged, this.directoryProfileSettings);
		for (const layer of [globalSettings, this.projectSettings, this.directoryProfileSettings]) {
			if (Object.hasOwn(layer, "advisor")) merged.advisor = structuredClone(layer.advisor);
		}
		// Favorites are deliberately global user preferences; project and directory overlays must
		// never shadow the canonical list or make a pin disappear when changing repositories.
		if (globalSettings.modelFavorites !== undefined) merged.modelFavorites = globalSettings.modelFavorites;
		else delete merged.modelFavorites;
		const workerDelegation = mergeWorkerDelegationLayers(
			globalSettings.workerDelegation,
			this.projectSettings.workerDelegation,
			this.directoryProfileSettings.workerDelegation,
		);
		if (workerDelegation) merged.workerDelegation = workerDelegation;
		else delete merged.workerDelegation;
		if (this.runtimeResourceProfiles !== undefined) {
			merged = deepMergeSettings(merged, {
				activeResourceProfile: this.runtimeResourceProfiles,
				activeResourceProfiles: this.runtimeResourceProfiles,
			});
		}
		return merged;
	}

	private recomputeSettings(): void {
		this.settings = this.mergeEffectiveSettings();
		this.refreshProfileRegistry();
		this.notifyChanges();
	}

	/** Subscribe to effective-settings transitions. Listeners start synchronously; returned promises are not awaited. */
	subscribeChanges(listener: () => void): () => void {
		this.changeListeners.add(listener);
		return () => this.changeListeners.delete(listener);
	}

	/** The effective value of a plain setting: what the merged settings layers resolve to. */
	getPlain<K extends PlainSettingKey>(key: K): Settings[K] {
		return this.settings[key];
	}

	/** Write a plain setting to the owner's own settings, mark it modified and save. */
	setPlain<K extends PlainSettingKey>(key: K, value: Settings[K]): void {
		this.globalSettings[key] = value;
		this.markModified(key);
		this.save();
	}

	private notifyChanges(): void {
		const advisor = JSON.stringify(this.getAdvisorSettings());
		if (advisor !== this.observedAdvisorSettings) {
			this.observedAdvisorSettings = advisor;
			this.advisorSettingsRevision += 1;
		}
		for (const listener of [...this.changeListeners]) {
			try {
				void Promise.resolve(listener()).catch(() => {});
			} catch {
				// Settings persistence is authoritative; a runtime projection can recover on its next refresh.
			}
		}
	}

	/** Create a SettingsManager that loads from files */
	static create(
		cwd: string,
		agentDir: string = getAgentDir(),
		options: SettingsManagerCreateOptions = {},
	): SettingsManager {
		return SettingsManager.fromStorage(new FileSettingsStorage(cwd, agentDir), options);
	}

	/** Another session's own manager over this storage (a bot's session): the same settings, its own runtime state. */
	sibling(): SettingsManager {
		return SettingsManager.fromStorage(this.storage, { projectTrusted: this.projectTrusted });
	}

	/** Create a SettingsManager from an arbitrary storage backend */
	static fromStorage(storage: SettingsStorage, options: SettingsManagerCreateOptions = {}): SettingsManager {
		const projectTrusted = options.projectTrusted ?? true;
		const globalLoad = SettingsManager.tryLoadFromStorage(storage, "global");
		const projectLoad = SettingsManager.tryLoadFromStorage(storage, "project", projectTrusted);
		const directoryProfileLoad = SettingsManager.tryLoadDirectoryProfileFromStorage(storage);
		const initialErrors: SettingsError[] = [
			...(globalLoad.error ? [{ scope: "global" as const, error: globalLoad.error }] : []),
			...(projectLoad.error ? [{ scope: "project" as const, error: projectLoad.error }] : []),
			...(directoryProfileLoad.error
				? [{ scope: "directoryProfile" as const, error: directoryProfileLoad.error }]
				: []),
		];
		return new SettingsManager(
			storage,
			globalLoad.settings,
			projectLoad.settings,
			directoryProfileLoad.settings,
			globalLoad.error,
			projectLoad.error,
			initialErrors,
			projectTrusted,
			directoryProfileLoad.info,
			directoryProfileLoad.error,
		);
	}

	/** Create an in-memory SettingsManager (no file I/O) */
	static inMemory(settings: Partial<Settings> = {}): SettingsManager {
		const storage = new InMemorySettingsStorage();
		const initialSettings = migrateSettings(structuredClone(settings) as Record<string, unknown>);
		storage.withLock("global", () => JSON.stringify(initialSettings, null, 2));
		return SettingsManager.fromStorage(storage);
	}

	private static loadFromStorage(storage: SettingsStorage, scope: SettingsScope, projectTrusted = true): Settings {
		if (scope === "project" && !projectTrusted) {
			return {};
		}

		let content: string | undefined;
		storage.withLock(scope, (current) => {
			content = current;
			return undefined;
		});

		if (!content) {
			return {};
		}
		const settings = JSON.parse(stripBom(content));
		return migrateSettings(settings);
	}

	private static tryLoadFromStorage(
		storage: SettingsStorage,
		scope: SettingsScope,
		projectTrusted = true,
	): { settings: Settings; error: Error | null } {
		try {
			return { settings: SettingsManager.loadFromStorage(storage, scope, projectTrusted), error: null };
		} catch (error) {
			return { settings: {}, error: error as Error };
		}
	}

	private static tryLoadDirectoryProfileFromStorage(storage: SettingsStorage): {
		settings: Settings;
		error: Error | null;
		info: DirectoryResourceProfileInfo | null;
	} {
		const info = storage instanceof FileSettingsStorage ? storage.getDirectoryResourceProfileInfo() : null;
		try {
			let content: string | undefined;
			if (storage instanceof FileSettingsStorage) {
				content = storage.readDirectoryResourceProfile();
			} else {
				storage.withLock("directoryProfile", (current) => {
					content = current;
					return undefined;
				});
			}
			if (!content) return { settings: {}, error: null, info };
			const settings = JSON.parse(stripBom(content));
			return { settings: migrateSettings(settings), error: null, info };
		} catch (error) {
			return { settings: {}, error: error as Error, info };
		}
	}

	getGlobalSettings(): Settings {
		return structuredClone(this.globalSettings);
	}

	getProjectSettings(): Settings {
		return structuredClone(this.projectSettings);
	}

	getDirectoryResourceProfileSettings(): Settings {
		return structuredClone(this.directoryProfileSettings);
	}

	getDirectoryResourceProfileInfo(): DirectoryResourceProfileInfo | null {
		return this.directoryProfileInfo ? { ...this.directoryProfileInfo } : null;
	}

	getProfileRegistry(): ProfileRegistry {
		this.refreshProfileRegistry();
		return this.profileRegistry;
	}

	getActiveResourceProfileNames(): string[] {
		if (this.runtimeResourceProfiles !== undefined) {
			return [...this.runtimeResourceProfiles];
		}
		if (hasExplicitEmptyActiveResourceProfileSelection(this.globalSettings)) {
			return [];
		}
		const names = normalizeActiveResourceProfiles(this.settings);
		return names.length > 0 || hasExplicitActiveResourceProfileSelection(this.settings)
			? names
			: this.getExternalRootActiveResourceProfileNames();
	}

	hasExplicitActiveResourceProfileSelection(): boolean {
		// An explicit empty runtime/settings selection means "no profile", not an invalid profile
		// whose authority should collapse to deny-all. Non-empty unresolved refs remain explicit and
		// are diagnosed/strictly denied through the normal active-profile path.
		return this.getActiveResourceProfileNames().length > 0;
	}

	/**
	 * Aggregate ONLY the active profiles' contribution to a resource kind's filter — the user's own
	 * legacy `disabledResources` list is not merged in. Includes the strict-UAC deny-all (an
	 * authority-bearing kind no active profile mentions is denied outright); that denial is
	 * profile-driven too. Shared by `getResourceProfileFilter` (which merges the legacy disable list
	 * on top) and `isResourceDeniedByActiveProfile` (which must attribute a denial to the profile
	 * ALONE — a user-only disable must never be reported as "withheld by the active resource
	 * profile").
	 */
	private computeProfileOnlyResourceFilter(kind: ResourceProfileKind): Required<ResourceProfileFilterSettings> {
		const profileFilter: ResourceProfileFilterSettings = {};
		const seenProfiles = new Set<string>();
		const registry = this.getProfileRegistry();
		const activeProfileNames = this.getActiveResourceProfileNames();
		let kindMentionedByProfile = false;
		for (const profileName of activeProfileNames) {
			if (seenProfiles.has(profileName)) continue;
			seenProfiles.add(profileName);
			const kindFilter = this.resolveProfileFromRegistry(registry, profileName)?.resources[kind];
			if (kindFilter && ((kindFilter.allow?.length ?? 0) > 0 || (kindFilter.block?.length ?? 0) > 0)) {
				kindMentionedByProfile = true;
			}
			appendFilter(profileFilter, kindFilter);
		}

		// Strict UAC: an active profile set is the COMPLETE grant. An authority-bearing kind that no
		// active profile explicitly mentions is denied outright — grant-all must be said out loud
		// via `allow: ["*"]`. Themes are exempt (cosmetic, no authority). With no active profile,
		// behavior is unchanged: profiles are the opt-in least-privilege boundary.
		if (activeProfileNames.length > 0 && kind !== "themes" && !kindMentionedByProfile) {
			return { allow: [], block: ["*"] };
		}

		return {
			allow: [...new Set(profileFilter.allow ?? [])],
			block: [...new Set(profileFilter.block ?? [])],
		};
	}

	getResourceProfileFilter(kind: ResourceProfileKind): Required<ResourceProfileFilterSettings> {
		const legacyFilter = mergeResourceProfileFilters(
			collectLegacyDisabledFilterFromSettings(this.globalSettings, kind),
			collectLegacyDisabledFilterFromSettings(this.projectSettings, kind),
			collectLegacyDisabledFilterFromSettings(this.directoryProfileSettings, kind),
		);
		const filter = mergeResourceProfileFilters(legacyFilter, this.computeProfileOnlyResourceFilter(kind));
		return {
			allow: [...new Set(filter.allow ?? [])],
			block: [...new Set(filter.block ?? [])],
		};
	}

	/**
	 * Explicit off-switch for passive default-on resources. Unlike the strict profile grant,
	 * an omitted allow entry is not a disable: only disabledResources, the resource selector's
	 * negative filters, or an authored profile block wins. This keeps default-on cosmetic resources
	 * available without weakening the import boundary for ordinary authority-bearing extensions.
	 */
	isResourceExplicitlyDisabled(kind: ResourceProfileKind, resourcePath: string, baseDir = ""): boolean {
		const userDisabled = mergeResourceProfileFilters(
			collectLegacyDisabledFilterFromSettings(this.globalSettings, kind),
			collectLegacyDisabledFilterFromSettings(this.projectSettings, kind),
			collectLegacyDisabledFilterFromSettings(this.directoryProfileSettings, kind),
		).block;
		if (matchesResourceProfilePattern(resourcePath, userDisabled ?? [], baseDir)) return true;
		if (isResourceDisabledByTopLevelOverrides(this.settings, kind, resourcePath, baseDir)) {
			return true;
		}

		const registry = this.getProfileRegistry();
		const seen = new Set<string>();
		for (const profileName of this.getActiveResourceProfileNames()) {
			if (seen.has(profileName)) continue;
			seen.add(profileName);
			const explicitBlocks = this.resolveProfileFromRegistry(registry, profileName)?.resources[kind]?.block ?? [];
			if (matchesResourceProfilePattern(resourcePath, explicitBlocks, baseDir)) return true;
		}
		return false;
	}

	/**
	 * Profile grants the user's own disable list overrides. RATIFIED precedence: a user disable
	 * (`disabledResources` / `!` overrides) is a hard off-switch that always WINS over a profile
	 * allow (the legacy disabled filter merges into every profile filter as a block, and blocks
	 * beat allows). This helper only SURFACES the conflict so a granted-but-disabled resource
	 * doesn't look like a broken grant.
	 */
	getProfileGrantsOverriddenByUserDisable(kind: ResourceProfileKind): string[] {
		const disabled = this.settings.disabledResources?.[kind] ?? [];
		if (!Array.isArray(disabled) || disabled.length === 0) return [];
		const registry = this.getProfileRegistry();
		const conflicts = new Set<string>();
		for (const profileName of this.getActiveResourceProfileNames()) {
			const filter = this.resolveProfileFromRegistry(registry, profileName)?.resources[kind];
			for (const allowEntry of filter?.allow ?? []) {
				if (allowEntry === "*") continue;
				if (disabled.includes(allowEntry) || matchesResourceProfilePattern(allowEntry, disabled)) {
					conflicts.add(allowEntry);
				}
			}
		}
		return [...conflicts];
	}

	isResourceAllowedByProfile(kind: ResourceProfileKind, resourcePath: string, baseDir = ""): boolean {
		const filter = this.getResourceProfileFilter(kind);
		if (filter.allow.length > 0 && !matchesResourceProfilePattern(resourcePath, filter.allow, baseDir)) {
			return false;
		}
		if (matchesResourceProfilePattern(resourcePath, filter.block, baseDir)) {
			return false;
		}
		return true;
	}

	/**
	 * Whether the ACTIVE PROFILE alone denies this resource — the user's own legacy
	 * `disabledResources` list is ignored. A "withheld by the active resource profile" report must
	 * use this, not `isResourceAllowedByProfile`: that check merges the user's own disables in, so a
	 * plain user-disabled resource (no profile even mentioning it) would otherwise be misattributed
	 * to the profile.
	 */
	isResourceDeniedByActiveProfile(kind: ResourceProfileKind, resourcePath: string, baseDir = ""): boolean {
		if (this.getActiveResourceProfileNames().length === 0) return false;
		const filter = this.computeProfileOnlyResourceFilter(kind);
		if (filter.allow.length > 0 && !matchesResourceProfilePattern(resourcePath, filter.allow, baseDir)) {
			return true;
		}
		return matchesResourceProfilePattern(resourcePath, filter.block, baseDir);
	}

	/**
	 * Situational soul(s) of the currently active profile(s): a system-prompt identity prefix
	 * injected while the profile is active. Multiple active profiles' souls are concatenated.
	 */
	getActiveProfileSoul(): string | undefined {
		// First-wins precedence (like profile model/thinking): the most-specific active profile's soul
		// is the identity — concatenating multiple souls would inject contradictory identities.
		const registry = this.getProfileRegistry();
		const seen = new Set<string>();
		for (const profileName of this.getActiveResourceProfileNames()) {
			if (seen.has(profileName)) continue;
			seen.add(profileName);
			const soul = this.resolveProfileFromRegistry(registry, profileName)?.soul?.trim();
			if (soul) return soul;
		}
		return undefined;
	}

	isProjectTrusted(): boolean {
		return this.projectTrusted;
	}

	setProjectTrusted(trusted: boolean): void {
		if (this.projectTrusted === trusted) {
			return;
		}

		this.projectTrusted = trusted;
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();

		if (!trusted) {
			this.projectSettings = {};
			this.projectSettingsLoadError = null;
			this.recomputeSettings();
			return;
		}

		const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project", trusted);
		this.projectSettings = projectLoad.settings;
		this.projectSettingsLoadError = projectLoad.error;
		if (projectLoad.error) {
			this.recordError("project", projectLoad.error);
		} else {
			this.reportWorkerDelegationDiagnostics("project", this.projectSettings);
		}
		this.recomputeSettings();
	}

	async reload(): Promise<void> {
		await this.writeQueue;
		const globalLoad = SettingsManager.tryLoadFromStorage(this.storage, "global");
		if (!globalLoad.error) {
			this.globalSettings = globalLoad.settings;
			this.globalSettingsLoadError = null;
			this.reportWorkerDelegationDiagnostics("global", this.globalSettings);
		} else {
			this.globalSettingsLoadError = globalLoad.error;
			this.recordError("global", globalLoad.error);
		}

		this.modifiedFields.clear();
		this.modifiedNestedFields.clear();
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();

		const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project", this.projectTrusted);
		if (!projectLoad.error) {
			this.projectSettings = projectLoad.settings;
			this.projectSettingsLoadError = null;
			this.reportWorkerDelegationDiagnostics("project", this.projectSettings);
		} else {
			this.projectSettingsLoadError = projectLoad.error;
			this.recordError("project", projectLoad.error);
		}

		const directoryProfileLoad = SettingsManager.tryLoadDirectoryProfileFromStorage(this.storage);
		this.directoryProfileInfo = directoryProfileLoad.info;
		this.directoryProfileSettingsLoadError = directoryProfileLoad.error;
		if (!directoryProfileLoad.error) {
			this.directoryProfileSettings = directoryProfileLoad.settings;
			this.reportWorkerDelegationDiagnostics("directoryProfile", this.directoryProfileSettings);
		} else {
			this.recordError("directoryProfile", directoryProfileLoad.error);
		}

		this.recomputeSettings();
	}

	/** Capture the complete in-memory settings generation before runtime reload mutates it. */
	createReloadSnapshot(): SettingsReloadSnapshot {
		return {
			globalSettings: structuredClone(this.globalSettings),
			projectSettings: structuredClone(this.projectSettings),
			directoryProfileSettings: structuredClone(this.directoryProfileSettings),
			runtimeResourceProfiles:
				this.runtimeResourceProfiles === undefined ? undefined : [...this.runtimeResourceProfiles],
			inlineResourceProfileDefinitions: structuredClone(this.inlineResourceProfileDefinitions),
			discoveredResourceProfileDefinitions: structuredClone(this.discoveredResourceProfileDefinitions),
			effectiveSettings: structuredClone(this.settings),
			projectTrusted: this.projectTrusted,
			modifiedFields: new Set(this.modifiedFields),
			modifiedNestedFields: this.cloneModifiedNestedFields(this.modifiedNestedFields),
			modifiedProjectFields: new Set(this.modifiedProjectFields),
			modifiedProjectNestedFields: this.cloneModifiedNestedFields(this.modifiedProjectNestedFields),
			globalSettingsLoadError: this.globalSettingsLoadError,
			projectSettingsLoadError: this.projectSettingsLoadError,
			directoryProfileSettingsLoadError: this.directoryProfileSettingsLoadError,
			directoryProfileInfo: this.directoryProfileInfo ? { ...this.directoryProfileInfo } : null,
			errors: [...this.errors],
		};
	}

	/** Restore a failed runtime reload without changing the on-disk settings generation. */
	restoreReloadSnapshot(snapshot: SettingsReloadSnapshot): void {
		this.globalSettings = structuredClone(snapshot.globalSettings);
		this.projectSettings = structuredClone(snapshot.projectSettings);
		this.directoryProfileSettings = structuredClone(snapshot.directoryProfileSettings);
		this.runtimeResourceProfiles =
			snapshot.runtimeResourceProfiles === undefined ? undefined : [...snapshot.runtimeResourceProfiles];
		this.inlineResourceProfileDefinitions = structuredClone(snapshot.inlineResourceProfileDefinitions);
		this.discoveredResourceProfileDefinitions = structuredClone(snapshot.discoveredResourceProfileDefinitions);
		this.settings = structuredClone(snapshot.effectiveSettings);
		this.projectTrusted = snapshot.projectTrusted;
		this.modifiedFields = new Set(snapshot.modifiedFields);
		this.modifiedNestedFields = this.cloneModifiedNestedFields(snapshot.modifiedNestedFields);
		this.modifiedProjectFields = new Set(snapshot.modifiedProjectFields);
		this.modifiedProjectNestedFields = this.cloneModifiedNestedFields(snapshot.modifiedProjectNestedFields);
		this.globalSettingsLoadError = snapshot.globalSettingsLoadError;
		this.projectSettingsLoadError = snapshot.projectSettingsLoadError;
		this.directoryProfileSettingsLoadError = snapshot.directoryProfileSettingsLoadError;
		this.directoryProfileInfo = snapshot.directoryProfileInfo ? { ...snapshot.directoryProfileInfo } : null;
		this.errors = [...snapshot.errors];
		this.refreshProfileRegistry();
		this.notifyChanges();
	}

	/** Apply additional overrides on top of current settings */
	applyOverrides(overrides: Partial<Settings>): void {
		const normalizedOverrides = { ...overrides };
		if (Object.hasOwn(overrides, "workerDelegation")) {
			const workerDelegation = normalizeWorkerDelegationLayer(overrides.workerDelegation);
			if (workerDelegation) normalizedOverrides.workerDelegation = workerDelegation;
			else delete normalizedOverrides.workerDelegation;
		}
		this.settings = deepMergeSettings(this.settings, normalizedOverrides);
		this.notifyChanges();
	}

	/** Select runtime-only resource profiles, e.g. from CLI/subagent launch options. */
	setRuntimeResourceProfiles(profileNames: string[]): void {
		this.runtimeResourceProfiles = normalizeResourceProfileNames(profileNames);
		this.recomputeSettings();
	}

	/** Add one-shot profile definitions from CLI/SDK/ephemeral agent launch input. Never writes to disk. */
	addInlineResourceProfileDefinitions(
		profiles: Record<string, ResourceProfileSettings | ProfileDefinitionInput>,
	): void {
		const next = { ...this.inlineResourceProfileDefinitions };
		for (const [name, input] of Object.entries(profiles)) {
			const existing = next[name];
			const definition = Object.hasOwn(input, "resources")
				? (input as ProfileDefinitionInput)
				: { resources: input as ResourceProfileSettings };
			const resources = mergeResourceProfileSettings(existing?.resources, definition.resources);
			next[name] = mergeProfileDefinition(name, definition, resources, existing);
		}
		this.inlineResourceProfileDefinitions = next;
		this.refreshProfileRegistry();
	}

	/** Replace profile definitions discovered inside loaded resource files. Never writes to disk. */
	replaceDiscoveredResourceProfileDefinitions(profiles: Record<string, ResourceProfileSettings>): void {
		this.discoveredResourceProfileDefinitions = { ...profiles };
		this.refreshProfileRegistry();
	}

	/** Add profile definitions discovered after resource resolution, e.g. context agent files. Never writes to disk. */
	addDiscoveredResourceProfileDefinitions(profiles: Record<string, ResourceProfileSettings>): void {
		this.discoveredResourceProfileDefinitions = mergeResourceProfileMap(
			this.discoveredResourceProfileDefinitions,
			profiles,
		);
		this.refreshProfileRegistry();
	}

	private rewriteReusableProfileSelections(oldName: string, newName: string | undefined): void {
		if (this.runtimeResourceProfiles?.includes(oldName)) {
			this.runtimeResourceProfiles = [
				...new Set(
					this.runtimeResourceProfiles.flatMap((profile) =>
						profile === oldName ? (newName ? [newName] : []) : [profile],
					),
				),
			];
		}

		if (rewriteActiveProfileReference(this.globalSettings, oldName, newName)) {
			this.markModified("activeResourceProfile");
			this.markModified("activeResourceProfiles");
			this.save();
		}

		const projectSettings = structuredClone(this.projectSettings);
		if (rewriteActiveProfileReference(projectSettings, oldName, newName)) {
			this.markProjectModified("activeResourceProfile");
			this.markProjectModified("activeResourceProfiles");
			this.saveProjectSettings(projectSettings);
		}

		if (rewriteActiveProfileReference(this.directoryProfileSettings, oldName, newName)) {
			this.persistDirectoryProfiles(() => {});
		}
		this.recomputeSettings();
	}

	private persistDirectoryProfiles(update: (settings: Settings) => void): void {
		const next = structuredClone(this.directoryProfileSettings);
		update(next);
		this.directoryProfileSettings = next;
		this.recomputeSettings();

		this.enqueueWrite("directoryProfile", () => {
			this.storage.withLock("directoryProfile", (current) => {
				const currentSettings = current
					? migrateSettings(JSON.parse(stripBom(current)) as Record<string, unknown>)
					: {};
				const merged: Settings = {
					...currentSettings,
					...next,
					resourceProfiles: next.resourceProfiles,
					activeResourceProfiles: next.activeResourceProfiles,
					activeResourceProfile: next.activeResourceProfile,
				};
				if (!next.resourceProfiles) {
					delete merged.resourceProfiles;
				}
				if (!next.activeResourceProfiles && next.activeResourceProfile === undefined) {
					delete merged.activeResourceProfiles;
					delete merged.activeResourceProfile;
				}
				return JSON.stringify(merged, null, 2);
			});
		});
	}

	private getProfileFilePath(profileName: string): string {
		const normalized = normalizeProfileName(profileName);
		const profilesDir = this.storage.getProfilesDir?.();
		if (!profilesDir) {
			throw new Error("Profiles directory is not configured");
		}
		return join(resolve(profilesDir), `${normalized}.json`);
	}

	/**
	 * Create or update a profile definition in the selected persistence scope.
	 */
	setProfileDefinition(profileName: string, definition: ProfileDefinitionInput, scope: ProfilePersistenceScope): void {
		const name = normalizeProfileName(profileName);
		const resources = sanitizeProfileResources(definition.resources);

		if (scope === "session") {
			const next = { ...this.inlineResourceProfileDefinitions };
			const payload = mergeProfileDefinition(name, definition, resources, next[name]);
			if (encodeStoredProfileDefinition(payload)) {
				next[name] = payload;
			} else {
				delete next[name];
			}
			this.inlineResourceProfileDefinitions = next;
			this.refreshProfileRegistry();
			return;
		}

		if (scope === "global") {
			const next = structuredClone(this.globalSettings);
			updateStoredProfileDefinition(next, name, definition, resources);
			this.globalSettings = next;
			this.markModified("resourceProfiles");
			this.save();
			return;
		}

		if (scope === "project") {
			this.updateProjectSettings("resourceProfiles", (settings) => {
				updateStoredProfileDefinition(settings, name, definition, resources);
			});
			return;
		}

		if (scope === "directory") {
			this.persistDirectoryProfiles((current) => {
				updateStoredProfileDefinition(current, name, definition, resources);
			});
			return;
		}

		const path = this.getProfileFilePath(name);
		const existing = existsSync(path)
			? parseProfileFileDefinition(readFileSync(path, "utf-8"), name)
			: { name, resources: {} };
		const payload = mergeProfileDefinition(name, definition, resources, existing);
		this.mutateProfileFiles(() => {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, JSON.stringify(payload, null, 2), "utf-8");
		});
	}

	/**
	 * Delete a profile from the selected scope.
	 */
	deleteProfile(profileName: string, scope: ProfilePersistenceScope): void {
		const name = normalizeProfileName(profileName);

		if (scope === "session") {
			const next = { ...this.inlineResourceProfileDefinitions };
			delete next[name];
			this.inlineResourceProfileDefinitions = next;
			this.refreshProfileRegistry();
			if (this.runtimeResourceProfiles) {
				this.setRuntimeResourceProfiles(this.runtimeResourceProfiles.filter((profile) => profile !== name));
			}
			return;
		}

		if (scope === "global") {
			const next = { ...(this.globalSettings.resourceProfiles ?? {}) };
			delete next[name];
			if (Object.keys(next).length > 0) {
				this.globalSettings.resourceProfiles = next;
			} else {
				delete this.globalSettings.resourceProfiles;
			}
			if (this.globalSettings.activeResourceProfile === name) {
				delete this.globalSettings.activeResourceProfile;
			}
			if (this.globalSettings.activeResourceProfiles) {
				this.globalSettings.activeResourceProfiles = this.globalSettings.activeResourceProfiles.filter(
					(profile) => profile !== name,
				);
				if (this.globalSettings.activeResourceProfiles.length === 0) {
					delete this.globalSettings.activeResourceProfiles;
				}
			}
			this.markModified("resourceProfiles");
			this.save();
			return;
		}

		if (scope === "project") {
			this.updateProjectSettings("resourceProfiles", (settings) => {
				const next = { ...(settings.resourceProfiles ?? {}) };
				delete next[name];
				if (Object.keys(next).length > 0) {
					settings.resourceProfiles = next;
				} else {
					delete settings.resourceProfiles;
				}
				if (settings.activeResourceProfile === name) {
					delete settings.activeResourceProfile;
				}
				if (settings.activeResourceProfiles) {
					settings.activeResourceProfiles = settings.activeResourceProfiles.filter((profile) => profile !== name);
					if (settings.activeResourceProfiles.length === 0) {
						delete settings.activeResourceProfiles;
					}
				}
			});
			return;
		}

		if (scope === "directory") {
			this.persistDirectoryProfiles((current) => {
				const next = { ...(current.resourceProfiles ?? {}) };
				delete next[name];
				if (Object.keys(next).length > 0) {
					current.resourceProfiles = next;
				} else {
					delete current.resourceProfiles;
				}
				if (current.activeResourceProfile === name) {
					delete current.activeResourceProfile;
				}
				if (current.activeResourceProfiles) {
					current.activeResourceProfiles = current.activeResourceProfiles.filter((profile) => profile !== name);
					if (current.activeResourceProfiles.length === 0) {
						delete current.activeResourceProfiles;
					}
				}
			});
			return;
		}

		const profilePath = this.getProfileFilePath(name);
		if (!existsSync(profilePath)) {
			throw new Error(`Profile not found: ${name}`);
		}
		this.mutateProfileFiles(() => rmSync(profilePath, { force: true }));
		this.rewriteReusableProfileSelections(name, undefined);
	}

	renameProfile(profileName: string, newProfileName: string, scope: ProfilePersistenceScope): void {
		const oldName = normalizeProfileName(profileName);
		const newName = normalizeProfileName(newProfileName);
		if (oldName === newName) {
			return;
		}

		if (scope === "session") {
			const profile = this.inlineResourceProfileDefinitions[oldName];
			if (!profile) {
				throw new Error(`Profile not found: ${oldName}`);
			}
			delete this.inlineResourceProfileDefinitions[oldName];
			this.inlineResourceProfileDefinitions[newName] = profile;
			if (this.runtimeResourceProfiles) {
				this.runtimeResourceProfiles = this.runtimeResourceProfiles.map((name) =>
					name === oldName ? newName : name,
				);
				this.setRuntimeResourceProfiles(this.runtimeResourceProfiles);
			}
			this.refreshProfileRegistry();
			return;
		}

		if (scope === "global") {
			const next = structuredClone(this.globalSettings);
			renameStoredProfileDefinition(next, oldName, newName);
			this.globalSettings = next;
			this.markModified("resourceProfiles");
			this.markModified("activeResourceProfile");
			this.markModified("activeResourceProfiles");
			this.save();
			return;
		}

		if (scope === "project") {
			this.updateProjectSettings("resourceProfiles", (settings) => {
				renameStoredProfileDefinition(settings, oldName, newName);
			});
			return;
		}

		if (scope === "directory") {
			this.persistDirectoryProfiles((current) => {
				renameStoredProfileDefinition(current, oldName, newName);
			});
			return;
		}

		const oldPath = this.getProfileFilePath(oldName);
		const newPath = this.getProfileFilePath(newName);
		if (!existsSync(oldPath)) {
			throw new Error(`Profile not found: ${oldName}`);
		}
		if (existsSync(newPath)) {
			throw new Error(`Profile already exists: ${newName}`);
		}
		const parsed = parseProfileFileDefinition(readFileSync(oldPath, "utf-8"), oldName);
		parsed.name = newName;
		this.mutateProfileFiles(() => {
			writeFileSync(newPath, JSON.stringify(parsed, null, 2), "utf-8");
			rmSync(oldPath, { force: true });
		});
		this.rewriteReusableProfileSelections(oldName, newName);
	}

	/**
	 * Set active profile selection in the selected scope.
	 */
	setActiveProfile(profileName: string | undefined, scope: Exclude<ProfilePersistenceScope, "reusable-file">): void {
		const name = profileName ? normalizeProfileSelection(profileName) : undefined;
		if (scope === "session") {
			if (name) {
				this.setRuntimeResourceProfiles([name]);
			} else {
				this.setRuntimeResourceProfiles([]);
			}
			return;
		}

		if (scope === "global") {
			if (name) {
				this.globalSettings.activeResourceProfile = name;
				this.globalSettings.activeResourceProfiles = [name];
			} else {
				delete this.globalSettings.activeResourceProfile;
				this.globalSettings.activeResourceProfiles = [];
			}
			this.markModified("activeResourceProfile");
			this.markModified("activeResourceProfiles");
			this.save();
			return;
		}

		if (scope === "project") {
			this.updateProjectSettings("activeResourceProfile", (settings) => {
				setActiveProfileInSettings(settings, name);
			});
			return;
		}

		this.persistDirectoryProfiles((current) => {
			setActiveProfileInSettings(current, name);
		});
	}

	/** Atomically replace the global profile/authority fields used by config restore and rollback. */
	replaceGlobalResourceProfileConfiguration(configuration: GlobalResourceProfileConfiguration): void {
		const next = structuredClone(this.globalSettings);
		const replace = <K extends keyof GlobalResourceProfileConfiguration>(key: K): void => {
			const value = configuration[key];
			if (value === undefined) {
				delete next[key];
			} else {
				next[key] = structuredClone(value) as Settings[K];
			}
			this.markModified(key);
		};
		replace("resourceProfiles");
		replace("activeResourceProfile");
		replace("activeResourceProfiles");
		replace("externalResourceRoots");
		replace("trustedResourceRoots");
		this.globalSettings = next;
		this.save();
	}

	/** Restore one profile definition's persistent owner after a post-doctor commit failure. */
	restoreProfileDefinitionFromReloadSnapshot(
		profileName: string,
		scope: Exclude<ProfilePersistenceScope, "reusable-file">,
		snapshot: SettingsReloadSnapshot,
	): void {
		const name = normalizeProfileName(profileName);
		if (scope === "session") {
			const previous = snapshot.inlineResourceProfileDefinitions[name];
			if (previous) this.inlineResourceProfileDefinitions[name] = structuredClone(previous);
			else delete this.inlineResourceProfileDefinitions[name];
			this.refreshProfileRegistry();
			return;
		}

		const restoreDefinition = (settings: Settings, previous: Settings): void => {
			const definitions = structuredClone(settings.resourceProfiles ?? {});
			const oldDefinition = previous.resourceProfiles?.[name];
			if (oldDefinition) definitions[name] = structuredClone(oldDefinition);
			else delete definitions[name];
			if (Object.keys(definitions).length > 0) settings.resourceProfiles = definitions;
			else delete settings.resourceProfiles;
		};

		if (scope === "global") {
			restoreDefinition(this.globalSettings, snapshot.globalSettings);
			this.markModified("resourceProfiles");
			this.save();
			return;
		}
		if (scope === "project") {
			this.updateProjectSettings("resourceProfiles", (settings) => {
				restoreDefinition(settings, snapshot.projectSettings);
			});
			return;
		}
		this.persistDirectoryProfiles((settings) => {
			restoreDefinition(settings, snapshot.directoryProfileSettings);
		});
	}

	/** Mark a global field as modified during this session */
	private markModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedFields.add(field);
		if (nestedKey) {
			if (!this.modifiedNestedFields.has(field)) {
				this.modifiedNestedFields.set(field, new Set());
			}
			this.modifiedNestedFields.get(field)!.add(nestedKey);
		}
	}

	/** Mark a project field as modified during this session */
	private markProjectModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedProjectFields.add(field);
		if (nestedKey) {
			if (!this.modifiedProjectNestedFields.has(field)) {
				this.modifiedProjectNestedFields.set(field, new Set());
			}
			this.modifiedProjectNestedFields.get(field)!.add(nestedKey);
		}
	}

	private assertProjectTrustedForWrite(): void {
		if (!this.projectTrusted) {
			throw new Error("Project is not trusted; refusing to write project settings");
		}
	}

	private recordError(scope: SettingsErrorScope, error: unknown): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push({ scope, error: normalizedError });
	}

	private clearModifiedScope(scope: SettingsScope): void {
		if (scope === "global") {
			this.modifiedFields.clear();
			this.modifiedNestedFields.clear();
			return;
		}

		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();
	}

	/**
	 * Reusable profile files (`profiles/<name>.json`) are the one settings artifact written outside the
	 * queued scopes: callers read them straight back, so the write stays synchronous and touches no
	 * scope's pending-field bookkeeping. They get the same worker suppression as `enqueueWrite`.
	 */
	private mutateProfileFiles(task: () => void): void {
		if (isWorkerSession()) return;
		task();
	}

	private enqueueWrite(scope: SettingsScope, task: () => void): void {
		// Zero-footprint (worker session): this is the universal disk-write choke for every settings
		// scope (save() -> "global", saveProjectSettings() -> "project", directoryProfile writes) --
		// a worker session never writes settings.json (or any scoped variant) to disk. In-memory
		// settings are already updated by the caller before reaching here, so reads are unaffected.
		if (isWorkerSession()) return;
		this.writeQueue = this.writeQueue
			.then(() => {
				if (scope === "project") {
					this.assertProjectTrustedForWrite();
				}
				task();
				this.clearModifiedScope(scope);
			})
			.catch((error) => {
				this.recordError(scope, error);
			});
	}

	private cloneModifiedNestedFields(source: Map<keyof Settings, Set<string>>): Map<keyof Settings, Set<string>> {
		const snapshot = new Map<keyof Settings, Set<string>>();
		for (const [key, value] of source.entries()) {
			snapshot.set(key, new Set(value));
		}
		return snapshot;
	}

	private persistScopedSettings(
		scope: SettingsScope,
		snapshotSettings: Settings,
		modifiedFields: Set<keyof Settings>,
		modifiedNestedFields: Map<keyof Settings, Set<string>>,
	): void {
		this.storage.withLock(scope, (current) => {
			const currentFileSettings = current
				? migrateSettings(JSON.parse(stripBom(current)) as Record<string, unknown>)
				: {};
			const mergedSettings: Settings = { ...currentFileSettings };
			for (const field of modifiedFields) {
				const value = snapshotSettings[field];
				if (modifiedNestedFields.has(field) && typeof value === "object" && value !== null) {
					const nestedModified = modifiedNestedFields.get(field)!;
					const baseNested = (currentFileSettings[field] as Record<string, unknown>) ?? {};
					const inMemoryNested = value as Record<string, unknown>;
					const mergedNested = { ...baseNested };
					for (const nestedKey of nestedModified) {
						mergedNested[nestedKey] = inMemoryNested[nestedKey];
					}
					(mergedSettings as Record<string, unknown>)[field] = mergedNested;
				} else {
					(mergedSettings as Record<string, unknown>)[field] = value;
				}
			}

			return JSON.stringify(mergedSettings, null, 2);
		});
	}

	private save(): void {
		this.recomputeSettings();

		if (this.globalSettingsLoadError) {
			return;
		}

		const snapshotGlobalSettings = structuredClone(this.globalSettings);
		const modifiedFields = new Set(this.modifiedFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedNestedFields);

		this.enqueueWrite("global", () => {
			this.persistScopedSettings("global", snapshotGlobalSettings, modifiedFields, modifiedNestedFields);
		});
	}

	private saveProjectSettings(settings: Settings): void {
		this.assertProjectTrustedForWrite();
		this.projectSettings = structuredClone(settings);
		this.recomputeSettings();

		if (this.projectSettingsLoadError) {
			return;
		}

		const snapshotProjectSettings = structuredClone(this.projectSettings);
		const modifiedFields = new Set(this.modifiedProjectFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedProjectNestedFields);
		this.enqueueWrite("project", () => {
			this.persistScopedSettings("project", snapshotProjectSettings, modifiedFields, modifiedNestedFields);
		});
	}

	private updateProjectSettings(field: keyof Settings, update: (settings: Settings) => void): void {
		this.assertProjectTrustedForWrite();
		const projectSettings = structuredClone(this.projectSettings);
		update(projectSettings);
		this.markProjectModified(field);
		this.saveProjectSettings(projectSettings);
	}

	/** Validate and publish against the locked, current settings generation. */
	async activateLocalModelPool(
		refs: readonly string[],
		signal?: AbortSignal,
		validate?: (current: SettingsManager, candidate: Settings, projected: Settings) => void,
	): Promise<void> {
		await this.flush();
		signal?.throwIfAborted();
		if (!this.storage.updateGlobalSnapshot) throw new Error("Settings storage cannot atomically validate activation");
		let committed: Settings | undefined;
		let validated: SettingsManager | undefined;
		this.storage.updateGlobalSnapshot((snapshot) => {
			const parent = this.storage;
			const snapshotStorage: SettingsStorage = {
				withLock: (scope, fn) => {
					fn(
						scope === "global"
							? snapshot.global
							: scope === "project"
								? snapshot.project
								: snapshot.directoryProfile,
					);
				},
				getProfilesDir: () => parent.getProfilesDir?.() ?? "",
				getProfileResolutionBaseDir: () => parent.getProfileResolutionBaseDir?.() ?? process.cwd(),
			};
			const current = SettingsManager.fromStorage(snapshotStorage, { projectTrusted: this.projectTrusted });
			if (
				current.globalSettingsLoadError ||
				current.projectSettingsLoadError ||
				current.directoryProfileSettingsLoadError
			)
				throw new Error("Settings could not be loaded; activation refused");
			committed = current.prepareLocalModelPool(refs, signal);
			validate?.(current, committed, current.mergeEffectiveSettings(committed));
			signal?.throwIfAborted();
			validated = current;
			return JSON.stringify(committed, null, 2);
		});
		if (!committed || !validated) throw new Error("Settings activation was not committed");
		this.globalSettings = committed;
		this.projectSettings = validated.projectSettings;
		this.directoryProfileSettings = validated.directoryProfileSettings;
		this.recomputeSettings();
	}

	private prepareLocalModelPool(refs: readonly string[], signal?: AbortSignal): Settings {
		if (refs.length === 0 || refs.some((ref) => !ref.startsWith("ollama/") || ref.length <= "ollama/".length)) {
			throw new Error("A nonempty Ollama model pool is required");
		}
		if (isWorkerSession()) throw new Error("Workers cannot activate a model pool");
		if (this.globalSettingsLoadError) throw new Error("Global settings could not be loaded; activation refused");
		const primary = refs[0]!;
		const next = structuredClone(this.globalSettings);
		next.modelFavorites = this.getModelFavoritesIncluding(refs);
		next.enabledModels = [...refs];
		next.defaultProvider = "ollama";
		next.defaultModel = primary.slice("ollama/".length);
		next.defaultThinkingLevel = "off";
		next.systemOne = { ...next.systemOne, enabled: true };
		next.compaction = { ...next.compaction, model: primary };
		next.contextPolicy = {
			...next.contextPolicy,
			memory: {
				...next.contextPolicy?.memory,
				history: {
					...next.contextPolicy?.memory?.history,
					summaryModel: primary,
					allowExternalSummaryEgress: false,
				},
			},
		};
		next.workerDelegation = { ...next.workerDelegation, account: "same" };
		next.localRuntimes = { ...next.localRuntimes, ollama: { ...next.localRuntimes?.ollama, enabled: true } };
		next.modelRouter = {
			...next.modelRouter,
			enabled: true,
			selectionMode: "auto",
			fitnessGate: true,
			cheapModel: undefined,
			mediumModel: undefined,
			expensiveModel: undefined,
			executorModel: primary,
			learningModel: primary,
			cheapThinking: "off",
			mediumThinking: "off",
			expensiveThinking: "off",
			executorThinking: "off",
		};
		// Build the effective candidate without publishing a transient settings change.
		const projected = this.mergeEffectiveSettings(next);
		const profileRouter = this.getProfileModelRouterSettings();
		const router = { ...projected.modelRouter, ...profileRouter };
		const enabled = projected.enabledModels;
		if (
			projected.defaultProvider !== "ollama" ||
			projected.defaultModel !== next.defaultModel ||
			projected.defaultThinkingLevel !== "off" ||
			projected.localRuntimes?.ollama?.enabled === false ||
			projected.systemOne?.enabled !== true ||
			projected.workerDelegation?.account !== "same" ||
			projected.contextPolicy?.memory?.history?.allowExternalSummaryEgress !== false ||
			!isSystemOneEnabled({ getSystemOneSettings: () => projected.systemOne ?? {} }) ||
			!enabled ||
			enabled.length !== refs.length ||
			enabled.some((ref, i) => ref !== refs[i]) ||
			router.enabled !== true ||
			router.selectionMode !== "auto" ||
			router.fitnessGate !== true ||
			[router.cheapThinking, router.mediumThinking, router.expensiveThinking, router.executorThinking].some(
				(level) => level !== "off",
			) ||
			[router.cheapModel, router.mediumModel, router.expensiveModel].some(
				(ref) => ref !== undefined && ref.trim() !== "",
			) ||
			router.executorModel !== primary ||
			router.learningModel !== primary
		) {
			throw new Error(
				"Project, directory or active profile settings override the requested local model configuration",
			);
		}

		signal?.throwIfAborted();
		return next;
	}
	async flush(): Promise<void> {
		await this.writeQueue;
	}

	drainErrors(): SettingsError[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	getLastChangelogVersion(): string | undefined {
		return this.settings.lastChangelogVersion;
	}

	setLastChangelogVersion(version: string): void {
		this.setPlain("lastChangelogVersion", version);
	}

	getSessionDir(): string | undefined {
		const sessionDir = this.settings.sessionDir;
		return sessionDir ? normalizePath(sessionDir) : sessionDir;
	}

	getDefaultProvider(): string | undefined {
		return this.settings.defaultProvider;
	}

	getDefaultModel(): string | undefined {
		return this.settings.defaultModel;
	}

	setDefaultProvider(provider: string): void {
		this.setPlain("defaultProvider", provider);
	}

	setDefaultModel(modelId: string): void {
		this.setPlain("defaultModel", modelId);
	}

	setDefaultModelAndProvider(provider: string, modelId: string): void {
		this.globalSettings.defaultProvider = provider;
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultProvider");
		this.markModified("defaultModel");
		this.save();
	}

	getSteeringMode(): "all" | "one-at-a-time" {
		// Every queued steering message reaches the next model turn together; the census saw the
		// second of two steers wait a whole turn with nothing on screen saying so.
		return this.settings.steeringMode || "all";
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.setPlain("steeringMode", mode);
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return this.settings.followUpMode || "one-at-a-time";
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.setPlain("followUpMode", mode);
	}

	getTheme(): string | undefined {
		return this.settings.theme;
	}

	setTheme(theme: string): void {
		this.setPlain("theme", theme);
	}

	/** The configured resource catalog directory, if any (round resource management). */
	getCatalogDir(): string | undefined {
		return this.settings.catalogDir;
	}

	setCatalogDir(dir: string | undefined): void {
		if (dir) {
			this.globalSettings.catalogDir = dir;
		} else {
			delete this.globalSettings.catalogDir;
		}
		this.markModified("catalogDir");
		this.save();
	}

	getDefaultThinkingLevel(): ThinkingLevel | undefined {
		return this.settings.defaultThinkingLevel;
	}

	setDefaultThinkingLevel(level: ThinkingLevel): void {
		this.setPlain("defaultThinkingLevel", level);
	}

	getFastModePreference(provider: string): FastModePreference | undefined {
		const preference = this.settings.fastMode?.[provider];
		return typeof preference === "boolean" || preference === "ultrafast" ? preference : undefined;
	}

	setFastModePreference(provider: string, preference: FastModePreference): void {
		if (!provider || provider === "__proto__" || provider === "constructor" || provider === "prototype") {
			throw new TypeError(`Invalid fast-mode provider '${provider}'.`);
		}
		if (typeof preference !== "boolean" && preference !== "ultrafast") {
			throw new TypeError("Invalid fast-mode preference; expected a boolean or 'ultrafast'.");
		}
		this.globalSettings.fastMode = { ...(this.globalSettings.fastMode ?? {}), [provider]: preference };
		this.markModified("fastMode", provider);
		this.save();
	}

	getFastModeEnabled(provider: string): boolean | undefined {
		const preference = this.getFastModePreference(provider);
		return preference === "ultrafast" ? true : preference;
	}

	setFastModeEnabled(provider: string, enabled: boolean): void {
		this.setFastModePreference(provider, enabled);
	}

	getTransport(): TransportSetting {
		return this.settings.transport ?? "auto";
	}

	setTransport(transport: TransportSetting): void {
		this.setPlain("transport", transport);
	}

	getCompactionEnabled(): boolean {
		return this.settings.compaction?.enabled ?? DEFAULT_COMPACTION_SETTINGS.enabled;
	}

	setCompactionEnabled(enabled: boolean): void {
		if (!this.globalSettings.compaction) {
			this.globalSettings.compaction = {};
		}
		this.globalSettings.compaction.enabled = enabled;
		this.markModified("compaction", "enabled");
		this.save();
	}

	getCompactionReserveTokens(): number {
		return this.settings.compaction?.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens;
	}

	getCompactionKeepRecentTokens(): number {
		return this.settings.compaction?.keepRecentTokens ?? DEFAULT_COMPACTION_SETTINGS.keepRecentTokens;
	}

	getCompactionTriggerPercent(): number {
		const triggerPercent = this.settings.compaction?.triggerPercent ?? DEFAULT_COMPACTION_SETTINGS.triggerPercent;
		if (triggerPercent === undefined) throw new Error("default compaction triggerPercent is not configured");
		return triggerPercent;
	}

	hasExplicitCompactionTriggerPercent(): boolean {
		return this.settings.compaction?.triggerPercent !== undefined;
	}

	/**
	 * Skill curator (#32). Auto-archive of stale reflection-promoted skills is ON by default (restorable,
	 * announced, promoted-only). Set `autoArchive: false` to make it propose-only (`/curate`).
	 */
	getCuratorSettings(): { autoArchive: boolean; staleDays: number } {
		return resolveCuratorSettings(this.settings);
	}

	/**
	 * Optional per-turn cost guard (#34). Explicit `enabled: true` is mandatory; this keeps positive
	 * thresholds written by older releases dormant instead of silently restoring a spend guard.
	 */
	getCostGuardSettings(): CostGuardSettings {
		return resolveCostGuardSettings(this.settings);
	}

	setCostGuardSettings(settings: CostGuardSettings, scope: SettingsScope = "global"): void {
		const normalized = normalizeCostGuardSettings(settings);
		if (scope === "project") {
			const projectSettings = structuredClone(this.projectSettings);
			projectSettings.costGuard = normalized;
			this.markProjectModified("costGuard");
			this.saveProjectSettings(projectSettings);
			return;
		}
		this.globalSettings.costGuard = normalized;
		this.markModified("costGuard");
		this.save();
	}

	private readonly reasoningLevelRejected = new Map<string, unknown>();

	/**
	 * One request-local reasoning setting (see {@link ReasoningSettings}). An unrecognized value is
	 * reported once by name through the settings diagnostics and then reads as unset, so a typo
	 * neither reaches the provider nor passes silently.
	 */
	private readReasoningLevelSetting(
		key: "hostTurnThinking" | "bookkeepingThinking",
		fallbackDescription: string,
	): ThinkingLevel | "inherit" | undefined {
		const configured = this.settings.reasoning?.[key];
		if (configured === undefined || configured === "inherit") return configured;
		if (isThinkingLevel(configured)) return configured;
		if (this.reasoningLevelRejected.get(key) !== configured) {
			this.reasoningLevelRejected.set(key, configured);
			this.recordError(
				"global",
				new Error(
					`reasoning.${key}: unknown value ${JSON.stringify(configured)}; expected a thinking level or "inherit". Using the default (${fallbackDescription}).`,
				),
			);
		}
		return undefined;
	}

	/** Host-turn reasoning policy (see {@link ReasoningSettings.hostTurnThinking}). */
	getHostTurnThinkingLevel(): ThinkingLevel | "inherit" | undefined {
		return this.readReasoningLevelSetting("hostTurnThinking", "one level below the session level");
	}

	/** Bookkeeping-continuation reasoning policy (see {@link ReasoningSettings.bookkeepingThinking}). */
	getBookkeepingThinkingLevel(): ThinkingLevel | "inherit" | undefined {
		return this.readReasoningLevelSetting("bookkeepingThinking", "low, clamped to the session level");
	}

	/** Both request-local reasoning policies, read live for the next request. */
	getCheapTurnSettings(): {
		hostTurn: ThinkingLevel | "inherit" | undefined;
		bookkeeping: ThinkingLevel | "inherit" | undefined;
	} {
		return { hostTurn: this.getHostTurnThinkingLevel(), bookkeeping: this.getBookkeepingThinkingLevel() };
	}

	getFailoverSettings(): Required<FailoverSettings> {
		return { subscriptionHop: this.settings.failover?.subscriptionHop ?? true };
	}

	private getProfileModelRouterSettings(): ModelRouterSettings | undefined {
		const activeProfileNames = this.getActiveResourceProfileNames();
		if (activeProfileNames.length === 0) return undefined;
		const registry = this.getProfileRegistry();
		const merged: ModelRouterSettings = {};
		for (let index = activeProfileNames.length - 1; index >= 0; index--) {
			const profile = this.resolveProfileFromRegistry(registry, activeProfileNames[index]);
			const router = profile?.modelRouter;
			if (!router) continue;
			if (router.enabled !== undefined) merged.enabled = router.enabled;
			if (router.selectionMode !== undefined) merged.selectionMode = router.selectionMode;
			if (router.poolPreference !== undefined) merged.poolPreference = router.poolPreference;
			if (router.fitnessGate !== undefined) merged.fitnessGate = router.fitnessGate;
			if (router.cheapModel !== undefined) merged.cheapModel = router.cheapModel;
			if (router.mediumModel !== undefined) merged.mediumModel = router.mediumModel;
			if (router.expensiveModel !== undefined) merged.expensiveModel = router.expensiveModel;
			if (router.learningModel !== undefined) merged.learningModel = router.learningModel;
			if (router.executorModel !== undefined) merged.executorModel = router.executorModel;
			if (router.cheapThinking !== undefined) merged.cheapThinking = router.cheapThinking;
			if (router.mediumThinking !== undefined) merged.mediumThinking = router.mediumThinking;
			if (router.expensiveThinking !== undefined) merged.expensiveThinking = router.expensiveThinking;
			if (router.executorThinking !== undefined) merged.executorThinking = router.executorThinking;
			if (router.hmoePreset !== undefined) merged.hmoePreset = router.hmoePreset;
			if (router.hmoeTeamStrategy !== undefined) merged.hmoeTeamStrategy = router.hmoeTeamStrategy;
			if (router.hmoeIndependence !== undefined) merged.hmoeIndependence = router.hmoeIndependence;
			if (router.hmoePreference !== undefined) merged.hmoePreference = router.hmoePreference;
			if (router.hmoeWeights !== undefined) merged.hmoeWeights = router.hmoeWeights;
		}
		return Object.keys(merged).length > 0 ? merged : undefined;
	}

	/**
	 * What an unset `modelRouter.enabled` means for this session: routing is on when the session has
	 * System One to judge it, off otherwise. The session sets it once it knows; an explicit setting wins.
	 */
	setModelRouterDefaultEnabled(enabled: boolean): void {
		this.modelRouterDefaultEnabled = enabled;
	}

	getModelRouterSettings(): {
		enabled: boolean;
		selectionMode: ModelRouterSelectionMode;
		poolPreference: ModelRouterPoolPreference;
		cheapModel?: string;
		mediumModel?: string;
		expensiveModel?: string;
		learningModel?: string;
		executorModel?: string;
		fitnessGate: boolean;
		cheapThinking?: ThinkingLevel;
		mediumThinking?: ThinkingLevel;
		expensiveThinking?: ThinkingLevel;
		executorThinking?: ThinkingLevel;
		hmoePreset?: HmoePreset;
		hmoeTeamStrategy?: HmoeTeamStrategy;
		hmoeIndependence?: HmoeIndependence;
		hmoePreference?: HmoePreference;
		hmoeWeights?: HmoeWeights;
	} {
		return resolveModelRouterSettings(
			this.settings,
			this.getProfileModelRouterSettings(),
			this.modelRouterDefaultEnabled,
		);
	}

	setModelRouterSettings(settings: ModelRouterSettings, scope: SettingsScope = "global"): void {
		const normalized = normalizeModelRouterSettings(settings);
		if (scope === "project") {
			const projectSettings = structuredClone(this.projectSettings);
			projectSettings.modelRouter = normalized;
			this.markProjectModified("modelRouter");
			this.saveProjectSettings(projectSettings);
			return;
		}

		this.globalSettings.modelRouter = normalized;
		this.markModified("modelRouter");
		this.save();
	}

	isLocalRuntimeEnabled(runtime: "ollama" | "llamacpp" | "transformers"): boolean {
		const cfg = this.settings.localRuntimes?.[runtime];
		return cfg?.enabled ?? true;
	}

	setLocalRuntimeEnabled(
		runtime: "ollama" | "llamacpp" | "transformers",
		enabled: boolean,
		scope: SettingsScope = "global",
	): void {
		const current = this.settings.localRuntimes ?? {};
		const updated: LocalRuntimesSettings = {
			...current,
			[runtime]: { ...current[runtime], enabled },
		};
		if (scope === "project") {
			const projectSettings = structuredClone(this.projectSettings);
			projectSettings.localRuntimes = updated;
			this.markProjectModified("localRuntimes");
			this.saveProjectSettings(projectSettings);
			return;
		}

		this.globalSettings.localRuntimes = updated;
		this.markModified("localRuntimes");
		this.save();
	}

	/** Configured auxiliary summarizer model id, or "auto" (default) to pick the cheapest authed model. */
	getCompactionModel(): string {
		return this.settings.compaction?.model ?? "auto";
	}

	getSelfCompactionSettings(): SelfCompactionSettings {
		const raw = this.settings.compaction?.selfMonitor ?? {};
		const key = JSON.stringify(raw);
		if (this.resolvedSelfCompaction?.key !== key) {
			this.resolvedSelfCompaction = { key, value: resolveSelfCompactionSettings(raw) };
		}
		return this.resolvedSelfCompaction.value;
	}

	getCompactionSettings(): {
		enabled: boolean;
		reserveTokens: number;
		keepRecentTokens: number;
		triggerPercent: number;
	} {
		return {
			enabled: this.getCompactionEnabled(),
			reserveTokens: this.getCompactionReserveTokens(),
			keepRecentTokens: this.getCompactionKeepRecentTokens(),
			triggerPercent: this.getCompactionTriggerPercent(),
		};
	}

	getLoggingSettings(): { level?: LogLevel; categories?: string[]; maxFileMb?: number; retainDays?: number } {
		return resolveLoggingSettings(this.settings);
	}

	getOrchestratorSettings(): { delegationGate: boolean } {
		return { delegationGate: this.settings.orchestrator?.delegationGate ?? false };
	}

	getScoutSettings(): { enabled: boolean; model: string } {
		return {
			enabled: this.settings.scout?.enabled ?? false,
			model: this.settings.scout?.model ?? "auto",
		};
	}

	setScoutSettings(settings: ScoutSettings, scope: SettingsScope = "global"): void {
		if (scope === "project") {
			const projectSettings = structuredClone(this.projectSettings);
			projectSettings.scout = { ...settings };
			this.markProjectModified("scout");
			this.saveProjectSettings(projectSettings);
			return;
		}
		this.globalSettings.scout = { ...settings };
		this.markModified("scout");
		this.save();
	}

	getSystemOneSettings(): {
		enabled: boolean;
		provider: SystemOneProviderChoice;
		loopMode?: SystemOneSettings["loopMode"];
		completionProfile?: SystemOneSettings["completionProfile"];
	} {
		return resolveSystemOneSettings(this.settings);
	}

	/** Switches System One's provider; every evaluation resolves it anew, so the next one uses it. */
	setSystemOneProvider(provider: SystemOneProviderChoice): void {
		this.globalSettings.systemOne = { ...this.globalSettings.systemOne, provider };
		this.markModified("systemOne");
		this.save();
	}

	setSystemOneSettings(settings: SystemOneSettings, scope: SettingsScope = "global"): void {
		if (scope === "project") {
			const projectSettings = structuredClone(this.projectSettings);
			projectSettings.systemOne = { ...settings };
			this.markProjectModified("systemOne");
			this.saveProjectSettings(projectSettings);
			return;
		}
		this.globalSettings.systemOne = { ...settings };
		this.markModified("systemOne");
		this.save();
	}

	getContextGcSettings(): {
		enabled: boolean;
		preserveRecentMessages: number;
		packStrideMessages: number;
		minToolResultChars: number;
		tools: string[];
		semanticMemory: {
			enabled: boolean;
			preserveRecentPages: number;
			minChars: number;
			markers: string[];
		};
	} {
		return resolveContextGcSettings(this.settings);
	}

	getContextPromptEnforcementSettings(): { enabled: boolean; preserveRecentMessages: number; minChars: number } {
		return resolveContextPromptEnforcementSettings(this.settings, this.getContextGcSettings());
	}

	getContextCurationSettings(): { enabled: boolean; model?: string; maxJobsPerTurn: number } {
		return resolveContextCurationSettings(this.settings);
	}

	setContextCurationSettings(settings: ContextCurationSettings, scope: SettingsScope = "global"): void {
		if (scope === "project") {
			const projectSettings = structuredClone(this.projectSettings);
			projectSettings.contextPolicy = { ...projectSettings.contextPolicy, curation: { ...settings } };
			this.markProjectModified("contextPolicy");
			this.saveProjectSettings(projectSettings);
			return;
		}
		this.globalSettings.contextPolicy = { ...this.globalSettings.contextPolicy, curation: { ...settings } };
		this.markModified("contextPolicy");
		this.save();
	}

	setContextPromptEnforcementSettings(
		settings: ContextPromptEnforcementSettings,
		scope: SettingsScope = "global",
	): void {
		if (scope === "project") {
			const projectSettings = structuredClone(this.projectSettings);
			projectSettings.contextPolicy = { ...projectSettings.contextPolicy, enforcement: { ...settings } };
			this.markProjectModified("contextPolicy");
			this.saveProjectSettings(projectSettings);
			return;
		}

		this.globalSettings.contextPolicy = { ...this.globalSettings.contextPolicy, enforcement: { ...settings } };
		this.markModified("contextPolicy");
		this.save();
	}

	getMemoryRetrievalSettings(): {
		enabled: boolean;
		maxResults: number;
		includeInPrompt: boolean;
		allowExternalEgress: boolean;
	} {
		return resolveMemoryRetrievalSettings(this.settings);
	}

	setMemoryRetrievalSettings(settings: MemoryRetrievalSettings, scope: SettingsScope = "global"): void {
		const normalized = normalizeMemoryRetrievalSettings(settings);
		if (scope === "project") {
			const projectSettings = structuredClone(this.projectSettings);
			const history = projectSettings.contextPolicy?.memory?.history;
			projectSettings.contextPolicy = {
				...projectSettings.contextPolicy,
				memory: { ...normalized, history },
			};
			this.markProjectModified("contextPolicy");
			this.saveProjectSettings(projectSettings);
			return;
		}

		const history = this.globalSettings.contextPolicy?.memory?.history;
		this.globalSettings.contextPolicy = {
			...this.globalSettings.contextPolicy,
			memory: { ...normalized, history },
		};
		this.markModified("contextPolicy");
		this.save();
	}

	getMemoryHistorySettings(): {
		hierarchy: boolean;
		summaryModel: string | undefined;
		compactionThinkingLevel: MemoryHistorySettings["compactionThinkingLevel"];
		compactionMaxUsdPerDay: number | undefined;
		allowExternalSummaryEgress: boolean;
		allowExternalAdmissionEgress: boolean;
		maxConcurrentSummaries: number;
		frontierMaxBytes: number;
		retentionDays: number | undefined;
	} {
		return resolveMemoryHistorySettings(this.settings);
	}

	setMemoryHistorySettings(settings: MemoryHistorySettings, scope: SettingsScope = "global"): void {
		const normalized = normalizeMemoryHistorySettings(settings);
		if (scope === "project") {
			const projectSettings = structuredClone(this.projectSettings);
			projectSettings.contextPolicy = {
				...projectSettings.contextPolicy,
				memory: { ...projectSettings.contextPolicy?.memory, history: normalized },
			};
			this.markProjectModified("contextPolicy");
			this.saveProjectSettings(projectSettings);
			return;
		}

		this.globalSettings.contextPolicy = {
			...this.globalSettings.contextPolicy,
			memory: { ...this.globalSettings.contextPolicy?.memory, history: normalized },
		};
		this.markModified("contextPolicy");
		this.save();
	}

	getBranchSummarySettings(): { reserveTokens: number; skipPrompt: boolean } {
		return {
			reserveTokens: this.settings.branchSummary?.reserveTokens ?? 16384,
			skipPrompt: this.settings.branchSummary?.skipPrompt ?? false,
		};
	}

	getBranchSummarySkipPrompt(): boolean {
		return this.settings.branchSummary?.skipPrompt ?? false;
	}

	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? true;
	}

	setRetryEnabled(enabled: boolean): void {
		if (!this.globalSettings.retry) {
			this.globalSettings.retry = {};
		}
		this.globalSettings.retry.enabled = enabled;
		this.markModified("retry", "enabled");
		this.save();
	}

	getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number } {
		return {
			enabled: this.getRetryEnabled(),
			maxRetries: this.settings.retry?.maxRetries ?? 3,
			baseDelayMs: this.settings.retry?.baseDelayMs ?? 2000,
		};
	}

	/**
	 * Stream-stall watchdog bounds (pi-agent-core reliability/watchdogs.ts) for one model class.
	 * Returns only the fields the user set, validated; unset fields fall back to that class's
	 * defaults at the wiring site (agent-session's stall resolver), which are DEFAULT_STREAM_IDLE
	 * for `local` and DEFAULT_CLOUD_STREAM_IDLE for `cloud`. Resolved per request, so edits apply
	 * live. The legacy top-level bounds are the `local` budget; a `local` entry overrides them
	 * field by field. See {@link StreamStallBudgetSettings}.
	 */
	getStreamStallSettings(modelClass: StreamStallModelClass): StreamStallSettings {
		this.reportLegacyStreamStallScopeDiagnostic();
		return resolveStreamStallSettings(this.settings, modelClass);
	}

	getHttpIdleTimeoutMs(): number {
		return parseTimeoutSetting(this.settings.httpIdleTimeoutMs, "httpIdleTimeoutMs") ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS;
	}

	setHttpIdleTimeoutMs(timeoutMs: number): void {
		if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
			throw new Error(`Invalid httpIdleTimeoutMs setting: ${String(timeoutMs)}`);
		}
		this.globalSettings.httpIdleTimeoutMs = Math.floor(timeoutMs);
		this.markModified("httpIdleTimeoutMs");
		this.save();
	}

	getProviderRetrySettings(): { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs: number } {
		return resolveProviderRetrySettings(this.settings);
	}

	/**
	 * Per-response output cap, in tokens. A model's registry limit is a theoretical maximum (grok-4.6
	 * advertises 500,000), and a request that carries no cap lets a degenerate generation run to it:
	 * measured live, one continuation turn streamed for over twenty minutes at the model's output
	 * price with nothing persisted. Real responses, a long file write included, stay far below this
	 * default; a goal's remaining budget still narrows it further, and a model with a smaller limit
	 * keeps that limit.
	 */
	getMaxOutputTokens(): number {
		return sanitizeIntegerSetting(this.settings.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 1, 2_000_000);
	}

	getWebSocketConnectTimeoutMs(): number | undefined {
		return parseTimeoutSetting(this.settings.websocketConnectTimeoutMs, "websocketConnectTimeoutMs");
	}

	getHideThinkingBlock(): boolean {
		return this.settings.hideThinkingBlock ?? true;
	}

	setHideThinkingBlock(hide: boolean): void {
		this.setPlain("hideThinkingBlock", hide);
	}

	getShellPath(): string | undefined {
		return this.settings.shellPath;
	}

	setShellPath(path: string | undefined): void {
		this.setPlain("shellPath", path);
	}

	getExposeSessionEnvironment(): boolean {
		return this.settings.exposeSessionEnvironment ?? true;
	}

	setExposeSessionEnvironment(enabled: boolean | undefined): void {
		this.setPlain("exposeSessionEnvironment", enabled);
	}

	getQuietStartup(): boolean {
		return this.settings.quietStartup ?? true;
	}

	/** Repository instruction resources are off unless a settings layer opts in. Global resources always load. */
	getProjectContextFiles(): "on-demand" | "off" {
		return this.settings.projectContextFiles === "on-demand" ? "on-demand" : "off";
	}

	/** One authoritative admission decision for project AGENTS-family context and instruction-bearing resources. */
	areProjectInstructionsEnabled(): boolean {
		return this.getProjectContextFiles() === "on-demand";
	}

	/** Which settings layer last set `projectContextFiles`, if any. */
	getProjectContextFilesScope(): SettingsScope | undefined {
		if (this.directoryProfileSettings.projectContextFiles !== undefined) return "directoryProfile";
		if (this.projectSettings.projectContextFiles !== undefined) return "project";
		if (this.globalSettings.projectContextFiles !== undefined) return "global";
		return undefined;
	}

	setProjectContextFiles(mode: "on-demand" | "off", scope: SettingsScope = "directoryProfile"): void {
		if (scope === "directoryProfile") {
			this.persistDirectoryProfiles((settings) => {
				settings.projectContextFiles = mode;
			});
			return;
		}
		if (scope === "project") {
			this.updateProjectSettings("projectContextFiles", (settings) => {
				settings.projectContextFiles = mode;
			});
			return;
		}
		this.globalSettings.projectContextFiles = mode;
		this.markModified("projectContextFiles");
		this.save();
	}

	setQuietStartup(quiet: boolean): void {
		this.setPlain("quietStartup", quiet);
	}

	getShellCommandPrefix(): string | undefined {
		return this.settings.shellCommandPrefix;
	}

	setShellCommandPrefix(prefix: string | undefined): void {
		this.setPlain("shellCommandPrefix", prefix);
	}

	getNpmCommand(): string[] | undefined {
		return this.settings.npmCommand ? [...this.settings.npmCommand] : undefined;
	}

	setNpmCommand(command: string[] | undefined): void {
		this.globalSettings.npmCommand = command ? [...command] : undefined;
		this.markModified("npmCommand");
		this.save();
	}

	getCollapseChangelog(): boolean {
		return this.settings.collapseChangelog ?? false;
	}

	setCollapseChangelog(collapse: boolean): void {
		this.setPlain("collapseChangelog", collapse);
	}

	getPackages(): PackageSource[] {
		return [...(this.settings.packages ?? [])];
	}

	setPackages(packages: PackageSource[]): void {
		this.globalSettings.packages = packages;
		this.markModified("packages");
		this.save();
	}

	setProjectPackages(packages: PackageSource[]): void {
		this.updateProjectSettings("packages", (settings) => {
			settings.packages = packages;
		});
	}

	getExtensionPaths(): string[] {
		return [...(this.settings.extensions ?? [])];
	}

	setExtensionPaths(paths: string[]): void {
		this.globalSettings.extensions = paths;
		this.markModified("extensions");
		this.save();
	}

	setProjectExtensionPaths(paths: string[]): void {
		this.updateProjectSettings("extensions", (settings) => {
			settings.extensions = paths;
		});
	}

	getSkillPaths(): string[] {
		return [...(this.settings.skills ?? [])];
	}

	setSkillPaths(paths: string[]): void {
		this.globalSettings.skills = paths;
		this.markModified("skills");
		this.save();
	}

	setProjectSkillPaths(paths: string[]): void {
		this.updateProjectSettings("skills", (settings) => {
			settings.skills = paths;
		});
	}

	getPromptTemplatePaths(): string[] {
		return [...(this.settings.prompts ?? [])];
	}

	setPromptTemplatePaths(paths: string[]): void {
		this.globalSettings.prompts = paths;
		this.markModified("prompts");
		this.save();
	}

	setProjectPromptTemplatePaths(paths: string[]): void {
		this.updateProjectSettings("prompts", (settings) => {
			settings.prompts = paths;
		});
	}

	getThemePaths(): string[] {
		return [...(this.settings.themes ?? [])];
	}

	setThemePaths(paths: string[]): void {
		this.globalSettings.themes = paths;
		this.markModified("themes");
		this.save();
	}

	setProjectThemePaths(paths: string[]): void {
		this.updateProjectSettings("themes", (settings) => {
			settings.themes = paths;
		});
	}

	getEnableSkillCommands(): boolean {
		return this.settings.enableSkillCommands ?? true;
	}

	setEnableSkillCommands(enabled: boolean): void {
		this.setPlain("enableSkillCommands", enabled);
	}

	getMemorySystem(): MemorySystem {
		return resolveMemorySystem(this.settings.memorySystem);
	}

	setMemorySystem(system: MemorySystem, scope: SettingsScope = "global"): void {
		if (!isValidMemorySystem(system)) {
			throw new Error(`Invalid memory system '${system}'. Must be 'okf' or 'icm'.`);
		}
		if (scope === "project") {
			const projectSettings = structuredClone(this.projectSettings);
			projectSettings.memorySystem = system;
			this.markProjectModified("memorySystem");
			this.saveProjectSettings(projectSettings);
			return;
		}
		if (scope === "directoryProfile") {
			this.persistDirectoryProfiles((settings) => {
				settings.memorySystem = system;
			});
			return;
		}
		this.globalSettings.memorySystem = system;
		this.markModified("memorySystem");
		this.save();
	}

	getSteStrictness(): number {
		return normalizeSteStrictness(this.settings.steStrictness);
	}

	setSteStrictness(strictness: number): void {
		if (!Number.isInteger(strictness) || strictness < 0 || strictness > 10) {
			throw new Error(`Invalid steStrictness '${strictness}'. Must be an integer from 0 (off) to 10.`);
		}
		this.globalSettings.steStrictness = strictness;
		this.markModified("steStrictness");
		this.save();
	}

	getThinkingBudgets(): ThinkingBudgetsSettings | undefined {
		return this.settings.thinkingBudgets;
	}

	getShowImages(): boolean {
		return this.settings.terminal?.showImages ?? true;
	}

	setShowImages(show: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.showImages = show;
		this.markModified("terminal", "showImages");
		this.save();
	}

	getImageWidthCells(): number {
		const width = this.settings.terminal?.imageWidthCells;
		if (typeof width !== "number" || !Number.isFinite(width)) {
			return 60;
		}
		return Math.max(1, Math.floor(width));
	}

	setImageWidthCells(width: number): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.imageWidthCells = Math.max(1, Math.floor(width));
		this.markModified("terminal", "imageWidthCells");
		this.save();
	}

	getClearOnShrink(): boolean {
		// Settings takes precedence, then env var, then default false
		if (this.settings.terminal?.clearOnShrink !== undefined) {
			return this.settings.terminal.clearOnShrink;
		}
		return process.env.PI_CLEAR_ON_SHRINK === "1";
	}

	setClearOnShrink(enabled: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.clearOnShrink = enabled;
		this.markModified("terminal", "clearOnShrink");
		this.save();
	}

	getShowTerminalProgress(): boolean {
		return this.settings.terminal?.showTerminalProgress ?? false;
	}

	setShowTerminalProgress(enabled: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.showTerminalProgress = enabled;
		this.markModified("terminal", "showTerminalProgress");
		this.save();
	}

	getTerminalHyperlinks(): boolean | undefined {
		return this.settings.terminal?.hyperlinks;
	}

	setTerminalHyperlinks(enabled: boolean | undefined): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.hyperlinks = enabled;
		this.markModified("terminal", "hyperlinks");
		this.save();
	}

	getTerminalImages(): "kitty" | "iterm2" | "none" | null | undefined {
		return this.settings.terminal?.images;
	}

	setTerminalImages(protocol: "kitty" | "iterm2" | "none" | null | undefined): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.images = protocol;
		this.markModified("terminal", "images");
		this.save();
	}

	getTerminalTrueColor(): boolean | undefined {
		return this.settings.terminal?.trueColor;
	}

	setTerminalTrueColor(enabled: boolean | undefined): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.trueColor = enabled;
		this.markModified("terminal", "trueColor");
		this.save();
	}

	getShowCacheMissNotices(): boolean {
		return this.settings.showCacheMissNotices ?? false;
	}

	setShowCacheMissNotices(enabled: boolean): void {
		this.setPlain("showCacheMissNotices", enabled);
	}

	getDefaultTools(): string[] | undefined {
		return this.globalSettings.defaultTools ? [...this.globalSettings.defaultTools] : undefined;
	}

	setDefaultTools(tools: string[] | undefined): void {
		this.globalSettings.defaultTools = tools ? [...tools] : undefined;
		this.markModified("defaultTools");
		this.save();
	}

	getImageAutoResize(): boolean {
		return this.settings.images?.autoResize ?? true;
	}

	setImageAutoResize(enabled: boolean): void {
		if (!this.globalSettings.images) {
			this.globalSettings.images = {};
		}
		this.globalSettings.images.autoResize = enabled;
		this.markModified("images", "autoResize");
		this.save();
	}

	getBlockImages(): boolean {
		return this.settings.images?.blockImages ?? false;
	}

	setBlockImages(blocked: boolean): void {
		if (!this.globalSettings.images) {
			this.globalSettings.images = {};
		}
		this.globalSettings.images.blockImages = blocked;
		this.markModified("images", "blockImages");
		this.save();
	}

	getClipboardImageDirectory(): string | undefined {
		return this.settings.images?.clipboardDirectory?.trim() || undefined;
	}

	setClipboardImageDirectory(directory: string | undefined): void {
		if (!this.globalSettings.images) {
			this.globalSettings.images = {};
		}
		if (directory?.trim()) {
			this.globalSettings.images.clipboardDirectory = directory.trim();
		} else {
			delete this.globalSettings.images.clipboardDirectory;
		}
		this.markModified("images", "clipboardDirectory");
		this.save();
	}

	getEnabledModels(): string[] | undefined {
		return this.settings.enabledModels;
	}

	setEnabledModels(patterns: string[] | undefined): void {
		this.globalSettings.enabledModels = patterns;
		this.markModified("enabledModels");
		this.save();
	}

	getModelFavorites(): ModelFavorite[] {
		return resolveModelFavorites(this.settings);
	}

	/** Return the current canonical favorites unioned with provider/model references, without persisting. */
	getModelFavoritesIncluding(refs: readonly string[]): ModelFavorite[] {
		return resolveModelFavoritesIncluding(this.settings, refs);
	}

	isModelFavorite(provider: string, modelId: string): boolean {
		return this.getModelFavorites().some(
			(favorite) => favorite.provider === provider && favorite.modelId === modelId,
		);
	}

	toggleModelFavorite(provider: string, modelId: string): void {
		const favorites = this.getModelFavorites();
		const index = favorites.findIndex((favorite) => favorite.provider === provider && favorite.modelId === modelId);
		if (index >= 0) favorites.splice(index, 1);
		else favorites.push({ provider, modelId });
		this.globalSettings.modelFavorites = favorites;
		this.markModified("modelFavorites");
		this.save();
	}

	getWorkbenchSettings(): Required<WorkbenchSettings> {
		return resolveWorkbenchSettings(this.settings);
	}

	setWorkbenchSetting<K extends keyof WorkbenchSettings>(key: K, value: Required<WorkbenchSettings>[K]): void {
		this.setWorkbenchSettings({ [key]: value });
	}

	/** One write for a geometry change that touches several keys. */
	setWorkbenchSettings(values: Partial<Required<WorkbenchSettings>>): void {
		this.globalSettings.workbench ??= {};
		for (const [key, value] of Object.entries(values) as [keyof WorkbenchSettings, never][]) {
			this.globalSettings.workbench[key] = value;
			this.markModified("workbench", key);
		}
		this.save();
	}

	/** What a project with no saved trust decision gets. Global only: a project cannot decide its own trust. */
	getProjectTrustDefault(): "trusted" | "untrusted" {
		return this.globalSettings.projectTrust === "untrusted" ? "untrusted" : "trusted";
	}

	getDoubleEscapeAction(): "fork" | "tree" | "none" {
		return this.settings.doubleEscapeAction ?? "tree";
	}

	setDoubleEscapeAction(action: "fork" | "tree" | "none"): void {
		this.setPlain("doubleEscapeAction", action);
	}

	getTreeFilterMode(): "default" | "no-tools" | "user-only" | "labeled-only" | "all" {
		const mode = this.settings.treeFilterMode;
		const valid = ["default", "no-tools", "user-only", "labeled-only", "all"];
		return mode && valid.includes(mode) ? mode : "default";
	}

	setTreeFilterMode(mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all"): void {
		this.setPlain("treeFilterMode", mode);
	}

	getShowHardwareCursor(): boolean {
		return this.settings.showHardwareCursor ?? process.env.PI_HARDWARE_CURSOR === "1";
	}

	setShowHardwareCursor(enabled: boolean): void {
		this.setPlain("showHardwareCursor", enabled);
	}

	getEditorPaddingX(): number {
		return this.settings.editorPaddingX ?? 0;
	}

	setEditorPaddingX(padding: number): void {
		this.globalSettings.editorPaddingX = Math.max(0, Math.min(3, Math.floor(padding)));
		this.markModified("editorPaddingX");
		this.save();
	}

	getAutocompleteMaxVisible(): number {
		return this.settings.autocompleteMaxVisible ?? 5;
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.globalSettings.autocompleteMaxVisible = Math.max(3, Math.min(20, Math.floor(maxVisible)));
		this.markModified("autocompleteMaxVisible");
		this.save();
	}

	getCodeBlockIndent(): string {
		return this.settings.markdown?.codeBlockIndent ?? "  ";
	}

	getWarnings(): WarningSettings {
		return { ...(this.settings.warnings ?? {}) };
	}

	setWarnings(warnings: WarningSettings): void {
		this.globalSettings.warnings = { ...warnings };
		this.markModified("warnings");
		this.save();
	}

	getSelfModificationSettings(): { enabled: boolean; sourcePath?: string; sourcePaths?: string[] } {
		return resolveSelfModificationSettings(this.settings);
	}

	setSelfModificationSettings(settings: SelfModificationSettings, scope: SettingsScope = "global"): void {
		if (scope === "project") {
			const projectSettings = structuredClone(this.projectSettings);
			const existing = projectSettings.selfModification;
			projectSettings.selfModification = {
				...existing,
				...settings,
				sourcePaths: settings.sourcePaths ?? existing?.sourcePaths,
			};
			this.markProjectModified("selfModification");
			this.saveProjectSettings(projectSettings);
			return;
		}

		const existing = this.globalSettings.selfModification;
		this.globalSettings.selfModification = {
			...existing,
			...settings,
			sourcePaths: settings.sourcePaths ?? existing?.sourcePaths,
		};
		this.markModified("selfModification");
		this.save();
	}

	getAutonomySettings(): Required<AutonomySettings> {
		return resolveAutonomySettings(this.settings);
	}

	setAutonomySettings(settings: AutonomySettings, scope: SettingsScope = "global"): void {
		if (scope === "project") {
			const projectSettings = structuredClone(this.projectSettings);
			projectSettings.autonomy = { ...settings };
			this.markProjectModified("autonomy");
			this.saveProjectSettings(projectSettings);
			return;
		}

		this.globalSettings.autonomy = { ...settings };
		this.markModified("autonomy");
		this.save();
	}

	/** Results waiting for the owner's review at which the one review-backlog notice is raised; 0 means never. */
	getReviewWaitingNoticeAt(): number {
		return sanitizeIntegerSetting(
			this.settings.proofSheets?.reviewWaitingNoticeAt,
			DEFAULT_REVIEW_WAITING_NOTICE_AT,
			0,
			MAX_REVIEW_WAITING_NOTICE_AT,
		);
	}

	getProactivitySettings(): ResolvedProactivitySettings {
		return resolveProactivitySettings(this.settings);
	}

	/**
	 * Acting-ahead bounds, read like standing grants: only from the layers the owner writes under the agent directory
	 * (directory profile first, then global), never the project's own settings. Any settings load error turns it off.
	 */
	getActAheadSettings(): ResolvedActAheadSettings {
		const resolved = resolveActAheadSettings([
			this.directoryProfileSettings.proactivity?.actAhead,
			this.globalSettings.proactivity?.actAhead,
		]);
		const loadError =
			this.globalSettingsLoadError ?? this.projectSettingsLoadError ?? this.directoryProfileSettingsLoadError;
		return loadError ? { ...resolved, enabled: false } : resolved;
	}

	/**
	 * What delivered notes teach the review, read like acting ahead: only from the layers the owner writes under the
	 * agent directory (directory profile first, then global), never the project's own settings.
	 */
	getProactivityFeedbackSettings(): ResolvedProactivityFeedbackSettings {
		return resolveProactivityFeedbackSettings([
			this.directoryProfileSettings.proactivity?.feedback,
			this.globalSettings.proactivity?.feedback,
		]);
	}

	/** Replaces the layer's proactivity settings; the layer's `actAhead` and `feedback` stay unless `settings` sets them. */
	setProactivitySettings(settings: ProactivitySettings, scope: SettingsScope = "global"): void {
		const keep = (layer: ProactivitySettings | undefined): ProactivitySettings => {
			const actAhead = settings.actAhead ?? layer?.actAhead;
			const feedback = settings.feedback ?? layer?.feedback;
			return { ...settings, ...(actAhead ? { actAhead } : {}), ...(feedback ? { feedback } : {}) };
		};
		if (scope === "project") {
			const projectSettings = structuredClone(this.projectSettings);
			projectSettings.proactivity = keep(projectSettings.proactivity);
			this.markProjectModified("proactivity");
			this.saveProjectSettings(projectSettings);
			return;
		}

		this.globalSettings.proactivity = keep(this.globalSettings.proactivity);
		this.markModified("proactivity");
		this.save();
	}

	/** Leaders as sub-orchestrators: the nesting depth, the default when unset or out of range. */
	getLeaderSettings(): Required<LeaderSettings> {
		return resolveLeaderSettings(this.settings.leaders);
	}

	/** Retention of closed orchestration work: the days a closed unit stays before idle release (0 keeps it). */
	getOrchestrationRetentionSettings(): { closedObjectiveDays: number } {
		return resolveOrchestrationRetention(this.settings.orchestration);
	}

	getRoutinesSettings(): Required<Pick<RoutinesSettings, "automaticIntake" | "maxResultWakesPerDay">> {
		return resolveRoutinesSettings(this.settings);
	}

	/** Bounds of routines run away; the daemon reads them for the whole agent dir. */
	getRoutineAwaySettings(): ResolvedRoutineAwaySettings {
		return resolveRoutineAwaySettings(this.settings);
	}

	/**
	 * Whether the daemon starts with the owner's login (see `away-service.ts`). It installs a service on this machine,
	 * so it is read like a standing grant: only from the layers the owner writes under the agent directory (directory
	 * profile first, then global), never the project's own settings. Any settings load error reads as `notify`, which
	 * installs nothing.
	 */
	getRoutineAwayAutostart(): RoutineAwayAutostart {
		if (this.globalSettingsLoadError ?? this.projectSettingsLoadError ?? this.directoryProfileSettingsLoadError)
			return "notify";
		const written = [this.directoryProfileSettings.routines, this.globalSettings.routines]
			.map((layer) => (isPlainRecord(layer) && isPlainRecord(layer.away) ? layer.away.autostart : undefined))
			.find((value) => value !== undefined);
		return written === "off" || written === "on" ? written : "notify";
	}

	getResearchLaneSettings(): ResolvedResearchLaneSettings {
		return resolveResearchLaneSettings(this.settings);
	}

	setResearchLaneSettings(settings: ResearchLaneSettings, scope: SettingsScope = "global"): void {
		if (scope === "project") {
			const projectSettings = structuredClone(this.projectSettings);
			projectSettings.researchLane = { ...settings };
			this.markProjectModified("researchLane");
			this.saveProjectSettings(projectSettings);
			return;
		}

		this.globalSettings.researchLane = { ...settings };
		this.markModified("researchLane");
		this.save();
	}

	getToolOutputSettings(): ResolvedToolOutputSettings {
		return resolveToolOutputSettings(this.settings);
	}

	getFleetSettings(): ResolvedFleetSettings {
		return resolveFleetSettings(this.settings);
	}

	setFleetSettings(settings: FleetSettings): void {
		this.globalSettings.fleet = structuredClone(settings);
		this.markModified("fleet");
		this.save();
	}

	getWorktreeSyncSettings(): ResolvedWorktreeSyncSettings {
		return resolveWorktreeSyncSettings(this.settings);
	}

	getProcessMatrixSettings(): ResolvedProcessMatrixSettings {
		return resolveProcessMatrixSettings(this.settings);
	}

	getWindowsShellSettings(): ResolvedWindowsShellSettings {
		return resolveWindowsShellSettings(this.settings);
	}

	getProviderAdmissionSettings(): ResolvedProviderAdmissionSettings {
		return resolveProviderAdmissionSettings(this.settings);
	}

	getToolExecutionSettings(): ResolvedToolExecutionSettings {
		return resolveToolExecutionSettings(this.settings);
	}

	/**
	 * The `fileEncodings` rules in the order they are consulted: this project's first, then the
	 * global ones it does not already cover. The effective-settings merge cannot express that on its
	 * own — merging two maps keeps the global declaration order — so the layers are read directly.
	 */
	getFileEncodings(): FileEncodingRule[] {
		return resolveFileEncodingRules([this.directoryProfileSettings, this.projectSettings, this.globalSettings]);
	}

	getBackgroundToolSettings(): ResolvedBackgroundToolSettings {
		return resolveBackgroundToolSettings(this.settings);
	}

	getEdgeSettings(): ResolvedEdgeSettings {
		const loadError =
			this.globalSettingsLoadError ?? this.projectSettingsLoadError ?? this.directoryProfileSettingsLoadError;
		return resolveEdgeSettings(this.settings, loadError, [
			this.directoryProfileSettings.edge,
			this.globalSettings.edge,
		]);
	}

	/**
	 * Channel admission policies, read like standing grants: only from the layers the owner writes under the agent
	 * directory (directory profile first, then global), never the project's own settings. Any settings load error
	 * withholds every policy, so no channel starts.
	 */
	getChannelPolicies(): ReadonlyMap<string, ChannelPolicyResolution> {
		if (this.globalSettingsLoadError ?? this.projectSettingsLoadError ?? this.directoryProfileSettingsLoadError)
			return new Map();
		return resolveChannelPolicies([this.directoryProfileSettings.channels, this.globalSettings.channels]);
	}

	/**
	 * The policies the daemon serves channels under while no session is open: the global layer alone (the daemon has no
	 * directory), so only `channels.<name>.awayCwd` written there names where. A global load error withholds them all.
	 */
	getAwayChannelPolicies(): ReadonlyMap<string, ChannelPolicyResolution> {
		if (this.globalSettingsLoadError) return new Map();
		return resolveChannelPolicies([this.globalSettings.channels]);
	}

	getWorkerDelegationSettings(): ResolvedWorkerDelegationSettings {
		return resolveWorkerDelegationSettings(this.settings);
	}

	/** The escalation ladder and outcome ledger settings: hands-off defaults with the owner's overrides on top. */
	getWorkerOutcomeSettings(): ResolvedWorkerOutcomeSettings {
		return resolveWorkerOutcomeSettings(normalizeWorkerDelegationLayer(this.settings.workerDelegation)?.outcomes);
	}

	/** Worker thinking relative to the foreground when neither authority nor profile pins it. */
	getWorkerThinkingPolicy(): WorkerThinkingPolicy {
		return resolveWorkerThinkingPolicy(this.settings);
	}

	/** Which account fresh workers run on and the ordered routing candidates. */
	getWorkerAccountRouting(): WorkerAccountRouting {
		return resolveWorkerAccountRouting(this.settings);
	}

	getWorkerModelPinPolicy(): WorkerModelPinPolicy {
		return compileWorkerModelPinPolicy({
			global: this.globalSettings.workerDelegation?.modelPins,
			project: this.projectSettings.workerDelegation?.modelPins,
			directoryProfile: this.directoryProfileSettings.workerDelegation?.modelPins,
		});
	}

	getActiveOrchestrationProfile(): string | undefined {
		const profileId = this.settings.activeOrchestrationProfile;
		return typeof profileId === "string" && profileId.trim().length > 0 ? profileId.trim() : undefined;
	}

	setWorkerDelegationSettings(settings: WorkerDelegationSettings, scope: SettingsScope = "global"): void {
		const normalizedSettings = normalizeWorkerDelegationLayer(settings) ?? {};
		const sourceSettings = scope === "project" ? this.projectSettings : this.globalSettings;
		const existingPins = sourceSettings.workerDelegation?.modelPins;
		if (Object.hasOwn(settings, "modelPins")) {
			const policy = compileWorkerModelPinPolicy({ [scope]: settings.modelPins });
			if (policy.status === "invalid") {
				throw new Error(`Invalid worker model pin settings: ${policy.diagnostics.join("; ")}`);
			}
			if (settings.modelPins !== undefined) normalizedSettings.modelPins = structuredClone(settings.modelPins);
		} else if (existingPins !== undefined) {
			normalizedSettings.modelPins = structuredClone(existingPins);
		}
		if (scope === "project") {
			const projectSettings = structuredClone(this.projectSettings);
			projectSettings.workerDelegation = normalizedSettings;
			this.markProjectModified("workerDelegation");
			this.saveProjectSettings(projectSettings);
			return;
		}

		this.globalSettings.workerDelegation = normalizedSettings;
		this.markModified("workerDelegation");
		this.save();
	}

	getLearningPolicySettings(): ResolvedLearningPolicySettings {
		return resolveLearningPolicySettings(this.settings);
	}

	getToolkitScripts(): ToolkitScript[] {
		return resolveToolkitScripts(this.settings);
	}

	setToolkitSettings(settings: ToolkitSettings, scope: SettingsScope = "global"): void {
		if (scope === "project") {
			const projectSettings = structuredClone(this.projectSettings);
			projectSettings.toolkit = { ...settings };
			this.markProjectModified("toolkit");
			this.saveProjectSettings(projectSettings);
			return;
		}

		this.globalSettings.toolkit = { ...settings };
		this.markModified("toolkit");
		this.save();
	}

	getAdvisorSettings(): AdvisorSettings & { enabled: boolean; error?: string } {
		return resolveAdvisorSettings(this.settings);
	}

	getAdvisorSettingsScope(): SettingsScope | undefined {
		if (Object.hasOwn(this.directoryProfileSettings, "advisor")) return "directoryProfile";
		if (Object.hasOwn(this.projectSettings, "advisor")) return "project";
		return Object.hasOwn(this.globalSettings, "advisor") ? "global" : undefined;
	}

	getAdvisorSettingsRevision(): number {
		return this.advisorSettingsRevision;
	}

	setAdvisorSettings(settings: AdvisorSettings, scope: SettingsScope = "global"): void {
		if (scope !== "global" && scope !== "project" && scope !== "directoryProfile")
			throw new Error("Unknown peer settings scope.");
		if (scope === "directoryProfile") {
			this.persistDirectoryProfiles((current) => {
				current.advisor = {
					...(current.advisor ?? this.projectSettings.advisor ?? this.globalSettings.advisor),
					...settings,
				};
			});
			return;
		}
		if (scope === "project") {
			const projectSettings = structuredClone(this.projectSettings);
			projectSettings.advisor = { ...(projectSettings.advisor ?? this.globalSettings.advisor), ...settings };
			this.markProjectModified("advisor");
			this.saveProjectSettings(projectSettings);
			return;
		}
		this.globalSettings.advisor = { ...this.globalSettings.advisor, ...settings };
		this.markModified("advisor");
		this.save();
	}

	getModelCapabilitySettings(): Required<ModelCapabilitySettings> {
		return resolveModelCapabilitySettings(this.settings);
	}

	setModelCapabilitySettings(settings: ModelCapabilitySettings, scope: SettingsScope = "global"): void {
		if (scope === "project") {
			const projectSettings = structuredClone(this.projectSettings);
			projectSettings.modelCapability = { ...settings };
			this.markProjectModified("modelCapability");
			this.saveProjectSettings(projectSettings);
			return;
		}

		this.globalSettings.modelCapability = { ...settings };
		this.markModified("modelCapability");
		this.save();
	}

	getBedrockScopeSettings(): BedrockScopeSettings | undefined {
		return resolveBedrockScopeSettings(this.globalSettings.bedrock);
	}

	setBedrockScopeSettings(scope: BedrockScopeSettings): void {
		const normalized = normalizeBedrockScopeSettings(scope);
		if (!normalized) throw new Error("Cannot persist an invalid or empty Bedrock verification scope.");
		this.globalSettings.bedrock = { ...normalized, modelIds: [...normalized.modelIds] };
		this.markModified("bedrock");
		this.save();
	}

	clearBedrockScopeSettings(): void {
		delete this.globalSettings.bedrock;
		this.markModified("bedrock");
		this.save();
	}

	setLearningPolicySettings(settings: LearningPolicySettings, scope: SettingsScope = "global"): void {
		if (scope === "project") {
			const projectSettings = structuredClone(this.projectSettings);
			projectSettings.learningPolicy = { ...settings };
			this.markProjectModified("learningPolicy");
			this.saveProjectSettings(projectSettings);
			return;
		}

		this.globalSettings.learningPolicy = { ...settings };
		this.markModified("learningPolicy");
		this.save();
	}

	getAutoLearnSettings(): AutoLearnSettings {
		const settings = this.settings.autoLearn ?? {};
		return {
			...settings,
			model: settings.model ?? this.getModelRouterSettings().learningModel,
			thinkingLevel: settings.thinkingLevel ?? "low",
			complexTaskToolCalls: settings.complexTaskToolCalls ?? 12,
		};
	}

	setAutoLearnSettings(settings: AutoLearnSettings, scope: SettingsScope = "global"): void {
		if (scope === "project") {
			const projectSettings = structuredClone(this.projectSettings);
			projectSettings.autoLearn = { ...settings };
			this.markProjectModified("autoLearn");
			this.saveProjectSettings(projectSettings);
			return;
		}

		this.globalSettings.autoLearn = { ...settings };
		this.markModified("autoLearn");
		this.save();
	}

	getExternalResourceRoots(): string[] {
		return this.settings.externalResourceRoots ?? [];
	}

	setExternalResourceRoots(roots: string[], scope: SettingsScope = "global"): void {
		if (scope === "project") {
			const projectSettings = structuredClone(this.projectSettings);
			projectSettings.externalResourceRoots = [...roots];
			this.markProjectModified("externalResourceRoots");
			this.saveProjectSettings(projectSettings);
			return;
		}

		this.globalSettings.externalResourceRoots = [...roots];
		this.markModified("externalResourceRoots");
		this.save();
	}

	getTrustedResourceRoots(): string[] {
		return this.settings.trustedResourceRoots ?? [];
	}

	setTrustedResourceRoots(roots: string[], scope: SettingsScope = "global"): void {
		if (scope === "project") {
			const projectSettings = structuredClone(this.projectSettings);
			projectSettings.trustedResourceRoots = [...roots];
			this.markProjectModified("trustedResourceRoots");
			this.saveProjectSettings(projectSettings);
			return;
		}

		this.globalSettings.trustedResourceRoots = [...roots];
		this.markModified("trustedResourceRoots");
		this.save();
	}

	addTrustedResourceRoot(path: string, scope: SettingsScope = "global"): void {
		const canonicalPath = this.canonicalizePath(path);
		if (!canonicalPath) return;

		const current = this.getTrustedResourceRoots();
		if (!current.includes(canonicalPath)) {
			this.setTrustedResourceRoots([...current, canonicalPath], scope);
		}
	}

	canonicalizePath(p: string): string | null {
		try {
			const resolved = resolve(p.replace(/^~/, homedir()));
			if (existsSync(resolved)) {
				return realpathSync(resolved);
			}
			return resolved;
		} catch {
			return null;
		}
	}

	getEffectiveExternalResourceRoots(): string[] {
		const roots = this.getExternalResourceRoots();
		const trusted = this.getTrustedResourceRoots();

		const canonicalTrusted = new Set(
			trusted.map((t) => this.canonicalizePath(t)).filter((t): t is string => t !== null),
		);

		const effective: string[] = [];
		for (const r of roots) {
			const canonicalR = this.canonicalizePath(r);
			if (canonicalR && canonicalR.trim() !== "" && canonicalTrusted.has(canonicalR) && existsSync(canonicalR)) {
				effective.push(canonicalR);
			}
		}
		return effective;
	}
}
