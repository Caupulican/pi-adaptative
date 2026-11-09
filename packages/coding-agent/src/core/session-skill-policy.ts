import type { SessionEntry } from "../kernel/node.ts";
import { resolveAutoLearnSettings } from "./learning/auto-learn-settings.ts";
import type { AutoLearnSettings, AutonomyMode } from "./settings/settings-schema.ts";
import { utf8PrefixByBytes } from "./util/bounded-value.ts";
import { isPlainRecord } from "./util/value-guards.ts";

export const SESSION_SKILL_POLICY_CUSTOM_TYPE = "session_skill_policy";
export const MAX_SESSION_SKILL_EXCLUSIONS = 64;
export const MAX_SKILL_EXCLUSION_REASON_BYTES = 512;
export const MAX_SKILL_NAME_CHARS = 128;

export interface SkillExclusionRecord {
	name: string;
	reason: string;
	excludedAt: string;
	sessionId: string;
}

export interface SessionSkillPolicyPayload {
	version: 1;
	sessionId: string;
	exclusions: SkillExclusionRecord[];
}

/** What a skill vault reads of its session: the session's exclusions are replayed from these entries. */
export interface SessionSkillPolicyReader {
	getSessionId(): string;
	getEntryCount(): number;
	getEntriesSince(startIndex: number): SessionEntry[];
}

export interface SessionSkillPolicyPort extends SessionSkillPolicyReader {
	appendCustomEntry(customType: string, data: unknown): string;
}

export function isValidSkillName(name: string): boolean {
	if (typeof name !== "string") return false;
	const trimmed = name.trim();
	if (trimmed.length === 0 || trimmed.length > MAX_SKILL_NAME_CHARS) return false;
	if (/[\x00-\x1f\x7f]/.test(trimmed)) return false;
	return true;
}

export function boundReasonInBytes(reason: string, maxBytes = MAX_SKILL_EXCLUSION_REASON_BYTES): string {
	const trimmed = reason.trim();
	if (!trimmed) return "";
	return utf8PrefixByBytes(trimmed, maxBytes);
}

export function isSkillExclusionRecord(value: unknown, expectedSessionId?: string): value is SkillExclusionRecord {
	if (!isPlainRecord(value)) return false;
	if (typeof value.name !== "string" || !isValidSkillName(value.name)) return false;
	if (typeof value.reason !== "string") return false;
	const boundedReason = boundReasonInBytes(value.reason);
	if (!boundedReason) return false;
	if (typeof value.excludedAt !== "string" || !value.excludedAt.trim()) return false;
	if (typeof value.sessionId !== "string" || !value.sessionId.trim()) return false;
	if (expectedSessionId !== undefined && value.sessionId !== expectedSessionId) return false;
	return true;
}

export function decodeSessionSkillPolicyPayload(
	data: unknown,
	expectedSessionId?: string,
): SessionSkillPolicyPayload | undefined {
	if (!isPlainRecord(data) || data.version !== 1 || typeof data.sessionId !== "string" || !data.sessionId.trim()) {
		return undefined;
	}
	if (expectedSessionId !== undefined && data.sessionId !== expectedSessionId) {
		return undefined;
	}
	if (!Array.isArray(data.exclusions) || data.exclusions.length > MAX_SESSION_SKILL_EXCLUSIONS) {
		return undefined;
	}
	const exclusions: SkillExclusionRecord[] = [];
	const seenNames = new Set<string>();
	for (const item of data.exclusions) {
		if (!isSkillExclusionRecord(item, data.sessionId)) continue;
		const normalizedName = item.name.trim();
		if (seenNames.has(normalizedName)) continue;
		seenNames.add(normalizedName);
		exclusions.push({
			name: normalizedName,
			reason: boundReasonInBytes(item.reason),
			excludedAt: item.excludedAt,
			sessionId: item.sessionId,
		});
	}
	return {
		version: 1,
		sessionId: data.sessionId,
		exclusions,
	};
}

export function appendSessionSkillExclusion(
	sessionManager: Pick<SessionSkillPolicyPort, "getSessionId" | "appendCustomEntry">,
	currentExclusions: readonly SkillExclusionRecord[],
	newExclusion: { name: string; reason: string },
): { payload: SessionSkillPolicyPayload; record: SkillExclusionRecord } {
	const sessionId = sessionManager.getSessionId();
	const normalizedName = newExclusion.name.trim();
	if (!isValidSkillName(normalizedName)) {
		throw new Error(`Invalid skill name: "${newExclusion.name}"`);
	}
	const boundedReason = boundReasonInBytes(newExclusion.reason);
	if (!boundedReason) {
		throw new Error("Exclusion reason cannot be blank");
	}
	const record: SkillExclusionRecord = {
		name: normalizedName,
		reason: boundedReason,
		excludedAt: new Date().toISOString(),
		sessionId,
	};
	const existingWithoutName = currentExclusions.filter((e) => e.name !== normalizedName && e.sessionId === sessionId);
	if (existingWithoutName.length >= MAX_SESSION_SKILL_EXCLUSIONS) {
		throw new Error(`Maximum session skill exclusions (${MAX_SESSION_SKILL_EXCLUSIONS}) reached`);
	}
	const exclusions = [...existingWithoutName, record];
	const payload: SessionSkillPolicyPayload = {
		version: 1,
		sessionId,
		exclusions,
	};
	sessionManager.appendCustomEntry(SESSION_SKILL_POLICY_CUSTOM_TYPE, payload);
	return { payload, record };
}

/** An edit of the body of a skill that already exists, with the names of the skills this session has loaded. */
export interface SkillBodyEdit {
	name: string;
	loadedSkillNames: readonly string[];
}

/**
 * `ineligible`: the autonomy mode or autoLearn settings forbid skill evolution.
 * `proposal`: evolution is permitted, but the edit targets a skill this session never loaded; it stays a proposal.
 */
export type SkillEvolutionEligibility =
	| { eligible: true; reason: string }
	| { eligible: false; disposition: "ineligible" | "proposal"; reason: string };

/**
 * The skill-evolution rule. The autonomy mode and autoLearn settings decide whether skills may change at all. Editing
 * the body of an existing skill (`existingSkill`) also requires that this session loaded that skill: a membership
 * fact, so an edit of a skill the session did not load is a proposal, never a write. Creating a skill passes no
 * `existingSkill`; the create path refuses an existing file on its own.
 */
export function checkSkillEvolutionEligibility(
	autonomyMode: AutonomyMode,
	autoLearnSettings?: AutoLearnSettings,
	existingSkill?: SkillBodyEdit,
): SkillEvolutionEligibility {
	if (autonomyMode === "off") {
		return {
			eligible: false,
			disposition: "ineligible",
			reason: "autonomy mode is off; skill evolution requires owner approval",
		};
	}
	const resolved = resolveAutoLearnSettings(autonomyMode, autoLearnSettings);
	if (!resolved.enabled) {
		return { eligible: false, disposition: "ineligible", reason: "autoLearn is disabled in settings" };
	}
	if (!resolved.applyHighConfidence) {
		return { eligible: false, disposition: "ineligible", reason: "applyHighConfidence is disabled in settings" };
	}
	if (existingSkill && !existingSkill.loadedSkillNames.includes(existingSkill.name)) {
		return {
			eligible: false,
			disposition: "proposal",
			reason: `skill "${existingSkill.name}" was not loaded in this session, so its body was not edited; the update is kept as a proposal for the owner`,
		};
	}
	return { eligible: true, reason: `permitted by autonomy mode ${autonomyMode} and autoLearn settings` };
}
