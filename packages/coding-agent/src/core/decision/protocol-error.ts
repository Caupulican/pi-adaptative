/**
 * Decision Engine Protocol Error.
 * Thrown when semantic engine output violates protocol schema, ranges, or invariants.
 * Conforms to TYPESAFE_PROTOCOL.md and DECISION_ENGINE_RULES.md.
 */

import { SemanticResponseError, type SystemOneReceipt } from "../review/system-one-review-port.ts";

export class DecisionEngineProtocolError extends SemanticResponseError {
	readonly details?: Record<string, unknown>;

	constructor(message: string, details?: Record<string, unknown>, receipts?: readonly SystemOneReceipt[]) {
		super(message, receipts ?? []);
		this.name = "DecisionEngineProtocolError";
		this.details = details;
	}
}
