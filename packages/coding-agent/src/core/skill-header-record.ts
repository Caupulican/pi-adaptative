/** Defines the canonical discovered-skill record identities that may be carried across provider requests. */
import { transientRecordDigest } from "../kernel/transient-record-decision.ts";
import {
	isTransientRecordPacked,
	readTransientRecordPayload,
	TRANSIENT_RECORD_SUPERSEDING_NOTE,
} from "../kernel/transient-records.ts";
import type { AgentMessage } from "../kernel/types.ts";
import { isPlainRecord } from "./util/value-guards.ts";

export const DISCOVERED_SKILL_RECORD_KIND = "discovered_skill";
export const DISCOVERED_SKILL_RECORD_KIND_PREFIX = "discovered_skill_header:";

export function clearedDiscoveredSkillText(slot: string): string {
	return `DISCOVERED SKILL [${slot}] cleared. Search the vault again if needed.`;
}

export function discoveredSkillDigest(section: string, sourceId: string, order: number): string {
	return transientRecordDigest(JSON.stringify([section, sourceId, order]));
}

export function isDiscoveredSkillRecord(message: AgentMessage): message is Extract<AgentMessage, { role: "custom" }> {
	return message.role === "custom" && message.customType.startsWith(DISCOVERED_SKILL_RECORD_KIND_PREFIX);
}

/** Full active record digest, null for a valid clear, or undefined when the wire cannot replay it. */
export function replayableDiscoveredSkill(message: AgentMessage): string | null | undefined {
	if (!isDiscoveredSkillRecord(message) || typeof message.content !== "string") return undefined;
	const details = message.details;
	if (
		!isPlainRecord(details) ||
		details.superseding !== true ||
		typeof details.digest !== "string" ||
		isTransientRecordPacked(details) ||
		!message.content.endsWith(TRANSIENT_RECORD_SUPERSEDING_NOTE)
	)
		return undefined;
	const slot = message.customType.slice(DISCOVERED_SKILL_RECORD_KIND_PREFIX.length);
	const section = message.content.slice(0, -TRANSIENT_RECORD_SUPERSEDING_NOTE.length);
	const record = readTransientRecordPayload(details);
	if (!record) {
		return section === clearedDiscoveredSkillText(slot) && details.digest === transientRecordDigest(section)
			? null
			: undefined;
	}
	if (record.v !== 1 || record.k !== DISCOVERED_SKILL_RECORD_KIND || !isPlainRecord(record)) return undefined;
	const { name, sourceId, order } = record;
	if (
		typeof name !== "string" ||
		typeof sourceId !== "string" ||
		typeof order !== "number" ||
		!Number.isSafeInteger(order) ||
		order <= 0 ||
		!section.startsWith(`DISCOVERED SKILL [${slot}] ${JSON.stringify(name)}\n`)
	) {
		return undefined;
	}
	return details.digest === discoveredSkillDigest(section, sourceId, order) ? details.digest : undefined;
}
