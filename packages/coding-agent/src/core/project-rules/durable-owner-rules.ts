/**
 * Durable owner development rules.
 *
 * An owner instruction like `no TDD, mandatory, fast paced only` is policy, not prompt text: it has
 * to outlive the turn that carried it, survive compaction and restart, and reach every worker,
 * synthesized specialist and capability builder the session dispatches.
 *
 * The normalizer reads the owner's own words through a lexicon of development-process directives,
 * so any instruction of that class is captured — not one recognized sentence.
 * Conforms to DURABLE_USER_RULES.md, GOVERNANCE_LIVE_PATHS.md and RCG-010..014, RCG-046.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RuleConsequence, SemanticRule } from "./types.ts";

export const OWNER_RULE_SCHEMA_VERSION = "1.0" as const;

export type OwnerRulePhase = "build" | "adapt" | "verify" | "deliver";

/** Process behaviours an owner rule can forbid, and the vocabulary that names each one. */
export type OwnerForbiddenPractice =
	| "tdd_workflow"
	| "full_suite_per_edit"
	| "full_repo_gate_per_edit"
	| "repeated_expensive_green_validation";

export type OwnerPreferredPractice =
	| "targeted_compile_or_typecheck"
	| "smallest_factual_probe"
	| "batched_implementation"
	| "milestone_validation";

export interface OwnerRulePolicy {
	readonly schema_version: typeof OWNER_RULE_SCHEMA_VERSION;
	readonly id: string;
	readonly source_message_id?: string;
	/** The owner's exact words, never paraphrased. */
	readonly original_text: string;
	readonly normalized_rule: string;
	readonly phases: readonly OwnerRulePhase[];
	readonly consequence: RuleConsequence;
	readonly forbid: readonly OwnerForbiddenPractice[];
	readonly prefer: readonly OwnerPreferredPractice[];
	readonly allow: readonly string[];
	readonly broad_verification_phases: readonly OwnerRulePhase[];
	readonly revision: number;
	readonly created_at: string;
	readonly updated_at: string;
}

interface DirectiveMatcher {
	readonly practice: OwnerForbiddenPractice;
	readonly patterns: readonly RegExp[];
}

/**
 * Negated development practices, recognized by what the owner actually forbade.
 * Each pattern requires the negation and the practice in the same clause, so "we should use TDD"
 * never registers as a prohibition.
 */
const FORBIDDEN_DIRECTIVES: readonly DirectiveMatcher[] = [
	{
		practice: "tdd_workflow",
		patterns: [
			/\b(?:no|never|without|skip|don'?t\s+(?:use|do)|avoid|not)\s+(?:any\s+)?(?:tdd|test[-\s]?first|test[-\s]?driven(?:\s+development)?|red[-\s/]green)\b/i,
			/\btdd\b[^.!?]{0,20}\b(?:forbidden|banned|prohibited|not\s+allowed|off)\b/i,
		],
	},
	{
		practice: "full_suite_per_edit",
		patterns: [
			/\b(?:no|never|without|skip|don'?t\s+run|avoid|not)\s+(?:the\s+)?(?:full|whole|entire|complete)\s+(?:test\s+)?suite\b/i,
			/\b(?:full|whole|entire)\s+(?:test\s+)?suite\b[^.!?]{0,30}\b(?:per\s+edit|after\s+(?:each|every)|forbidden|banned)\b/i,
		],
	},
	{
		practice: "full_repo_gate_per_edit",
		patterns: [
			/\b(?:no|never|without|skip|don'?t\s+run|avoid|not)\s+(?:a\s+)?(?:full\s+)?(?:npm\s+run\s+check|repo(?:sitory)?\s+gate|full\s+check)\b/i,
			/\b(?:npm\s+run\s+check|repo(?:sitory)?\s+gate)\b[^.!?]{0,30}\b(?:per\s+edit|after\s+(?:each|every)|forbidden|banned)\b/i,
		],
	},
	{
		practice: "repeated_expensive_green_validation",
		patterns: [
			/\b(?:no|never|don'?t|avoid|stop)\s+(?:re)?running\s+(?:already[-\s]green|passing|green)\b/i,
			/\b(?:no|never|avoid)\s+(?:repeated|redundant)\s+(?:expensive\s+)?(?:validation|verification|gates?)\b/i,
		],
	},
];

/** Pace directives: they add the preferred practices rather than forbidding a named one. */
const FAST_PACE_PATTERNS: readonly RegExp[] = [
	/\bfast[-\s]?pac(?:e|ed|ing)\b/i,
	/\b(?:move|go|work|iterate|ship)\s+fast\b/i,
	/\bfast\s+iteration\b/i,
	/\bquick(?:ly)?\s+(?:iterate|iteration|turnaround)\b/i,
];

/** Escalators: the owner saying this is not optional. */
const MANDATORY_PATTERNS: readonly RegExp[] = [
	/\bmandator(?:y|ily)\b/i,
	/\bnon[-\s]?negoti(?:able|nable)\b/i,
	/\bnot\s+negoti(?:able|nable)\b/i,
	/\brequired\b/i,
	/\bhard\s+requirement\b/i,
	/\balways\b/i,
	/\bnever\b/i,
];

const DEFAULT_PREFERENCES: readonly OwnerPreferredPractice[] = [
	"targeted_compile_or_typecheck",
	"smallest_factual_probe",
	"batched_implementation",
	"milestone_validation",
];

const DEFAULT_ALLOWANCES: readonly string[] = [
	"a tiny probe required to establish a specific fact",
	"a mandatory mechanical activation proof",
];

/**
 * Normalizes an owner instruction into a durable policy, or returns undefined when the text carries
 * no development-process directive. Absence of a match is not a silent pass: the caller records
 * nothing, and no policy claims authority it was not given.
 */
export function normalizeOwnerRule(text: string, sourceMessageId?: string): OwnerRulePolicy | undefined {
	const original = text.trim();
	if (!original) return undefined;

	const forbid: OwnerForbiddenPractice[] = [];
	for (const directive of FORBIDDEN_DIRECTIVES) {
		if (directive.patterns.some((pattern) => pattern.test(original))) forbid.push(directive.practice);
	}
	const fastPaced = FAST_PACE_PATTERNS.some((pattern) => pattern.test(original));
	if (fastPaced) {
		// A fast-pace directive is a statement about validation cost per edit; the practices it rules
		// out are exactly the per-edit expensive gates.
		for (const practice of ["full_suite_per_edit", "full_repo_gate_per_edit"] as const) {
			if (!forbid.includes(practice)) forbid.push(practice);
		}
	}
	if (forbid.length === 0) return undefined;

	const mandatory = MANDATORY_PATTERNS.some((pattern) => pattern.test(original));
	const now = new Date().toISOString();
	const id = `owner-rule-${createHash("sha256").update(forbid.slice().sort().join("|")).digest("hex").slice(0, 12)}`;

	return {
		schema_version: OWNER_RULE_SCHEMA_VERSION,
		id,
		...(sourceMessageId ? { source_message_id: sourceMessageId } : {}),
		original_text: original,
		normalized_rule: describeOwnerRule(forbid, fastPaced),
		phases: ["build", "adapt"],
		consequence: mandatory ? "critical" : "high",
		forbid,
		prefer: [...DEFAULT_PREFERENCES],
		allow: [...DEFAULT_ALLOWANCES],
		broad_verification_phases: ["verify", "deliver"],
		revision: 1,
		created_at: now,
		updated_at: now,
	};
}

function describeOwnerRule(forbid: readonly OwnerForbiddenPractice[], fastPaced: boolean): string {
	const clauses: string[] = [];
	if (forbid.includes("tdd_workflow")) clauses.push("no test-first or red/green workflow");
	if (forbid.includes("full_suite_per_edit")) clauses.push("no full test suite after an edit");
	if (forbid.includes("full_repo_gate_per_edit")) clauses.push("no whole-repository gate after an edit");
	if (forbid.includes("repeated_expensive_green_validation")) clauses.push("no rerun of an already-green gate");
	if (fastPaced) clauses.push("use the cheapest targeted check that establishes the current fact");
	return `During build and adapt: ${clauses.join("; ")}. Broad verification belongs to verify and deliver.`;
}

/** One line per active policy, for a mission, a steering state, or an operator view. */
export function renderOwnerRulesForMission(policies: readonly OwnerRulePolicy[]): string {
	if (policies.length === 0) return "";
	const lines = policies.map(
		(policy) =>
			`- ${policy.normalized_rule} (owner instruction, ${policy.consequence}; original: "${policy.original_text}")`,
	);
	return ["MANDATORY OWNER DEVELOPMENT RULES", ...lines].join("\n");
}

/** Projects a policy into the semantic rule registry so violations block a transition. */
export function ownerRuleToSemanticRule(policy: OwnerRulePolicy, phase: SemanticRule["phase"]): SemanticRule {
	return {
		schema_version: "1.0",
		rule_id: `${policy.id}:${phase}`,
		source: { path: "owner:instruction", line: null, digest: policy.id },
		text: policy.normalized_rule,
		scope: ["**/*"],
		phase,
		consequence: policy.consequence,
		owner: "jev",
		enabled: true,
	};
}

interface OwnerRuleFile {
	schema_version: typeof OWNER_RULE_SCHEMA_VERSION;
	policies: OwnerRulePolicy[];
}

/**
 * Durable store for owner rules, keyed by project so one machine's sessions on different
 * repositories do not inherit each other's policy. Restored on construction, which is how a policy
 * survives a restart and, equally, a compaction that dropped the message that created it.
 */
export class DurableOwnerRuleStore {
	private readonly filePath: string;
	private policies: OwnerRulePolicy[] = [];

	constructor(options: { agentDir: string; projectKey: string }) {
		const digest = createHash("sha256").update(options.projectKey).digest("hex").slice(0, 16);
		this.filePath = join(options.agentDir, "owner-rules", `${digest}.json`);
		this.load();
	}

	get path(): string {
		return this.filePath;
	}

	private load(): void {
		if (!existsSync(this.filePath)) return;
		try {
			const parsed = JSON.parse(readFileSync(this.filePath, "utf-8")) as OwnerRuleFile;
			if (Array.isArray(parsed?.policies)) this.policies = parsed.policies;
		} catch {
			// A corrupt policy file must not silently mean "no rules": it means the rules are
			// unreadable, so the store stays empty and the caller's fail-closed path applies.
			this.policies = [];
		}
	}

	private persist(): void {
		mkdirSync(dirname(this.filePath), { recursive: true });
		const file: OwnerRuleFile = { schema_version: OWNER_RULE_SCHEMA_VERSION, policies: this.policies };
		const temporary = `${this.filePath}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(file, null, "\t")}\n`, "utf-8");
		renameSync(temporary, this.filePath);
	}

	list(): readonly OwnerRulePolicy[] {
		return [...this.policies];
	}

	/**
	 * Records a policy, bumping its revision when the owner restated the same rule with new words.
	 * Returns the stored policy, or undefined when the text carried no directive.
	 */
	record(text: string, sourceMessageId?: string): OwnerRulePolicy | undefined {
		const policy = normalizeOwnerRule(text, sourceMessageId);
		if (!policy) return undefined;
		const existingIndex = this.policies.findIndex((candidate) => candidate.id === policy.id);
		if (existingIndex < 0) {
			this.policies.push(policy);
			this.persist();
			return policy;
		}
		const existing = this.policies[existingIndex] as OwnerRulePolicy;
		if (existing.original_text === policy.original_text && existing.consequence === policy.consequence) {
			return existing;
		}
		const updated: OwnerRulePolicy = {
			...policy,
			created_at: existing.created_at,
			revision: existing.revision + 1,
			updated_at: new Date().toISOString(),
		};
		this.policies[existingIndex] = updated;
		this.persist();
		return updated;
	}
}
