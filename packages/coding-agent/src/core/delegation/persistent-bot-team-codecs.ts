/**
 * The bot record, the team record and the group message as the store persists them, decoded from what this build and older
 * builds wrote: a stored value that cannot be trusted is rejected here, not repaired. The identifier pattern the three
 * records share lives here too, because a stored identifier is read here first. The store holds the live state, the file
 * and every mutation; this module only reads a value out of the file.
 */
import { isRecordObject } from "../util/value-guards.ts";
import type {
	PersistentBotRecord,
	PersistentTeamMemberDelivery,
	PersistentTeamMessage,
	PersistentTeamRecord,
} from "./persistent-bot-team-store.ts";

/** The identifier domain bots, teams and their stored records share. */
export const BOT_OR_TEAM_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** What a member's delivery did: started a runtime, steered it, ran a follow-up turn, waited for room, or failed. */
const DELIVERY_OUTCOMES: ReadonlySet<string> = new Set(["started", "steering", "followed_up", "queued", "failed"]);

function isDeliveryOutcome(value: unknown): value is PersistentTeamMemberDelivery["outcome"] {
	return typeof value === "string" && DELIVERY_OUTCOMES.has(value);
}

export function parseBotRecord(value: unknown): PersistentBotRecord | undefined {
	if (!isRecordObject(value)) {
		return undefined;
	}
	const {
		agentId,
		displayName,
		description,
		provider,
		modelId,
		thinkingLevel,
		soul: storedSoul,
		instructions: legacyInstructions,
		profileId,
		canWrite,
		leader,
		createdBy,
		remote,
		createdAt,
		updatedAt,
		retired,
		lastTranscriptRef,
		lastSummary,
		lastMessageAt,
		lastReadAt,
		lastNotice,
	} = value;
	// Records written before the soul concept stored the same text under `instructions`; the next save writes `soul`.
	const soul = storedSoul ?? legacyInstructions;

	if (
		typeof agentId !== "string" ||
		!BOT_OR_TEAM_ID_REGEX.test(agentId) ||
		typeof displayName !== "string" ||
		typeof provider !== "string" ||
		typeof modelId !== "string" ||
		typeof createdAt !== "string" ||
		typeof updatedAt !== "string"
	) {
		return undefined;
	}

	return {
		agentId,
		displayName,
		description: typeof description === "string" ? description : undefined,
		provider,
		modelId,
		thinkingLevel: typeof thinkingLevel === "string" ? thinkingLevel : undefined,
		soul: typeof soul === "string" ? soul : undefined,
		profileId: typeof profileId === "string" ? profileId : undefined,
		canWrite: typeof canWrite === "boolean" ? canWrite : undefined,
		leader: typeof leader === "boolean" ? leader : undefined,
		createdBy: typeof createdBy === "string" && createdBy.length > 0 ? createdBy : undefined,
		remote: remote === true ? true : undefined,
		createdAt,
		updatedAt,
		retired: typeof retired === "boolean" ? retired : undefined,
		lastTranscriptRef: typeof lastTranscriptRef === "string" ? lastTranscriptRef : undefined,
		lastSummary: typeof lastSummary === "string" ? lastSummary : undefined,
		lastMessageAt: typeof lastMessageAt === "number" && Number.isFinite(lastMessageAt) ? lastMessageAt : undefined,
		lastReadAt: typeof lastReadAt === "number" && Number.isFinite(lastReadAt) ? lastReadAt : undefined,
		lastNotice:
			isRecordObject(lastNotice) &&
			typeof lastNotice.at === "number" &&
			Number.isFinite(lastNotice.at) &&
			typeof lastNotice.text === "string"
				? { at: lastNotice.at, text: lastNotice.text }
				: undefined,
	};
}

export function parseTeamRecord(value: unknown): PersistentTeamRecord | undefined {
	if (!isRecordObject(value)) {
		return undefined;
	}
	const {
		teamId,
		incarnationId,
		name,
		description,
		memberAgentIds,
		createdAt,
		updatedAt,
		lastMessageAt,
		lastReadAt,
		memoryFilePath,
	} = value;

	if (
		typeof teamId !== "string" ||
		!BOT_OR_TEAM_ID_REGEX.test(teamId) ||
		typeof createdAt !== "string" ||
		typeof updatedAt !== "string" ||
		(incarnationId !== undefined &&
			(typeof incarnationId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(incarnationId))) ||
		!Array.isArray(memberAgentIds)
	) {
		return undefined;
	}

	const validMembers: string[] = [];
	for (const id of memberAgentIds) {
		if (typeof id === "string" && BOT_OR_TEAM_ID_REGEX.test(id)) {
			validMembers.push(id);
		}
	}

	return {
		teamId,
		...(typeof incarnationId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(incarnationId) ? { incarnationId } : {}),
		name: typeof name === "string" ? name : teamId,
		description: typeof description === "string" ? description : undefined,
		memberAgentIds: validMembers,
		createdAt,
		updatedAt,
		lastMessageAt: typeof lastMessageAt === "number" && Number.isFinite(lastMessageAt) ? lastMessageAt : undefined,
		lastReadAt: typeof lastReadAt === "number" && Number.isFinite(lastReadAt) ? lastReadAt : undefined,
		memoryFilePath: typeof memoryFilePath === "string" ? memoryFilePath : undefined,
	};
}

export function parseTeamMessage(value: unknown): PersistentTeamMessage | undefined {
	if (!isRecordObject(value)) {
		return undefined;
	}
	const { messageId, teamId, teamIncarnationId, sender, text, timestamp, targetAgentIds, deliveries } = value;

	if (
		typeof messageId !== "string" ||
		typeof teamId !== "string" ||
		!BOT_OR_TEAM_ID_REGEX.test(teamId) ||
		typeof text !== "string" ||
		typeof timestamp !== "number" ||
		!Number.isFinite(timestamp) ||
		!isRecordObject(sender) ||
		!Array.isArray(targetAgentIds) ||
		!Array.isArray(deliveries)
	) {
		return undefined;
	}

	let parsedSender: PersistentTeamMessage["sender"] | undefined;
	if (sender.kind === "operator") {
		parsedSender = { kind: "operator" };
	} else if (sender.kind === "brain") {
		parsedSender = { kind: "brain" };
	} else if (sender.kind === "bot" && typeof sender.agentId === "string") {
		parsedSender = { kind: "bot", agentId: sender.agentId };
	}
	if (!parsedSender) {
		return undefined;
	}

	const validTargets: string[] = [];
	for (const t of targetAgentIds) {
		if (typeof t === "string") {
			validTargets.push(t);
		}
	}

	const validDeliveries: PersistentTeamMemberDelivery[] = [];
	for (const d of deliveries) {
		if (isRecordObject(d) && typeof d.agentId === "string" && isDeliveryOutcome(d.outcome)) {
			validDeliveries.push({
				agentId: d.agentId,
				outcome: d.outcome,
				messageId: typeof d.messageId === "string" ? d.messageId : undefined,
				detail: typeof d.detail === "string" ? d.detail : undefined,
			});
		}
	}

	return {
		messageId,
		teamId,
		...(typeof teamIncarnationId === "string" ? { teamIncarnationId } : {}),
		sender: parsedSender,
		text,
		timestamp,
		targetAgentIds: validTargets,
		deliveries: validDeliveries,
	};
}
