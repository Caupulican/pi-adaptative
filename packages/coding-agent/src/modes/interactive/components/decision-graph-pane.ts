/**
 * The Decision graph pane: the System One decider's live dashboard beside the chat. It owns only
 * what a viewport owns — scroll position and the stage the operator expanded — and composes its
 * rows per frame from the model the workbench hands it. The view (List | Diagram) is workbench
 * geometry, persisted with the other operator choices.
 */

import type { DecisionStage } from "../../../core/operator-projection/decision-stage-log.ts";
import type { DecisionGraphModel } from "./decision-graph-model.ts";
import { renderDecisionDiagram, renderDecisionList } from "./decision-graph-render.ts";
import type { WorkbenchGraphView } from "./workbench.ts";
import { WorkbenchPane, type WorkbenchPaneTitleButton } from "./workbench-pane.ts";

export const GRAPH_PANE_TITLE = "Decision graph";

export class DecisionGraphPane extends WorkbenchPane {
	private selectedStage?: DecisionStage;
	private stageAt: readonly (DecisionStage | undefined)[] = [];

	/** The stage whose detail is open in the List view. */
	getSelectedStage(): DecisionStage | undefined {
		return this.selectedStage;
	}

	/** A click on a stage row opens its detail; a second click on the same stage closes it. */
	toggleStage(stage: DecisionStage): void {
		this.selectedStage = this.selectedStage === stage ? undefined : stage;
	}

	/** The stage drawn on the content row under a pointer, or undefined off any stage row. */
	stageAtPoint(column: number, row: number): DecisionStage | undefined {
		const index = this.rowAt(column, row);
		return index === undefined ? undefined : this.stageAt[index];
	}

	/** One title row plus `height - 1` content rows, `width` cells each; the current stage stays in view. */
	draw(
		model: DecisionGraphModel,
		view: WorkbenchGraphView,
		x: number,
		y: number,
		width: number,
		height: number,
		actions: readonly WorkbenchPaneTitleButton[],
	): string[] {
		const inner = Math.max(1, width - 2);
		const composed =
			view === "list" ? renderDecisionList(model, inner, this.selectedStage) : renderDecisionDiagram(model, inner);
		this.stageAt = composed.stageAt;
		const meta = model.current
			? `${model.current.stage}${model.loop > 1 ? ` · loop ${model.loop}` : ""}`
			: model.goal.branch === "delivered"
				? "delivered"
				: "idle";
		return this.render(
			GRAPH_PANE_TITLE,
			meta,
			[...composed.rows],
			x,
			y,
			width,
			height,
			{ row: composed.currentRow, key: composed.focusKey },
			actions,
		);
	}
}
