import type { OperatorProjectionController } from "./operator-projection-controller.ts";
import type { OperatorEvent } from "./types.ts";

export interface OperatorEventControllerDeps {
	projectionController: OperatorProjectionController;
}

/**
 * OperatorEventController:
 * Bridges runtime events (compaction, supervision, rules, acquisition) into canonical OperatorEvents.
 * Enforces presentation rules: routine successes are silent; milestones and interventions are visible.
 * Implements FR-119, FR-129..FR-134.
 */
export class OperatorEventController {
	private readonly projectionController: OperatorProjectionController;

	constructor(deps: OperatorEventControllerDeps) {
		this.projectionController = deps.projectionController;
	}

	recordPlanMilestone(title: string, detail?: string): OperatorEvent {
		return this.projectionController.emitEvent({
			severity: "info",
			category: "plan",
			title,
			detail,
		});
	}

	recordSpecialistMilestone(specialty: string, action: "created" | "reused"): OperatorEvent {
		return this.projectionController.emitEvent({
			severity: "info",
			category: "worker",
			title: `Specialist ${action} · ${specialty}`,
		});
	}

	recordCapabilityMilestone(capabilityId: string, action: "synthesized" | "activated"): OperatorEvent {
		return this.projectionController.emitEvent({
			severity: "success",
			category: "adaptation",
			title: `Capability ${action} · ${capabilityId}`,
		});
	}

	recordCompactionResult(summary: string): OperatorEvent {
		// FR-131: compaction event visible as one line
		return this.projectionController.emitEvent({
			severity: "info",
			category: "compaction",
			title: `Context compacted · ${summary}`,
		});
	}

	recordRuleRepair(ruleId: string, repairAction: string): OperatorEvent {
		// FR-132: project-rule repair event visible
		return this.projectionController.emitEvent({
			severity: "warning",
			category: "rule",
			title: `Rule repair triggered · ${ruleId}`,
			detail: repairAction,
		});
	}

	recordSupervisorIntervention(workerId: string, directive: string): OperatorEvent {
		// FR-133: supervisor intervention event visible
		return this.projectionController.emitEvent({
			severity: "warning",
			category: "worker",
			title: `Worker steered · ${workerId}`,
			detail: directive,
		});
	}

	recordAcquisitionEvent(disposition: "rewrite_safe_route" | "deny", message: string): OperatorEvent {
		// FR-134: acquisition rewrite/block event visible
		return this.projectionController.emitEvent({
			severity: disposition === "deny" ? "failure" : "warning",
			category: "acquisition",
			title: disposition === "deny" ? `Acquisition blocked · ${message}` : `Acquisition hardened · ${message}`,
		});
	}

	getVisibleEvents(): readonly OperatorEvent[] {
		return this.projectionController.getVisibleEvents();
	}
}
