import type { ThinkingLevel } from "@caupulican/pi-agent-core";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { isValidThinkingLevel } from "../cli/args.ts";
import { resolvePath } from "../utils/paths.ts";
import { mergeResourceProfileSettings } from "./resource-profile-blocks.ts";
import type { ResourceProfileKind, ResourceProfileSettings, Settings } from "./settings-manager.ts";
import { validateSkillName } from "./skills.ts";

export type ProfileSource =
	| "global-settings"
	| "project-settings"
	| "profile-file"
	| "directory-overlay"
	| "inline"
	| "embedded"
	| "bundle";

export interface NormalizedProfile {
	name: string;
	description?: string;
	model?: string;
	thinking?: ThinkingLevel;
	resources: ResourceProfileSettings;
	source: ProfileSource;
	sourcePath?: string;
	baseDir?: string;
}

export interface ProfileRegistryDiagnostic {
	source: ProfileSource;
	path?: string;
	message: string;
}

export interface ProfileRegistryOptions {
	globalSettings: Settings;
	projectSettings: Settings;
	directoryProfileSettings: Settings;
	inlineResourceProfileDefinitions: Record<string, ResourceProfileSettings>;
	discoveredResourceProfileDefinitions: Record<string, ResourceProfileSettings>;
	profilesDir?: string;
	externalResourceRoots?: string[];
}

const RESOURCE_PROFILE_KINDS: ResourceProfileKind[] = ["extensions", "skills", "prompts", "themes", "agents", "tools"];

interface ProfileCandidate {
	profile: NormalizedProfile;
	precedence: number;
	order: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const strings = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
	return strings.length > 0 ? strings : undefined;
}

function shouldResolveAgainstBaseDir(pattern: string): boolean {
	return pattern.startsWith("./") || pattern.startsWith("../");
}

function normalizePattern(pattern: string, baseDir: string | undefined): string {
	const trimmed = pattern.trim();
	if (!baseDir || !shouldResolveAgainstBaseDir(trimmed)) return trimmed;
	return resolvePath(trimmed, baseDir, { trim: true });
}

function normalizeStringArray(value: unknown, baseDir: string | undefined): string[] | undefined {
	const strings = asStringArray(value);
	if (!strings) return undefined;
	return strings.map((pattern) => normalizePattern(pattern, baseDir));
}

function normalizeResourceProfileSettings(value: unknown, baseDir: string | undefined): ResourceProfileSettings {
	if (!isRecord(value)) {
		throw new Error("resources must be an object");
	}
	const result: ResourceProfileSettings = {};
	for (const kind of RESOURCE_PROFILE_KINDS) {
		const filterValue = value[kind];
		if (filterValue === undefined) continue;
		if (!isRecord(filterValue)) {
			throw new Error(`${kind} filter must be an object`);
		}
		const allow = normalizeStringArray(filterValue.allow, baseDir);
		const block = normalizeStringArray(filterValue.block, baseDir);
		result[kind] = { allow, block };
	}
	return result;
}

function validateProfileName(name: string): string[] {
	return validateSkillName(name);
}

function normalizeThinking(value: unknown): ThinkingLevel | undefined {
	const thinking = asNonEmptyString(value);
	if (!thinking) return undefined;
	if (!isValidThinkingLevel(thinking)) {
		throw new Error(`thinking must be one of off, minimal, low, medium, high, xhigh`);
	}
	return thinking;
}

function normalizeWrapperProfile(options: {
	value: unknown;
	source: ProfileSource;
	sourcePath?: string;
	baseDir?: string;
	fallbackName?: string;
}): NormalizedProfile {
	if (!isRecord(options.value)) {
		throw new Error("profile JSON must be an object");
	}
	const name = asNonEmptyString(options.value.name) ?? options.fallbackName;
	if (!name) {
		throw new Error("profile name is required");
	}
	const nameErrors = validateProfileName(name);
	if (nameErrors.length > 0) {
		throw new Error(`invalid profile name "${name}": ${nameErrors.join(", ")}`);
	}
	const resources = normalizeResourceProfileSettings(options.value.resources ?? {}, options.baseDir);
	const description = asNonEmptyString(options.value.description);
	const model = asNonEmptyString(options.value.model);
	const thinking = normalizeThinking(options.value.thinking);
	return {
		name,
		description,
		model,
		thinking,
		resources,
		source: options.source,
		sourcePath: options.sourcePath,
		baseDir: options.baseDir,
	};
}

function normalizeSettingsProfiles(
	settings: Settings,
	source: ProfileSource,
): Array<Omit<NormalizedProfile, "source"> & { source?: ProfileSource }> {
	const profiles: Array<Omit<NormalizedProfile, "source"> & { source?: ProfileSource }> = [];
	for (const [name, resources] of Object.entries(settings.resourceProfiles ?? {})) {
		const nameErrors = validateProfileName(name);
		if (nameErrors.length > 0) continue;
		profiles.push({ name, resources: mergeResourceProfileSettings(undefined, resources) });
	}
	return profiles.map((profile) => ({ ...profile, source }));
}

function normalizeDefinitions(
	definitions: Record<string, ResourceProfileSettings>,
	source: ProfileSource,
): NormalizedProfile[] {
	const profiles: NormalizedProfile[] = [];
	for (const [name, resources] of Object.entries(definitions)) {
		const nameErrors = validateProfileName(name);
		if (nameErrors.length > 0) continue;
		profiles.push({ name, resources: mergeResourceProfileSettings(undefined, resources), source });
	}
	return profiles;
}

export class ProfileRegistry {
	private options: ProfileRegistryOptions;
	private diagnostics: ProfileRegistryDiagnostic[] = [];

	constructor(options: ProfileRegistryOptions) {
		this.options = options;
	}

	listDiagnostics(): ProfileRegistryDiagnostic[] {
		this.collectCandidates();
		return [...this.diagnostics];
	}

	listProfiles(): NormalizedProfile[] {
		const candidates = this.collectCandidates();
		const winners = new Map<string, ProfileCandidate>();
		for (const candidate of candidates) {
			const existing = winners.get(candidate.profile.name);
			if (
				!existing ||
				candidate.precedence < existing.precedence ||
				(candidate.precedence === existing.precedence && candidate.order < existing.order)
			) {
				winners.set(candidate.profile.name, candidate);
			}
		}
		return Array.from(winners.values())
			.sort((a, b) => a.profile.name.localeCompare(b.profile.name))
			.map((candidate) => candidate.profile);
	}

	getProfile(name: string): NormalizedProfile | undefined {
		const trimmed = name.trim();
		if (!trimmed) return undefined;
		return this.listProfiles().find((profile) => profile.name === trimmed);
	}

	resolveProfileRef(ref: string, fromDir: string): NormalizedProfile | undefined {
		const trimmed = ref.trim();
		if (!trimmed) return undefined;
		if (trimmed.startsWith("./") || trimmed.startsWith("../")) {
			const sourcePath = resolvePath(trimmed, fromDir, { trim: true });
			return this.loadProfileFile(sourcePath, "profile-file", 0)?.profile;
		}
		return this.getProfile(trimmed);
	}

	private collectCandidates(): ProfileCandidate[] {
		this.diagnostics = [];
		const candidates: ProfileCandidate[] = [];
		let order = 0;
		const add = (profile: NormalizedProfile, precedence: number): void => {
			candidates.push({ profile, precedence, order: order++ });
		};

		for (const profile of normalizeDefinitions(this.options.inlineResourceProfileDefinitions, "inline")) {
			add(profile, 1);
		}
		for (const profile of normalizeSettingsProfiles(this.options.directoryProfileSettings, "directory-overlay")) {
			add({ ...profile, source: "directory-overlay" }, 2);
		}
		for (const profile of normalizeSettingsProfiles(this.options.projectSettings, "project-settings")) {
			add({ ...profile, source: "project-settings" }, 3);
		}
		for (const profile of this.loadProfileFiles()) {
			add(profile.profile, profile.precedence);
		}
		for (const profile of normalizeSettingsProfiles(this.options.globalSettings, "global-settings")) {
			add({ ...profile, source: "global-settings" }, 5);
		}
		for (const profile of normalizeDefinitions(this.options.discoveredResourceProfileDefinitions, "embedded")) {
			add(profile, 6);
		}

		return candidates;
	}

	private loadProfileFiles(): ProfileCandidate[] {
		const candidates: ProfileCandidate[] = [];
		let order = 0;

		const profilesDir = this.options.profilesDir;
		if (profilesDir && existsSync(profilesDir)) {
			try {
				const entries = readdirSync(profilesDir)
					.filter((entry) => entry.endsWith(".json"))
					.sort();
				for (const entry of entries) {
					const sourcePath = join(profilesDir, entry);
					const loaded = this.loadProfileFile(sourcePath, "profile-file", order++);
					if (loaded) {
						candidates.push({ ...loaded, precedence: 4 });
					}
				}
			} catch (error) {
				this.diagnostics.push({ source: "profile-file", path: profilesDir, message: String(error) });
			}
		}

		const externalRoots = this.options.externalResourceRoots ?? [];
		for (const root of externalRoots) {
			const extProfilesDir = join(root, "profiles");
			if (existsSync(extProfilesDir)) {
				try {
					const entries = readdirSync(extProfilesDir)
						.filter((entry) => entry.endsWith(".json"))
						.sort();
					for (const entry of entries) {
						const sourcePath = join(extProfilesDir, entry);
						const loaded = this.loadProfileFile(sourcePath, "profile-file", order++);
						if (loaded) {
							candidates.push({ ...loaded, precedence: 4.1 });
						}
					}
				} catch (error) {
					this.diagnostics.push({ source: "profile-file", path: extProfilesDir, message: String(error) });
				}
			}
		}

		return candidates;
	}

	private loadProfileFile(sourcePath: string, source: ProfileSource, order: number): ProfileCandidate | undefined {
		try {
			const stats = statSync(sourcePath);
			if (!stats.isFile()) return undefined;
			const parsed = JSON.parse(readFileSync(sourcePath, "utf-8"));
			const fallbackName = basename(sourcePath, ".json");
			return {
				profile: normalizeWrapperProfile({
					value: parsed,
					source,
					sourcePath: resolve(sourcePath),
					baseDir: dirname(resolve(sourcePath)),
					fallbackName,
				}),
				precedence: 0,
				order,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.diagnostics.push({ source, path: sourcePath, message });
			return undefined;
		}
	}
}
