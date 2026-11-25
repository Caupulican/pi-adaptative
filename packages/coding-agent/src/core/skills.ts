import { closeSync, existsSync, fstatSync, openSync, readSync, type Stats, statSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import type { ThinkingLevel } from "../kernel/index.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import { isResourcePathWithin } from "./resource-traversal.ts";
import { isWorkerSession } from "./session-role.ts";
import { discoverSkillFiles } from "./skill-discovery.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import { isValidThinkingLevel } from "./thinking-level.ts";
import { sameFileVersion } from "./util/bounded-file.ts";

export const MAX_SKILL_FRONTMATTER_BYTES = 16 * 1024;
export const MAX_ACTIVE_SKILL_BODY_BYTES = 64 * 1024;
const SKILL_FRONTMATTER_READ_CHUNK_BYTES = 1024;

export const MAX_SKILL_NAME_LENGTH = 64;

export const MAX_SKILL_DESCRIPTION_LENGTH = 1024;

export const SKILL_EFFECTS = ["external-write", "network", "external-binary", "secret"] as const;
export type SkillEffect = (typeof SKILL_EFFECTS)[number];

function isSkillEffect(value: unknown): value is SkillEffect {
	return typeof value === "string" && (SKILL_EFFECTS as readonly string[]).includes(value);
}

function parseSkillEffects(value: unknown): { effects: SkillEffect[]; unknown: string[] } {
	const names = Array.isArray(value)
		? value.map((entry) => String(entry).trim())
		: typeof value === "string"
			? value.split(",").map((entry) => entry.trim())
			: [];
	const wanted = names.filter((name) => name.length > 0);
	return {
		effects: [...new Set(wanted.filter(isSkillEffect))],
		unknown: wanted.filter((name) => !isSkillEffect(name)),
	};
}

export const MAX_SKILL_PATH_PATTERNS = 16;
export const MAX_SKILL_PATH_PATTERN_LENGTH = 200;

function skillPathPatternProblem(pattern: string): string | undefined {
	if (pattern.length > MAX_SKILL_PATH_PATTERN_LENGTH) {
		return `longer than ${MAX_SKILL_PATH_PATTERN_LENGTH} characters`;
	}
	if (pattern.includes("\0")) return "contains a NUL character";
	if (pattern.startsWith("!")) return "negation is not supported";
	if (pattern.startsWith("/") || /^[A-Za-z]:[\\/]/.test(pattern)) {
		return "must be relative to the working directory";
	}
	return undefined;
}

function parseSkillPaths(value: unknown): { paths: string[]; rejected: Array<{ pattern: string; reason: string }> } {
	const names: string[] = [];
	if (Array.isArray(value)) {
		for (const entry of value) names.push(String(entry).trim());
	} else if (typeof value === "string") {
		let depth = 0;
		let start = 0;
		for (let index = 0; index <= value.length; index++) {
			const char = value[index];
			if (char === "{") depth++;
			else if (char === "}" && depth > 0) depth--;
			if (index === value.length || (char === "," && depth === 0)) {
				names.push(value.slice(start, index).trim());
				start = index + 1;
			}
		}
	}
	const paths: string[] = [];
	const rejected: Array<{ pattern: string; reason: string }> = [];
	for (const pattern of new Set(names.filter((name) => name.length > 0))) {
		const problem = skillPathPatternProblem(pattern);
		if (problem !== undefined) rejected.push({ pattern: pattern.slice(0, 80), reason: problem });
		else if (paths.length >= MAX_SKILL_PATH_PATTERNS) {
			rejected.push({ pattern: pattern.slice(0, 80), reason: `more than ${MAX_SKILL_PATH_PATTERNS} patterns` });
		} else paths.push(pattern);
	}
	return { paths, rejected };
}

export interface SkillFrontmatter {
	name?: string;
	description?: string;
	effects?: unknown;
	paths?: unknown;
	"disable-model-invocation"?: boolean;
	thinking?: string;
	promoted?: boolean;
	[key: string]: unknown;
}

export interface Skill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	sourceInfo: SourceInfo;
	disableModelInvocation: boolean;
	promoted?: boolean;
	/** Declared effects beyond the working tree; absent or empty means none. */
	effects?: readonly SkillEffect[];
	/**
	 * Working-tree globs the skill is for (frontmatter `paths`). Search ranks the skill higher and marks it
	 * when the session's recent file work matches one; it is never loaded or applied because of a match.
	 */
	paths?: readonly string[];
	thinking?: ThinkingLevel;
}

export function isWorkerEligibleSkill(skill: { effects?: readonly SkillEffect[] }): boolean {
	return (skill.effects?.length ?? 0) === 0;
}

export function workerEligibleSkills<T extends { effects?: readonly SkillEffect[] }>(skills: readonly T[]): T[] {
	return skills.filter(isWorkerEligibleSkill);
}

export function skillsForSessionRole<T extends { effects?: readonly SkillEffect[] }>(
	skills: readonly T[],
): readonly T[] {
	return isWorkerSession() ? workerEligibleSkills(skills) : skills;
}

export interface LoadSkillsResult {
	skills: Skill[];
	diagnostics: ResourceDiagnostic[];
}

export function validateSkillName(name: string): string[] {
	const errors: string[] = [];

	if (name.length > MAX_SKILL_NAME_LENGTH) {
		errors.push(`name exceeds ${MAX_SKILL_NAME_LENGTH} characters (${name.length})`);
	}

	if (!/^[a-z0-9-]+$/.test(name)) {
		errors.push(`name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)`);
	}

	if (name.startsWith("-") || name.endsWith("-")) {
		errors.push(`name must not start or end with a hyphen`);
	}

	if (name.includes("--")) {
		errors.push(`name must not contain consecutive hyphens`);
	}

	return errors;
}

function validateDescription(description: string | undefined): string[] {
	const errors: string[] = [];

	if (!description || description.trim() === "") {
		errors.push("description is required");
	} else if (description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
		errors.push(`description exceeds ${MAX_SKILL_DESCRIPTION_LENGTH} characters (${description.length})`);
	}

	return errors;
}

export interface LoadSkillsFromDirOptions {
	dir: string;
	source: string;
	/** Profile UAC gate: when provided, files it denies are never read from disk. */
	isPathAllowed?: (path: string) => boolean;
}

function createSkillSourceInfo(filePath: string, baseDir: string, source: string): SourceInfo {
	switch (source) {
		case "user":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				scope: "user",
				baseDir,
			});
		case "project":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				scope: "project",
				baseDir,
			});
		case "path":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				baseDir,
			});
		default:
			return createSyntheticSourceInfo(filePath, { source, baseDir });
	}
}

interface SkillFrontmatterFile {
	readonly text: string;
	readonly version: Stats;
}

export function readSkillFrontmatterFile(filePath: string): string {
	return readSkillFrontmatterSnapshot(filePath).text;
}

function readSkillFrontmatterSnapshot(filePath: string): SkillFrontmatterFile {
	const fileDescriptor = openSync(filePath, "r");
	try {
		const before = fstatSync(fileDescriptor);
		if (!before.isFile()) throw new Error("Skill is not a regular file.");
		const chunks: Buffer[] = [];
		let totalBytes = 0;
		while (totalBytes < MAX_SKILL_FRONTMATTER_BYTES) {
			const chunk = Buffer.allocUnsafe(
				Math.min(SKILL_FRONTMATTER_READ_CHUNK_BYTES, MAX_SKILL_FRONTMATTER_BYTES - totalBytes),
			);
			const bytesRead = readSync(fileDescriptor, chunk, 0, chunk.length, totalBytes);
			if (bytesRead > 0) {
				chunks.push(chunk.subarray(0, bytesRead));
				totalBytes += bytesRead;
			}
			const rawText = Buffer.concat(chunks, totalBytes).toString("utf8");
			const prefix = stripBom(rawText).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
			const hasOpeningDelimiter = prefix.length >= 3 && prefix.startsWith("---");
			const closingDelimiter = hasOpeningDelimiter ? prefix.indexOf("\n---", 3) : -1;
			if (!hasOpeningDelimiter || closingDelimiter !== -1 || bytesRead === 0) {
				const after = fstatSync(fileDescriptor);
				if (!sameFileVersion(before, after)) throw new Error("Skill changed while metadata was being read.");
				return { text: closingDelimiter === -1 ? prefix : prefix.slice(0, closingDelimiter + 4), version: after };
			}
		}
		throw new Error(`Skill frontmatter exceeds ${MAX_SKILL_FRONTMATTER_BYTES} bytes or is unterminated.`);
	} finally {
		closeSync(fileDescriptor);
	}
}

const MAX_CACHED_SKILL_HEADERS = 256;
const MAX_CACHED_SKILL_HEADER_CHARS = 256 * 1024;

interface CachedSkillFrontmatter {
	readonly version: Stats;
	readonly frontmatter: SkillFrontmatter;
	readonly chars: number;
}

export class SkillFrontmatterCache {
	private readonly entries = new Map<string, CachedSkillFrontmatter>();
	private chars = 0;

	read(filePath: string): SkillFrontmatter {
		const cached = this.entries.get(filePath);
		if (cached) {
			const current = statSync(filePath, { throwIfNoEntry: false });
			if (current?.isFile() && sameFileVersion(cached.version, current)) {
				this.entries.delete(filePath);
				this.entries.set(filePath, cached);
				return cached.frontmatter;
			}
			this.delete(filePath, cached);
		}
		const { text, version } = readSkillFrontmatterSnapshot(filePath);
		const { frontmatter } = parseFrontmatter<SkillFrontmatter>(text);
		this.entries.set(filePath, { frontmatter, version, chars: text.length });
		this.chars += text.length;
		while (this.entries.size > MAX_CACHED_SKILL_HEADERS || this.chars > MAX_CACHED_SKILL_HEADER_CHARS) {
			const oldest = this.entries.entries().next();
			if (oldest.done) break;
			this.delete(...oldest.value);
		}
		return frontmatter;
	}

	private delete(filePath: string, entry: CachedSkillFrontmatter): void {
		this.entries.delete(filePath);
		this.chars -= entry.chars;
	}
}

export function loadSkillsFromDir(options: LoadSkillsFromDirOptions): LoadSkillsResult {
	const { dir, source } = options;
	return loadSkillsFromDirInternal(dir, source, options.isPathAllowed);
}

function loadSkillsFromDirInternal(
	dir: string,
	source: string,
	isPathAllowed?: (path: string) => boolean,
	frontmatterCache?: SkillFrontmatterCache,
): LoadSkillsResult {
	const skills: Skill[] = [];
	const diagnostics: ResourceDiagnostic[] = [];
	for (const filePath of discoverSkillFiles(dir, "pi")) {
		if (isPathAllowed && !isPathAllowed(filePath)) continue;
		const result = loadSkillFromFile(filePath, source, frontmatterCache);
		if (result.skill) skills.push(result.skill);
		diagnostics.push(...result.diagnostics);
	}

	return { skills, diagnostics };
}

function loadSkillFromFile(
	filePath: string,
	source: string,
	frontmatterCache?: SkillFrontmatterCache,
): { skill: Skill | null; diagnostics: ResourceDiagnostic[] } {
	const diagnostics: ResourceDiagnostic[] = [];
	const isDeclaredSkill = basename(filePath) === "SKILL.md";

	try {
		const frontmatter =
			frontmatterCache?.read(filePath) ??
			parseFrontmatter<SkillFrontmatter>(readSkillFrontmatterFile(filePath)).frontmatter;
		const skillDir = dirname(filePath);
		const parentDirName = basename(skillDir);

		if (!isDeclaredSkill && (!frontmatter.description || frontmatter.description.trim() === "")) {
			return { skill: null, diagnostics: [] };
		}

		const descErrors = validateDescription(frontmatter.description);
		for (const error of descErrors) {
			diagnostics.push({ type: "warning", message: error, path: filePath });
		}

		const fallbackName = isDeclaredSkill ? parentDirName : basename(filePath, ".md");
		const name = frontmatter.name || fallbackName;

		const nameErrors = validateSkillName(name);
		for (const error of nameErrors) {
			diagnostics.push({ type: "warning", message: error, path: filePath });
		}

		const { effects, unknown: unknownEffects } = parseSkillEffects(frontmatter.effects);
		for (const effect of unknownEffects) {
			diagnostics.push({
				type: "warning",
				message: `unknown effect "${effect}" (expected ${SKILL_EFFECTS.join(", ")})`,
				path: filePath,
			});
		}

		const { paths, rejected: rejectedPaths } = parseSkillPaths(frontmatter.paths);
		for (const { pattern, reason } of rejectedPaths) {
			diagnostics.push({ type: "warning", message: `ignored paths entry "${pattern}": ${reason}`, path: filePath });
		}

		if (!frontmatter.description || frontmatter.description.trim() === "") {
			return { skill: null, diagnostics };
		}

		return {
			skill: {
				name,
				description: frontmatter.description,
				filePath,
				baseDir: skillDir,
				sourceInfo: createSkillSourceInfo(filePath, skillDir, source),
				disableModelInvocation: frontmatter["disable-model-invocation"] === true,
				promoted: frontmatter.promoted === true,
				...(effects.length > 0 ? { effects } : {}),
				...(paths.length > 0 ? { paths } : {}),
				thinking: isValidThinkingLevel(frontmatter.thinking) ? frontmatter.thinking : undefined,
			},
			diagnostics,
		};
	} catch (error) {
		if (isDeclaredSkill) {
			const message = error instanceof Error ? error.message : "failed to parse skill file";
			diagnostics.push({ type: "warning", message, path: filePath });
		}
		return { skill: null, diagnostics };
	}
}

export interface LoadSkillsOptions {
	cwd: string;
	agentDir: string;
	skillPaths: string[];
	includeDefaults: boolean;
	includeProjectDefaults?: boolean;
	frontmatterCache?: SkillFrontmatterCache;
	isPathAllowed?: (path: string) => boolean;
}

export function loadSkills(options: LoadSkillsOptions): LoadSkillsResult {
	const { agentDir, skillPaths, includeDefaults } = options;

	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(agentDir ?? getAgentDir());

	const skillMap = new Map<string, Skill>();
	const realPathSet = new Set<string>();
	const allDiagnostics: ResourceDiagnostic[] = [];
	const collisionDiagnostics: ResourceDiagnostic[] = [];

	function addSkills(result: LoadSkillsResult) {
		allDiagnostics.push(...result.diagnostics);
		for (const skill of result.skills) {
			const realPath = canonicalizePath(skill.filePath);

			if (realPathSet.has(realPath)) {
				continue;
			}

			const existing = skillMap.get(skill.name);
			if (existing) {
				collisionDiagnostics.push({
					type: "collision",
					message: `name "${skill.name}" collision`,
					path: skill.filePath,
					collision: {
						resourceType: "skill",
						name: skill.name,
						winnerPath: existing.filePath,
						loserPath: skill.filePath,
					},
				});
			} else {
				skillMap.set(skill.name, skill);
				realPathSet.add(realPath);
			}
		}
	}

	if (includeDefaults) {
		addSkills(
			loadSkillsFromDirInternal(
				join(resolvedAgentDir, "skills"),
				"user",
				options.isPathAllowed,
				options.frontmatterCache,
			),
		);
	}
	if (options.includeProjectDefaults ?? includeDefaults) {
		addSkills(
			loadSkillsFromDirInternal(
				resolve(resolvedCwd, CONFIG_DIR_NAME, "skills"),
				"project",
				options.isPathAllowed,
				options.frontmatterCache,
			),
		);
	}

	const userSkillsDir = join(resolvedAgentDir, "skills");
	const projectSkillsDir = resolve(resolvedCwd, CONFIG_DIR_NAME, "skills");

	const getSource = (resolvedPath: string): "user" | "project" | "path" => {
		if (!includeDefaults) {
			if (isResourcePathWithin(resolvedPath, userSkillsDir)) return "user";
			if (isResourcePathWithin(resolvedPath, projectSkillsDir)) return "project";
		}
		return "path";
	};

	for (const rawPath of skillPaths) {
		const resolvedPath = resolvePath(rawPath, resolvedCwd, { trim: true });
		if (!existsSync(resolvedPath)) {
			allDiagnostics.push({ type: "warning", message: "skill path does not exist", path: resolvedPath });
			continue;
		}

		try {
			const stats = statSync(resolvedPath);
			const source = getSource(resolvedPath);
			if (stats.isDirectory()) {
				addSkills(loadSkillsFromDirInternal(resolvedPath, source, options.isPathAllowed, options.frontmatterCache));
			} else if (stats.isFile() && resolvedPath.endsWith(".md")) {
				if (options.isPathAllowed && !options.isPathAllowed(resolvedPath)) {
					continue;
				}
				const result = loadSkillFromFile(resolvedPath, source, options.frontmatterCache);
				if (result.skill) {
					addSkills({ skills: [result.skill], diagnostics: result.diagnostics });
				} else {
					allDiagnostics.push(...result.diagnostics);
				}
			} else {
				allDiagnostics.push({ type: "warning", message: "skill path is not a markdown file", path: resolvedPath });
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to read skill path";
			allDiagnostics.push({ type: "warning", message, path: resolvedPath });
		}
	}

	return {
		skills: Array.from(skillMap.values()),
		diagnostics: [...allDiagnostics, ...collisionDiagnostics],
	};
}
