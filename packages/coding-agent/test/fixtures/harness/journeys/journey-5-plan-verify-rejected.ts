import "../builtin-install.ts";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { createBarrier, type ScriptStep } from "../scripted-provider.ts";
import { type HarnessWorld, projectPath, withDeadline } from "../session-fixture.ts";
import {
	CHANGED_FILE_ANSWER_CLAIMS,
	deliveredLines,
	enqueueRoot,
	enqueueStepWorker,
	PLAN_CALL_JUDGMENTS,
	planCallSteps,
	planTitled,
	planUpdateStep,
	ROOT_TRACK,
	reportStep,
	stepTrack,
} from "./journey-5-shared.ts";
import { latestBatchResults } from "./shared.ts";

/** The file this phase changes; the journey's world holds it beside the limits module. */
export const TIMEOUTS_PATH = projectPath("src", "timeouts.ts");
export const ORIGINAL_TIMEOUTS = "export const TIMEOUT_MS = 1000;\n";

const TITLE = "Set the request timeout to 3000 and have the change checked";
const REJECTION = "timeout_is_2000_not_3000";
const HOLD = `independent verification rejected the result (${REJECTION}); change the step it checked, then it is verified again`;

/** A step's worker: one edit of the timeouts file, then a report of the change. */
function editThenReport(name: string, oldText: string, newText: string, summary: string): ScriptStep[] {
	return [
		{
			name: `${name}-edit`,
			reply: {
				content: [
					{
						type: "toolCall",
						id: `${name}-edit-1`,
						name: "edit",
						arguments: { path: TIMEOUTS_PATH, edits: [{ oldText, newText }] },
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			...reportStep(`${name}-report`, {
				status: "completed",
				summary,
				changes: [{ file: "src/timeouts.ts", what: summary }],
			}),
			check: (request) => {
				const edit = latestBatchResults(request).find((result) => result.toolName === "edit");
				if (edit?.isError) throw new Error(`the step's edit was refused: ${edit.text}`);
			},
		},
	];
}

/**
 * Verify, rejected, then revised. A step sets the wrong value, and the verify step over it rejects the result with a reason
 * code. The verify step is held for re-planning with the rejection's words, the step that depends on it is not released, the
 * verifier is not run again, and the root is told once. The root restates the step: the step and its verify step run again,
 * the second review accepts, and the dependent step runs.
 */
export async function runJourney5PlanVerifyRejectedPhase(world: HarnessWorld, session: AgentSession): Promise<void> {
	const trace = world.trace;
	const started = createBarrier();
	const rejected = createBarrier();
	const revised = createBarrier();
	const accepted = createBarrier();
	const done = createBarrier();
	let replanUpdate: string[] = [];
	let heldState: unknown;
	const mark = world.provider.reached.length;
	const setTimeoutStep = (text: string) => ({
		id: "set-timeout",
		do: text,
		files: ["src/timeouts.ts"],
		proof: "diff",
	});
	enqueueStepWorker(
		world,
		"set-timeout",
		...editThenReport("j5-reject-first", "TIMEOUT_MS = 1000", "TIMEOUT_MS = 2000", "TIMEOUT_MS is 2000."),
		...editThenReport("j5-reject-second", "TIMEOUT_MS = 2000", "TIMEOUT_MS = 3000", "TIMEOUT_MS is 3000."),
	);
	enqueueStepWorker(
		world,
		"check-timeout",
		reportStep("j5-reject-verdict", {
			status: "completed",
			summary: "src/timeouts.ts sets TIMEOUT_MS to 2000; the task asked for 3000.",
			verdict: "rejected",
			reasonCodes: [REJECTION],
		}),
		reportStep("j5-reject-reverdict", {
			status: "completed",
			summary: "src/timeouts.ts sets TIMEOUT_MS to 3000, as the task asked.",
			verdict: "accepted",
			reasonCodes: ["timeout_is_3000"],
		}),
	);
	enqueueStepWorker(
		world,
		"announce-timeout",
		reportStep(
			"j5-reject-announce",
			{ status: "completed", summary: "The request timeout is now 3000 ms." },
			// The dependent reports after the root has read the accepted check, so the root's wakes are told apart.
			accepted.promise,
		),
	);
	const snapshotOf = () => {
		const plan = planTitled(session, TITLE);
		const tasks = session.backgroundLanes.getTaskRuntimeSnapshot()?.tasks ?? {};
		const verifierTaskId = plan.nodes["check-timeout"]?.release?.taskId;
		return {
			version: "title" in plan.record ? plan.record.version : undefined,
			held: plan.nodes["check-timeout"]?.held && {
				reason: plan.nodes["check-timeout"].held.reason,
				detail: plan.nodes["check-timeout"].held.detail,
			},
			checkSettled: plan.nodes["check-timeout"]?.join !== undefined,
			dependentReleased: plan.nodes["announce-timeout"]?.release !== undefined,
			verifierAttempts: verifierTaskId === undefined ? undefined : tasks[verifierTaskId]?.attemptIds.length,
			stepTaskId: plan.nodes["set-timeout"]?.release?.taskId,
			verifierTaskId,
		};
	};
	let before: ReturnType<typeof snapshotOf> | undefined;
	enqueueRoot(
		world,
		...planCallSteps(
			"j5-reject",
			{
				action: "start",
				title: TITLE,
				final: "announce-timeout",
				steps: [
					setTimeoutStep("In src/timeouts.ts set TIMEOUT_MS to 3000."),
					{
						id: "check-timeout",
						do: "Confirm that src/timeouts.ts sets TIMEOUT_MS to 3000.",
						join: "verify",
						uses: ["set-timeout"],
					},
					{
						id: "announce-timeout",
						do: "State the new request timeout in one line, from the checked change. Change no file.",
						uses: ["check-timeout"],
					},
				],
			},
			"PLAN_STARTED",
			() => started.release(),
		),
		// The rejection wakes the root once; it restates the step in that turn.
		{
			...planUpdateStep("j5-reject-replan", "REPLAN", (request) => {
				replanUpdate = deliveredLines(request);
				before = snapshotOf();
				heldState = { file: world.io.readFileSync(TIMEOUTS_PATH, "utf8") };
				rejected.release();
			}),
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j5-reject-revise-1",
						name: "plan",
						arguments: {
							action: "revise",
							reason: "The check found 2000; the step must set 3000.",
							steps: [
								setTimeoutStep("In src/timeouts.ts set TIMEOUT_MS to 3000; it is 2000 now, which is wrong."),
							],
						},
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j5-reject-revised",
			check: (request) => {
				const result = latestBatchResults(request).find((entry) => entry.toolName === "plan");
				if (result?.isError || !result?.text.includes("PLAN_UPDATE")) {
					throw new Error(`the revise was not accepted: ${result?.text ?? "no result"}`);
				}
				revised.release();
			},
			reply: { content: [{ type: "text", text: "The step is restated; it and its check run again." }] },
		},
		planUpdateStep("j5-reject-accepted", "JOIN_DONE", () => accepted.release()),
		planUpdateStep("j5-reject-wake", "PLAN_DONE", () => done.release()),
	);
	world.systemOne.enterPhase("j5-reject", { ...PLAN_CALL_JUDGMENTS, ...CHANGED_FILE_ANSWER_CLAIMS });
	await withDeadline(
		trace,
		"J5 reject turn",
		session.prompt("Set the request timeout to 3000 and have the change checked."),
	);
	await withDeadline(trace, "J5 reject: the plan started", started.promise);
	await withDeadline(trace, "J5 reject: the rejection woke the root", rejected.promise, 60_000);
	await withDeadline(trace, "J5 reject: the root restated the step", revised.promise, 60_000);
	await withDeadline(trace, "J5 reject: the plan's result woke the root", done.promise, 60_000);
	await withDeadline(trace, "J5 reject: root idle", session.waitForForegroundIdle());
	expect(
		{
			state: before && {
				version: before.version,
				held: before.held,
				checkSettled: before.checkSettled,
				dependentReleased: before.dependentReleased,
				verifierAttempts: before.verifierAttempts,
			},
			file: heldState,
			codes: replanUpdate.filter((line) => line.includes("h PLAN_UPDATE,")),
			words: replanUpdate.filter((line) => line.startsWith("independent verification rejected")),
		},
		"a rejected review holds the verify step for re-planning with its reason, releases nothing after it, and tells the root once",
	).toEqual({
		state: {
			version: 1,
			held: { reason: "replan", detail: HOLD },
			checkSettled: false,
			dependentReleased: false,
			verifierAttempts: 1,
		},
		file: { file: "export const TIMEOUT_MS = 2000;\n" },
		codes: ["h PLAN_UPDATE,REPLAN,READ_ALL"],
		words: [HOLD],
	});
	const after = snapshotOf();
	const plan = planTitled(session, TITLE);
	const join = plan.nodes["check-timeout"]?.join;
	// An outcome written by a newer build is opaque; this build wrote this one.
	const joined = join && "status" in join.outcome ? join.outcome : undefined;
	expect(
		{
			version: after.version,
			stepRanAgain: after.stepTaskId !== undefined && after.stepTaskId !== before?.stepTaskId,
			checkRanAgain: after.verifierTaskId !== undefined && after.verifierTaskId !== before?.verifierTaskId,
			retired: plan.retired.map((entry) => [entry.nodeId, entry.taskId === before?.verifierTaskId, entry.reason]),
			held: after.held,
			check: joined && { status: joined.status, blocker: joined.blocker, assurance: joined.assurance },
			dependentReleased: after.dependentReleased,
			file: world.io.readFileSync(TIMEOUTS_PATH, "utf8"),
			closed: plan.closed?.status,
		},
		"the restated step and its verify step ran again on new workers, the second review accepted, and the dependent ran",
	).toEqual({
		version: 2,
		stepRanAgain: true,
		checkRanAgain: true,
		retired: [["check-timeout", true, "superseded"]],
		held: undefined,
		check: { status: "succeeded", blocker: "none", assurance: "independently_verified" },
		dependentReleased: true,
		file: "export const TIMEOUT_MS = 3000;\n",
		closed: "settled",
	});
	const reached = world.provider.reached.slice(mark);
	expect(
		{
			root: reached.filter((key) => key.startsWith(`${ROOT_TRACK}:`)),
			workers: ["set-timeout", "check-timeout", "announce-timeout"].map(
				(nodeId) => reached.filter((key) => key.startsWith(`${stepTrack(nodeId)}:`)).length,
			),
		},
		"the root was woken by the rejection, by the accepted check and by the plan's result; each verifier reported once",
	).toEqual({
		root: [
			`${ROOT_TRACK}:j5-reject-call`,
			`${ROOT_TRACK}:j5-reject-result`,
			`${ROOT_TRACK}:j5-reject-replan`,
			`${ROOT_TRACK}:j5-reject-revised`,
			`${ROOT_TRACK}:j5-reject-accepted`,
			`${ROOT_TRACK}:j5-reject-wake`,
		],
		workers: [4, 2, 1],
	});
	trace.mark("root", "j5.plan-verify-rejected");
}
