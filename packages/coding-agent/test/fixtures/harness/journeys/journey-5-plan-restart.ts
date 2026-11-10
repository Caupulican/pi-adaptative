import "../builtin-install.ts";
import { expect } from "vitest";
import type { HarnessWorld } from "../session-fixture.ts";
import { type PlanCutScenario, planCutFacts, runPlanCutPhase } from "./journey-5-plan-cut.ts";
import { TIMEOUTS_PATH } from "./journey-5-plan-verify-rejected.ts";

const SCENARIO: PlanCutScenario = {
	name: "j5-restart",
	mark: "j5.plan-restart",
	title: "Raise the request timeout to 4000, have the change checked, and list who reads it",
	prompt: "Raise the request timeout to 4000, have the change checked, and list who reads it.",
	change: "raise-timeout",
	check: "check-raise",
	listing: "list-readers",
	summary: "raise-summary",
	file: {
		path: TIMEOUTS_PATH,
		relative: "src/timeouts.ts",
		oldText: "TIMEOUT_MS = 3000",
		newText: "TIMEOUT_MS = 4000",
		after: "export const TIMEOUT_MS = 4000;\n",
	},
	tasks: {
		change: "In src/timeouts.ts set TIMEOUT_MS to 4000.",
		check: "Confirm that src/timeouts.ts sets TIMEOUT_MS to 4000.",
		listing:
			"Search the project for every place that reads TIMEOUT_MS and report each file and line. Change no file.",
		summary: "Combine the checked change and the list of readers into one result.",
	},
	reports: {
		change: "TIMEOUT_MS is 4000.",
		check: "src/timeouts.ts sets TIMEOUT_MS to 4000, as the task asked.",
		listing: "TIMEOUT_MS is read in src/timeouts.ts only.",
	},
	verdictCode: "timeout_is_4000",
	interruption: "agent_process_interrupted",
};

/**
 * Restart mid-plan (`journey-5-plan-cut.ts`): the owner closes the session at the cut and opens it again in the same process.
 * The close interrupts the worker in flight and cancels nothing: the listing's attempt is suspended, the check's attempt
 * stays queued, and the plan is as it was. The reopened session takes both up again and the plan goes on to its end.
 */
export async function runJourney5PlanRestartPhase(world: HarnessWorld): Promise<void> {
	await runPlanCutPhase(world, SCENARIO, async (owner, before) => {
		const sessionFile = owner.sessionManager.getSessionFile();
		if (sessionFile === undefined) throw new Error("the plan's owner has no session file");
		expect(
			await world.disposeSessionInBody(owner.session),
			"the plan's owner closes cleanly mid-plan",
		).toBeUndefined();
		await world.provider.waitForProducers();
		world.certifyDisposedOwner(owner.session, []);
		const closed = planCutFacts(owner.session, SCENARIO);
		expect(
			{
				sameTasks: closed.tasks,
				sameAttempts: closed.attemptIds,
				statuses: closed.statuses,
				interrupted: closed.reasons[2],
				settled: closed.settled,
				closed: closed.closed,
			},
			"the close interrupts the worker in flight and leaves the waiting check and the plan as they were: nothing is cancelled",
		).toEqual({
			sameTasks: before.tasks,
			sameAttempts: before.attemptIds,
			statuses: [["completed"], ["queued"], ["suspended"]],
			interrupted: [SCENARIO.interruption],
			settled: [true, false, false],
			closed: undefined,
		});
		return world.createRootSession("root", { sessionManager: world.openSessionManager(sessionFile) });
	});
}
