import { lstatSync, mkdirSync, opendirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { assertPortablePathSegment } from "../../utils/work-directory.ts";
import { canonicalPathScopeIdentity, isPathWithinScope, safeRealpathSync } from "../autonomy/path-scope.ts";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { readBoundedDirectoryNamesSync, readBoundedTextFileSync } from "../util/bounded-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import { assertProjectPipelineDirectory } from "./discover.ts";
import {
	clonePipelineRun,
	isPipelineRun,
	isPipelineRunActive,
	type PipelineDefinition,
	type PipelineRun,
	type PipelineStage,
	type StageDiskStatus,
	type StageScan,
} from "./types.ts";

export const RUN_MANIFEST_NAME = "run.json";
const MAX_STAGE_OUTPUT_SCAN_DEPTH = 16;
const MAX_STAGE_OUTPUT_SCAN_ENTRIES = 1000;
const MAX_PIPELINE_RUN_MANIFEST_BYTES = 64 * 1024;
const MAX_PIPELINE_RUN_SCAN_ENTRIES = 1_024;
const PIPELINE_LIFECYCLE_LOCK_NAME = ".lifecycle";

interface StageOutputScanBudget {
	visitedEntries: number;
}

function isRealOutputFile(name: string): boolean {
	return name !== ".gitkeep" && name !== ".DS_Store" && !name.startsWith(".");
}

function collectOutputFiles(
	realBaseDir: string,
	currentDir: string,
	relativePrefix = "",
	depth = 0,
	collected: string[] = [],
	budget: StageOutputScanBudget = { visitedEntries: 0 },
): string[] {
	if (depth > MAX_STAGE_OUTPUT_SCAN_DEPTH || budget.visitedEntries >= MAX_STAGE_OUTPUT_SCAN_ENTRIES) {
		return collected;
	}
	let directory: ReturnType<typeof opendirSync>;
	try {
		directory = opendirSync(currentDir);
	} catch {
		return collected;
	}
	try {
		while (budget.visitedEntries < MAX_STAGE_OUTPUT_SCAN_ENTRIES) {
			const dirent = directory.readSync();
			if (!dirent) break;
			budget.visitedEntries++;
			const entry = dirent.name;
			if (!isRealOutputFile(entry)) continue;
			const fullPath = join(currentDir, entry);
			const relPath = relativePrefix ? `${relativePrefix}/${entry}` : entry;
			try {
				const real = safeRealpathSync(fullPath);
				if (!isPathWithinScope(real, realBaseDir)) continue;
				const lstat = lstatSync(fullPath);
				if (lstat.isSymbolicLink()) {
					const realStat = statSync(real);
					if (realStat.isFile()) collected.push(relPath);
				} else if (lstat.isFile()) {
					collected.push(relPath);
				} else if (lstat.isDirectory()) {
					collectOutputFiles(realBaseDir, fullPath, relPath, depth + 1, collected, budget);
				}
			} catch {
				// Ignore unreadable entries
			}
		}
	} catch {
		return collected;
	} finally {
		try {
			directory.closeSync();
		} catch {
			// The scan result remains valid if the OS already closed the directory handle.
		}
	}
	return collected;
}

export function scanStageOutput(outputDir: string): { status: StageDiskStatus; outputFiles: string[] } {
	try {
		const root = lstatSync(outputDir);
		if (root.isSymbolicLink() || !root.isDirectory()) return { status: "empty", outputFiles: [] };
		const outputFiles = collectOutputFiles(safeRealpathSync(outputDir), outputDir).sort();
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
		const rootStats = lstatSync(runRoot);
		if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) return undefined;
		const manifestPath = runManifestPath(runRoot);
		const manifestStats = lstatSync(manifestPath);
		if (
			!manifestStats.isFile() ||
			manifestStats.isSymbolicLink() ||
			manifestStats.size > MAX_PIPELINE_RUN_MANIFEST_BYTES
		) {
			return undefined;
		}
		const parsed: unknown = JSON.parse(
			readBoundedTextFileSync(manifestPath, MAX_PIPELINE_RUN_MANIFEST_BYTES, "Pipeline run manifest"),
		);
		const run = parsePipelineRun(parsed);
		if (
			!run ||
			canonicalPathScopeIdentity(run.runRoot) !== canonicalPathScopeIdentity(runRoot) ||
			basename(runRoot) !== run.runId
		) {
			return undefined;
		}
		return run;
	} catch {
		return undefined;
	}
}

export function writePipelineRun(run: PipelineRun): void {
	if (!isPipelineRun(run)) throw new Error("Pipeline run state is invalid and was not persisted.");
	assertPortablePathSegment("Pipeline run id", run.runId);
	if (basename(run.runRoot) !== run.runId) {
		throw new Error("Pipeline run root must end with its exact run id.");
	}
	mkdirSync(run.runRoot, { recursive: true });
	const rootStats = lstatSync(run.runRoot);
	if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
		throw new Error(`Pipeline run root is not a real directory: ${run.runRoot}`);
	}
	writeFileAtomicSync(runManifestPath(run.runRoot), `${JSON.stringify(run, null, 2)}\n`);
}

export function createPipelineRunRoot(cwd: string, runId: string): string {
	assertPortablePathSegment("Pipeline run id", runId);
	return join(assertProjectPipelineDirectory(cwd, "pipeline-runs"), runId);
}

/** Serialize project-wide pipeline admission and transitions across sessions and OS processes. */
export function withPipelineLifecycleLock<T>(cwd: string, mutate: () => T): T {
	const runsRoot = assertProjectPipelineDirectory(cwd, "pipeline-runs");
	return withFileLockSync(join(runsRoot, PIPELINE_LIFECYCLE_LOCK_NAME), () => {
		const verifiedRoot = assertProjectPipelineDirectory(cwd, "pipeline-runs");
		if (canonicalPathScopeIdentity(verifiedRoot) !== canonicalPathScopeIdentity(runsRoot)) {
			throw new Error("Project pipeline-runs directory changed during lifecycle lock acquisition.");
		}
		return mutate();
	});
}

/** A restored run may operate only on its exact project-owned run directory. */
export function isProjectPipelineRun(cwd: string, run: PipelineRun): boolean {
	try {
		const expectedRoot = createPipelineRunRoot(cwd, run.runId);
		if (canonicalPathScopeIdentity(run.runRoot) !== canonicalPathScopeIdentity(expectedRoot)) return false;
		const rootStats = lstatSync(expectedRoot);
		return rootStats.isDirectory() && !rootStats.isSymbolicLink();
	} catch {
		return false;
	}
}

/** Resolve the exact validated durable manifest for a project-owned session snapshot. */
export function resolveProjectPipelineRun(cwd: string, run: PipelineRun): PipelineRun | undefined {
	if (!isProjectPipelineRun(cwd, run)) return undefined;
	return readPipelineRun(createPipelineRunRoot(cwd, run.runId));
}

/** Resolve the durable project-wide current run, using a session snapshot only as an identity hint. */
export function resolveCurrentProjectPipelineRun(cwd: string, snapshot?: PipelineRun): PipelineRun | undefined {
	const durableSnapshot = snapshot ? resolveProjectPipelineRun(cwd, snapshot) : undefined;
	return findActivePipelineRun(cwd) ?? durableSnapshot;
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
	let root: string;
	try {
		root = assertProjectPipelineDirectory(cwd, "pipeline-runs");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	let names: string[];
	try {
		names = readBoundedDirectoryNamesSync(root, MAX_PIPELINE_RUN_SCAN_ENTRIES, "Pipeline run directory");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	let active: PipelineRun | undefined;
	for (const name of names) {
		if (name.startsWith(".")) continue;
		const run = readPipelineRun(join(root, name));
		if (!run) {
			throw new Error(`Pipeline run directory contains an invalid managed entry: ${name}`);
		}
		if (!isPipelineRunActive(run)) continue;
		if (active) {
			throw new Error(`Pipeline run directory contains multiple active runs: ${active.runId}, ${run.runId}`);
		}
		active = run;
	}
	return active;
}

export function loadPipelineRunById(cwd: string, runId: string): PipelineRun | undefined {
	const trimmed = runId.trim();
	if (!trimmed) return undefined;
	let runRoot: string;
	try {
		runRoot = createPipelineRunRoot(cwd, trimmed);
	} catch {
		return undefined;
	}
	return readPipelineRun(runRoot);
}

export function decodePipelineRunPayload(data: unknown): PipelineRun | undefined {
	if (!isPlainRecord(data)) return undefined;
	const value = data.run ?? data;
	return parsePipelineRun(value);
}

export function pipelineRunParentDir(runRoot: string): string {
	return dirname(runRoot);
}
