/**
 * Observed health of the session's semantic plane.
 *
 * Health is what actually happened to the last evaluation, not a constant. A session with no plane
 * reports `unbound`; a bound plane that has never been asked reports `unknown`; a plane whose last
 * evaluation threw reports `degraded`. Nothing here renders a tick the runtime did not earn.
 */

export type SemanticPlaneHealthState = "unbound" | "unknown" | "ok" | "degraded";

export interface SemanticPlaneHealth {
	readonly state: SemanticPlaneHealthState;
	readonly lastOutcomeAt?: string;
	readonly lastFailure?: string;
}

/** Records the outcome of every semantic evaluation the session runs. */
export class SemanticPlaneHealthRecorder {
	private lastOutcomeAt?: string;
	private lastFailure?: string;
	private observed = false;

	recordSuccess(): void {
		this.observed = true;
		this.lastOutcomeAt = new Date().toISOString();
		this.lastFailure = undefined;
	}

	recordFailure(error: unknown): void {
		this.observed = true;
		this.lastOutcomeAt = new Date().toISOString();
		this.lastFailure = error instanceof Error ? error.message : String(error);
	}

	/** `bound` is whether a semantic plane exists at all for this session. */
	getHealth(bound: boolean): SemanticPlaneHealth {
		if (!bound) return { state: "unbound" };
		if (!this.observed) return { state: "unknown" };
		return {
			state: this.lastFailure ? "degraded" : "ok",
			...(this.lastOutcomeAt ? { lastOutcomeAt: this.lastOutcomeAt } : {}),
			...(this.lastFailure ? { lastFailure: this.lastFailure } : {}),
		};
	}
}

/** The one-glyph operator indicator for a health state. */
export function semanticPlaneHealthGlyph(health: SemanticPlaneHealth): string {
	switch (health.state) {
		case "ok":
			return "Jev ✓";
		case "degraded":
			return "Jev !";
		case "unknown":
			return "Jev ?";
		default:
			return "Jev –";
	}
}
