import { type Stats, statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { composeRequestSystemPrompt } from "@caupulican/pi-agent-core/provider-request-planner";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { stripResourceProfileBlocks } from "./resource-profile-blocks.ts";
import { MAX_SKILL_FRONTMATTER_BYTES, type Skill, type SkillFrontmatter } from "./skills.ts";
import { readBoundedTextFileSync, sameFileVersion } from "./util/bounded-file.ts";

export const DEFAULT_SKILL_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_ACTIVE_SKILL_BODY_BYTES = 64 * 1024;
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
}

export interface SkillSearchResult {
	candidates: Array<{ name: string; description: string }>;
	/** Skills on disk the loader could not index (`<path>: <reason>`), so a broken SKILL.md is visible. */
	diagnostics?: string[];
}

export type SkillLoadResult =
	| { ok: true; state: "loaded_pending"; name: string; baseDir: string; pinned: boolean; evicted?: string[] }
	| {
			ok: false;
			reason: "not_found" | "body_too_large" | "invalid_body" | "read_failed" | "pin_limit";
			message: string;
	  };

export type SkillReadResult =
	| { ok: true; name: string; description: string; body: string }
	| {
			ok: false;
			reason: "not_found" | "body_too_large" | "invalid_body" | "read_failed";
			message: string;
	  };

type SkillReadFailure = Exclude<SkillReadResult, { ok: true }>;
type SkillBodyReadResult = { ok: true; body: string; bodyBytes: number; file: SkillFileStat } | SkillReadFailure;

export interface SkillVaultControllerOptions {
	getSkills(): readonly Skill[];
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
	return [`ACTIVE SKILL ${skill.name}`, `BASE ${skill.baseDir}`, "NON-NEGOTIABLE WHILE ACTIVE:", body].join("\n");
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
function evictionVictimName(slots: ReadonlyMap<string, SkillSlotState>, excludeName?: string): string | undefined {
	let victim: { name: string; pinned: boolean; loadedAtMs: number } | undefined;
	for (const [name, slot] of slots) {
		if (name === excludeName) continue;
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
	private readonly refreshSkills: (() => void) | undefined;
	private readonly getSkillDiagnostics: (() => readonly string[]) | undefined;
	private readonly now: () => number;
	private readonly idleTimeoutMs: number;
	private readonly getMaxBodyBytes: () => number;
	private readonly onSkillUsed: ((skill: Skill, usedAtMs: number) => void) | undefined;
	private slots = new Map<string, SkillSlotState>();
	private unloadReason: SkillVaultUnloadReason | undefined;
	private contextRevision = 0;

	constructor(options: SkillVaultControllerOptions) {
		if (!Number.isFinite(options.idleTimeoutMs ?? DEFAULT_SKILL_IDLE_TIMEOUT_MS)) {
			throw new TypeError("Skill idle timeout must be finite.");
		}
		this.getSkills = options.getSkills;
		this.refreshSkills = options.refreshSkills;
		this.getSkillDiagnostics = options.getSkillDiagnostics;
		this.now = options.now ?? (() => performance.now());
		this.idleTimeoutMs = Math.max(1, options.idleTimeoutMs ?? DEFAULT_SKILL_IDLE_TIMEOUT_MS);
		this.getMaxBodyBytes = options.getMaxBodyBytes ?? (() => MAX_ACTIVE_SKILL_BODY_BYTES);
		this.onSkillUsed = options.onSkillUsed;
	}

	search(rawQuery: string): SkillSearchResult {
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
			.filter((skill) => !skill.disableModelInvocation)
			.map((skill) => ({ skill, score: searchScore(skill, query, tokens) }))
			.filter((entry) => entry.score > 0)
			.sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name))
			.slice(0, MAX_SEARCH_RESULTS)
			.map(({ skill }) => ({ name: skill.name, description: compactDescription(skill.description) }));
	}

	/** The named eligible skill, after one re-scan of the roots when the first lookup misses. */
	private findEligible(name: string, requester: SkillVaultRequester): Skill | undefined {
		const eligible = (candidate: Skill) =>
			candidate.name === name && (requester === "user" || !candidate.disableModelInvocation);
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

	/** Read one eligible skill body without loading, evicting, or otherwise mutating the vault. */
	read(name: string, requester: SkillVaultRequester = "model"): SkillReadResult {
		const skill = this.findEligible(name, requester);
		if (!skill) return this.notFound(name);
		const bodyResult = this.readSkillBody(skill, this.resolveMaxBodyBytes(), "read");
		if (!bodyResult.ok) return bodyResult;
		return { ok: true, name: skill.name, description: skill.description, body: bodyResult.body };
	}

	/** Host-only metadata snapshot for read-only audit brokers; paths never cross the tool boundary. */
	getSkillsSnapshot(): readonly Skill[] {
		return this.getSkills().map((skill) => ({ ...skill, sourceInfo: { ...skill.sourceInfo } }));
	}

	load(name: string, requester: SkillVaultRequester, pin = false): SkillLoadResult {
		const now = this.now();
		this.reconcile(now);
		const skill = this.findEligible(name, requester);
		if (!skill) return this.notFound(name);
		if (pin) {
			let pinnedCount = 0;
			for (const [slotName, slot] of this.slots) {
				if (slotName !== skill.name && slot.pinned) pinnedCount++;
			}
			if (pinnedCount >= MAX_PINNED_SKILLS) {
				return {
					ok: false,
					reason: "pin_limit",
					message: `At most ${MAX_PINNED_SKILLS} skills can be pinned; unload a pinned skill or reload it without pin first.`,
				};
			}
		}
		const maxBodyBytes = this.resolveMaxBodyBytes();
		const bodyResult = this.readSkillBody(skill, maxBodyBytes, "load");
		if (!bodyResult.ok) return bodyResult;
		const { body, bodyBytes, file } = bodyResult;
		const next = new Map(this.slots);
		next.set(skill.name, {
			state: "loaded_pending",
			skill,
			bodyBytes,
			systemPromptSection: activeSkillContext(skill, body),
			requester,
			pinned: pin,
			loadedAtMs: now,
			fileDevice: file.dev,
			fileInode: file.ino,
			fileSize: file.size,
			fileModifiedAtMs: file.mtimeMs,
			fileChangedAtMs: file.ctimeMs,
		});
		const evicted: string[] = [];
		while (next.size > MAX_LOADED_SKILLS || aggregateBodyBytes(next) > maxBodyBytes) {
			const victim = evictionVictimName(next, skill.name);
			if (!victim) break;
			next.delete(victim);
			evicted.push(victim);
		}
		this.replaceState(next);
		return {
			ok: true,
			state: "loaded_pending",
			name: skill.name,
			baseDir: skill.baseDir,
			pinned: pin,
			...(evicted.length > 0 ? { evicted } : {}),
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
		this.reconcile(now);
		const slots = [...this.slots.values()].map((slot) => this.slotStatus(slot, now));
		return {
			idleTimeoutMs: this.idleTimeoutMs,
			slots,
			...(slots.length === 0 && this.unloadReason ? { reason: this.unloadReason } : {}),
		};
	}

	commitSystemPromptSection(): string | undefined {
		const now = this.now();
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
