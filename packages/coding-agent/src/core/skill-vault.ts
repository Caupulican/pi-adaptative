import { statSync } from "node:fs";
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
const MAX_SEARCH_RESULTS = 5;
const MAX_SEARCH_DESCRIPTION_CHARS = 240;

type SkillVaultRequester = "model" | "user";
type SkillVaultUnloadReason = "explicit" | "idle_expired" | "resource_unavailable" | "budget_exceeded";

interface LoadedSkill {
	skill: Skill;
	bodyBytes: number;
	systemPromptSection: string;
	requester: SkillVaultRequester;
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
}

export type SkillLoadResult =
	| { ok: true; state: "loaded_pending"; name: string; baseDir: string; evicted?: string[] }
	| { ok: false; reason: "not_found" | "body_too_large" | "invalid_body" | "read_failed"; message: string };

export interface SkillVaultControllerOptions {
	getSkills(): readonly Skill[];
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

function leastRecentlyUsedName(slots: ReadonlyMap<string, SkillSlotState>, excludeName?: string): string | undefined {
	let lruName: string | undefined;
	let lruUsedAtMs = Number.POSITIVE_INFINITY;
	for (const [name, slot] of slots) {
		if (name === excludeName) continue;
		const usedAtMs = slotLastUsedAtMs(slot);
		if (usedAtMs < lruUsedAtMs) {
			lruUsedAtMs = usedAtMs;
			lruName = name;
		}
	}
	return lruName;
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
		this.now = options.now ?? (() => performance.now());
		this.idleTimeoutMs = Math.max(1, options.idleTimeoutMs ?? DEFAULT_SKILL_IDLE_TIMEOUT_MS);
		this.getMaxBodyBytes = options.getMaxBodyBytes ?? (() => MAX_ACTIVE_SKILL_BODY_BYTES);
		this.onSkillUsed = options.onSkillUsed;
	}

	search(rawQuery: string): SkillSearchResult {
		const query = rawQuery.trim().toLowerCase();
		const tokens = queryTokens(query);
		if (!query || tokens.length === 0) return { candidates: [] };
		const candidates = this.getSkills()
			.filter((skill) => !skill.disableModelInvocation)
			.map((skill) => ({ skill, score: searchScore(skill, query, tokens) }))
			.filter((entry) => entry.score > 0)
			.sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name))
			.slice(0, MAX_SEARCH_RESULTS)
			.map(({ skill }) => ({ name: skill.name, description: compactDescription(skill.description) }));
		return { candidates };
	}

	load(name: string, requester: SkillVaultRequester): SkillLoadResult {
		const now = this.now();
		this.reconcile(now);
		const skill = this.getSkills().find(
			(candidate) => candidate.name === name && (requester === "user" || !candidate.disableModelInvocation),
		);
		if (!skill) {
			return { ok: false, reason: "not_found", message: `No eligible skill named ${JSON.stringify(name)}.` };
		}
		const maxBodyBytes = this.resolveMaxBodyBytes();
		let before: ReturnType<typeof statSync>;
		try {
			before = statSync(skill.filePath);
		} catch (error) {
			return { ok: false, reason: "read_failed", message: error instanceof Error ? error.message : String(error) };
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
		let file: ReturnType<typeof statSync>;
		try {
			file = statSync(skill.filePath);
		} catch (error) {
			return { ok: false, reason: "read_failed", message: error instanceof Error ? error.message : String(error) };
		}
		if (!sameFileVersion(before, file)) {
			return { ok: false, reason: "read_failed", message: "Skill changed while it was being loaded." };
		}
		const next = new Map(this.slots);
		next.set(skill.name, {
			state: "loaded_pending",
			skill,
			bodyBytes,
			systemPromptSection: activeSkillContext(skill, body),
			requester,
			loadedAtMs: now,
			fileDevice: file.dev,
			fileInode: file.ino,
			fileSize: file.size,
			fileModifiedAtMs: file.mtimeMs,
			fileChangedAtMs: file.ctimeMs,
		});
		const evicted: string[] = [];
		while (next.size > MAX_LOADED_SKILLS || aggregateBodyBytes(next) > maxBodyBytes) {
			const victim = leastRecentlyUsedName(next, skill.name);
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

	/** Compose the exact provider system prompt for read-only diagnostics. */
	previewRequestSystemPrompt(base: string | undefined): string | undefined {
		return composeRequestSystemPrompt(base, this.previewSystemPromptSection());
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
			return { state: "loaded_pending", name: slot.skill.name, loadedAtMs: slot.loadedAtMs };
		}
		const idleForMs = Math.max(0, now - slot.lastUsedAtMs);
		return {
			state: "active",
			name: slot.skill.name,
			loadedAtMs: slot.loadedAtMs,
			lastUsedAtMs: slot.lastUsedAtMs,
			idleForMs,
			expiresInMs: Math.max(0, this.idleTimeoutMs - idleForMs),
			useCount: slot.useCount,
		};
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
			const victim = leastRecentlyUsedName(next);
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
