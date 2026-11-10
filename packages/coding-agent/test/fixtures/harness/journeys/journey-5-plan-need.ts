import "../builtin-install.ts";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { createBarrier, type ScriptedRequest } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import {
	deliveredLine,
	enqueueRoot,
	enqueueStepWorker,
	latestAttemptOf,
	PLAN_CALL_JUDGMENTS,
	planTitled,
	planUpdateStep,
	planUpdatesIn,
	ROOT_TRACK,
	reportStep,
	stepReached,
	stepTrack,
	whenPlanState,
} from "./journey-5-shared.ts";
import { latestBatchResults, refusalDiagnostic } from "./shared.ts";

const TITLE = "Probe the retry limit three ways and combine the two that answer";
const RESULT = "probe-result";
/** The three probes and the collect join over them, as the accepted call states them. */
const EAST = { id: "probe-east", do: "Read src/limits.ts and report the value MAX_RETRIES is set to. Change no file." };
const WEST = {
	id: "probe-west",
	do: "Search src for every place that reads MAX_RETRIES and report each file. Change no file.",
};
const SOUTH = {
	id: "probe-south",
	do: "Search the tests for every place that sets MAX_RETRIES and report each one. Change no file.",
};
/** The join settles on a quorum: two of the three probes must succeed for it. */
const JOIN = {
	id: RESULT,
	do: "Combine the two probes that answered.",
	join: "collect",
	uses: [EAST.id, WEST.id, SOUTH.id],
	need: 2,
};
/** The fix line a `need` on a step that is no collect join earns. */
const MISPLACED_NEED = `step "${EAST.id}" is plain work; need belongs to a collect step`;
/** The fix line a `need` larger than the collect join's member count earns (code fact F4). */
const TOO_LARGE_NEED = `step "${RESULT}": need must be between 1 and 2, the number of steps it combines`;

/**
 * The fix lines the plan call of the root's latest request was refused with, read from the failure record the root is
 * given; fails when the call was accepted.
 */
function planRefusalOf(request: ScriptedRequest): string {
	const result = latestBatchResults(request).find((entry) => entry.toolName === "plan");
	if (!result?.isError) throw new Error(`the plan call was not refused: ${result?.text ?? "no result"}`);
	return refusalDiagnostic(result.text) ?? result.text;
}

/** The root's reply that makes one `plan` call. */
function planCallReply(id: string, input: Record<string, unknown>) {
	return {
		content: [{ type: "toolCall" as const, id, name: "plan", arguments: input }],
		stopReason: "toolUse" as const,
	};
}

/**
 * A collect join that settles on a quorum. Before the root's accepted call, two plan calls are refused: a `need` on plain
 * work, and a `need` larger than the join's member count; neither records anything. The accepted plan runs three read-only
 * probes together, each held at its first request. The first report leaves the join unsettled and the plan running; the
 * second settles the join on its quorum of two, closes the plan and stops the third probe, which never answers. The root is
 * told once, by the plan's result, and the join's result names the two probes that succeeded.
 */
export async function runJourney5PlanNeedPhase(world: HarnessWorld, session: AgentSession): Promise<void> {
	const trace = world.trace;
	const started = createBarrier();
	const done = createBarrier();
	const releaseEast = createBarrier();
	const releaseWest = createBarrier();
	// Never released while the plan runs: the third probe is still waiting on its model when the quorum settles.
	const holdSouth = createBarrier();
	let updates = 0;
	let resultLine = "";
	const mark = world.provider.reached.length;
	enqueueStepWorker(
		world,
		EAST.id,
		reportStep(
			"j5-need-east-report",
			{ status: "completed", summary: "MAX_RETRIES is 3, as src/limits.ts sets it." },
			releaseEast.promise,
		),
	);
	enqueueStepWorker(
		world,
		WEST.id,
		reportStep(
			"j5-need-west-report",
			{ status: "completed", summary: "src/limits.ts is the only place that reads MAX_RETRIES." },
			releaseWest.promise,
		),
	);
	enqueueStepWorker(
		world,
		SOUTH.id,
		reportStep(
			"j5-need-south-report",
			{ status: "completed", summary: "Never delivered: the quorum settles before this probe answers." },
			holdSouth.promise,
		),
	);
	enqueueRoot(
		world,
		{
			name: "j5-need-misplaced-call",
			reply: planCallReply("j5-need-misplaced-call-1", {
				action: "start",
				title: TITLE,
				steps: [{ ...EAST, need: 1 }],
			}),
		},
		{
			name: "j5-need-misplaced-refused",
			check: (request) => {
				const refusal = planRefusalOf(request);
				if (!refusal.includes(MISPLACED_NEED))
					throw new Error(`the need on plain work was not refused with its fix: ${refusal}`);
			},
			reply: planCallReply("j5-need-too-large-call-1", {
				action: "start",
				title: TITLE,
				steps: [EAST, WEST, { ...JOIN, uses: [EAST.id, WEST.id], need: 3 }],
			}),
		},
		{
			name: "j5-need-too-large-refused",
			check: (request) => {
				const refusal = planRefusalOf(request);
				if (!refusal.includes(TOO_LARGE_NEED))
					throw new Error(`the need above the member count was not refused with its fix: ${refusal}`);
			},
			reply: planCallReply("j5-need-call-1", {
				action: "start",
				title: TITLE,
				steps: [EAST, WEST, SOUTH, JOIN],
			}),
		},
		{
			name: "j5-need-result",
			check: (request) => {
				const result = latestBatchResults(request).find((entry) => entry.toolName === "plan");
				if (result?.isError || !result?.text.includes("PLAN_STARTED")) {
					throw new Error(`the plan call was not accepted: ${result?.text ?? "no result"}`);
				}
				started.release();
			},
			reply: { content: [{ type: "text", text: "The plan is running." }] },
		},
		planUpdateStep("j5-need-wake", "PLAN_DONE", (request) => {
			updates = planUpdatesIn(request);
			resultLine = deliveredLine(request, "Result: ");
			done.release();
		}),
	);
	world.systemOne.enterPhase("j5-need", PLAN_CALL_JUDGMENTS);
	await withDeadline(
		trace,
		"J5 need turn",
		session.prompt("Probe the retry limit three ways and combine the two that answer."),
	);
	await withDeadline(trace, "J5 need: the plan started", started.promise);
	await withDeadline(
		trace,
		"J5 need: all three probes in flight",
		Promise.all([
			world.provider.whenReached(stepReached(EAST.id, "j5-need-east-report"), mark),
			world.provider.whenReached(stepReached(WEST.id, "j5-need-west-report"), mark),
			world.provider.whenReached(stepReached(SOUTH.id, "j5-need-south-report"), mark),
		]),
	);
	const inFlight = planTitled(session, TITLE);
	const taskOf = (nodeId: string) => inFlight.nodes[nodeId]?.release?.taskId;
	expect(
		{
			version: inFlight.record.version,
			ownWorkerEach: new Set([EAST.id, WEST.id, SOUTH.id].map(taskOf)).size,
			statuses: [EAST.id, WEST.id, SOUTH.id].map((nodeId) => latestAttemptOf(session, taskOf(nodeId))?.status),
			joinSettled: inFlight.nodes[RESULT]?.join !== undefined,
		},
		"the accepted plan released the three probes together before any report, each on its own worker, and the plan was recorded at its first version",
	).toEqual({ version: 1, ownWorkerEach: 3, statuses: ["running", "running", "running"], joinSettled: false });
	releaseEast.release();
	await withDeadline(
		trace,
		"J5 need: the first report settled",
		whenPlanState(session, () => planTitled(session, TITLE).nodes[EAST.id]?.settled !== undefined),
	);
	const afterFirst = planTitled(session, TITLE);
	expect(
		{
			eastSettled: afterFirst.nodes[EAST.id]?.settled !== undefined,
			joinSettled: afterFirst.nodes[RESULT]?.join !== undefined,
			southSettled: afterFirst.nodes[SOUTH.id]?.settled !== undefined,
			closed: afterFirst.closed?.status,
		},
		"one report of the two the join needs left the join unsettled and the plan running, with the third probe still in flight",
	).toEqual({ eastSettled: true, joinSettled: false, southSettled: false, closed: undefined });
	releaseWest.release();
	await withDeadline(trace, "J5 need: the plan's result woke the root", done.promise, 60_000);
	await withDeadline(trace, "J5 need: root idle", session.waitForForegroundIdle());
	const plan = planTitled(session, TITLE);
	const join = plan.nodes[RESULT]?.join;
	// An outcome written by a newer build is opaque; this build wrote this one.
	const joined = join && "status" in join.outcome ? join.outcome : undefined;
	const southTaskId = plan.nodes[SOUTH.id]?.release?.taskId;
	// The third probe's worker was running when it was stopped, so its attempt ended with a result that carries the reason.
	const south = latestAttemptOf(session, southTaskId);
	const southTask =
		southTaskId === undefined ? undefined : session.backgroundLanes.getTaskRuntimeSnapshot()?.tasks[southTaskId];
	const southOutcome = southTask?.outcome && "status" in southTask.outcome ? southTask.outcome : undefined;
	expect(
		{
			join: joined && { status: joined.status, scope: joined.scope, blocker: joined.blocker },
			probesSettled: [EAST.id, WEST.id, SOUTH.id].map((nodeId) => plan.nodes[nodeId]?.settled !== undefined),
			south: south && { status: south.status, reasonCode: south.result?.reasonCode },
			southOutcome: southOutcome && {
				status: southOutcome.status,
				sourceCodes: southOutcome.sourceCodes,
				nextAction: southOutcome.nextAction,
			},
			southAttempts: southTask?.attemptIds.length,
			closed: plan.closed?.status,
			retired: plan.retired,
		},
		"two reports settled the collect join on its quorum of two, the third probe's one attempt was stopped for it, and the plan closed",
	).toEqual({
		join: { status: "succeeded", scope: "join", blocker: "none" },
		probesSettled: [true, true, false],
		south: { status: "cancelled", reasonCode: "plan_join_settled" },
		southOutcome: {
			status: "cancelled",
			sourceCodes: ["plan_join_settled"],
			nextAction: { kind: "abandon", reason: "cancelled" },
		},
		southAttempts: 1,
		closed: "settled",
		retired: [],
	});
	const result = JSON.parse(String(world.io.readFileSync(join!.artifact, "utf8"))) as {
		kind: string;
		members: { nodeId: string; status: string }[];
		gaps: string[];
	};
	expect(
		{
			kind: result.kind,
			members: result.members.map((member) => [member.nodeId, member.status]),
			gaps: result.gaps,
			// The join settled on its quorum before the third probe answered, so its result names only the two that did.
			namesTheThird: JSON.stringify(result).includes(SOUTH.id),
		},
		"the join's result file names the two probes that succeeded with no gap, and says nothing about the third",
	).toEqual({
		kind: "collect",
		members: [
			[EAST.id, "succeeded"],
			[WEST.id, "succeeded"],
		],
		gaps: [],
		namesTheThird: false,
	});
	const reached = world.provider.reached.slice(mark);
	expect(
		{
			root: reached.filter((key) => key.startsWith(`${ROOT_TRACK}:`)),
			probes: [EAST.id, WEST.id, SOUTH.id].map(
				(nodeId) => reached.filter((key) => key.startsWith(`${stepTrack(nodeId)}:`)).length,
			),
			updates,
			resultLine,
		},
		"each probe asked its model once, the third got no reply, and the root was told once, by the plan's result",
	).toEqual({
		root: [
			`${ROOT_TRACK}:j5-need-misplaced-call`,
			`${ROOT_TRACK}:j5-need-misplaced-refused`,
			`${ROOT_TRACK}:j5-need-too-large-refused`,
			`${ROOT_TRACK}:j5-need-result`,
			`${ROOT_TRACK}:j5-need-wake`,
		],
		probes: [1, 1, 1],
		updates: 1,
		resultLine: "succeeded; 2 steps combined.",
	});
	holdSouth.release();
	trace.mark("root", "j5.plan-need");
}
