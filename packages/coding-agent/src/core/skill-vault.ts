import { type Stats, statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { composeRequestSystemPrompt } from "@caupulican/pi-agent-core/provider-request-planner";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { OWNER_PRECEDENCE_POLICY, SKILL_CONFLICT_RESOLUTION_RULE } from "./provider-prompt-contracts.ts";
import { stripResourceProfileBlocks } from "./resource-profile-blocks.ts";
import {
	appendSessionSkillExclusion,
	boundReasonInBytes,
	decodeSessionSkillPolicyPayload,
	isValidSkillName,
	MAX_SESSION_SKILL_EXCLUSIONS,
	SESSION_SKILL_POLICY_CUSTOM_TYPE,
	type SessionSkillPolicyPort,
	type SkillExclusionRecord,
} from "./session-skill-policy.ts";
import {
	inspectSkillFile,
	repairSkillFile,
	type SkillInspectResult,
	type SkillRepairInput,
	type SkillRepairResult,
} from "./skill-repair.ts";
import {
	MAX_ACTIVE_SKILL_BODY_BYTES,
	MAX_SKILL_FRONTMATTER_BYTES,
	type Skill,
	type SkillFrontmatter,
} from "./skills.ts";
import { readBoundedTextFileSync, sameFileVersion } from "./util/bounded-file.ts";

export { MAX_ACTIVE_SKILL_BODY_BYTES };
export const DEFAULT_SKILL_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
export const MIN_ACTIVE_SKILL_BODY_BYTES = 4 * 1024;
export const MAX_LOADED_SKILLS = 3;
export const MAX_PINNED_SKILLS = 2;
const MAX_SEARCH_RESULTS = 5;
const MAX_SEARCH_DESCRIPTION_CHARS = 240;

type SkillVaultRequester = "model" | "user";
type SkillVaultUnloadReason = "explicit" | "idle_expired" | "resource_unavailable" | "budget_exceeded";
type SkillBodyReadMode = "read" | "load";
type SkillFileStat = Stats;

interface LoadedSkill {
	skill: Skill;
	bodyBytes: number;
	systemPromptSection: string;
	requester: SkillVaultRequester;
	pinned: boolean;
	loadedAtMs: number;
	fileDevice: number;
	fileInode: number;
	fileSize: number;
	fileModifiedAtMs: number;
	fileChangedAtMs: number;
}

type SkillSlotState =
	| ({ state: "loaded_pending" } & LoadedSkill)
	| ({ state: "active"; lastUsedAtMs: number; useCount: number } & LoadedSkill);

export interface SkillSlotStatus {
	state: SkillSlotState["state"];
	name: string;
	pinned: boolean;
	loadedAtMs: number;
	lastUsedAtMs?: number;
	idleForMs?: number;
	expiresInMs?: number;
	useCount?: number;
}

export interface SkillVaultStatus {
	idleTimeoutMs: number;
	slots: SkillSlotStatus[];
	reason?: SkillVaultUnloadReason;
	exclusions?: Array<{ name: string; reason: string }>;
}

export interface SkillSearchResult {
	candidates: Array<{ name: string; description: string }>;
	/** Skills on disk the loader could not index (`<path>: <reason>`), so a broken SKILL.md is visible. */
	diagnostics?: string[];
}

export type SkillLoadResult =
	| {
			ok: true;
			state: "loaded_pending";
			name: string;
			baseDir: string;
			pinned: boolean;
			/** The load asked to pin this skill but the pin cap was already spent; it is resident unpinned. */
			pinCapReached?: true;
			evicted?: string[];
	  }
	| {
			ok: false;
			reason: "not_found" | "body_too_large" | "invalid_body" | "read_failed" | "capacity" | "excluded";
			message: string;
	  };

export type SkillBatchLoadResult =
	| { ok: true; results: Array<Extract<SkillLoadResult, { ok: true }>> }
	| Exclude<SkillLoadResult, { ok: true }>;

export type SkillReadResult =
	| { ok: true; name: string; description: string; body: string }
	| {
			ok: false;
			reason: "not_found" | "body_too_large" | "invalid_body" | "read_failed" | "excluded";
			message: string;
	  };

export type SkillExcludeResult =
	| { ok: true; name: string; reason: string; alreadyExcluded?: boolean }
	| { ok: false; reason: "invalid_name" | "invalid_reason" | "persistence_failed"; message: string };

type SkillReadFailure = Exclude<SkillReadResult, { ok: true }>;
type SkillBodyReadResult = { ok: true; body: string; bodyBytes: number; file: SkillFileStat } | SkillReadFailure;

export interface SkillVaultControllerOptions {
	getSkills(): readonly Skill[];
	/** Full skill inventory, ignoring profile or model eligibility filters, for repairs and audits. */
	getFullSkills?: () => readonly Skill[];
	/**
	 * Re-scan the skill roots. Called once on a lookup miss before refusing: a skill written during
	 * the session (by `skillify`, a write, or the owner) must be loadable in that session (measured
	 * live: two refusals 45 minutes apart for a skill that existed on disk the whole time).
	 */
	refreshSkills?: () => void;
	/** Loader diagnostics for skills that failed to index, rendered as `<path>: <message>`. */
	getSkillDiagnostics?: () => readonly string[];
	now?: () => number;
	idleTimeoutMs?: number;
	getMaxBodyBytes?: () => number;
	onSkillUsed?: (skill: Skill, usedAtMs: number) => void;
	getSessionManager?: () => SessionSkillPolicyPort | undefined;
}

function compactDescription(description: string): string {
	const normalized = description.replace(/\s+/g, " ").trim();
	if (normalized.length <= MAX_SEARCH_DESCRIPTION_CHARS) return normalized;
	return `${normalized.slice(0, MAX_SEARCH_DESCRIPTION_CHARS - 1)}…`;
}

function queryTokens(value: string): string[] {
	return [...new Set(value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
}

function searchScore(skill: Skill, query: string, tokens: readonly string[]): number {
	const name = skill.name.toLowerCase();
	const description = skill.description.toLowerCase();
	let score = name === query ? 100 : name.includes(query) ? 40 : description.includes(query) ? 20 : 0;
	for (const token of tokens) {
		if (name === token) score += 16;
		else if (name.includes(token)) score += 8;
		if (description.includes(token)) score += 3;
	}
	return score;
}

function activeSkillContext(skill: Skill, body: string): string {
	return [
		`ACTIVE SKILL ${skill.name}`,
		`BASE ${skill.baseDir}`,
		`${OWNER_PRECEDENCE_POLICY.replace(/\.$/, "")}: ${SKILL_CONFLICT_RESOLUTION_RULE}`,
		body,
	].join("\n");
}

function slotLastUsedAtMs(slot: SkillSlotState): number {
	return slot.state === "loaded_pending" ? slot.loadedAtMs : slot.lastUsedAtMs;
}

function aggregateBodyBytes(slots: ReadonlyMap<string, SkillSlotState>): number {
	let total = 0;
	for (const slot of slots.values()) total += slot.bodyBytes;
	return total;
}

function skillReadFailure(): SkillReadFailure {
	return { ok: false, reason: "read_failed", message: "Skill could not be read." };
}

/** Per-skill use is unobservable host-side (every loaded body rides every request), so eviction is honest FIFO by loadedAtMs: oldest unpinned first, oldest pinned only once no unpinned slot remains. */
function evictionVictimName(
	slots: ReadonlyMap<string, SkillSlotState>,
	excludedNames?: ReadonlySet<string>,
): string | undefined {
	let victim: { name: string; pinned: boolean; loadedAtMs: number } | undefined;
	for (const [name, slot] of slots) {
		if (excludedNames?.has(name)) continue;
		if (
			victim === undefined ||
			(victim.pinned && !slot.pinned) ||
			(victim.pinned === slot.pinned && slot.loadedAtMs < victim.loadedAtMs)
		) {
			victim = { name, pinned: slot.pinned, loadedAtMs: slot.loadedAtMs };
		}
	}
	return victim?.name;
}

/** Reserve at most roughly one context token's worth of bytes per advertised context token. */
export function resolveActiveSkillBodyByteLimit(contextWindow: number | undefined): number {
	if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) {
		return MAX_ACTIVE_SKILL_BODY_BYTES;
	}
	return Math.min(MAX_ACTIVE_SKILL_BODY_BYTES, Math.max(MIN_ACTIVE_SKILL_BODY_BYTES, Math.floor(contextWindow)));
}

/** One host-owned, event-driven lifecycle for lazy skill discovery and transient context projection. */
export class SkillVaultController {
	private readonly getSkills: () => readonly Skill[];
	private readonly getFullSkills: (() => readonly Skill[]) | undefined;
	private readonly refreshSkills: (() => void) | undefined;
	private readonly getSkillDiagnostics: (() => readonly string[]) | undefined;
	private readonly now: () => number;
	private readonly idleTimeoutMs: number;
	private readonly getMaxBodyBytes: () => number;
	private readonly onSkillUsed: ((skill: Skill, usedAtMs: number) => void) | undefined;
	private getSessionManager: (() => SessionSkillPolicyPort | undefined) | undefined;
	private cachedSessionId: string | undefined;
	private lastReplayedIndex = 0;
	private exclusions = new Map<string, SkillExclusionRecord>();
	private slots = new Map<string, SkillSlotState>();
	private unloadReason: SkillVaultUnloadReason | undefined;
	private contextRevision = 0;

	constructor(options: SkillVaultControllerOptions) {
		if (!Number.isFinite(options.idleTimeoutMs ?? DEFAULT_SKILL_IDLE_TIMEOUT_MS)) {
			throw new TypeError("Skill idle timeout must be finite.");
		}
		this.getSkills = options.getSkills;
		this.getFullSkills = options.getFullSkills;
		this.refreshSkills = options.refreshSkills;
		this.getSkillDiagnostics = options.getSkillDiagnostics;
		this.now = options.now ?? (() => performance.now());
		this.idleTimeoutMs = Math.max(1, options.idleTimeoutMs ?? DEFAULT_SKILL_IDLE_TIMEOUT_MS);
		this.getMaxBodyBytes = options.getMaxBodyBytes ?? (() => MAX_ACTIVE_SKILL_BODY_BYTES);
		this.onSkillUsed = options.onSkillUsed;
		this.getSessionManager = options.getSessionManager;
	}

	private syncExclusions(): void {
		const sm = this.getSessionManager?.();
		if (!sm) return;
		const currentSessionId = sm.getSessionId();
		if (this.cachedSessionId !== currentSessionId) {
			const isInitialBind = this.cachedSessionId === undefined;
			const hadPriorState = this.slots.size > 0 || this.exclusions.size > 0;
			this.slots.clear();
			this.exclusions.clear();
			this.cachedSessionId = currentSessionId;
			this.lastReplayedIndex = 0;
			if (!isInitialBind || hadPriorState) {
				this.contextRevision++;
			}
		}
		const currentCount = sm.getEntryCount();
		if (currentCount < this.lastReplayedIndex) {
			this.exclusions.clear();
			this.lastReplayedIndex = 0;
		}
		if (currentCount > this.lastReplayedIndex) {
			const newEntries = sm.getEntriesSince(this.lastReplayedIndex);
			this.lastReplayedIndex = currentCount;
			let updated = false;
			for (const entry of newEntries) {
				if (entry.type === "custom" && entry.customType === SESSION_SKILL_POLICY_CUSTOM_TYPE) {
					const payload = decodeSessionSkillPolicyPayload(entry.data, currentSessionId);
					if (payload && payload.sessionId === currentSessionId) {
						this.exclusions.clear();
						for (const record of payload.exclusions) {
							if (record.sessionId === currentSessionId) {
								this.exclusions.set(record.name, record);
								if (this.slots.has(record.name)) {
									this.slots.delete(record.name);
								}
							}
						}
						updated = true;
					}
				}
			}
			if (updated) {
				this.contextRevision++;
			}
		}
	}

	isExcluded(name: string): boolean {
		this.syncExclusions();
		return this.exclusions.has(name.trim());
	}

	getExclusions(): readonly SkillExclusionRecord[] {
		this.syncExclusions();
		return [...this.exclusions.values()];
	}

	previewExclusionReminder(): string | undefined {
		const exclusions = this.getExclusions();
		if (exclusions.length === 0) return undefined;
		const lines = exclusions.map((e) => `- ${e.name}: ${e.reason}`);
		return `EXCLUDED SKILLS (session-wide; conflict with owner instructions; superseded and inactive):\n${lines.join("\n")}`;
	}

	exclude(rawName: string, rawReason: string): SkillExcludeResult {
		const name = rawName.trim();
		if (!isValidSkillName(name)) {
			return {
				ok: false,
				reason: "invalid_name",
				message: "Skill exclude requires an exact valid name without control characters.",
			};
		}
		const boundedReason = boundReasonInBytes(rawReason);
		if (!boundedReason) {
			return {
				ok: false,
				reason: "invalid_reason",
				message: "Skill exclude requires a reason explaining conflict with owner instructions.",
			};
		}
		this.syncExclusions();
		const existing = this.exclusions.get(name);
		if (existing && existing.reason === boundedReason) {
			return {
				ok: true,
				name,
				reason: boundedReason,
				alreadyExcluded: true,
			};
		}
		const sm = this.getSessionManager?.();
		let record: SkillExclusionRecord;
		if (sm) {
			try {
				const existingRecords = [...this.exclusions.values()];
				const appended = appendSessionSkillExclusion(sm, existingRecords, { name, reason: boundedReason });
				record = appended.record;
				this.lastReplayedIndex = sm.getEntryCount();
			} catch (error) {
				return {
					ok: false,
					reason: "persistence_failed",
					message: error instanceof Error ? error.message : String(error),
				};
			}
		} else {
			if (this.exclusions.size >= MAX_SESSION_SKILL_EXCLUSIONS && !this.exclusions.has(name)) {
				return {
					ok: false,
					reason: "persistence_failed",
					message: `Maximum session skill exclusions (${MAX_SESSION_SKILL_EXCLUSIONS}) reached`,
				};
			}
			record = {
				name,
				reason: boundedReason,
				excludedAt: new Date(this.now()).toISOString(),
				sessionId: "in-memory",
			};
		}
		this.exclusions.set(name, record);
		if (this.slots.has(name)) {
			const next = new Map(this.slots);
			next.delete(name);
			this.replaceState(next, "explicit");
		} else {
			this.contextRevision++;
		}
		return { ok: true, name, reason: boundedReason };
	}

	inspect(name: string): SkillInspectResult {
		this.syncExclusions();
		const inventory = this.getFullSkills?.() ?? this.getSkills();
		const skill = inventory.find((s) => s.name === name.trim());
		if (!skill) return this.notFound(name);
		return inspectSkillFile(skill.filePath, skill.name);
	}

	repairSkill(input: SkillRepairInput): SkillRepairResult {
		const inventory = this.getFullSkills?.() ?? this.getSkills();
		let skill = inventory.find((s) => s.name === input.name);
		if (!skill && this.refreshSkills) {
			this.refreshSkills();
			const refreshedInventory = this.getFullSkills?.() ?? this.getSkills();
			skill = refreshedInventory.find((s) => s.name === input.name);
		}
		if (!skill) {
			return { ok: false, reason: "not_found", message: `Skill ${JSON.stringify(input.name)} not found on disk.` };
		}
		const result = repairSkillFile(skill.filePath, input, skill.description);
		if (result.ok) {
			this.refreshSkills?.();
		}
		return result;
	}

	search(rawQuery: string): SkillSearchResult {
		this.syncExclusions();
		const query = rawQuery.trim().toLowerCase();
		const tokens = queryTokens(query);
		if (!query || tokens.length === 0) return { candidates: [] };
		let candidates = this.searchCandidates(query, tokens);
		if (candidates.length === 0 && this.refreshSkills) {
			this.refreshSkills();
			candidates = this.searchCandidates(query, tokens);
		}
		const diagnostics = this.getSkillDiagnostics?.() ?? [];
		return { candidates, ...(diagnostics.length > 0 ? { diagnostics: [...diagnostics] } : {}) };
	}

	private searchCandidates(query: string, tokens: readonly string[]): SkillSearchResult["candidates"] {
		return this.getSkills()
			.filter((skill) => !skill.disableModelInvocation && !this.isExcluded(skill.name))
			.map((skill) => ({ skill, score: searchScore(skill, query, tokens) }))
			.filter((entry) => entry.score > 0)
			.sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name))
			.slice(0, MAX_SEARCH_RESULTS)
			.map(({ skill }) => ({ name: skill.name, description: compactDescription(skill.description) }));
	}

	/** The named eligible skill, after one re-scan of the roots when the first lookup misses. */
	private findEligible(name: string, requester: SkillVaultRequester): Skill | undefined {
		if (this.isExcluded(name)) return undefined;
		const eligible = (candidate: Skill) =>
			candidate.name === name &&
			!this.isExcluded(candidate.name) &&
			(requester === "user" || !candidate.disableModelInvocation);
		const found = this.getSkills().find(eligible);
		if (found || !this.refreshSkills) return found;
		this.refreshSkills();
		return this.getSkills().find(eligible);
	}

	private notFound(name: string): { ok: false; reason: "not_found"; message: string } {
		const rescanned = this.refreshSkills ? " after re-scanning the skill roots" : "";
		return {
			ok: false,
			reason: "not_found",
			message: `No eligible skill named ${JSON.stringify(name)}${rescanned}.`,
		};
	}

	private exclusionError(name: string): { ok: false; reason: "excluded"; message: string } {
		const exclusion = this.exclusions.get(name);
		return {
			ok: false,
			reason: "excluded",
			message: `Skill ${JSON.stringify(name)} is excluded in this session${exclusion ? `: ${exclusion.reason}` : "."}`,
		};
	}

	/** Read one eligible skill body without loading, evicting, or otherwise mutating the vault. */
	read(name: string, requester: SkillVaultRequester = "model"): SkillReadResult {
		this.syncExclusions();
		if (this.isExcluded(name)) {
			return this.exclusionError(name);
		}
		const skill = this.findEligible(name, requester);
		if (!skill) return this.notFound(name);
		const bodyResult = this.readSkillBody(skill, this.resolveMaxBodyBytes(), "read");
		if (!bodyResult.ok) return bodyResult;
		return { ok: true, name: skill.name, description: skill.description, body: bodyResult.body };
	}

	/** Host-only metadata snapshot for read-only audit brokers; paths never cross the tool boundary. */
	getSkillsSnapshot(): readonly Skill[] {
		this.syncExclusions();
		return this.getSkills()
			.filter((skill) => !this.isExcluded(skill.name))
			.map((skill) => ({ ...skill, sourceInfo: { ...skill.sourceInfo } }));
	}

	load(name: string, requester: SkillVaultRequester, pin = false): SkillLoadResult {
		const result = this.loadMany([name], requester, pin);
		return result.ok ? result.results[0]! : result;
	}

	/** Admit the complete requested set before replacing any live slot. Single loads use this path too. */
	loadMany(rawNames: readonly string[], requester: SkillVaultRequester, pin = false): SkillBatchLoadResult {
		const now = this.now();
		this.syncExclusions();
		this.reconcile(now);
		const names = new Set(rawNames.map((name) => name.trim()).filter(Boolean));
		if (names.size === 0) return { ok: false, reason: "not_found", message: "skill load requires an exact name" };
		for (const name of names) {
			if (this.isExcluded(name)) {
				return this.exclusionError(name);
			}
		}
		if (names.size > MAX_LOADED_SKILLS) {
			return {
				ok: false,
				reason: "capacity",
				message: `At most ${MAX_LOADED_SKILLS} skills can be loaded together; choose a smaller set.`,
			};
		}
		// Pinning is a retention preference, never a reason to refuse the load the model asked for
		// (2026-09-10 census: two sessions lost a turn each to a pin-cap refusal and retried unpinned).
		// Requested names take the remaining pin room in request order; the rest load unpinned and
		// say so, while slots pinned by earlier loads keep their pins.
		let pinRoom = MAX_PINNED_SKILLS;
		if (pin) {
			for (const [slotName, slot] of this.slots) {
				if (!names.has(slotName) && slot.pinned) pinRoom--;
			}
		}
		const pinnedNames = new Set<string>();
		const pinCapReached = new Set<string>();
		for (const name of names) {
			if (!pin) break;
			if (pinnedNames.size < pinRoom) pinnedNames.add(name);
			else pinCapReached.add(name);
		}
		const maxBodyBytes = this.resolveMaxBodyBytes();
		const prepared = new Map<string, SkillSlotState>();
		for (const name of names) {
			const skill = this.findEligible(name, requester);
			if (!skill) return this.notFound(name);
			const bodyResult = this.readSkillBody(skill, maxBodyBytes, "load");
			if (!bodyResult.ok) return bodyResult;
			const { body, bodyBytes, file } = bodyResult;
			prepared.set(name, {
				state: "loaded_pending",
				skill,
				bodyBytes,
				systemPromptSection: activeSkillContext(skill, body),
				requester,
				pinned: pinnedNames.has(name),
				loadedAtMs: now,
				fileDevice: file.dev,
				fileInode: file.ino,
				fileSize: file.size,
				fileModifiedAtMs: file.mtimeMs,
				fileChangedAtMs: file.ctimeMs,
			});
		}
		const admissionLimit = Math.min(maxBodyBytes, this.resolveMaxBodyBytes());
		if (aggregateBodyBytes(prepared) > admissionLimit) {
			return {
				ok: false,
				reason: "capacity",
				message: `Requested skill bodies exceed the shared ${admissionLimit}-byte budget; choose a smaller set.`,
			};
		}
		// A rescan for a later member can revoke or replace an earlier member. Recheck the
		// complete admission against one final resource snapshot before publishing any of it.
		const skills = this.getSkills();
		for (const slot of prepared.values()) {
			if (this.reconcileSlot(slot, skills, admissionLimit, now) !== undefined) {
				return {
					ok: false,
					reason: "read_failed",
					message: "Skill resources changed during batch admission; retry the complete set.",
				};
			}
		}
		const next = new Map(this.slots);
		for (const [name, slot] of prepared) next.set(name, slot);
		const evicted: string[] = [];
		while (next.size > MAX_LOADED_SKILLS || aggregateBodyBytes(next) > admissionLimit) {
			const victim = evictionVictimName(next, names);
			if (!victim) break;
			next.delete(victim);
			evicted.push(victim);
		}
		this.replaceState(next);
		return {
			ok: true,
			results: [...prepared.values()].map((slot, index) => ({
				ok: true,
				state: "loaded_pending",
				name: slot.skill.name,
				baseDir: slot.skill.baseDir,
				pinned: slot.pinned,
				...(pinCapReached.has(slot.skill.name) ? { pinCapReached: true as const } : {}),
				...(index === prepared.size - 1 && evicted.length > 0 ? { evicted } : {}),
			})),
		};
	}

	unload(name?: string): { ok: true; unloaded: string[] } {
		this.reconcile(this.now());
		const target = name?.trim();
		const unloaded = !target ? [...this.slots.keys()] : this.slots.has(target) ? [target] : [];
		if (unloaded.length > 0) {
			const next = new Map(this.slots);
			for (const slotName of unloaded) next.delete(slotName);
			this.replaceState(next, "explicit");
		}
		return { ok: true, unloaded };
	}

	status(): SkillVaultStatus {
		const now = this.now();
		this.syncExclusions();
		this.reconcile(now);
		const slots = [...this.slots.values()].map((slot) => this.slotStatus(slot, now));
		const exclusions = this.getExclusions().map((e) => ({ name: e.name, reason: e.reason }));
		return {
			idleTimeoutMs: this.idleTimeoutMs,
			slots,
			...(slots.length === 0 && this.unloadReason ? { reason: this.unloadReason } : {}),
			...(exclusions.length > 0 ? { exclusions } : {}),
		};
	}

	commitSystemPromptSection(): string | undefined {
		const now = this.now();
		this.syncExclusions();
		this.reconcile(now);
		if (this.slots.size === 0) return undefined;
		const sections: string[] = [];
		for (const [name, slot] of this.slots) {
			sections.push(slot.systemPromptSection);
			const firstUse = slot.state === "loaded_pending";
			const useCount = firstUse ? 1 : slot.useCount + 1;
			this.slots.set(name, { ...slot, state: "active", lastUsedAtMs: now, useCount });
			if (firstUse) {
				try {
					this.onSkillUsed?.(slot.skill, now);
				} catch {
					// Usage telemetry must never block skill application.
				}
			}
		}
		return sections.join("\n\n");
	}

	/** Model the next request's transient system cost without treating a diagnostic read as use. */
	previewSystemPromptSection(): string | undefined {
		this.syncExclusions();
		this.reconcile(this.now());
		if (this.slots.size === 0) return undefined;
		return [...this.slots.values()].map((slot) => slot.systemPromptSection).join("\n\n");
	}

	/**
	 * The exact provider system prompt for read-only diagnostics. Active skills no longer ride it:
	 * they are a durable host record in the message stream (see `ACTIVE_SKILL_CONTEXT_CUSTOM_TYPE`
	 * in provider-request-context-controller.ts), so the system prompt is the base prompt alone.
	 */
	previewRequestSystemPrompt(base: string | undefined): string | undefined {
		return composeRequestSystemPrompt(base, undefined);
	}

	/** Monotonic identity for provider-visible skill projection changes. */
	getContextRevision(): number {
		this.syncExclusions();
		this.reconcile(this.now());
		return this.contextRevision;
	}

	/** Record host-observed work derived from an active skill, independent of agent cooperation. */
	noteActivity(): void {
		const now = this.now();
		for (const [name, slot] of this.slots) {
			if (slot.state === "active") {
				this.slots.set(name, { ...slot, lastUsedAtMs: now });
			}
		}
	}

	private slotStatus(slot: SkillSlotState, now: number): SkillSlotStatus {
		if (slot.state === "loaded_pending") {
			return { state: "loaded_pending", name: slot.skill.name, pinned: slot.pinned, loadedAtMs: slot.loadedAtMs };
		}
		const idleForMs = Math.max(0, now - slot.lastUsedAtMs);
		return {
			state: "active",
			name: slot.skill.name,
			pinned: slot.pinned,
			loadedAtMs: slot.loadedAtMs,
			lastUsedAtMs: slot.lastUsedAtMs,
			idleForMs,
			expiresInMs: Math.max(0, this.idleTimeoutMs - idleForMs),
			useCount: slot.useCount,
		};
	}

	private readSkillBody(skill: Skill, maxBodyBytes: number, mode: SkillBodyReadMode): SkillBodyReadResult {
		let before: SkillFileStat;
		try {
			before = statSync(skill.filePath) as Stats;
		} catch (error) {
			return mode === "read"
				? skillReadFailure()
				: { ok: false, reason: "read_failed", message: error instanceof Error ? error.message : String(error) };
		}
		let raw: string;
		try {
			raw = readBoundedTextFileSync(
				skill.filePath,
				maxBodyBytes + MAX_SKILL_FRONTMATTER_BYTES,
				`Skill ${JSON.stringify(skill.name)}`,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return message.includes("exceeds its byte limit")
				? {
						ok: false,
						reason: "body_too_large",
						message: `Skill body exceeds ${maxBodyBytes} bytes; not truncated.`,
					}
				: mode === "read"
					? skillReadFailure()
					: { ok: false, reason: "read_failed", message };
		}
		const parsed = parseFrontmatter<SkillFrontmatter>(raw);
		const currentName = parsed.frontmatter.name ?? skill.name;
		const body = stripResourceProfileBlocks(parsed.body).trim();
		if (currentName !== skill.name || !parsed.frontmatter.description || !body) {
			return { ok: false, reason: "invalid_body", message: "Skill metadata changed or its body is empty." };
		}
		const bodyBytes = Buffer.byteLength(body, "utf8");
		if (bodyBytes > maxBodyBytes) {
			return {
				ok: false,
				reason: "body_too_large",
				message: `Skill body exceeds ${maxBodyBytes} bytes; not truncated.`,
			};
		}
		let file: SkillFileStat;
		try {
			file = statSync(skill.filePath) as Stats;
		} catch (error) {
			return mode === "read"
				? skillReadFailure()
				: { ok: false, reason: "read_failed", message: error instanceof Error ? error.message : String(error) };
		}
		if (!sameFileVersion(before, file)) {
			return {
				ok: false,
				reason: "read_failed",
				message:
					mode === "read" ? "Skill changed while it was being read." : "Skill changed while it was being loaded.",
			};
		}
		return { ok: true, body, bodyBytes, file };
	}

	private reconcile(now: number): void {
		if (this.slots.size === 0) return;
		const maxBodyBytes = this.resolveMaxBodyBytes();
		const skills = this.getSkills();
		const next = new Map(this.slots);
		let reason: SkillVaultUnloadReason | undefined;
		for (const [name, slot] of this.slots) {
			const slotReason = this.reconcileSlot(slot, skills, maxBodyBytes, now);
			if (slotReason !== undefined) {
				next.delete(name);
				reason = slotReason;
			}
		}
		while (aggregateBodyBytes(next) > maxBodyBytes) {
			const victim = evictionVictimName(next);
			if (!victim) break;
			next.delete(victim);
			reason = "budget_exceeded";
		}
		if (next.size !== this.slots.size) {
			this.replaceState(next, reason);
		}
	}

	private reconcileSlot(
		slot: SkillSlotState,
		skills: readonly Skill[],
		maxBodyBytes: number,
		now: number,
	): SkillVaultUnloadReason | undefined {
		if (slot.bodyBytes > maxBodyBytes) return "budget_exceeded";
		const currentSkill = skills.find(
			(skill) =>
				skill.name === slot.skill.name &&
				skill.filePath === slot.skill.filePath &&
				(slot.requester === "user" || !skill.disableModelInvocation),
		);
		if (!currentSkill) return "resource_unavailable";
		try {
			const file = statSync(slot.skill.filePath);
			if (
				file.dev !== slot.fileDevice ||
				file.ino !== slot.fileInode ||
				file.size !== slot.fileSize ||
				file.mtimeMs !== slot.fileModifiedAtMs ||
				file.ctimeMs !== slot.fileChangedAtMs
			) {
				return "resource_unavailable";
			}
		} catch {
			return "resource_unavailable";
		}
		if (now - slotLastUsedAtMs(slot) >= this.idleTimeoutMs) return "idle_expired";
		return undefined;
	}

	private replaceState(slots: Map<string, SkillSlotState>, unloadReason?: SkillVaultUnloadReason): void {
		this.slots = slots;
		if (unloadReason !== undefined) this.unloadReason = unloadReason;
		this.contextRevision++;
	}

	private resolveMaxBodyBytes(): number {
		const configured = this.getMaxBodyBytes();
		if (!Number.isFinite(configured)) return 1;
		return Math.min(MAX_ACTIVE_SKILL_BODY_BYTES, Math.max(1, Math.floor(configured)));
	}
}

export type {
	SkillInspectResult,
	SkillInspectSuccess,
	SkillRepairInput,
	SkillRepairResult,
	SkillRepairSuccess,
} from "./skill-repair.ts";
