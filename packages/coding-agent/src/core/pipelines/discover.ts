import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parseStageContract, parseWorkspaceFrontmatter } from "./parse-contract.ts";
import {
	MAX_PIPELINE_NAME_LENGTH,
	MAX_PIPELINE_STAGES,
	PIPELINE_STAGE_FOLDER_RE,
	type PipelineDefinition,
	type PipelineStage,
} from "./types.ts";

const ENTRY_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
const ROUTING_FILE = "CONTEXT.md";
const CONTRACT_FILE = "CONTEXT.md";
const FACTORY_DIRS = ["_shared", "references"] as const;

export function projectPipelinesDir(cwd: string): string {
	return join(cwd, ".pi", "pipelines");
}

export function projectPipelineRunsDir(cwd: string): string {
	return join(cwd, ".pi", "pipeline-runs");
}

export interface DiscoverPipelineOptions {
	agentPipelinesDir: string;
	cwd: string;
}

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function listDirs(path: string): string[] {
	if (!isDir(path)) return [];
	try {
		return readdirSync(path, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

function pickEntryFile(rootDir: string): string | undefined {
	for (const name of ENTRY_FILES) {
		const path = join(rootDir, name);
		if (existsSync(path)) return path;
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

function loadStage(stagesDir: string, folderName: string): PipelineStage | undefined {
	const parsed = parseStageFolder(folderName);
	if (!parsed) return undefined;
	const contractPath = join(stagesDir, folderName, CONTRACT_FILE);
	const content = readText(contractPath);
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
		const stage = loadStage(stagesDir, name);
		if (stage) stages.push(stage);
		if (stages.length >= MAX_PIPELINE_STAGES) break;
	}
	stages.sort((left, right) => left.ordinal - right.ordinal || left.slug.localeCompare(right.slug));
	return { stagesDir, stages };
}

export function loadPipelineDefinition(rootDir: string): PipelineDefinition | undefined {
	if (!isDir(rootDir)) return undefined;
	const { stagesDir, stages } = collectStages(rootDir);
	if (stages.length === 0) return undefined;
	const routingPath = join(rootDir, ROUTING_FILE);
	const routing = readText(routingPath);
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
		routingPath: existsSync(routingPath) ? routingPath : entryFile,
		factoryDir: pickFactoryDir(rootDir),
		stagesDir,
		stages,
	};
}

export function discoverPipelineDefinitions(options: DiscoverPipelineOptions): PipelineDefinition[] {
	const roots = [options.agentPipelinesDir, projectPipelinesDir(options.cwd)];
	const seen = new Set<string>();
	const definitions: PipelineDefinition[] = [];
	for (const root of roots) {
		for (const name of listDirs(root)) {
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
