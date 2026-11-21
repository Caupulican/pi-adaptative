/** Composes the existing current-persona transient without turning guidance into permission. */
import type { AgentMessage } from "../../kernel/types.ts";
import type { MemoryPromptBudget } from "../context/memory-prompt-budget.ts";
import { type FileStoreProvider, USER_PERSONA_CUSTOM_TYPE } from "./providers/file-store.ts";

export function userPersonaRecords(input: {
	writer: FileStoreProvider | undefined;
	withheld: boolean;
	enabled: boolean;
	budget: MemoryPromptBudget | undefined;
	record(type: string, text: string, cleared: boolean): AgentMessage;
}): AgentMessage[] {
	const { writer, record } = input;
	if (!writer) return [];
	if (input.withheld)
		return [
			record(
				USER_PERSONA_CUSTOM_TYPE,
				"USER PERSONA: withheld from this run, which carries a third party's words; earlier persona records are stale.",
				true,
			),
		];
	if (!input.enabled)
		return [
			record(
				USER_PERSONA_CUSTOM_TYPE,
				"USER PERSONA: memory is disabled or excluded from the prompt in this session; earlier persona records are stale.",
				true,
			),
		];
	const projection = writer.userPersonaProjection(input.budget);
	if (!projection) return [];
	if (!projection.changed)
		return projection.content === undefined ? [] : [record(USER_PERSONA_CUSTOM_TYPE, projection.content, true)];
	if (projection.content !== undefined) return [record(USER_PERSONA_CUSTOM_TYPE, projection.content, false)];
	return [
		record(
			USER_PERSONA_CUSTOM_TYPE,
			projection.unavailable
				? "USER PERSONA: some preference sources are unavailable or outside this snapshot. Current guidance is incomplete; do not infer removals from missing lines."
				: `USER PERSONA: USER.md changed (revision ${projection.revision}) beyond this model's memory budget; earlier persona records are stale. Read USER.md when preferences matter.`,
			false,
		),
	];
}
