import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomicSync } from "../util/atomic-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import { projectPipelineRunsDir } from "./discover.ts";
import {
	clonePipelineRun,
	isPipelineRun,
	type PipelineDefinition,
	type PipelineRun,
	type PipelineStage,
	type StageDiskStatus,
	type StageScan,
} from "./types.ts";

export const RUN_MANIFEST_NAME = "run.json";

function isRealOutputFile(name: string): boolean {
	return name !== ".gitkeep" && name !== ".DS_Store" && !name.startsWith(".");
}

function collectOutputFiles(dir: string, relativePrefix = ""): string[] {
	const results: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (!isRealOutputFile(entry)) continue;
		const fullPath = join(dir, entry);
		const relPath = relativePrefix ? `${relativePrefix}/${entry}` : entry;
		try {
			const stat = statSync(fullPath);
			if (stat.isFile()) {
				results.push(relPath);
			} else if (stat.isDirectory()) {
				results.push(...collectOutputFiles(fullPath, relPath));
			}
		} catch {
			// Ignore unreadable entries
		}
	}
	return results;
}

export function scanStageOutput(outputDir: string): { status: StageDiskStatus; outputFiles: string[] } {
	if (!existsSync(outputDir)) return { status: "empty", outputFiles: [] };
	try {
		const outputFiles = collectOutputFiles(outputDir).sort();
		return { status: outputFiles.length > 0 ? "complete" : "empty", outputFiles };
	} catch {
		return { status: "empty", outputFiles: [] };
	}
}

export function stageOutputDir(runRoot: string, stage: PipelineStage): string {
	return join(runRoot, stage.folderName, "output");
}

export function scanPipelineRun(definition: PipelineDefinition, run: PipelineRun): readonly StageScan[] {
	return definition.stages.map((stage) => {
		const scanned = scanStageOutput(stageOutputDir(run.runRoot, stage));
		return { stageId: stage.id, status: scanned.status, outputFiles: scanned.outputFiles };
	});
}

export function runManifestPath(runRoot: string): string {
	return join(runRoot, RUN_MANIFEST_NAME);
}

export function parsePipelineRun(value: unknown): PipelineRun | undefined {
	if (!isPipelineRun(value)) return undefined;
	return clonePipelineRun(value);
}

export function readPipelineRun(runRoot: string): PipelineRun | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(runManifestPath(runRoot), "utf8"));
		const run = parsePipelineRun(parsed);
		if (!run || run.runRoot !== runRoot) return undefined;
		return run;
	} catch {
		return undefined;
	}
}

export function writePipelineRun(run: PipelineRun): void {
	mkdirSync(run.runRoot, { recursive: true });
	writeFileAtomicSync(runManifestPath(run.runRoot), `${JSON.stringify(run, null, 2)}\n`);
}

export function createPipelineRunRoot(cwd: string, runId: string): string {
	return join(projectPipelineRunsDir(cwd), runId);
}

export function instantiatePipelineRun(args: {
	definition: PipelineDefinition;
	runId: string;
	runRoot: string;
	goalId?: string;
	now: string;
}): PipelineRun {
	const first = args.definition.stages[0];
	if (!first) throw new Error("Pipeline definition has no stages.");
	for (const stage of args.definition.stages) {
		mkdirSync(stageOutputDir(args.runRoot, stage), { recursive: true });
	}
	const run: PipelineRun = {
		version: 1,
		revision: 1,
		runId: args.runId,
		pipelineName: args.definition.name,
		definitionPath: args.definition.rootDir,
		runRoot: args.runRoot,
		currentStageId: first.id,
		status: "active",
		goalId: args.goalId,
		createdAt: args.now,
		updatedAt: args.now,
	};
	writePipelineRun(run);
	return run;
}

export function persistPipelineRun(run: PipelineRun, now: string): PipelineRun {
	const next = { ...run, revision: run.revision + 1, updatedAt: now };
	writePipelineRun(next);
	return next;
}

export function findActivePipelineRun(cwd: string): PipelineRun | undefined {
	const root = projectPipelineRunsDir(cwd);
	if (!existsSync(root)) return undefined;
	let latest: PipelineRun | undefined;
	try {
		for (const name of readdirSync(root)) {
			const run = readPipelineRun(join(root, name));
			if (!run || run.status !== "active") continue;
			if (!latest || run.updatedAt > latest.updatedAt) latest = run;
		}
	} catch {
		return latest;
	}
	return latest;
}

export function loadPipelineRunById(cwd: string, runId: string): PipelineRun | undefined {
	const trimmed = runId.trim();
	if (!trimmed) return undefined;
	const fromDisk = readPipelineRun(join(projectPipelineRunsDir(cwd), trimmed));
	if (fromDisk) return fromDisk;
	const active = findActivePipelineRun(cwd);
	return active?.runId === trimmed ? active : undefined;
}

export function decodePipelineRunPayload(data: unknown): PipelineRun | undefined {
	if (!isPlainRecord(data)) return undefined;
	const value = data.run ?? data;
	return parsePipelineRun(value);
}

export function pipelineRunParentDir(runRoot: string): string {
	return dirname(runRoot);
}
