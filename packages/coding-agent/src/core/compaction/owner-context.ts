/** Foreground compaction's current goal and exact source-validated branch-local historical owner inputs. */

import { isCompactionReversal } from "../../kernel/compaction/extraction.ts";
import type { CompactionOwnerHistoryContext, CompactionOwnerInput } from "../../kernel/compaction/owner-history.ts";
import {
	boundCompactionOwnerHistory,
	COMPACTION_OWNER_INPUT_MAX_CHARS,
	readCompactionOwnerHistory,
} from "../../kernel/compaction/owner-history.ts";
import type { AgentMessage } from "../../kernel/types.ts";
import { type GoalState, isGoalExecutionActive } from "../goals/goal-state.ts";
import {
	getOwnerEvidenceSnapshots,
	isCompleteOwnerSource,
	ownerShownRegions,
} from "../learning/owner-evidence-ledger.ts";
import { scanContextFileThreats, stripInvisibleUnicode } from "../security/context-threat-scanner.ts";
import { redactKnownSecrets, redactTokenShapes } from "../security/secret-text.ts";
import { type SessionStanding, sessionCapabilities } from "../session-standing.ts";
import { entryTurnOrigin, type RunTurnOrigin } from "../turn-origin.ts";
import { compactionEntryDetails } from "./compaction-entry-details.ts";
import type { SelfCompactionController } from "./self-compaction-controller.ts";

export function projectCompactionOwnerHistory(context: CompactionOwnerHistoryContext): CompactionOwnerInput[] {
	const originals = new Map(getOwnerEvidenceSnapshots(context.entries).map((record) => [record.entryId, record]));
	const previous = new Map(
		readCompactionOwnerHistory(context.previousDetails).map((record) => [record.entryId, record]),
	);
	const records: CompactionOwnerInput[] = [];
	for (let index = 0; index < context.entries.length; index++) {
		const entry = context.entries[index]!;
		const origin = entryTurnOrigin(entry);
		if (
			entry.type !== "message" ||
			entry.message.role !== "user" ||
			entry.workerControl !== undefined ||
			!origin ||
			origin.thirdParty ||
			(origin.k !== "owner-typed" && (origin.k !== "owner-channel" || origin.verified !== true))
		)
			continue;
		const source = originals.get(entry.id);
		if (
			!isCompleteOwnerSource(source) ||
			source.text.length > COMPACTION_OWNER_INPUT_MAX_CHARS ||
			!source.text.trim() ||
			(typeof entry.message.content !== "string" && entry.message.content.some((part) => part.type !== "text")) ||
			source.pasted?.length ||
			ownerShownRegions(source).some((region) => !region.inlineCode) ||
			stripInvisibleUnicode(source.text).cleaned !== source.text ||
			scanContextFileThreats(source.text).length ||
			redactKnownSecrets(redactTokenShapes(source.text)) !== source.text
		)
			continue;
		if (isCompactionReversal(source.text)) records.length = 0;
		if (index >= context.end || entry.id === context.retainedEntryId) continue;
		const record: CompactionOwnerInput = {
			entryId: entry.id,
			sourceId: source.sourceId,
			digest: source.digest,
			createdAt: source.createdAt,
			text: source.text,
		};
		const prior = previous.get(entry.id);
		if (
			index < context.start &&
			(!prior ||
				prior.sourceId !== record.sourceId ||
				prior.digest !== record.digest ||
				prior.createdAt !== record.createdAt ||
				prior.text !== record.text)
		)
			continue;
		records.push(record);
	}
	return boundCompactionOwnerHistory(records);
}

export function compactionOwnerContext(
	standing: SessionStanding,
	read: {
		goal(): GoalState | undefined;
		authority(): ReturnType<RunTurnOrigin["authority"]>;
		messages(): readonly AgentMessage[];
		handoff(): Pick<SelfCompactionController, "compactionDetails">;
	},
) {
	return {
		decorateCompactionDetails: (details: unknown) => compactionEntryDetails(details, read.messages(), read.handoff()),
		getActiveTask: () => {
			const goal = read.goal();
			return goal && isGoalExecutionActive(goal.status) ? goal.userGoal : undefined;
		},
		projectOwnerHistory: (context: CompactionOwnerHistoryContext) =>
			sessionCapabilities(standing).ownsWorkLifecycle && read.authority() !== "third-party"
				? projectCompactionOwnerHistory(context)
				: [],
	};
}
