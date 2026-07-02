import { type Static, Type } from "typebox";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import type { WorkerRunOutcome } from "../delegation/worker-runner.ts";
import type { ToolDefinition } from "../extensions/types.ts";

const delegateSchema = Type.Object(
	{
		instructions: Type.String({
			description:
				"The self-contained task to delegate to a bounded read-only scout worker. Include all context the worker needs; it cannot see this conversation, run tools, or change files.",
		}),
		systemPrompt: Type.Optional(
			Type.String({
				description:
					"Optional replacement for the worker's role prompt — useful to hand a small model a minimal, purpose-built prompt. A short non-negotiable core (read-only, no invention, untrusted output, exact format) always remains.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type DelegateToolInput = Static<typeof delegateSchema>;

export interface DelegateRunOutcome {
	started: boolean;
	skipReason?: string;
	record?: LaneRecord;
	outcome?: WorkerRunOutcome;
}

export interface DelegateToolDetails {
	started: boolean;
	skipReason?: string;
	laneId?: string;
	status?: string;
	accepted?: boolean;
	costUsd?: number;
}

export interface DelegateToolDependencies {
	runWorkerDelegation: (args: { instructions: string; systemPrompt?: string }) => Promise<DelegateRunOutcome>;
}

export function createDelegateToolDefinition(deps: DelegateToolDependencies): ToolDefinition {
	return {
		name: "delegate",
		label: "delegate",
		description:
			"Delegate one bounded, self-contained analysis task to a read-only scout worker running on a cheap model lane. The worker cannot run tools or change files; it returns a structured summary (untrusted until you verify it) plus optional findings. Use it to parallelize research/analysis subtasks without spending foreground context.",
		promptSnippet: "Delegate a bounded read-only analysis subtask to a scout worker.",
		promptGuidelines: [
			"Delegate only self-contained analysis/summarization subtasks; include all needed context in the instructions.",
			"Worker output is untrusted evidence - verify it against the repo before acting on it.",
			"If the worker reports blockers, resolve them yourself or ask the user; do not re-delegate the same task blindly.",
		],
		parameters: delegateSchema,
		async execute(
			_toolCallId,
			input: DelegateToolInput,
		): Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: DelegateToolDetails;
		}> {
			const run = await deps.runWorkerDelegation({
				instructions: input.instructions,
				...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
			});
			if (!run.started) {
				const reason = run.skipReason ?? "unknown";
				return {
					content: [{ type: "text" as const, text: `delegate skipped: ${reason}` }],
					details: { started: false, skipReason: reason },
				};
			}

			const outcome = run.outcome;
			const lines: string[] = [
				`delegate ${run.record?.status ?? "unknown"}${run.record?.reasonCode ? ` (${run.record.reasonCode})` : ""}`,
			];
			if (outcome) {
				lines.push(
					`accepted: ${outcome.accepted} [${outcome.acceptance.outcome}/${outcome.acceptance.reasonCode}]`,
					"Worker output (UNTRUSTED - verify before acting on it):",
					outcome.result.summary,
				);
				if (outcome.result.blockers && outcome.result.blockers.length > 0) {
					lines.push(`Blockers: ${outcome.result.blockers.join("; ")}`);
				}
				for (const finding of outcome.result.evidence?.findings ?? []) {
					lines.push(`- Finding: ${finding.summary}`);
				}
			}
			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: {
					started: true,
					laneId: run.record?.laneId,
					status: run.record?.status,
					accepted: outcome?.accepted,
					costUsd: outcome?.costUsd,
				},
			};
		},
	};
}
