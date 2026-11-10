/**
 * One isolated completion that has to end in one structured submission, under one spending budget: the shape every
 * background reading of a model shares. It owns the bounded usage and its release, the freshness check before each
 * request, the one terminating tool and its repeat refusal, the rule that a submission already received is the result
 * even when its measured charge failed the allowance, and the error of a completion that stopped with error or aborted.
 * A caller owns what its reading is about: its system prompt, its messages, its tool schema and validation, its turn
 * limit, its lane and the texts of its refusals.
 */
import type { Api, Message, Model } from "@caupulican/pi-ai";
import { resolveModelThinkingLevel } from "@caupulican/pi-ai/models";
import type { Static, TSchema } from "typebox";
import type { AgentLoopConfig } from "../../kernel/loop-config.ts";
import type { AgentTool } from "../../kernel/types.ts";
import type { IsolatedCompletionOptions, IsolatedCompletionResult } from "../agent-session-contracts.ts";
import type { AccountingOrigin } from "../cost/accounting-evidence.ts";
import { BoundedCompletionUsage } from "../cost/bounded-completion-usage.ts";
import type { RequestSpendBudget } from "../cost/request-spend-budget.ts";
import type { SessionSemanticUsageDelivery } from "../cost/semantic-usage-delivery.ts";
import { isolatedCompletionError } from "../provider-admission/refusal.ts";
import type { MaintenanceUsageRoute } from "../review/system-one-review-port.ts";

/** What one caller's submission tool hands back: the kept submission, the model's answer text and the host's record. */
export interface SubmissionAnswer<Submission> {
	readonly submission: Submission;
	/** Shown to the model, and the only part of the answer it ever sees. */
	readonly text: string;
	/** Kept by the host; the model never sees it. */
	readonly details?: unknown;
}

/** One caller's terminating tool: its schema, and the validation of what a submission carries. */
export interface SubmissionToolSpec<Parameters extends TSchema, Submission> {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: Parameters;
	/** Keeps one validated submission; throws to refuse it at the tool, so the model can correct it. */
	accept(params: Static<Parameters>): SubmissionAnswer<Submission>;
}

export interface BoundedSubmissionCompletionInput<Parameters extends TSchema, Submission> {
	readonly systemPrompt: string;
	/** New child-owned prompt messages for this call; foreground history is never inherited. */
	readonly messages: Message[];
	readonly model: Model<Api>;
	/** The model's output limit for this reading. */
	readonly maxTokens: number;
	readonly budget: RequestSpendBudget;
	readonly usageOwner: SessionSemanticUsageDelivery;
	readonly origin: AccountingOrigin;
	readonly maxTurns: number;
	/** The reading's one lane: its accounting route and its cache affinity. */
	readonly lane: MaintenanceUsageRoute;
	readonly signal: AbortSignal;
	/** Whether another request may start: source, policy and memory freshness, and the caller's cooperative stop. */
	assertCurrent(): void;
	runIsolatedCompletion(options: IsolatedCompletionOptions): Promise<IsolatedCompletionResult>;
	/** The caller's own tools, offered before the submission tool. */
	readonly tools?: readonly AgentTool[];
	readonly submission: SubmissionToolSpec<Parameters, Submission>;
	/** An extra gate before any tool runs, such as a rule about the message a tool call arrives in. */
	readonly beforeToolCall?: AgentLoopConfig["beforeToolCall"];
	/** How this reading names itself in the error of a completion that stopped with error or aborted. */
	readonly stoppedLabel: string;
}

/** The submission the reading kept, or the fact that it ended without one, which is an answer and not an error. */
export type BoundedSubmissionOutcome<Submission> =
	| { readonly status: "submitted"; readonly submission: Submission }
	| { readonly status: "no_submission" };

/**
 * Every physical request starts only while the caller's context is current and the allowance is healthy; a response
 * already received is processed and retained unless the reading was aborted.
 */
export async function runBoundedSubmissionCompletion<Parameters extends TSchema, Submission>(
	input: BoundedSubmissionCompletionInput<Parameters, Submission>,
): Promise<BoundedSubmissionOutcome<Submission>> {
	const { signal } = input;
	signal.throwIfAborted();
	input.assertCurrent();
	if (!Number.isSafeInteger(input.maxTokens) || input.maxTokens < 1 || input.maxTokens > input.model.maxTokens)
		throw new RangeError(`${input.stoppedLabel} requires a valid model output limit.`);
	const usage = new BoundedCompletionUsage(input.usageOwner, input.lane, input.budget, input.maxTurns, input.origin);
	const capture: { answer?: SubmissionAnswer<Submission> } = {};
	let closed = false;
	const assertOpen = (): void => {
		signal.throwIfAborted();
		if (closed) throw new Error(`${input.stoppedLabel} already ended.`);
	};
	const assertMayRequest = (): void => {
		assertOpen();
		input.assertCurrent();
	};
	const submit: AgentTool<Parameters> = {
		name: input.submission.name,
		label: input.submission.label,
		description: input.submission.description,
		parameters: input.submission.parameters,
		executionMode: "sequential",
		execute: async (_id, params) => {
			assertOpen();
			if (capture.answer !== undefined) throw new Error(`${input.stoppedLabel} already received its submission.`);
			const answer = input.submission.accept(params);
			capture.answer = answer;
			return { content: [{ type: "text", text: answer.text }], details: answer.details ?? {}, terminate: true };
		},
	};
	try {
		const result = await input.runIsolatedCompletion({
			systemPrompt: input.systemPrompt,
			messages: input.messages,
			model: input.model,
			thinkingLevel: resolveModelThinkingLevel(input.model, "low"),
			maxTokens: input.maxTokens,
			maxTurns: input.maxTurns,
			maxRetries: 0,
			signal,
			cacheRetention: "short",
			laneKind: input.lane,
			tools: [...(input.tools ?? []), submit],
			beforeToolCall: input.beforeToolCall,
			requestPreflight: (request) => {
				assertMayRequest();
				return usage.preflight(request);
			},
			requestGuard: () => {
				assertMayRequest();
				usage.assertHealthy();
			},
			providerResponseObserver: usage,
		});
		assertOpen();
		// A received submission is the result even when its measured charge failed the allowance; the caller's next
		// request is refused instead.
		const answer = capture.answer;
		if (answer !== undefined) return { status: "submitted", submission: answer.submission };
		usage.assertHealthy();
		if (result.stopReason === "error" || result.stopReason === "aborted")
			throw isolatedCompletionError(result, `${input.stoppedLabel} ${result.stopReason}.`);
		return { status: "no_submission" };
	} finally {
		closed = true;
		usage.release();
	}
}
