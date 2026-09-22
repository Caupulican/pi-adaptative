import type { NoulDirection } from "./noul.ts";

export type Consequence = "low" | "medium" | "high" | "critical";

export interface BooleanDecision {
	readonly kind: "boolean";
	readonly id: string;
	readonly instruction: string;
	readonly criteria?: {
		readonly true?: string;
		readonly false?: string;
	};
	/**
	 * Which end of the probability the asker needs. `required_true` (the default) passes on a high
	 * P(true); `required_false` passes on a low one. The band is read against this, so a question
	 * that is really "no risk is present" must say so here or its confident no reads as a fail.
	 */
	readonly direction?: NoulDirection;
	readonly consequence?: Consequence;
}

export interface ChoiceOption {
	readonly description: string;
	readonly notFor?: string;
}

export interface ChoiceDecision {
	readonly kind: "choice";
	readonly id: string;
	readonly instruction: string;
	readonly options: Record<string, ChoiceOption>;
	readonly consequence?: Consequence;
	readonly allowUnlistedChoice?: boolean;
}

export interface ScoreLevel {
	readonly value: number;
	readonly description: string;
}

export interface ScoreDecision {
	readonly kind: "score";
	readonly id: string;
	readonly instruction: string;
	readonly levels: readonly ScoreLevel[];
	readonly consequence?: Consequence;
}

export interface SetDecision {
	readonly kind: "set";
	readonly id: string;
	readonly instructionTemplate: string;
	readonly members: Record<string, string>;
	readonly consequence?: Consequence;
	readonly threshold?: number;
}

export type DecisionDefinition = BooleanDecision | ChoiceDecision | ScoreDecision | SetDecision;
