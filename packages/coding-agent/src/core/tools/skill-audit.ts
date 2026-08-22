import type { AgentTool } from "@caupulican/pi-agent-core";
import { type Static, Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { loadSkills, type Skill } from "../skills.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const DUPLICATE_THRESHOLD = 0.55;
export const DEFAULT_BOUNDED_SKILL_AUDIT_LIMITS = Object.freeze({
	maxSkills: 256,
	maxComparisonPairs: 32_768,
	maxDraftFieldChars: 16_384,
});
export const DEFAULT_WORKER_SKILL_AUDIT_MAX_SKILLS = DEFAULT_BOUNDED_SKILL_AUDIT_LIMITS.maxSkills;
export const DEFAULT_WORKER_SKILL_AUDIT_MAX_COMPARISON_PAIRS = DEFAULT_BOUNDED_SKILL_AUDIT_LIMITS.maxComparisonPairs;
export const DEFAULT_WORKER_SKILL_AUDIT_MAX_DRAFT_FIELD_CHARS = DEFAULT_BOUNDED_SKILL_AUDIT_LIMITS.maxDraftFieldChars;

const STOPWORDS = new Set(
	"the a an and or of for to with when use using from into this that skill task work working project agent agents code files file in on by as is are be do not should about".split(
		" ",
	),
);

/**
 * Tokenize text by lowercasing, removing non-alphanumeric chars (except hyphens and colons),
 * splitting on whitespace, and filtering out short tokens and stopwords.
 */
export function tokenize(text: string): string[] {
	return [
		...new Set(
			text
				.toLowerCase()
				.replace(/[^a-z0-9:-]+/g, " ")
				.split(/\s+/)
				.filter((token) => token.length >= 3 && !STOPWORDS.has(token)),
		),
	];
}

/**
 * Calculate Jaccard similarity between two token sets.
 * Jaccard(A, B) = |A ∩ B| / |A ∪ B|
 */
export function jaccard(a: string[], b: string[]): number {
	if (a.length === 0 || b.length === 0) return 0;
	const setA = new Set(a);
	const setB = new Set(b);
	let intersection = 0;
	for (const item of setA) if (setB.has(item)) intersection++;
	const union = new Set([...a, ...b]).size;
	return union === 0 ? 0 : intersection / union;
}

export interface SkillSummary {
	name: string;
	description: string;
	path: string;
	scope: string;
	keywords: string[];
}

export interface SkillAuditReport {
	generatedAt: string;
	skills: SkillSummary[];
	nearDuplicates: Array<{
		a: string;
		b: string;
		similarity: number;
		reason: string;
	}>;
	compartmentWarnings: Array<{
		skill: string;
		path: string;
		reason: string;
	}>;
	nameCollisions: Array<{
		name: string;
		paths: string[];
	}>;
	truncated?: boolean;
	recommendations?: string[];
}

export interface SkillAuditRunOptions {
	signal?: AbortSignal;
	/** Maximum number of host-provided skills considered by a bounded worker audit. */
	maxSkills?: number;
	/** Maximum number of pair comparisons performed by a bounded worker audit. */
	maxComparisonPairs?: number;
	/** Maximum characters accepted in each draft field before any discovery or comparison work. */
	maxDraftFieldChars?: number;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("Operation aborted");
}

/**
 * Audit existing skills for overlap and compare against a draft skill.
 */
export function runSkillAudit(
	cwd: string,
	draftSkill?: { name?: string; description?: string; body?: string },
	providedSkills?: readonly Skill[],
	redactPath?: (path: string) => string,
	runOptions?: SkillAuditRunOptions,
): SkillAuditReport {
	throwIfAborted(runOptions?.signal);
	const maxDraftFieldChars = runOptions?.maxDraftFieldChars;
	if (draftSkill && maxDraftFieldChars !== undefined) {
		for (const [field, value] of [
			["draftName", draftSkill.name],
			["draftDescription", draftSkill.description],
			["draftBody", draftSkill.body],
		] as const) {
			if (value !== undefined && value.length > maxDraftFieldChars) {
				throw new Error(`skill_audit_draft_too_large:${field}`);
			}
		}
	}
	// Load existing skills
	const skillsResult = providedSkills
		? { skills: providedSkills }
		: loadSkills({ cwd, agentDir: getAgentDir(), skillPaths: [], includeDefaults: true });
	const maxSkills = runOptions?.maxSkills;
	const sourceSkills =
		maxSkills === undefined
			? skillsResult.skills
			: skillsResult.skills.slice(0, Math.max(0, maxSkills - (draftSkill ? 1 : 0)));
	let truncated = sourceSkills.length < skillsResult.skills.length;

	const skills: SkillSummary[] = sourceSkills.map((skill: Skill) => ({
		name: skill.name,
		description: skill.description,
		path: redactPath?.(skill.filePath) ?? skill.filePath,
		scope: skill.sourceInfo.scope ?? "unknown",
		keywords: tokenize(`${skill.name} ${skill.description}`),
	}));

	// If a draft skill is provided, add it to the set for comparison
	if (draftSkill) {
		throwIfAborted(runOptions?.signal);
		const draftName = draftSkill.name || "draft-skill";
		const draftDesc = draftSkill.description || "";
		skills.push({
			name: draftName,
			description: draftDesc,
			path: "[draft]",
			scope: "draft",
			keywords: tokenize(`${draftName} ${draftDesc} ${draftSkill.body || ""}`),
		});
	}

	// Find near-duplicates based on Jaccard similarity
	const nearDuplicates: SkillAuditReport["nearDuplicates"] = [];
	let comparisonPairs = 0;
	comparisonLoop: for (let i = 0; i < skills.length; i++) {
		throwIfAborted(runOptions?.signal);
		for (let j = i + 1; j < skills.length; j++) {
			throwIfAborted(runOptions?.signal);
			if (
				runOptions?.maxComparisonPairs !== undefined &&
				comparisonPairs >= Math.max(0, runOptions.maxComparisonPairs)
			) {
				truncated = true;
				break comparisonLoop;
			}
			comparisonPairs++;
			const similarity = jaccard(skills[i].keywords, skills[j].keywords);
			if (similarity >= DUPLICATE_THRESHOLD) {
				const reason =
					similarity >= 0.9
						? "90%+ keyword overlap; merge/refine before adding another skill"
						: "high trigger/workflow overlap; review for dedup or compartmentalization";
				nearDuplicates.push({
					a: skills[i].path,
					b: skills[j].path,
					similarity: Number(similarity.toFixed(3)),
					reason,
				});
			}
		}
	}
	nearDuplicates.sort((a, b) => b.similarity - a.similarity);

	// Check for name collisions
	const byName = new Map<string, string[]>();
	for (const skill of skills) {
		const existing = byName.get(skill.name) ?? [];
		byName.set(skill.name, [...existing, skill.path]);
	}
	const nameCollisions = [...byName.entries()]
		.filter(([, paths]) => paths.length > 1)
		.map(([name, paths]) => ({ name, paths }));

	// Build recommendations
	const recommendations: string[] = [];
	if (draftSkill && nearDuplicates.length > 0) {
		const draftNearDupes = nearDuplicates.filter((d) => d.a === "[draft]" || d.b === "[draft]");
		if (draftNearDupes.length > 0) {
			recommendations.push(
				`Draft skill has ${draftNearDupes.length} similar existing skill(s). Consider merging or refining the trigger/scope.`,
			);
		}
	}
	if (nameCollisions.length > 0) {
		recommendations.push(
			`Found ${nameCollisions.length} skill name collision(s). Resolve naming conflicts before deployment.`,
		);
	}

	return {
		generatedAt: new Date().toISOString(),
		skills: skills.filter((s) => s.path !== "[draft]"), // Don't include draft in final skill list
		nearDuplicates,
		compartmentWarnings: [],
		nameCollisions,
		...(truncated ? { truncated: true } : {}),
		recommendations,
	};
}

const skillAuditSchema = Type.Object({
	draftName: Type.Optional(Type.String({ description: "Name of the draft skill to audit" })),
	draftDescription: Type.Optional(Type.String({ description: "Description of the draft skill" })),
	draftBody: Type.Optional(Type.String({ description: "Body/content of the draft skill" })),
});

export type SkillAuditInput = Static<typeof skillAuditSchema>;

export interface SkillAuditToolDetails {
	reportPath?: string;
}

export interface SkillAuditToolOptions {
	/** Host-owned metadata source. Omitted uses the foreground global discovery path. */
	getSkills?: () => readonly Skill[];
	/** Redacts host paths in the structured report before they can reach a worker. */
	redactPath?: (path: string) => string;
	/** Optional host-enforced bounds used by worker adapters; foreground callers remain unbounded. */
	maxSkills?: number;
	maxComparisonPairs?: number;
	maxDraftFieldChars?: number;
}

export function createSkillAuditToolDefinition(
	cwd: string,
	_options?: SkillAuditToolOptions,
): ToolDefinition<typeof skillAuditSchema, SkillAuditReport> {
	const options = _options;
	return {
		name: "skill_audit",
		label: "Skill Audit",
		description:
			"Check a draft/new skill for overlap with existing skills before creating it; flags near-duplicate triggers/descriptions via local Jaccard similarity. Read-only: does not write files.",
		promptSnippet: "Audit skill for overlaps",
		promptGuidelines: [
			"Use skill_audit to check draft skills for conflicts before creating them.",
			"Similarity >= 55% indicates potential dedup or compartmentalization work.",
		],
		parameters: skillAuditSchema,
		async execute(
			_toolCallId,
			{ draftName, draftDescription, draftBody }: SkillAuditInput,
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		): Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: SkillAuditReport;
		}> {
			const draftSkill =
				draftName || draftDescription
					? {
							name: draftName,
							description: draftDescription,
							body: draftBody,
						}
					: undefined;

			const report = runSkillAudit(cwd, draftSkill, options?.getSkills?.(), options?.redactPath, {
				signal,
				maxSkills: options?.maxSkills,
				maxComparisonPairs: options?.maxComparisonPairs,
				maxDraftFieldChars: options?.maxDraftFieldChars,
			});

			// Format the report as readable text
			const lines: string[] = [];
			lines.push(
				`Skill audit: ${report.skills.length} skill(s), ${report.nearDuplicates.length} overlap warning(s).`,
			);

			if (report.nearDuplicates.length > 0) {
				lines.push("\nTop overlap warnings:");
				for (const item of report.nearDuplicates.slice(0, 8)) {
					const aName = item.a.split("/").pop() || item.a;
					const bName = item.b.split("/").pop() || item.b;
					lines.push(`- ${(item.similarity * 100).toFixed(1)}%: ${aName} ↔ ${bName} — ${item.reason}`);
				}
			}

			if (report.nameCollisions.length > 0) {
				lines.push("\nName collisions:");
				for (const item of report.nameCollisions.slice(0, 8)) {
					lines.push(`- ${item.name}: ${item.paths.length} paths`);
				}
			}

			if (report.recommendations && report.recommendations.length > 0) {
				lines.push("\nRecommendations:");
				for (const rec of report.recommendations) {
					lines.push(`- ${rec}`);
				}
			}

			if (report.nearDuplicates.length === 0 && report.nameCollisions.length === 0) {
				lines.push("\nNo overlaps detected. This skill appears to be unique.");
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: report,
			};
		},
	};
}

export function createSkillAuditTool(cwd: string, options?: SkillAuditToolOptions): AgentTool<typeof skillAuditSchema> {
	return wrapToolDefinition(createSkillAuditToolDefinition(cwd, options));
}
