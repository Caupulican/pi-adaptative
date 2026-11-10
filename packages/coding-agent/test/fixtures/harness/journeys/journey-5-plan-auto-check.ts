import "../builtin-install.ts";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { createBarrier, type ScriptStep } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, withDeadline } from "../session-fixture.ts";
import {
	deliveredLines,
	enqueueRoot,
	enqueueStepWorker,
	PLAN_CALL_JUDGMENTS,
	planCallSteps,
	planTitled,
	planUpdateStep,
	ROOT_TRACK,
	reportStep,
	stepTaskLines,
	stepTrack,
} from "./journey-5-shared.ts";
import { latestBatchResults } from "./shared.ts";

const TITLE = "Count the uses of the retry limit and state the count";
const COUNT = "grep -c MAX_RETRIES src/limits.ts";
const ANSWER = "MAX_RETRIES appears once in src/limits.ts.";

/** A worker's plain answer: it declares itself done in text and submits no report. */
function textAnswer(name: string): ScriptStep {
	return { name, reply: { content: [{ type: "text", text: ANSWER }] } };
}

/**
 * A result the host cannot check gets an independent check from the plan. A step runs a command and then answers in text:
 * asked twice for a report, it answers in text both times, so its result stands unverified. No verify step covers it, so the
 * plan settles it, adds a read-only check of it and points the step that used it at that check. The verifier accepts, the
 * dependent step runs on the checked result, and the owner is asked nothing.
 */
export async function runJourney5PlanAutoCheckPhase(world: HarnessWorld, session: AgentSession): Promise<void> {
	const trace = world.trace;
	const started = createBarrier();
	const checked = createBarrier();
	const done = createBarrier();
	let checkUpdate: string[] = [];
	let doneUpdate: string[] = [];
	let dependentTask: string[] = [];
	let verifierTask: string[] = [];
	const mark = world.provider.reached.length;
	for (const name of ["j5-auto-count", "j5-auto-recount"]) {
		world.shell.enqueue({ name, command: COUNT, cwd: HARNESS_PROJECT_CWD, output: "1\n", exitCode: 0 });
	}
	const count: ScriptStep["reply"] = {
		content: [{ type: "toolCall", id: "j5-auto-count-1", name: "bash", arguments: { command: COUNT } }],
		stopReason: "toolUse",
	};
	enqueueStepWorker(
		world,
		"count-uses",
		{ name: "j5-auto-count", reply: count },
		// The step answers in text, and again each of the two times the host asks it for a report it can check.
		textAnswer("j5-auto-answer"),
		textAnswer("j5-auto-answer-asked"),
		textAnswer("j5-auto-answer-asked-again"),
	);
	enqueueStepWorker(
		world,
		"count-uses-check",
		{
			name: "j5-auto-recount",
			check: (request) => {
				verifierTask = stepTaskLines(request);
			},
			reply: {
				content: [{ type: "toolCall", id: "j5-auto-recount-1", name: "bash", arguments: { command: COUNT } }],
				stopReason: "toolUse",
			},
		},
		{
			...reportStep("j5-auto-verdict", {
				status: "completed",
				summary: "The command prints 1: MAX_RETRIES appears once in src/limits.ts, as the step says.",
				verdict: "accepted",
				reasonCodes: ["count_is_1"],
				checks: [{ command: COUNT, result: "passed" }],
			}),
			check: (request) => {
				const recount = latestBatchResults(request).find((result) => result.toolName === "bash");
				if (recount?.isError || recount?.text.trim() !== "1") {
					throw new Error(`the verifier's own count did not run: ${recount?.text ?? "no result"}`);
				}
			},
		},
	);
	enqueueStepWorker(world, "state-count", {
		...reportStep(
			"j5-auto-state",
			{ status: "completed", summary: "The retry limit is used once." },
			// The dependent reports after the root has read the check's result, so the root's two wakes are told apart.
			checked.promise,
		),
		check: (request) => {
			dependentTask = stepTaskLines(request);
		},
	});
	enqueueRoot(
		world,
		...planCallSteps(
			"j5-auto",
			{
				action: "start",
				title: TITLE,
				steps: [
					{
						id: "count-uses",
						do: "Count with a command how many lines of src/limits.ts name MAX_RETRIES, and report the count. Change no file.",
					},
					{
						id: "state-count",
						do: "State in one line how many times the retry limit is used, from the count the earlier step found. Change no file.",
						uses: ["count-uses"],
					},
				],
			},
			"PLAN_STARTED",
			() => started.release(),
		),
		planUpdateStep("j5-auto-checked", "JOIN_DONE", (request) => {
			checkUpdate = deliveredLines(request);
			checked.release();
		}),
		planUpdateStep("j5-auto-wake", "PLAN_DONE", (request) => {
			doneUpdate = deliveredLines(request);
			done.release();
		}),
	);
	world.systemOne.enterPhase("j5-auto", PLAN_CALL_JUDGMENTS);
	await withDeadline(
		trace,
		"J5 auto check turn",
		session.prompt("Count the uses of the retry limit and state the count."),
	);
	await withDeadline(trace, "J5 auto check: the plan started", started.promise);
	await withDeadline(trace, "J5 auto check: the plan's result woke the root", done.promise, 60_000);
	await withDeadline(trace, "J5 auto check: root idle", session.waitForForegroundIdle());
	const plan = planTitled(session, TITLE);
	const record = "title" in plan.record ? plan.record : undefined;
	const snapshot = session.backgroundLanes.getTaskRuntimeSnapshot();
	const stepTaskId = plan.nodes["count-uses"]?.release?.taskId;
	const stored = stepTaskId === undefined ? undefined : snapshot?.tasks[stepTaskId]?.outcome;
	const stepOutcome = stored && "status" in stored ? stored : undefined;
	const join = plan.nodes["count-uses-check"]?.join;
	// An outcome written by a newer build is opaque; this build wrote this one.
	const joined = join && "status" in join.outcome ? join.outcome : undefined;
	expect(
		{
			step: stepOutcome && {
				status: stepOutcome.status,
				blocker: stepOutcome.blocker,
				next: stepOutcome.nextAction.kind,
				exit: stepOutcome.ladder?.exit,
			},
			version: record?.version,
			steps: record?.nodes.map((node) => [node.id, node.kind, node.inputs]),
			final: record?.final,
			check: joined && { status: joined.status, blocker: joined.blocker, assurance: joined.assurance },
			held: Object.entries(plan.nodes).flatMap(([id, node]) => (node.held ? [id] : [])),
			closed: plan.closed?.status,
		},
		"the unverified step settled, the plan added its check and pointed the dependent at it, and the accepted check let the plan finish",
	).toEqual({
		step: { status: "partial", blocker: "unverified_result", next: "verify_independently", exit: "E9b" },
		version: 2,
		steps: [
			["count-uses", "work", []],
			["count-uses-check", "verify", ["count-uses"]],
			["state-count", "work", ["count-uses-check"]],
		],
		final: "state-count",
		check: { status: "succeeded", blocker: "none", assurance: "independently_verified" },
		held: [],
		closed: "settled",
	});
	expect(
		{
			verifier: verifierTask.filter((line) => line.startsWith("Task: ")).slice(0, 1),
			verifies: verifierTask.filter((line) => line.startsWith("Independently verify durable task ")),
			dependent: dependentTask
				.filter((line) => line.startsWith("Input from step "))
				.map((line) => [line.slice("Input from step ".length).split(":")[0], line.includes(" Combined result: ")]),
		},
		"the verifier was told which step to check, and the dependent was given the check's combined result",
	).toEqual({
		verifier: [
			"Task: Independently verify step count-uses: Count with a command how many lines of src/limits.ts name MAX_RETRIES, and report the count. Change no file.",
		],
		verifies: [
			`Independently verify durable task '${stepTaskId}', attempt '${stepOutcome?.attempts.at(-1)?.attemptId}'.`,
		],
		dependent: [["count-uses-check", true]],
	});
	const reached = world.provider.reached.slice(mark);
	expect(
		{
			root: reached.filter((key) => key.startsWith(`${ROOT_TRACK}:`)),
			workers: ["count-uses", "count-uses-check", "state-count"].map(
				(nodeId) => reached.filter((key) => key.startsWith(`${stepTrack(nodeId)}:`)).length,
			),
			updates: [checkUpdate, doneUpdate].map((lines) => lines.filter((line) => line.includes("h PLAN_UPDATE,"))),
			result: doneUpdate.filter((line) => line.startsWith("Result: ")),
			report: doneUpdate.filter((line) => line.startsWith("Report: ")).length,
		},
		"the step was asked twice for a report, and the root was woken by the check's result and by the plan's, never for the owner",
	).toEqual({
		root: [
			`${ROOT_TRACK}:j5-auto-call`,
			`${ROOT_TRACK}:j5-auto-result`,
			`${ROOT_TRACK}:j5-auto-checked`,
			`${ROOT_TRACK}:j5-auto-wake`,
		],
		workers: [4, 2, 1],
		updates: [["h PLAN_UPDATE,JOIN_DONE,READ_REPORT"], ["h PLAN_UPDATE,PLAN_DONE,READ_REPORT"]],
		// The plan finished on a plain step: its update carries that step's outcome and a reference to its report.
		result: ["Result: Outcome: succeeded (blocker: none; requirements met: 0 of 0; assurance: host_verified)"],
		report: 1,
	});
	trace.mark("root", "j5.plan-auto-check");
}
