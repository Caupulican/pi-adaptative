/**
 * Decision Engine Protocol Error.
 * Thrown when semantic engine output violates protocol schema, ranges, or invariants.
 * Conforms to TYPESAFE_PROTOCOL.md and DECISION_ENGINE_RULES.md.
 */

import type { SystemOneReceipt } from "../review/system-one-review-port.ts";

export class DecisionEngineProtocolError extends Error {
	readonly details?: Record<string, unknown>;
	/** Persistence outcome of each paid provider response behind the rejected output (retries included). */
	readonly receipts?: readonly SystemOneReceipt[];

	constructor(message: string, details?: Record<string, unknown>, receipts?: readonly SystemOneReceipt[]) {
		super(message);
		this.name = "DecisionEngineProtocolError";
		this.details = details;
		this.receipts = receipts;
	}
}
