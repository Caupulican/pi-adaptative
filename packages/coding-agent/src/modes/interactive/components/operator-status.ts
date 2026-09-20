import { type Component, truncateToWidth } from "@caupulican/pi-tui";
import type { OperatorProjectionController } from "../../../core/operator-projection/operator-projection-controller.ts";
import type { OperatorProjection } from "../../../core/operator-projection/types.ts";
import { theme } from "../theme/theme.ts";

export interface OperatorStatusOptions {
	projectionController?: OperatorProjectionController;
	getProjection?: () => OperatorProjection;
}

/**
 * OperatorStatusComponent:
 * Operator-first status presentation rendered directly under the title strip.
 * Answers Goal, Phase, Now, Why, Next, and Health without internal noise or chain-of-thought.
 * Implements FR-120..FR-123, FR-135, FR-136.
 */
export class OperatorStatusComponent implements Component {
	private readonly controller?: OperatorProjectionController;
	private readonly getProjectionFn?: () => OperatorProjection;

	constructor(options: OperatorStatusOptions) {
		this.controller = options.projectionController;
		this.getProjectionFn = options.getProjection;
	}

	getProjection(): OperatorProjection | undefined {
		if (this.controller) return this.controller.getProjection();
		if (this.getProjectionFn) return this.getProjectionFn();
		return undefined;
	}

	render(width: number): string[] {
		const projection = this.getProjection();
		if (!projection) return [];

		const { phase, phase_index, phase_count, current_action, why, next_action, active_actors, adaptation, proof } =
			projection;

		// Format phase badge
		let phaseBadge = phase.toUpperCase();
		if (phase === "blocked") {
			phaseBadge = theme.bold(theme.fg("error", "BLOCKED"));
		} else if (phase === "done") {
			phaseBadge = theme.bold(theme.fg("success", `DONE  ${phase_index}/${phase_count}`));
		} else if (phase === "adapt") {
			phaseBadge = theme.bold(theme.fg("warning", `ADAPT  ${phase_index}/${phase_count}`));
		} else {
			phaseBadge = theme.bold(theme.fg("accent", `${phase.toUpperCase()}  ${phase_index}/${phase_count}`));
		}

		const lines: string[] = [];

		// Row 1: Phase badge + bullet + Current Action
		const actionBullet = theme.fg(phase === "blocked" ? "error" : "accent", "●");
		const row1 = ` ${phaseBadge}  ${actionBullet} ${current_action}`;
		lines.push(truncateToWidth(row1, width, "…"));

		// Row 2: Actor or Adaptation, Why, or Next
		if (phase === "blocked") {
			// FR-135: Blocked state explains completed work + remaining block
			const completedDesc =
				proof.total > 0 ? `Completed: ${proof.satisfied}/${proof.total} criteria satisfied · ` : "";
			const row2 = ` ${theme.fg("muted", `${completedDesc}${why}`)}`;
			lines.push(truncateToWidth(row2, width, "…"));
		} else if (phase === "done") {
			// FR-136: Done state shows delivery refs and satisfied proof
			const proofDesc = `Delivered · proof ${proof.satisfied}/${proof.total} verified`;
			const nextDesc = next_action ? ` · ${next_action}` : "";
			const row2 = ` ${theme.fg("success", `${proofDesc}${nextDesc}`)}`;
			lines.push(truncateToWidth(row2, width, "…"));
		} else if (adaptation) {
			// Adaptation row: What the adaptation means
			const whyDesc = `Why: ${why}`;
			const nextDesc = next_action ? ` · Next: ${next_action}` : "";
			const row2 = ` ${theme.fg("muted", `${whyDesc}${nextDesc}`)}`;
			lines.push(truncateToWidth(row2, width, "…"));
		} else {
			// Regular in-progress row: Active actor and Next action
			const primaryActor = active_actors[0];
			const actorLabel = primaryActor ? primaryActor.label : "Root";
			const elapsedStr =
				primaryActor?.elapsedMs !== undefined ? ` · ${Math.floor(primaryActor.elapsedMs / 1000)}s` : "";
			const nextPart = next_action ? `        Next: ${next_action}` : "";
			const row2 = ` ${theme.fg("dim", `${actorLabel}${elapsedStr}`)}${theme.fg("muted", nextPart)}`;
			lines.push(truncateToWidth(row2, width, "…"));
		}

		return lines;
	}

	invalidate(): void {}
}
