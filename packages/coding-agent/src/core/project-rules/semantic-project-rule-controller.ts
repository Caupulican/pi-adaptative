import { createHash, randomUUID } from "node:crypto";
import { noulFromAnswer, settledNoul } from "../system-one/policy.ts";
import type {
	CompletionRuleInput,
	MutationRuleInput,
	RuleConsequence,
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
	): Promise<{
		answers?: Record<string, { type?: string; boolean?: boolean; choice?: string; value?: boolean | number }>;
		results?: Record<string, { kind?: string; confidence?: { value?: number }; selected?: unknown }>;
	}>;
}

export interface SteeringPlane {
	requireCertificate(
		checkpoint: string,
		payload: unknown,
		context?: { objectiveId?: string; taskId?: string; signal?: AbortSignal },
	): Promise<{ certificate_id: string; answers?: Record<string, unknown> }>;
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
 * Compiles SemanticRule entries from Markdown source text (e.g. AGENTS.md).
 * FR-041, FR-042.
 */
export function compileRulesFromText(text: string, sourcePath: string): SemanticRule[] {
	const digest = createHash("sha256").update(text).digest("hex");
	const lines = text.split(/\r?\n/);
	const rules: SemanticRule[] = [];

	let currentPhase: RulePhase = "mutation";
	let consequence: RuleConsequence = "medium";

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!.trim();
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
				phase: currentPhase,
				consequence,
				owner: isDeterministic ? "deterministic" : "jev",
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

function ruleViolationAnswer(answer: unknown): number | boolean {
	const fields = answer && typeof answer === "object" ? (answer as { probabilityTrue?: unknown }) : undefined;
	const probability =
		typeof fields?.probabilityTrue === "number" ? fields.probabilityTrue : noulFromAnswer(answer, true);
	return typeof probability === "number" && (!Number.isFinite(probability) || probability < 0 || probability > 1)
		? true
		: probability;
}

function semanticRuleFindings(
	rules: readonly SemanticRule[],
	phase: RulePhase,
	answers: Record<string, unknown> | undefined,
	certificateId?: string,
): RuleViolation[] {
	const findings: RuleViolation[] = [];
	for (const rule of rules) {
		if (settledNoul(ruleViolationAnswer(answers?.[`violate::${rule.rule_id}`]), "required_false", true) === false)
			continue;
		findings.push({
			ruleId: rule.rule_id,
			phase,
			consequence: rule.consequence,
			explanation: `Verify project rule finding ${rule.rule_id}${certificateId ? ` from certificate ${certificateId}` : ""}: ${rule.text}`,
			suggestedFix: `Reproduce the finding, revise confirmed failures, and recheck compliance with: ${rule.text}`,
		});
	}
	return findings;
}

/**
 * SemanticProjectRuleController:
 * Evaluates repository-specific semantic rules across mutation, task_postflight, and completion phases.
 * Enforces deterministic vs Jev ownership split, prevents authority expansion,
 * emits RepairWork for deterministic violations, and asks the receiving agent to verify semantic candidates.
 * Implements FR-040..FR-050.
 */
export class SemanticProjectRuleController {
	readonly registry: SemanticRuleRegistry;
	private readonly decisionEngine?: DecisionEngine;
	private readonly steering?: SteeringPlane;
	private readonly repairLog: Array<{ ruleId: string; summary: string; timestamp: string }> = [];

	constructor(deps: {
		registry?: SemanticRuleRegistry;
		decisionEngine?: DecisionEngine;
		steering?: SteeringPlane;
		initialRules?: readonly SemanticRule[];
	}) {
		this.registry = deps.registry ?? new SemanticRuleRegistry();
		this.decisionEngine = deps.decisionEngine;
		this.steering = deps.steering;

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
		const semantic = applicable.filter((r) => r.owner === "jev");
		const violations: RuleViolation[] = [];
		const evidence = input.boundedDiffEvidence ?? input.evidence ?? input.artifacts;

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

		// 2. Semantic Jev Evaluation
		if (semantic.length > 0) {
			if (this.decisionEngine) {
				const program: DecisionEngineProgram = {
					schema_version: "2.0",
					program_id: `rule_program_${Date.now()}`,
					description: `Evaluate semantic project rules for phase ${phase}`,
					decisions: semantic.map((r) => ({
						id: `violate::${r.rule_id}`,
						kind: "boolean",
						type: "noul",
						instruction: `Does the change violate the following project rule? Rule: "${r.text}"`,
					})),
				};

				try {
					const evaluation = await this.decisionEngine.evaluate(
						program,
						{
							changedFiles: input.changedFiles,
							evidence,
						},
						{ consequence: maxConsequence(semantic), signal: input.signal },
					);

					violations.push(
						...semanticRuleFindings(semantic, phase, { ...evaluation.answers, ...evaluation.results }),
					);
				} catch (error) {
					input.signal?.throwIfAborted();
					violations.push({
						ruleId: "semantic_rule_eval_unavailable",
						phase,
						consequence: maxConsequence(semantic),
						explanation: `Semantic project-rule evaluation unavailable: ${String(error instanceof Error ? error.message : error).slice(0, 500)}`,
					});
					return this.toValidationResult(
						violations,
						applicable.length,
						input.objectiveId,
						input.taskId,
						"advisory",
					);
				}
			} else if (this.steering) {
				// Require certificate JEV-PROJECT-RULE
				try {
					const cert = await this.steering.requireCertificate(
						"JEV-PROJECT-RULE",
						{
							phase,
							rules: semantic.map((r) => ({ id: r.rule_id, text: r.text })),
							changedFiles: input.changedFiles,
							evidence,
						},
						{ objectiveId: input.objectiveId, taskId: input.taskId, signal: input.signal },
					);

					violations.push(...semanticRuleFindings(semantic, phase, cert.answers, cert.certificate_id));
				} catch (error) {
					input.signal?.throwIfAborted();
					violations.push({
						ruleId: "semantic_rule_certificate_unavailable",
						phase,
						consequence: maxConsequence(semantic),
						explanation: `Semantic project-rule certificate unavailable: ${String(error instanceof Error ? error.message : error).slice(0, 500)}`,
					});
					return this.toValidationResult(
						violations,
						applicable.length,
						input.objectiveId,
						input.taskId,
						"advisory",
					);
				}
			}
		}

		return this.toValidationResult(violations, applicable.length, input.objectiveId, input.taskId, "verification");
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
