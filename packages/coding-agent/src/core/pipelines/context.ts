import { isAbsolute, join, normalize, resolve } from "node:path";
import { isPathWithinScope, safeRealpathSync } from "../autonomy/path-scope.ts";
import { readFilePrefixSync } from "../util/bounded-file.ts";
import {
	type AssembledLayer,
	type AssembledStageContext,
	type ContextLayer,
	isPipelineRunActive,
	MAX_LAYER_FILE_CHARS,
	MAX_STAGE_CONTEXT_CHARS,
	type PipelineDefinition,
	type PipelineRun,
	type PipelineStage,
} from "./types.ts";

const CHARS_PER_TOKEN = 4;

function resolveUnder(baseDir: string, sandboxRoot: string, rawPath: string): string | undefined {
	const trimmed = rawPath.trim();
	if (!trimmed) return undefined;
	try {
		const lexicalPath = resolve(isAbsolute(trimmed) ? trimmed : join(baseDir, trimmed));
		if (!isPathWithinScope(lexicalPath, resolve(sandboxRoot))) return undefined;
		const resolved = safeRealpathSync(lexicalPath);
		if (!isPathWithinScope(resolved, safeRealpathSync(sandboxRoot))) return undefined;
		return normalize(resolved);
	} catch {
		return undefined;
	}
}

function readBounded(path: string, scopeRoot: string, maxChars: number): { text: string; truncated: boolean } {
	try {
		const resolvedPath = safeRealpathSync(path);
		if (!isPathWithinScope(resolvedPath, safeRealpathSync(scopeRoot))) {
			return { text: `(missing: ${path})`, truncated: false };
		}
		const maxBytes = Math.max(1, maxChars * 4);
		const prefix = readFilePrefixSync(resolvedPath, maxBytes, "Pipeline context file");
		const raw = prefix.content.toString("utf8");
		const truncated = prefix.truncated || raw.length > maxChars;
		if (!truncated) return { text: raw, truncated: false };
		return { text: `${raw.slice(0, maxChars)}\n…[truncated]`, truncated: true };
	} catch (error) {
		return { text: `(unreadable: ${error instanceof Error ? error.message : String(error)})`, truncated: false };
	}
}

function pushLayer(
	layers: AssembledLayer[],
	layer: ContextLayer,
	path: string,
	scopeRoot: string,
	label: string,
	remaining: number,
): number {
	if (remaining <= 0) {
		layers.push({ layer, path, label, text: "(omitted: stage context budget)", truncated: true });
		return 0;
	}
	const budget = Math.min(MAX_LAYER_FILE_CHARS, remaining);
	const read = readBounded(path, scopeRoot, budget);
	layers.push({ layer, path, label, text: read.text, truncated: read.truncated });
	return remaining - read.text.length;
}

export function currentPipelineStage(definition: PipelineDefinition, run: PipelineRun): PipelineStage | undefined {
	return definition.stages.find((stage) => stage.id === run.currentStageId);
}

export function assembleStageContext(
	definition: PipelineDefinition,
	run: PipelineRun,
	stage?: PipelineStage,
): AssembledStageContext {
	const currentStage = stage ?? currentPipelineStage(definition, run);
	if (!currentStage) {
		throw new Error(
			`Current pipeline stage '${run.currentStageId}' is missing from definition '${definition.name}'.`,
		);
	}
	const layers: AssembledLayer[] = [];
	let remaining = MAX_STAGE_CONTEXT_CHARS;
	remaining = pushLayer(layers, 0, definition.entryFile, definition.rootDir, "L0 entry", remaining);
	if (definition.routingPath !== definition.entryFile) {
		remaining = pushLayer(layers, 1, definition.routingPath, definition.rootDir, "L1 routing", remaining);
	}
	remaining = pushLayer(layers, 2, currentStage.contractPath, definition.rootDir, "L2 stage contract", remaining);

	const definitionStageDir = join(definition.stagesDir, currentStage.folderName);
	const runStageDir = join(run.runRoot, currentStage.folderName);
	for (const input of currentStage.contract.inputs) {
		if (input.kind === "reference") {
			const path = resolveUnder(definitionStageDir, definition.rootDir, input.path);
			if (!path) continue;
			remaining = pushLayer(layers, 3, path, definition.rootDir, `L3 ${input.path}`, remaining);
		} else {
			const path = resolveUnder(runStageDir, run.runRoot, input.path);
			if (!path) continue;
			remaining = pushLayer(layers, 4, path, run.runRoot, `L4 ${input.path}`, remaining);
		}
	}

	const text = layers
		.map((item) => `### ${item.label}\npath: ${item.path}\n${item.text}`)
		.join("\n\n")
		.slice(0, MAX_STAGE_CONTEXT_CHARS);
	return {
		stageId: currentStage.id,
		layers,
		text,
		tokenEstimate: Math.ceil(text.length / CHARS_PER_TOKEN),
	};
}

export function formatPipelineContext(
	definition: PipelineDefinition,
	run: PipelineRun,
	assembled: AssembledStageContext,
): string {
	const stage = currentPipelineStage(definition, run);
	const humanCheck = stage?.contract.humanCheck.trim();
	const lines = [
		`PIPELINE ${definition.name} run=${run.runId} status=${run.status} stage=${run.currentStageId}`,
		stage ? `ONE JOB: ${stage.contract.oneJob || stage.contract.title || stage.id}` : "",
		humanCheck ? `HUMAN CHECK: ${humanCheck}` : "",
		`Increment completes this stage after output/ has files, then starts the next. Status is the files on disk.`,
		assembled.text,
	].filter((line) => line.length > 0);
	return `${PIPELINE_CONTEXT_OPEN} revision=${run.revision}>\n${lines.join("\n")}\n</pipeline_context>`;
}

export function formatActivePipelineContext(definition: PipelineDefinition, run: PipelineRun): string | undefined {
	if (!isPipelineRunActive(run)) return undefined;
	return formatPipelineContext(definition, run, assembleStageContext(definition, run));
}

const PIPELINE_CONTEXT_OPEN = "<pipeline_context";
