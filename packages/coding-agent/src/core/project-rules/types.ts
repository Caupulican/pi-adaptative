import type { RepairWork } from "../objective-execution/objective-repair-work.ts";

export type RulePhase = "mutation" | "task_postflight" | "completion";
export type RuleConsequence = "low" | "medium" | "high" | "critical";
export type RuleOwner = "deterministic" | "jev";

export interface RuleSource {
	readonly path: string;
	readonly line?: number | null;
	readonly digest?: string | null;
}

export interface SemanticRule {
	readonly schema_version: "1.0";
	readonly rule_id: string;
	readonly source: RuleSource;
	readonly text: string;
	readonly scope?: readonly string[];
	readonly phase: RulePhase;
	readonly consequence: RuleConsequence;
	readonly owner: RuleOwner;
	readonly enabled: boolean;
	readonly deterministic_check?: {
		readonly type?: string;
		readonly pattern?: string;
		readonly file_glob?: string;
	};
	readonly check?: (input: MutationRuleInput) => Promise<RuleViolation | undefined> | RuleViolation | undefined;
}

export interface RuleViolation {
	readonly ruleId: string;
	readonly phase: RulePhase;
	readonly consequence: RuleConsequence;
	readonly explanation: string;
	readonly targetFile?: string;
	readonly line?: number;
	readonly suggestedFix?: string;
}

export interface RuleRepairWork extends RepairWork {
	readonly target_objective_id?: string;
	readonly target_task_id?: string;
	readonly kind?: string;
	readonly instructions?: string;
	readonly blocking?: boolean;
	readonly required_verifications?: readonly string[];
	readonly suggested_expert?: {
		readonly role: string;
		readonly routing_band: string;
	};
}

export interface RuleValidationResult {
	readonly passed: boolean;
	readonly violations: readonly RuleViolation[];
	readonly checkedRules: number;
	readonly repairWork?: RuleRepairWork;
	readonly summaryEvent?: string;
}

export interface MutationRuleInput {
	readonly objectiveId?: string;
	readonly taskId?: string;
	readonly changedFiles: readonly string[];
	readonly diffContent?: string;
	readonly boundedDiffEvidence?: string | Record<string, unknown>;
	readonly fileContents?: Record<string, string>;
	readonly signal?: AbortSignal;
}

export interface TaskPostflightRuleInput {
	readonly objectiveId: string;
	readonly taskId: string;
	readonly changedFiles: readonly string[];
	readonly artifacts?: readonly unknown[];
	readonly signal?: AbortSignal;
}

export interface CompletionRuleInput {
	readonly objectiveId: string;
	readonly changedFiles: readonly string[];
	readonly evidence?: readonly unknown[];
	readonly signal?: AbortSignal;
}
