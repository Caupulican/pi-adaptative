/**
 * Where a bash call runs: as a background session task or in the foreground. A call that sets `background: true` asks for
 * a task; a call that leaves `background` unset and only waits on state outside the session (`isExternalWaitCommand`)
 * is moved to one, so the wait never holds the turn and its exit arrives through the task's completion wake;
 * `background: false` keeps a call in the foreground. Where no task can start, the call runs in its foreground form
 * (no `background`): the foreground's bound and the session shell.
 */

import { requestedBackgroundForms } from "../../kernel/tool-call-arguments.ts";
import type { ToolCallBackgroundForms } from "../../kernel/types.ts";
import { isExternalWaitCommand } from "./command-family.ts";
import type { BashToolInput } from "./schemas/bash.ts";

/** Why bash moves a call the model did not ask to background: shown in the call's handoff result. */
export const EXTERNAL_WAIT_REASON = "it waits on outside state";

export function bashBackgroundArguments(input: BashToolInput): ToolCallBackgroundForms<BashToolInput> | undefined {
	if (typeof input?.command !== "string") return undefined;
	const requested = requestedBackgroundForms(input);
	if (requested !== undefined || input.background !== undefined || !isExternalWaitCommand(input.command))
		return requested;
	return { background: { ...input, background: true }, foreground: input, reason: EXTERNAL_WAIT_REASON };
}
