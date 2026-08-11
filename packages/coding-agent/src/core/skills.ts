import type { ThinkingLevel } from "@caupulican/pi-agent-core";
import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import { isResourcePathWithin } from "./resource-traversal.ts";
import { discoverSkillFiles } from "./skill-discovery.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import { sameFileVersion } from "./util/bounded-file.ts";

/** Discovery retains only this bounded metadata prefix, never the whole skill body. */
export const MAX_SKILL_FRONTMATTER_BYTES = 16 * 1024;
const SKILL_FRONTMATTER_READ_CHUNK_BYTES = 1024;

const MAX_NAME_LENGTH = 64;

/** Max description length per spec */
const MAX_DESCRIPTION_LENGTH = 1024;

// Kept local rather than imported from settings-manager.ts's ThinkingLevel validation: that module
// already imports validateSkillName FROM this file, so importing back would cycle. The literal set
// is small and stable (mirrors settings-manager.ts's own VALID_THINKING_LEVELS).
const VALID_SKILL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
function isSkillThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (VALID_SKILL_THINKING_LEVELS as readonly string[]).includes(value);
}

export interface SkillFrontmatter {
	name?: string;
	description?: string;
	"disable-model-invocation"?: boolean;
	/** Optional thinking-level hint (R1 follow-up); see Skill.thinking. */
	thinking?: string;
	/** Reflection-generated skill marker used by the curator. */
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
	/**
	 * Optional thinking-level hint parsed from frontmatter (R1 follow-up: skill-surfaced thinking
	 * governance, alongside resource-profile thinking). Core only parses and surfaces this value —
	 * nothing in pi-adaptative core applies it to a session's thinking level yet. Unlike an active
	 * resource profile (a persistent "situation", see settings-manager.ts's activeResourceProfile)
	 * or a routed turn (bracketed by a try/finally swap/restore, see agent-session.ts's
	 * _runAgentPromptWithModelRouter), a skill has no session-lifecycle hook marking when it starts
	 * or stops governing a turn, so applying this is left to the consumer (e.g. a skill-router
	 * extension) via the existing ctx.setThinkingLevel() extension API.
	 */
	thinking?: ThinkingLevel;
}

export interface LoadSkillsResult {
	skills: Skill[];
	diagnostics: ResourceDiagnostic[];
}

/**
 * Validate skill name per Agent Skills spec.
 * Returns array of validation error messages (empty if valid).
 */
export function validateSkillName(name: string): string[] {
	const errors: string[] = [];

	if (name.length > MAX_NAME_LENGTH) {
		errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
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

/**
 * Validate description per Agent Skills spec.
 */
function validateDescription(description: string | undefined): string[] {
	const errors: string[] = [];

	if (!description || description.trim() === "") {
		errors.push("description is required");
	} else if (description.length > MAX_DESCRIPTION_LENGTH) {
		errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
	}

	return errors;
}

export interface LoadSkillsFromDirOptions {
	/** Directory to scan for skills */
	dir: string;
	/** Source identifier for these skills */
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

/**
 * Read one stable, bounded frontmatter prefix. The closing delimiter ends the read, so discovery
 * cost depends on metadata size, never body size. Unterminated metadata fails at the explicit cap.
 */
export function readSkillFrontmatterFile(filePath: string): string {
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
			const prefix = Buffer.concat(chunks, totalBytes).toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
			const hasOpeningDelimiter = prefix.length >= 3 && prefix.startsWith("---");
			const closingDelimiter = hasOpeningDelimiter ? prefix.indexOf("\n---", 3) : -1;
			if (!hasOpeningDelimiter || closingDelimiter !== -1 || bytesRead === 0) {
				const after = fstatSync(fileDescriptor);
				if (!sameFileVersion(before, after)) throw new Error("Skill changed while metadata was being read.");
				return closingDelimiter === -1 ? prefix : prefix.slice(0, closingDelimiter + 4);
			}
		}
		throw new Error(`Skill frontmatter exceeds ${MAX_SKILL_FRONTMATTER_BYTES} bytes or is unterminated.`);
	} finally {
		closeSync(fileDescriptor);
	}
}

/**
 * Load skills from a directory.
 *
 * Discovery rules:
 * - if a directory contains SKILL.md, treat it as a skill root and do not recurse further
 * - otherwise, load direct .md children in the root
 * - recurse into subdirectories to find SKILL.md
 */
export function loadSkillsFromDir(options: LoadSkillsFromDirOptions): LoadSkillsResult {
	const { dir, source } = options;
	return loadSkillsFromDirInternal(dir, source, options.isPathAllowed);
}

function loadSkillsFromDirInternal(
	dir: string,
	source: string,
	isPathAllowed?: (path: string) => boolean,
): LoadSkillsResult {
	const skills: Skill[] = [];
	const diagnostics: ResourceDiagnostic[] = [];
	for (const filePath of discoverSkillFiles(dir, "pi")) {
		// Profile UAC: denied skill contents are never read from disk.
		if (isPathAllowed && !isPathAllowed(filePath)) continue;
		const result = loadSkillFromFile(filePath, source);
		if (result.skill) skills.push(result.skill);
		diagnostics.push(...result.diagnostics);
	}

	return { skills, diagnostics };
}

function loadSkillFromFile(
	filePath: string,
	source: string,
): { skill: Skill | null; diagnostics: ResourceDiagnostic[] } {
	const diagnostics: ResourceDiagnostic[] = [];

	try {
		const { frontmatter } = parseFrontmatter<SkillFrontmatter>(readSkillFrontmatterFile(filePath));
		const skillDir = dirname(filePath);
		const parentDirName = basename(skillDir);

		// Validate description
		const descErrors = validateDescription(frontmatter.description);
		for (const error of descErrors) {
			diagnostics.push({ type: "warning", message: error, path: filePath });
		}

		// Use name from frontmatter, or fall back to parent directory name
		const name = frontmatter.name || parentDirName;

		// Validate name
		const nameErrors = validateSkillName(name);
		for (const error of nameErrors) {
			diagnostics.push({ type: "warning", message: error, path: filePath });
		}

		// Still load the skill even with warnings (unless description is completely missing)
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
				thinking: isSkillThinkingLevel(frontmatter.thinking) ? frontmatter.thinking : undefined,
			},
			diagnostics,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed to parse skill file";
		diagnostics.push({ type: "warning", message, path: filePath });
		return { skill: null, diagnostics };
	}
}

export interface LoadSkillsOptions {
	/** Working directory for project-local skills. */
	cwd: string;
	/** Agent config directory for global skills. */
	agentDir: string;
	/** Explicit skill paths (files or directories) */
	skillPaths: string[];
	/** Include default skills directories. */
	includeDefaults: boolean;
	/** Profile UAC gate: when provided, files it denies are never read from disk. */
	isPathAllowed?: (path: string) => boolean;
}

/**
 * Load skills from all configured locations.
 * Returns skills and any validation diagnostics.
 */
export function loadSkills(options: LoadSkillsOptions): LoadSkillsResult {
	const { agentDir, skillPaths, includeDefaults } = options;

	// Resolve agentDir - if not provided, use default from config
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(agentDir ?? getAgentDir());

	const skillMap = new Map<string, Skill>();
	const realPathSet = new Set<string>();
	const allDiagnostics: ResourceDiagnostic[] = [];
	const collisionDiagnostics: ResourceDiagnostic[] = [];

	function addSkills(result: LoadSkillsResult) {
		allDiagnostics.push(...result.diagnostics);
		for (const skill of result.skills) {
			// Resolve symlinks to detect duplicate files
			const realPath = canonicalizePath(skill.filePath);

			// Skip silently if we've already loaded this exact file (via symlink)
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
		addSkills(loadSkillsFromDirInternal(join(resolvedAgentDir, "skills"), "user", options.isPathAllowed));
		addSkills(
			loadSkillsFromDirInternal(resolve(resolvedCwd, CONFIG_DIR_NAME, "skills"), "project", options.isPathAllowed),
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
				addSkills(loadSkillsFromDirInternal(resolvedPath, source, options.isPathAllowed));
			} else if (stats.isFile() && resolvedPath.endsWith(".md")) {
				// Profile UAC: a denied skill file is never read from disk.
				if (options.isPathAllowed && !options.isPathAllowed(resolvedPath)) {
					continue;
				}
				const result = loadSkillFromFile(resolvedPath, source);
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
