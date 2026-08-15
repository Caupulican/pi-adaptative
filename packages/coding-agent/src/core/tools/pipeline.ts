import { type Static, Type } from "typebox";
import { createWorkRunId } from "../../utils/work-directory.ts";
import type { BackgroundToolTaskRef } from "../background-tool-task-controller.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { GoalState } from "../goals/goal-state.ts";
import type { OpenTaskStepRef } from "../goals/goal-tool-core.ts";
import {
	abandonPipelineRun,
	assembleStageContext,
	createPipelineRunRoot,
	discoverPipelineDefinitions,
	findActivePipelineRun,
	findPipelineDefinition,
	formatPipelineContext,
	incrementPipelineRun,
	instantiatePipelineRun,
	isPipelineRunActive,
	loadPipelineDefinition,
	loadPipelineRunById,
	type PipelineDefinition,
	type PipelineRun,
	scanPipelineRun,
} from "../pipelines/index.ts";
import {
	emptyOrchestrationCall,
	type OrchestrationPanelModel,
	renderOrchestrationToolResult,
} from "./orchestration-panel.ts";

const pipelineSchema = Type.Object(
	{
		action: Type.Union(
			[
				Type.Literal("list"),
				Type.Literal("start"),
				Type.Literal("status"),
				Type.Literal("increment"),
				Type.Literal("abandon"),
			],
			{ description: "list definitions; start a run; status from output/; increment current; abandon." },
		),
		name: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: "Definition name for start." })),
		runId: Type.Optional(
			Type.String({ minLength: 1, maxLength: 128, description: "Run id. Defaults to the active run." }),
		),
		goalId: Type.Optional(
			Type.String({ minLength: 1, maxLength: 128, description: "Optional goal to join on start." }),
		),
	},
	{ additionalProperties: false },
);

export type PipelineToolInput = Static<typeof pipelineSchema>;
export type PipelineToolAction = PipelineToolInput["action"];

export interface PipelineToolDetails {
	action: PipelineToolAction;
	applied: boolean;
	error?: string;
	run?: PipelineRun;
	definitionName?: string;
}

export interface PipelineToolDependencies {
	cwd: () => string;
	agentPipelinesDir: () => string;
	getPipelineRun: () => PipelineRun | undefined;
	savePipelineRun: (run: PipelineRun) => void;
	getGoalState?: () => GoalState | undefined;
	getOpenTaskSteps?: () => readonly OpenTaskStepRef[];
	getBackgroundToolTasks?: () => readonly BackgroundToolTaskRef[];
	now?: () => string;
	createRunId?: () => string;
}

function errorResult(action: PipelineToolAction, error: string, run?: PipelineRun) {
	return {
		content: [{ type: "text" as const, text: `pipeline ${action} failed: ${error}` }],
		details: { action, applied: false, error, run } satisfies PipelineToolDetails,
		isError: true as const,
	};
}

function resolveRun(deps: PipelineToolDependencies, runId: string | undefined): PipelineRun | undefined {
	if (runId?.trim()) return loadPipelineRunById(deps.cwd(), runId.trim());
	return deps.getPipelineRun() ?? findActivePipelineRun(deps.cwd());
}

function resolveDefinition(deps: PipelineToolDependencies, run: PipelineRun): PipelineDefinition | undefined {
	return (
		loadPipelineDefinition(run.definitionPath) ??
		findPipelineDefinition({ agentPipelinesDir: deps.agentPipelinesDir(), cwd: deps.cwd() }, run.pipelineName)
	);
}

function formatDefinitionList(definitions: readonly PipelineDefinition[], active?: PipelineRun): string {
	if (definitions.length === 0) {
		return "No pipeline definitions. Put a numbered-stage workspace in .pi/pipelines/ or ~/.pi/agent/pipelines/.";
	}
	const lines = definitions.map((definition) => {
		const stages = definition.stages.map((stage) => stage.id).join(", ");
		return `- ${definition.name} (${definition.form}, ${definition.stages.length} stages: ${stages})`;
	});
	if (active) {
		lines.unshift(
			`Active run ${active.runId}: ${active.pipelineName} @ ${active.currentStageId} (${active.status}).`,
		);
	}
	return `Pipelines:\n${lines.join("\n")}`;
}

function formatStatus(definition: PipelineDefinition, run: PipelineRun): string {
	const scans = scanPipelineRun(definition, run);
	const lines = [
		`Pipeline '${definition.name}' run ${run.runId} ${run.status}. Current stage: ${run.currentStageId}.`,
		...scans.map((scan) => {
			const mark = scan.status === "complete" ? "x" : " ";
			const files = scan.outputFiles.length > 0 ? ` (${scan.outputFiles.join(", ")})` : "";
			return `- [${mark}] ${scan.stageId}${files}`;
		}),
	];
	if (run.goalId) lines.push(`Joined goal: ${run.goalId}.`);
	return lines.join("\n");
}

function pipelinePanel(details: PipelineToolDetails | undefined): OrchestrationPanelModel {
	const run = details?.run;
	if (!run) {
		return {
			label: "pipeline",
			action: details?.action,
			status: details?.error ? "error" : "idle",
			emptyText: details?.error ?? "No pipeline run.",
		};
	}
	return {
		label: "pipeline",
		action: details.action,
		status:
			run.status === "completed" ? "success" : run.status === "abandoned" || details.error ? "warning" : "running",
		summary: [`${run.pipelineName}`, run.currentStageId, run.status],
		emptyText: details.error,
	};
}

export function createPipelineToolDefinition(deps: PipelineToolDependencies): ToolDefinition {
	const now = deps.now ?? (() => new Date().toISOString());
	return {
		name: "pipeline",
		label: "Pipeline",
		description:
			"Run an ICM folder pipeline: numbered stages, load only the current contract, increment when output/ has files.",
		promptSnippet: "Walk a folder pipeline one stage at a time.",
		promptGuidelines: [
			"Use for repeating sequential workflows with stage folders. Status is output/ files, not chat memory.",
			"increment completes the current stage then starts the next. Write outputs first. No Review-now latch.",
			"Use task_steps advance for checklists, goal increment for requirements, delegate for concurrent work.",
		],
		parameters: pipelineSchema,
		renderShell: "self",
		renderCall() {
			return emptyOrchestrationCall();
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as PipelineToolDetails | undefined;
			return renderOrchestrationToolResult(theme, pipelinePanel(details), {
				isPartial,
				collapse: !expanded && details?.applied === true,
				expanded: true,
			});
		},
		async execute(_toolCallId, input: PipelineToolInput) {
			const timestamp = now();
			const discoverOpts = { agentPipelinesDir: deps.agentPipelinesDir(), cwd: deps.cwd() };
			try {
				if (input.action === "list") {
					const definitions = discoverPipelineDefinitions(discoverOpts);
					const active = resolveRun(deps, input.runId);
					return {
						content: [{ type: "text" as const, text: formatDefinitionList(definitions, active) }],
						details: { action: "list", applied: false, run: active } satisfies PipelineToolDetails,
					};
				}

				if (input.action === "start") {
					if (!input.name?.trim()) return errorResult("start", "start requires name.");
					const definition = findPipelineDefinition(discoverOpts, input.name);
					if (!definition) {
						return errorResult("start", `No pipeline definition named '${input.name.trim()}'.`);
					}
					const existing = deps.getPipelineRun();
					if (existing && isPipelineRunActive(existing)) {
						return errorResult(
							"start",
							`An active run '${existing.runId}' already exists. Increment or abandon it first.`,
							existing,
						);
					}
					const runId = deps.createRunId?.() ?? createWorkRunId();
					const run = instantiatePipelineRun({
						definition,
						runId,
						runRoot: createPipelineRunRoot(deps.cwd(), runId),
						goalId: input.goalId?.trim() || deps.getGoalState?.()?.goalId,
						now: timestamp,
					});
					deps.savePipelineRun(run);
					const stage = definition.stages[0]!;
					const assembled = assembleStageContext(definition, run, stage);
					const text = [
						`pipeline start recorded. Run ${run.runId} at ${stage.id}.`,
						formatPipelineContext(definition, run, assembled),
					].join("\n");
					return {
						content: [{ type: "text" as const, text }],
						details: {
							action: "start",
							applied: true,
							run,
							definitionName: definition.name,
						} satisfies PipelineToolDetails,
					};
				}

				const current = resolveRun(deps, input.runId);
				if (!current) return errorResult(input.action, "No active pipeline run. Use start first.");
				const definition = resolveDefinition(deps, current);
				if (!definition) {
					return errorResult(input.action, `Pipeline definition '${current.pipelineName}' is missing.`, current);
				}

				if (input.action === "status") {
					const assembled = assembleStageContext(definition, current);
					return {
						content: [
							{
								type: "text" as const,
								text: `${formatStatus(definition, current)}\n${formatPipelineContext(definition, current, assembled)}`,
							},
						],
						details: { action: "status", applied: false, run: current } satisfies PipelineToolDetails,
					};
				}

				if (input.action === "abandon") {
					const run = abandonPipelineRun(current, timestamp);
					deps.savePipelineRun(run);
					return {
						content: [
							{ type: "text" as const, text: `pipeline abandon recorded. Run ${run.runId} is abandoned.` },
						],
						details: { action: "abandon", applied: true, run } satisfies PipelineToolDetails,
					};
				}

				const advanced = incrementPipelineRun(definition, current, timestamp, {
					goal: deps.getGoalState?.(),
					openTaskSteps: deps.getOpenTaskSteps?.(),
					backgroundToolTasks: deps.getBackgroundToolTasks?.(),
				});
				deps.savePipelineRun(advanced.run);
				const assembled = assembleStageContext(definition, advanced.run);
				return {
					content: [
						{
							type: "text" as const,
							text: `pipeline increment recorded. ${advanced.result.detail}\n${formatPipelineContext(definition, advanced.run, assembled)}`,
						},
					],
					details: { action: "increment", applied: true, run: advanced.run } satisfies PipelineToolDetails,
				};
			} catch (error) {
				return errorResult(
					input.action,
					error instanceof Error ? error.message : String(error),
					deps.getPipelineRun(),
				);
			}
		},
	};
}
