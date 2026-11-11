import "../builtin-install.ts";
import type { SimpleStreamOptions } from "@caupulican/pi-ai";
import { expect } from "vitest";
import type { Outcome } from "../../../../src/core/delegation/worker-outcome.ts";
import { subscribeOutcomes } from "../../../../src/core/delegation/worker-outcome.ts";
import { createGoalState, type GoalState } from "../../../../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot } from "../../../../src/core/goals/session-goal-state.ts";
import { createBarrier, HARNESS_PROVIDER, type ScriptedRequest, type ScriptStep } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, withDeadline } from "../session-fixture.ts";
import {
	carriesTask,
	delegateStart,
	handoffBlocks,
	J9_ROOT_JUDGMENTS,
	j9Profile,
	recordedOutcome,
	saveJ9Profile,
	scriptRequirementCheckSpawn,
	taskForInstructions,
} from "./journey-9-shared.ts";
import { latestBatchResults } from "./shared.ts";

const MOVE_PROMPT = "Start an unbound read-only worker to report the retry limit from the limits file.";
const MOVE_TASK = "Inspect MAX_RETRIES in the limits file across escalation rungs and cover the requirement.";
const MOVE_REQ_ID = "j9-move-req";

const TIME_PROMPT = "Start a bounded read-only worker to cover both limits requirements.";
const TIME_TASK = "Cover both the host-checkable and open limits requirements within the attempt wall-clock cap.";
const TIME_CHECK_REQ_ID = "j9-time-checked";
const TIME_OPEN_REQ_ID = "j9-time-open";

const CHECK_COMMAND = "grep -n MAX_RETRIES src/limits.ts";
/** Words outside the delivery-claim vocabulary so read-only worker turns ask no claim-delivery judgment. */
const PARTIAL_NOTE = "Only the value was read, and I did nothing more with it.";
const NOW = "2026-10-08T00:00:00.000Z";

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

function requestReasoning(request: ScriptedRequest): NonNullable<SimpleStreamOptions["reasoning"]> | "off" {
	return (request.options as SimpleStreamOptions | undefined)?.reasoning ?? "off";
}

function extractReceiptId(request: ScriptedRequest): string {
	const match = /\b(c-[0-9a-f]+)\b/.exec(JSON.stringify(request.context.messages));
	if (!match?.[1]) {
		throw new Error(
			`Expected host report request with a command receipt id: ${JSON.stringify(request.context.messages)}`,
		);
	}
	return match[1];
}

function proveRequirementWithShellSteps(
	prefix: string,
	requirementId: string,
	checkPrompt?: (request: ScriptedRequest) => void,
): ScriptStep[] {
	return [
		{
			name: `${prefix}-bash`,
			...(checkPrompt ? { check: checkPrompt } : {}),
			reply: {
				content: [
					{ type: "toolCall", id: `${prefix}-bash-call`, name: "bash", arguments: { command: CHECK_COMMAND } },
				],
				stopReason: "toolUse",
			},
		},
		{
			name: `${prefix}-draft`,
			check: (request) => {
				const bash = latestBatchResults(request).find((result) => result.toolName === "bash");
				if (bash?.isError || !bash?.text.includes("MAX_RETRIES = 3")) {
					throw new Error(`${prefix} bash check failed: ${bash?.text ?? "no result"}`);
				}
			},
			reply: {
				content: [{ type: "text", text: "MAX_RETRIES = 3 appears in the limits file." }],
			},
		},
		{
			name: `${prefix}-report`,
			reply: (request) => ({
				content: [
					{
						type: "toolCall",
						id: `${prefix}-report-call`,
						name: "submit_report",
						arguments: {
							status: "completed",
							summary: "MAX_RETRIES = 3 is present in the limits file.",
							requirements: [{ id: requirementId, status: "met", evidence: [extractReceiptId(request)] }],
						},
					},
				],
				stopReason: "toolUse",
			}),
		},
	];
}

/**
 * Leg 5: multi-rung escalation (E14 -> E15 -> E0) and partial time-stop rerun at unchanged thinking:
 * 1. An unbound worker starts at `thinking: "off"` on `worker-a` (`routeProviders: [worker-a, worker-b]`) and leaves its
 *    requirement partial -> Rung 1 (`E14`) raises thinking to `"minimal"` on `worker-a` -> still partial -> Rung 2 (`E15`)
 *    preserves the origin attempt's unbound ordered-fallback policy and moves to `worker-b` -> `worker-b` proves the
 *    requirement (`E0`).
 * 2. A worker at `thinking: "low"` with per-attempt `maxWallClockMs` times out (`wall_clock_exceeded` -> `time_exhausted`),
 *    `E12` proves one checkable requirement while the second stays uncovered (`partialProgress`), and Rung 1 (`E14`)
 *    reruns `[TIME_OPEN_REQ_ID]` at the **same** `"low"` thinking level rather than raising to `"medium"`.
 */
export async function runJourney9RerunAndModelMovePhase(world: HarnessWorld): Promise<void> {
	await runRerunThenModelMoveSubleg(world);
	await runTimeExhaustedSameThinkingSubleg(world);
}

async function runRerunThenModelMoveSubleg(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	const accepted = createBarrier();
	const reported = createBarrier();
	const recorded: Outcome[] = [];
	world.setModelReasoning("worker-a", true);
	world.setModelReasoning("worker-b", true);
	const sessionManager = world.createSessionManager();
	appendGoalStateSnapshot(sessionManager, moveGoal());
	const unsubscribe = subscribeOutcomes((outcome) => {
		if (!outcome.coverage.required.includes(MOVE_REQ_ID)) return;
		recorded.push(outcome);
		if (outcome.nextAction.kind !== "rerun_uncovered" && outcome.nextAction.kind !== "host_check") {
			accepted.release();
		}
	});
	world.shell.enqueue({
		name: "j9-l5-move-bash",
		command: CHECK_COMMAND,
		cwd: HARNESS_PROJECT_CWD,
		output: "1:export const MAX_RETRIES = 3;\n",
		exitCode: 0,
	});
	world.provider.enqueue(
		"root",
		{
			name: "j9-l5-move-start",
			reply: {
				content: [
					delegateStart("j9-l5-move-call", {
						instructions: MOVE_TASK,
						readOnly: true,
						thinkingLevel: "off",
						requirementIds: [MOVE_REQ_ID],
					}),
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j9-l5-move-reply",
			check: (request) => {
				const started = latestBatchResults(request).find((result) => result.toolName === "delegate");
				if (started?.isError || !started?.text.includes("delegate started (running)")) {
					throw new Error(`the unbound worker did not start: ${started?.text ?? "no result"}`);
				}
			},
			reply: { content: [{ type: "text", text: "Noted." }] },
		},
		{
			name: "j9-l5-move-handoff",
			maxRequests: 12,
			until: (request) => {
				const done = handoffBlocks(request).some(
					(block) =>
						block.outcome.includes("Outcome: succeeded") && block.outcome.includes(`covered: ${MOVE_REQ_ID}`),
				);
				if (!done) return false;
				reported.release();
				return true;
			},
			reply: { content: [{ type: "text", text: "Noted." }] },
		},
	);
	world.provider.enqueueTrack(
		"j9-l5-move-a",
		"worker-a",
		carriesTask(MOVE_TASK),
		{
			name: "j9-l5-a-attempt1",
			check: (request) => {
				expect(requestReasoning(request), "attempt 1 starts at thinking off").toBe("off");
				expect(
					JSON.stringify(request.context.messages),
					"attempt 1 carries the initial task without a rung header",
				).not.toContain("this run has more thinking");
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j9-l5-a1-report",
						name: "submit_report",
						arguments: {
							status: "completed",
							summary: "The retry limit of the limits file is 3, and I did not look any further.",
							requirements: [{ id: MOVE_REQ_ID, status: "partial", note: PARTIAL_NOTE }],
						},
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j9-l5-a-attempt2",
			check: (request) => {
				expect(requestReasoning(request), "rung 1 raises worker-a thinking from off to minimal").toBe("minimal");
				expect(
					JSON.stringify(request.context.messages),
					"rung 1 tells worker-a that this run has more thinking",
				).toContain("this run has more thinking");
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j9-l5-a2-report",
						name: "submit_report",
						arguments: {
							status: "completed",
							summary: "The retry limit of the limits file is still 3, and I did nothing further.",
							requirements: [{ id: MOVE_REQ_ID, status: "partial", note: PARTIAL_NOTE }],
						},
					},
				],
				stopReason: "toolUse",
			},
		},
	);
	world.provider.enqueueTrack(
		"j9-l5-move-b",
		"worker-b",
		carriesTask(MOVE_TASK),
		...proveRequirementWithShellSteps("j9-l5-b", MOVE_REQ_ID, (request) => {
			expect(requestReasoning(request), "rung 2 moves to worker-b at its fallback thinking off").toBe("off");
			expect(
				JSON.stringify(request.context.messages),
				"rung 2 tells worker-b that this run is on another model",
			).toContain("this run is on another model");
		}),
	);
	world.systemOne.enterPhase("j9-l5-move", { ...J9_ROOT_JUDGMENTS, ...GOAL_STEP_JUDGMENTS });
	try {
		const { session } = await world.createRootSession("root", {
			sessionManager,
			settings: {
				autonomy: { goalAutoContinue: false },
				workerDelegation: {
					routeProviders: [`${HARNESS_PROVIDER}/worker-a`, `${HARNESS_PROVIDER}/worker-b`],
					outcomes: { escalation: { enabled: true, maxRungs: 2 } },
				},
			},
		});
		await withDeadline(trace, "J9 leg 5 move turn", session.prompt(MOVE_PROMPT));
		await withDeadline(trace, "J9 leg 5 move E0", accepted.promise);
		if (recorded.at(-1)?.ladder.exit === "E0") {
			await withDeadline(trace, "J9 leg 5 move handoff", reported.promise);
		}
		await withDeadline(trace, "J9 leg 5 move idle", session.waitForForegroundIdle());

		const taskId = taskForInstructions(session, MOVE_TASK);
		const final = recordedOutcome(session, taskId);
		const taskState = session.backgroundLanes.getTaskRuntimeSnapshot()?.tasks[taskId];
		expect(
			recorded.map((outcome) => ({
				exit: outcome.ladder.exit,
				rung: outcome.ladder.rung,
				next: outcome.nextAction,
			})),
			"E14 raises thinking on worker-a, E15 moves to worker-b, and E0 accepts the verified report",
		).toEqual([
			{
				exit: "E14",
				rung: 1,
				next: {
					kind: "rerun_uncovered",
					requirementIds: [MOVE_REQ_ID],
					rung: 1,
					modelRef: `${HARNESS_PROVIDER}/worker-a`,
					thinking: "minimal",
				},
			},
			{
				exit: "E15",
				rung: 2,
				next: {
					kind: "rerun_uncovered",
					requirementIds: [MOVE_REQ_ID],
					rung: 2,
					modelRef: `${HARNESS_PROVIDER}/worker-b`,
					thinking: "off",
				},
			},
			{
				exit: "E0",
				rung: 2,
				next: { kind: "accept" },
			},
		]);
		expect(
			final.attempts.map((attempt) => ({
				modelRef: attempt.modelRef,
				thinking: attempt.thinking,
				rung: attempt.rung,
			})),
			"the task's three attempts record rung 0 on worker-a (off), rung 1 on worker-a (minimal), and rung 2 on worker-b (off)",
		).toEqual([
			{ modelRef: `${HARNESS_PROVIDER}/worker-a`, thinking: "off", rung: 0 },
			{ modelRef: `${HARNESS_PROVIDER}/worker-a`, thinking: "minimal", rung: 1 },
			{ modelRef: `${HARNESS_PROVIDER}/worker-b`, thinking: "off", rung: 2 },
		]);
		expect(
			taskState?.escalations?.map((entry) => ({
				taskId: entry.taskId,
				rung: entry.rung,
				modelRef: entry.modelRef,
				thinking: entry.thinking,
			})),
			"both escalation rungs run in place on the same X2 task identity",
		).toEqual([
			{ taskId, rung: 1, modelRef: `${HARNESS_PROVIDER}/worker-a`, thinking: "minimal" },
			{ taskId, rung: 2, modelRef: `${HARNESS_PROVIDER}/worker-b`, thinking: "off" },
		]);
		expect(await world.disposeSessionInBody(session), "the leg 5 move owner disposes cleanly").toBeUndefined();
		trace.mark("root", "j9.rerun-and-model-move");
	} finally {
		unsubscribe();
		world.setModelReasoning("worker-a", false);
		world.setModelReasoning("worker-b", false);
	}
}

async function runTimeExhaustedSameThinkingSubleg(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	const stallAttempt1 = createBarrier();
	const accepted = createBarrier();
	const reported = createBarrier();
	const recorded: Outcome[] = [];
	world.setModelReasoning("worker-a", true);
	saveJ9Profile(world, {
		...j9Profile("j9-time", "worker-a"),
		modelPolicy: {
			mode: "fixed",
			candidates: [{ provider: HARNESS_PROVIDER, modelId: "worker-a", thinkingLevel: "low" }],
		},
		budget: { maxTokens: 400_000 },
	});
	const sessionManager = world.createSessionManager();
	appendGoalStateSnapshot(sessionManager, timeStopGoal());
	const unsubscribe = subscribeOutcomes((outcome) => {
		if (!outcome.coverage.required.includes(TIME_OPEN_REQ_ID)) return;
		recorded.push(outcome);
		if (outcome.nextAction.kind !== "rerun_uncovered" && outcome.nextAction.kind !== "host_check") {
			accepted.release();
		}
	});
	const scriptedCheck = scriptRequirementCheckSpawn(world, CHECK_COMMAND);
	world.shell.enqueue(
		{
			name: "j9-l5-time-e12-check",
			command: CHECK_COMMAND,
			cwd: HARNESS_PROJECT_CWD,
			output: "1:export const MAX_RETRIES = 3;\n",
			exitCode: 0,
		},
		{
			name: "j9-l5-time-attempt2-bash",
			command: CHECK_COMMAND,
			cwd: HARNESS_PROJECT_CWD,
			output: "1:export const MAX_RETRIES = 3;\n",
			exitCode: 0,
		},
	);
	world.provider.enqueue(
		"root",
		{
			name: "j9-l5-time-start",
			reply: {
				content: [
					delegateStart("j9-l5-time-call", {
						profileId: "j9-time",
						instructions: TIME_TASK,
						requirementIds: [TIME_CHECK_REQ_ID, TIME_OPEN_REQ_ID],
					}),
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j9-l5-time-reply",
			check: (request) => {
				const started = latestBatchResults(request).find((result) => result.toolName === "delegate");
				if (started?.isError || !started?.text.includes("delegate started (running)")) {
					throw new Error(`the wall-clock worker did not start: ${started?.text ?? "no result"}`);
				}
			},
			reply: { content: [{ type: "text", text: "Noted." }] },
		},
		{
			name: "j9-l5-time-handoff",
			maxRequests: 12,
			until: (request) => {
				const done = handoffBlocks(request).some(
					(block) =>
						block.outcome.includes("Outcome: succeeded") &&
						block.outcome.includes(`covered: ${TIME_OPEN_REQ_ID}`),
				);
				if (!done) return false;
				reported.release();
				return true;
			},
			reply: { content: [{ type: "text", text: "Noted." }] },
		},
	);
	world.provider.enqueueTrack(
		"j9-l5-time-a",
		"worker-a",
		carriesTask(TIME_TASK),
		{
			name: "j9-l5-time-attempt1-stall",
			gate: stallAttempt1.promise,
			check: (request) => {
				expect(requestReasoning(request), "attempt 1 starts at thinking low").toBe("low");
			},
			reply: {
				content: [{ type: "text", text: "Unreachable: wall-clock cap aborts attempt 1 first." }],
			},
		},
		...proveRequirementWithShellSteps("j9-l5-time-a2", TIME_OPEN_REQ_ID, (request) => {
			expect(
				requestReasoning(request),
				"partial time-stop rerun keeps rung 1 at thinking low rather than raising to medium after a wall-clock timeout",
			).toBe("low");
			expect(
				JSON.stringify(request.context.messages),
				"partial time-stop rerun states that the earlier attempt ran out of time after partial progress",
			).toContain("ran out of time after partial progress");
		}),
	);
	world.systemOne.enterPhase("j9-l5-time", { ...J9_ROOT_JUDGMENTS, ...GOAL_STEP_JUDGMENTS });
	try {
		const { session } = await world.createRootSession("root", {
			sessionManager,
			settings: {
				autonomy: { goalAutoContinue: false },
				workerDelegation: {
					maxWallClockMs: 300,
					outcomes: { escalation: { enabled: true, maxRungs: 2 } },
				},
			},
		});
		await withDeadline(trace, "J9 leg 5 time turn", session.prompt(TIME_PROMPT));
		await withDeadline(trace, "J9 leg 5 time E0", accepted.promise);
		if (recorded.at(-1)?.ladder.exit === "E0") {
			await withDeadline(trace, "J9 leg 5 time handoff", reported.promise);
		}
		await withDeadline(trace, "J9 leg 5 time idle", session.waitForForegroundIdle());

		const taskId = taskForInstructions(session, TIME_TASK);
		const final = recordedOutcome(session, taskId);
		expect(
			recorded.map((outcome) => ({
				exit: outcome.ladder.exit,
				status: outcome.status,
				blocker: outcome.blocker,
				next: outcome.nextAction,
			})),
			"timeout runs E12 first, then places rung 1 at unchanged thinking low for the remaining requirement, then E0 accepts",
		).toEqual([
			{
				exit: "E12",
				status: "failed",
				blocker: "time_exhausted",
				next: { kind: "host_check", requirementIds: [TIME_CHECK_REQ_ID] },
			},
			{
				exit: "E14",
				status: "partial",
				blocker: "time_exhausted",
				next: {
					kind: "rerun_uncovered",
					requirementIds: [TIME_OPEN_REQ_ID],
					rung: 1,
					modelRef: `${HARNESS_PROVIDER}/worker-a`,
					thinking: "low",
				},
			},
			{
				exit: "E0",
				status: "succeeded",
				blocker: "none",
				next: { kind: "accept" },
			},
		]);
		expect(
			final.attempts.map((attempt) => ({
				thinking: attempt.thinking,
				rung: attempt.rung,
				laneStatus: attempt.laneStatus,
			})),
			"both the timed-out attempt and its partial time-stop rerun run at thinking low",
		).toEqual([
			{ thinking: "low", rung: 0, laneStatus: "timeout" },
			{ thinking: "low", rung: 1, laneStatus: "succeeded" },
		]);
		expect(await world.disposeSessionInBody(session), "the leg 5 time owner disposes cleanly").toBeUndefined();
		trace.mark("root", "j9.time-exhausted-same-thinking");
	} finally {
		stallAttempt1.release();
		unsubscribe();
		scriptedCheck.restore();
		world.setModelReasoning("worker-a", false);
	}
}

function moveGoal(): GoalState {
	const goal = createGoalState({
		goalId: "j9-move-goal",
		userGoal: "Prove MAX_RETRIES across escalation rungs.",
		now: NOW,
	});
	return {
		...goal,
		requirements: [
			{
				id: MOVE_REQ_ID,
				text: "Confirm MAX_RETRIES in the limits file.",
				status: "open",
				evidenceIds: [],
				createdAt: NOW,
				updatedAt: NOW,
			},
		],
	};
}

function timeStopGoal(): GoalState {
	const goal = createGoalState({
		goalId: "j9-time-goal",
		userGoal: "Cover both limits requirements under a per-attempt wall-clock cap.",
		now: NOW,
	});
	return {
		...goal,
		requirements: [
			{
				id: TIME_CHECK_REQ_ID,
				text: `The limits file still carries MAX_RETRIES, checked by ${CHECK_COMMAND}.`,
				check: { command: CHECK_COMMAND, expectExitCode: 0 },
				status: "open",
				evidenceIds: [],
				createdAt: NOW,
				updatedAt: NOW,
			},
			{
				id: TIME_OPEN_REQ_ID,
				text: "Confirm the MAX_RETRIES value in the worker report.",
				status: "open",
				evidenceIds: [],
				createdAt: NOW,
				updatedAt: NOW,
			},
		],
	};
}
