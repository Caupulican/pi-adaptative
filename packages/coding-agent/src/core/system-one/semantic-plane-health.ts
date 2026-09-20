/**
 * Observed health of the session's semantic plane.
 *
 * Health is what actually happened to the last evaluation, not a constant. A session with no plane
 * reports `unbound`; a bound plane that has never been asked reports `unknown`; a plane with an
 * evaluation in flight reports `evaluating`; a plane whose last evaluation threw reports `degraded`.
 * Nothing here renders a state the runtime did not earn.
 */

export type SemanticPlaneHealthState = "unbound" | "unknown" | "evaluating" | "ok" | "degraded";

export interface SemanticPlaneHealth {
	readonly state: SemanticPlaneHealthState;
	readonly lastOutcomeAt?: string;
	readonly lastFailure?: string;
	/** Evaluations currently in flight; only meaningful while `state` is `evaluating`. */
	readonly inFlight?: number;
}

/** Records the outcome of every semantic evaluation the session runs. */
export class SemanticPlaneHealthRecorder {
	private lastOutcomeAt?: string;
	private lastFailure?: string;
	private observed = false;
	private inFlight = 0;

	/** A real evaluation started; the plane is `evaluating` until its matching end. */
	recordStart(): void {
		this.inFlight += 1;
	}

	recordSuccess(): void {
		this.inFlight = Math.max(0, this.inFlight - 1);
		this.observed = true;
		this.lastOutcomeAt = new Date().toISOString();
		this.lastFailure = undefined;
	}

	/**
	 * The evaluation was cancelled — the operator aborted the turn, or its caller went away. The
	 * plane did not fail: nothing was observed, so the last real outcome stands and the state
	 * returns to whatever it was before the evaluation started.
	 */
	recordCancelled(): void {
		this.inFlight = Math.max(0, this.inFlight - 1);
	}

	recordFailure(error: unknown): void {
		this.inFlight = Math.max(0, this.inFlight - 1);
		this.observed = true;
		this.lastOutcomeAt = new Date().toISOString();
		this.lastFailure = error instanceof Error ? error.message : String(error);
	}

	/** `bound` is whether a semantic plane exists at all for this session. */
	getHealth(bound: boolean): SemanticPlaneHealth {
		if (!bound) return { state: "unbound" };
		if (this.inFlight > 0) {
			return {
				state: "evaluating",
				inFlight: this.inFlight,
				...(this.lastOutcomeAt ? { lastOutcomeAt: this.lastOutcomeAt } : {}),
				...(this.lastFailure ? { lastFailure: this.lastFailure } : {}),
			};
		}
		if (!this.observed) return { state: "unknown" };
		return {
			state: this.lastFailure ? "degraded" : "ok",
			...(this.lastOutcomeAt ? { lastOutcomeAt: this.lastOutcomeAt } : {}),
			...(this.lastFailure ? { lastFailure: this.lastFailure } : {}),
		};
	}
}

/**
 * The operator label for a health state, as the normal-mode POV bar shows it. Every state has a
 * word an operator can act on; there is deliberately no "?" state.
 */
export function semanticPlaneHealthLabel(health: SemanticPlaneHealth): string {
	switch (health.state) {
		case "ok":
			return "JEV ok";
		case "degraded":
			return "JEV degraded";
		case "evaluating":
			return "JEV eval";
		case "unknown":
			return "JEV ready";
		default:
			return "JEV off";
	}
}
