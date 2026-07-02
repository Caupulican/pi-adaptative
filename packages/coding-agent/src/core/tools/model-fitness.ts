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
	}) => Promise<{ started: true; model: string; report: ModelFitnessReport } | { started: false; skipReason: string }>;
}

export function createModelFitnessToolDefinition(deps: ModelFitnessToolDependencies): ToolDefinition {
	return {
		name: "model_fitness",
		label: "model_fitness",
		description:
			"Probe whether a candidate model can drive the harness's subagent contracts: runs the real research-lane, scout-worker, and routing-judge runners against the model and reports parse/success rates, judge discrimination, latency, and probe cost. Use it to evaluate small/local models (e.g. Ollama) before configuring them as lane or judge models.",
		promptSnippet: "Benchmark a candidate model against the research/worker/judge subagent contracts.",
		promptGuidelines: [
			"Use model_fitness before recommending a model for researchLane.model, workerDelegation.model, or modelRouter.judgeModel.",
			"A good lane model has high research/worker success; a good judge additionally routes trivial prompts cheap while keeping planning elevated.",
			"Probes spend real tokens on the probed model; prefer local/free models or small trial counts.",
		],
		parameters: modelFitnessSchema,
		async execute(
			_toolCallId,
			input: ModelFitnessToolInput,
		): Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: ModelFitnessToolDetails;
		}> {
			const run = await deps.runProbe({ model: input.model, trials: input.trials });
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
