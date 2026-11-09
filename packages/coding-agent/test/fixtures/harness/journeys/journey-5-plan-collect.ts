import "../builtin-install.ts";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { createBarrier } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import {
	enqueueRoot,
	enqueueStepWorker,
	PLAN_CALL_JUDGMENTS,
	planCallSteps,
	planTitled,
	planUpdateStep,
	planUpdatesIn,
	reportStep,
	rootReached,
	stepReached,
	stepWriteAuthority,
} from "./journey-5-shared.ts";

const TITLE = "Survey the limits module from two angles and combine the findings";

/**
 * Start and collect: the root starts a plan of two independent read-only steps and a collect join over them. Both steps are
 * released before either finishes, the join settles in code once both report, and the root is told once.
 */
export async function runJourney5PlanCollectPhase(world: HarnessWorld, session: AgentSession): Promise<void> {
	const trace = world.trace;
	const started = createBarrier();
	const done = createBarrier();
	const releaseWorkers = createBarrier();
	let planUpdates = 0;
	const mark = world.provider.reached.length;
	for (const nodeId of ["survey-exports", "survey-usage"]) {
		enqueueStepWorker(
			world,
			nodeId,
			reportStep(
				`j5-${nodeId}-report`,
				{ status: "completed", summary: `Result of ${nodeId}: MAX_RETRIES is 3.` },
				releaseWorkers.promise,
			),
		);
	}
	enqueueRoot(
		world,
		...planCallSteps(
			"j5-collect",
			{
				action: "start",
				title: TITLE,
				steps: [
					{
						id: "survey-exports",
						do: "Read src/limits.ts and list every exported constant with its value. Change no file. Report the list as your result.",
					},
					{
						id: "survey-usage",
						do: "Search the project for every place that reads MAX_RETRIES and report each file and line. Change no file.",
					},
					{
						id: "combined",
						do: "Combine both surveys into one result.",
						join: "collect",
						uses: ["survey-exports", "survey-usage"],
					},
				],
			},
			"PLAN_STARTED",
			() => started.release(),
		),
		planUpdateStep("j5-collect-wake", "PLAN_DONE", (request) => {
			planUpdates = planUpdatesIn(request);
			done.release();
		}),
	);
	world.systemOne.enterPhase("j5-collect", PLAN_CALL_JUDGMENTS);
	await withDeadline(
		trace,
		"J5 collect turn",
		session.prompt("Survey the limits module from two angles and combine the findings."),
	);
	await withDeadline(trace, "J5 plan started", started.promise);
	// Both steps are in flight, each held at its first request, before either reports: the plan runs them in parallel.
	await withDeadline(
		trace,
		"J5 both steps in flight",
		Promise.all([
			world.provider.whenReached(stepReached("survey-exports", "j5-survey-exports-report"), mark),
			world.provider.whenReached(stepReached("survey-usage", "j5-survey-usage-report"), mark),
		]),
	);
	releaseWorkers.release();
	await withDeadline(trace, "J5 the plan's result woke the root", done.promise, 60_000);
	await withDeadline(trace, "J5 root idle", session.waitForForegroundIdle());
	const plan = planTitled(session, TITLE);
	const join = plan.nodes.combined?.join;
	// An outcome written by a newer build is opaque; this build wrote this one.
	const joined = join && "status" in join.outcome ? join.outcome : undefined;
	expect(
		{
			workers: [plan.nodes["survey-exports"]?.release?.taskId, plan.nodes["survey-usage"]?.release?.taskId].map(
				(taskId) => typeof taskId === "string",
			),
			ownWorkerEach: plan.nodes["survey-exports"]?.release?.taskId !== plan.nodes["survey-usage"]?.release?.taskId,
			settled: [plan.nodes["survey-exports"]?.settled, plan.nodes["survey-usage"]?.settled].map(
				(settlement) => settlement !== undefined,
			),
			mayChange: ["survey-exports", "survey-usage"].map((nodeId) =>
				stepWriteAuthority(session, plan.nodes[nodeId]?.release?.taskId),
			),
			joinRanNoWorker: plan.nodes.combined?.release === undefined,
			join: joined && { status: joined.status, scope: joined.scope, blocker: joined.blocker },
			closed: plan.closed?.status,
			retired: plan.retired,
		},
		"each step ran read-only on its own worker and settled, the collect join settled in code, and the plan closed",
	).toEqual({
		workers: [true, true],
		ownWorkerEach: true,
		settled: [true, true],
		// A step that names no files is read-only work: its worker holds no write path and no edit tool.
		mayChange: [
			{ readOnly: true, writePaths: [], editTools: [] },
			{ readOnly: true, writePaths: [], editTools: [] },
		],
		joinRanNoWorker: true,
		join: { status: "succeeded", scope: "join", blocker: "none" },
		closed: "settled",
		retired: [],
	});
	const result = JSON.parse(String(world.io.readFileSync(join!.artifact, "utf8"))) as {
		kind: string;
		members: { nodeId: string; status: string }[];
		gaps: string[];
		conflicts: unknown[];
	};
	expect(
		{ kind: result.kind, members: result.members.map((member) => [member.nodeId, member.status]), gaps: result.gaps },
		"the join's result file names both members as succeeded with no gap",
	).toEqual({
		kind: "collect",
		members: [
			["survey-exports", "succeeded"],
			["survey-usage", "succeeded"],
		],
		gaps: [],
	});
	expect(
		world.provider.reached.slice(mark),
		"each step asked its model once, and the root was woken by the plan's one result",
	).toEqual([
		rootReached("j5-collect-call"),
		rootReached("j5-collect-result"),
		stepReached("survey-exports", "j5-survey-exports-report"),
		stepReached("survey-usage", "j5-survey-usage-report"),
		rootReached("j5-collect-wake"),
	]);
	expect(planUpdates, "the root received exactly one plan update, the plan's result").toBe(1);
	trace.mark("root", "j5.plan-collect");
}
