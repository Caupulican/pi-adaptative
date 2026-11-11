import "../builtin-install.ts";
import { join } from "node:path";
import type { SimpleStreamOptions } from "@caupulican/pi-ai";
import { expect } from "vitest";
import type { Outcome } from "../../../../src/core/delegation/worker-outcome.ts";
import { subscribeOutcomes } from "../../../../src/core/delegation/worker-outcome.ts";
import { createGoalState, type GoalState } from "../../../../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot } from "../../../../src/core/goals/session-goal-state.ts";
import { createBarrier, HARNESS_PROVIDER, type ScriptedRequest } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { ORIGINAL_TIMEOUTS, TIMEOUTS_PATH } from "./journey-5-plan-verify-rejected.ts";
import { CHANGED_FILE_ANSWER_CLAIMS } from "./journey-5-shared.ts";
import {
	carriesTask,
	delegateStart,
	handoffBlocks,
	J9_ROOT_JUDGMENTS,
	recordedOutcome,
	scriptRequirementCheckSpawn,
} from "./journey-9-shared.ts";
import { LIMITS_PATH, latestBatchResults, ORIGINAL_LIMITS } from "./shared.ts";

const X2_PROMPT = "Start a worktree writer to update both limits and timeouts.";
const X2_TASK = "Update MAX_RETRIES in src/limits.ts and TIMEOUT_MS in src/timeouts.ts inside a worktree lane.";
const REQ_A1 = "j9-wt-a1";
const REQ_A2 = "j9-wt-a2";

const X1_PROMPT = "Start a worktree writer to cover the limits and timeouts requirements.";
const X1_TASK = "Ensure MAX_RETRIES in src/limits.ts and TIMEOUT_MS in src/timeouts.ts satisfy both requirements.";
const REQ_B1 = "j9-wt-b1";
const REQ_B2 = "j9-wt-b2";
const CHECK_B1 = "rg 'MAX_RETRIES = 3' src/limits.ts";
const CHECK_B2 = "rg 'TIMEOUT_MS = 2000' src/timeouts.ts";

const PARTIAL_NOTE = "Only MAX_RETRIES was adjusted in this pass; TIMEOUT_MS remains untouched.";
const NOW = "2026-10-08T00:00:00.000Z";

function requestReasoning(request: ScriptedRequest): NonNullable<SimpleStreamOptions["reasoning"]> | "off" {
	return (request.options as SimpleStreamOptions | undefined)?.reasoning ?? "off";
}

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
 * Leg 6: worktree-lane escalation placement:
 * - Case A (`X2`, `attemptOfTaskId` + `reuseOriginLane`): a writing worker in an isolated worktree lane edits
 *   `src/limits.ts` (`REQ_A1`) and reports `REQ_A2` partial -> unaccepted (`task.status === "blocked"`, `X2`) -> `E14`
 *   places Rung 1 on the **same** task inside the **same** `originCwd` worktree lane, where Attempt 2 reads Attempt 1's
 *   unlanded `MAX_RETRIES = 5` edit in place and finishes `src/timeouts.ts` (`REQ_A2`) while `HARNESS_PROJECT_CWD` stays untouched.
 * - Case B (`X1`, `supersedesTaskId` + `freshLane`): a writing worker in a clean worktree lane completes (`accepted: true`,
 *   `task.status === "completed"`, `X1`), `E12` proves `REQ_B1` and fails `REQ_B2`, and `E14` spawns a `supersedesTaskId`
 *   rerun in a **fresh** worktree lane carrying the full `origin.requirementIds` (`[REQ_B1, REQ_B2]`) and omitting prior
 *   abandoned-lane coverage notes.
 */
export async function runJourney9WorktreeRerunPhase(world: HarnessWorld): Promise<void> {
	await runSameWorktreeLaneAttemptRerunSubleg(world);
	await runFreshWorktreeLaneSupersedesRerunSubleg(world);
}

async function runSameWorktreeLaneAttemptRerunSubleg(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	const settled = createBarrier();
	const reported = createBarrier();
	const recorded: Outcome[] = [];
	let attempt2ReadLimits = "";
	world.setModelReasoning("worker-a", true);
	const sessionManager = world.createSessionManager();
	appendGoalStateSnapshot(sessionManager, x2Goal());
	const unsubscribe = subscribeOutcomes((outcome) => {
		if (!outcome.coverage.required.some((id) => id === REQ_A1 || id === REQ_A2)) return;
		recorded.push(outcome);
		if (outcome.nextAction.kind !== "rerun_uncovered" && outcome.nextAction.kind !== "host_check") {
			settled.release();
		}
	});
	world.provider.enqueue(
		"root",
		{
			name: "j9-l6-x2-start",
			reply: {
				content: [
					delegateStart("j9-l6-x2-call", {
						model: { provider: HARNESS_PROVIDER, modelId: "worker-a" },
						thinkingLevel: "off",
						writePaths: ["src/limits.ts", "src/timeouts.ts"],
						instructions: X2_TASK,
						requirementIds: [REQ_A1, REQ_A2],
					}),
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j9-l6-x2-reply",
			check: (request) => {
				const started = latestBatchResults(request).find((result) => result.toolName === "delegate");
				if (started?.isError || !started?.text.includes("delegate started (running)")) {
					throw new Error(`the X2 worktree writer did not start: ${started?.text ?? "no result"}`);
				}
			},
			reply: { content: [{ type: "text", text: "Noted." }] },
		},
		{
			name: "j9-l6-x2-handoff",
			maxRequests: 12,
			until: (request) => {
				const done = handoffBlocks(request).some(
					(block) => block.outcome.includes(`covered: ${REQ_A2}`) && !block.outcome.includes("uncovered:"),
				);
				if (!done) return false;
				reported.release();
				return true;
			},
			reply: { content: [{ type: "text", text: "Noted." }] },
		},
	);
	world.provider.enqueueTrack(
		"j9-l6-x2-a",
		"worker-a",
		carriesTask(X2_TASK),
		{
			name: "j9-l6-x2-a1-edit",
			check: (request) => {
				expect(requestReasoning(request), "X2 attempt 1 starts at thinking off").toBe("off");
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j9-l6-x2-a1-edit-call",
						name: "edit",
						arguments: {
							path: "src/limits.ts",
							edits: [{ oldText: "MAX_RETRIES = 3", newText: "MAX_RETRIES = 5" }],
						},
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j9-l6-x2-a1-report",
			check: (request) => {
				const edit = latestBatchResults(request).find((entry) => entry.toolName === "edit");
				if (edit?.isError) throw new Error(`X2 attempt 1 edit failed: ${edit.text}`);
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j9-l6-x2-a1-report-call",
						name: "submit_report",
						arguments: {
							status: "completed",
							summary: "Updated MAX_RETRIES in src/limits.ts inside the worktree lane.",
							changes: [{ file: "src/limits.ts", what: "Set MAX_RETRIES to 5." }],
							requirements: [
								{ id: REQ_A1, status: "met", evidence: ["src/limits.ts"] },
								{ id: REQ_A2, status: "partial", note: PARTIAL_NOTE },
							],
						},
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j9-l6-x2-a2-read",
			check: (request) => {
				expect(requestReasoning(request), "X2 rung 1 raises thinking from off to minimal").toBe("minimal");
				const promptText = JSON.stringify(request.context.messages);
				expect(promptText, "in-place lane rerun carries prior coverage context").toContain(
					`Already met, do not redo: ${REQ_A1}`,
				);
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j9-l6-x2-a2-read-call",
						name: "read",
						arguments: { path: "src/limits.ts" },
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j9-l6-x2-a2-edit",
			check: (request) => {
				const read = latestBatchResults(request).find((entry) => entry.toolName === "read");
				if (read?.isError) throw new Error(`X2 attempt 2 read failed: ${read.text}`);
				attempt2ReadLimits = read?.text ?? "";
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j9-l6-x2-a2-edit-call",
						name: "edit",
						arguments: {
							path: "src/timeouts.ts",
							edits: [{ oldText: "TIMEOUT_MS = 1000", newText: "TIMEOUT_MS = 2000" }],
						},
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j9-l6-x2-a2-report",
			check: (request) => {
				const edit = latestBatchResults(request).find((entry) => entry.toolName === "edit");
				if (edit?.isError) throw new Error(`X2 attempt 2 edit failed: ${edit.text}`);
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j9-l6-x2-a2-report-call",
						name: "submit_report",
						arguments: {
							status: "completed",
							summary: "Updated TIMEOUT_MS in src/timeouts.ts inside the reused worktree lane.",
							changes: [{ file: "src/timeouts.ts", what: "Set TIMEOUT_MS to 2000." }],
							requirements: [{ id: REQ_A2, status: "met", evidence: ["src/timeouts.ts"] }],
						},
					},
				],
				stopReason: "toolUse",
			},
		},
	);
	world.systemOne.enterPhase("j9-l6-x2", {
		...J9_ROOT_JUDGMENTS,
		...GOAL_STEP_JUDGMENTS,
		...CHANGED_FILE_ANSWER_CLAIMS,
	});
	try {
		const { session } = await world.createRootSession("root", {
			sessionManager,
			settings: {
				worktreeSync: { enabled: true },
				autonomy: { goalAutoContinue: false },
				workerDelegation: {
					outcomes: { escalation: { enabled: true, maxRungs: 2 } },
				},
			},
		});
		await withDeadline(trace, "J9 leg 6 X2 turn", session.prompt(X2_PROMPT));
		await withDeadline(trace, "J9 leg 6 X2 settled", settled.promise);
		await withDeadline(trace, "J9 leg 6 X2 handoff", reported.promise);
		await withDeadline(trace, "J9 leg 6 X2 idle", session.waitForForegroundIdle());

		const snapshot = session.backgroundLanes.getTaskRuntimeSnapshot();
		const matchingTasks = Object.values(snapshot?.tasks ?? {}).filter((entry) =>
			entry.attemptIds.some((attemptId) => snapshot?.attempts[attemptId]?.dispatch.instructions.includes(X2_TASK)),
		);
		expect(matchingTasks.length, "X2 attemptOfTaskId keeps a single task record rather than superseding").toBe(1);
		const taskState = matchingTasks[0]!;
		const [attempt1Id, attempt2Id] = taskState.attemptIds;
		const attempt1 = attempt1Id ? snapshot?.attempts[attempt1Id] : undefined;
		const attempt2 = attempt2Id ? snapshot?.attempts[attempt2Id] : undefined;
		const lane1Cwd = attempt1?.dispatch.executionContract?.worker.authority.cwd;
		const lane2Cwd = attempt2?.dispatch.executionContract?.worker.authority.cwd;
		if (!lane1Cwd || !lane2Cwd) throw new Error("expected worktree lane cwds on both X2 attempts");

		const final = recordedOutcome(session, taskState.task.taskId);
		expect(
			{
				exits: recorded.map((outcome) => outcome.ladder.exit),
				attemptCount: taskState.attemptIds.length,
				sameLaneCwd: lane1Cwd === lane2Cwd,
				isolatedFromBase: lane1Cwd !== HARNESS_PROJECT_CWD,
				attempt2SawAttempt1Edit: attempt2ReadLimits.includes("MAX_RETRIES = 5"),
				attempt2RequirementIds: attempt2?.dispatch.requirementIds,
				escalationTaskId: taskState.escalations?.[0]?.taskId,
				escalationSupersedes: taskState.escalations?.[0]?.supersedesTaskId,
				laneFiles: [
					world.io.readFileSync(join(lane1Cwd, "src/limits.ts"), "utf8"),
					world.io.readFileSync(join(lane1Cwd, "src/timeouts.ts"), "utf8"),
				],
				baseFiles: [world.io.readFileSync(LIMITS_PATH, "utf8"), world.io.readFileSync(TIMEOUTS_PATH, "utf8")],
				finalUncovered: final.coverage.uncovered,
			},
			"Case A (X2): unaccepted worktree writer reruns as attemptOfTaskId in the SAME worktree lane, preserving Attempt 1's partial edit in place while base checkout stays clean",
		).toEqual({
			exits: ["E14", "E9b"],
			attemptCount: 2,
			sameLaneCwd: true,
			isolatedFromBase: true,
			attempt2SawAttempt1Edit: true,
			attempt2RequirementIds: [REQ_A2],
			escalationTaskId: taskState.task.taskId,
			escalationSupersedes: undefined,
			laneFiles: ["export const MAX_RETRIES = 5;\n", "export const TIMEOUT_MS = 2000;\n"],
			baseFiles: [ORIGINAL_LIMITS, ORIGINAL_TIMEOUTS],
			finalUncovered: [],
		});

		expect(await world.disposeSessionInBody(session), "the leg 6 X2 session disposes cleanly").toBeUndefined();
		trace.mark("root", "j9.worktree-rerun-x2");
	} finally {
		unsubscribe();
		world.setModelReasoning("worker-a", false);
	}
}

async function runFreshWorktreeLaneSupersedesRerunSubleg(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	const settled = createBarrier();
	const reported = createBarrier();
	const recorded: Outcome[] = [];
	world.setModelReasoning("worker-a", true);
	const sessionManager = world.createSessionManager();
	appendGoalStateSnapshot(sessionManager, x1Goal());
	const unsubscribe = subscribeOutcomes((outcome) => {
		if (!outcome.coverage.required.some((id) => id === REQ_B1 || id === REQ_B2)) return;
		recorded.push(outcome);
		if (outcome.nextAction.kind !== "rerun_uncovered" && outcome.nextAction.kind !== "host_check") {
			settled.release();
		}
	});
	const scriptedChecks = scriptRequirementCheckSpawn(world, CHECK_B1, CHECK_B2);
	world.shell.enqueue(
		{
			name: "j9-l6-x1-e12-b1",
			command: CHECK_B1,
			output: "export const MAX_RETRIES = 3;\n",
			exitCode: 0,
		},
		{
			name: "j9-l6-x1-e12-b2",
			command: CHECK_B2,
			output: "",
			exitCode: 1,
		},
	);
	world.provider.enqueue(
		"root",
		{
			name: "j9-l6-x1-start",
			reply: {
				content: [
					delegateStart("j9-l6-x1-call", {
						model: { provider: HARNESS_PROVIDER, modelId: "worker-a" },
						thinkingLevel: "off",
						writePaths: ["src/limits.ts", "src/timeouts.ts"],
						instructions: X1_TASK,
						requirementIds: [REQ_B1, REQ_B2],
					}),
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j9-l6-x1-reply",
			check: (request) => {
				const started = latestBatchResults(request).find((result) => result.toolName === "delegate");
				if (started?.isError || !started?.text.includes("delegate started (running)")) {
					throw new Error(`the X1 worktree writer did not start: ${started?.text ?? "no result"}`);
				}
			},
			reply: { content: [{ type: "text", text: "Noted." }] },
		},
		{
			name: "j9-l6-x1-handoff",
			maxRequests: 12,
			until: (request) => {
				const done = handoffBlocks(request).some(
					(block) =>
						block.outcome.includes(`covered: ${REQ_B1}, ${REQ_B2}`) && !block.outcome.includes("uncovered:"),
				);
				if (!done) return false;
				reported.release();
				return true;
			},
			reply: { content: [{ type: "text", text: "Noted." }] },
		},
	);
	world.provider.enqueueTrack(
		"j9-l6-x1-a",
		"worker-a",
		carriesTask(X1_TASK),
		{
			name: "j9-l6-x1-b1-report",
			check: (request) => {
				expect(requestReasoning(request), "X1 task 1 starts at thinking off").toBe("off");
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j9-l6-x1-b1-report-call",
						name: "submit_report",
						arguments: {
							status: "completed",
							summary:
								"Inspected src/limits.ts and src/timeouts.ts in the initial worktree lane; no write seemed needed.",
							requirements: [
								{
									id: REQ_B1,
									status: "not_applicable",
									note: "MAX_RETRIES already read as 3 in this worktree checkout.",
								},
								{
									id: REQ_B2,
									status: "not_applicable",
									note: "Assumed default TIMEOUT_MS already matched retry behavior.",
								},
							],
						},
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j9-l6-x1-b2-edit-limits",
			check: (request) => {
				expect(requestReasoning(request), "X1 rung 1 raises thinking from off to minimal").toBe("minimal");
				const promptText = JSON.stringify(request.context.messages);
				expect(
					promptText,
					"fresh worktree lane omits prior-lane coverage so the fresh checkout satisfies the full requirement set",
				).not.toContain("Already met, do not redo");
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j9-l6-x1-b2-edit-limits-call",
						name: "edit",
						arguments: {
							path: "src/limits.ts",
							edits: [{ oldText: "MAX_RETRIES = 3", newText: "MAX_RETRIES = 5" }],
						},
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j9-l6-x1-b2-edit-timeouts",
			check: (request) => {
				const edit = latestBatchResults(request).find((entry) => entry.toolName === "edit");
				if (edit?.isError) throw new Error(`X1 fresh-lane limits edit failed: ${edit.text}`);
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j9-l6-x1-b2-edit-timeouts-call",
						name: "edit",
						arguments: {
							path: "src/timeouts.ts",
							edits: [{ oldText: "TIMEOUT_MS = 1000", newText: "TIMEOUT_MS = 2000" }],
						},
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j9-l6-x1-b2-report",
			check: (request) => {
				const edit = latestBatchResults(request).find((entry) => entry.toolName === "edit");
				if (edit?.isError) throw new Error(`X1 fresh-lane timeouts edit failed: ${edit.text}`);
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j9-l6-x1-b2-report-call",
						name: "submit_report",
						arguments: {
							status: "completed",
							summary: "Updated src/limits.ts and src/timeouts.ts in the fresh worktree lane.",
							changes: [
								{ file: "src/limits.ts", what: "Set MAX_RETRIES to 5." },
								{ file: "src/timeouts.ts", what: "Set TIMEOUT_MS to 2000." },
							],
							requirements: [
								{ id: REQ_B1, status: "met", evidence: ["src/limits.ts"] },
								{ id: REQ_B2, status: "met", evidence: ["src/timeouts.ts"] },
							],
						},
					},
				],
				stopReason: "toolUse",
			},
		},
	);
	world.systemOne.enterPhase("j9-l6-x1", {
		...J9_ROOT_JUDGMENTS,
		...GOAL_STEP_JUDGMENTS,
		...CHANGED_FILE_ANSWER_CLAIMS,
	});
	try {
		const { session } = await world.createRootSession("root", {
			sessionManager,
			settings: {
				worktreeSync: { enabled: true },
				autonomy: { goalAutoContinue: false },
				workerDelegation: {
					outcomes: { escalation: { enabled: true, maxRungs: 2 } },
				},
			},
		});
		await withDeadline(trace, "J9 leg 6 X1 turn", session.prompt(X1_PROMPT));
		await withDeadline(trace, "J9 leg 6 X1 settled", settled.promise);
		await withDeadline(trace, "J9 leg 6 X1 handoff", reported.promise);
		await withDeadline(trace, "J9 leg 6 X1 idle", session.waitForForegroundIdle());

		const snapshot = session.backgroundLanes.getTaskRuntimeSnapshot();
		const tasks = Object.values(snapshot?.tasks ?? {}).filter((entry) =>
			entry.attemptIds.some((attemptId) => snapshot?.attempts[attemptId]?.dispatch.instructions.includes(X1_TASK)),
		);
		expect(tasks.length, "X1 completed writer spawns a new supersedesTaskId successor task").toBe(2);
		const originTask = tasks.find((entry) => entry.escalations?.[0]?.supersedesTaskId === entry.task.taskId);
		const successorTask = tasks.find(
			(entry) =>
				entry.escalations?.[0]?.taskId === entry.task.taskId &&
				entry.escalations?.[0]?.supersedesTaskId !== undefined,
		);
		if (!originTask || !successorTask) {
			throw new Error(`expected origin and successor X1 tasks, got: ${JSON.stringify(tasks.map((t) => t.task))}`);
		}
		const originAttempt = snapshot?.attempts[originTask.attemptIds[0]!];
		const successorAttempt = snapshot?.attempts[successorTask.attemptIds[0]!];
		const laneB1Cwd = originAttempt?.dispatch.executionContract?.worker.authority.cwd;
		const laneB2Cwd = successorAttempt?.dispatch.executionContract?.worker.authority.cwd;
		if (!laneB1Cwd || !laneB2Cwd) throw new Error("expected worktree lane cwds on both X1 tasks");

		expect(
			{
				exits: recorded.map((outcome) => outcome.ladder.exit),
				originTaskStatus: originTask.task.status,
				escalationTargetTaskId: originTask.escalations?.[0]?.taskId,
				escalationSupersedes: originTask.escalations?.[0]?.supersedesTaskId,
				successorInheritedSupersedes: successorTask.escalations?.[0]?.supersedesTaskId,
				e14ActionRequirements:
					recorded[1]?.nextAction.kind === "rerun_uncovered" ? recorded[1].nextAction.requirementIds : undefined,
				successorRequirementIds: successorAttempt?.dispatch.requirementIds,
				distinctWorktreeLanes: laneB2Cwd !== laneB1Cwd,
				bothIsolatedFromBase: laneB1Cwd !== HARNESS_PROJECT_CWD && laneB2Cwd !== HARNESS_PROJECT_CWD,
				e12RanInOriginLane: world.shell.requests
					.filter((request) => request.command === CHECK_B1 || request.command === CHECK_B2)
					.map((request) => request.cwd),
				successorLaneFiles: [
					world.io.readFileSync(join(laneB2Cwd, "src/limits.ts"), "utf8"),
					world.io.readFileSync(join(laneB2Cwd, "src/timeouts.ts"), "utf8"),
				],
				baseFiles: [world.io.readFileSync(LIMITS_PATH, "utf8"), world.io.readFileSync(TIMEOUTS_PATH, "utf8")],
			},
			"Case B (X1): completed worktree writer spawns supersedesTaskId in a FRESH worktree lane carrying the full origin.requirementIds while base checkout stays clean",
		).toEqual({
			exits: ["E12", "E14", "E9b"],
			originTaskStatus: "completed",
			escalationTargetTaskId: successorTask.task.taskId,
			escalationSupersedes: originTask.task.taskId,
			successorInheritedSupersedes: originTask.task.taskId,
			e14ActionRequirements: [REQ_B2],
			successorRequirementIds: [REQ_B1, REQ_B2],
			distinctWorktreeLanes: true,
			bothIsolatedFromBase: true,
			e12RanInOriginLane: [laneB1Cwd, laneB1Cwd],
			successorLaneFiles: ["export const MAX_RETRIES = 5;\n", "export const TIMEOUT_MS = 2000;\n"],
			baseFiles: [ORIGINAL_LIMITS, ORIGINAL_TIMEOUTS],
		});

		expect(await world.disposeSessionInBody(session), "the leg 6 X1 session disposes cleanly").toBeUndefined();
		trace.mark("root", "j9.worktree-rerun-x1");
	} finally {
		scriptedChecks.restore();
		unsubscribe();
		world.setModelReasoning("worker-a", false);
	}
}

function x2Goal(): GoalState {
	const seeded = createGoalState({
		goalId: "j9-wt-x2-goal",
		userGoal: X2_TASK,
		now: NOW,
	});
	return {
		...seeded,
		requirements: [
			{
				id: REQ_A1,
				text: "src/limits.ts sets MAX_RETRIES to 5.",
				status: "open",
				evidenceIds: [],
				createdAt: NOW,
				updatedAt: NOW,
			},
			{
				id: REQ_A2,
				text: "src/timeouts.ts sets TIMEOUT_MS to 2000.",
				status: "open",
				evidenceIds: [],
				createdAt: NOW,
				updatedAt: NOW,
			},
		],
	};
}

function x1Goal(): GoalState {
	const seeded = createGoalState({
		goalId: "j9-wt-x1-goal",
		userGoal: X1_TASK,
		now: NOW,
	});
	return {
		...seeded,
		requirements: [
			{
				id: REQ_B1,
				text: "src/limits.ts covers the retry limit requirement.",
				check: { command: CHECK_B1, expectExitCode: 0 },
				status: "open",
				evidenceIds: [],
				createdAt: NOW,
				updatedAt: NOW,
			},
			{
				id: REQ_B2,
				text: "src/timeouts.ts sets TIMEOUT_MS to 2000.",
				check: { command: CHECK_B2, expectExitCode: 0 },
				status: "open",
				evidenceIds: [],
				createdAt: NOW,
				updatedAt: NOW,
			},
		],
	};
}
