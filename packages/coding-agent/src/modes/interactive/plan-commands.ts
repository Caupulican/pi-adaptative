/**
 * `/plan` — inspection of the session's plans: each open plan step by step, closed ones in one line. The command only
 * reads; a plan runs, retries, joins and finishes without the owner typing anything.
 */
import type { GoalState } from "../../core/goals/goal-state.ts";
import { interfaceText } from "../../core/language/interface-text.ts";
import { planInspectionText } from "../../core/plan/plan-panel.ts";
import type { PlanView } from "../../core/plan/plan-view.ts";

export interface PlanCommandHost {
	/** Retained plans in `listPlanViews` order; empty when the worker ledger is not loaded. */
	listPlans(): readonly PlanView[];
	getGoalStateSnapshot(): GoalState | undefined;
	showError(message: string): void;
	/** Multi-line output in the conversation. */
	showText(text: string): void;
}

/** What `/plan` answers with when it is given an argument it does not take. */
export function planUsage(): string {
	return interfaceText().autonomyCommands.plan.usage;
}

export function handlePlanCommand(host: PlanCommandHost, text: string): void {
	if (text.replace(/^\/plan\b/, "").trim().length > 0) {
		host.showError(planUsage());
		return;
	}
	const requirements = new Map(
		(host.getGoalStateSnapshot()?.requirements ?? []).map((requirement) => [requirement.id, requirement.text]),
	);
	host.showText(planInspectionText(host.listPlans(), { requirementText: (id) => requirements.get(id) }));
}
