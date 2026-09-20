/**
 * Root semantic project-rule wiring for a live session.
 *
 * One controller per session owns the rules compiled from the trusted instruction files the
 * resource loader admitted, plus the durable owner policies. It is consulted at the three real
 * transitions — mutation acceptance, task postflight, and completion — and a blocking violation
 * queues durable RepairWork instead of being reported and ignored.
 * Conforms to GOVERNANCE_LIVE_PATHS.md and RCG-041..RCG-043, RCG-046.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { createRetentionDecisionEngine } from "../compaction/retention-decision-engine.ts";
import type { SemanticDecisionEngine } from "../decision/engine.ts";
import type { OwnerRulePolicy } from "./durable-owner-rules.ts";
import { ownerRuleToSemanticRule } from "./durable-owner-rules.ts";
import { compileRulesFromText, SemanticProjectRuleController } from "./semantic-project-rule-controller.ts";
import type { RulePhase, RuleRepairWork, RuleValidationResult, SemanticRule } from "./types.ts";

/** A rule source the host trusts: an instruction file the resource loader already admitted. */
export interface TrustedRuleSource {
	readonly path: string;
	readonly content: string;
}

export interface SessionProjectRulesDeps {
	readonly cwd: string;
	/** Instruction files the active profile admitted. Untrusted repository text is never a source. */
	getTrustedRuleSources(): readonly TrustedRuleSource[];
	/** Durable owner policies, which are rules at every phase. */
	getOwnerRulePolicies(): readonly OwnerRulePolicy[];
	/** The session's semantic engine; absent means only deterministic rules can be evaluated. */
	getDecisionEngine(): SemanticDecisionEngine | undefined;
	/** Durable sink for queued RepairWork. */
	recordRepairWork(repair: RuleRepairWork): void;
	/** Bounded operator-visible notice for a blocking violation. */
	emitViolation?(result: RuleValidationResult): void;
}

const MAX_RULE_FILE_EVIDENCE_BYTES = 32 * 1024;

/** Session custom-entry type carrying durable RepairWork queued by a rule violation. */
export const PROJECT_RULE_REPAIR_CUSTOM_TYPE = "project-rule-repair-work";

/**
 * Owns the live rule controller and the three transition hooks.
 *
 * Rules are recompiled lazily whenever the trusted sources or owner policies change, so an edit to
 * AGENTS.md during a session takes effect without a restart.
 */
export class SessionProjectRules {
	private readonly deps: SessionProjectRulesDeps;
	private controller?: SemanticProjectRuleController;
	private compiledSignature?: string;
	private readonly queuedRepairs: RuleRepairWork[] = [];

	constructor(deps: SessionProjectRulesDeps) {
		this.deps = deps;
	}

	/** Every rule currently in force, compiled from trusted sources and owner policies. */
	getRules(): readonly SemanticRule[] {
		return this.getController().getRules();
	}

	getQueuedRepairWork(): readonly RuleRepairWork[] {
		return [...this.queuedRepairs];
	}

	private getController(): SemanticProjectRuleController {
		const sources = this.deps.getTrustedRuleSources();
		const policies = this.deps.getOwnerRulePolicies();
		const signature = [
			...sources.map((source) => `${source.path}:${source.content.length}`),
			...policies.map((policy) => `${policy.id}:${policy.revision}`),
		].join("|");
		if (this.controller && this.compiledSignature === signature) return this.controller;

		const rules: SemanticRule[] = [];
		for (const source of sources) {
			rules.push(...compileRulesFromText(source.content, source.path));
		}
		for (const policy of policies) {
			for (const phase of ["mutation", "task_postflight", "completion"] as const) {
				rules.push(ownerRuleToSemanticRule(policy, phase));
			}
		}

		const engine = this.deps.getDecisionEngine();
		this.controller = new SemanticProjectRuleController({
			initialRules: rules,
			...(engine ? { decisionEngine: createRetentionDecisionEngine(engine) } : {}),
		});
		this.compiledSignature = signature;
		return this.controller;
	}

	/** A blocking violation is critical or high: it stops the transition it was found at. */
	static blocks(result: RuleValidationResult): boolean {
		return !result.passed && result.violations.some((v) => v.consequence === "critical" || v.consequence === "high");
	}

	private consume(result: RuleValidationResult): RuleValidationResult {
		if (result.passed) return result;
		if (result.repairWork) {
			this.queuedRepairs.push(result.repairWork);
			this.deps.recordRepairWork(result.repairWork);
		}
		if (SessionProjectRules.blocks(result)) this.deps.emitViolation?.(result);
		return result;
	}

	/** RCG-041: mutation acceptance. */
	async validateMutation(input: {
		objectiveId?: string;
		taskId?: string;
		changedFiles: readonly string[];
		diffContent?: string;
		signal?: AbortSignal;
	}): Promise<RuleValidationResult> {
		const fileContents = this.readChangedFiles(input.changedFiles);
		return this.consume(
			await this.getController().validateMutation({
				...input,
				fileContents,
				boundedDiffEvidence: input.diffContent ?? summarizeFileEvidence(fileContents),
			}),
		);
	}

	/** RCG-042: task postflight. */
	async validateTaskPostflight(input: {
		objectiveId: string;
		taskId: string;
		changedFiles: readonly string[];
		artifacts?: readonly unknown[];
		signal?: AbortSignal;
	}): Promise<RuleValidationResult> {
		return this.consume(await this.getController().validateTaskPostflight(input));
	}

	/** RCG-043: completion. */
	async validateCompletion(input: {
		objectiveId: string;
		changedFiles: readonly string[];
		evidence?: readonly unknown[];
		signal?: AbortSignal;
	}): Promise<RuleValidationResult> {
		return this.consume(await this.getController().validateCompletion(input));
	}

	/** Bounded contents of the changed files, for deterministic pattern rules. */
	private readChangedFiles(changedFiles: readonly string[]): Record<string, string> {
		const contents: Record<string, string> = {};
		for (const file of changedFiles) {
			const absolute = isAbsolute(file) ? file : join(this.deps.cwd, file);
			try {
				const text = readFileSync(absolute, "utf-8");
				contents[relative(this.deps.cwd, absolute) || file] = text.slice(0, MAX_RULE_FILE_EVIDENCE_BYTES);
			} catch {
				// A file that cannot be read is not evidence of compliance; it is simply absent from the
				// deterministic pass, and the semantic pass still sees its path.
			}
		}
		return contents;
	}
}

function summarizeFileEvidence(fileContents: Record<string, string>): string {
	return Object.entries(fileContents)
		.map(([path, content]) => `${path} (${content.length} bytes)`)
		.join("\n");
}

export type { RulePhase, RuleValidationResult };
