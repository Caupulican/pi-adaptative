import { createHash, randomUUID } from "node:crypto";
import { isNoulProbability, noulBand } from "../decision/noul.ts";
import type {
	CompletionRuleInput,
	MutationRuleInput,
	RuleConsequence,
	RuleDoubt,
	RuleOwner,
	RulePhase,
	RuleRepairWork,
	RuleValidationResult,
	RuleViolation,
	SemanticRule,
	TaskPostflightRuleInput,
} from "./types.ts";

export interface DecisionEngineProgram {
	readonly schema_version: "2.0";
	readonly program_id: string;
	readonly description: string;
	readonly decisions: readonly unknown[];
}

export interface DecisionEngine {
	evaluate(
		program: DecisionEngineProgram,
		state?: Record<string, unknown>,
		options?: { consequence?: string; signal?: AbortSignal },
	): Promise<{ answers?: Record<string, unknown> }>;
}

/** The semantic rule program: one question per rule, each pointing at its named rule and the named change. */
export const PROJECT_RULE_PROGRAM_ID = "rule_program_v2";

/**
 * The source marker that makes an instruction bullet a rule System One judges, with the transition it is judged at and
 * what a violation costs: `<!-- system-one: phase=mutation consequence=high -->` (both fields optional).
 */
const SEMANTIC_RULE_MARKER = /<!--\s*system-one:?([^>]*?)-->/i;
const RULE_PHASES: readonly RulePhase[] = ["mutation", "task_postflight", "completion"];
const RULE_CONSEQUENCES: readonly RuleConsequence[] = ["low", "medium", "high", "critical"];

function markerField<T extends string>(fields: string, name: string, allowed: readonly T[]): T | undefined {
	const value = new RegExp(`\\b${name}\\s*=\\s*([a-z_]+)`, "i").exec(fields)?.[1]?.toLowerCase();
	return allowed.find((candidate) => candidate === value);
}

export class SemanticRuleRegistry {
	private readonly rules = new Map<string, SemanticRule>();

	register(rule: SemanticRule): void {
		this.rules.set(rule.rule_id, rule);
	}

	registerAll(rules: readonly SemanticRule[]): void {
		for (const rule of rules) {
			this.register(rule);
		}
	}

	get(id: string): SemanticRule | undefined {
		return this.rules.get(id);
	}

	list(): readonly SemanticRule[] {
		return Array.from(this.rules.values());
	}

	applicable(changedFiles: readonly string[], phase: RulePhase): SemanticRule[] {
		return Array.from(this.rules.values()).filter((rule) => {
			if (!rule.enabled || rule.phase !== phase) return false;
			if (!rule.scope || rule.scope.length === 0 || rule.scope.includes("*") || rule.scope.includes("**/*")) {
				return true;
			}
			return changedFiles.some((file) =>
				rule.scope?.some((scopePattern) => {
					if (scopePattern.endsWith("/**")) {
						const prefix = scopePattern.slice(0, -3);
						return file.startsWith(prefix);
					}
					if (scopePattern.includes("*")) {
						const regex = new RegExp(`^${scopePattern.replace(/\./g, "\\.").replace(/\*/g, ".*")}$`);
						return regex.test(file);
					}
					return file.includes(scopePattern) || file.startsWith(scopePattern);
				}),
			);
		});
	}
}

/**
 * Compiles SemanticRule entries from Markdown source text (e.g. AGENTS.md). Every bullet is a rule. A bullet carrying
 * the `system-one` marker is judged by System One at the phase and consequence the marker names; a bullet naming one of
 * the mechanical checks below is checked by code; every other bullet is standing guidance that no transition judges
 * (style, process and conversation rules cannot be settled from a change). FR-041, FR-042.
 */
export function compileRulesFromText(text: string, sourcePath: string): SemanticRule[] {
	const digest = createHash("sha256").update(text).digest("hex");
	const lines = text.split(/\r?\n/);
	const rules: SemanticRule[] = [];

	let currentPhase: RulePhase = "mutation";
	let consequence: RuleConsequence = "medium";

	for (let i = 0; i < lines.length; i++) {
		const marker = SEMANTIC_RULE_MARKER.exec(lines[i]!);
		// The marker's own words (`phase=completion`) never move the section heuristic below.
		const line = lines[i]!.replace(SEMANTIC_RULE_MARKER, "").trim();
		if (!line) continue;

		if (line.toLowerCase().includes("postflight")) {
			currentPhase = "task_postflight";
		} else if (line.toLowerCase().includes("completion") || line.toLowerCase().includes("release")) {
			currentPhase = "completion";
		} else if (line.toLowerCase().includes("mutation") || line.toLowerCase().includes("code quality")) {
			currentPhase = "mutation";
		}

		// Detect rule lines (e.g. "- No inline imports", "- Never commit unless", "- No any")
		const ruleMatch = line.match(/^[-*]\s+(.+)$/);
		if (ruleMatch) {
			const ruleText = ruleMatch[1]!.trim();
			const ruleSlug = ruleText
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.slice(0, 40)
				.replace(/^-|-$/g, "");
			const ruleId = `rule-${ruleSlug || randomUUID().slice(0, 8)}`;

			const isDeterministic =
				ruleText.includes("inline import") ||
				ruleText.includes("any unless") ||
				ruleText.includes("commit unless") ||
				ruleText.includes("hardcode key") ||
				ruleText.includes("models.generated.ts");

			consequence =
				ruleText.toLowerCase().includes("never") || ruleText.toLowerCase().includes("mandatory")
					? "critical"
					: "medium";
			const owner: RuleOwner = marker ? "semantic" : isDeterministic ? "deterministic" : "guidance";

			rules.push({
				schema_version: "1.0",
				rule_id: ruleId,
				source: {
					path: sourcePath,
					line: i + 1,
					digest,
				},
				text: ruleText,
				scope: ["**/*"],
				// A judged rule takes its phase and consequence from its own marker, never from nearby words.
				phase: marker ? (markerField(marker[1] ?? "", "phase", RULE_PHASES) ?? "mutation") : currentPhase,
				consequence: marker
					? (markerField(marker[1] ?? "", "consequence", RULE_CONSEQUENCES) ?? "medium")
					: consequence,
				owner,
				enabled: true,
			});
		}
	}

	return rules;
}

function maxConsequence(rules: readonly SemanticRule[]): RuleConsequence {
	if (rules.some((r) => r.consequence === "critical")) return "critical";
	if (rules.some((r) => r.consequence === "high")) return "high";
	if (rules.some((r) => r.consequence === "medium")) return "medium";
	return "low";
}

/** One judged rule per question, the rule and the change named in state instead of spliced into the question. */
function semanticRuleProgram(rules: readonly SemanticRule[], phase: RulePhase): DecisionEngineProgram {
	return {
		schema_version: "2.0",
		program_id: PROJECT_RULE_PROGRAM_ID,
		description: `Whether the ${phase} change violates each judged project rule.`,
		decisions: rules.map((rule, index) => ({
			id: `violate::${rule.rule_id}`,
			kind: "boolean",
			type: "noul",
			instruction: `Does \`change\` violate the project rule in \`rules[${index}].text\`?`,
			criteria: {
				true: "Something the change does is forbidden by the rule, or the change leaves out something the rule requires of it.",
				false: "Nothing in the change goes against the rule, or the rule does not apply to what the change does.",
			},
		})),
	};
}

/** P(the change violates the rule), or undefined when the answer carries no probability (never read as a verdict). */
function violationProbability(answer: unknown): number | undefined {
	if (!answer || typeof answer !== "object") return undefined;
	const fields = answer as { noul?: unknown; probabilityTrue?: unknown };
	const probability = fields.probabilityTrue ?? fields.noul;
	return isNoulProbability(probability) ? probability : undefined;
}

/**
 * A settled "violates" is a finding the receiving agent verifies; a settled "does not" passes; anything else (an
 * undecided band or no answer) is a doubt, the same outcome an evaluator outage has.
 */
function readSemanticRules(
	rules: readonly SemanticRule[],
	phase: RulePhase,
	answers: Record<string, unknown> | undefined,
): { findings: RuleViolation[]; doubts: RuleDoubt[] } {
	const findings: RuleViolation[] = [];
	const doubts: RuleDoubt[] = [];
	for (const rule of rules) {
		const probability = violationProbability(answers?.[`violate::${rule.rule_id}`]);
		const band = probability === undefined ? "ambiguous" : noulBand(probability, "required_false");
		if (band === "hard_pass" || band === "soft_pass") continue;
		if (band === "ambiguous") {
			doubts.push({ ruleId: rule.rule_id, text: rule.text, cause: "undecided" });
			continue;
		}
		findings.push({
			ruleId: rule.rule_id,
			phase,
			consequence: rule.consequence,
			explanation: `Verify project rule finding ${rule.rule_id}: ${rule.text}`,
			suggestedFix: `Reproduce the finding, revise confirmed failures, and recheck compliance with: ${rule.text}`,
		});
	}
	return { findings, doubts };
}

/** A doubt at a postflight or completion is a verification obligation, worded as one. */
function doubtObligation(doubt: RuleDoubt, phase: RulePhase, consequence: RuleConsequence): RuleViolation {
	return {
		ruleId: doubt.ruleId,
		phase,
		consequence,
		explanation: `Verify project rule ${doubt.ruleId}, which System One ${doubt.cause === "unavailable" ? "could not judge" : "did not settle"}: ${doubt.text}`,
		suggestedFix: `Check the change against the rule, revise what does not comply, and recheck: ${doubt.text}`,
	};
}

/**
 * SemanticProjectRuleController:
 * Evaluates repository-specific semantic rules across mutation, task_postflight, and completion phases.
 * Enforces the deterministic / semantic / guidance ownership split, prevents authority expansion,
 * emits RepairWork for deterministic violations, and asks the receiving agent to verify semantic candidates.
 * Implements FR-040..FR-050.
 */
export class SemanticProjectRuleController {
	readonly registry: SemanticRuleRegistry;
	/** Resolved at every evaluation: an engine bound after the rules compiled is the one that judges them. */
	private readonly getDecisionEngine: () => DecisionEngine | undefined;
	private readonly repairLog: Array<{ ruleId: string; summary: string; timestamp: string }> = [];

	constructor(deps: {
		registry?: SemanticRuleRegistry;
		getDecisionEngine?: () => DecisionEngine | undefined;
		initialRules?: readonly SemanticRule[];
	}) {
		this.registry = deps.registry ?? new SemanticRuleRegistry();
		this.getDecisionEngine = deps.getDecisionEngine ?? (() => undefined);

		if (deps.initialRules) {
			this.registry.registerAll(deps.initialRules);
		}
	}

	registerRule(rule: SemanticRule): SemanticRule {
		this.registry.register(rule);
		return rule;
	}

	getRules(): readonly SemanticRule[] {
		return this.registry.list();
	}

	getRepairLog(): readonly { ruleId: string; summary: string; timestamp: string }[] {
		return [...this.repairLog];
	}

	/**
	 * FR-044: Mutation phase validation.
	 */
	async validateMutation(input: MutationRuleInput): Promise<RuleValidationResult> {
		input.signal?.throwIfAborted();
		const applicable = this.registry.applicable(input.changedFiles, "mutation");
		return this.evaluateRules(applicable, input, "mutation");
	}

	/**
	 * FR-045: Task postflight phase validation.
	 */
	async validateTaskPostflight(input: TaskPostflightRuleInput): Promise<RuleValidationResult> {
		input.signal?.throwIfAborted();
		const applicable = this.registry.applicable(input.changedFiles, "task_postflight");
		return this.evaluateRules(applicable, input, "task_postflight");
	}

	/**
	 * FR-046: Completion phase validation.
	 */
	async validateCompletion(input: CompletionRuleInput): Promise<RuleValidationResult> {
		input.signal?.throwIfAborted();
		const applicable = this.registry.applicable(input.changedFiles, "completion");
		return this.evaluateRules(applicable, input, "completion");
	}

	private async evaluateRules(
		applicable: readonly SemanticRule[],
		input: {
			objectiveId?: string;
			taskId?: string;
			changedFiles: readonly string[];
			diffContent?: string;
			boundedDiffEvidence?: string | Record<string, unknown>;
			artifacts?: readonly unknown[];
			evidence?: readonly unknown[];
			fileContents?: Record<string, string>;
			signal?: AbortSignal;
		},
		phase: RulePhase,
	): Promise<RuleValidationResult> {
		if (applicable.length === 0) {
			return { passed: true, violations: [], checkedRules: 0 };
		}

		const deterministic = applicable.filter((r) => r.owner === "deterministic");
		const semantic = applicable.filter((r) => r.owner === "semantic");
		const violations: RuleViolation[] = [];
		const evidence =
			input.boundedDiffEvidence ??
			input.diffContent ??
			input.evidence ??
			input.artifacts ??
			input.fileContents ??
			null;

		// 1. Deterministic Mechanical Evaluation
		for (const rule of deterministic) {
			if (rule.check) {
				const checkResult = await rule.check(input as MutationRuleInput);
				if (checkResult) {
					violations.push(checkResult);
				}
			} else if (rule.deterministic_check?.pattern) {
				const regex = new RegExp(rule.deterministic_check.pattern);
				if (input.diffContent && regex.test(input.diffContent)) {
					violations.push({
						ruleId: rule.rule_id,
						phase,
						consequence: rule.consequence,
						targetFile: input.changedFiles[0] ?? "unknown",
						explanation: `Forbidden pattern '${rule.deterministic_check.pattern}' matched, violating rule: ${rule.text}`,
						suggestedFix: "Remove or replace forbidden pattern",
					});
				}
				for (const [filePath, content] of Object.entries(input.fileContents ?? {})) {
					if (regex.test(content)) {
						violations.push({
							ruleId: rule.rule_id,
							phase,
							consequence: rule.consequence,
							targetFile: filePath,
							explanation: `Forbidden pattern '${rule.deterministic_check.pattern}' matched in ${filePath}, violating rule: ${rule.text}`,
							suggestedFix: "Remove or replace forbidden pattern",
						});
					}
				}
			} else {
				// Default mechanical heuristics for standard rules
				const textLower = rule.text.toLowerCase();
				if (textLower.includes("inline import")) {
					// Check for inline await import() or import("...")
					for (const [filePath, content] of Object.entries(input.fileContents ?? {})) {
						if (/\bimport\s*\(/.test(content)) {
							violations.push({
								ruleId: rule.rule_id,
								phase,
								consequence: rule.consequence,
								targetFile: filePath,
								explanation: `Inline dynamic import detected in ${filePath}, violating rule: ${rule.text}`,
								suggestedFix: "Move import to top-level import statement",
							});
						}
					}
				}
			}
		}

		// If deterministic checks failed, return immediately
		if (violations.length > 0) {
			return this.toValidationResult(violations, applicable.length, input.objectiveId, input.taskId);
		}

		if (semantic.length === 0) return this.toValidationResult([], applicable.length);

		// 2. System One judgment of the rules their source marked as checkable.
		const judged = await this.judgeSemanticRules(semantic, phase, input.changedFiles, evidence, input.signal);
		const consequenceOf = new Map(semantic.map((rule) => [rule.rule_id, rule.consequence]));
		const obligations = judged.doubts.map((doubt) =>
			doubtObligation(doubt, phase, consequenceOf.get(doubt.ruleId) ?? "medium"),
		);
		const unavailable = judged.unavailable
			? `Project rule diagnostic: System One could not judge ${semantic.length} project rule(s): ${judged.unavailable}`
			: undefined;
		// A mutation is kept on a doubt: its tool result names the rules to check. A postflight or a completion turns
		// the doubt into the same verification obligation a settled finding opens.
		if (phase === "mutation" && judged.findings.length === 0 && judged.doubts.length > 0) {
			return {
				passed: true,
				violations: [],
				checkedRules: applicable.length,
				doubts: judged.doubts,
				...(unavailable ? { advisory: true, summaryEvent: unavailable } : {}),
			};
		}
		const result = this.toValidationResult(
			phase === "mutation" ? judged.findings : [...judged.findings, ...obligations],
			applicable.length,
			input.objectiveId,
			input.taskId,
			"verification",
		);
		return judged.doubts.length > 0 ? { ...result, doubts: judged.doubts } : result;
	}

	/** One request per phase, the engine resolved now; an evaluation that does not answer leaves every rule in doubt. */
	private async judgeSemanticRules(
		rules: readonly SemanticRule[],
		phase: RulePhase,
		changedFiles: readonly string[],
		change: unknown,
		signal: AbortSignal | undefined,
	): Promise<{ findings: RuleViolation[]; doubts: RuleDoubt[]; unavailable?: string }> {
		const unjudged = (reason: string) => ({
			findings: [],
			doubts: rules.map((rule) => ({ ruleId: rule.rule_id, text: rule.text, cause: "unavailable" as const })),
			unavailable: reason.slice(0, 500),
		});
		const engine = this.getDecisionEngine();
		if (!engine) return unjudged("no System One engine is configured for this session");
		try {
			const evaluation = await engine.evaluate(
				semanticRuleProgram(rules, phase),
				{ phase, rules: rules.map((rule) => ({ id: rule.rule_id, text: rule.text })), changedFiles, change },
				{ consequence: maxConsequence(rules), signal },
			);
			return readSemanticRules(rules, phase, evaluation.answers);
		} catch (error) {
			signal?.throwIfAborted();
			return unjudged(String(error instanceof Error ? error.message : error));
		}
	}

	private toValidationResult(
		violations: readonly RuleViolation[],
		checkedRules: number,
		objectiveId?: string,
		taskId?: string,
		mode: "deterministic" | "verification" | "advisory" = "deterministic",
	): RuleValidationResult {
		if (violations.length === 0) {
			// FR-049: pass is silent in operator UI
			return {
				passed: true,
				violations: [],
				checkedRules,
			};
		}
		if (mode !== "deterministic") {
			return {
				passed: false,
				...(mode === "advisory" ? { advisory: true } : { verificationRequired: true }),
				violations,
				checkedRules,
				summaryEvent: `${mode === "advisory" ? "Project rule diagnostic" : "Verify project rule findings in this lane before continuing"}: ${violations
					.map((violation) => violation.explanation)
					.join("; ")
					.slice(0, 2000)}`,
			};
		}

		// FR-047: violation => RepairWork
		const first = violations[0]!;
		const effObjectiveId = objectiveId ?? "unknown";
		const effTaskId = taskId ?? `${effObjectiveId}-rule-repair`;
		const repairWork: RuleRepairWork = {
			schema_version: "1.0",
			repair_id: `repair-${first.ruleId}-${Date.now()}`,
			objective_id: effObjectiveId,
			target_objective_id: effObjectiveId,
			target_task_id: effTaskId,
			failed_gate_id: `rule_violation_${first.ruleId}`,
			reason: `Project rule violation: ${first.explanation}`,
			required_next_proof: "Pass rule evaluation without violations",
			recommended_work_class: "implement",
			kind: "remediate_rule_violation",
			instructions: first.suggestedFix ?? `Fix violation of rule '${first.ruleId}': ${first.explanation}`,
			required_verifications: ["project_rule_recheck"],
			suggested_expert: {
				role: "implementer",
				routing_band: "fast_code",
			},
			blocking: first.consequence === "critical" || first.consequence === "high",
		};

		// FR-050: repair event visible
		const summaryEvent = `Rule violation detected · ${first.ruleId} · RepairWork queued`;
		this.repairLog.push({
			ruleId: first.ruleId,
			summary: summaryEvent,
			timestamp: new Date().toISOString(),
		});

		return {
			passed: false,
			violations,
			checkedRules,
			repairWork,
			summaryEvent,
		};
	}
}
