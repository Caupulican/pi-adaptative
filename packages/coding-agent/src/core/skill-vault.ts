import { type Stats, statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { minimatch } from "minimatch";
import { composeRequestSystemPrompt } from "../kernel/provider-request-planner.ts";
import { sealSystemPrompt } from "../kernel/sealed-directives.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import type { AccountingOrigin } from "./cost/accounting-evidence.ts";
import type { SemanticDecisionEngine } from "./decision/engine.ts";
import { OWNER_PRECEDENCE_POLICY } from "./provider-prompt-contracts.ts";
import { stripResourceProfileBlocks } from "./resource-profile-blocks.ts";
import {
	appendSessionSkillExclusion,
	boundReasonInBytes,
	decodeSessionSkillPolicyPayload,
	isValidSkillName,
	MAX_SESSION_SKILL_EXCLUSIONS,
	SESSION_SKILL_POLICY_CUSTOM_TYPE,
	type SessionSkillPolicyPort,
	type SessionSkillPolicyReader,
	type SkillExclusionRecord,
} from "./session-skill-policy.ts";
import {
	EMPTY_SKILL_PROMPT_SECTIONS,
	SkillDiscovery,
	type SkillDiscoveryOptions,
	type SkillPromptSection,
	type SkillSearchResult,
} from "./skill-header-discovery.ts";
import {
	inspectSkillFile,
	repairSkillFile,
	type SkillInspectResult,
	type SkillRepairInput,
	type SkillRepairResult,
} from "./skill-repair.ts";
import {
	isWorkerEligibleSkill,
	MAX_ACTIVE_SKILL_BODY_BYTES,
	MAX_SKILL_FRONTMATTER_BYTES,
	type Skill,
	type SkillFrontmatter,
} from "./skills.ts";
import { readBoundedTextFileSync, sameFileVersion } from "./util/bounded-file.ts";

export type { SkillPromptSection, SkillSearchResult } from "./skill-header-discovery.ts";
export { MAX_ACTIVE_SKILL_BODY_BYTES };
export const DEFAULT_SKILL_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
export const MIN_ACTIVE_SKILL_BODY_BYTES = 4 * 1024;
export const MAX_LOADED_SKILLS = 3;
export const MAX_PINNED_SKILLS = 2;
/** Recent working-tree files the vault remembers for path-scoped skill ranking (most recent kept). */
export const MAX_SKILL_WORK_PATHS = 64;

type SkillVaultRequester = "model" | "user";
type SkillVaultUnloadReason = "explicit" | "idle_expired" | "resource_unavailable" | "budget_exceeded";
type SkillBodyReadMode = "read" | "load";
type SkillFileStat = Stats;

interface LoadedSkill {
	skill: Skill;
	bodyBytes: number;
	promptSection: SkillPromptSection;
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

export type SkillLoadResult =
	| {
			ok: true;
			state: SkillSlotState["state"];
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

export interface SkillRequestContext {
	readonly revision: number;
	readonly sections: readonly SkillPromptSection[];
	readonly headers: readonly SkillPromptSection[];
	readonly exclusionReminder: string | undefined;
}

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
	getSemanticEngine?(): SemanticDecisionEngine | undefined;
	getSemanticProvider?(): string | undefined;
	getSearchOrigin?(): AccountingOrigin | undefined;
	now?: () => number;
	idleTimeoutMs?: number;
	getMaxBodyBytes?: () => number;
	onSkillUsed?: (skill: Skill, usedAtMs: number) => void;
	/** The session whose skill-policy entries the vault replays: its exclusions hold for every read. */
	getSessionManager?: () => SessionSkillPolicyReader | undefined;
	/**
	 * Records an exclusion on that session. Absent, the vault serves reads only (a worker's skill access over a parent
	 * opened read-only) and refuses an exclusion rather than keeping one the session never records.
	 */
	appendPolicyEntry?: SessionSkillPolicyPort["appendCustomEntry"];
}

function activeSkillContext(skill: Skill, body: string): string {
	return [
		`ACTIVE SKILL ${skill.name}`,
		`BASE ${skill.baseDir}`,
		// One short precedence line per loaded body; the full conflict rule lives once in the skill
		// tool description (tools/skill.ts).
		`${OWNER_PRECEDENCE_POLICY.replace(/\.$/, "")}: on conflict, skill exclude (exact name, reason).`,
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
	private readonly discovery: SkillDiscovery;
	private readonly getSemanticEngine?: SkillVaultControllerOptions["getSemanticEngine"];
	private readonly getSemanticProvider?: SkillVaultControllerOptions["getSemanticProvider"];
	private readonly getSearchOrigin?: SkillVaultControllerOptions["getSearchOrigin"];
	private readonly now: () => number;
	private readonly idleTimeoutMs: number;
	private readonly getMaxBodyBytes: () => number;
	private readonly onSkillUsed: ((skill: Skill, usedAtMs: number) => void) | undefined;
	private getSessionManager: (() => SessionSkillPolicyReader | undefined) | undefined;
	private readonly appendPolicyEntry: SessionSkillPolicyPort["appendCustomEntry"] | undefined;
	private cachedSessionId: string | undefined;
	private lastReplayedIndex = 0;
	private exclusions = new Map<string, SkillExclusionRecord>();
	private slots = new Map<string, SkillSlotState>();
	/**
	 * Names of the skills this session loaded (a load, never a read). Unload and idle expiry do not forget a name: this
	 * is the session's history of loads, and it is cleared only when the session changes.
	 */
	private loadedSkillNames = new Set<string>();
	/** Recent working-tree file paths (cwd-relative, `/` separators), oldest first; ranks path-scoped skills. */
	private workPaths = new Set<string>();
	private pathsRevision = 0;
	private unloadReason: SkillVaultUnloadReason | undefined;
	private contextRevision = 0;
	private requestContext?: SkillRequestContext;

	constructor(options: SkillVaultControllerOptions) {
		if (!Number.isFinite(options.idleTimeoutMs ?? DEFAULT_SKILL_IDLE_TIMEOUT_MS)) {
			throw new TypeError("Skill idle timeout must be finite.");
		}
		this.getSkills = options.getSkills;
		this.getFullSkills = options.getFullSkills;
		this.refreshSkills = options.refreshSkills;
		this.getSemanticEngine = options.getSemanticEngine;
		this.getSemanticProvider = options.getSemanticProvider;
		this.getSearchOrigin = options.getSearchOrigin;
		this.now = options.now ?? (() => performance.now());
		this.idleTimeoutMs = Math.max(1, options.idleTimeoutMs ?? DEFAULT_SKILL_IDLE_TIMEOUT_MS);
		this.getMaxBodyBytes = options.getMaxBodyBytes ?? (() => MAX_ACTIVE_SKILL_BODY_BYTES);
		this.onSkillUsed = options.onSkillUsed;
		this.getSessionManager = options.getSessionManager;
		this.appendPolicyEntry = options.appendPolicyEntry;
		this.discovery = this.createDiscovery(false);
	}

	private syncExclusions(): void {
		const sm = this.getSessionManager?.();
		if (!sm) return;
		const currentSessionId = sm.getSessionId();
		if (this.cachedSessionId !== currentSessionId) {
			const isInitialBind = this.cachedSessionId === undefined;
			const hadPriorState = this.slots.size > 0 || this.exclusions.size > 0;
			this.slots.clear();
			this.discovery.clear();
			this.workPaths.clear();
			this.pathsRevision++;
			this.exclusions.clear();
			this.loadedSkillNames.clear();
			this.cachedSessionId = currentSessionId;
			this.lastReplayedIndex = 0;
			if (!isInitialBind || hadPriorState) {
				this.invalidateRequestContext();
			}
		}
		const currentCount = sm.getEntryCount();
		if (currentCount < this.lastReplayedIndex) {
			if (this.exclusions.size > 0) this.invalidateRequestContext();
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
				this.invalidateRequestContext();
			}
		}
	}

	/**
	 * Record working-tree files the session just touched (cwd-relative, `/` separators). Host-observed from
	 * tool calls, so it needs no model cooperation; only the most recent {@link MAX_SKILL_WORK_PATHS} are kept.
	 */
	noteWorkPaths(paths: readonly string[]): void {
		this.syncExclusions();
		for (const path of paths) {
			if (path.length === 0) continue;
			if (!this.workPaths.delete(path)) this.pathsRevision++;
			this.workPaths.add(path);
		}
		while (this.workPaths.size > MAX_SKILL_WORK_PATHS) {
			const oldest = this.workPaths.values().next().value;
			if (oldest === undefined) break;
			this.workPaths.delete(oldest);
		}
	}

	private matchesWorkPaths(skill: Skill): boolean {
		if (!skill.paths || skill.paths.length === 0 || this.workPaths.size === 0) return false;
		const recent = [...this.workPaths];
		// matchBase makes a slash-free pattern (`*.rs`) match in any directory, like a gitignore line.
		return skill.paths.some((pattern) =>
			recent.some((path) => minimatch(path, pattern, { dot: true, matchBase: true })),
		);
	}

	isExcluded(name: string): boolean {
		this.syncExclusions();
		return this.exclusions.has(name.trim());
	}

	getExclusions(): readonly SkillExclusionRecord[] {
		this.syncExclusions();
		return [...this.exclusions.values()];
	}

	/** Names of the skills this session has loaded, in first-load order. A read does not count as a load. */
	getLoadedSkillNames(): readonly string[] {
		this.syncExclusions();
		return [...this.loadedSkillNames];
	}

	previewExclusionReminder(): string | undefined {
		this.syncExclusions();
		return this.renderExclusionReminder();
	}

	private renderExclusionReminder(): string | undefined {
		if (this.exclusions.size === 0) return undefined;
		const exclusions = [...this.exclusions.values()];
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
			const append = this.appendPolicyEntry;
			if (!append) {
				return {
					ok: false,
					reason: "persistence_failed",
					message: "This skill vault only reads its session; an exclusion cannot be recorded here.",
				};
			}
			try {
				const existingRecords = [...this.exclusions.values()];
				const appended = appendSessionSkillExclusion(
					{ getSessionId: () => sm.getSessionId(), appendCustomEntry: append },
					existingRecords,
					{ name, reason: boundedReason },
				);
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
			this.invalidateRequestContext();
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

	search(rawQuery: string, options?: SkillDiscoveryOptions): Promise<SkillSearchResult> {
		this.syncExclusions();
		return this.discovery.search(rawQuery, options);
	}

	previewSkillHeaders(): readonly SkillPromptSection[] {
		return this.discovery.previewSkillHeaders();
	}

	createWorkerDiscovery(): SkillDiscovery {
		this.syncExclusions();
		return this.createDiscovery(true);
	}

	private createDiscovery(worker: boolean): SkillDiscovery {
		const sessionId = this.cachedSessionId;
		return new SkillDiscovery({
			getEligibleSkills: () => {
				this.syncExclusions();
				if (worker && sessionId !== this.cachedSessionId) return [];
				const skills = this.getSkills();
				return this.modelEligibleSkills(skills, worker);
			},
			refreshSkills: this.refreshSkills,
			matchesWorkPaths: (skill) => this.matchesWorkPaths(skill),
			workPathsRevision: () => this.pathsRevision,
			getSemanticEngine: this.getSemanticEngine,
			getSemanticProvider: this.getSemanticProvider,
			now: this.now,
			getOrigin: this.getSearchOrigin,
		});
	}

	private modelEligibleSkills(skills: readonly Skill[], worker: boolean): readonly Skill[] {
		return skills.filter((skill) => this.isEligible(skill, "model", worker) && isValidSkillName(skill.name));
	}

	/** The named eligible skill, after one re-scan of the roots when the first lookup misses. */
	private findEligible(
		name: string,
		requester: SkillVaultRequester,
		worker = false,
		refresh = this.refreshSkills,
	): Skill | undefined {
		if (this.isExcluded(name)) return undefined;
		const eligible = (candidate: Skill) => candidate.name === name && this.isEligible(candidate, requester, worker);
		const found = this.getSkills().find(eligible);
		if (found || !refresh) return found;
		const sessionId = this.cachedSessionId;
		refresh();
		this.syncExclusions();
		return sessionId === this.cachedSessionId ? this.getSkills().find(eligible) : undefined;
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

	private isEligible(skill: Skill, requester: SkillVaultRequester, worker: boolean): boolean {
		return (
			!this.exclusions.has(skill.name) &&
			(requester === "user" || !skill.disableModelInvocation) &&
			(!worker || isWorkerEligibleSkill(skill))
		);
	}

	/** Read one eligible skill body without loading, evicting, or otherwise mutating the vault. */
	read(name: string, requester: SkillVaultRequester = "model", worker = false): SkillReadResult {
		this.syncExclusions();
		if (this.isExcluded(name)) {
			return this.exclusionError(name);
		}
		const skill = this.findEligible(name, requester, worker);
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
		const sessionId = this.cachedSessionId;
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
		const maxBodyBytes = this.resolveMaxBodyBytes();
		const prepared = new Map<string, SkillSlotState>();
		let refreshed = false;
		const refresh = () => {
			if (refreshed) return;
			refreshed = true;
			this.refreshSkills?.();
		};
		for (const name of names) {
			const skill = this.findEligible(name, requester, false, refresh);
			if (!skill) return this.notFound(name);
			const resident = this.slots.get(name);
			if (resident?.skill.filePath === skill.filePath && resident.skill.baseDir === skill.baseDir) {
				prepared.set(name, { ...resident, skill, requester });
				continue;
			}
			const bodyResult = this.readSkillBody(skill, maxBodyBytes, "load");
			if (!bodyResult.ok) return bodyResult;
			const { body, bodyBytes, file } = bodyResult;
			prepared.set(name, {
				state: "loaded_pending",
				skill,
				bodyBytes,
				promptSection: Object.freeze({ name, section: activeSkillContext(skill, body) }),
				requester,
				pinned: false,
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
		// complete admission against the current session and resource inventory before publishing it.
		const skills = this.getSkills();
		this.syncExclusions();
		if (this.cachedSessionId !== sessionId) {
			return {
				ok: false,
				reason: "read_failed",
				message: "Session changed during skill admission; retry the load.",
			};
		}
		for (const slot of prepared.values()) {
			if (this.exclusions.has(slot.skill.name)) return this.exclusionError(slot.skill.name);
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
		const pinCapReached = new Set<string>();
		if (pin) {
			let room = MAX_PINNED_SKILLS;
			for (const slot of next.values()) if (slot.pinned) room--;
			for (const [name, slot] of prepared) {
				if (slot.pinned) continue;
				if (room <= 0) {
					pinCapReached.add(name);
					continue;
				}
				room--;
				const pinned = { ...slot, pinned: true };
				prepared.set(name, pinned);
				next.set(name, pinned);
			}
		}
		for (const slot of prepared.values()) this.loadedSkillNames.add(slot.skill.name);
		const sameSections =
			next.size === this.slots.size &&
			[...prepared].every(
				([name, slot]) => this.slots.get(name)?.promptSection.section === slot.promptSection.section,
			);
		if (sameSections) this.slots = next;
		else this.replaceState(next);
		return {
			ok: true,
			results: [...prepared.values()].map((slot, index) => ({
				ok: true,
				state: slot.state,
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

	/**
	 * Marks the active skills used by an accepted request and returns their sections in load order: one provider record per
	 * skill, so a request re-sends only the skills whose section changed.
	 */
	commitSkillSections(): readonly SkillPromptSection[] {
		const projection = this.captureRequestContext();
		this.noteRequestAccepted();
		return projection.sections;
	}

	acceptRequestContext(expected: SkillRequestContext): void {
		if (this.captureRequestContext() !== expected) {
			throw new Error("Committed skill context diverged from its accepted plan");
		}
		this.noteRequestAccepted();
	}

	private noteRequestAccepted(): void {
		const now = this.now();
		for (const [name, slot] of this.slots) {
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
	}

	/** A shared projection whose identity changes only when its provider-visible inputs change. */
	captureRequestContext(checkFiles = true): SkillRequestContext {
		this.syncExclusions();
		const hasHeaders = this.discovery.hasSelectedHeaders();
		const skills = this.slots.size > 0 || hasHeaders ? this.getSkills() : [];
		this.reconcile(this.now(), skills, checkFiles);
		const headers = hasHeaders
			? this.discovery.previewSkillHeaders(skills, (skill) => this.isEligible(skill, "model", false))
			: EMPTY_SKILL_PROMPT_SECTIONS;
		const previous = this.requestContext;
		if (previous?.revision === this.contextRevision && previous.headers === headers) return previous;
		const bodyChanged = previous?.revision !== this.contextRevision;
		this.requestContext = Object.freeze({
			revision: this.contextRevision,
			sections: bodyChanged
				? Object.freeze([...this.slots.values()].map((slot) => slot.promptSection))
				: previous.sections,
			headers,
			exclusionReminder: bodyChanged ? this.renderExclusionReminder() : previous.exclusionReminder,
		});
		return this.requestContext;
	}

	/** The sections a request would carry, in load order, without treating a diagnostic read as use. */
	previewSkillSections(): readonly SkillPromptSection[] {
		return this.captureRequestContext().sections;
	}

	/**
	 * The exact provider system prompt for read-only diagnostics. Active skills no longer ride it:
	 * they are one host record per skill in the message stream (see `ACTIVE_SKILL_RECORD_KIND_PREFIX`
	 * in provider-request-context-controller.ts), so the system prompt is the base prompt alone.
	 */
	previewRequestSystemPrompt(base: string | undefined): string | undefined {
		return sealSystemPrompt(composeRequestSystemPrompt(base, undefined));
	}

	/** Monotonic identity for provider-visible skill projection changes. */
	getContextRevision(): number {
		return this.captureRequestContext().revision;
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

	private reconcile(now: number, skills?: readonly Skill[], checkFiles = true): void {
		if (this.slots.size === 0) return;
		const maxBodyBytes = this.resolveMaxBodyBytes();
		const inventory = skills ?? this.getSkills();
		let next: Map<string, SkillSlotState> | undefined;
		let reason: SkillVaultUnloadReason | undefined;
		for (const [name, slot] of this.slots) {
			const slotReason = this.reconcileSlot(slot, inventory, maxBodyBytes, now, checkFiles);
			if (slotReason !== undefined) {
				next ??= new Map(this.slots);
				next.delete(name);
				reason = slotReason;
			}
		}
		while (aggregateBodyBytes(next ?? this.slots) > maxBodyBytes) {
			next ??= new Map(this.slots);
			const victim = evictionVictimName(next);
			if (!victim) break;
			next.delete(victim);
			reason = "budget_exceeded";
		}
		if (next) this.replaceState(next, reason);
	}

	private reconcileSlot(
		slot: SkillSlotState,
		skills: readonly Skill[],
		maxBodyBytes: number,
		now: number,
		checkFiles = true,
	): SkillVaultUnloadReason | undefined {
		if (slot.bodyBytes > maxBodyBytes) return "budget_exceeded";
		const currentSkill = skills.find(
			(skill) =>
				skill.name === slot.skill.name &&
				skill.filePath === slot.skill.filePath &&
				skill.baseDir === slot.skill.baseDir &&
				(slot.requester === "user" || !skill.disableModelInvocation),
		);
		if (!currentSkill) return "resource_unavailable";
		if (checkFiles && !this.isCurrentSkillFile(slot)) return "resource_unavailable";
		if (now - slotLastUsedAtMs(slot) >= this.idleTimeoutMs) return "idle_expired";
		return undefined;
	}

	private isCurrentSkillFile(slot: SkillSlotState): boolean {
		try {
			const file = statSync(slot.skill.filePath);
			return (
				file.dev === slot.fileDevice &&
				file.ino === slot.fileInode &&
				file.size === slot.fileSize &&
				file.mtimeMs === slot.fileModifiedAtMs &&
				file.ctimeMs === slot.fileChangedAtMs
			);
		} catch {
			return false;
		}
	}

	private replaceState(slots: Map<string, SkillSlotState>, unloadReason?: SkillVaultUnloadReason): void {
		this.slots = slots;
		if (unloadReason !== undefined) this.unloadReason = unloadReason;
		this.invalidateRequestContext();
	}

	private invalidateRequestContext(): void {
		this.contextRevision++;
		this.requestContext = undefined;
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
