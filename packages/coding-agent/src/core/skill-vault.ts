import { statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { composeRequestSystemPrompt } from "@caupulican/pi-agent-core";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { stripResourceProfileBlocks } from "./resource-profile-blocks.ts";
import { MAX_SKILL_FRONTMATTER_BYTES, type Skill, type SkillFrontmatter } from "./skills.ts";
import { readBoundedTextFileSync, sameFileVersion } from "./util/bounded-file.ts";

export const DEFAULT_SKILL_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_ACTIVE_SKILL_BODY_BYTES = 64 * 1024;
export const MIN_ACTIVE_SKILL_BODY_BYTES = 4 * 1024;
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

type SkillVaultState =
	| { state: "unloaded"; reason?: SkillVaultUnloadReason }
	| ({ state: "loaded_pending" } & LoadedSkill)
	| ({ state: "active"; lastUsedAtMs: number; useCount: number } & LoadedSkill);

export interface SkillVaultStatus {
	state: SkillVaultState["state"];
	idleTimeoutMs: number;
	name?: string;
	loadedAtMs?: number;
	lastUsedAtMs?: number;
	idleForMs?: number;
	expiresInMs?: number;
	useCount?: number;
	reason?: SkillVaultUnloadReason;
}

export interface SkillSearchResult {
	candidates: Array<{ name: string; description: string }>;
}

export type SkillLoadResult =
	| { ok: true; state: "loaded_pending"; name: string; replaced?: string }
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
	private current: SkillVaultState = { state: "unloaded" };
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
		const replaced = this.current.state === "unloaded" ? undefined : this.current.skill.name;
		this.replaceState({
			state: "loaded_pending",
			skill,
			bodyBytes,
			systemPromptSection: activeSkillContext(skill, body),
			requester,
			loadedAtMs: this.now(),
			fileDevice: file.dev,
			fileInode: file.ino,
			fileSize: file.size,
			fileModifiedAtMs: file.mtimeMs,
			fileChangedAtMs: file.ctimeMs,
		});
		return { ok: true, state: "loaded_pending", name: skill.name, ...(replaced ? { replaced } : {}) };
	}

	unload(): { ok: true; unloaded?: string } {
		const unloaded = this.current.state === "unloaded" ? undefined : this.current.skill.name;
		this.replaceState({ state: "unloaded", reason: "explicit" });
		return { ok: true, ...(unloaded ? { unloaded } : {}) };
	}

	status(): SkillVaultStatus {
		const now = this.now();
		this.reconcile(now);
		if (this.current.state === "unloaded") {
			return {
				state: "unloaded",
				idleTimeoutMs: this.idleTimeoutMs,
				...(this.current.reason ? { reason: this.current.reason } : {}),
			};
		}
		if (this.current.state === "loaded_pending") {
			return {
				state: "loaded_pending",
				idleTimeoutMs: this.idleTimeoutMs,
				name: this.current.skill.name,
				loadedAtMs: this.current.loadedAtMs,
			};
		}
		const idleForMs = Math.max(0, now - this.current.lastUsedAtMs);
		return {
			state: "active",
			idleTimeoutMs: this.idleTimeoutMs,
			name: this.current.skill.name,
			loadedAtMs: this.current.loadedAtMs,
			lastUsedAtMs: this.current.lastUsedAtMs,
			idleForMs,
			expiresInMs: Math.max(0, this.idleTimeoutMs - idleForMs),
			useCount: this.current.useCount,
		};
	}

	commitSystemPromptSection(): string | undefined {
		const now = this.now();
		this.reconcile(now);
		if (this.current.state === "unloaded") return undefined;
		const loaded = this.current;
		const firstUse = loaded.state === "loaded_pending";
		const useCount = firstUse ? 1 : loaded.useCount + 1;
		this.current = { ...loaded, state: "active", lastUsedAtMs: now, useCount };
		if (firstUse) {
			try {
				this.onSkillUsed?.(loaded.skill, now);
			} catch {
				// Usage telemetry must never block skill application.
			}
		}
		return loaded.systemPromptSection;
	}

	/** Model the next request's transient system cost without treating a diagnostic read as use. */
	previewSystemPromptSection(): string | undefined {
		this.reconcile(this.now());
		return this.current.state === "unloaded" ? undefined : this.current.systemPromptSection;
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
		if (this.current.state === "active") {
			this.current = { ...this.current, lastUsedAtMs: now };
		}
	}

	private reconcile(now: number): void {
		if (!this.reconcileResource()) return;
		const current = this.current;
		if (current.state === "unloaded") return;
		const lastUsedAtMs = current.state === "loaded_pending" ? current.loadedAtMs : current.lastUsedAtMs;
		if (now - lastUsedAtMs >= this.idleTimeoutMs) {
			this.replaceState({ state: "unloaded", reason: "idle_expired" });
		}
	}

	private reconcileResource(): boolean {
		if (this.current.state === "unloaded") return false;
		const loaded = this.current;
		if (loaded.bodyBytes > this.resolveMaxBodyBytes()) {
			this.replaceState({ state: "unloaded", reason: "budget_exceeded" });
			return false;
		}
		const currentSkill = this.getSkills().find(
			(skill) =>
				skill.name === loaded.skill.name &&
				skill.filePath === loaded.skill.filePath &&
				(loaded.requester === "user" || !skill.disableModelInvocation),
		);
		if (!currentSkill) {
			this.replaceState({ state: "unloaded", reason: "resource_unavailable" });
			return false;
		}
		try {
			const file = statSync(loaded.skill.filePath);
			if (
				file.dev !== loaded.fileDevice ||
				file.ino !== loaded.fileInode ||
				file.size !== loaded.fileSize ||
				file.mtimeMs !== loaded.fileModifiedAtMs ||
				file.ctimeMs !== loaded.fileChangedAtMs
			) {
				this.replaceState({ state: "unloaded", reason: "resource_unavailable" });
				return false;
			}
		} catch {
			this.replaceState({ state: "unloaded", reason: "resource_unavailable" });
			return false;
		}
		return true;
	}

	private replaceState(state: SkillVaultState): void {
		this.current = state;
		this.contextRevision++;
	}

	private resolveMaxBodyBytes(): number {
		const configured = this.getMaxBodyBytes();
		if (!Number.isFinite(configured)) return 1;
		return Math.min(MAX_ACTIVE_SKILL_BODY_BYTES, Math.max(1, Math.floor(configured)));
	}
}
