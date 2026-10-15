/**
 * The Decision graph pane: the System One decider's live dashboard beside the chat. It owns only
 * what a viewport owns — scroll position and the stage the operator expanded — and composes its
 * rows per frame from the model the workbench hands it. The view (List | Diagram | Lanes) is workbench
 * geometry, persisted with the other operator choices.
 */

import type { DecisionStage } from "../../../core/operator-projection/decision-stage-log.ts";
import type { WorkbenchGraphView } from "../../../core/settings/settings-schema.ts";
import { renderDecisionList } from "./decision-graph-list.ts";
import type { DecisionGraphModel } from "./decision-graph-model.ts";
import { STAGE_LABEL } from "./decision-graph-render.ts";
import { renderDecisionScene } from "./decision-graph-scene.ts";
import { renderFlowLanes } from "./flow-lanes-render.ts";
import { SPRING_SNAPPY, SpringTable } from "./graph/spring.ts";
import { WorkbenchPane, type WorkbenchPaneTitleButton } from "./workbench-pane.ts";

export const GRAPH_PANE_TITLE = "Decision graph";

/** The title's meta: the current stage by its label and, after a repair, the loop it is in (`build · loop 2`). */
export function graphTitleMeta(model: DecisionGraphModel): string {
	// Idle is the resting state and says nothing; only a finished goal or a running stage is worth a word.
	if (!model.current) return model.goal.branch === "delivered" ? "delivered" : "";
	const stage = STAGE_LABEL[model.current.stage];
	return model.loop > 1 ? `${stage} · loop ${model.loop}` : stage;
}

/** A draw this long after the previous one means the pane was hidden in between; its springs start over. */
const STALE_DRAW_GAP_MS = 2000;

export class DecisionGraphPane extends WorkbenchPane {
	private selectedStage?: DecisionStage;
	private stageAt: readonly (DecisionStage | undefined)[] = [];
	private stageAtCell?: (column: number, row: number) => DecisionStage | undefined;
	private seenObjective?: string;
	/** All of the diagram's motion state: the focus bar's springs. Cleared when the objective changes or the pane was away. */
	private readonly springs = new SpringTable(SPRING_SNAPPY);
	/** The model clock at the last draw; the workbench hides the pane without drawing, so a long gap means it was away. */
	private lastDrawnAt?: number;
	/** The moment the last frame's motion is no longer needed; undefined when nothing moved. */
	private motion?: number;

	/**
	 * When the last drawn frame needs motion until; always finite (a spring: a short lease each frame renews,
	 * a carrier: its start plus the flight time or its end plus the settle time). Undefined: nothing moves.
	 */
	get motionUntil(): number | undefined {
		return this.motion;
	}

	/** A frame that is not drawn (graph hidden or folded) needs no motion. */
	override hide(): void {
		this.motion = undefined;
		super.hide();
	}

	/**
	 * A new objective starts over: no selection, no springs. So does a draw after the pane was away, so the
	 * focus bar never slides in from where it was before the pane was hidden.
	 */
	private trackStage(model: DecisionGraphModel): void {
		const away = this.lastDrawnAt !== undefined && model.nowMs - this.lastDrawnAt > STALE_DRAW_GAP_MS;
		this.lastDrawnAt = model.nowMs;
		if (model.objectiveId !== this.seenObjective) {
			this.seenObjective = model.objectiveId;
			this.selectedStage = undefined;
			this.springs.clear();
			return;
		}
		if (away) this.springs.clear();
	}

	/** The stage whose detail is open in the List view. */
	getSelectedStage(): DecisionStage | undefined {
		return this.selectedStage;
	}

	/** A click on a stage row opens its detail; a second click on the same stage closes it. */
	toggleStage(stage: DecisionStage): void {
		this.selectedStage = this.selectedStage === stage ? undefined : stage;
	}

	/** The stage under a pointer: the exact node for the diagram, the row's stage for the row-granular views. */
	stageAtPoint(column: number, row: number): DecisionStage | undefined {
		const index = this.rowAt(column, row);
		if (index === undefined) return undefined;
		return this.stageAtCell ? this.stageAtCell(this.contentColumn(column), index) : this.stageAt[index];
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
		motion = true,
		interactive = true,
	): string[] {
		const inner = Math.max(1, width - 2);
		this.trackStage(model);
		// A stage that is no longer among the model's stages (evicted, or from another objective) shows no detail.
		if (this.selectedStage !== undefined && !model.stages.some((row) => row.stage === this.selectedStage)) {
			this.selectedStage = undefined;
		}
		const composed =
			view === "list"
				? renderDecisionList(model, inner, this.selectedStage)
				: view === "lanes"
					? renderFlowLanes(model.flow, inner, model.nowMs, motion)
					: renderDecisionScene(model, inner, this.springs, { motion });
		this.stageAt = composed.stageAt;
		this.stageAtCell = composed.stageAtCell;
		this.motion = composed.motionUntil;
		return this.render(
			GRAPH_PANE_TITLE,
			graphTitleMeta(model),
			[...composed.rows],
			x,
			y,
			width,
			height,
			{ row: composed.currentRow, key: composed.focusKey },
			actions,
			interactive,
			composed.pinnedRows,
		);
	}
}
