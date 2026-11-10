import "../builtin-install.ts";
import { expect } from "vitest";
import type { Outcome } from "../../../../src/core/delegation/worker-outcome.ts";
import { subscribeOutcomes } from "../../../../src/core/delegation/worker-outcome.ts";
import { createGoalState, type GoalState } from "../../../../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot, getLatestGoalStateSnapshot } from "../../../../src/core/goals/session-goal-state.ts";
import { createBarrier } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import {
	carriesTask,
	completeHandoff,
	delegateStart,
	J9_ROOT_JUDGMENTS,
	J9_SETTINGS,
	j9Profile,
	recordedOutcome,
	saveJ9Profile,
	scriptRequirementCheckSpawn,
	taskForInstructions,
	workerReport,
} from "./journey-9-shared.ts";
import { LIMITS_PATH, latestBatchResults } from "./shared.ts";

const PROMPT = "Start a read-only worker that covers the retry limit requirement of the limits file.";
const TASK = "Inspect the retry limit of the limits file and cover the requirement that names it.";
const REQUIREMENT_ID = "j9-met";
/** An observational command the read-only shell line admits, and the one a passing host requirement check runs. */
const CHECK_COMMAND = `rg MAX_RETRIES ${LIMITS_PATH}`;
/** What the worker says about the one requirement, in words no claim check reacts to. */
const PARTIAL_NOTE = "Only the value was read, and I did nothing more with it.";
const NOW = "2026-10-08T00:00:00.000Z";
/**
 * What System One is asked around the root's one tool call under a goal: before it, that the step belongs to the goal and
 * is supported; after it, that it moved the work, stayed in scope, and the work goes on.
 */
const GOAL_STEP_JUDGMENTS = {
	step_relevant: { kind: "noul", probability: 0.97 },
	evidence_sufficient_to_act: { kind: "noul", probability: 0.97 },
	unsupported_assumption_present: { kind: "noul", probability: 0.02 },
	route: { kind: "choice", choice: "reason", confidence: 0.97 },
	action_accomplished_step: { kind: "noul", probability: 0.02 },
	conclusions_supported: { kind: "noul", probability: 0.97 },
	scope_violation: { kind: "noul", probability: 0.02 },
	unrelated_behavior_change: { kind: "noul", probability: 0.02 },
	replan_required: { kind: "noul", probability: 0.02 },
	next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
} as const;

/**
 * Leg 4: the host runs the check the worker skipped. The task covers a goal requirement that carries a host check; the
 * worker answers for it as partial, so the ladder hands the requirement to the host (exit E12). The check passes once, the
 * outcome is projected again with the requirement covered by that check, and the ladder accepts it (exit E0).
 */
export async function runJourney9HostCheckPhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	const reported = createBarrier();
	const accepted = createBarrier();
	const recorded: Outcome[] = [];
	saveJ9Profile(world, j9Profile("j9-check", "worker-a"));
	// The goal is seeded in the journal and is active, so a worker may be started for its requirement. Its automatic
	// continuation is switched off for the leg: the only turns are the owner's and the one the handoff starts.
	const sessionManager = world.createSessionManager();
	appendGoalStateSnapshot(sessionManager, goalWithCheckableRequirement());
	const unsubscribe = subscribeOutcomes((outcome) => {
		if (!outcome.coverage.required.includes(REQUIREMENT_ID)) return;
		recorded.push(outcome);
		if (outcome.ladder.exit === "E0") accepted.release();
	});
	const scriptedCheck = scriptRequirementCheckSpawn(world, CHECK_COMMAND);
	world.shell.enqueue({
		name: "j9-l4-check",
		command: CHECK_COMMAND,
		output: "MAX_RETRIES = 3\n",
		exitCode: 0,
	});
	world.provider.enqueue(
		"root",
		{
			name: "j9-l4-start",
			reply: {
				content: [
					delegateStart("j9-l4-call", {
						profileId: "j9-check",
						instructions: TASK,
						requirementIds: [REQUIREMENT_ID],
					}),
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j9-l4-reply",
			check: (request) => {
				const started = latestBatchResults(request).find((result) => result.toolName === "delegate");
				if (started?.isError || !started?.text.includes("delegate started (running)")) {
					throw new Error(`the worker did not start: ${started?.text ?? "no result"}`);
				}
			},
			reply: { content: [{ type: "text", text: "Noted." }] },
		},
		{
			name: "j9-l4-handoff",
			maxRequests: 8,
			until: (request) => {
				if (!completeHandoff(request)) return false;
				reported.release();
				return true;
			},
			reply: { content: [{ type: "text", text: "Noted." }] },
		},
	);
	world.provider.enqueueTrack(
		"j9-l4-check",
		"worker-a",
		carriesTask(TASK),
		workerReport("j9-l4-report", {
			status: "completed",
			summary: "The retry limit of the limits file is 3, and I did not look any further.",
			requirements: [{ id: REQUIREMENT_ID, status: "partial", note: PARTIAL_NOTE }],
		}),
	);
	world.systemOne.enterPhase("j9-l4", { ...J9_ROOT_JUDGMENTS, ...GOAL_STEP_JUDGMENTS });
	let created: Awaited<ReturnType<typeof world.createRootSession>> | undefined;
	try {
		created = await world.createRootSession("root", {
			sessionManager,
			settings: { ...J9_SETTINGS, autonomy: { goalAutoContinue: false } },
		});
		const session = created.session;
		await withDeadline(trace, "J9 leg 4 turn", session.prompt(PROMPT));
		// The accepted outcome follows the host's own check. When it does not come, the processes the host started say why:
		// no shell among them means the check never ran.
		await withDeadline(trace, "J9 leg 4 accepted outcome", accepted.promise, 120_000).catch((error: unknown) => {
			throw new Error(
				`the host check led to no accepted outcome; the host started: ${JSON.stringify(scriptedCheck.spawned)}; outcomes: ${JSON.stringify(recorded.map((outcome) => [outcome.ladder.exit, outcome.status, outcome.blocker]))}`,
				{ cause: error },
			);
		});
		await withDeadline(trace, "J9 leg 4 handoff", reported.promise, 120_000);
		await withDeadline(trace, "J9 leg 4 root idle", session.waitForForegroundIdle());

		const taskId = taskForInstructions(session, TASK);
		const final = recordedOutcome(session, taskId);
		// The first outcome of the attempt names the host check; the projection after the check replaces it.
		expect(
			recorded.map((outcome) => ({
				exit: outcome.ladder.exit,
				next: outcome.nextAction.kind,
				ids: outcome.nextAction.kind === "host_check" ? outcome.nextAction.requirementIds : undefined,
				status: outcome.status,
				blocker: outcome.blocker,
				covered: outcome.coverage.covered,
				assurance: outcome.assurance,
			})),
			"the attempt is first recorded with the host check it needs, then accepted once that check covered the requirement",
		).toEqual([
			{
				exit: "E12",
				next: "host_check",
				ids: [REQUIREMENT_ID],
				// Nothing is covered yet, so the attempt reads blocked: partial is for a task with some requirements covered.
				status: "blocked",
				blocker: "requirement_uncovered",
				covered: [],
				assurance: "unverified",
			},
			{
				exit: "E0",
				next: "accept",
				ids: undefined,
				status: "succeeded",
				blocker: "none",
				covered: [{ id: REQUIREMENT_ID, by: "requirement_check" }],
				assurance: "host_check",
			},
		]);
		expect(
			{
				shared: recorded.at(-1)?.outcomeId,
				stored: final.outcomeId,
				status: final.status,
				exit: final.ladder.exit,
			},
			"the accepted outcome is the one the task holds",
		).toEqual({ shared: final.outcomeId, stored: final.outcomeId, status: "succeeded", exit: "E0" });
		expect(
			world.shell.requests.filter((request) => request.command === CHECK_COMMAND),
			"the host ran the requirement check exactly once",
		).toHaveLength(1);
		// The host check covers the requirement in the outcome. The goal's own account is not closed by it.
		const goal = getLatestGoalStateSnapshot(sessionManager);
		expect(
			goal?.requirements.map((requirement) => [requirement.id, requirement.status]),
			"a check the host ran is not by itself written back to the goal requirement",
		).toEqual([[REQUIREMENT_ID, "open"]]);
		expect(await world.disposeSessionInBody(session), "the leg 4 owner disposes cleanly").toBeUndefined();
		trace.mark("root", "j9.host-check");
	} finally {
		unsubscribe();
		scriptedCheck.restore();
	}
}

/** An active goal whose one requirement carries a check the host can rerun. */
function goalWithCheckableRequirement(): GoalState {
	const goal = createGoalState({
		goalId: "j9-goal",
		userGoal: "Prove the retry limit of the limits file.",
		now: NOW,
	});
	return {
		...goal,
		requirements: [
			{
				id: REQUIREMENT_ID,
				text: `The limits file still names MAX_RETRIES, as ${CHECK_COMMAND} shows.`,
				check: { command: CHECK_COMMAND, expectExitCode: 0 },
				status: "open",
				evidenceIds: [],
				createdAt: NOW,
				updatedAt: NOW,
			},
		],
	};
}
