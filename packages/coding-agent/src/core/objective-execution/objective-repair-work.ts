/**
 * Objective Repair Work Generation and Validation.
 * Conforms to schemas/repair-work.schema.json.
 */

import { randomUUID } from "node:crypto";

export const REPAIR_WORK_SCHEMA_VERSION = "1.0" as const;

export interface FailedGateRecord {
	readonly gate_id?: string;
	readonly id?: string;
	readonly reason?: string;
	readonly required_next_proof?: string;
}

export type RepairWorkClass =
	| "retrieve"
	| "investigate"
	| "implement"
	| "deterministic_test"
	| "verify"
	| "review"
	| "replan";

export interface RepairWork {
	readonly schema_version: typeof REPAIR_WORK_SCHEMA_VERSION;
	readonly repair_id: string;
	readonly objective_id: string;
	readonly failed_gate_id: string;
	readonly reason: string;
	readonly required_next_proof: string;
	readonly recommended_work_class: RepairWorkClass;
	readonly acceptance_criterion_ids?: readonly string[];
	readonly prior_failed_strategy_fingerprints?: readonly string[];
	readonly independent_worker_required?: boolean;
}

export class RepairWorkValidationError extends Error {
	constructor(message: string) {
		super(`RepairWorkValidationError: ${message}`);
		this.name = "RepairWorkValidationError";
	}
}

/**
 * Validates a RepairWork object against schemas/repair-work.schema.json.
 */
export function validateRepairWork(value: unknown): asserts value is RepairWork {
	if (!value || typeof value !== "object") {
		throw new RepairWorkValidationError("RepairWork must be a non-null object.");
	}

	const work = value as Record<string, unknown>;

	if (work.schema_version !== REPAIR_WORK_SCHEMA_VERSION) {
		throw new RepairWorkValidationError(
			`Invalid schema_version '${String(work.schema_version)}', expected '${REPAIR_WORK_SCHEMA_VERSION}'.`,
		);
	}

	if (typeof work.repair_id !== "string" || !work.repair_id.trim()) {
		throw new RepairWorkValidationError("repair_id must be a non-empty string.");
	}

	if (typeof work.objective_id !== "string" || !work.objective_id.trim()) {
		throw new RepairWorkValidationError("objective_id must be a non-empty string.");
	}

	if (typeof work.failed_gate_id !== "string" || !work.failed_gate_id.trim()) {
		throw new RepairWorkValidationError("failed_gate_id must be a non-empty string.");
	}

	if (typeof work.reason !== "string" || !work.reason.trim()) {
		throw new RepairWorkValidationError("reason must be a non-empty string.");
	}

	if (typeof work.required_next_proof !== "string" || !work.required_next_proof.trim()) {
		throw new RepairWorkValidationError("required_next_proof must be a non-empty string.");
	}

	const validClasses: ReadonlySet<RepairWorkClass> = new Set([
		"retrieve",
		"investigate",
		"implement",
		"deterministic_test",
		"verify",
		"review",
		"replan",
	]);
	if (
		typeof work.recommended_work_class !== "string" ||
		!validClasses.has(work.recommended_work_class as RepairWorkClass)
	) {
		throw new RepairWorkValidationError(`Invalid recommended_work_class '${String(work.recommended_work_class)}'.`);
	}
}

/**
 * Converts failed completion transaction gates into structured repair work items.
 * Generic try-again prompts are forbidden (Rule 43); concrete proof requirements are derived from failed gate IDs.
 */
export function completionFailuresToRepairWork(
	failedGates: readonly FailedGateRecord[],
	objectiveId: string,
	options?: {
		priorStrategyFingerprint?: string;
		acceptanceCriterionIds?: readonly string[];
	},
): readonly RepairWork[] {
	if (!failedGates || failedGates.length === 0) {
		return [];
	}

	return failedGates.map((gate) => {
		const gateId = gate.gate_id ?? gate.id ?? "unknown_gate";
		const reason = gate.reason || "Completion gate validation failed.";
		let recommendedClass: RepairWorkClass = "implement";
		let requiredNextProof =
			gate.required_next_proof || "Address gate failure and provide passing verification evidence.";
		let independentWorkerRequired = false;

		switch (gateId) {
			case "unresolved_verification_obligations":
				recommendedClass = "deterministic_test";
				requiredNextProof = "Run and provide passing test exit status for all pending verification obligations.";
				break;
			case "hypotheses_untested":
				recommendedClass = "investigate";
				requiredNextProof = "Investigate and provide empirical evidence resolving open hypotheses.";
				break;
			case "review_challenge_gate":
			case "external_completion_gate":
				recommendedClass = "verify";
				requiredNextProof = "Independent verification must confirm all acceptance criteria without bias.";
				independentWorkerRequired = true;
				break;
			case "stale_evidence":
				recommendedClass = "retrieve";
				requiredNextProof = "Fresh tool receipts and repository status after recent mutations.";
				break;
			case "semantic_validation_rejected":
				recommendedClass = "replan";
				requiredNextProof = "Revise approach to address semantic rejection criteria.";
				independentWorkerRequired = true;
				break;
			default:
				recommendedClass = "implement";
				requiredNextProof = `Provide concrete proof resolving failure in ${gateId}: ${reason}`;
				break;
		}

		const repair: RepairWork = {
			schema_version: REPAIR_WORK_SCHEMA_VERSION,
			repair_id: `repair_${randomUUID().slice(0, 8)}`,
			objective_id: objectiveId,
			failed_gate_id: gateId,
			reason,
			required_next_proof: requiredNextProof,
			recommended_work_class: recommendedClass,
			...(options?.acceptanceCriterionIds ? { acceptance_criterion_ids: options.acceptanceCriterionIds } : {}),
			...(options?.priorStrategyFingerprint
				? { prior_failed_strategy_fingerprints: [options.priorStrategyFingerprint] }
				: {}),
			...(independentWorkerRequired ? { independent_worker_required: true } : {}),
		};

		validateRepairWork(repair);
		return repair;
	});
}
