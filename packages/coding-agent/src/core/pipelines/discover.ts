import { lstatSync } from "node:fs";
import { basename, join } from "node:path";
import { canonicalPathScopeIdentity, isPathWithinScope, safeRealpathSync } from "../autonomy/path-scope.ts";
import { readBoundedDirectoryNamesSync, readBoundedTextFileSync } from "../util/bounded-file.ts";
import { parseStageContract, parseWorkspaceFrontmatter } from "./parse-contract.ts";
import {
	MAX_PIPELINE_NAME_LENGTH,
	MAX_PIPELINE_STAGES,
	PIPELINE_STAGE_FOLDER_RE,
	type PipelineDefinition,
	type PipelineRun,
	type PipelineStage,
} from "./types.ts";

const ENTRY_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
const ROUTING_FILE = "CONTEXT.md";
const CONTRACT_FILE = "CONTEXT.md";
const FACTORY_DIRS = ["_shared", "references"] as const;
const MAX_PIPELINE_DEFINITION_FILE_BYTES = 64 * 1024;
const MAX_PIPELINE_DIRECTORY_ENTRIES = 1_024;
const MAX_PIPELINE_DEFINITIONS = 64;

export function projectPipelinesDir(cwd: string): string {
	return join(cwd, ".pi", "pipelines");
}

export function projectPipelineRunsDir(cwd: string): string {
	return join(cwd, ".pi", "pipeline-runs");
}

/** Validate one project-owned pipeline storage root without following a managed symlink first. */
export function assertProjectPipelineDirectory(cwd: string, name: "pipelines" | "pipeline-runs"): string {
	const piRoot = join(cwd, ".pi");
	const directory = join(piRoot, name);
	for (const [path, label] of [
		[piRoot, "Project .pi path"],
		[directory, `Project ${name} path`],
	] as const) {
		let stats: ReturnType<typeof lstatSync>;
		try {
			stats = lstatSync(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (!stats.isDirectory() || stats.isSymbolicLink()) {
			throw new Error(`${label} is not a real directory: ${path}`);
		}
	}
	if (!isPathWithinScope(safeRealpathSync(directory), safeRealpathSync(cwd))) {
		throw new Error(`Project ${name} directory escapes the working directory.`);
	}
	return directory;
}

export interface DiscoverPipelineOptions {
	agentPipelinesDir: string;
	cwd: string;
}

function readText(path: string, rootDir: string): string | undefined {
	try {
		const stats = lstatSync(path);
		if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_PIPELINE_DEFINITION_FILE_BYTES) {
			return undefined;
		}
		if (!isPathWithinScope(safeRealpathSync(path), safeRealpathSync(rootDir))) return undefined;
		return readBoundedTextFileSync(path, MAX_PIPELINE_DEFINITION_FILE_BYTES, "Pipeline definition file");
	} catch {
		return undefined;
	}
}

function isDir(path: string): boolean {
	try {
		const stats = lstatSync(path);
		return stats.isDirectory() && !stats.isSymbolicLink();
	} catch {
		return false;
	}
}

function listDirs(path: string): string[] {
	if (!isDir(path)) return [];
	try {
		return readBoundedDirectoryNamesSync(path, MAX_PIPELINE_DIRECTORY_ENTRIES, "Pipeline directory")
			.filter((name) => !name.startsWith(".") && isDir(join(path, name)))
			.sort();
	} catch {
		return [];
	}
}

function pickEntryFile(rootDir: string): string | undefined {
	for (const name of ENTRY_FILES) {
		const path = join(rootDir, name);
		if (readText(path, rootDir) !== undefined) return path;
	}
	return undefined;
}

function pickFactoryDir(rootDir: string): string {
	for (const name of FACTORY_DIRS) {
		const path = join(rootDir, name);
		if (isDir(path)) return path;
	}
	return join(rootDir, "_shared");
}

function parseStageFolder(name: string): { ordinal: number; slug: string } | undefined {
	const match = name.match(PIPELINE_STAGE_FOLDER_RE);
	if (!match) return undefined;
	return { ordinal: Number(match[1]), slug: match[2] };
}

function loadStage(rootDir: string, stagesDir: string, folderName: string): PipelineStage | undefined {
	const parsed = parseStageFolder(folderName);
	if (!parsed) return undefined;
	const contractPath = join(stagesDir, folderName, CONTRACT_FILE);
	const content = readText(contractPath, rootDir);
	if (content === undefined) return undefined;
	const contract = parseStageContract(content);
	return {
		id: `${String(parsed.ordinal).padStart(2, "0")}_${parsed.slug}`,
		ordinal: parsed.ordinal,
		slug: parsed.slug,
		folderName,
		contractPath,
		outputDir: join(stagesDir, folderName, "output"),
		contract,
	};
}

function collectStages(rootDir: string): { stagesDir: string; stages: PipelineStage[] } {
	const nested = join(rootDir, "stages");
	const stagesDir =
		isDir(nested) && listDirs(nested).some((name) => PIPELINE_STAGE_FOLDER_RE.test(name)) ? nested : rootDir;
	const stages: PipelineStage[] = [];
	for (const name of listDirs(stagesDir)) {
		const stage = loadStage(rootDir, stagesDir, name);
		if (stage) stages.push(stage);
		if (stages.length >= MAX_PIPELINE_STAGES) break;
	}
	stages.sort((left, right) => left.ordinal - right.ordinal || left.slug.localeCompare(right.slug));
	return { stagesDir, stages };
}

export function loadPipelineDefinition(rootDir: string): PipelineDefinition | undefined {
	try {
		if (!isDir(rootDir)) return undefined;
		const { stagesDir, stages } = collectStages(rootDir);
		if (stages.length === 0) return undefined;
		const routingPath = join(rootDir, ROUTING_FILE);
		const routing = readText(routingPath, rootDir);
		const parsed = routing !== undefined ? parseWorkspaceFrontmatter(routing) : undefined;
		const folderName = basename(rootDir).slice(0, MAX_PIPELINE_NAME_LENGTH);
		const name = (parsed?.name || folderName).slice(0, MAX_PIPELINE_NAME_LENGTH);
		const entryFile = pickEntryFile(rootDir) ?? routingPath;
		return {
			name,
			description: parsed?.description ?? "",
			form: parsed?.form ?? "pipeline",
			rootDir,
			entryFile,
			routingPath: routing !== undefined ? routingPath : entryFile,
			factoryDir: pickFactoryDir(rootDir),
			stagesDir,
			stages,
		};
	} catch {
		return undefined;
	}
}

export function discoverPipelineDefinitions(options: DiscoverPipelineOptions): PipelineDefinition[] {
	let projectRoot: string | undefined;
	try {
		projectRoot = assertProjectPipelineDirectory(options.cwd, "pipelines");
	} catch {
		projectRoot = undefined;
	}
	const roots = [options.agentPipelinesDir, ...(projectRoot ? [projectRoot] : [])];
	const seen = new Set<string>();
	const definitions: PipelineDefinition[] = [];
	for (const root of roots) {
		for (const name of listDirs(root)) {
			if (definitions.length >= MAX_PIPELINE_DEFINITIONS) return definitions;
			const path = join(root, name);
			if (seen.has(path)) continue;
			const definition = loadPipelineDefinition(path);
			if (!definition) continue;
			seen.add(path);
			definitions.push(definition);
		}
	}
	return definitions;
}

export function findPipelineDefinition(options: DiscoverPipelineOptions, name: string): PipelineDefinition | undefined {
	const wanted = name.trim().toLocaleLowerCase();
	if (!wanted) return undefined;
	return discoverPipelineDefinitions(options).find((definition) => definition.name.toLocaleLowerCase() === wanted);
}

/** Resolve a run's immutable definition path, with the normal discovery roots as a move-safe fallback. */
export function resolvePipelineDefinitionForRun(
	options: DiscoverPipelineOptions,
	run: Pick<PipelineRun, "definitionPath" | "pipelineName">,
): PipelineDefinition | undefined {
	const definitions = discoverPipelineDefinitions(options);
	const storedPath = canonicalPathScopeIdentity(run.definitionPath);
	return (
		definitions.find((definition) => canonicalPathScopeIdentity(definition.rootDir) === storedPath) ??
		definitions.find((definition) => definition.name.toLocaleLowerCase() === run.pipelineName.toLocaleLowerCase())
	);
}
