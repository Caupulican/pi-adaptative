/**
 * The arguments a tool call runs with. Before schema validation the tool's own compatibility shim
 * (`prepareArguments`) runs; after it, the validated arguments give the call's forms (`backgroundArguments`). A call with
 * a background form runs in it only once its handoff to a background session task is accepted, and in its foreground
 * form otherwise. A nested call (one tool calling another) is never handed off, so it always runs in its foreground form.
 */

import type { AgentLoopConfig, BackgroundToolCallContext } from "./loop-config.ts";
import type { AgentTool, AgentToolCall, ToolCallBackgroundForms } from "./types.ts";

/**
 * A call's forms: the arguments it runs with in the foreground and, for a call that can start as a background task, the
 * arguments it runs with as one and why (the tool's reason when its caller did not ask).
 */
export interface ToolCallForm {
	readonly arguments: Record<string, any>;
	readonly background?: { readonly arguments: Record<string, any>; readonly reason?: string };
}

/** Whether the host can hand a call off to a background task now: it hands calls off and says it can. */
export function canHandOffToolCalls(config: AgentLoopConfig): boolean {
	return config.handoffToolCall !== undefined && config.canHandOffToolCalls?.() === true;
}

/** The tool's compatibility shim on the raw arguments, before schema validation. */
export function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) return toolCall;
	const prepared = tool.prepareArguments(toolCall.arguments);
	return prepared === toolCall.arguments ? toolCall : { ...toolCall, arguments: prepared as Record<string, any> };
}

/** A call's forms, read from its validated arguments; both are schema-valid, so neither is re-validated. */
export function toolCallForm(tool: AgentTool<any>, args: Record<string, any>): ToolCallForm {
	const forms = tool.backgroundArguments?.(args) as ToolCallBackgroundForms<Record<string, any>> | undefined;
	if (forms === undefined) return { arguments: args };
	const reason = forms.reason === undefined ? {} : { reason: forms.reason };
	return { arguments: forms.foreground, background: { arguments: forms.background, ...reason } };
}

/**
 * A prepared call across its handoff, the one place its form is decided. A call with a background form starts its body
 * only once the handoff is decided: handed off, it runs in its background form; refused, or no longer possible, it runs
 * in its foreground form, so a background form never runs in the foreground. Any other call starts at once.
 */
export interface ToolCallHandoff {
	/** Whether the host can hand this call off at all: it can now, and something would move the call. */
	readonly canHandOff: boolean;
	/** When the clock moves the call: at once for a call with a background form, else the operator's delay. */
	readonly delayMs: number | undefined;
	/** The arguments the call runs with if it is handed off. */
	readonly handoffArguments: Record<string, any>;
	/** The arguments the body runs with, once it may start. */
	readonly decided: Promise<Record<string, any>>;
	/** What moves the call if it is handed off now: the host by hand, the model's request, the tool, or the clock. */
	trigger(manual: boolean): Pick<BackgroundToolCallContext, "trigger" | "reason">;
	/** The handoff was accepted: the body starts in the background form. */
	handedOff(): void;
	/** The call stays in the foreground: the body starts in its foreground form. Returns `completion`. */
	inForeground<T>(completion: T): T;
}

export function toolCallHandoff(form: ToolCallForm, config: AgentLoopConfig): ToolCallHandoff {
	const background = form.background;
	const delayMs = background !== undefined ? 0 : backgroundToolCallDelay(config);
	let start: (args: Record<string, any>) => void = () => {};
	const decided = new Promise<Record<string, any>>((resolve) => {
		start = resolve;
	});
	if (background === undefined) start(form.arguments);
	return {
		canHandOff:
			canHandOffToolCalls(config) && (delayMs !== undefined || config.subscribeToolCallHandoffRequest !== undefined),
		delayMs,
		handoffArguments: background?.arguments ?? form.arguments,
		decided,
		trigger(manual) {
			if (manual) return { trigger: "manual" };
			if (background === undefined) return { trigger: "clock" };
			return background.reason === undefined
				? { trigger: "requested" }
				: { trigger: "tool", reason: background.reason };
		},
		handedOff: () => start(background?.arguments ?? form.arguments),
		inForeground(completion) {
			start(form.arguments);
			return completion;
		},
	};
}

/** The operator's clock: a positive `backgroundToolCallAfterMs` moves a foreground call running longer; unset is off. */
function backgroundToolCallDelay(config: AgentLoopConfig): number | undefined {
	const delay = config.backgroundToolCallAfterMs;
	if (delay === undefined || !Number.isFinite(delay) || delay <= 0) return undefined;
	return delay;
}

/**
 * The forms of a call whose own `background: true` asks for a background task: that call as it is, and the call without
 * `background` for the foreground. A call that does not ask has none.
 */
export function requestedBackgroundForms<T extends { background?: boolean }>(
	args: T,
): { background: T; foreground: T } | undefined {
	if (args?.background !== true) return undefined;
	const { background: _requested, ...foreground } = args;
	return { background: args, foreground: foreground as T };
}
