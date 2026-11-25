/** Path legend facts and inert control records that may outlive one continuous-chat turn. */

import {
	TOOL_FAILURE_LEDGER_CLEARED_TEXT,
	TOOL_FAILURE_LEDGER_TRANSIENT_KIND,
} from "../../kernel/tool-failure-memory.ts";
import { readTransientRecordPayload, TRANSIENT_RECORD_SUPERSEDING_NOTE } from "../../kernel/transient-records.ts";
import type { AgentMessage } from "../../kernel/types.ts";
import {
	VERIFICATION_OBLIGATION_TRANSIENT_KIND,
	VERIFICATION_OBLIGATIONS_CLEARED_TEXT,
} from "../../kernel/verification-obligations.ts";
import { COMMS_RECORD_VERSION } from "../comms/comms-records.ts";
import {
	type PathAliasLegendEntry,
	readPathAliasLegendRecord,
	renderPathAliasLegend,
	renderPathAliasLegendFrame,
} from "../comms/host-injection-records.ts";
import { PATH_ALIAS_LEGEND_CUSTOM_TYPE } from "../context/path-alias-table.ts";
import { replayableDiscoveredSkill } from "../skill-header-record.ts";
import { isPlainRecord } from "../util/value-guards.ts";

function isSettledControl(message: Extract<AgentMessage, { role: "custom" }>): boolean {
	const cleared =
		message.customType === TOOL_FAILURE_LEDGER_TRANSIENT_KIND
			? TOOL_FAILURE_LEDGER_CLEARED_TEXT
			: message.customType === VERIFICATION_OBLIGATION_TRANSIENT_KIND
				? VERIFICATION_OBLIGATIONS_CLEARED_TEXT
				: undefined;
	return (
		cleared !== undefined &&
		isPlainRecord(message.details) &&
		message.details.superseding === true &&
		readTransientRecordPayload(message.details) === undefined &&
		message.content === cleared + TRANSIENT_RECORD_SUPERSEDING_NOTE
	);
}

export function replayableAliasLegend(
	message: AgentMessage,
	frame: boolean,
): readonly PathAliasLegendEntry[] | undefined {
	if (message.role !== "custom" || message.customType !== PATH_ALIAS_LEGEND_CUSTOM_TYPE) return undefined;
	const record = readPathAliasLegendRecord(readTransientRecordPayload(message.details));
	if (!record || !isPlainRecord(message.details) || message.details.cumulative !== true || record.paused === true)
		return undefined;
	if (frame ? record.paused !== undefined || record.resumed !== undefined : record.paused === undefined)
		return undefined;
	const expected = frame ? renderPathAliasLegendFrame(record.entries) : renderPathAliasLegend(record);
	return message.content === expected ? record.entries : undefined;
}

/** Current activity cues and ordinary one-shot transients start a fresh window. */
export function replayableBodyAliases(
	messages: readonly AgentMessage[],
	transient: boolean,
): PathAliasLegendEntry[] | undefined {
	const entries: PathAliasLegendEntry[] = [];
	for (const message of messages) {
		if (message.role === "custom") {
			if (isSettledControl(message) || replayableDiscoveredSkill(message) !== undefined) continue;
			const aliases = replayableAliasLegend(message, false);
			if (aliases) {
				for (const alias of aliases) entries.push(alias);
				continue;
			}
		}
		if (transient || (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult"))
			return undefined;
	}
	return entries;
}

/** Union only mappings whose exact path spelling never changed. */
export function mergeRetainedAliases(
	earlier: readonly PathAliasLegendEntry[],
	next: readonly PathAliasLegendEntry[],
): Map<string, string> | undefined {
	const entries = new Map(earlier.map(({ id, path }) => [id, path]));
	for (const { id, path } of next) {
		const existing = entries.get(id);
		if (existing !== undefined && existing !== path) return undefined;
		entries.set(id, path);
	}
	return entries;
}

export function renderRetainedAliasAdditions(entries: readonly PathAliasLegendEntry[]): string {
	return renderPathAliasLegend({ v: COMMS_RECORD_VERSION, k: "path_alias_legend", paused: false, entries });
}
