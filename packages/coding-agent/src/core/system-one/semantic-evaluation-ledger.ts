/**
 * The Jev evaluation ledger's vocabulary: what one semantic evaluation is (kind, label, timing,
 * outcome, verdict, bounded reasons), the one observer every evaluation path reports to, and the
 * pure functions that turn a raw evaluation or a steering certificate into a verdict the operator
 * can read. No path may record an evaluation any other way; that is how `S1 eval` under-reported.
 */

import type { SemanticEvaluationScope } from "../decision/engine.ts";
import type { DecisionEvaluation } from "../decision/evaluation.ts";
import type { NoulBand } from "../decision/noul.ts";
import type { Consequence } from "../decision/primitives.ts";
import { findPackForCheckpoint } from "../steering/programs.ts";
import type { SteeringCertificate } from "../steering/types.ts";
import { isAdverseAnswer } from "./policy.ts";
import type { ValidationStage } from "./types.ts";

export type SemanticEvaluationOutcome = "ok" | "failed" | "cancelled";

export type { SemanticEvaluationScope } from "../decision/engine.ts";

/** Collision-free worker question identity for one objective and logical task across retries. */
export function semanticWorkerTaskScope(objectiveId: string, taskId: string): SemanticEvaluationScope {
	return { kind: "worker-task", id: JSON.stringify([objectiveId, taskId]) };
}

/** One evaluation the plane is running right now. */
export interface SemanticEvaluationStart {
	readonly evaluationId: string;
	readonly programId: string;
	/** Operator-readable name for the judgment; see {@link semanticEvaluationLabel}. */
	readonly label: string;
	readonly consequence?: Consequence;
	readonly evaluationScope?: SemanticEvaluationScope;
	/** Stable family for matching repeated invocations whose program ids include run timestamps. */
	readonly questionNamespace?: string;
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
	/** Full question identities and states; absent only on legacy/reasons-only records. */
	readonly questionStates?: readonly SemanticQuestionState[];
}

/** Unbounded question text and its semantic state, separate from the bounded display preview. */
export interface SemanticQuestionState {
	/** Exact identity (result key or certificate predicate), never display-truncated. */
	readonly question: string;
	readonly uncertain: boolean;
	/** Optional bounded explanation for display; the identity above remains complete. */
	readonly text?: string;
}

/** The one sink every semantic evaluation in the session reports to. */
export interface SemanticEvaluationObserver {
	/** `model` is the engine or pinned model the evaluation runs on, kept for the durable ledger. */
	start(input: {
		programId: string;
		consequence?: Consequence;
		model?: string;
		evaluationScope?: SemanticEvaluationScope;
	}): string;
	settleOk(
		evaluationId: string,
		verdict?: string,
		reasons?: readonly string[],
		questionStates?: readonly SemanticQuestionState[],
	): void;
	settleFailed(evaluationId: string, error: unknown): void;
	settleCancelled(evaluationId: string): void;
	/** Sets the verdict on an already-settled record (System One's policy result arrives later). */
	noteVerdict(
		evaluationId: string,
		verdict: string,
		reasons?: readonly string[],
		questionStates?: readonly SemanticQuestionState[],
	): void;
}

const LABEL_LIMIT = 64;
export const MAX_EVALUATION_REASONS = 6;
const REASON_LIMIT = 120;

const HOST_PROGRAM_FAMILIES: readonly { pattern: RegExp; label: string; namespace: string }[] = [
	{ pattern: /^rule_program_/, label: "project rules", namespace: "project-rules" },
	{ pattern: /^retention_eval_/, label: "retention", namespace: "retention" },
	{ pattern: /^supervision_eval_/, label: "worker supervision", namespace: "worker-supervision" },
	{ pattern: /^objective-route-v2$/, label: "objective route", namespace: "objective-route" },
	{ pattern: /^system-one:locate$/, label: "file locate", namespace: "file-locate" },
];

/** Checkpoints whose registered pack is the synthesized fallback but whose call site names them. */
const CHECKPOINT_LABEL_OVERRIDES: Readonly<Record<string, string>> = {
	"JEV-WORKER-SUPERVISION": "worker supervision",
};

/** Every System One stage in the operator's words. Exhaustive: a new stage cannot ship without its label. */
const SYSTEM_ONE_STAGE_LABELS: Readonly<Record<ValidationStage, string>> = {
	intake: "request",
	preflight: "preflight",
	tool_gate: "tool gate",
	postflight: "postflight",
	evidence_check: "evidence check",
	drift_check: "drift check",
	drift_loop: "drift loop",
	duplicate_logic: "duplicate logic",
	patch_review: "patch review",
	completion: "completion",
	completion_challenge: "completion challenge",
	claim_delivery: "answer claims",
	code_duplicate: "duplicate code",
	unsettled_item: "unsettled findings",
	route_choice: "model routing",
};

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
		if (stage in SYSTEM_ONE_STAGE_LABELS) return SYSTEM_ONE_STAGE_LABELS[stage as ValidationStage];
	}
	if (programId.startsWith(STEERING_PROGRAM_PREFIX)) {
		const checkpoint = programId.slice(STEERING_PROGRAM_PREFIX.length).split(":")[0] ?? "";
		if (checkpoint) return bounded(labelForCheckpoint(checkpoint), LABEL_LIMIT);
	}
	if (/^JEV-[A-Z0-9-]+$/.test(programId)) return bounded(labelForCheckpoint(programId), LABEL_LIMIT);
	for (const family of HOST_PROGRAM_FAMILIES) if (family.pattern.test(programId)) return family.label;
	return bounded(programId, LABEL_LIMIT);
}

/** Canonical identity for repeated semantic questions, independent of ephemeral invocation ids. */
export function semanticQuestionNamespace(programId: string): string {
	for (const family of HOST_PROGRAM_FAMILIES) if (family.pattern.test(programId)) return family.namespace;
	return programId;
}

/**
 * What an evaluation's result says to an operator: its outcome when it did not finish ok, else its
 * verdict. The routine `evaluated` verdict names nothing the label does not already say, so it has none.
 */
export function evaluationResultText(
	record: Pick<SemanticEvaluationRecord, "outcome" | "verdict">,
): string | undefined {
	if (record.outcome !== "ok") return record.outcome;
	return record.verdict && record.verdict !== "evaluated" ? record.verdict : undefined;
}

/**
 * A reason line for a judgment that settled nothing.
 *
 * Doubts travel as reason lines rather than as a parallel array: reasons are already bounded,
 * already durable and already drawn, so a doubt reaches the pane and the ledger by the same route
 * as every other reason. The prefix is the contract that makes one countable.
 */
export const DOUBT_REASON_PREFIX = "unsure: ";

export function doubtReason(text: string): string {
	return bounded(`${DOUBT_REASON_PREFIX}${text}`, REASON_LIMIT);
}

/** The open doubts in a set of reason lines, with the prefix stripped. */
export function doubtsFromReasons(reasons: readonly string[] | undefined): string[] {
	return (reasons ?? [])
		.filter((line) => line.startsWith(DOUBT_REASON_PREFIX))
		.map((line) => line.slice(DOUBT_REASON_PREFIX.length));
}

export const PROGRAM_SETTLED_REASON = "settled: every predicate passed";

/** How each band reads to an operator. `soft pass` and `unsure` are deliberately not "true". */
export const NOUL_BAND_LABEL: Readonly<Record<NoulBand, string>> = Object.freeze({
	hard_pass: "pass",
	soft_pass: "soft pass",
	ambiguous: "unsure",
	hard_fail: "fail",
});

/** What a raw evaluation decided, without inventing a judgment it did not make. */
export function verdictFromEvaluation(evaluation: DecisionEvaluation): {
	verdict?: string;
	reasons: readonly string[];
	questionStates: readonly SemanticQuestionState[];
} {
	const reasons: string[] = [];
	const questionStates: SemanticQuestionState[] = [];
	let verdict: string | undefined = evaluation.proposedFunctionCall?.name;
	for (const [id, result] of Object.entries(evaluation.results)) {
		const includeInPreview = reasons.length < MAX_EVALUATION_REASONS;
		let line: string;
		let uncertain = false;
		switch (result.kind) {
			case "boolean": {
				// The probability and the band are the answer. Printing the old derived boolean taught
				// the 0.5 cutoff to anyone reading the pane: `x: true (p=0.51)` is not a yes.
				line = `${id}: P(yes)=${result.probabilityTrue.toFixed(2)} · ${NOUL_BAND_LABEL[result.band]} (${
					result.direction === "required_false" ? "needs no" : "needs yes"
				})`;
				uncertain = result.band === "ambiguous";
				break;
			}
			case "choice":
				if (includeInPreview && verdict === undefined) verdict = result.selected;
				line = `${id}: ${result.selected}`;
				break;
			case "score":
				line = `${id}: ${result.value}`;
				break;
			case "set":
				line = `${id}: ${result.selected.join(", ")}`;
				break;
			case "function_call":
				line = `${id}: ${result.name}`;
				break;
			default:
				line = `${id}: unsupported (${result.reason})`;
		}
		if (result.kind !== "unsupported")
			questionStates.push({ question: id, uncertain, text: bounded(line, REASON_LIMIT) });
		if (includeInPreview) reasons.push(uncertain ? doubtReason(line) : bounded(line, REASON_LIMIT));
	}
	return { ...(verdict !== undefined ? { verdict } : {}), reasons, questionStates };
}

/** What a steering certificate decided. */
export function verdictFromCertificate(certificate: SteeringCertificate): {
	verdict: string;
	reasons: readonly string[];
	questionStates: readonly SemanticQuestionState[];
} {
	const verdict = certificate.semantic_outcome ?? certificate.policy_result ?? certificate.directive;
	const reasons: string[] = [];
	const questionStates: SemanticQuestionState[] = [];
	const failed = certificate.failed_semantic_predicates ?? [];
	const unsure = certificate.unsure_semantic_predicates ?? [];
	// A supervision judgment completes with a pass whatever it found: its answers are judgments, not protocol
	// failures. What it found is which questions came back decisively adverse, and that belongs on the row.
	const adverse =
		certificate.checkpoint_id === "JEV-WORKER-SUPERVISION"
			? Object.entries(certificate.answers ?? {}).flatMap(([id, answer]) => (isAdverseAnswer(answer) ? [id] : []))
			: [];
	const settled =
		certificate.semantic_outcome === "pass" && failed.length === 0 && unsure.length === 0 && adverse.length === 0;
	if (!settled && adverse.length === 0) reasons.push(bounded(`directive: ${certificate.directive}`, REASON_LIMIT));
	for (const id of adverse) {
		questionStates.push({ question: id, uncertain: false, text: bounded(`${id}: adverse`, REASON_LIMIT) });
		if (reasons.length < MAX_EVALUATION_REASONS) reasons.push(bounded(`adverse: ${id}`, REASON_LIMIT));
	}
	for (const predicate of failed) {
		questionStates.push({ question: predicate, uncertain: false, text: bounded(predicate, REASON_LIMIT) });
		if (reasons.length < MAX_EVALUATION_REASONS) reasons.push(bounded(predicate, REASON_LIMIT));
	}
	// A predicate that was only unsure is an open doubt, not a rejection: it is why the checkpoint
	// wants another look, and the pane has to be able to say so.
	for (const predicate of unsure) {
		if (failed.includes(predicate)) continue;
		questionStates.push({ question: predicate, uncertain: true, text: bounded(predicate, REASON_LIMIT) });
		if (reasons.length < MAX_EVALUATION_REASONS) reasons.push(doubtReason(predicate));
	}
	if (settled) reasons.push(PROGRAM_SETTLED_REASON);
	return { verdict, reasons, questionStates };
}
