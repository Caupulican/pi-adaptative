import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { loadPipelineDefinition } from "./discover.ts";
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

function isInsideRoot(root: string, candidate: string): boolean {
	const rel = relative(resolve(root), resolve(candidate));
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function resolveUnder(baseDir: string, sandboxRoot: string, rawPath: string): string | undefined {
	const trimmed = rawPath.trim();
	if (!trimmed) return undefined;
	const resolved = resolve(isAbsolute(trimmed) ? trimmed : join(baseDir, trimmed));
	if (!isInsideRoot(sandboxRoot, resolved)) return undefined;
	return normalize(resolved);
}

function readBounded(path: string, maxChars: number): { text: string; truncated: boolean } {
	try {
		if (!existsSync(path) || !statSync(path).isFile()) {
			return { text: `(missing: ${path})`, truncated: false };
		}
		const raw = readFileSync(path, "utf8");
		if (raw.length <= maxChars) return { text: raw, truncated: false };
		return { text: `${raw.slice(0, maxChars)}\n…[truncated ${raw.length - maxChars} chars]`, truncated: true };
	} catch (error) {
		return { text: `(unreadable: ${error instanceof Error ? error.message : String(error)})`, truncated: false };
	}
}

function pushLayer(
	layers: AssembledLayer[],
	layer: ContextLayer,
	path: string,
	label: string,
	remaining: number,
): number {
	if (remaining <= 0) {
		layers.push({ layer, path, label, text: "(omitted: stage context budget)", truncated: true });
		return 0;
	}
	const budget = Math.min(MAX_LAYER_FILE_CHARS, remaining);
	const read = readBounded(path, budget);
	layers.push({ layer, path, label, text: read.text, truncated: read.truncated });
	return remaining - read.text.length;
}

export function currentPipelineStage(definition: PipelineDefinition, run: PipelineRun): PipelineStage | undefined {
	return definition.stages.find((stage) => stage.id === run.currentStageId);
}

export function assembleStageContext(
	definition: PipelineDefinition,
	run: PipelineRun,
	stage: PipelineStage = currentPipelineStage(definition, run) ?? definition.stages[0]!,
): AssembledStageContext {
	const layers: AssembledLayer[] = [];
	let remaining = MAX_STAGE_CONTEXT_CHARS;
	remaining = pushLayer(layers, 0, definition.entryFile, "L0 entry", remaining);
	if (definition.routingPath !== definition.entryFile) {
		remaining = pushLayer(layers, 1, definition.routingPath, "L1 routing", remaining);
	}
	remaining = pushLayer(layers, 2, stage.contractPath, "L2 stage contract", remaining);

	const definitionStageDir = join(definition.stagesDir, stage.folderName);
	const runStageDir = join(run.runRoot, stage.folderName);
	for (const input of stage.contract.inputs) {
		if (input.kind === "reference") {
			const path = resolveUnder(definitionStageDir, definition.rootDir, input.path);
			if (!path) continue;
			remaining = pushLayer(layers, 3, path, `L3 ${input.path}`, remaining);
		} else {
			const path = resolveUnder(runStageDir, run.runRoot, input.path);
			if (!path) continue;
			remaining = pushLayer(layers, 4, path, `L4 ${input.path}`, remaining);
		}
	}

	const text = layers
		.map((item) => `### ${item.label}\npath: ${item.path}\n${item.text}`)
		.join("\n\n")
		.slice(0, MAX_STAGE_CONTEXT_CHARS);
	return {
		stageId: stage.id,
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

export function formatActivePipelineContext(run: PipelineRun): string | undefined {
	if (!isPipelineRunActive(run)) return undefined;
	const definition = loadPipelineDefinition(run.definitionPath);
	if (!definition) return undefined;
	return formatPipelineContext(definition, run, assembleStageContext(definition, run));
}

const PIPELINE_CONTEXT_OPEN = "<pipeline_context";
