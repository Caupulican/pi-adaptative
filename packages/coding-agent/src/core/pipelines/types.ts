/** ICM pipeline form: numbered stages, factory vs product, status from files. */

export const PIPELINE_STAGE_FOLDER_RE = /^(\d{2})_([a-z0-9][a-z0-9-]{0,62})$/;
export const MAX_PIPELINE_STAGES = 32;
export const MAX_PIPELINE_NAME_LENGTH = 64;
export const MAX_CONTRACT_PROCESS_CHARS = 4_000;
export const MAX_HUMAN_CHECK_CHARS = 1_000;
export const MAX_STAGE_CONTEXT_CHARS = 8_000;
export const MAX_LAYER_FILE_CHARS = 4_000;

export type PipelineForm =
	| "pipeline"
	| "umbrella"
	| "record-library"
	| "knowledge-bundle"
	| "context-map"
	| "system-map";

export type ContextLayer = 0 | 1 | 2 | 3 | 4;

export type InputKind = "working" | "reference";

export interface PipelineInputRef {
	kind: InputKind;
	path: string;
}

export interface StageContract {
	title: string;
	oneJob: string;
	inputs: readonly PipelineInputRef[];
	doNotLoad: readonly string[];
	process: readonly string[];
	outputs: readonly string[];
	humanCheck: string;
}

export interface PipelineStage {
	id: string;
	ordinal: number;
	slug: string;
	folderName: string;
	contractPath: string;
	outputDir: string;
	contract: StageContract;
}

export type StageDiskStatus = "empty" | "complete";

export interface PipelineDefinition {
	name: string;
	description: string;
	form: PipelineForm;
	rootDir: string;
	entryFile: string;
	routingPath: string;
	factoryDir: string;
	stagesDir: string;
	stages: readonly PipelineStage[];
}

export type PipelineRunStatus = "active" | "completed" | "abandoned";

export interface PipelineRun {
	version: 1;
	revision: number;
	runId: string;
	pipelineName: string;
	definitionPath: string;
	runRoot: string;
	currentStageId: string;
	status: PipelineRunStatus;
	goalId?: string;
	createdAt: string;
	updatedAt: string;
}

export interface StageScan {
	stageId: string;
	status: StageDiskStatus;
	outputFiles: readonly string[];
}

export interface IncrementResult {
	surface: "pipeline" | "task_steps" | "goal";
	from?: string;
	to?: string;
	completed: boolean;
	detail: string;
}

export interface AssembledLayer {
	layer: ContextLayer;
	path: string;
	label: string;
	text: string;
	truncated: boolean;
}

export interface AssembledStageContext {
	stageId: string;
	layers: readonly AssembledLayer[];
	text: string;
	tokenEstimate: number;
}

export const PIPELINE_RUN_CUSTOM_TYPE = "pipeline_run";
export const PIPELINE_CONTEXT_MARKER = "<pipeline_context";

export function isPipelineForm(value: unknown): value is PipelineForm {
	return (
		value === "pipeline" ||
		value === "umbrella" ||
		value === "record-library" ||
		value === "knowledge-bundle" ||
		value === "context-map" ||
		value === "system-map"
	);
}

export function isPipelineRun(value: unknown): value is PipelineRun {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		record.version === 1 &&
		typeof record.revision === "number" &&
		Number.isInteger(record.revision) &&
		record.revision >= 0 &&
		typeof record.runId === "string" &&
		record.runId.length > 0 &&
		typeof record.pipelineName === "string" &&
		typeof record.definitionPath === "string" &&
		typeof record.runRoot === "string" &&
		typeof record.currentStageId === "string" &&
		(record.status === "active" || record.status === "completed" || record.status === "abandoned") &&
		typeof record.createdAt === "string" &&
		typeof record.updatedAt === "string" &&
		(record.goalId === undefined || typeof record.goalId === "string")
	);
}

export function clonePipelineRun(run: PipelineRun): PipelineRun {
	return { ...run };
}

export function isPipelineRunActive(run: Pick<PipelineRun, "status">): boolean {
	return run.status === "active";
}
