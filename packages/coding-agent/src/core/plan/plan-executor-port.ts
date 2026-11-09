/**
 * The surface the `plan` tool, the plan rows, `/status` and `/plan` reach the plan executor through. The executor
 * (`plan-executor.ts`) implements it; consumers depend on this file only.
 */

import type { PlanJoinKind } from "./plan-graph.ts";

/** One step as the model writes it (`plan` tool schema, design PG 5.1). */
export interface PlanToolStep {
	readonly id: string;
	readonly do: string;
	readonly files?: readonly string[];
	readonly uses?: readonly string[];
	readonly after?: readonly string[];
	readonly req?: readonly string[];
	readonly deep?: boolean;
	readonly join?: PlanJoinKind;
	readonly question?: string;
	readonly by?: string;
	/** What makes the step done, one line; carried into the step's brief and its result's proof sheet. */
	readonly doneWhen?: string;
	/** What the step must not touch or decide, one line each; carried like `doneWhen`. */
	readonly outOfScope?: readonly string[];
	/** How the step's result is proven: cite, cmd, diff, or check:<command> (a command whose exit code 0 proves it). */
	readonly proof?: string;
	/** A vote step: the criteria every candidate is judged on, one each. */
	readonly criteria?: readonly string[];
}

export interface PlanToolInput {
	readonly action: "start" | "revise" | "cancel";
	readonly title?: string;
	readonly steps?: readonly PlanToolStep[];
	readonly final?: string;
	readonly remove?: readonly string[];
	readonly reason?: string;
}

export interface PlanCallContext {
	readonly toolCallId: string;
	readonly signal?: AbortSignal;
}

export type PlanToolResult =
	| {
			readonly ok: true;
			/** Model-facing text: `h PLAN_STARTED` (or the revise/cancel code) plus one plain line per step. */
			readonly text: string;
			readonly planId: string;
			readonly version: number;
			readonly started: number;
			readonly waiting: number;
	  }
	| { readonly ok: false; readonly text: string };

export interface PlanExecutorPort {
	/** Runs one `plan` tool call: facts, System One judgments, ordered exits, record, first release. */
	applyToolCall(input: PlanToolInput, context: PlanCallContext): Promise<PlanToolResult>;
}
