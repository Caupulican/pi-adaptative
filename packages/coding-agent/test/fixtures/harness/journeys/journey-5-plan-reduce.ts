import "../builtin-install.ts";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { createBarrier } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import {
	deliveredLines,
	enqueueRoot,
	enqueueStepWorker,
	PLAN_CALL_JUDGMENTS,
	planCallSteps,
	planTitled,
	planUpdateStep,
	planUpdatesIn,
	ROOT_TRACK,
	reportStep,
	stepReached,
	stepTaskLines,
	stepTrack,
	stepWriteAuthority,
} from "./journey-5-shared.ts";

const TITLE = "Settle how many retries the project allows";
const LIMIT_FINDING = "src/limits.ts:1 sets MAX_RETRIES to 3";
const CALLERS_FINDING = "src/limits.ts:1 sets MAX_RETRIES to 5";
/** How a pair of findings about one place is named: to the reducer, in the result file and in the root's update. */
const CONFLICT = `src/limits.ts:1: ${LIMIT_FINDING} / ${CALLERS_FINDING}`;

/**
 * Reduce: two steps report findings about the same line that cannot both hold, and a reduce step answers one question from
 * both. With System One on, the host pairs the findings by the place they name and reads the pair as a conflict before the
 * reducer starts: the reducer is told, the result file names the conflict and the root's update carries it, so the root is told
 * to read everything. With System One off nothing judges the pair: the reducer still reads both results and the result names
 * no conflict.
 */
export async function runJourney5PlanReducePhase(world: HarnessWorld, session: AgentSession): Promise<void> {
	const trace = world.trace;
	const judged = world.systemOne.enabled;
	const started = createBarrier();
	const done = createBarrier();
	const releaseReaders = createBarrier();
	let updates = 0;
	let update: string[] = [];
	let reducerTask: string[] = [];
	const mark = world.provider.reached.length;
	enqueueStepWorker(
		world,
		"read-limit",
		reportStep(
			"j5-reduce-limit-report",
			{
				status: "completed",
				summary: "The limits module sets the retry limit.",
				findings: [{ summary: LIMIT_FINDING, confidence: 0.9 }],
			},
			releaseReaders.promise,
		),
	);
	enqueueStepWorker(
		world,
		"read-callers",
		reportStep(
			"j5-reduce-callers-report",
			{
				status: "completed",
				summary: "The callers assume a retry limit.",
				findings: [{ summary: CALLERS_FINDING, confidence: 0.6 }],
			},
			releaseReaders.promise,
		),
	);
	enqueueStepWorker(world, "settled-limit", {
		...reportStep("j5-reduce-answer-report", {
			status: "completed",
			summary:
				"The project allows 3 retries: src/limits.ts:1 sets MAX_RETRIES to 3, and the other reading is wrong.",
		}),
		check: (request) => {
			reducerTask = stepTaskLines(request);
		},
	});
	enqueueRoot(
		world,
		...planCallSteps(
			"j5-reduce",
			{
				action: "start",
				title: TITLE,
				steps: [
					{
						id: "read-limit",
						do: "Read src/limits.ts and report the value MAX_RETRIES is set to, with the file and line. Change no file.",
					},
					{
						id: "read-callers",
						do: "Read the callers of MAX_RETRIES and report the retry limit they assume, with the file and line. Change no file.",
					},
					{
						id: "settled-limit",
						do: "Give the one retry limit the project allows.",
						join: "reduce",
						uses: ["read-limit", "read-callers"],
						question: "How many retries does the project allow?",
					},
				],
			},
			"PLAN_STARTED",
			() => started.release(),
		),
		planUpdateStep("j5-reduce-wake", "PLAN_DONE", (request) => {
			updates = planUpdatesIn(request);
			update = deliveredLines(request);
			done.release();
		}),
	);
	world.systemOne.enterPhase("j5-reduce", {
		...PLAN_CALL_JUDGMENTS,
		// The two findings name the same line: they cannot both hold, and each states its claim.
		findings_contradict: { kind: "noul", probability: 0.97 },
		finding_evidence_sufficient: { kind: "noul", probability: 0.97 },
	});
	await withDeadline(
		trace,
		"J5 reduce turn",
		session.prompt("Settle how many retries the project allows; two readings may disagree."),
	);
	await withDeadline(trace, "J5 reduce: the plan started", started.promise);
	await withDeadline(
		trace,
		"J5 reduce: both readers in flight",
		Promise.all([
			world.provider.whenReached(stepReached("read-limit", "j5-reduce-limit-report"), mark),
			world.provider.whenReached(stepReached("read-callers", "j5-reduce-callers-report"), mark),
		]),
	);
	releaseReaders.release();
	await withDeadline(trace, "J5 reduce: the plan's result woke the root", done.promise, 60_000);
	await withDeadline(trace, "J5 reduce: root idle", session.waitForForegroundIdle());
	const combine =
		"Combine the results of steps read-limit, read-callers into one answer. It answers: How many retries does the project allow? Name every place the results disagree and resolve it or say why it stays open.";
	expect(
		{
			task: reducerTask.filter((line) => line.startsWith("Task: ")),
			combine: reducerTask.filter((line) => line.startsWith("Combine the results")),
			inputs: reducerTask
				.filter((line) => line.startsWith("Input from step "))
				.map((line) => [line.slice("Input from step ".length).split(":")[0], line.includes(" Report: ")]),
		},
		"the reducer was given its own task, the question, the conflict the host read and a reference to each result",
	).toEqual({
		task: ["Task: Give the one retry limit the project allows."],
		combine: [judged ? `${combine} These findings conflict: ${CONFLICT}.` : combine],
		inputs: [
			["read-limit", true],
			["read-callers", true],
		],
	});
	const plan = planTitled(session, TITLE);
	const join = plan.nodes["settled-limit"]?.join;
	// An outcome written by a newer build is opaque; this build wrote this one.
	const joined = join && "status" in join.outcome ? join.outcome : undefined;
	expect(
		{
			readersSettled: [plan.nodes["read-limit"]?.settled, plan.nodes["read-callers"]?.settled].map(
				(settlement) => settlement !== undefined,
			),
			reducerMayChange: stepWriteAuthority(session, plan.nodes["settled-limit"]?.release?.taskId),
			join: joined && { status: joined.status, scope: joined.scope, blocker: joined.blocker },
			closed: plan.closed?.status,
			retired: plan.retired,
		},
		"both readers settled, the reducer ran read-only on its own worker, its result settled the join, and the plan closed",
	).toEqual({
		readersSettled: [true, true],
		reducerMayChange: { readOnly: true, writePaths: [], editTools: [] },
		join: { status: "succeeded", scope: "join", blocker: "none" },
		closed: "settled",
		retired: [],
	});
	const result = JSON.parse(String(world.io.readFileSync(join!.artifact, "utf8"))) as {
		kind: string;
		members: { nodeId: string; status: string }[];
		gaps: string[];
		conflicts: { kind: string; between: string[]; detail: string }[];
	};
	expect(
		{
			kind: result.kind,
			members: result.members.map((member) => [member.nodeId, member.status]),
			gaps: result.gaps,
			conflicts: result.conflicts,
		},
		"the join's result file names both members and the conflict the host read between their findings",
	).toEqual({
		kind: "reduce",
		members: [
			["read-limit", "succeeded"],
			["read-callers", "succeeded"],
		],
		gaps: [],
		conflicts: judged ? [{ kind: "finding", between: ["read-limit", "read-callers"], detail: CONFLICT }] : [],
	});
	const reached = world.provider.reached.slice(mark);
	expect(
		{
			root: reached.filter((key) => key.startsWith(`${ROOT_TRACK}:`)),
			workers: ["read-limit", "read-callers", "settled-limit"].map(
				(nodeId) => reached.filter((key) => key.startsWith(`${stepTrack(nodeId)}:`)).length,
			),
		},
		"each step asked its model once, and the root was woken once, by the plan's result",
	).toEqual({
		root: [`${ROOT_TRACK}:j5-reduce-call`, `${ROOT_TRACK}:j5-reduce-result`, `${ROOT_TRACK}:j5-reduce-wake`],
		workers: [1, 1, 1],
	});
	expect(
		{
			updates,
			codes: update.filter((line) => line.includes("h PLAN_UPDATE,")),
			result: update.filter((line) => line.startsWith("Result: ")),
			conflicts: update.filter((line) => line.startsWith("Conflict ")),
		},
		"the root's one update names the conflict and tells it to read everything; without a conflict it reads the report",
	).toEqual({
		updates: 1,
		codes: [`h PLAN_UPDATE,PLAN_DONE,${judged ? "READ_ALL" : "READ_REPORT"}`],
		result: ["Result: succeeded; 2 steps combined."],
		conflicts: judged ? [`Conflict (finding) between read-limit and read-callers: ${CONFLICT}`] : [],
	});
	trace.mark("root", "j5.plan-reduce");
}
