/** Submit bot inbox words under their recorded origin and the matching schedule's cancellation lifetime. */
import type { TurnOriginRecord } from "../../kernel/turn-origin-stamp.ts";
import type { PromptOptions } from "../agent-session-contracts.ts";
import { jobsDir } from "../remote/job-store.ts";
import { submitRoutineScope } from "../remote/routine-job-index.ts";
import { routineJobScopeFromRef, scheduledBotSourceRef } from "../remote/routine-job-origin.ts";
import { recordedMessageOrigin } from "../turn-origin.ts";
import type { BotSessionEntry } from "./bot-session-load.ts";

export async function submitBotPrompt(
	agentDir: string,
	entry: BotSessionEntry,
	text: string,
	queued: boolean,
	origin: TurnOriginRecord | undefined,
	preflightResult: NonNullable<PromptOptions["preflightResult"]>,
): Promise<void> {
	const submit = (signal?: AbortSignal) =>
		entry.session.prompt(text, {
			expandPromptTemplates: false,
			processSlashCommands: false,
			streamingBehavior: queued ? "followUp" : "steer",
			...(origin ? { source: "extension" as const, origin: recordedMessageOrigin(origin) } : {}),
			...(signal ? { signal } : {}),
			preflightResult,
		});
	const ref = scheduledBotSourceRef(origin);
	if (ref) return submitRoutineScope(jobsDir(agentDir), routineJobScopeFromRef(entry.agentId, ref), submit);
	return submit();
}
