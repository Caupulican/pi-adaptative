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
	/**
	 * ISO instant to stamp the message with — the caller's turn-owning timestamp, not a fresh
	 * `Date.now()` read here. This message is built once per turn and then persists verbatim in
	 * durable history, so anchoring it to the triggering turn keeps it a real, meaningful instant
	 * without a second independent wall-clock read racing the rest of the turn's messages.
	 */
	timestamp: string;
}): ReturnType<typeof createCustomMessage> | undefined {
	try {
		const context = resolveActivePipelineContext(args.options, args.snapshot);
		return context
			? createCustomMessage(
					"pipeline_context",
					context.text,
					false,
					{ revision: context.run.revision },
					args.timestamp,
				)
			: undefined;
	} catch (error) {
		args.onError(`Pipeline context unavailable: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}
