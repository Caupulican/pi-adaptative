/** Select the memory records visible to a provider request, retaining the proven prefix across turns. */
import type { AgentMessage } from "../../kernel/index.ts";
import { VersionedMessageFilter } from "../../kernel/prefix-fold.ts";
import { TRANSCRIPT_FRONTIER_CUSTOM_TYPE } from "./transcript-memory-contracts.ts";

/** Durable record kind carrying the tiered memory evidence block (and its cleared form). */
export const MEMORY_EVIDENCE_CUSTOM_TYPE = "memory_evidence";

function hiddenFromProvider(message: AgentMessage, icm: boolean): boolean {
	if (message.role !== "custom") return false;
	if (message.customType === "pipeline_context") {
		const mode = (message.details as { contextMode?: string } | undefined)?.contextMode ?? "inline";
		return mode !== (icm ? "on-demand" : "inline");
	}
	return (
		icm &&
		[
			"memory_context",
			MEMORY_EVIDENCE_CUSTOM_TYPE,
			TRANSCRIPT_FRONTIER_CUSTOM_TYPE,
			"user_persona",
			"reflection_cue",
			"reflection_turn_trigger",
		].includes(message.customType)
	);
}

export class ProviderContextVisibility extends VersionedMessageFilter {
	constructor(icm: boolean) {
		super((message) => hiddenFromProvider(message, icm));
	}
}
