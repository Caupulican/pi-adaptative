import "../builtin-install.ts";
import type { HarnessWorld } from "../session-fixture.ts";
import { type PlanCutScenario, runPlanCutPhase } from "./journey-5-plan-cut.ts";
import { crashCutChecks, LIMITS_PATH, ownedFilesManifest, ownedWorkerFiles } from "./shared.ts";

const SCENARIO: PlanCutScenario = {
	name: "j5-crash",
	mark: "j5.plan-crash",
	title: "Raise the retry limit to 6, have the change checked, and list who reads it",
	prompt: "Raise the retry limit to 6, have the change checked, and list who reads it.",
	change: "bump-retries",
	check: "check-bump",
	listing: "list-retry-readers",
	summary: "bump-summary",
	file: {
		path: LIMITS_PATH,
		relative: "src/limits.ts",
		oldText: "MAX_RETRIES = 5",
		newText: "MAX_RETRIES = 6",
		after: "export const MAX_RETRIES = 6;\n",
	},
	tasks: {
		change: "In src/limits.ts set MAX_RETRIES to 6.",
		check: "Confirm that src/limits.ts sets MAX_RETRIES to 6.",
		listing:
			"Search the project for every place that reads MAX_RETRIES and report each file and line. Change no file.",
		summary: "Combine the checked change and the list of readers into one result.",
	},
	reports: {
		change: "MAX_RETRIES is 6.",
		check: "src/limits.ts sets MAX_RETRIES to 6, as the task asked.",
		listing: "MAX_RETRIES is read in src/limits.ts only.",
	},
	verdictCode: "limit_is_6",
	interruption: "agent_process_recovered_after_owner_exit",
};

/**
 * Crash mid-plan (`journey-5-plan-cut.ts`): the owner's process ends at the cut. Its files go back to what they held then
 * (the listing's attempt running under the dead process's lease, the check's attempt queued), the process changes, and the
 * session is opened again. The recovery finds the lease's owner gone and suspends the listing's attempt, which then names
 * that as what interrupted it, and takes up the check's attempt, which never started, as it is. The plan goes on to its end
 * as it does after a close.
 */
export async function runJourney5PlanCrashPhase(world: HarnessWorld): Promise<void> {
	await runPlanCutPhase(world, SCENARIO, async (owner) => {
		const sessionFile = owner.sessionManager.getSessionFile();
		if (sessionFile === undefined) throw new Error("the plan's owner has no session file");
		const agents = Object.values(owner.session.backgroundLanes.getTaskRuntimeSnapshot()?.agents ?? {});
		const manifest = ownedFilesManifest(
			world,
			{ sessionFile, sessionId: owner.sessionManager.getSessionId() },
			agents.map((agent) => ownedWorkerFiles(world, agent)),
		);
		return world.restart({
			owner: owner.session,
			sessionFile,
			cut: { manifest, capture: manifest() },
			rewindSqlite: false,
			retainedClaims: [],
			check: crashCutChecks("the plan's owner disposes cleanly"),
		});
	});
}
