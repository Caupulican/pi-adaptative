/**
 * The arguments a tool call runs with. Before schema validation the tool's own compatibility shim
 * (`prepareArguments`) runs; after it, the validated arguments choose where the call runs. A call with background forms
 * (`backgroundArguments`) starts as a background session task in its background form when the host can hand calls off
 * now, and otherwise runs in its foreground form. A nested call (one tool calling another) is never handed off, so its
 * host chooses with no handoff and it always runs in its foreground form.
 */

import type { AgentLoopConfig, BackgroundToolCallContext } from "./loop-config.ts";
import type { AgentTool, AgentToolCall, ToolCallBackgroundForms } from "./types.ts";

/**
 * A call's run form: the arguments it runs with and, for a call that starts as a background task, why (the tool's
 * reason when its caller did not ask) and the foreground form it runs in if the handoff does not happen.
 */
export interface ToolCallForm {
	readonly arguments: Record<string, any>;
	readonly background?: { readonly reason?: string; readonly foreground: Record<string, any> };
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

/** The form a call runs in, chosen from its validated arguments; both forms are schema-valid, so neither is re-validated. */
export function toolCallForm(tool: AgentTool<any>, args: Record<string, any>, canHandOff: boolean): ToolCallForm {
	const forms = tool.backgroundArguments?.(args) as ToolCallBackgroundForms<Record<string, any>> | undefined;
	if (forms === undefined) return { arguments: args };
	if (!canHandOff) return { arguments: forms.foreground };
	const reason = forms.reason === undefined ? {} : { reason: forms.reason };
	return { arguments: forms.background, background: { ...reason, foreground: forms.foreground } };
}

/**
 * A prepared call across its handoff. A call prepared in its background form starts its body only once the handoff is
 * decided: handed off, it runs in that form; refused, or no longer possible, it runs in its foreground form, so a
 * background form never runs in the foreground. Any other call starts at once in the form it was prepared in.
 */
export interface ToolCallHandoff {
	/** Whether the host can hand this call off at all: it can now, and something would move the call. */
	readonly canHandOff: boolean;
	/** When the clock moves the call: at once for a call prepared in its background form, else the operator's delay. */
	readonly delayMs: number | undefined;
	/** Settles when the body may start. */
	readonly decided: Promise<void>;
	/** What moves the call if it is handed off now: the host by hand, the model's request, the tool, or the clock. */
	trigger(manual: boolean): Pick<BackgroundToolCallContext, "trigger" | "reason">;
	/** The handoff was accepted: the body starts in the form the call was prepared in. */
	handedOff(): void;
	/** The call stays in the foreground: the body starts in its foreground form. Returns `completion`. */
	inForeground<T>(completion: T): T;
}

export function toolCallHandoff(
	call: { args: unknown; background: ToolCallForm["background"] },
	config: AgentLoopConfig,
): ToolCallHandoff {
	const background = call.background;
	const delayMs = background !== undefined ? 0 : backgroundToolCallDelay(config);
	let start = (): void => {};
	const decided =
		background === undefined
			? Promise.resolve()
			: new Promise<void>((resolve) => {
					start = resolve;
				});
	return {
		canHandOff:
			canHandOffToolCalls(config) && (delayMs !== undefined || config.subscribeToolCallHandoffRequest !== undefined),
		delayMs,
		decided,
		trigger(manual) {
			if (manual) return { trigger: "manual" };
			if (background === undefined) return { trigger: "clock" };
			return background.reason === undefined
				? { trigger: "requested" }
				: { trigger: "tool", reason: background.reason };
		},
		handedOff: () => start(),
		inForeground(completion) {
			if (call.background !== undefined) {
				call.args = call.background.foreground;
				call.background = undefined;
			}
			start();
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
