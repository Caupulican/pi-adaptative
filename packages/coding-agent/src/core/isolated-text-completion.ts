import type { Usage } from "@caupulican/pi-ai";
import type { IsolatedCompletionOptions, IsolatedCompletionResult } from "./agent-session-contracts.ts";

export interface IsolatedCompletionRunner {
	runIsolatedCompletion(options: IsolatedCompletionOptions): Promise<IsolatedCompletionResult>;
}

export type IsolatedTextCompletionOptions = Omit<IsolatedCompletionOptions, "messages"> & {
	userPrompt: string;
};

export interface IsolatedTextCompletionResult {
	text: string;
	costUsd: number;
	stopReason: string;
	usage: Usage;
}

/** Run one child-owned text prompt and project the shared route/curation result shape. */
export async function runIsolatedTextCompletion(
	runner: IsolatedCompletionRunner,
	options: IsolatedTextCompletionOptions,
): Promise<IsolatedTextCompletionResult> {
	const { userPrompt, ...completionOptions } = options;
	const completion = await runner.runIsolatedCompletion({
		...completionOptions,
		messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
	});
	return {
		text: completion.text,
		costUsd: completion.usage.cost.total,
		stopReason: String(completion.stopReason),
		usage: completion.usage,
	};
}
