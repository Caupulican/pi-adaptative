/**
 * What the owner is told when automatic collection changes accepted knowledge: the changes a pass carries, bounded, and
 * the plain lines that name them. One owner of the wording; the notice itself is delivered by the session as an
 * owner-facing line that no model request carries.
 */
import { resolveAutoLearnSettings } from "../learning/auto-learn-settings.ts";
import type { AutoLearnSettings, AutonomySettings } from "../settings/settings-schema.ts";
import type { KnowledgeCollectionHandoff, KnowledgeCollectionOutcome } from "./knowledge-collector.ts";
import type { KnowledgeKind, KnowledgeMutationReceipt } from "./knowledge-record.ts";

/** Lines a pass names one by one; the rest is counted. */
export const MAX_ANNOUNCED_CHANGES = 3;
const MAX_FACT_CHARS = 160;
const SHORT_ID_CHARS = 8;

/** One accepted change, as the store committed it. The text is already one bounded line. */
export interface AnnouncedKnowledgeChange {
	readonly kind: KnowledgeKind;
	readonly id: string;
	readonly text: string;
	/** The identity held a live value before: the fact was updated, not learned. */
	readonly existed: boolean;
}

/** What a pass carries: the first changes in commit order, and how many came after them. */
export interface KnowledgeChangeDigest {
	readonly changes: readonly AnnouncedKnowledgeChange[];
	readonly more: number;
}

export function oneLine(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length <= MAX_FACT_CHARS ? line : `${line.slice(0, MAX_FACT_CHARS - 1).trimEnd()}…`;
}

/** Adds one applied change to a digest. A forgotten or replayed commit changed nothing new and is not carried. */
export function withAppliedChange(
	digest: KnowledgeChangeDigest,
	receipt: KnowledgeMutationReceipt,
): KnowledgeChangeDigest {
	const committed = receipt.committed;
	if (!committed) return digest;
	if (digest.changes.length >= MAX_ANNOUNCED_CHANGES) return { ...digest, more: digest.more + 1 };
	return {
		changes: [
			...digest.changes,
			{ kind: committed.kind, id: receipt.id, text: oneLine(committed.text), existed: committed.existed },
		],
		more: digest.more,
	};
}

export const EMPTY_CHANGE_DIGEST: KnowledgeChangeDigest = { changes: [], more: 0 };

/** The owner's lines for one pass: one per carried change, then one for the rest. */
export function announcementLines(digest: KnowledgeChangeDigest): string[] {
	const lines = digest.changes.map(
		(change) =>
			`${change.existed ? "Updated" : "Learned"} (${change.kind}): ${change.text}  /knowledge show ${change.id.slice(0, SHORT_ID_CHARS)}`,
	);
	if (digest.more > 0) lines.push(`and ${digest.more} more: /knowledge list`);
	return lines;
}

export type KnowledgeCollectionEvent = {
	type: "knowledge_collection";
	handoff?: KnowledgeCollectionHandoff;
} & KnowledgeCollectionOutcome;
export type KnowledgeAnnouncementEvent = { type: "warning"; message: string; severity: "info" };

/**
 * Emits a pass's terminal event, then the owner's lines for what it changed. A line is an informational session event:
 * it is not a message, so no model request carries it, and nothing records it as evidence, history or knowledge.
 */
export function emitKnowledgeCollection(
	terminal: {
		outcome: KnowledgeCollectionOutcome;
		handoff?: KnowledgeCollectionHandoff;
		changes?: KnowledgeChangeDigest;
	},
	settings: {
		getAutonomySettings(): { mode: AutonomySettings["mode"] & string };
		getAutoLearnSettings(): AutoLearnSettings;
	},
	emit: (event: KnowledgeCollectionEvent | KnowledgeAnnouncementEvent) => void,
): void {
	emit({ type: "knowledge_collection", ...terminal.outcome, handoff: terminal.handoff });
	if (!resolveAutoLearnSettings(settings.getAutonomySettings().mode, settings.getAutoLearnSettings()).announce) return;
	for (const message of announcementLines(terminal.changes ?? EMPTY_CHANGE_DIGEST))
		emit({ type: "warning", message, severity: "info" });
}

/** The collector's terminal hook for a session: the pass's event and lines, then the session's own follow-up. */
export function knowledgeTerminalHook(
	settings: Parameters<typeof emitKnowledgeCollection>[1],
	emit: Parameters<typeof emitKnowledgeCollection>[2],
	afterwards: () => void,
): (
	outcome: KnowledgeCollectionOutcome,
	handoff?: KnowledgeCollectionHandoff,
	changes?: KnowledgeChangeDigest,
) => void {
	return (outcome, handoff, changes) => {
		emitKnowledgeCollection({ outcome, handoff, changes }, settings, emit);
		afterwards();
	};
}
