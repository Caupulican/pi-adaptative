import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import chalk from "chalk";
import { CONFIG_DIR_NAME, getBundledPromptsDir, getBundledSkillsDir } from "../config.ts";
import { loadThemeFromPath, type Theme } from "../modes/interactive/theme/theme.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";

export type { ResourceCollision, ResourceDiagnostic } from "./diagnostics.ts";

import { canonicalizePath, isLocalPath, resolvePath } from "../utils/paths.ts";
import { createEventBus, type EventBus } from "./event-bus.ts";
import {
	createExtensionRuntime,
	disposeExtensionEventSubscriptions,
	loadExtension,
	loadExtensionFromFactory,
	loadExtensions,
} from "./extensions/loader.ts";
import type { Extension, ExtensionFactory, ExtensionRuntime, LoadExtensionsResult } from "./extensions/types.ts";
import { DefaultPackageManager, type PathMetadata } from "./package-manager.ts";
import type { PromptTemplate } from "./prompt-templates.ts";
import { loadPromptTemplates } from "./prompt-templates.ts";
import {
	mergeResourceProfileMap,
	parseResourceProfileBlocks,
	stripResourceProfileBlocks,
} from "./resource-profile-blocks.ts";
import {
	matchesResourceProfilePattern,
	type ResourceProfileKind,
	type ResourceProfileSettings,
	SettingsManager,
} from "./settings-manager.ts";
import type { Skill } from "./skills.ts";
import { loadSkills } from "./skills.ts";
import { createSourceInfo, type SourceInfo } from "./source-info.ts";

export interface ResourceExtensionPaths {
	skillPaths?: Array<{ path: string; metadata: PathMetadata }>;
	promptPaths?: Array<{ path: string; metadata: PathMetadata }>;
	themePaths?: Array<{ path: string; metadata: PathMetadata }>;
}

export interface ResourceReloadOptions {
	/** Throw instead of accepting a hot reload that produced extension load/conflict errors. */
	failOnExtensionErrors?: boolean;
	/** Keep the previous extension generation alive until commitReload()/rollbackReload(). */
	deferExtensionDispose?: boolean;
}

export interface ResourceLoader {
	getExtensions(): LoadExtensionsResult;
	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
	/** Skills allowed by the currently active resource profile — use for selection/invocation/agent-visibility. */
	getActiveSkills(): Skill[];
	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
	/** Prompt templates allowed by the currently active resource profile — use for selection/invocation/agent-visibility. */
	getActivePrompts(): PromptTemplate[];
	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
	/** Themes allowed by the currently active resource profile. */
	getActiveThemes(): Theme[];
	getAgentsFiles(): { agentsFiles: Array<{ path: string; content?: string }> };
	/** Warnings about context files withheld by the active profile (empty when none). */
	getAgentsDiagnostics(): ResourceDiagnostic[];
	/** Profile-INDEPENDENT discovery (editor universe; metadata only, never loads content). */
	getDiscoverableSkillPaths(): string[];
	getDiscoverablePromptPaths(): string[];
	getDiscoverableAgentsFilePaths(): string[];
	getSystemPrompt(): string | undefined;
	getAppendSystemPrompt(): string[];
	getLoadedExtension(path: string): Extension | undefined;
	removeLoadedExtension(path: string): Extension | undefined;
	loadSingleExtension(path: string): Promise<{ extension: Extension | null; error: string | null }>;
	extendResources(paths: ResourceExtensionPaths): void;
	reload(options?: ResourceReloadOptions): Promise<void>;
	commitReload?(): void;
	rollbackReload?(): void;
	/** Get all discoverable extension paths (enabled and disabled) */
	getDiscoverableExtensionPaths(): Promise<string[]>;
}

interface ResourceLoaderSnapshot {
	extensionsResult: LoadExtensionsResult;
	skills: Skill[];
	skillDiagnostics: ResourceDiagnostic[];
	prompts: PromptTemplate[];
	promptDiagnostics: ResourceDiagnostic[];
	themes: Theme[];
	themeDiagnostics: ResourceDiagnostic[];
	agentsFiles: Array<{ path: string; content?: string }>;
	systemPrompt?: string;
	appendSystemPrompt: string[];
	lastSkillPaths: string[];
	extensionSkillSourceInfos: Map<string, SourceInfo>;
	extensionPromptSourceInfos: Map<string, SourceInfo>;
	extensionThemeSourceInfos: Map<string, SourceInfo>;
	lastPromptPaths: string[];
	lastThemePaths: string[];
}

function resolvePromptInput(input: string | undefined, description: string): string | undefined {
	if (!input) {
		return undefined;
	}

	if (existsSync(input)) {
		try {
			return readFileSync(input, "utf-8");
		} catch (error) {
			console.error(chalk.yellow(`Warning: Could not read ${description} file ${input}: ${error}`));
			return input;
		}
	}

	return input;
}

/**
 * Threat-pattern scope (Hermes-parity #31). `context` patterns apply to any attacker-influenced text
 * injected into context (context files, recalled memory). `strict` patterns are additionally checked on
 * HIGH-PRIVILEGE writes (memory writes, skill installs) where a false positive is cheap (user-mediated)
 * but a miss can persist an exfiltration/backdoor. A `strict` scan is a SUPERSET of `context`.
 */
export type ThreatScope = "context" | "strict";

const THREAT_PATTERNS: Array<{ label: string; pattern: RegExp; scope: ThreatScope }> = [
	{
		label: "instruction override",
		pattern:
			/\b(?:ignore|disregard|override|bypass)\b.{0,80}\b(?:previous|prior|above|system|developer|agent)\b.{0,80}\binstructions?\b/i,
		scope: "context",
	},
	{
		label: "secret exfiltration",
		pattern:
			/\b(?:reveal|print|dump|exfiltrate|send|upload)\b.{0,80}\b(?:secrets?|tokens?|api[_ -]?keys?|credentials?|environment variables?|\.env)\b/i,
		scope: "context",
	},
	{
		label: "hidden instruction",
		pattern: /\b(?:do not tell|don't tell|hide this from)\b.{0,80}\b(?:user|operator|developer)\b/i,
		scope: "context",
	},
	{
		label: "role hijack",
		pattern: /\byou\s+are\s+(?:\w+\s+){0,4}now\s+(?:a|an|the)\s+\w+/i,
		scope: "context",
	},
	{
		label: "system prompt leak",
		pattern: /\b(?:output|print|reveal|repeat|show)\b.{0,40}\b(?:system|initial|developer)\b.{0,20}\bprompt\b/i,
		scope: "context",
	},
	// strict-only (high-privilege write paths): credential exfil, backdoors, persistence.
	{
		label: "credential exfil command",
		pattern:
			/\b(?:curl|wget|fetch|invoke-webrequest|nc)\b.{0,100}\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
		scope: "strict",
	},
	{
		label: "ssh backdoor",
		pattern: /authorized_keys|(?:~|\$HOME)\/\.ssh\b/i,
		scope: "strict",
	},
	{
		label: "secret file read",
		pattern: /\bcat\b.{0,40}(?:\.env\b|\.netrc|\.pgpass|\.npmrc|\.pypirc|credentials)/i,
		scope: "strict",
	},
	{
		label: "data exfil to url",
		pattern: /\b(?:send|post|upload|exfiltrate|transmit|curl|wget)\b.{0,80}https?:\/\//i,
		scope: "strict",
	},
];

/**
 * Genuinely-dangerous invisible / bidi-control characters used to HIDE instructions or visually reorder
 * text (Trojan-Source): zero-width space (U+200B), bidi embeddings/overrides (U+202A\u2013U+202E), word-joiner
 * + invisible math operators (U+2060\u2013U+2064), bidi isolates + deprecated format controls (U+2066\u2013U+206F),
 * and BOM/zero-width-no-break (U+FEFF).
 *
 * DELIBERATELY EXCLUDES U+200C ZWNJ, U+200D ZWJ, U+200E LRM, U+200F RLM \u2014 these are LEGITIMATE and
 * load-bearing in Persian/Arabic/Hebrew/Hindi shaping (joiner control, directionality) and in emoji ZWJ
 * sequences; stripping them corrupts real text (bug #35). The Trojan-Source reorder attack relies on the
 * embeddings/overrides/isolates above, which are still stripped. (Hermes-parity #31/#35.)
 */
const INVISIBLE_UNICODE_RE = /[\u200B\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;

/** True if `content` contains any invisible/bidi-control character. */
export function hasInvisibleUnicode(content: string): boolean {
	INVISIBLE_UNICODE_RE.lastIndex = 0;
	return INVISIBLE_UNICODE_RE.test(content);
}

/**
 * Strip invisible/bidi-control characters, returning the cleaned text and how many were removed. Used on
 * READ paths (context files, recalled memory) — strip-and-continue rather than block, so benign
 * international text isn't rejected wholesale while hidden payloads are neutralized (agy's layered policy).
 */
export function stripInvisibleUnicode(content: string): { cleaned: string; removed: number } {
	let removed = 0;
	const cleaned = content.replace(INVISIBLE_UNICODE_RE, () => {
		removed++;
		return "";
	});
	return { cleaned, removed };
}

export function scanContextFileThreats(content: string, scope: ThreatScope = "context"): string[] {
	return THREAT_PATTERNS.filter((p) => (scope === "strict" || p.scope === "context") && p.pattern.test(content)).map(
		({ label }) => label,
	);
}

function sanitizeContextFileContent(filePath: string, content: string): string {
	const profileFreeContent = stripResourceProfileBlocks(content);
	// Strip-and-continue for hidden/bidi-control chars: don't reject a whole file for benign zero-width
	// chars in legitimate international text, but neutralize any payload hidden with them (agy #31).
	const { cleaned, removed } = stripInvisibleUnicode(profileFreeContent);
	if (removed > 0) {
		console.error(chalk.yellow(`Warning: stripped ${removed} invisible/bidi char(s) from ${filePath}`));
	}
	const findings = scanContextFileThreats(cleaned);
	if (findings.length === 0) return cleaned;
	console.error(chalk.yellow(`Warning: Blocked context file ${filePath}: ${findings.join(", ")}`));
	return `[BLOCKED: ${filePath} contained potential prompt injection (${findings.join(", ")}). Content not loaded.]`;
}

/**
 * RAW (unsanitized) context files from `dir`. Sanitization/threat-scanning is DEFERRED to the caller
 * so a profile-DENIED file's content is never processed into the session — only its embedded
 * `<resource-profile>` blocks are read for discovery (see {@link loadRawProjectContextFiles}).
 */
function loadRawContextFilesFromDir(dir: string): Array<{ path: string; rawContent: string }> {
	const candidates = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD", "GEMINI.md", "GEMINI.MD"];
	const files: Array<{ path: string; rawContent: string }> = [];
	for (const filename of candidates) {
		const filePath = join(dir, filename);
		if (existsSync(filePath)) {
			try {
				files.push({ path: filePath, rawContent: readFileSync(filePath, "utf-8") });
			} catch (error) {
				console.error(chalk.yellow(`Warning: Could not read ${filePath}: ${error}`));
			}
		}
	}
	return files;
}

/**
 * Discover project/agent context files with their RAW content (profile blocks intact, no sanitize).
 * The agents-kind profile filter can be DEFINED inside these same files (embedded `<resource-profile>`
 * blocks), so callers must read raw to discover profiles before knowing which files the filter denies;
 * sanitization/exposure is then applied only to files the filter allows.
 */
export function loadRawProjectContextFiles(options: {
	cwd: string;
	agentDir: string;
	projectTrusted?: boolean;
}): Array<{ path: string; rawContent: string }> {
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(options.agentDir);

	const contextFiles: Array<{ path: string; rawContent: string }> = [];
	const seenPaths = new Set<string>();

	for (const globalContext of loadRawContextFilesFromDir(resolvedAgentDir)) {
		contextFiles.push(globalContext);
		seenPaths.add(globalContext.path);
	}

	if (options.projectTrusted !== false) {
		const ancestorContextFiles: Array<{ path: string; rawContent: string }> = [];

		let currentDir = resolvedCwd;
		const root = resolve("/");

		while (true) {
			const contextFilesInDir = loadRawContextFilesFromDir(currentDir).filter(
				(contextFile) => !seenPaths.has(contextFile.path),
			);
			if (contextFilesInDir.length > 0) {
				ancestorContextFiles.unshift(...contextFilesInDir);
				for (const contextFile of contextFilesInDir) {
					seenPaths.add(contextFile.path);
				}
			}

			if (currentDir === root) break;

			const parentDir = resolve(currentDir, "..");
			if (parentDir === currentDir) break;
			currentDir = parentDir;
		}

		contextFiles.push(...ancestorContextFiles);
	}

	return contextFiles;
}

/**
 * Discover project/agent context files with SANITIZED content (profile blocks stripped, invisible/bidi
 * chars removed, prompt-injection scanned). Every discovered file is sanitized — callers that must
 * respect a profile's agents-kind denial should use {@link loadRawProjectContextFiles} and sanitize
 * only the allowed subset instead, so denied content is never processed.
 */
export function loadProjectContextFiles(options: {
	cwd: string;
	agentDir: string;
	projectTrusted?: boolean;
}): Array<{ path: string; content?: string }> {
	return loadRawProjectContextFiles(options).map((file) => ({
		path: file.path,
		content: sanitizeContextFileContent(file.path, file.rawContent),
	}));
}

export interface DefaultResourceLoaderOptions {
	cwd: string;
	agentDir: string;
	settingsManager?: SettingsManager;
	eventBus?: EventBus;
	additionalExtensionPaths?: string[];
	additionalSkillPaths?: string[];
	additionalPromptTemplatePaths?: string[];
	additionalThemePaths?: string[];
	extensionFactories?: ExtensionFactory[];
	noExtensions?: boolean;
	noSkills?: boolean;
	noPromptTemplates?: boolean;
	noThemes?: boolean;
	noContextFiles?: boolean;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
	skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
		skills: Skill[];
		diagnostics: ResourceDiagnostic[];
	};
	promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
	};
	themesOverride?: (base: { themes: Theme[]; diagnostics: ResourceDiagnostic[] }) => {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	};
	agentsFilesOverride?: (base: { agentsFiles: Array<{ path: string; content?: string }> }) => {
		agentsFiles: Array<{ path: string; content?: string }>;
	};
	systemPromptOverride?: (base: string | undefined) => string | undefined;
	appendSystemPromptOverride?: (base: string[]) => string[];
}

export class DefaultResourceLoader implements ResourceLoader {
	private cwd: string;
	private agentDir: string;
	private settingsManager: SettingsManager;
	private eventBus: EventBus;
	private packageManager: DefaultPackageManager;
	private additionalExtensionPaths: string[];
	private additionalSkillPaths: string[];
	private additionalPromptTemplatePaths: string[];
	private additionalThemePaths: string[];
	private extensionFactories: ExtensionFactory[];
	private noExtensions: boolean;
	private noSkills: boolean;
	private noPromptTemplates: boolean;
	private noThemes: boolean;
	private noContextFiles: boolean;
	private systemPromptSource?: string;
	private appendSystemPromptSource?: string[];
	private extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
	private skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
		skills: Skill[];
		diagnostics: ResourceDiagnostic[];
	};
	private promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
	};
	private themesOverride?: (base: { themes: Theme[]; diagnostics: ResourceDiagnostic[] }) => {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	};
	private agentsFilesOverride?: (base: { agentsFiles: Array<{ path: string; content?: string }> }) => {
		agentsFiles: Array<{ path: string; content?: string }>;
	};
	private systemPromptOverride?: (base: string | undefined) => string | undefined;
	private appendSystemPromptOverride?: (base: string[]) => string[];

	private extensionsResult: LoadExtensionsResult;
	private skills: Skill[];
	private skillDiagnostics: ResourceDiagnostic[];
	private prompts: PromptTemplate[];
	private promptDiagnostics: ResourceDiagnostic[];
	private themes: Theme[];
	private themeDiagnostics: ResourceDiagnostic[];
	private agentsFiles: Array<{ path: string; content?: string }>;
	private systemPrompt?: string;
	private appendSystemPrompt: string[];
	private lastSkillPaths: string[];
	private lastAgentsFilePaths: string[] = [];
	private discoverableSkillPaths: string[] = [];
	private discoverablePromptPaths: string[] = [];
	private agentsDiagnostics: ResourceDiagnostic[] = [];
	private extensionSkillSourceInfos: Map<string, SourceInfo>;
	private extensionPromptSourceInfos: Map<string, SourceInfo>;
	private extensionThemeSourceInfos: Map<string, SourceInfo>;
	private lastPromptPaths: string[];
	private lastThemePaths: string[];
	private pendingReloadSnapshot: ResourceLoaderSnapshot | undefined;

	constructor(options: DefaultResourceLoaderOptions) {
		this.cwd = resolvePath(options.cwd);
		this.agentDir = resolvePath(options.agentDir);
		this.settingsManager = options.settingsManager ?? SettingsManager.create(this.cwd, this.agentDir);
		this.eventBus = options.eventBus ?? createEventBus();
		this.packageManager = new DefaultPackageManager({
			cwd: this.cwd,
			agentDir: this.agentDir,
			settingsManager: this.settingsManager,
		});
		this.additionalExtensionPaths = options.additionalExtensionPaths ?? [];
		this.additionalSkillPaths = options.additionalSkillPaths ?? [];
		this.additionalPromptTemplatePaths = options.additionalPromptTemplatePaths ?? [];
		this.additionalThemePaths = options.additionalThemePaths ?? [];
		this.noExtensions = options.noExtensions ?? false;
		this.extensionFactories = options.extensionFactories ?? [];
		this.noSkills = options.noSkills ?? false;
		this.noPromptTemplates = options.noPromptTemplates ?? false;
		this.noThemes = options.noThemes ?? false;
		this.noContextFiles = options.noContextFiles ?? false;
		this.systemPromptSource = options.systemPrompt;
		this.appendSystemPromptSource = options.appendSystemPrompt;
		this.extensionsOverride = options.extensionsOverride;
		this.skillsOverride = options.skillsOverride;
		this.promptsOverride = options.promptsOverride;
		this.themesOverride = options.themesOverride;
		this.agentsFilesOverride = options.agentsFilesOverride;
		this.systemPromptOverride = options.systemPromptOverride;
		this.appendSystemPromptOverride = options.appendSystemPromptOverride;

		this.extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
		this.skills = [];
		this.skillDiagnostics = [];
		this.prompts = [];
		this.promptDiagnostics = [];
		this.themes = [];
		this.themeDiagnostics = [];
		this.agentsFiles = [];
		this.appendSystemPrompt = [];
		this.lastSkillPaths = [];
		this.extensionSkillSourceInfos = new Map();
		this.extensionPromptSourceInfos = new Map();
		this.extensionThemeSourceInfos = new Map();
		this.lastPromptPaths = [];
		this.lastThemePaths = [];
	}

	getExtensions(): LoadExtensionsResult {
		return this.extensionsResult;
	}

	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
		return { skills: this.skills, diagnostics: this.skillDiagnostics };
	}

	/**
	 * Skills permitted by the CURRENTLY active resource profile (the loaded set intersected with the
	 * live profile filter). Use this everywhere a skill can be SELECTED, INVOKED, or shown to the
	 * agent — so neither the user (autocomplete / typed `/skill:`) nor the agent (system prompt /
	 * expansion / command API / RPC) can use a skill the active profile blocks, including after a
	 * runtime profile switch (router-managed / `/profile`). The full loaded set (`getSkills`) is
	 * reserved for the profile editor and resource listings, which must show blockable skills.
	 */
	getActiveSkills(): Skill[] {
		const filter = this.settingsManager.getResourceProfileFilter("skills");
		if (filter.allow.length === 0 && filter.block.length === 0) return this.skills;
		return this.skills.filter((s) => {
			const allowed = filter.allow.length === 0 || matchesResourceProfilePattern(s.filePath, filter.allow, this.cwd);
			const blocked = matchesResourceProfilePattern(s.filePath, filter.block, this.cwd);
			return allowed && !blocked;
		});
	}

	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
		return { prompts: this.prompts, diagnostics: this.promptDiagnostics };
	}

	/**
	 * Prompt templates permitted by the CURRENTLY active resource profile (the loaded set intersected with the
	 * live profile filter). Use this everywhere a prompt template can be SELECTED, INVOKED, or shown to the
	 * agent — so neither the user (autocomplete / typed slash command) nor the agent can use a prompt template
	 * the active profile blocks. The full loaded set (`getPrompts`) is reserved for the profile editor.
	 */
	getActivePrompts(): PromptTemplate[] {
		const filter = this.settingsManager.getResourceProfileFilter("prompts");
		if (filter.allow.length === 0 && filter.block.length === 0) return this.prompts;
		return this.prompts.filter((p) => {
			const allowed = filter.allow.length === 0 || matchesResourceProfilePattern(p.filePath, filter.allow, this.cwd);
			const blocked = matchesResourceProfilePattern(p.filePath, filter.block, this.cwd);
			return allowed && !blocked;
		});
	}

	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] } {
		return { themes: this.themes, diagnostics: this.themeDiagnostics };
	}

	/**
	 * Themes permitted by the CURRENTLY active resource profile.
	 */
	getActiveThemes(): Theme[] {
		const filter = this.settingsManager.getResourceProfileFilter("themes");
		if (filter.allow.length === 0 && filter.block.length === 0) return this.themes;
		return this.themes.filter((t) => {
			if (!t.sourcePath) return true;
			const allowed =
				filter.allow.length === 0 || matchesResourceProfilePattern(t.sourcePath, filter.allow, this.cwd);
			const blocked = matchesResourceProfilePattern(t.sourcePath, filter.block, this.cwd);
			return allowed && !blocked;
		});
	}

	getAgentsFiles(): { agentsFiles: Array<{ path: string; content?: string }> } {
		return { agentsFiles: this.agentsFiles };
	}

	/** Warnings about context files withheld by the active profile (empty when none). */
	getAgentsDiagnostics(): ResourceDiagnostic[] {
		return this.agentsDiagnostics;
	}

	/**
	 * Profile-INDEPENDENT discovery for the profile editor's universe (same rule as
	 * getDiscoverableExtensionPaths): the full pre-filter path sets retained from the last
	 * reload. Discovery is metadata, not loading — granting a currently-blocked skill/prompt/
	 * context file requires being able to SEE it; strict UAC only forbids reading denied
	 * CONTENT into the session.
	 */
	getDiscoverableSkillPaths(): string[] {
		return [...this.discoverableSkillPaths];
	}

	getDiscoverablePromptPaths(): string[] {
		return [...this.discoverablePromptPaths];
	}

	getDiscoverableAgentsFilePaths(): string[] {
		return [...this.lastAgentsFilePaths];
	}

	getSystemPrompt(): string | undefined {
		return this.systemPrompt;
	}

	getAppendSystemPrompt(): string[] {
		return this.appendSystemPrompt;
	}

	/**
	 * Get all discoverable extension paths (enabled and disabled).
	 * Used for profile resource filtering to show the full universe of available extensions.
	 */
	async getDiscoverableExtensionPaths(): Promise<string[]> {
		await this.settingsManager.reload();
		const resolvedPaths = await this.packageManager.resolve();
		const cliExtensionPaths = await this.packageManager.resolveExtensionSources(this.additionalExtensionPaths, {
			temporary: true,
		});
		// Return all paths (enabled and disabled) from resolved, CLI, AND external-resource-root sources.
		// External-root extensions are loaded just like the others (see reload), so they MUST appear in the
		// profile editor's universe too — otherwise they're active but unblockable, and the editor wrongly
		// shows "(none available)" while they run (bug: external extensions invisible to the profile editor).
		const allPaths = new Set<string>();
		for (const resource of resolvedPaths.extensions) {
			allPaths.add(resource.path);
		}
		for (const resource of cliExtensionPaths.extensions) {
			allPaths.add(resource.path);
		}
		for (const p of this.discoverExternalExtensionPaths()) {
			allPaths.add(p);
		}
		return Array.from(allPaths);
	}

	/**
	 * Discover extension directories under every external resource root (`<root>/extensions/<name>` with an
	 * index.ts/index.js/package.json). Single source of truth shared by the load path and the profile
	 * editor's universe so the two never diverge.
	 */
	private discoverExternalExtensionPaths(): string[] {
		const out: string[] = [];
		for (const root of this.settingsManager.getEffectiveExternalResourceRoots()) {
			const extDir = join(root, "extensions");
			if (!existsSync(extDir)) continue;
			try {
				for (const entry of readdirSync(extDir, { withFileTypes: true })) {
					let isDir = entry.isDirectory();
					if (entry.isSymbolicLink()) {
						try {
							isDir = statSync(join(extDir, entry.name)).isDirectory();
						} catch {
							continue;
						}
					}
					if (!isDir) continue;
					const entryPath = join(extDir, entry.name);
					if (
						existsSync(join(entryPath, "index.ts")) ||
						existsSync(join(entryPath, "index.js")) ||
						existsSync(join(entryPath, "package.json"))
					) {
						out.push(entryPath);
					}
				}
			} catch {
				// silent — a missing/unreadable root must not break discovery
			}
		}
		return out;
	}

	/**
	 * Get a loaded extension by path.
	 * Matches by path or resolvedPath.
	 */
	getLoadedExtension(extensionPath: string): Extension | undefined {
		return this.extensionsResult.extensions.find(
			(ext) => ext.path === extensionPath || ext.resolvedPath === extensionPath,
		);
	}

	/**
	 * Remove and return a loaded extension from the extensions array.
	 */
	removeLoadedExtension(extensionPath: string): Extension | undefined {
		const index = this.extensionsResult.extensions.findIndex(
			(ext) => ext.path === extensionPath || ext.resolvedPath === extensionPath,
		);
		if (index === -1) return undefined;
		const [ext] = this.extensionsResult.extensions.splice(index, 1);
		return ext;
	}

	/**
	 * Load a single extension with fresh import, reusing the shared runtime.
	 * Returns the loaded extension or null with error details.
	 */
	async loadSingleExtension(extensionPath: string): Promise<{ extension: Extension | null; error: string | null }> {
		const result = await loadExtension(extensionPath, this.cwd, this.eventBus, this.extensionsResult.runtime, {
			fresh: true,
		});
		if (result.extension && !result.error) {
			const loaded = result.extension;
			// Drop any stale generation at the same path, then register the freshly loaded one so
			// _buildRuntime() aggregates it.
			this.extensionsResult.extensions = this.extensionsResult.extensions.filter(
				(e) => e.path !== loaded.path && e.resolvedPath !== loaded.resolvedPath,
			);
			this.extensionsResult.extensions.push(loaded);
		}
		return result;
	}

	/**
	 * Apply the active resource-profile allow/block to a list of discovered resource paths.
	 * Used for every source that does NOT pass through the package manager's
	 * resolve/applyResourceProfileFilters pipeline (external roots, bundled defaults, and
	 * extension-contributed resources) so no source bypasses the active profile.
	 */
	private filterPathsByProfile(paths: string[], kind: ResourceProfileKind): string[] {
		const filter = this.settingsManager.getResourceProfileFilter(kind);
		if (filter.allow.length === 0 && filter.block.length === 0) return paths;
		return paths.filter((p) => {
			const allowed = filter.allow.length === 0 || matchesResourceProfilePattern(p, filter.allow, this.cwd);
			const blocked = matchesResourceProfilePattern(p, filter.block, this.cwd);
			return allowed && !blocked;
		});
	}

	extendResources(paths: ResourceExtensionPaths): void {
		// Extension-contributed resources (via the resources_discover event) must respect the
		// active resource profile too — otherwise an allowed extension can re-introduce skills/
		// prompts/themes the profile blocks.
		const allowPath = (entry: { path: string }, kind: ResourceProfileKind): boolean =>
			this.filterPathsByProfile([entry.path], kind).length > 0;
		const skillPaths = this.normalizeExtensionPaths(paths.skillPaths ?? []).filter((e) => allowPath(e, "skills"));
		const promptPaths = this.normalizeExtensionPaths(paths.promptPaths ?? []).filter((e) => allowPath(e, "prompts"));
		const themePaths = this.normalizeExtensionPaths(paths.themePaths ?? []).filter((e) => allowPath(e, "themes"));

		for (const entry of skillPaths) {
			this.extensionSkillSourceInfos.set(entry.path, createSourceInfo(entry.path, entry.metadata));
		}
		for (const entry of promptPaths) {
			this.extensionPromptSourceInfos.set(entry.path, createSourceInfo(entry.path, entry.metadata));
		}
		for (const entry of themePaths) {
			this.extensionThemeSourceInfos.set(entry.path, createSourceInfo(entry.path, entry.metadata));
		}

		if (skillPaths.length > 0) {
			this.lastSkillPaths = this.mergePaths(
				this.lastSkillPaths,
				skillPaths.map((entry) => entry.path),
			);
			this.updateSkillsFromPaths(this.lastSkillPaths);
		}

		if (promptPaths.length > 0) {
			this.lastPromptPaths = this.mergePaths(
				this.lastPromptPaths,
				promptPaths.map((entry) => entry.path),
			);
			this.updatePromptsFromPaths(this.lastPromptPaths);
		}

		if (themePaths.length > 0) {
			this.lastThemePaths = this.mergePaths(
				this.lastThemePaths,
				themePaths.map((entry) => entry.path),
			);
			this.updateThemesFromPaths(this.lastThemePaths);
		}
	}

	private createSnapshot(): ResourceLoaderSnapshot {
		return {
			extensionsResult: this.extensionsResult,
			skills: this.skills,
			skillDiagnostics: this.skillDiagnostics,
			prompts: this.prompts,
			promptDiagnostics: this.promptDiagnostics,
			themes: this.themes,
			themeDiagnostics: this.themeDiagnostics,
			agentsFiles: this.agentsFiles,
			systemPrompt: this.systemPrompt,
			appendSystemPrompt: this.appendSystemPrompt,
			lastSkillPaths: this.lastSkillPaths,
			extensionSkillSourceInfos: this.extensionSkillSourceInfos,
			extensionPromptSourceInfos: this.extensionPromptSourceInfos,
			extensionThemeSourceInfos: this.extensionThemeSourceInfos,
			lastPromptPaths: this.lastPromptPaths,
			lastThemePaths: this.lastThemePaths,
		};
	}

	private restoreSnapshot(snapshot: ResourceLoaderSnapshot): void {
		this.extensionsResult = snapshot.extensionsResult;
		this.skills = snapshot.skills;
		this.skillDiagnostics = snapshot.skillDiagnostics;
		this.prompts = snapshot.prompts;
		this.promptDiagnostics = snapshot.promptDiagnostics;
		this.themes = snapshot.themes;
		this.themeDiagnostics = snapshot.themeDiagnostics;
		this.agentsFiles = snapshot.agentsFiles;
		this.systemPrompt = snapshot.systemPrompt;
		this.appendSystemPrompt = snapshot.appendSystemPrompt;
		this.lastSkillPaths = snapshot.lastSkillPaths;
		this.extensionSkillSourceInfos = snapshot.extensionSkillSourceInfos;
		this.extensionPromptSourceInfos = snapshot.extensionPromptSourceInfos;
		this.extensionThemeSourceInfos = snapshot.extensionThemeSourceInfos;
		this.lastPromptPaths = snapshot.lastPromptPaths;
		this.lastThemePaths = snapshot.lastThemePaths;
	}

	async commitReload(): Promise<void> {
		if (!this.pendingReloadSnapshot) return;
		await disposeExtensionEventSubscriptions(this.pendingReloadSnapshot.extensionsResult.extensions);
		this.pendingReloadSnapshot = undefined;
	}

	async rollbackReload(): Promise<void> {
		if (!this.pendingReloadSnapshot) return;
		await disposeExtensionEventSubscriptions(this.extensionsResult.extensions);
		this.restoreSnapshot(this.pendingReloadSnapshot);
		this.pendingReloadSnapshot = undefined;
	}

	async reload(options: ResourceReloadOptions = {}): Promise<void> {
		const snapshot = this.createSnapshot();
		this.pendingReloadSnapshot = undefined;
		try {
			await this.settingsManager.reload();
			const resolvedPaths = await this.packageManager.resolve();
			const cliExtensionPaths = await this.packageManager.resolveExtensionSources(this.additionalExtensionPaths, {
				temporary: true,
			});
			const metadataByPath = new Map<string, PathMetadata>();

			this.extensionSkillSourceInfos = new Map();
			this.extensionPromptSourceInfos = new Map();
			this.extensionThemeSourceInfos = new Map();

			// Helper to extract enabled paths and store metadata
			const getEnabledResources = (
				resources: Array<{ path: string; enabled: boolean; metadata: PathMetadata }>,
			): Array<{ path: string; enabled: boolean; metadata: PathMetadata }> => {
				for (const r of resources) {
					if (!metadataByPath.has(r.path)) {
						metadataByPath.set(r.path, r.metadata);
					}
				}
				return resources.filter((r) => r.enabled);
			};

			const getEnabledPaths = (
				resources: Array<{ path: string; enabled: boolean; metadata: PathMetadata }>,
			): string[] => getEnabledResources(resources).map((r) => r.path);

			const enabledExtensions = getEnabledPaths(resolvedPaths.extensions);
			const enabledSkillResources = getEnabledResources(resolvedPaths.skills);
			const enabledPrompts = getEnabledPaths(resolvedPaths.prompts);
			const enabledThemes = getEnabledPaths(resolvedPaths.themes);

			const mapSkillPath = (resource: { path: string; metadata: PathMetadata }): string => {
				if (resource.metadata.source !== "auto" && resource.metadata.origin !== "package") {
					return resource.path;
				}
				try {
					const stats = statSync(resource.path);
					if (!stats.isDirectory()) {
						return resource.path;
					}
				} catch {
					return resource.path;
				}
				const skillFile = join(resource.path, "SKILL.md");
				if (existsSync(skillFile)) {
					if (!metadataByPath.has(skillFile)) {
						metadataByPath.set(skillFile, resource.metadata);
					}
					return skillFile;
				}
				return resource.path;
			};

			const enabledSkills = enabledSkillResources.map(mapSkillPath);

			// Add CLI paths metadata
			for (const r of cliExtensionPaths.extensions) {
				if (!metadataByPath.has(r.path)) {
					metadataByPath.set(r.path, { source: "cli", scope: "temporary", origin: "top-level" });
				}
			}
			for (const r of cliExtensionPaths.skills) {
				if (!metadataByPath.has(r.path)) {
					metadataByPath.set(r.path, { source: "cli", scope: "temporary", origin: "top-level" });
				}
			}

			const cliEnabledExtensions = getEnabledPaths(cliExtensionPaths.extensions);
			const cliEnabledSkills = getEnabledPaths(cliExtensionPaths.skills);
			const cliEnabledPrompts = getEnabledPaths(cliExtensionPaths.prompts);
			const cliEnabledThemes = getEnabledPaths(cliExtensionPaths.themes);

			// Gather effective external resource roots
			const effectiveRoots = this.settingsManager.getEffectiveExternalResourceRoots();

			const filterPathsByProfile = (paths: string[], kind: ResourceProfileKind): string[] =>
				this.filterPathsByProfile(paths, kind);

			// Discover external extensions (same source the profile editor uses, so they stay in sync).
			const externalExtensions = this.discoverExternalExtensionPaths();
			for (const entryPath of externalExtensions) {
				metadataByPath.set(entryPath, { source: "external", scope: "user", origin: "top-level" });
			}
			const activeProfilesForExt = this.settingsManager.getActiveResourceProfileNames();
			const profileFilteredExternalExtensions =
				activeProfilesForExt.length === 0 ? [] : filterPathsByProfile(externalExtensions, "extensions");

			const extensionPaths = this.noExtensions
				? cliEnabledExtensions
				: this.mergePaths(cliEnabledExtensions, [
						...filterPathsByProfile(enabledExtensions, "extensions"),
						...profileFilteredExternalExtensions,
					]);

			const extensionsResult = await loadExtensions(extensionPaths, this.cwd, this.eventBus);
			const inlineExtensions = await this.loadExtensionFactories(extensionsResult.runtime);
			extensionsResult.extensions.push(...inlineExtensions.extensions);
			extensionsResult.errors.push(...inlineExtensions.errors);

			// Detect extension conflicts (tools, commands, flags with same names from different extensions)
			// Keep all extensions loaded. Conflicts are reported as diagnostics, and precedence is handled by load order.
			const conflicts = this.detectExtensionConflicts(extensionsResult.extensions);
			for (const conflict of conflicts) {
				extensionsResult.errors.push({ path: conflict.path, error: conflict.message });
			}

			for (const p of this.additionalExtensionPaths) {
				if (isLocalPath(p)) {
					const resolved = this.resolveResourcePath(p);
					if (!existsSync(resolved)) {
						extensionsResult.errors.push({ path: resolved, error: `Extension path does not exist: ${resolved}` });
					}
				}
			}
			const resolvedExtensionsResult = this.extensionsOverride
				? this.extensionsOverride(extensionsResult)
				: extensionsResult;
			if (options.failOnExtensionErrors && resolvedExtensionsResult.errors.length > 0) {
				const summary = resolvedExtensionsResult.errors
					.slice(0, 6)
					.map((error) => `${error.path}: ${error.error}`)
					.join("; ");
				throw new Error(`Extension reload failed preflight: ${summary}`);
			}
			this.extensionsResult = resolvedExtensionsResult;
			this.applyExtensionSourceInfo(this.extensionsResult.extensions, metadataByPath);

			// Discover external skills
			const externalSkills: string[] = [];
			for (const root of effectiveRoots) {
				const skillsDir = join(root, "skills");
				if (existsSync(skillsDir)) {
					try {
						const entries = readdirSync(skillsDir, { withFileTypes: true });
						for (const entry of entries) {
							let isDir = entry.isDirectory();
							if (entry.isSymbolicLink()) {
								try {
									const stats = statSync(join(skillsDir, entry.name));
									isDir = stats.isDirectory();
								} catch {
									continue;
								}
							}
							if (isDir) {
								const entryPath = join(skillsDir, entry.name);
								const skillFile = join(entryPath, "SKILL.md");
								const targetPath = existsSync(skillFile) ? skillFile : entryPath;
								externalSkills.push(targetPath);
								metadataByPath.set(targetPath, { source: "external", scope: "user", origin: "top-level" });
							}
						}
					} catch {
						// silent
					}
				}
			}

			// Build skill paths with precedence: CLI > user/project > bundled > additional.
			// Bundled skills are expanded into individual SKILL.md paths so they pass through the
			// resource-profile filter exactly like user/external skills (no source bypasses the profile).
			const bundledSkillsDir = getBundledSkillsDir();
			const bundledSkillPaths: string[] = [];
			if (existsSync(bundledSkillsDir)) {
				try {
					for (const entry of readdirSync(bundledSkillsDir, { withFileTypes: true })) {
						if (!entry.isDirectory()) continue;
						const entryPath = join(bundledSkillsDir, entry.name);
						const skillFile = join(entryPath, "SKILL.md");
						bundledSkillPaths.push(existsSync(skillFile) ? skillFile : entryPath);
					}
				} catch {
					// silent
				}
			}
			const skillPaths = this.noSkills
				? this.mergePaths([...cliEnabledSkills], this.additionalSkillPaths)
				: this.mergePaths(
						[...cliEnabledSkills, ...enabledSkills, ...externalSkills, ...bundledSkillPaths],
						this.additionalSkillPaths,
					);

			this.lastSkillPaths = skillPaths;
			// Discovery universe: ALL package-resolved skills (profile-denied entries survive
			// resolve() with enabled=false) plus every other source, pre-filter.
			this.discoverableSkillPaths = this.mergePaths(
				[
					...cliEnabledSkills,
					...enabledSkillResources.map(mapSkillPath),
					...resolvedPaths.skills.map(mapSkillPath),
					...externalSkills,
					...bundledSkillPaths,
				],
				this.additionalSkillPaths,
			);
			this.updateSkillsFromPaths(skillPaths, metadataByPath);
			for (const p of this.additionalSkillPaths) {
				if (isLocalPath(p)) {
					const resolved = this.resolveResourcePath(p);
					if (!existsSync(resolved) && !this.skillDiagnostics.some((d) => d.path === resolved)) {
						this.skillDiagnostics.push({ type: "error", message: "Skill path does not exist", path: resolved });
					}
				}
			}

			// Discover external prompts
			const externalPrompts: string[] = [];
			for (const root of effectiveRoots) {
				const promptsDir = join(root, "prompts");
				if (existsSync(promptsDir)) {
					const files = collectFilesRecursively(promptsDir, /\.md$/);
					for (const f of files) {
						externalPrompts.push(f);
						metadataByPath.set(f, { source: "external", scope: "user", origin: "top-level" });
					}
				}
			}

			// Bundled prompts expanded into individual files so they pass through the profile filter too.
			const bundledPromptsDir = getBundledPromptsDir();
			const bundledPromptPaths = existsSync(bundledPromptsDir)
				? collectFilesRecursively(bundledPromptsDir, /\.md$/)
				: [];
			const promptPaths = this.noPromptTemplates
				? this.mergePaths(cliEnabledPrompts, this.additionalPromptTemplatePaths)
				: this.mergePaths(
						[...cliEnabledPrompts, ...enabledPrompts, ...externalPrompts, ...bundledPromptPaths],
						this.additionalPromptTemplatePaths,
					);

			this.lastPromptPaths = promptPaths;
			this.discoverablePromptPaths = this.mergePaths(
				[
					...cliEnabledPrompts,
					...enabledPrompts,
					...resolvedPaths.prompts.map((resource) => resource.path),
					...externalPrompts,
					...bundledPromptPaths,
				],
				this.additionalPromptTemplatePaths,
			);
			this.updatePromptsFromPaths(promptPaths, metadataByPath);
			for (const p of this.additionalPromptTemplatePaths) {
				if (isLocalPath(p)) {
					const resolved = this.resolveResourcePath(p);
					if (!existsSync(resolved) && !this.promptDiagnostics.some((d) => d.path === resolved)) {
						this.promptDiagnostics.push({
							type: "error",
							message: "Prompt template path does not exist",
							path: resolved,
						});
					}
				}
			}

			// Discover external themes
			const externalThemes: string[] = [];
			for (const root of effectiveRoots) {
				const themesDir = join(root, "themes");
				if (existsSync(themesDir)) {
					const files = collectFilesRecursively(themesDir, /\.json$/);
					for (const f of files) {
						externalThemes.push(f);
						metadataByPath.set(f, { source: "external", scope: "user", origin: "top-level" });
					}
				}
			}

			const themePaths = this.noThemes
				? this.mergePaths(cliEnabledThemes, this.additionalThemePaths)
				: this.mergePaths([...cliEnabledThemes, ...enabledThemes, ...externalThemes], this.additionalThemePaths);

			this.lastThemePaths = themePaths;
			this.updateThemesFromPaths(themePaths, metadataByPath);
			for (const p of this.additionalThemePaths) {
				const resolved = this.resolveResourcePath(p);
				if (!existsSync(resolved) && !this.themeDiagnostics.some((d) => d.path === resolved)) {
					this.themeDiagnostics.push({ type: "error", message: "Theme path does not exist", path: resolved });
				}
			}

			// Read RAW content once. Sanitization/threat-scanning/exposure is deferred until AFTER the
			// agents filter, so a profile-denied context file's content is never processed into the session.
			const rawAgentsFiles = this.noContextFiles
				? []
				: loadRawProjectContextFiles({
						cwd: this.cwd,
						agentDir: this.agentDir,
						projectTrusted: this.settingsManager.isProjectTrusted(),
					});
			const agentEmbeddedProfiles: Record<string, ResourceProfileSettings> = {};
			const activeProfileNames = this.settingsManager.getActiveResourceProfileNames();
			// DISCOVERY read (metadata only, never loading): an embedded <resource-profile> block can live
			// in ANY context file — including one the resulting agents filter then denies (AGENTS.md
			// defining a profile that blocks GEMINI.md is the canonical bootstrap circularity). The filter
			// cannot be known without first scanning every candidate file's raw content, so path-based
			// pre-filtering is impossible for the agents kind. Only profile-block config is extracted here;
			// a denied file's instructional content is never sanitized, threat-scanned, or exposed — it is
			// dropped by the filter below — so the never-read-denied-CONTENT invariant holds.
			for (const file of rawAgentsFiles) {
				try {
					const { profiles } = parseResourceProfileBlocks(file.rawContent, { profileNames: activeProfileNames });
					Object.assign(agentEmbeddedProfiles, mergeResourceProfileMap(agentEmbeddedProfiles, profiles));
				} catch {}
			}
			this.settingsManager.addDiscoveredResourceProfileDefinitions(agentEmbeddedProfiles);
			const agentProfileFilter = this.settingsManager.getResourceProfileFilter("agents");
			// Editor universe: the FULL pre-filter path set (discovery is metadata, not loading).
			this.lastAgentsFilePaths = rawAgentsFiles.map((file) => file.path);
			const agentsFiles = {
				agentsFiles: rawAgentsFiles
					.filter((file) => {
						const allowed =
							agentProfileFilter.allow.length === 0 ||
							matchesResourceProfilePattern(file.path, agentProfileFilter.allow, this.cwd);
						const blocked = matchesResourceProfilePattern(file.path, agentProfileFilter.block, this.cwd);
						return allowed && !blocked;
					})
					// Sanitize (strip profile blocks + scan threats) ONLY for allowed files — the denied
					// files' raw content was used solely for profile-block discovery above.
					.map((file) => ({ path: file.path, content: sanitizeContextFileContent(file.path, file.rawContent) })),
			};
			// Strict UAC silently denying AGENTS.md/CLAUDE.md context is a sharp footgun for lean
			// profiles — surface it loudly instead of letting instructions vanish without a trace.
			const withheldAgentsCount = rawAgentsFiles.length - agentsFiles.agentsFiles.length;
			this.agentsDiagnostics =
				withheldAgentsCount > 0
					? [
							{
								type: "warning",
								message: `${withheldAgentsCount} context file(s) (AGENTS.md/CLAUDE.md) withheld by the active resource profile — grant the "agents" kind to restore them`,
							},
						]
					: [];
			const resolvedAgentsFiles = this.agentsFilesOverride ? this.agentsFilesOverride(agentsFiles) : agentsFiles;
			this.agentsFiles = resolvedAgentsFiles.agentsFiles;

			const baseSystemPrompt = resolvePromptInput(
				this.systemPromptSource ?? this.discoverSystemPromptFile(),
				"system prompt",
			);
			this.systemPrompt = this.systemPromptOverride ? this.systemPromptOverride(baseSystemPrompt) : baseSystemPrompt;

			const appendSources =
				this.appendSystemPromptSource ??
				(this.discoverAppendSystemPromptFile() ? [this.discoverAppendSystemPromptFile()!] : []);
			const baseAppend = appendSources
				.map((s) => resolvePromptInput(s, "append system prompt"))
				.filter((s): s is string => s !== undefined);
			this.appendSystemPrompt = this.appendSystemPromptOverride
				? this.appendSystemPromptOverride(baseAppend)
				: baseAppend;
			if (options.deferExtensionDispose) {
				this.pendingReloadSnapshot = snapshot;
			} else {
				await disposeExtensionEventSubscriptions(snapshot.extensionsResult.extensions);
			}
		} catch (error) {
			if (this.extensionsResult !== snapshot.extensionsResult) {
				await disposeExtensionEventSubscriptions(this.extensionsResult.extensions);
			}
			this.restoreSnapshot(snapshot);
			throw error;
		}
	}

	private normalizeExtensionPaths(
		entries: Array<{ path: string; metadata: PathMetadata }>,
	): Array<{ path: string; metadata: PathMetadata }> {
		return entries.map((entry) => {
			const metadata = entry.metadata.baseDir
				? { ...entry.metadata, baseDir: this.resolveResourcePath(entry.metadata.baseDir) }
				: entry.metadata;
			return {
				path: this.resolveResourcePath(entry.path),
				metadata,
			};
		});
	}

	private updateSkillsFromPaths(skillPaths: string[], metadataByPath?: Map<string, PathMetadata>): void {
		let skillsResult: { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
		if (this.noSkills && skillPaths.length === 0) {
			skillsResult = { skills: [], diagnostics: [] };
		} else {
			skillsResult = loadSkills({
				cwd: this.cwd,
				agentDir: this.agentDir,
				skillPaths,
				includeDefaults: false,
				// Profile UAC: denied skill files are never read from disk.
				isPathAllowed: (path) => this.filterPathsByProfile([path], "skills").length > 0,
			});
		}
		const resolvedSkills = this.skillsOverride ? this.skillsOverride(skillsResult) : skillsResult;
		this.skills = resolvedSkills.skills.map((skill) => ({
			...skill,
			sourceInfo:
				this.findSourceInfoForPath(skill.filePath, this.extensionSkillSourceInfos, metadataByPath) ??
				skill.sourceInfo ??
				this.getDefaultSourceInfoForPath(skill.filePath),
		}));
		this.skillDiagnostics = resolvedSkills.diagnostics;
	}

	private updatePromptsFromPaths(promptPaths: string[], metadataByPath?: Map<string, PathMetadata>): void {
		let promptsResult: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
		if (this.noPromptTemplates && promptPaths.length === 0) {
			promptsResult = { prompts: [], diagnostics: [] };
		} else {
			const allPrompts = loadPromptTemplates({
				cwd: this.cwd,
				agentDir: this.agentDir,
				promptPaths,
				includeDefaults: false,
				// Profile UAC: denied prompt templates are never read from disk.
				isPathAllowed: (path) => this.filterPathsByProfile([path], "prompts").length > 0,
			});
			promptsResult = this.dedupePrompts(allPrompts);
		}
		const resolvedPrompts = this.promptsOverride ? this.promptsOverride(promptsResult) : promptsResult;
		this.prompts = resolvedPrompts.prompts.map((prompt) => ({
			...prompt,
			sourceInfo:
				this.findSourceInfoForPath(prompt.filePath, this.extensionPromptSourceInfos, metadataByPath) ??
				prompt.sourceInfo ??
				this.getDefaultSourceInfoForPath(prompt.filePath),
		}));
		this.promptDiagnostics = resolvedPrompts.diagnostics;
	}

	private updateThemesFromPaths(themePaths: string[], metadataByPath?: Map<string, PathMetadata>): void {
		let themesResult: { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
		if (this.noThemes && themePaths.length === 0) {
			themesResult = { themes: [], diagnostics: [] };
		} else {
			const loaded = this.loadThemes(themePaths, false);
			const deduped = this.dedupeThemes(loaded.themes);
			themesResult = { themes: deduped.themes, diagnostics: [...loaded.diagnostics, ...deduped.diagnostics] };
		}
		const resolvedThemes = this.themesOverride ? this.themesOverride(themesResult) : themesResult;
		this.themes = resolvedThemes.themes.map((theme) => {
			const sourcePath = theme.sourcePath;
			theme.sourceInfo = sourcePath
				? (this.findSourceInfoForPath(sourcePath, this.extensionThemeSourceInfos, metadataByPath) ??
					theme.sourceInfo ??
					this.getDefaultSourceInfoForPath(sourcePath))
				: theme.sourceInfo;
			return theme;
		});
		this.themeDiagnostics = resolvedThemes.diagnostics;
	}

	private applyExtensionSourceInfo(extensions: Extension[], metadataByPath: Map<string, PathMetadata>): void {
		for (const extension of extensions) {
			extension.sourceInfo =
				this.findSourceInfoForPath(extension.path, undefined, metadataByPath) ??
				this.getDefaultSourceInfoForPath(extension.path);
			for (const command of extension.commands.values()) {
				command.sourceInfo = extension.sourceInfo;
			}
			for (const tool of extension.tools.values()) {
				tool.sourceInfo = extension.sourceInfo;
			}
		}
	}

	private findSourceInfoForPath(
		resourcePath: string,
		extraSourceInfos?: Map<string, SourceInfo>,
		metadataByPath?: Map<string, PathMetadata>,
	): SourceInfo | undefined {
		if (!resourcePath) {
			return undefined;
		}

		if (resourcePath.startsWith("<")) {
			return this.getDefaultSourceInfoForPath(resourcePath);
		}

		const normalizedResourcePath = resolve(resourcePath);
		if (extraSourceInfos) {
			for (const [sourcePath, sourceInfo] of extraSourceInfos.entries()) {
				const normalizedSourcePath = resolve(sourcePath);
				if (
					normalizedResourcePath === normalizedSourcePath ||
					normalizedResourcePath.startsWith(`${normalizedSourcePath}${sep}`)
				) {
					return { ...sourceInfo, path: resourcePath };
				}
			}
		}

		if (metadataByPath) {
			const exact = metadataByPath.get(normalizedResourcePath) ?? metadataByPath.get(resourcePath);
			if (exact) {
				return createSourceInfo(resourcePath, exact);
			}

			for (const [sourcePath, metadata] of metadataByPath.entries()) {
				const normalizedSourcePath = resolve(sourcePath);
				if (
					normalizedResourcePath === normalizedSourcePath ||
					normalizedResourcePath.startsWith(`${normalizedSourcePath}${sep}`)
				) {
					return createSourceInfo(resourcePath, metadata);
				}
			}
		}

		return undefined;
	}

	private getDefaultSourceInfoForPath(filePath: string): SourceInfo {
		if (filePath.startsWith("<") && filePath.endsWith(">")) {
			return {
				path: filePath,
				source: filePath.slice(1, -1).split(":")[0] || "temporary",
				scope: "temporary",
				origin: "top-level",
			};
		}

		const normalizedPath = resolve(filePath);
		const agentRoots = [
			join(this.agentDir, "skills"),
			join(this.agentDir, "prompts"),
			join(this.agentDir, "themes"),
			join(this.agentDir, "extensions"),
		];
		const projectRoots = [
			join(this.cwd, CONFIG_DIR_NAME, "skills"),
			join(this.cwd, CONFIG_DIR_NAME, "prompts"),
			join(this.cwd, CONFIG_DIR_NAME, "themes"),
			join(this.cwd, CONFIG_DIR_NAME, "extensions"),
		];

		for (const root of agentRoots) {
			if (this.isUnderPath(normalizedPath, root)) {
				return { path: filePath, source: "local", scope: "user", origin: "top-level", baseDir: root };
			}
		}

		for (const root of projectRoots) {
			if (this.isUnderPath(normalizedPath, root)) {
				return { path: filePath, source: "local", scope: "project", origin: "top-level", baseDir: root };
			}
		}

		return {
			path: filePath,
			source: "local",
			scope: "temporary",
			origin: "top-level",
			baseDir: statSync(normalizedPath).isDirectory() ? normalizedPath : resolve(normalizedPath, ".."),
		};
	}

	private mergePaths(primary: string[], additional: string[]): string[] {
		const merged: string[] = [];
		const seen = new Set<string>();

		for (const p of [...primary, ...additional]) {
			const resolved = this.resolveResourcePath(p);
			const canonicalPath = canonicalizePath(resolved);
			if (seen.has(canonicalPath)) continue;
			seen.add(canonicalPath);
			merged.push(resolved);
		}

		return merged;
	}

	private resolveResourcePath(p: string): string {
		return resolvePath(p, this.cwd, { trim: true });
	}

	private loadThemes(
		paths: string[],
		includeDefaults: boolean = true,
	): {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	} {
		const themes: Theme[] = [];
		const diagnostics: ResourceDiagnostic[] = [];
		if (includeDefaults) {
			const defaultDirs = [join(this.agentDir, "themes"), join(this.cwd, CONFIG_DIR_NAME, "themes")];

			for (const dir of defaultDirs) {
				this.loadThemesFromDir(dir, themes, diagnostics);
			}
		}

		for (const p of paths) {
			const resolved = this.resolveResourcePath(p);
			if (!existsSync(resolved)) {
				diagnostics.push({ type: "warning", message: "theme path does not exist", path: resolved });
				continue;
			}

			try {
				const stats = statSync(resolved);
				if (stats.isDirectory()) {
					this.loadThemesFromDir(resolved, themes, diagnostics);
				} else if (stats.isFile() && resolved.endsWith(".json")) {
					this.loadThemeFromFile(resolved, themes, diagnostics);
				} else {
					diagnostics.push({ type: "warning", message: "theme path is not a json file", path: resolved });
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : "failed to read theme path";
				diagnostics.push({ type: "warning", message, path: resolved });
			}
		}

		return { themes, diagnostics };
	}

	private loadThemesFromDir(dir: string, themes: Theme[], diagnostics: ResourceDiagnostic[]): void {
		if (!existsSync(dir)) {
			return;
		}

		try {
			const entries = readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				let isFile = entry.isFile();
				if (entry.isSymbolicLink()) {
					try {
						isFile = statSync(join(dir, entry.name)).isFile();
					} catch {
						continue;
					}
				}
				if (!isFile) {
					continue;
				}
				if (!entry.name.endsWith(".json")) {
					continue;
				}
				this.loadThemeFromFile(join(dir, entry.name), themes, diagnostics);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to read theme directory";
			diagnostics.push({ type: "warning", message, path: dir });
		}
	}

	private loadThemeFromFile(filePath: string, themes: Theme[], diagnostics: ResourceDiagnostic[]): void {
		try {
			themes.push(loadThemeFromPath(filePath));
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to load theme";
			diagnostics.push({ type: "warning", message, path: filePath });
		}
	}

	private async loadExtensionFactories(runtime: ExtensionRuntime): Promise<{
		extensions: Extension[];
		errors: Array<{ path: string; error: string }>;
	}> {
		const extensions: Extension[] = [];
		const errors: Array<{ path: string; error: string }> = [];

		for (const [index, factory] of this.extensionFactories.entries()) {
			const extensionPath = `<inline:${index + 1}>`;
			try {
				const extension = await loadExtensionFromFactory(factory, this.cwd, this.eventBus, runtime, extensionPath);
				extensions.push(extension);
			} catch (error) {
				const message = error instanceof Error ? error.message : "failed to load extension";
				errors.push({ path: extensionPath, error: message });
			}
		}

		return { extensions, errors };
	}

	private dedupePrompts(prompts: PromptTemplate[]): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
		const seen = new Map<string, PromptTemplate>();
		const diagnostics: ResourceDiagnostic[] = [];

		for (const prompt of prompts) {
			const existing = seen.get(prompt.name);
			if (existing) {
				diagnostics.push({
					type: "collision",
					message: `name "/${prompt.name}" collision`,
					path: prompt.filePath,
					collision: {
						resourceType: "prompt",
						name: prompt.name,
						winnerPath: existing.filePath,
						loserPath: prompt.filePath,
					},
				});
			} else {
				seen.set(prompt.name, prompt);
			}
		}

		return { prompts: Array.from(seen.values()), diagnostics };
	}

	private dedupeThemes(themes: Theme[]): { themes: Theme[]; diagnostics: ResourceDiagnostic[] } {
		const seen = new Map<string, Theme>();
		const diagnostics: ResourceDiagnostic[] = [];

		for (const t of themes) {
			const name = t.name ?? "unnamed";
			const existing = seen.get(name);
			if (existing) {
				diagnostics.push({
					type: "collision",
					message: `name "${name}" collision`,
					path: t.sourcePath,
					collision: {
						resourceType: "theme",
						name,
						winnerPath: existing.sourcePath ?? "<builtin>",
						loserPath: t.sourcePath ?? "<builtin>",
					},
				});
			} else {
				seen.set(name, t);
			}
		}

		return { themes: Array.from(seen.values()), diagnostics };
	}

	private discoverSystemPromptFile(): string | undefined {
		const projectPath = join(this.cwd, CONFIG_DIR_NAME, "SYSTEM.md");
		if (this.settingsManager.isProjectTrusted() && existsSync(projectPath)) {
			return projectPath;
		}

		const globalPath = join(this.agentDir, "SYSTEM.md");
		if (existsSync(globalPath)) {
			return globalPath;
		}

		return undefined;
	}

	private discoverAppendSystemPromptFile(): string | undefined {
		const projectPath = join(this.cwd, CONFIG_DIR_NAME, "APPEND_SYSTEM.md");
		if (this.settingsManager.isProjectTrusted() && existsSync(projectPath)) {
			return projectPath;
		}

		const globalPath = join(this.agentDir, "APPEND_SYSTEM.md");
		if (existsSync(globalPath)) {
			return globalPath;
		}

		return undefined;
	}

	private isUnderPath(target: string, root: string): boolean {
		const normalizedRoot = resolve(root);
		if (target === normalizedRoot) {
			return true;
		}
		const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
		return target.startsWith(prefix);
	}

	private detectExtensionConflicts(extensions: Extension[]): Array<{ path: string; message: string }> {
		const conflicts: Array<{ path: string; message: string }> = [];

		// Track which extension registered each tool and flag
		const toolOwners = new Map<string, string>();
		const flagOwners = new Map<string, string>();

		for (const ext of extensions) {
			// Check tools
			for (const toolName of ext.tools.keys()) {
				const existingOwner = toolOwners.get(toolName);
				if (existingOwner && existingOwner !== ext.path) {
					conflicts.push({
						path: ext.path,
						message: `Tool "${toolName}" conflicts with ${existingOwner}`,
					});
				} else {
					toolOwners.set(toolName, ext.path);
				}
			}

			// Check flags
			for (const flagName of ext.flags.keys()) {
				const existingOwner = flagOwners.get(flagName);
				if (existingOwner && existingOwner !== ext.path) {
					conflicts.push({
						path: ext.path,
						message: `Flag "--${flagName}" conflicts with ${existingOwner}`,
					});
				} else {
					flagOwners.set(flagName, ext.path);
				}
			}
		}

		return conflicts;
	}
}

function collectFilesRecursively(dir: string, pattern: RegExp): string[] {
	const files: string[] = [];
	if (!existsSync(dir)) return files;

	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();

			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDir = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			if (isDir) {
				files.push(...collectFilesRecursively(fullPath, pattern));
			} else if (isFile && pattern.test(entry.name)) {
				files.push(fullPath);
			}
		}
	} catch {
		// silent
	}
	return files;
}
