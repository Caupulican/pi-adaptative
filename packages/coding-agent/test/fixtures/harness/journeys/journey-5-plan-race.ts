import "../builtin-install.ts";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { createBarrier } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import {
	deliveredLine,
	enqueueRoot,
	enqueueStepWorker,
	latestAttemptOf,
	PLAN_CALL_JUDGMENTS,
	planCallSteps,
	planTitled,
	planUpdateStep,
	planUpdatesIn,
	ROOT_TRACK,
	reportStep,
	stepReached,
	stepTrack,
} from "./journey-5-shared.ts";

const TITLE = "Find where the retry limit is read, by whichever search answers first";

/**
 * Race: two steps look for the same answer and a race join takes the first accepted result. The step still running is
 * stopped with the join's reason, the plan closes on the winner, and the root is told once.
 */
export async function runJourney5PlanRacePhase(world: HarnessWorld, session: AgentSession): Promise<void> {
	const trace = world.trace;
	const started = createBarrier();
	const done = createBarrier();
	const releaseWinner = createBarrier();
	// Never released: the losing step is still waiting on its model when the race settles.
	const holdLoser = createBarrier();
	let updates = 0;
	let resultLine = "";
	const mark = world.provider.reached.length;
	enqueueStepWorker(
		world,
		"search-imports",
		reportStep(
			"j5-race-winner-report",
			{ status: "completed", summary: "MAX_RETRIES is read only where src/limits.ts exports it." },
			releaseWinner.promise,
		),
	);
	enqueueStepWorker(
		world,
		"search-text",
		reportStep(
			"j5-race-loser-report",
			{ status: "completed", summary: "A text search finds MAX_RETRIES in src/limits.ts." },
			holdLoser.promise,
		),
	);
	enqueueRoot(
		world,
		...planCallSteps(
			"j5-race",
			{
				action: "start",
				title: TITLE,
				steps: [
					{
						id: "search-imports",
						do: "Follow the import graph from src/limits.ts and report every module that reads MAX_RETRIES. Change no file.",
					},
					{
						id: "search-text",
						do: "Search the project text for MAX_RETRIES and report every file and line that reads it. Change no file.",
					},
					{
						id: "first-answer",
						do: "Take the first accepted answer.",
						join: "race",
						uses: ["search-imports", "search-text"],
					},
				],
			},
			"PLAN_STARTED",
			() => started.release(),
		),
		planUpdateStep("j5-race-wake", "PLAN_DONE", (request) => {
			updates = planUpdatesIn(request);
			resultLine = deliveredLine(request, "Result: ");
			done.release();
		}),
	);
	world.systemOne.enterPhase("j5-race", PLAN_CALL_JUDGMENTS);
	await withDeadline(
		trace,
		"J5 race turn",
		session.prompt("Find where the retry limit is read; take whichever search answers first."),
	);
	await withDeadline(trace, "J5 race: the plan started", started.promise);
	await withDeadline(
		trace,
		"J5 race: both steps in flight",
		Promise.all([
			world.provider.whenReached(stepReached("search-imports", "j5-race-winner-report"), mark),
			world.provider.whenReached(stepReached("search-text", "j5-race-loser-report"), mark),
		]),
	);
	releaseWinner.release();
	await withDeadline(trace, "J5 race: the plan's result woke the root", done.promise, 60_000);
	await withDeadline(trace, "J5 race: root idle", session.waitForForegroundIdle());
	const plan = planTitled(session, TITLE);
	const join = plan.nodes["first-answer"]?.join;
	// An outcome written by a newer build is opaque; this build wrote this one.
	const joined = join && "status" in join.outcome ? join.outcome : undefined;
	const loserTaskId = plan.nodes["search-text"]?.release?.taskId;
	// The step's worker was running when it was stopped, so its attempt ended with a result that carries the reason.
	const loser = latestAttemptOf(session, loserTaskId);
	const loserTask =
		loserTaskId === undefined ? undefined : session.backgroundLanes.getTaskRuntimeSnapshot()?.tasks[loserTaskId];
	const loserOutcome = loserTask?.outcome && "status" in loserTask.outcome ? loserTask.outcome : undefined;
	expect(
		{
			join: joined && { status: joined.status, scope: joined.scope, blocker: joined.blocker },
			winnerSettled: plan.nodes["search-imports"]?.settled !== undefined,
			loserSettled: plan.nodes["search-text"]?.settled !== undefined,
			loser: loser && { status: loser.status, reasonCode: loser.result?.reasonCode },
			loserOutcome: loserOutcome && {
				status: loserOutcome.status,
				sourceCodes: loserOutcome.sourceCodes,
				nextAction: loserOutcome.nextAction,
			},
			loserAttempts: loserTask?.attemptIds.length,
			closed: plan.closed?.status,
			retired: plan.retired,
		},
		"the race settled on the first accepted step, the other step's one attempt was stopped for it, and the plan closed",
	).toEqual({
		join: { status: "succeeded", scope: "join", blocker: "none" },
		winnerSettled: true,
		loserSettled: false,
		loser: { status: "cancelled", reasonCode: "plan_join_settled" },
		loserOutcome: {
			status: "cancelled",
			sourceCodes: ["plan_join_settled"],
			nextAction: { kind: "abandon", reason: "cancelled" },
		},
		loserAttempts: 1,
		closed: "settled",
		retired: [],
	});
	const result = JSON.parse(String(world.io.readFileSync(join!.artifact, "utf8"))) as {
		kind: string;
		winner?: string;
		members: { nodeId: string; status: string }[];
		gaps: string[];
	};
	expect(
		{
			kind: result.kind,
			winner: result.winner,
			members: result.members.map((member) => [member.nodeId, member.status]),
			gaps: result.gaps,
		},
		"the join's result file names the winner as its one member",
	).toEqual({ kind: "race", winner: "search-imports", members: [["search-imports", "succeeded"]], gaps: [] });
	const reached = world.provider.reached.slice(mark);
	expect(
		{
			root: reached.filter((key) => key.startsWith(`${ROOT_TRACK}:`)),
			winner: reached.filter((key) => key.startsWith(`${stepTrack("search-imports")}:`)).length,
			loser: reached.filter((key) => key.startsWith(`${stepTrack("search-text")}:`)).length,
		},
		"each step asked its model once, and the root was woken once, by the plan's result",
	).toEqual({
		root: [`${ROOT_TRACK}:j5-race-call`, `${ROOT_TRACK}:j5-race-result`, `${ROOT_TRACK}:j5-race-wake`],
		winner: 1,
		loser: 1,
	});
	expect({ updates, resultLine }, "the root received exactly one plan update, and it names the winner").toEqual({
		updates: 1,
		resultLine: "succeeded; winner search-imports; 1 steps combined.",
	});
	holdLoser.release();
	trace.mark("root", "j5.plan-race");
}
