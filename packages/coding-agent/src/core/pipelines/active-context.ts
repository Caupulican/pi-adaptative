import { createCustomMessage } from "@caupulican/pi-agent-core";
import { formatActivePipelineContext } from "./context.ts";
import { type DiscoverPipelineOptions, resolvePipelineDefinitionForRun } from "./discover.ts";
import { resolveCurrentProjectPipelineRun } from "./run-state.ts";
import type { PipelineRun } from "./types.ts";

export interface ActivePipelineContext {
	run: PipelineRun;
	text: string;
}

/** Resolve durable run identity, definition ownership, and bounded prompt text through one path. */
export function resolveActivePipelineContext(
	options: DiscoverPipelineOptions,
	snapshot?: PipelineRun,
): ActivePipelineContext | undefined {
	const run = resolveCurrentProjectPipelineRun(options.cwd, snapshot);
	if (!run) return undefined;
	const definition = resolvePipelineDefinitionForRun(options, run);
	if (!definition) return undefined;
	const text = formatActivePipelineContext(definition, run);
	return text ? { run, text } : undefined;
}

/** Build the optional per-turn pipeline message without leaking discovery failures into prompt admission. */
export function createActivePipelineContextMessage(args: {
	options: DiscoverPipelineOptions;
	snapshot?: PipelineRun;
	onError(message: string): void;
}): ReturnType<typeof createCustomMessage> | undefined {
	try {
		const context = resolveActivePipelineContext(args.options, args.snapshot);
		return context
			? createCustomMessage(
					"pipeline_context",
					context.text,
					false,
					{ revision: context.run.revision },
					new Date().toISOString(),
				)
			: undefined;
	} catch (error) {
		args.onError(`Pipeline context unavailable: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}
