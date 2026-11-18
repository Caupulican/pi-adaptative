/** Select the memory records visible to a provider request, retaining the proven prefix across turns. */
import { countHistoryWork, inheritHistoryWork } from "@caupulican/pi-ai/history-work";
import type { AgentMessage } from "../../kernel/index.ts";
import {
	type MessageHistoryVersion,
	messageHistoryVersion,
	registerProjectedMessageHistory,
	unchangedMessagePrefix,
} from "../../kernel/message-revision.ts";
import { PrefixFirstMatchByFirstItem } from "../../kernel/prefix-fold.ts";
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

interface FilteredProviderHistory {
	readonly sourceVersion: MessageHistoryVersion;
	readonly sourceLength: number;
	readonly projectedVersion: MessageHistoryVersion;
	readonly projected: AgentMessage[];
}

export class ProviderContextVisibility {
	private readonly firstHidden = new PrefixFirstMatchByFirstItem((message: AgentMessage) =>
		hiddenFromProvider(message, this.icm),
	);
	private readonly projections = new WeakMap<AgentMessage, FilteredProviderHistory>();

	private readonly icm: boolean;

	constructor(icm: boolean) {
		this.icm = icm;
	}

	filter(messages: AgentMessage[], reuseCertifiedHistory: boolean): AgentMessage[] {
		const sourceVersion = reuseCertifiedHistory ? messageHistoryVersion(messages) : undefined;
		const first = sourceVersion ? messages[0] : undefined;
		if (!sourceVersion || !first) return messages.filter((message) => !hiddenFromProvider(message, this.icm));
		if (this.firstHidden.find(messages) < 0) return messages;

		const previous = this.projections.get(first);
		if (previous?.sourceVersion === sourceVersion) {
			inheritHistoryWork(messages, previous.projected);
			return previous.projected;
		}
		const retained =
			previous && unchangedMessagePrefix(previous.sourceVersion, sourceVersion) >= previous.sourceLength
				? previous
				: undefined;
		const projected = retained ? retained.projected.slice() : [];
		const prefix = projected.length;
		for (let index = retained?.sourceLength ?? 0; index < messages.length; index++) {
			const message = messages[index]!;
			if (!hiddenFromProvider(message, this.icm)) projected.push(message);
		}
		countHistoryWork(messages, "copiedRows", prefix);
		inheritHistoryWork(messages, projected);
		const projectedVersion = registerProjectedMessageHistory(projected, retained?.projectedVersion, prefix);
		this.projections.set(first, { sourceVersion, sourceLength: messages.length, projectedVersion, projected });
		return projected;
	}
}
