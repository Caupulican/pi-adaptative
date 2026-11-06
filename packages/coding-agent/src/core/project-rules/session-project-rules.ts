/**
 * Root semantic project-rule wiring for a live session.
 *
 * One controller per session owns the rules compiled from the trusted instruction files the
 * resource loader admitted, plus the durable owner policies. It is consulted at the three real
 * transitions — mutation acceptance, task postflight, and completion. Deterministic violations
 * queue durable RepairWork; semantic findings require verification in the receiving lane.
 * Conforms to GOVERNANCE_LIVE_PATHS.md and RCG-041..RCG-043, RCG-046.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { createRetentionDecisionEngine } from "../compaction/retention-decision-engine.ts";
import type { SemanticDecisionEngine } from "../decision/engine.ts";
import { RULE_CONFLICT_NOTE } from "../objective-execution/local-commit-delivery.ts";
import type { OwnerRulePolicy } from "./durable-owner-rules.ts";
import { OWNER_RULE_JUDGED_PHASES, ownerRuleToSemanticRule } from "./durable-owner-rules.ts";
import { compileRulesFromText, SemanticProjectRuleController } from "./semantic-project-rule-controller.ts";
import type { RulePhase, RuleRepairWork, RuleValidationResult, SemanticRule } from "./types.ts";
import { blocksRuleTransition } from "./types.ts";

/** A rule source the host trusts: an instruction file the resource loader already admitted. */
export interface TrustedRuleSource {
	readonly path: string;
	readonly content: string;
}

export interface SessionProjectRulesDeps {
	readonly cwd: string;
	/** Instruction files the active profile admitted. Untrusted repository text is never a source. */
	getTrustedRuleSources(): readonly TrustedRuleSource[];
	/** Durable owner policies: process rules, judged at task postflight and completion (no single edit shows them). */
	getOwnerRulePolicies(): readonly OwnerRulePolicy[];
	/** The session's semantic engine; absent means only deterministic rules can be evaluated. */
	getDecisionEngine(): SemanticDecisionEngine | undefined;
	/** Durable sink for queued RepairWork. */
	recordRepairWork(repair: RuleRepairWork): void;
	/** Bounded operator-visible notice for a violation or semantic advice. */
	emitViolation?(result: RuleValidationResult): void;
}

const MAX_RULE_FILE_EVIDENCE_BYTES = 32 * 1024;
/** Shared bound on the change a mutation's judged rules see. */
const MAX_RULE_CHANGE_CHARS = 24 * 1024;

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
		const signature = createHash("sha256")
			.update(
				JSON.stringify({
					sources: sources.map((source) => [source.path, source.content]),
					policies: policies.map((policy) => [policy.id, policy.revision]),
				}),
			)
			.digest("hex");
		if (this.controller && this.compiledSignature === signature) return this.controller;

		const rules: SemanticRule[] = [];
		for (const source of sources) {
			rules.push(...compileRulesFromText(source.content, source.path));
		}
		for (const policy of policies) {
			for (const phase of OWNER_RULE_JUDGED_PHASES) {
				rules.push(ownerRuleToSemanticRule(policy, phase));
			}
		}

		this.controller = new SemanticProjectRuleController({
			initialRules: rules,
			// The session's engine at the moment a rule is judged, not the one bound when the rules compiled.
			getDecisionEngine: () => {
				const engine = this.deps.getDecisionEngine();
				return engine ? createRetentionDecisionEngine(engine) : undefined;
			},
		});
		this.compiledSignature = signature;
		return this.controller;
	}

	/** A blocking violation is critical or high: it stops the transition it was found at. */
	static blocks(result: RuleValidationResult): boolean {
		return blocksRuleTransition(result);
	}

	private consume(result: RuleValidationResult): RuleValidationResult {
		// A kept mutation still reports an evaluator outage as an operator diagnostic.
		if (result.passed && !result.advisory) return result;
		if (result.repairWork) {
			this.queuedRepairs.push(result.repairWork);
			this.deps.recordRepairWork(result.repairWork);
		}
		if (result.advisory || SessionProjectRules.blocks(result)) this.deps.emitViolation?.(result);
		return result;
	}

	/**
	 * The tool gate's verdict on a mutation under the owner's rule authority: `user` accepts without checking, `ask`
	 * blocks a violation with the conflict note and records nothing, any other authority blocks it with the violation and
	 * the RepairWork it queued. A rule System One left unsettled never blocks: the kept result names it to check.
	 */
	async acceptMutation(
		input: { toolName: string; changedFiles: readonly string[]; patch?: string },
		authority: "unset" | "ask" | "user" | "written",
	): Promise<{ blocked: boolean; explanation?: string; repairId?: string; note?: string }> {
		if (authority === "user") return { blocked: false };
		const result = await this.validateMutation(input, { record: authority !== "ask" });
		if (!SessionProjectRules.blocks(result)) {
			const doubts = result.doubts ?? [];
			if (doubts.length === 0) return { blocked: false };
			return {
				blocked: false,
				note: `[project rules] System One did not settle whether this change follows ${doubts.length === 1 ? "this rule" : "these rules"}; check the change against ${doubts.length === 1 ? "it" : "them"} before relying on it:\n${doubts
					.map((doubt) => `- ${doubt.text}`)
					.join("\n")}`,
			};
		}
		if (authority === "ask") return { blocked: true, explanation: RULE_CONFLICT_NOTE };
		return {
			blocked: true,
			explanation: result.violations[0]?.explanation,
			repairId: result.repairWork?.repair_id,
		};
	}

	/**
	 * RCG-041: mutation acceptance. The judged change is the edit's own patch, the whole content of a file the write
	 * tool created (it only creates), or else each changed file as it now stands; bounded, with truncation flagged.
	 */
	async validateMutation(
		input: {
			objectiveId?: string;
			taskId?: string;
			toolName?: string;
			changedFiles: readonly string[];
			patch?: string;
			diffContent?: string;
			signal?: AbortSignal;
		},
		options?: { record?: boolean },
	): Promise<RuleValidationResult> {
		const { toolName, patch, ...ruleInput } = input;
		const fileContents = this.readChangedFiles(input.changedFiles);
		const result = await this.getController().validateMutation({
			...ruleInput,
			fileContents,
			boundedDiffEvidence: boundedChange(patch ?? input.diffContent, fileContents, toolName === "write"),
		});
		return options?.record === false ? result : this.consume(result);
	}

	/** RCG-042: task postflight. */
	async validateTaskPostflight(input: {
		objectiveId: string;
		taskId: string;
		changedFiles: readonly string[];
		artifacts?: readonly unknown[];
		boundedDiffEvidence?: string | Record<string, unknown>;
		signal?: AbortSignal;
	}): Promise<RuleValidationResult> {
		return this.consume(await this.getController().validateTaskPostflight(input));
	}

	/** RCG-043: completion. */
	async validateCompletion(
		input: {
			objectiveId: string;
			changedFiles: readonly string[];
			evidence?: readonly unknown[];
			boundedDiffEvidence?: string | Record<string, unknown>;
			signal?: AbortSignal;
		},
		options?: { record?: boolean },
	): Promise<RuleValidationResult> {
		const result = await this.getController().validateCompletion(input);
		return options?.record === false ? result : this.consume(result);
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

/** The change a mutation rule is judged against, within one shared bound. */
function boundedChange(
	patch: string | undefined,
	fileContents: Record<string, string>,
	created: boolean,
): Record<string, unknown> {
	if (patch !== undefined) {
		return { patch: patch.slice(0, MAX_RULE_CHANGE_CHARS), truncated: patch.length > MAX_RULE_CHANGE_CHARS };
	}
	let remaining = MAX_RULE_CHANGE_CHARS;
	let truncated = false;
	const files: { path: string; content: string }[] = [];
	for (const [path, content] of Object.entries(fileContents)) {
		const kept = content.slice(0, Math.max(0, remaining));
		if (kept.length < content.length) truncated = true;
		remaining -= kept.length;
		files.push({ path, content: kept });
	}
	return { [created ? "createdFiles" : "filesAfterChange"]: files, truncated };
}

export type { RulePhase, RuleValidationResult };
