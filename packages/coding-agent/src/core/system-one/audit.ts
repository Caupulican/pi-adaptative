import type { ToolEvent, ValidationDecision } from "./types.ts";

export interface DecisionAuditRecord extends ValidationDecision {
	run_id: string;
	latency_ms?: number;
}

export interface ToolAuditRecord extends ToolEvent {
	run_id: string;
}

/**
 * AuditStore: in-memory / append-only audit trail for System One decisions and tool events.
 * R-040: Every Jev decision MUST persist stage, model, question catalog version, question hash, state hash, raw typed answers, and policy result.
 * R-041: Every tool action MUST persist intent, impact class, status, input hash, output hash, and produced observation refs.
 */
/** The in-memory audit keeps this many of each record; the durable ledgers hold the full history. */
export const MAX_AUDIT_RECORDS = 256;

export class AuditStore {
	private readonly decisions: DecisionAuditRecord[] = [];
	private readonly toolActions: ToolAuditRecord[] = [];

	recordDecision(runId: string, decision: ValidationDecision): void {
		this.decisions.push({
			...decision,
			run_id: runId,
		});
		while (this.decisions.length > MAX_AUDIT_RECORDS) this.decisions.shift();
	}

	recordToolAction(runId: string, toolEvent: ToolEvent): void {
		this.toolActions.push({
			...toolEvent,
			run_id: runId,
		});
		while (this.toolActions.length > MAX_AUDIT_RECORDS) this.toolActions.shift();
	}

	getDecisionsForRun(runId: string): readonly DecisionAuditRecord[] {
		return this.decisions.filter((d) => d.run_id === runId);
	}

	getToolActionsForRun(runId: string): readonly ToolAuditRecord[] {
		return this.toolActions.filter((t) => t.run_id === runId);
	}

	/**
	 * Reconstruct why a stage gate produced its outcome (Section 25).
	 */
	explainDecision(decisionId: string):
		| {
				decision: DecisionAuditRecord;
				explanation: string;
		  }
		| undefined {
		const decision = this.decisions.find((d) => d.id === decisionId);
		if (!decision) return undefined;

		const explanation = [
			`Stage: ${decision.stage}`,
			`Model: ${decision.model}`,
			`Question Catalog Version: ${decision.question_catalog_version}`,
			`Questions Hash: ${decision.questions_hash}`,
			`State Hash: ${decision.state_hash}`,
			`Policy Result: ${decision.policy_result}`,
			`Answers: ${JSON.stringify(decision.answers, null, 2)}`,
		].join("\n");

		return { decision, explanation };
	}
}
