import type { GateOutcome, GateOutcomeKind } from "./contracts.ts";

function isGateOutcomeKind(value: unknown): value is GateOutcomeKind {
	return (
		value === "allow" || value === "downgrade" || value === "escalate" || value === "ask-user" || value === "block"
	);
}

function getPrecedence(kind: unknown): number {
	if (kind === "allow") return 0;
	if (kind === "downgrade") return 1;
	if (kind === "escalate") return 2;
	if (kind === "ask-user") return 3;
	if (kind === "block") return 4;
	return 4; // Malformed/unknown outcome kind defaults to most restrictive (block)
}

export function combineGateOutcomes(outcomes: readonly GateOutcome[]): GateOutcome {
	if (outcomes.length === 0) {
		return {
			outcome: "ask-user",
			gate: "gate-combiner",
			reasonCode: "no_gate_outcomes",
			message: "No gate outcomes to combine",
		};
	}

	let winner = outcomes[0];
	let maxPrecedence = getPrecedence(winner.outcome);

	for (let i = 1; i < outcomes.length; i++) {
		const current = outcomes[i];
		const currentPrecedence = getPrecedence(current.outcome);
		if (currentPrecedence > maxPrecedence) {
			winner = current;
			maxPrecedence = currentPrecedence;
		}
	}

	if (!isGateOutcomeKind(winner.outcome)) {
		return {
			...winner,
			outcome: "block",
			message: winner.message || "Malformed outcome kind coerced to block",
		};
	}

	return winner;
}

export function fallbackGateOutcome(args: { gate: string; reversible: boolean; reasonCode: string }): GateOutcome {
	const gate = (args.gate || "").trim() || "unknown_gate";
	const reasonCode = (args.reasonCode || "").trim() || "unknown_reason";
	const outcome: GateOutcomeKind = args.reversible ? "ask-user" : "block";

	return {
		outcome,
		gate,
		reasonCode,
		message: `Fallback gate outcome: ${outcome} for gate ${gate} (${reasonCode})`,
	};
}
