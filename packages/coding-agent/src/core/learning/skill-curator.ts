/**
 * Skill curator (Hermes-parity #32). Reflection (R7) promotes recurring procedures into SKILL.md files;
 * without curation they accumulate forever, bloating tool/context and raising per-turn cost. The curator
 * tracks usage of PROMOTED skills (frontmatter `promoted: true`) and PROPOSES — never auto-applies —
 * archiving stale ones and consolidating overlapping ones. Hand-authored user skills are never touched.
 *
 * Design (locked with agy): propose-only, session-start + idle triggers (not per-turn), restorable
 * archive (non-destructive), and consolidation is a flagged suggestion (never an auto-merge).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jaccard, tokenize } from "../tools/skill-audit.ts";

/** Per-promoted-skill signal the proposal logic reasons over. Pure data — no I/O. */
export interface PromotedSkillInfo {
	name: string;
	/** When the skill file was created (ms epoch); guards a freshly-promoted skill from instant archival. */
	createdMs: number;
	/** Last time the skill was loaded/used (ms epoch); 0 if never used. */
	lastUsedMs: number;
	useCount: number;
	/** Tokens from name+description+body, for overlap detection. */
	keywords: string[];
}

export interface CuratorOptions {
	/** A promoted skill unused and older than this many days is proposed for archival. Default 30. */
	staleDays: number;
	/** Token-Jaccard ≥ this between two promoted skills flags them for consolidation. Default 0.5. */
	overlapThreshold: number;
	/** Current time (ms epoch); injected so the proposal logic stays pure/testable. */
	now: number;
}

export const DEFAULT_CURATOR_OPTIONS: Omit<CuratorOptions, "now"> = {
	staleDays: 30,
	overlapThreshold: 0.5,
};

export interface CurationProposals {
	/** Promoted skills proposed for (restorable) archival, with a human reason. */
	archive: Array<{ name: string; reason: string }>;
	/** Pairs of promoted skills that overlap enough to consider merging (flag only, never auto-merge). */
	consolidate: Array<{ names: [string, string]; overlap: number }>;
}

/**
 * Pure proposal logic: decide which promoted skills to PROPOSE archiving (stale + unused) and which pairs
 * overlap enough to PROPOSE consolidating. Returns suggestions only; the caller applies them on approval.
 */
export function computeCurationProposals(skills: PromotedSkillInfo[], opts: CuratorOptions): CurationProposals {
	const staleMs = opts.staleDays * 86_400_000;
	const archive: CurationProposals["archive"] = [];
	for (const s of skills) {
		// "Stale" = never recently used AND not freshly promoted: measure age from the most recent of
		// last-use / creation so a brand-new skill isn't archived before it has had a chance to be used.
		const lastSeen = Math.max(s.lastUsedMs, s.createdMs);
		const ageMs = opts.now - lastSeen;
		if (ageMs > staleMs) {
			const days = Math.floor(ageMs / 86_400_000);
			archive.push({
				name: s.name,
				reason: s.useCount === 0 ? `never used, ${days}d old` : `unused for ${days}d (${s.useCount} total uses)`,
			});
		}
	}

	const consolidate: CurationProposals["consolidate"] = [];
	const archiving = new Set(archive.map((a) => a.name));
	for (let i = 0; i < skills.length; i++) {
		for (let j = i + 1; j < skills.length; j++) {
			const a = skills[i];
			const b = skills[j];
			// Don't propose consolidating something already proposed for archival.
			if (archiving.has(a.name) || archiving.has(b.name)) continue;
			const overlap = jaccard(a.keywords, b.keywords);
			if (overlap >= opts.overlapThreshold) {
				consolidate.push({ names: [a.name, b.name], overlap });
			}
		}
	}
	return { archive, consolidate };
}

interface UsageRecord {
	lastUsedMs: number;
	useCount: number;
}
type UsageMap = Record<string, UsageRecord>;

/** Cap on how much of a skill body feeds keyword extraction (keeps overlap detection cheap). */
const KEYWORD_SOURCE_CAP = 4000;

/**
 * Filesystem layer over {@link computeCurationProposals}: reads promoted SKILL.md files + the usage
 * sidecar, and archives/restores skills non-destructively. The current time is injected so callers (and
 * tests) control "now".
 */
export class SkillCurator {
	private readonly skillsDir: string;
	private readonly archiveDir: string;
	private readonly usageFile: string;

	constructor(skillsDir: string) {
		this.skillsDir = skillsDir;
		this.archiveDir = join(skillsDir, ".archive");
		this.usageFile = join(skillsDir, ".usage.json");
	}

	/** Record that a promoted skill was loaded/used (bumps count + last-used). Best-effort. */
	recordUse(name: string, now: number): void {
		try {
			const usage = this.loadUsage();
			const prev = usage[name] ?? { lastUsedMs: 0, useCount: 0 };
			usage[name] = { lastUsedMs: now, useCount: prev.useCount + 1 };
			writeFileSync(this.usageFile, JSON.stringify(usage, null, 2), "utf-8");
		} catch {
			// usage tracking must never disrupt a turn
		}
	}

	/** Build the proposals from the current promoted-skill corpus. */
	proposeCuration(now: number, options: Partial<Omit<CuratorOptions, "now">> = {}): CurationProposals {
		const skills = this.loadPromotedSkills();
		return computeCurationProposals(skills, {
			now,
			staleDays: options.staleDays ?? DEFAULT_CURATOR_OPTIONS.staleDays,
			overlapThreshold: options.overlapThreshold ?? DEFAULT_CURATOR_OPTIONS.overlapThreshold,
		});
	}

	/** Move a promoted skill into `.archive/` (restorable). Returns true if archived. */
	archiveSkill(name: string): boolean {
		try {
			const from = join(this.skillsDir, name);
			if (!existsSync(join(from, "SKILL.md")) || !this.isPromoted(name)) return false;
			mkdirSync(this.archiveDir, { recursive: true });
			renameSync(from, join(this.archiveDir, name));
			return true;
		} catch {
			return false;
		}
	}

	/** Restore an archived skill back into the active skills dir. Returns true if restored. */
	restoreSkill(name: string): boolean {
		try {
			const from = join(this.archiveDir, name);
			const to = join(this.skillsDir, name);
			if (!existsSync(join(from, "SKILL.md")) || existsSync(to)) return false;
			renameSync(from, to);
			return true;
		} catch {
			return false;
		}
	}

	loadPromotedSkills(): PromotedSkillInfo[] {
		const out: PromotedSkillInfo[] = [];
		let entries: string[];
		try {
			entries = readdirSync(this.skillsDir);
		} catch {
			return out;
		}
		const usage = this.loadUsage();
		for (const name of entries) {
			if (name.startsWith(".")) continue; // skip .archive, .usage.json
			const file = join(this.skillsDir, name, "SKILL.md");
			let raw: string;
			let createdMs = 0;
			try {
				raw = readFileSync(file, "utf-8");
				createdMs = statSync(file).birthtimeMs || statSync(file).mtimeMs;
			} catch {
				continue;
			}
			if (!isPromotedFrontmatter(raw)) continue;
			const u = usage[name] ?? { lastUsedMs: 0, useCount: 0 };
			out.push({
				name,
				createdMs,
				lastUsedMs: u.lastUsedMs,
				useCount: u.useCount,
				keywords: tokenize(raw.slice(0, KEYWORD_SOURCE_CAP)),
			});
		}
		return out;
	}

	private isPromoted(name: string): boolean {
		try {
			return isPromotedFrontmatter(readFileSync(join(this.skillsDir, name, "SKILL.md"), "utf-8"));
		} catch {
			return false;
		}
	}

	private loadUsage(): UsageMap {
		try {
			return JSON.parse(readFileSync(this.usageFile, "utf-8")) as UsageMap;
		} catch {
			return {};
		}
	}
}

/** True if a SKILL.md's YAML frontmatter declares `promoted: true` (reflection-generated). */
export function isPromotedFrontmatter(content: string): boolean {
	const fm = content.match(/^---\n([\s\S]*?)\n---/);
	if (!fm) return false;
	return /^\s*promoted\s*:\s*true\s*$/im.test(fm[1]);
}
