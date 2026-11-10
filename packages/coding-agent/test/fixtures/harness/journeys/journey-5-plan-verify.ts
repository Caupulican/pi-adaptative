import "../builtin-install.ts";
import { expect } from "vitest";
import { createBarrier } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, withDeadline } from "../session-fixture.ts";
import {
	CHANGED_FILE_ANSWER_CLAIMS,
	deliveredLines,
	enqueueRoot,
	enqueueStepWorker,
	latestAttemptOf,
	PLAN_CALL_JUDGMENTS,
	planCallSteps,
	planTitled,
	planUpdateStep,
	planUpdatesIn,
	ROOT_TRACK,
	stepRequirementIds,
	stepTaskLines,
	stepTrack,
	stepWriteAuthority,
} from "./journey-5-shared.ts";
import {
	assertCompletionRuleRefusal,
	goalCompletionFacts,
	LIMITS_PATH,
	latestBatchResults,
	requirementIdOf,
} from "./shared.ts";

const TITLE = "Raise the retry limit to 5 and have the change checked";
const CHECK = "grep -n MAX_RETRIES src/limits.ts";

/** What each of the root's actions under a goal is read for with System One on: it moved the work, in scope, and the work goes on. */
const GOAL_STEP_JUDGMENTS = {
	action_accomplished_step: { kind: "noul", probability: 0.02 },
	conclusions_supported: { kind: "noul", probability: 0.97 },
	scope_violation: { kind: "noul", probability: 0.02 },
	unrelated_behavior_change: { kind: "noul", probability: 0.02 },
	replan_required: { kind: "noul", probability: 0.02 },
	next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
} as const;

/** The goal's completion with System One on: what was asked is achieved and proven, and nothing asked is missing. */
const COMPLETION_JUDGMENTS = {
	outcomes_achieved: { kind: "noul", probability: 0.97 },
	required_behavior_unverified: { kind: "noul", probability: 0.02 },
	material_claim_unsupported: { kind: "noul", probability: 0.02 },
	missing_requirement: { kind: "noul", probability: 0.02 },
} as const;

/**
 * Verify, accepted: under a goal with one requirement, a step changes a file for that requirement and a verify step checks
 * it. The verifier is a read-only worker of the verifier role that reconciles no subject: it is given its own task, the
 * step's task as dispatched and the step's report, runs its own check and submits an accepted verdict. The join succeeds with
 * the requirement covered by the verification, the goal gains worker evidence that names the verification, and the changing
 * step's own record is left as it was.
 */
export async function runJourney5PlanVerifyAcceptedPhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	const { session } = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
	const started = createBarrier();
	const done = createBarrier();
	let requirementId = "";
	let updates = 0;
	let update: string[] = [];
	let verifierTask: string[] = [];
	let verificationEvidence: { id: string; kind: string; summary: string }[] = [];
	let factsBeforeCompletion: string | undefined;
	const mark = world.provider.reached.length;
	world.shell.enqueue({
		name: "j5-verify-check",
		command: CHECK,
		cwd: HARNESS_PROJECT_CWD,
		output: "1:export const MAX_RETRIES = 5;\n",
		exitCode: 0,
	});
	enqueueStepWorker(
		world,
		"apply-limit",
		{
			name: "j5-verify-apply-edit",
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j5-verify-apply-edit-1",
						name: "edit",
						arguments: { path: LIMITS_PATH, edits: [{ oldText: "MAX_RETRIES = 3", newText: "MAX_RETRIES = 5" }] },
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j5-verify-apply-report",
			check: (request) => {
				const edit = latestBatchResults(request).find((result) => result.toolName === "edit");
				if (edit?.isError) throw new Error(`the step's edit was refused: ${edit.text}`);
			},
			reply: (request) => {
				const [id] = stepRequirementIds(request);
				return {
					content: [
						{
							type: "toolCall",
							id: "j5-verify-apply-report-1",
							name: "submit_report",
							arguments: {
								status: "completed",
								summary: "Set MAX_RETRIES to 5 in src/limits.ts.",
								requirements: [{ id, status: "met", evidence: ["src/limits.ts"] }],
								changes: [{ file: "src/limits.ts", what: "MAX_RETRIES is 5 instead of 3.", serves: [id] }],
							},
						},
					],
					stopReason: "toolUse",
				};
			},
		},
	);
	enqueueStepWorker(
		world,
		"check-limit",
		{
			name: "j5-verify-check-run",
			check: (request) => {
				verifierTask = stepTaskLines(request);
			},
			reply: {
				content: [{ type: "toolCall", id: "j5-verify-check-run-1", name: "bash", arguments: { command: CHECK } }],
				stopReason: "toolUse",
			},
		},
		{
			name: "j5-verify-check-report",
			check: (request) => {
				const check = latestBatchResults(request).find((result) => result.toolName === "bash");
				if (check?.isError || !check?.text.includes("MAX_RETRIES = 5")) {
					throw new Error(`the verifier's check did not run: ${check?.text ?? "no result"}`);
				}
			},
			reply: (request) => {
				const [id] = stepRequirementIds(request);
				return {
					content: [
						{
							type: "toolCall",
							id: "j5-verify-check-report-1",
							name: "submit_report",
							arguments: {
								status: "completed",
								summary: "src/limits.ts sets MAX_RETRIES to 5, as the step reports.",
								verdict: "accepted",
								reasonCodes: ["limit_is_5"],
								requirements: [{ id, status: "met", evidence: [] }],
								checks: [{ command: CHECK, result: "passed" }],
							},
						},
					],
					stopReason: "toolUse",
				};
			},
		},
	);
	enqueueStepWorker(world, "check-limit", {
		name: "j5-verify-check-followup",
		reply: (request) => {
			const [id] = stepRequirementIds(request);
			const receipt = /^- (c-[0-9a-f]{12}) bash: /m.exec(deliveredLines(request).join("\n"))?.[1] ?? "";
			return {
				content: [
					{
						type: "toolCall",
						id: "j5-verify-check-followup-1",
						name: "submit_report",
						arguments: {
							status: "completed",
							summary: "src/limits.ts sets MAX_RETRIES to 5, as the step reports.",
							verdict: "accepted",
							reasonCodes: ["limit_is_5"],
							requirements: [{ id, status: "met", evidence: [receipt] }],
							checks: [{ command: CHECK, receiptId: receipt, result: "passed" }],
						},
					},
				],
				stopReason: "toolUse",
			};
		},
	});
	enqueueRoot(
		world,
		{
			name: "j5-verify-goal",
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j5-verify-goal-1",
						name: "goal",
						arguments: { action: "start", goalId: "raise-limit", userGoal: "Raise the retry limit to 5." },
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j5-verify-requirement",
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j5-verify-requirement-1",
						name: "goal",
						arguments: { action: "add_requirement", text: "MAX_RETRIES equals 5" },
					},
				],
				stopReason: "toolUse",
			},
		},
		...planCallSteps(
			"j5-verify",
			(request) => {
				requirementId = requirementIdOf(request);
				return {
					action: "start",
					title: TITLE,
					steps: [
						{
							id: "apply-limit",
							do: "In src/limits.ts change MAX_RETRIES from 3 to 5.",
							files: ["src/limits.ts"],
							req: [requirementId],
						},
						{
							id: "check-limit",
							do: "Confirm that src/limits.ts sets MAX_RETRIES to 5 and nothing else changed.",
							join: "verify",
							uses: ["apply-limit"],
							req: [requirementId],
						},
					],
				};
			},
			"PLAN_STARTED",
			() => started.release(),
		),
		// The plan's result wakes the root once. It proves the requirement from the verification and completes the goal.
		{
			...planUpdateStep("j5-verify-wake", "PLAN_DONE", (request) => {
				updates = planUpdatesIn(request);
				update = deliveredLines(request);
			}),
			reply: () => {
				verificationEvidence = (session.getGoalStateSnapshot()?.evidence ?? []).filter(
					(entry) => entry.kind === "worker",
				);
				return {
					content: [
						{
							type: "toolCall",
							id: "j5-verify-satisfy-1",
							name: "goal",
							arguments: {
								action: "satisfy_requirement",
								requirementId,
								evidenceIds: verificationEvidence.map((entry) => entry.id),
							},
						},
					],
					stopReason: "toolUse",
				};
			},
		},
		{
			name: "j5-verify-satisfied",
			check: (request) => {
				const result = latestBatchResults(request).find((entry) => entry.toolName === "goal");
				if (result?.isError) throw new Error(`the requirement was not satisfied: ${result.text}`);
				factsBeforeCompletion = goalCompletionFacts(session);
			},
			reply: {
				content: [
					{ type: "toolCall", id: "j5-verify-complete-1", name: "goal", arguments: { action: "complete" } },
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j5-verify-complete-rule",
			check: (request) =>
				assertCompletionRuleRefusal(request, "J5 verify completion", session, factsBeforeCompletion),
			reply: {
				content: [
					{ type: "toolCall", id: "j5-verify-complete-2", name: "goal", arguments: { action: "complete" } },
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j5-verify-completed",
			check: (request) => {
				const result = latestBatchResults(request).find((entry) => entry.toolName === "goal");
				if (result?.isError) throw new Error(`the goal was not completed: ${result.text}`);
				done.release();
			},
			reply: { content: [{ type: "text", text: "The limit is 5 and the change was checked independently." }] },
		},
	);
	world.systemOne.enterPhase("j5-verify", {
		...PLAN_CALL_JUDGMENTS,
		...GOAL_STEP_JUDGMENTS,
		...CHANGED_FILE_ANSWER_CLAIMS,
		...COMPLETION_JUDGMENTS,
	});
	await withDeadline(
		trace,
		"J5 verify turn",
		session.prompt("Goal: raise the retry limit to 5, and have the change checked independently."),
	);
	await withDeadline(trace, "J5 verify: the plan started", started.promise);
	await withDeadline(trace, "J5 verify: the plan's result woke the root", done.promise, 60_000);
	await withDeadline(trace, "J5 verify: root idle", session.waitForForegroundIdle());
	const plan = planTitled(session, TITLE);
	const snapshot = session.backgroundLanes.getTaskRuntimeSnapshot();
	const subjectTaskId = plan.nodes["apply-limit"]?.release?.taskId;
	const verifierTaskId = plan.nodes["check-limit"]?.release?.taskId;
	const verifier = verifierTaskId === undefined ? undefined : snapshot?.tasks[verifierTaskId];
	const subject = latestAttemptOf(session, subjectTaskId);
	const join = plan.nodes["check-limit"]?.join;
	// An outcome written by a newer build is opaque; this build wrote this one.
	const joined = join && "status" in join.outcome ? join.outcome : undefined;
	const brief = verifierTask.indexOf("Original task as dispatched:");
	expect(
		{
			own: verifierTask.filter((line) => line.startsWith("Task: ")).slice(0, 1),
			proves: verifierTask.filter((line) => line.startsWith("Requirements this step proves: ")).slice(0, 1),
			subject: verifierTask.filter((line) => line.startsWith("Independently verify durable task ")),
			subjectTask: verifierTask.slice(brief + 1).filter((line) => line.startsWith("Task: ")),
			artifacts: verifierTask.slice(verifierTask.indexOf("Reported artifacts:") + 1, -2),
		},
		"the verifier was given its own task, then the step's task as dispatched, its outcome and the file it changed",
	).toEqual({
		own: ["Task: Confirm that src/limits.ts sets MAX_RETRIES to 5 and nothing else changed."],
		proves: [`Requirements this step proves: ${requirementId}`],
		subject: [`Independently verify durable task '${subjectTaskId}', attempt '${subject?.attemptId}'.`],
		subjectTask: ["Task: In src/limits.ts change MAX_RETRIES from 3 to 5."],
		artifacts: ["- src/limits.ts"],
	});
	expect(
		{
			file: world.io.readFileSync(LIMITS_PATH, "utf8"),
			verifierRole: verifier?.task.role,
			reconcilesNoSubject: verifier?.task.verificationOfTaskId === undefined,
			verifierMayChange: stepWriteAuthority(session, verifierTaskId),
			subjectRecord: subject?.verification,
			join: joined && {
				status: joined.status,
				scope: joined.scope,
				blocker: joined.blocker,
				assurance: joined.assurance,
				coverage: joined.coverage,
			},
			closed: plan.closed?.status,
		},
		"the verifier ran read-only as a review of the step, its accepted verdict settled the join, and the step's own record is unchanged",
	).toEqual({
		file: "export const MAX_RETRIES = 5;\n",
		verifierRole: "verifier",
		reconcilesNoSubject: true,
		verifierMayChange: { readOnly: true, writePaths: [], editTools: [] },
		subjectRecord: undefined,
		join: {
			status: "succeeded",
			scope: "join",
			blocker: "none",
			assurance: "independently_verified",
			coverage: {
				required: [requirementId],
				covered: [{ id: requirementId, by: "verification" }],
				uncovered: [],
			},
		},
		closed: "settled",
	});
	const goal = session.getGoalStateSnapshot();
	expect(
		{
			codes: update.filter((line) => line.includes("h PLAN_UPDATE,")),
			result: update.filter((line) => line.startsWith("Result: ") || line.startsWith("Requirements: ")),
			evidence: verificationEvidence.map((entry) => entry.summary.split(".")[0]),
			requirement: goal?.requirements.map((requirement) => [requirement.id, requirement.status]),
			goal: goal?.status,
		},
		"the plan's one update reads as a report, the goal gained evidence of the step's accepted report and of the verification, and the root completed the goal on them",
	).toEqual({
		codes: ["h PLAN_UPDATE,PLAN_DONE,READ_REPORT"],
		result: ["Result: succeeded; 1 steps combined.", `Requirements: ${requirementId} met`],
		evidence: [
			`Worker ${subjectTaskId} covers requirement ${requirementId}: the host accepted its report`,
			`Worker ${verifierTaskId} covers requirement ${requirementId}: independent verification accepted it`,
		],
		requirement: [[requirementId, "satisfied"]],
		goal: "completed",
	});
	const reached = world.provider.reached.slice(mark);
	expect(
		{
			root: reached.filter((key) => key.startsWith(`${ROOT_TRACK}:`)),
			workers: ["apply-limit", "check-limit"].map(
				(nodeId) => reached.filter((key) => key.startsWith(`${stepTrack(nodeId)}:`)).length,
			),
			updates,
		},
		"the step made two requests, the verifier three (its check, its report, the report with the receipt), and the root was woken once",
	).toEqual({
		root: [
			`${ROOT_TRACK}:j5-verify-goal`,
			`${ROOT_TRACK}:j5-verify-requirement`,
			`${ROOT_TRACK}:j5-verify-call`,
			`${ROOT_TRACK}:j5-verify-result`,
			`${ROOT_TRACK}:j5-verify-wake`,
			`${ROOT_TRACK}:j5-verify-satisfied`,
			`${ROOT_TRACK}:j5-verify-complete-rule`,
			`${ROOT_TRACK}:j5-verify-completed`,
		],
		workers: [2, 3],
		updates: 1,
	});
	expect(await world.disposeSessionInBody(session), "the verify owner disposes cleanly").toBeUndefined();
	trace.mark("root", "j5.plan-verify-accepted");
}
