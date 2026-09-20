/**
 * The Jev evaluation ledger's vocabulary: what one semantic evaluation is (kind, label, timing,
 * outcome, verdict, bounded reasons), the one observer every evaluation path reports to, and the
 * pure functions that turn a raw evaluation or a steering certificate into a verdict the operator
 * can read. No path may record an evaluation any other way; that is how `JEV eval` under-reported.
 */

import type { DecisionEvaluation } from "../decision/evaluation.ts";
import type { Consequence } from "../decision/primitives.ts";
import { findPackForCheckpoint } from "../steering/programs.ts";
import type { SteeringCertificate } from "../steering/types.ts";
import type { ValidationStage } from "./types.ts";

export type SemanticEvaluationOutcome = "ok" | "failed" | "cancelled";

/** One evaluation the plane is running right now. */
export interface SemanticEvaluationStart {
	readonly evaluationId: string;
	readonly programId: string;
	/** Operator-readable name for the judgment; see {@link semanticEvaluationLabel}. */
	readonly label: string;
	readonly consequence?: Consequence;
	/** Epoch ms. */
	readonly startedAt: number;
}

/** One finished evaluation. */
export interface SemanticEvaluationRecord extends SemanticEvaluationStart {
	readonly endedAt: number;
	readonly durationMs: number;
	readonly outcome: SemanticEvaluationOutcome;
	/** The judgment itself: a semantic outcome, a policy result, or a chosen route. */
	readonly verdict?: string;
	/** Bounded reason lines, as the pane's preview body. */
	readonly reasons?: readonly string[];
}

/** The one sink every semantic evaluation in the session reports to. */
export interface SemanticEvaluationObserver {
	/** `model` is the engine or pinned model the evaluation runs on, kept for the durable ledger. */
	start(input: { programId: string; consequence?: Consequence; model?: string }): string;
	settleOk(evaluationId: string, verdict?: string, reasons?: readonly string[]): void;
	settleFailed(evaluationId: string, error: unknown): void;
	settleCancelled(evaluationId: string): void;
	/** Sets the verdict on an already-settled record (System One's policy result arrives later). */
	noteVerdict(evaluationId: string, verdict: string, reasons?: readonly string[]): void;
}

const LABEL_LIMIT = 64;
export const MAX_EVALUATION_REASONS = 6;
const REASON_LIMIT = 120;

const HOST_PROGRAM_LABELS: readonly (readonly [RegExp, string])[] = [
	[/^rule_program_/, "project rules"],
	[/^retention_eval_/, "retention"],
	[/^supervision_eval_/, "worker supervision"],
	[/^objective-route-v2$/, "objective route"],
];

/** Checkpoints whose registered pack is the synthesized fallback but whose call site names them. */
const CHECKPOINT_LABEL_OVERRIDES: Readonly<Record<string, string>> = {
	"JEV-WORKER-SUPERVISION": "worker supervision",
};

const SYSTEM_ONE_STAGES: ReadonlySet<string> = new Set<ValidationStage>([
	"intake",
	"preflight",
	"tool_gate",
	"postflight",
	"evidence_check",
	"drift_check",
	"drift_loop",
	"duplicate_logic",
	"patch_review",
	"completion",
	"completion_challenge",
]);

const STEERING_PROGRAM_PREFIX = "pi:steering:program:";
const STEERING_PACK_PREFIX = "pi:steering:pack:";

function bounded(value: string, limit: number): string {
	const collapsed = value.replace(/\s+/g, " ").trim();
	return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}

function labelForCheckpoint(checkpointId: string): string {
	const override = CHECKPOINT_LABEL_OVERRIDES[checkpointId];
	if (override) return override;
	const pack = findPackForCheckpoint(checkpointId);
	if (pack?.id.startsWith(STEERING_PACK_PREFIX)) {
		const name = pack.id.slice(STEERING_PACK_PREFIX.length).split(":")[0] ?? "";
		// A checkpoint without a registered pack gets a synthesized pack named after itself; the
		// label then degrades to the id rather than to a guess.
		if (name && name !== checkpointId) return name.replaceAll("_", " ");
	}
	return checkpointId;
}

/**
 * Operator-readable name for a program id. Every branch reads something the source declares:
 * System One stage names, steering pack names, the host program families; the fallback is the raw id.
 */
export function semanticEvaluationLabel(programId: string): string {
	if (programId.startsWith("system-one:")) {
		const stage = programId.slice("system-one:".length);
		if (SYSTEM_ONE_STAGES.has(stage)) return stage.replaceAll("_", " ");
	}
	if (programId.startsWith(STEERING_PROGRAM_PREFIX)) {
		const checkpoint = programId.slice(STEERING_PROGRAM_PREFIX.length).split(":")[0] ?? "";
		if (checkpoint) return bounded(labelForCheckpoint(checkpoint), LABEL_LIMIT);
	}
	if (/^JEV-[A-Z0-9-]+$/.test(programId)) return bounded(labelForCheckpoint(programId), LABEL_LIMIT);
	for (const [pattern, label] of HOST_PROGRAM_LABELS) if (pattern.test(programId)) return label;
	return bounded(programId, LABEL_LIMIT);
}

/** What a raw evaluation decided, without inventing a judgment it did not make. */
export function verdictFromEvaluation(evaluation: DecisionEvaluation): {
	verdict?: string;
	reasons: readonly string[];
} {
	const reasons: string[] = [];
	let verdict: string | undefined = evaluation.proposedFunctionCall?.name;
	for (const [id, result] of Object.entries(evaluation.results)) {
		if (reasons.length >= MAX_EVALUATION_REASONS) break;
		switch (result.kind) {
			case "boolean":
				reasons.push(bounded(`${id}: ${result.value} (p=${result.probabilityTrue.toFixed(2)})`, REASON_LIMIT));
				break;
			case "choice":
				if (verdict === undefined) verdict = result.selected;
				reasons.push(bounded(`${id}: ${result.selected}`, REASON_LIMIT));
				break;
			case "score":
				reasons.push(bounded(`${id}: ${result.value}`, REASON_LIMIT));
				break;
			case "set":
				reasons.push(bounded(`${id}: ${result.selected.join(", ")}`, REASON_LIMIT));
				break;
			case "function_call":
				reasons.push(bounded(`${id}: ${result.name}`, REASON_LIMIT));
				break;
			default:
				reasons.push(bounded(`${id}: unsupported (${result.reason})`, REASON_LIMIT));
		}
	}
	return { ...(verdict !== undefined ? { verdict } : {}), reasons };
}

/** What a steering certificate decided. */
export function verdictFromCertificate(certificate: SteeringCertificate): {
	verdict: string;
	reasons: readonly string[];
} {
	const verdict = certificate.semantic_outcome ?? certificate.policy_result ?? certificate.directive;
	const reasons: string[] = [];
	if (certificate.semantic_outcome !== "pass")
		reasons.push(bounded(`directive: ${certificate.directive}`, REASON_LIMIT));
	for (const predicate of certificate.failed_semantic_predicates ?? []) {
		if (reasons.length >= MAX_EVALUATION_REASONS) break;
		reasons.push(bounded(predicate, REASON_LIMIT));
	}
	return { verdict, reasons };
}
