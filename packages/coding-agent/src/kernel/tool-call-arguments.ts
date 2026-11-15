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
 * A call's run form: the arguments it runs with, and whether it starts as a background task (with the tool's reason when
 * its caller did not ask).
 */
export interface ToolCallForm {
	readonly arguments: Record<string, any>;
	readonly background?: { readonly reason?: string };
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
	return { arguments: forms.background, background: forms.reason === undefined ? {} : { reason: forms.reason } };
}

/** What moved a handed-off call: the host by hand, the model's request, the tool (with its reason), or the clock. */
export function handoffTrigger(
	manual: boolean,
	background: ToolCallForm["background"],
): Pick<BackgroundToolCallContext, "trigger" | "reason"> {
	if (manual) return { trigger: "manual" };
	if (background === undefined) return { trigger: "clock" };
	return background.reason === undefined ? { trigger: "requested" } : { trigger: "tool", reason: background.reason };
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
