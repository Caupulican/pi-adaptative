import "../builtin-install.ts";
import { expect } from "vitest";
import { createBarrier, type ScriptedRequest } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { ICM_INTAKE_JUDGMENTS, latestBatchResults } from "./shared.ts";

/** The intake judgments a plain prompt consumes here: a plan call without a profile asks no capability question. */
const { capabilities_authorized: _capabilities, ...INTAKE_JUDGMENTS } = ICM_INTAKE_JUDGMENTS;

/** A plan step's worker runs on the root's model: its request is told apart by the step header its task starts with. */
function isStepWorker(nodeId: string): (request: ScriptedRequest) => boolean {
	return (request) => JSON.stringify(request.context.messages).includes(`| node ${nodeId} | attempt 1]`);
}

/** The root's own requests: none of them carries a plan step's task. */
function isRoot(request: ScriptedRequest): boolean {
	return !JSON.stringify(request.context.messages).includes("| attempt 1]");
}

/**
 * Start and collect: the root starts a plan of two independent read-only steps and a collect join over them. Both steps are
 * released before either finishes, the join settles in code once both report, and the root is told once.
 */
export async function runJourney5PlanCollectPhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	const fleet = world.settingsManager.getGlobalSettings().fleet ?? {};
	world.settingsManager.setFleetSettings({ ...fleet, ceiling: { ...fleet.ceiling, running: 4 } });
	const created = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
	const session = created.session;
	const started = createBarrier();
	const done = createBarrier();
	const releaseWorkers = createBarrier();
	let planUpdates = 0;
	const mark = world.provider.reached.length;
	for (const nodeId of ["survey-exports", "survey-usage"]) {
		world.provider.enqueueTrack(`j5-${nodeId}`, "root", isStepWorker(nodeId), {
			name: `j5-${nodeId}-report`,
			gate: releaseWorkers.promise,
			reply: {
				content: [
					{
						type: "toolCall",
						id: `j5-${nodeId}-report-1`,
						name: "submit_report",
						arguments: { status: "completed", summary: `Result of ${nodeId}: MAX_RETRIES is 3.` },
					},
				],
				stopReason: "toolUse",
			},
		});
	}
	world.provider.enqueueTrack(
		"j5-root",
		"root",
		isRoot,
		{
			name: "j5-collect-plan",
			check: (request) => {
				const offered = (request.context.tools ?? []).map((tool) => tool.name);
				if (!offered.includes("plan")) throw new Error(`the root is not offered plan: ${offered.join(", ")}`);
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j5-collect-plan-1",
						name: "plan",
						arguments: {
							action: "start",
							title: "Survey the limits module from two angles and combine the findings",
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
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j5-collect-started",
			check: (request) => {
				const result = latestBatchResults(request).find((entry) => entry.toolName === "plan");
				if (result?.isError || !result?.text.includes("PLAN_STARTED")) {
					throw new Error(`the plan did not start: ${result?.text ?? "no result"}`);
				}
				started.release();
			},
			reply: { content: [{ type: "text", text: "The plan is running." }] },
		},
		{
			name: "j5-collect-wake",
			maxRequests: 8,
			until: (request) => {
				const context = JSON.stringify(request.context.messages);
				const finished = context.includes("PLAN_UPDATE,PLAN_DONE");
				if (finished) {
					planUpdates = context.split("h PLAN_UPDATE,").length - 1;
					done.release();
				}
				return finished;
			},
			reply: { content: [{ type: "text", text: "Waiting for the plan." }] },
		},
	);
	world.systemOne.enterPhase("j5-collect", {
		...INTAKE_JUDGMENTS,
		// The plan's review: the plan covers the request, and each step can be done from its own words.
		misses_request_part: { kind: "noul", probability: 0.02 },
		brief_self_contained: { kind: "noul", probability: 0.97 },
	});
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
			world.provider.whenReached("j5-survey-exports:j5-survey-exports-report", mark),
			world.provider.whenReached("j5-survey-usage:j5-survey-usage-report", mark),
		]),
	);
	releaseWorkers.release();
	await withDeadline(trace, "J5 the plan's result woke the root", done.promise, 60_000);
	await withDeadline(trace, "J5 root idle", session.waitForForegroundIdle());
	const plans = Object.values(session.backgroundLanes.getTaskRuntimeSnapshot()?.plans ?? {});
	expect(plans, "the session holds exactly the one plan").toHaveLength(1);
	const plan = plans[0]!;
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
			joinRanNoWorker: plan.nodes.combined?.release === undefined,
			join: joined && { status: joined.status, scope: joined.scope, blocker: joined.blocker },
			closed: plan.closed?.status,
			retired: plan.retired,
		},
		"each step ran on its own worker and settled, the collect join settled in code, and the plan closed",
	).toEqual({
		workers: [true, true],
		ownWorkerEach: true,
		settled: [true, true],
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
		"j5-root:j5-collect-plan",
		"j5-root:j5-collect-started",
		"j5-survey-exports:j5-survey-exports-report",
		"j5-survey-usage:j5-survey-usage-report",
		"j5-root:j5-collect-wake",
	]);
	expect(planUpdates, "the root received exactly one plan update, the plan's result").toBe(1);
	expect(await world.disposeSessionInBody(session), "the J5 owner disposes cleanly").toBeUndefined();
	trace.mark("root", "j5.plan-collect");
}
