/**
 * Resource-profile tool/extension gating + reload-time profile model re-application.
 *
 * Extracted verbatim from agent-session.ts (god-file decomposition). Resolves the active resource
 * profile's tool allow/block filter, filters the runtime extension set (tracking the withheld/inert
 * tallies it owns), reports the /context "withheld by profile" observations, and — on reload —
 * re-applies a profile-bound model/thinking level unless an explicit launch flag set them. Owns the
 * inert-extension warnings and profile-denied-extension count; everything else is read through deps.
 */

import type { Agent, ThinkingLevel } from "@caupulican/pi-agent-core";
import type { SessionManager } from "@caupulican/pi-agent-core/node";
import type { Extension } from "./extensions/index.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { resolveProfileModelSettings } from "./model-resolver.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import {
	matchesResourceProfilePattern,
	type ResourceProfileFilterSettings,
	type SettingsManager,
} from "./settings-manager.ts";

export interface ProfileFilterControllerDeps {
	getSettingsManager(): SettingsManager;
	getResourceLoader(): ResourceLoader;
	getModelRegistry(): ModelRegistry;
	getCwd(): string;
	getAgent(): Agent;
	getSessionManager(): SessionManager;
	/** Construction-time tool allow-set (undefined = no allow-list gate). */
	getAllowedToolNames(): Set<string> | undefined;
	/** Construction-time tool exclude-set. */
	getExcludedToolNames(): Set<string> | undefined;
	/** Live resource-profile tool filter (re-derived on reload; may be undefined). */
	getToolProfileFilter(): Required<ResourceProfileFilterSettings> | undefined;
	/** Whether the model was set by an explicit launch flag (profile must not clobber it). */
	isExplicitModel(): boolean;
	/** Whether the thinking level was set by an explicit launch flag. */
	isExplicitThinking(): boolean;
	/** Apply a thinking level (delegates to model-selection). */
	setThinkingLevel(level: ThinkingLevel): void;
}

export class ProfileFilterController {
	/** G12: extensions loaded but rendered fully inert by the profile's tools filter. */
	private _inertExtensionWarnings: string[] = [];
	/** Count of extensions withheld by the active resource profile (for the /context observation). */
	private _profileDeniedExtensionCount = 0;

	private readonly deps: ProfileFilterControllerDeps;

	constructor(deps: ProfileFilterControllerDeps) {
		this.deps = deps;
	}

	/** Inert-extension warnings tracked by the last {@link filterExtensionsForRuntime} pass. */
	getInertExtensionWarnings(): string[] {
		return this._inertExtensionWarnings;
	}

	/**
	 * Resolve the active resource-profile tool allow/block filter from current settings.
	 * Mirrors the construction-time derivation (settingsManager.getResourceProfileFilter("tools"))
	 * so reload() can re-apply it after a live settings/profile edit.
	 */
	deriveToolProfileFilter(): Required<ResourceProfileFilterSettings> {
		const filter = this.deps.getSettingsManager().getResourceProfileFilter("tools");
		return { allow: filter.allow ?? [], block: filter.block ?? [] };
	}

	isToolOrCommandAllowedByProfile(name: string): boolean {
		const allowedToolNames = this.deps.getAllowedToolNames();
		const excludedToolNames = this.deps.getExcludedToolNames();
		if (allowedToolNames && !allowedToolNames.has(name)) return false;
		if (excludedToolNames?.has(name)) return false;
		const filter = this.deps.getToolProfileFilter();
		if (!filter) return true;
		if (filter.allow.length > 0 && !matchesResourceProfilePattern(name, filter.allow)) return false;
		if (matchesResourceProfilePattern(name, filter.block)) return false;
		return true;
	}

	private _hasToolOrCommandProfileGate(): boolean {
		const toolProfileFilter = this.deps.getToolProfileFilter();
		return Boolean(
			this.deps.getAllowedToolNames() ||
				this.deps.getExcludedToolNames() ||
				(toolProfileFilter && (toolProfileFilter.allow.length > 0 || toolProfileFilter.block.length > 0)),
		);
	}

	filterExtensionsForRuntime(extensions: Extension[]): Extension[] {
		const settingsManager = this.deps.getSettingsManager();
		this._inertExtensionWarnings = [];
		this._profileDeniedExtensionCount = 0;
		if (settingsManager.getActiveResourceProfileNames().length === 0) {
			if (settingsManager.hasExplicitActiveResourceProfileSelection()) {
				// An explicit profile selection that resolves to no active profile is a deliberate
				// deny-all — every extension is withheld by that choice.
				this._profileDeniedExtensionCount = extensions.length;
				return [];
			}
			// No profile in play: only inline/SDK extensions load by default. That is the baseline, not
			// a profile denial, so it is not counted as withheld.
			return extensions.filter((extension) => extension.sourceInfo.source === "inline");
		}
		const hasToolOrCommandGate = this._hasToolOrCommandProfileGate();
		const allowedExtensions = extensions.filter((extension) =>
			settingsManager.isResourceAllowedByProfile("extensions", extension.path, extension.sourceInfo.baseDir),
		);
		this._profileDeniedExtensionCount = extensions.length - allowedExtensions.length;
		return allowedExtensions.map((extension) => {
			if (!hasToolOrCommandGate) return extension;
			const tools = new Map(
				Array.from(extension.tools.entries()).filter(([name]) => this.isToolOrCommandAllowedByProfile(name)),
			);
			const commands = new Map(
				Array.from(extension.commands.entries()).filter(([name]) => this.isToolOrCommandAllowedByProfile(name)),
			);
			// G12: an extension the profile ALLOWS whose every tool and command the tools filter
			// then denies loads and runs lifecycle hooks but is completely uninvocable — surface
			// it instead of presenting a "loaded" extension that silently does nothing.
			if (extension.tools.size + extension.commands.size > 0 && tools.size + commands.size === 0) {
				const name = extension.path.split(/[\\/]/).pop() ?? extension.path;
				this._inertExtensionWarnings.push(
					`extension "${name}" is loaded but fully inert: the active profile's tools filter denies all ${extension.tools.size} tool(s) and ${extension.commands.size} command(s) it contributes`,
				);
			}
			return { ...extension, tools, commands };
		});
	}

	/**
	 * /context observations for skills/prompts/extensions the active resource profile removed from
	 * listings — the analog of the withheld-AGENTS.md warning. Strict UAC makes these silently absent,
	 * so a lean profile's effect on the resource surface stays visible. Counts are profile-scoped
	 * (skills/prompts via the profile-independent discovery universe filtered by the live profile
	 * filter; extensions via the runtime filter's denied tally). Empty when nothing is withheld.
	 *
	 * Uses `isResourceDeniedByActiveProfile` (profile-only), not `isResourceAllowedByProfile` (which
	 * also folds in the user's own legacy `disabledResources` list): a plain user-disabled resource
	 * must never be misattributed to "the active resource profile" — that case is already surfaced by
	 * the G14 disable-wins warning. With no active profile at all, the helper always reports nothing
	 * denied, so this naturally stays silent (extensions keep their own runtime-filter-derived count,
	 * which is already correctly zero absent a profile).
	 */
	profileDeniedResourceObservations(): string[] {
		const settingsManager = this.deps.getSettingsManager();
		const resourceLoader = this.deps.getResourceLoader();
		const cwd = this.deps.getCwd();
		const observations: string[] = [];
		const withheld = (kind: "skills" | "prompts", paths: string[]): number =>
			paths.filter((path) => settingsManager.isResourceDeniedByActiveProfile(kind, path, cwd)).length;

		const skillsWithheld = withheld("skills", resourceLoader.getDiscoverableSkillPaths());
		if (skillsWithheld > 0) {
			observations.push(
				`${skillsWithheld} skill(s) withheld by the active resource profile — grant the "skills" kind to restore them`,
			);
		}
		const promptsWithheld = withheld("prompts", resourceLoader.getDiscoverablePromptPaths());
		if (promptsWithheld > 0) {
			observations.push(
				`${promptsWithheld} prompt(s) withheld by the active resource profile — grant the "prompts" kind to restore them`,
			);
		}
		if (this._profileDeniedExtensionCount > 0) {
			observations.push(
				`${this._profileDeniedExtensionCount} extension(s) withheld by the active resource profile — grant the "extensions" kind to restore them`,
			);
		}
		return observations;
	}

	/**
	 * Re-resolve the active resource profile's model/thinking from current settings and apply it.
	 * Only acts when the profile actually binds model/thinking AND that field was not set by an
	 * explicit launch flag — so live profile edits apply on reload without clobbering an explicit
	 * --model/--thinking. A no-op for profiles that don't bind a model.
	 */
	async reapplyActiveProfileModelSettings(): Promise<void> {
		if (this.deps.isExplicitModel() && this.deps.isExplicitThinking()) return;
		const settingsManager = this.deps.getSettingsManager();
		const activeProfileNames = settingsManager.getActiveResourceProfileNames();
		if (activeProfileNames.length === 0) return;
		const profileSettings = resolveProfileModelSettings({
			activeProfileNames,
			registry: settingsManager.getProfileRegistry(),
			modelRegistry: this.deps.getModelRegistry(),
			cwd: this.deps.getCwd(),
		});
		if (!this.deps.isExplicitModel() && profileSettings.model) {
			const current = this.deps.getAgent().state.model;
			const next = profileSettings.model;
			if (!current || current.provider !== next.provider || current.id !== next.id) {
				// Mirror the startup/cycle path: set the model directly (no auth gate, no settings
				// persist) so re-applying the profile model behaves like initial resolution rather
				// than a runtime model switch. No model_select emit here — reload rebuilds the
				// extension runtime and emits session_start("reload") right after, and the UI
				// re-renders from session.model.
				this.deps.getAgent().state.model = next;
				this.deps.getSessionManager().appendModelChange(next.provider, next.id);
			}
		}
		if (!this.deps.isExplicitThinking() && profileSettings.thinkingLevel) {
			this.deps.setThinkingLevel(profileSettings.thinkingLevel);
		}
	}
}
