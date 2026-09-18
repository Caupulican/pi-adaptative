/**
 * Skill curator (Hermes-parity #32). Reflection (R7) promotes recurring procedures into SKILL.md files;
 * without curation they accumulate forever, bloating tool/context and raising per-turn cost. The curator
 * tracks usage of PROMOTED skills (frontmatter `promoted: true`) and PROPOSES — never auto-applies —
 * archiving stale ones and consolidating overlapping ones. Hand-authored user skills are never touched.
 *
 * Design (locked with agy): propose-only, session-start + idle triggers (not per-turn), restorable
 * archive (non-destructive), and consolidation is a flagged suggestion (never an auto-merge).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { jaccard, tokenize } from "../tools/skill-audit.ts";
import { withFileLock, withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";

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

export interface DisuseBreadthGuard {
	/** Whether observation breadth is sufficient to infer true disuse. When false, archival proposals are suppressed. */
	sufficient?: boolean;
	/** Number of observed sessions/traces evaluated. */
	sessionCount?: number;
	/** Minimum sessions required before proposing archival. Default 1. */
	minSessions?: number;
	/** Day span across observations. */
	spanDays?: number;
	/** Minimum day span required. Default 0. */
	minSpanDays?: number;
	/** Human reason if insufficient. */
	reason?: string;
}

export interface CuratorOptions {
	/** A promoted skill unused and older than this many days is proposed for archival. Default 30. */
	staleDays: number;
	/** Token-Jaccard ≥ this between two promoted skills flags them for consolidation. Default 0.5. */
	overlapThreshold: number;
	/** Current time (ms epoch); injected so the proposal logic stays pure/testable. */
	now: number;
	/** Disuse evidence qualification (Grok learn parity). Archival is suppressed if disuse breadth is insufficient. */
	disuseGuard?: DisuseBreadthGuard;
	/** Set of skill names whose archival proposal was rejected by the user; suppressed across runs. */
	rejectedSkills?: ReadonlySet<string>;
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
	const disuseSufficient =
		opts.disuseGuard?.sufficient !== false &&
		(opts.disuseGuard?.minSessions === undefined ||
			(opts.disuseGuard.sessionCount ?? 0) >= opts.disuseGuard.minSessions) &&
		(opts.disuseGuard?.minSpanDays === undefined || (opts.disuseGuard.spanDays ?? 0) >= opts.disuseGuard.minSpanDays);

	if (disuseSufficient) {
		for (const s of skills) {
			if (opts.rejectedSkills?.has(s.name)) continue;
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

export interface CurationDecisionRecord {
	date: string;
	name: string;
	action: "archive" | "consolidate";
	decision: "applied" | "rejected" | "deferred";
	reason?: string;
}

/**
 * Filesystem layer over {@link computeCurationProposals}: reads promoted SKILL.md files + the usage
 * sidecar, and archives/restores skills non-destructively. The current time is injected so callers (and
 * tests) control "now".
 */
export class SkillCurator {
	private readonly skillsDir: string;
	private readonly archiveDir: string;
	private readonly usageFile: string;
	private readonly decisionsFile: string;

	constructor(skillsDir: string) {
		this.skillsDir = skillsDir;
		this.archiveDir = join(skillsDir, ".archive");
		this.usageFile = join(skillsDir, ".usage.json");
		this.decisionsFile = join(skillsDir, ".decisions.jsonl");
	}

	/**
	 * Record that a promoted skill was loaded/used (bumps count + last-used). Best-effort.
	 * Load-mutate-write runs under a single exclusive lock so two concurrent uses (e.g. two sessions
	 * loading the same skill around the same time) can't both read the old usage map and drop a count.
	 */
	recordUse(name: string, now: number): void {
		try {
			withFileLockSync(this.usageFile, () => {
				const usage = this.loadUsage();
				const prev = usage[name] ?? { lastUsedMs: 0, useCount: 0 };
				usage[name] = { lastUsedMs: now, useCount: prev.useCount + 1 };
				writeFileAtomicSync(this.usageFile, JSON.stringify(usage, null, 2));
			});
		} catch {
			// usage tracking must never disrupt a turn
		}
	}

	/**
	 * Record a curation decision (Grok learn parity via decisions.jsonl). Appends one JSON line.
	 */
	recordDecision(decision: {
		name: string;
		action: "archive" | "consolidate";
		decision: "applied" | "rejected" | "deferred";
		reason?: string;
	}): void {
		try {
			withFileLockSync(this.decisionsFile, () => {
				const line: CurationDecisionRecord = {
					date: new Date().toISOString().slice(0, 10),
					name: decision.name,
					action: decision.action,
					decision: decision.decision,
					reason: decision.reason,
				};
				let existing = "";
				try {
					existing = readFileSync(this.decisionsFile, "utf-8");
				} catch {
					existing = "";
				}
				const content = existing ? `${existing.trimEnd()}\n${JSON.stringify(line)}\n` : `${JSON.stringify(line)}\n`;
				writeFileAtomicSync(this.decisionsFile, content);
			});
		} catch {
			// decision tracking must never disrupt a turn
		}
	}

	/**
	 * Load skill names whose archival was explicitly rejected by the user.
	 */
	loadRejections(): Set<string> {
		const rejections = new Set<string>();
		try {
			const content = readFileSync(this.decisionsFile, "utf-8");
			for (const line of content.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				const entry = JSON.parse(trimmed) as CurationDecisionRecord;
				if (entry.action === "archive" && entry.decision === "rejected") {
					rejections.add(entry.name);
				}
			}
		} catch {
			// file may not exist yet
		}
		return rejections;
	}

	/** Build the proposals from the current promoted-skill corpus. */
	proposeCuration(now: number, options: Partial<Omit<CuratorOptions, "now">> = {}): CurationProposals {
		const skills = this.loadPromotedSkills();
		const rejectedSkills = options.rejectedSkills ?? this.loadRejections();
		return computeCurationProposals(skills, {
			now,
			staleDays: options.staleDays ?? DEFAULT_CURATOR_OPTIONS.staleDays,
			overlapThreshold: options.overlapThreshold ?? DEFAULT_CURATOR_OPTIONS.overlapThreshold,
			disuseGuard: options.disuseGuard,
			rejectedSkills,
		});
	}

	/**
	 * Auto-archive every stale promoted skill in ONE locked batch (#32 default-on). The lock serializes
	 * curation across sessions sharing this `agentDir` so a concurrent session can't archive a folder
	 * mid-rename (agy's race mitigation). Returns the names archived (for the host to announce). Never
	 * throws; on lock contention it simply does nothing this run.
	 */
	async autoArchiveStale(now: number, options: Partial<Omit<CuratorOptions, "now">> = {}): Promise<string[]> {
		if (!existsSync(this.skillsDir)) return [];
		try {
			return await withFileLock(
				this.skillsDir,
				() => {
					const archived: string[] = [];
					for (const a of this.proposeCuration(now, options).archive) {
						if (this.archiveSkill(a.name)) archived.push(a.name);
					}
					return archived;
				},
				{ retries: 2 },
			);
		} catch {
			return []; // another session holds the lock, or fs error — skip this run
		}
	}

	/** Move a promoted skill into `.archive/` (restorable). Returns true if archived. */
	archiveSkill(name: string): boolean {
		try {
			const from = join(this.skillsDir, name);
			if (!existsSync(join(from, "SKILL.md")) || !this.isPromoted(name)) return false;
			mkdirSync(this.archiveDir, { recursive: true });
			renameSync(from, join(this.archiveDir, name));
			this.recordDecision({
				name,
				action: "archive",
				decision: "applied",
				reason: "archived",
			});
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
			this.recordDecision({
				name,
				action: "archive",
				decision: "rejected",
				reason: "restored by user",
			});
			this.recordUse(name, Date.now());
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
