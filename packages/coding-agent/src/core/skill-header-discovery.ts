/** Ranks eligible skill headers and owns the bounded set retained by a conversation. */
import { createHash } from "node:crypto";
import { transientRecordDigest } from "../kernel/transient-record-decision.ts";
import type { TransientRecordPayload } from "../kernel/transient-records.ts";
import type { AccountingOrigin } from "./cost/accounting-evidence.ts";
import type { SemanticDecisionEngine, SemanticEvaluationScope } from "./decision/engine.ts";
import { DISCOVERED_SKILL_RECORD_KIND, discoveredSkillDigest } from "./skill-header-record.ts";
import {
	SKILL_RANKING_TIMEOUT_MS,
	type SkillRankingSource,
	SkillSemanticRanking,
	sameSkillRankingSource,
} from "./skill-semantic-ranking.ts";
import type { Skill } from "./skills.ts";

export const EMPTY_SKILL_PROMPT_SECTIONS: readonly SkillPromptSection[] = Object.freeze([]);

const MAX_SEARCH_DESCRIPTION_CHARS = 240;
const MAX_SKILL_SEARCH_QUERY_CHARS = 500;
const MAX_SEMANTIC_SKILL_CANDIDATES = 200;
const MAX_DISCOVERED_SKILL_HEADERS = 8;
/** Rank bonus for a text match whose skill declares paths matching the session's recent file work. */
const PATH_MATCH_SCORE = 10;
const COMMON_QUERY_WORDS = new Set(
	"a an and are as at be by can could for from how i in into is it me of on or please should that the this to we what when where which who will with would you".split(
		" ",
	),
);

export interface SkillHeader {
	readonly name: string;
	readonly description: string;
}

export interface SkillSearchResult {
	readonly candidates: readonly SkillHeader[];
	readonly ranking?: "exact" | "format" | "semantic" | "lexical";
	readonly semantic?: "reused" | "uncertain" | "unavailable";
	readonly ambiguous?: true;
}

export interface SkillPromptSection {
	readonly name: string;
	readonly section: string;
	readonly recordId?: string;
	readonly discovery?: { readonly sourceId: string; readonly order: number; readonly digest: string };
}

export interface SkillDiscoveryOptions {
	readonly signal?: AbortSignal;
	readonly evaluationScope?: SemanticEvaluationScope;
}

function compactDescription(description: string): string {
	const normalized = description.replace(/\s+/g, " ").trim();
	if (normalized.length <= MAX_SEARCH_DESCRIPTION_CHARS) return normalized;
	return `${normalized.slice(0, MAX_SEARCH_DESCRIPTION_CHARS - 1)}…`;
}

function searchTerms(value: string): Set<string> {
	const words =
		value
			.normalize("NFKC")
			.toLowerCase()
			.match(/[\p{L}\p{N}]+/gu) ?? [];
	return new Set(words.filter((word) => !COMMON_QUERY_WORDS.has(word)));
}

function searchScore({ name, description }: CatalogSkill, terms: ReadonlySet<string>): number {
	let score = 0;
	for (const term of terms) {
		if (name.has(term)) score += 8;
		else if (description.has(term)) score += 3;
	}
	return score;
}

interface CatalogSkill {
	readonly skill: Skill;
	readonly header: SkillHeader;
	readonly name: ReadonlySet<string>;
	readonly description: ReadonlySet<string>;
}

interface RankedSkill {
	readonly entry: CatalogSkill;
	readonly score: number;
}

interface SkillCatalog {
	readonly entries: readonly CatalogSkill[];
	readonly byName: ReadonlyMap<string, CatalogSkill>;
	readonly digest: string;
}

function matchesSkillSource(previous: Skill, current: Skill): boolean {
	return (
		previous.name === current.name &&
		previous.filePath === current.filePath &&
		previous.baseDir === current.baseDir &&
		previous.description === current.description
	);
}

function matchesCatalogSkill({ skill }: CatalogSkill, current: Skill): boolean {
	const previous = skill.paths;
	const next = current.paths;
	return (
		matchesSkillSource(skill, current) &&
		previous?.length === next?.length &&
		(previous === undefined || previous.every((path, index) => path === next?.[index]))
	);
}

function compileCatalog(skills: readonly Skill[]): SkillCatalog {
	const entries = skills.map(
		(skill): CatalogSkill => ({
			skill: { ...skill, paths: skill.paths?.slice() },
			header: skillHeader(skill),
			name: searchTerms(skill.name),
			description: searchTerms(skill.description),
		}),
	);
	const byName = new Map<string, CatalogSkill>();
	for (const entry of entries) if (!byName.has(entry.skill.name)) byName.set(entry.skill.name, entry);
	return {
		entries,
		byName,
		digest: transientRecordDigest(
			JSON.stringify(
				skills.map((skill) => [skill.name, skill.description, skill.filePath, skill.baseDir, skill.paths]),
			),
		),
	};
}

/** Verbs that ask for an artifact to be produced; a format word beside none of them names a topic, not a demand. */
const OUTPUT_VERBS = "(?:make|build|create|generate|produce|write|draw|render|design|show|give|visuali[sz]e|present)";
/** Words that make a format word the name of a subject (an html parsing bug, a video player) instead of an artifact. */
const SUBJECT_FOLLOWER =
	"(?!\\s+(?:parsing|parser|player|codec|decoder|encoder|driver|stream|streaming|call|buffer|element|tag|api|playback|bug|renderer|rendering|library|loader|loading|handler|error|crash|syntax))";

/** A demand for the artifact `noun` names: a producing verb, then at most four words, then the noun. */
function makeDemand(noun: string): RegExp {
	return new RegExp(`\\b${OUTPUT_VERBS}\\b(?:\\s+[\\w'-]+){0,4}?\\s+${noun}\\b${SUBJECT_FOLLOWER}`, "i");
}

/** A demand that names the format as the output ("as an html page", "in html", "into mermaid"). */
function formatDemand(noun: string): RegExp {
	return new RegExp(`\\b(?:as|in|into)\\s+(?:an?\\s+|the\\s+)?${noun}\\b${SUBJECT_FOLLOWER}`, "i");
}

const DIAGRAM_NOUN = "(?:diagrams?|flow ?charts?|mermaid|svg|sequence charts?|concept maps?)";
const HTML_ARTIFACT_NOUN = "(?:html\\s+(?:pages?|files?|documents?|explainers?|reports?|slides?)|web ?pages?)";
const HTML_FORMAT_NOUN = "(?:html(?:\\s+(?:pages?|files?|documents?))?|web ?pages?)";
const VIDEO_NOUN = "(?:videos?|screencasts?)";

/**
 * The output formats an owner can demand and the bundled skill that produces each. The skills are found by
 * their own descriptions and `skill search`; this table is what lets the search answer a format query with that
 * skill first, whatever other skills mention the same words.
 * A demand is an output verb or phrase ("make a diagram", "explain it in HTML", "explainer video", "draw
 * the flow"), never the bare format word: "html parsing bug" asks for no page.
 */
const OUTPUT_FORMAT_SKILL_ROUTES: ReadonlyArray<{ readonly skill: string; readonly demands: readonly RegExp[] }> = [
	{
		skill: "explain-diagram",
		demands: [
			makeDemand(DIAGRAM_NOUN),
			formatDemand(DIAGRAM_NOUN),
			/\bdraw\s+(?:me\s+|up\s+|out\s+)?(?:an?|the|how|what|this|that|it)\b/i,
		],
	},
	{
		skill: "explain-html",
		demands: [makeDemand(HTML_ARTIFACT_NOUN), formatDemand(HTML_FORMAT_NOUN)],
	},
	{
		skill: "explain-video",
		demands: [
			makeDemand(VIDEO_NOUN),
			formatDemand(VIDEO_NOUN),
			/\b(?:explainer|narrated)\s+(?:videos?|walkthroughs?|explainers?)\b/i,
			/\bscreencasts?\b/i,
			/\b3b1b\b/i,
			/\b(?:as|into|to)\s+(?:an?\s+)?mp4\b/i,
		],
	},
];

/**
 * The one format skill a query demands. A query that names several formats has no single answer, so it
 * returns nothing so semantic discovery can judge the query.
 */
function demandedFormatSkill(query: string): string | undefined {
	const matches = OUTPUT_FORMAT_SKILL_ROUTES.filter((route) => route.demands.some((demand) => demand.test(query)));
	return matches.length === 1 ? matches[0]?.skill : undefined;
}

function skillHeader(skill: Skill): SkillHeader {
	return Object.freeze({ name: skill.name, description: compactDescription(skill.description) });
}

function headerSection(skill: Skill, header: SkillHeader, slot: number, order: number): SkillPromptSection {
	const sourceId = createHash("sha256")
		.update(JSON.stringify([skill.filePath, skill.baseDir, skill.description]))
		.digest("hex");
	const section = `DISCOVERED SKILL [${slot}] ${JSON.stringify(header.name)}\n${header.description}\nUse the skill vault if you need its body.`;
	return Object.freeze({
		name: header.name,
		recordId: String(slot),
		section,
		discovery: Object.freeze({
			sourceId,
			order,
			digest: discoveredSkillDigest(section, sourceId, order),
		}),
	});
}

interface SkillDiscoveryDeps {
	getEligibleSkills(): readonly Skill[];
	refreshSkills?: () => void;
	matchesWorkPaths(skill: Skill): boolean;
	workPathsRevision(): number;
	getSemanticEngine?(): SemanticDecisionEngine | undefined;
	getSemanticProvider?(): string | undefined;
	now(): number;
	getOrigin?(): AccountingOrigin | undefined;
}

/** Selects from the eligible catalog and retains only headers this conversation has discovered. */
export class SkillDiscovery {
	private readonly selected = new Map<string, { skill: Skill; header: SkillHeader; section: SkillPromptSection }>();
	private generation = 0;
	private restored = false;
	private latestOrder = 0;
	private headerProjection: readonly SkillPromptSection[] | undefined;
	private catalog: SkillCatalog | undefined;
	private recentRank?: {
		catalog: SkillCatalog;
		query: string;
		pathsRevision: number;
		ranked: readonly RankedSkill[];
		candidates: readonly SkillHeader[];
	};

	private readonly deps: SkillDiscoveryDeps;
	private readonly semanticRanking: SkillSemanticRanking;

	constructor(deps: SkillDiscoveryDeps) {
		this.deps = deps;
		this.semanticRanking = new SkillSemanticRanking(deps.now);
	}

	clear(): void {
		this.selected.clear();
		this.headerProjection = undefined;
		this.catalog = undefined;
		this.recentRank = undefined;
		this.semanticRanking.clear();
		this.latestOrder = 0;
		this.generation++;
	}

	restoreSkillHeaders(
		readSlot: (id: string) =>
			| {
					readonly content: string | undefined;
					readonly record: TransientRecordPayload | undefined;
			  }
			| undefined,
	): void {
		if (this.restored) return;
		this.restored = true;
		if (this.selected.size > 0) return;
		const eligible = this.deps.getEligibleSkills();
		const restored: { skill: Skill; header: SkillHeader; section: SkillPromptSection; order: number }[] = [];
		for (let slot = 1; slot <= MAX_DISCOVERED_SKILL_HEADERS; slot++) {
			const prior = readSlot(String(slot));
			const record = prior?.record as
				| (TransientRecordPayload & { name?: unknown; sourceId?: unknown; order?: unknown })
				| undefined;
			if (
				record?.v !== 1 ||
				record.k !== DISCOVERED_SKILL_RECORD_KIND ||
				typeof record.name !== "string" ||
				typeof record.order !== "number" ||
				!Number.isSafeInteger(record.order) ||
				record.order <= 0
			)
				continue;
			const skill = eligible.find((candidate) => candidate.name === record.name);
			if (!skill) continue;
			const header = skillHeader(skill);
			const section = headerSection(skill, header, slot, record.order);
			if (section.discovery?.sourceId === record.sourceId && section.section === prior?.content) {
				restored.push({ skill: { ...skill }, header, section, order: record.order });
			}
		}
		for (const { order, ...entry } of restored.sort((left, right) => left.order - right.order)) {
			this.selected.delete(entry.header.name);
			this.selected.set(entry.header.name, entry);
			this.headerProjection = undefined;
			this.latestOrder = order;
		}
	}

	hasSelectedHeaders(): boolean {
		return this.selected.size > 0;
	}

	previewSkillHeaders(
		inventory?: readonly Skill[],
		isEligible?: (skill: Skill) => boolean,
	): readonly SkillPromptSection[] {
		if (this.selected.size === 0) return EMPTY_SKILL_PROMPT_SECTIONS;
		const skills = inventory ?? this.deps.getEligibleSkills();
		const current = new Set<string>();
		for (const skill of skills) {
			const selected = this.selected.get(skill.name);
			if (selected && matchesSkillSource(selected.skill, skill) && (!isEligible || isEligible(skill))) {
				current.add(skill.name);
				if (current.size === this.selected.size) break;
			}
		}
		for (const name of this.selected.keys()) {
			if (current.has(name)) continue;
			this.selected.delete(name);
			this.headerProjection = undefined;
		}
		if (this.selected.size === 0) return EMPTY_SKILL_PROMPT_SECTIONS;
		this.headerProjection ??= Object.freeze([...this.selected.values()].map((entry) => entry.section));
		return this.headerProjection;
	}

	async search(rawQuery: string, options: SkillDiscoveryOptions = {}): Promise<SkillSearchResult> {
		options.signal?.throwIfAborted();
		const query = rawQuery.trim().slice(0, MAX_SKILL_SEARCH_QUERY_CHARS);
		if (!query) return { candidates: [] };
		const normalizedQuery = query.toLowerCase();
		const explicitFormat = demandedFormatSkill(normalizedQuery);
		let eligible = this.deps.getEligibleSkills();
		const generation = this.generation;
		const direct = this.findDirect(eligible, normalizedQuery, explicitFormat);
		if (direct) return direct;
		const terms = searchTerms(query);
		if (terms.size === 0) return { candidates: [] };
		let source = this.semanticSource();

		let prepared = this.prepareSearch(this.captureCatalog(eligible), normalizedQuery, terms);
		let refreshed = false;
		const refresh = (): SkillSearchResult | undefined => {
			if (refreshed || !this.deps.refreshSkills) return undefined;
			refreshed = true;
			this.deps.refreshSkills();
			eligible = this.deps.getEligibleSkills();
			if (generation !== this.generation) return { candidates: [] };
			const direct = this.findDirect(eligible, normalizedQuery, explicitFormat);
			if (direct) return direct;
			prepared = this.prepareSearch(this.captureCatalog(eligible), normalizedQuery, terms);
			source = this.semanticSource();
			return undefined;
		};
		const couldBeExact = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalizedQuery);
		if (!prepared.ranked[0] || (prepared.ranked[0].score <= 0 && (!source || couldBeExact))) {
			const found = refresh();
			if (found) return found;
		}
		if (prepared.ranked.length === 0) return { candidates: [] };
		if (!source) {
			this.semanticRanking.clear();
			return this.lexicalResult(prepared.ranked, "unavailable");
		}
		const deadline = this.deps.now() + SKILL_RANKING_TIMEOUT_MS;
		let timeoutMs: number | undefined;
		while (source && prepared.ranked.length > 0) {
			const rankingSource = source;
			const semantic = await this.semanticRanking.rank({
				source: rankingSource,
				query,
				catalogDigest: prepared.catalog.digest,
				candidates: prepared.candidates,
				origin: this.deps.getOrigin?.(),
				evaluationScope: options.evaluationScope,
				signal: options.signal,
				timeoutMs,
			});
			options.signal?.throwIfAborted();
			const current = this.captureCatalog(this.deps.getEligibleSkills());
			if (generation !== this.generation) return { candidates: [] };
			if (
				!sameSkillRankingSource(rankingSource, this.semanticSource()) ||
				current !== prepared.catalog ||
				this.deps.workPathsRevision() !== prepared.pathsRevision
			) {
				return this.lexicalResult(this.prepareSearch(current, normalizedQuery, terms).ranked, "unavailable");
			}
			const chosen = semantic.kind === "match" ? current.byName.get(semantic.name) : undefined;
			if (chosen) {
				const result = this.remember(chosen.skill, "semantic");
				return semantic.reused ? { ...result, semantic: "reused" } : result;
			}

			if (!prepared.ranked[0]?.score && !refreshed && this.deps.refreshSkills) {
				const found = refresh();
				if (found) return found;
				if (prepared.catalog !== current) {
					timeoutMs = Math.floor(deadline - this.deps.now());
					if (semantic.kind !== "unavailable" && timeoutMs > 0) continue;
					return this.lexicalResult(prepared.ranked, "unavailable");
				}
				if (!sameSkillRankingSource(rankingSource, source))
					return this.lexicalResult(prepared.ranked, "unavailable");
			}
			if (semantic.kind === "uncertain" || semantic.kind === "unavailable") {
				return this.lexicalResult(prepared.ranked, semantic.kind);
			}
			const result: SkillSearchResult = { candidates: [], ranking: "semantic" };
			return semantic.reused ? { ...result, semantic: "reused" } : result;
		}
		return this.lexicalResult(prepared.ranked, "unavailable");
	}

	private findDirect(
		skills: readonly Skill[],
		query: string,
		explicitFormat: string | undefined,
	): SkillSearchResult | undefined {
		const exact = skills.find((skill) => skill.name.toLowerCase() === query);
		if (exact) return this.remember(exact, "exact");
		const format = explicitFormat ? skills.find((skill) => skill.name === explicitFormat) : undefined;
		return format ? this.remember(format, "format") : undefined;
	}

	private semanticSource(): SkillRankingSource | undefined {
		const engine = this.deps.getSemanticEngine?.();
		const capabilities = engine?.capabilities();
		return engine && capabilities?.choice && capabilities.boolean
			? { engine, provider: this.deps.getSemanticProvider?.() }
			: undefined;
	}

	private captureCatalog(skills: readonly Skill[]): SkillCatalog {
		const current = this.catalog;
		if (
			current?.entries.length === skills.length &&
			current.entries.every((entry, index) => matchesCatalogSkill(entry, skills[index]!))
		) {
			return current;
		}
		this.recentRank = undefined;
		this.catalog = compileCatalog(skills);
		return this.catalog;
	}

	private prepareSearch(
		catalog: SkillCatalog,
		query: string,
		terms: ReadonlySet<string>,
	): NonNullable<SkillDiscovery["recentRank"]> {
		const pathsRevision = this.deps.workPathsRevision();
		const recent = this.recentRank;
		if (recent?.catalog === catalog && recent.query === query && recent.pathsRevision === pathsRevision)
			return recent;
		const ranked = catalog.entries
			.map((entry) => {
				const score = searchScore(entry, terms);
				return {
					entry,
					score: score > 0 && this.deps.matchesWorkPaths(entry.skill) ? score + PATH_MATCH_SCORE : score,
				};
			})
			.sort((left, right) => right.score - left.score || left.entry.skill.name.localeCompare(right.entry.skill.name))
			.slice(0, MAX_SEMANTIC_SKILL_CANDIDATES);
		this.recentRank = {
			catalog,
			query,
			pathsRevision,
			ranked,
			candidates: ranked.map(({ entry }) => entry.header),
		};
		return this.recentRank;
	}

	private lexicalResult(ranked: readonly RankedSkill[], semantic: "uncertain" | "unavailable"): SkillSearchResult {
		const best = ranked[0];
		if (!best || best.score <= 0) return { candidates: [], ranking: "lexical", semantic };
		if (best.score === ranked[1]?.score) return { candidates: [], ranking: "lexical", semantic, ambiguous: true };
		return { ...this.remember(best.entry.skill, "lexical"), semantic };
	}

	private remember(skill: Skill, ranking: NonNullable<SkillSearchResult["ranking"]>): SkillSearchResult {
		const existing = this.selected.get(skill.name);
		if (existing && matchesSkillSource(existing.skill, skill)) {
			return { candidates: [existing.header], ranking };
		}
		this.selected.delete(skill.name);
		if (this.selected.size === MAX_DISCOVERED_SKILL_HEADERS) {
			const oldest = this.selected.keys().next();
			if (!oldest.done) this.selected.delete(oldest.value);
		}
		const occupied = new Set([...this.selected.values()].map((entry) => entry.section.recordId));
		let slot = 1;
		while (occupied.has(String(slot))) slot++;
		const header = skillHeader(skill);
		const section = headerSection(skill, header, slot, ++this.latestOrder);
		this.selected.set(skill.name, { skill: { ...skill }, header, section });
		this.headerProjection = undefined;
		return { candidates: [header], ranking };
	}
}
