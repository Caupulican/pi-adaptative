import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { ModelFitnessReport } from "../research/model-fitness.ts";
import { formatModelFitnessReport } from "../research/model-fitness.ts";

const modelFitnessSchema = Type.Object(
	{
		model: Type.String({
			description:
				'Model pattern to probe, e.g. "ollama/qwen3:0.6b" or any registered provider/model pattern. The model must be registered and authenticated.',
		}),
		trials: Type.Optional(
			Type.Number({
				description:
					"Trials per lane surface (research/worker), 1-20. Default 3. The judge always runs its 6-prompt set.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type ModelFitnessToolInput = Static<typeof modelFitnessSchema>;

export interface ModelFitnessToolDetails {
	started: boolean;
	skipReason?: string;
	model?: string;
	report?: ModelFitnessReport;
}

export interface ModelFitnessToolDependencies {
	runProbe: (args: {
		model: string;
		trials?: number;
		/**
		 * The LLM tool-call id for THIS invocation: the idempotency token a retry of the same
		 * tool call reuses, so the spawned-usage reportId stays stable on a retry instead of falling
		 * back to a bare (model, trials) identity — which two deliberately separate tool calls on the
		 * same model/trials would otherwise collide on and silently under-count.
		 */
		toolCallId?: string;
	}) => Promise<{ started: true; model: string; report: ModelFitnessReport } | { started: false; skipReason: string }>;
}

export function createModelFitnessToolDefinition(deps: ModelFitnessToolDependencies): ToolDefinition {
	return {
		name: "model_fitness",
		label: "model_fitness",
		description:
			"Probe whether a candidate model can drive the harness's subagent contracts: runs the real research-lane, delegated-worker, and routing-judge runners against the model and reports parse/success rates, judge discrimination, latency, and probe cost. Use it to evaluate small/local models (e.g. Ollama) before configuring them as lane or judge models.",
		promptSnippet: "Benchmark model against research/worker/judge contracts.",
		promptGuidelines: [
			"Use before pinning model in worker profile, researchLane.model, modelRouter.judgeModel.",
			"Lane: high research/worker success. Judge: trivial cheap, planning elevated.",
			"Probes spend real tokens; prefer local/free models or few trials.",
		],
		parameters: modelFitnessSchema,
		async execute(
			toolCallId,
			input: ModelFitnessToolInput,
		): Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: ModelFitnessToolDetails;
		}> {
			const run = await deps.runProbe({ model: input.model, trials: input.trials, toolCallId });
			if (!run.started) {
				return {
					content: [{ type: "text" as const, text: `model_fitness skipped: ${run.skipReason}` }],
					details: { started: false, skipReason: run.skipReason },
				};
			}
			return {
				content: [{ type: "text" as const, text: formatModelFitnessReport(run.model, run.report) }],
				details: { started: true, model: run.model, report: run.report },
			};
		},
	};
}
