/**
 * Decision Engine Protocol Error.
 * Thrown when semantic engine output violates protocol schema, ranges, or invariants.
 * Conforms to TYPESAFE_PROTOCOL.md and DECISION_ENGINE_RULES.md.
 */

export class DecisionEngineProtocolError extends Error {
	readonly details?: Record<string, unknown>;

	constructor(message: string, details?: Record<string, unknown>) {
		super(message);
		this.name = "DecisionEngineProtocolError";
		this.details = details;
	}
}
