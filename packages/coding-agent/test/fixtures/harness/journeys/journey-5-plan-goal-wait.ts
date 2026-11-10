import "../builtin-install.ts";
import { createEmptyUsage } from "@caupulican/pi-ai";
import { expect } from "vitest";
import { DEFAULT_GOAL_WORKER_WAIT_MS } from "../../../../src/core/goals/goal-continuation-defaults.ts";
import { editPersistedGoal } from "../../../../src/core/goals/goal-lifecycle.ts";
import { createBarrier } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import {
	deliveredLines,
	enqueueRoot,
	enqueueStepWorker,
	latestAttemptOf,
	planCallSteps,
	planTitled,
	planUpdateStep,
	ROOT_TRACK,
	reportStep,
	stepReached,
	whenPlanState,
} from "./journey-5-shared.ts";
import { latestBatchResults } from "./shared.ts";

const LABEL = "j5-plan-goal-wait";
/** The port the goal's own wake is armed on. */
const WAKE_OWNER = "goal-continuation";
/** The clock a plan's last movement and its wait are stamped and decided on. */
const CLOCK_OWNER = "orchestration";
/** The port a running worker's lease heartbeat renews on. */
const LEASE_OWNER = "worker-lease";
const TITLE = "Watch the retry limit from two angles and combine the readings";
const FIRST = "watch-first";
const SECOND = "watch-second";
const SUMMARY = "watch-summary";
const GOAL = "Keep the retry limit documented.";
const GOAL_ID = `${LABEL}-goal`;
const TIMEOUT_TURN_TOKENS = 2_000;
const TEN_MINUTES_MS = 600_000;
/** One step of the orchestration clock the wait runs out on, short enough for the worker's lease to stay live. */
const CLOCK_STEP_MS = 60_000;
/**
 * What a continuation turn tells the root beside the goal's record: to go on, and the standing rule for a wait that ran out.
 * The decision's own message is the owner's status text; the turn's words are the same on every continuation.
 */
const GOAL_TURN_LINES = ["Continue objective.", "Recover/reassign timeouts; verify/reopen blocks."];
/**
 * What the plan's wait timeout is built from: one running step and the default worker wait. The same two numbers the
 * decision's own message reads.
 */
const TIMEOUT_MESSAGE = `The plan's 1 running step(s) have shown no progress for ${Math.round((DEFAULT_GOAL_WORKER_WAIT_MS / 3_600_000) * 10) / 10} h; continue the goal with what is known and re-plan what is stuck.`;

/**
 * A plan under a goal: the goal's wait on the plan's running steps. The session runs with System One off, because this
 * phase proves timers and wakes, which no judgment decides.
 *
 * In one turn the root starts a goal and, under it, a plan of two read-only steps and a collect join over them; both steps
 * are held at their first request, so the plan is in flight and the goal's continuation decision waits on it. The goal is
 * recorded without requirements, and the continuation runs at the owner's default delay of zero: a goal that did not wait
 * here would prompt the root again and again while the plan runs. The wake is armed on the goal's port for what is left of
 * the plan's wait, an early wake only re-arms, and a step's settlement re-decides it at once. The deadline belongs to the
 * orchestration clock: once that clock is past the plan's last movement plus the maximum worker wait, the decision is the
 * wait timeout, and the one wake that fires then spends the owner's last turn, which stops the goal as budget_limited. The
 * plan is not affected by the stop: its running step finishes, the plan closes and the root is told its result in one
 * request.
 *
 * A running step holds a durable lease stamped and checked on the orchestration clock, and the lease lives a minute and a
 * half of that clock. The phase therefore walks the orchestration clock forward in steps and fires the running worker's lease
 * heartbeat between them, as production heartbeats do, so that the step is still live when the wait runs out. A single jump
 * of the whole wait would expire the lease and the step could never report.
 */
export async function runJourney5PlanGoalWaitPhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	const started = createBarrier();
	const done = createBarrier();
	const firstMayReport = createBarrier();
	const secondMayReport = createBarrier();
	// The session keeps its history in a file, as the plan's other owners do: a plan's update is accepted into stored history.
	const created = await world.createRootSession("root", {
		sessionManager: world.createSessionManager(),
		systemOneEnabled: false,
		settings: { memorySystem: "okf", autoLearn: { enabled: false } },
	});
	const session = created.session;
	world.systemOne.enterPhase(LABEL, {});
	const maxStallTurns = created.settingsManager.getAutonomySettings().maxStallTurns;
	// The plan's two first steps run side by side, so the fleet is given room for the two of them.
	const fleet = created.settingsManager.getGlobalSettings().fleet ?? {};
	created.settingsManager.setFleetSettings({ ...fleet, ceiling: { ...fleet.ceiling, running: 2 } });
	const mark = world.provider.reached.length;
	const rootRequests = () => world.provider.reached.slice(mark).filter((name) => name.startsWith(`${ROOT_TRACK}:`));
	const decision = () => session.getGoalRuntimeSnapshot({ maxStallTurns }).continuation;
	const plan = () => planTitled(session, TITLE);
	const attemptOf = (nodeId: string) => latestAttemptOf(session, plan().nodes[nodeId]?.release?.taskId);
	const settled = (nodeId: string) => plan().nodes[nodeId]?.settled !== undefined;
	// An outcome written by a newer build is opaque; this build wrote this one, so its record names the goal.
	const goalOfPlan = (): string | undefined => (plan().record as { goalId?: string }).goalId;

	// 1. Nothing is armed on the goal's continuation port before the goal exists.
	expect(
		world.timers.armedDelays(WAKE_OWNER),
		`${LABEL}: no goal-continuation alarm is armed before the goal starts`,
	).toEqual([]);

	// 2. A goal, and under it a plan of two read-only steps and a collect join over them, both steps held at their first
	// request.
	for (const nodeId of [FIRST, SECOND]) {
		enqueueStepWorker(
			world,
			nodeId,
			reportStep(
				`${LABEL}-${nodeId}-report`,
				{ status: "completed", summary: `Result of ${nodeId}: MAX_RETRIES is 5 in src/limits.ts.` },
				(nodeId === FIRST ? firstMayReport : secondMayReport).promise,
			),
		);
	}
	const [planCall, planResult] = planCallSteps(
		`${LABEL}-plan`,
		{
			action: "start",
			title: TITLE,
			steps: [
				{ id: FIRST, do: "Read src/limits.ts and report the value of MAX_RETRIES. Change no file." },
				{
					id: SECOND,
					do: "Search the project for every place that reads MAX_RETRIES and report each file and line. Change no file.",
				},
				{
					id: SUMMARY,
					do: "Combine both readings into one result.",
					join: "collect",
					uses: [FIRST, SECOND],
				},
			],
		},
		"PLAN_STARTED",
		() => started.release(),
	);
	if (!planCall || !planResult) throw new Error(`${LABEL}: the plan call has no script`);
	enqueueRoot(
		world,
		{
			name: `${LABEL}-goal-call`,
			reply: {
				content: [
					{
						type: "toolCall",
						id: `${LABEL}-goal-call-1`,
						name: "goal",
						arguments: { action: "start", goalId: GOAL_ID, userGoal: GOAL },
					},
				],
				stopReason: "toolUse",
			},
		},
		// The same turn goes on to the plan: the goal's own continuation never has to start it.
		{
			...planCall,
			check: (request) => {
				const result = latestBatchResults(request).find((entry) => entry.toolName === "goal");
				if (!result || result.isError) throw new Error(`the goal was not started: ${result?.text ?? "no result"}`);
				planCall.check?.(request);
			},
		},
		planResult,
	);
	await withDeadline(
		trace,
		`${LABEL} turn`,
		session.prompt("Watch the retry limit from two angles and combine the readings."),
		90_000,
	);
	await withDeadline(trace, `${LABEL}: the plan started`, started.promise, 90_000);
	await withDeadline(
		trace,
		`${LABEL}: both steps are in flight`,
		Promise.all([
			world.provider.whenReached(stepReached(FIRST, `${LABEL}-${FIRST}-report`), mark),
			world.provider.whenReached(stepReached(SECOND, `${LABEL}-${SECOND}-report`), mark),
		]),
		90_000,
	);
	expect(
		{
			goalId: goalOfPlan(),
			running: [FIRST, SECOND].map((nodeId) => attemptOf(nodeId)?.status),
		},
		`${LABEL}: the plan runs under the goal, with both read-only steps held at their first request`,
	).toEqual({ goalId: GOAL_ID, running: ["running", "running"] });

	// 3. The wake is armed for what is left of the plan's wait, the decision waits on the plan, and the wait makes no root
	// request of its own.
	await withDeadline(trace, `${LABEL}: the goal's wake is armed`, world.timers.whenArmed(WAKE_OWNER), 90_000);
	const waiting = decision();
	const armedForWait = world.timers.armedDelays(WAKE_OWNER);
	const rootsAtRest = rootRequests();
	expect(
		{
			action: waiting.action,
			reasonCode: waiting.reasonCode,
			hasResumeAt: waiting.resumeAt !== undefined,
			alarms: armedForWait.length,
			root: rootsAtRest,
		},
		`${LABEL}: the idle root waits on the plan's running steps with one wake armed, and the turn that started the plan is its last request`,
	).toEqual({
		action: "waiting",
		reasonCode: "plan_in_flight",
		hasResumeAt: true,
		alarms: 1,
		root: [
			`${ROOT_TRACK}:${LABEL}-goal-call`,
			`${ROOT_TRACK}:${LABEL}-plan-call`,
			`${ROOT_TRACK}:${LABEL}-plan-result`,
		],
	});
	expect(armedForWait[0], `${LABEL}: the wake is armed for no more than the maximum worker wait`).toBeLessThanOrEqual(
		DEFAULT_GOAL_WORKER_WAIT_MS,
	);
	expect(armedForWait[0], `${LABEL}: the wake is armed for a delay that has not passed`).toBeGreaterThan(0);

	// 4. A wake that fires before the deadline only re-arms: the orchestration clock has not moved, so the plan is still
	// waited on and still no request is made.
	const armedDelay = armedForWait[0]!;
	expect(world.timers.advance(WAKE_OWNER, armedDelay), `${LABEL}: the wake fires at its delay`).toBe(1);
	await withDeadline(trace, `${LABEL}: the wake is armed again`, world.timers.whenArmed(WAKE_OWNER), 90_000);
	const afterEarlyWake = decision();
	expect(
		{
			action: afterEarlyWake.action,
			reasonCode: afterEarlyWake.reasonCode,
			hasResumeAt: afterEarlyWake.resumeAt !== undefined,
			alarms: world.timers.armedDelays(WAKE_OWNER).length,
			root: rootRequests().length,
		},
		`${LABEL}: an early wake only re-arms, because the orchestration clock did not move`,
	).toEqual({
		action: "waiting",
		reasonCode: "plan_in_flight",
		hasResumeAt: true,
		alarms: 1,
		root: rootsAtRest.length,
	});

	// 5. A step changing re-decides the wake at once: the settlement becomes the plan's new last movement, and the wake is
	// armed for the whole wait again without waiting for the old alarm.
	expect(
		world.timers.advance(WAKE_OWNER, TEN_MINUTES_MS),
		`${LABEL}: ten minutes of the wait pass with nothing to fire`,
	).toBe(0);
	firstMayReport.release();
	await withDeadline(
		trace,
		`${LABEL}: the first step settles`,
		whenPlanState(session, () => settled(FIRST)),
		90_000,
	);
	const afterStep = decision();
	const armedAfterStep = world.timers.armedDelays(WAKE_OWNER);
	expect(
		{
			action: afterStep.action,
			reasonCode: afterStep.reasonCode,
			alarms: armedAfterStep.length,
			longerThanWhatTheOldAlarmHasLeft: (armedAfterStep[0] ?? 0) > armedDelay - TEN_MINUTES_MS,
			withinTheWait: (armedAfterStep[0] ?? 0) <= DEFAULT_GOAL_WORKER_WAIT_MS,
			root: rootRequests().length,
		},
		`${LABEL}: the step's settlement re-decides the wake at once for the plan's new last movement`,
	).toEqual({
		action: "waiting",
		reasonCode: "plan_in_flight",
		alarms: 1,
		longerThanWhatTheOldAlarmHasLeft: true,
		withinTheWait: true,
		root: rootsAtRest.length,
	});

	// 6. The deadline is the orchestration clock's: walked past the plan's last movement plus the maximum worker wait, with
	// the running worker's lease heartbeat between the steps, the decision is the plan's wait timeout while the armed wake
	// is still the old alarm.
	const runningLeaseTtlMs = attemptOf(SECOND)?.dispatch.executionContract?.worker.profile.leaseTtlMs;
	if (runningLeaseTtlMs === undefined) {
		throw new Error(`${LABEL}: the running step carries no lease TTL`);
	}
	const heartbeatMs = Math.floor(runningLeaseTtlMs / 3);
	const alarmBeforeDeadline = world.timers.armedDelays(WAKE_OWNER);
	const rootsBeforeDeadline = rootRequests().length;
	const clockSteps = Math.ceil(DEFAULT_GOAL_WORKER_WAIT_MS / CLOCK_STEP_MS) + 1;
	for (let step = 0; step < clockSteps && decision().reasonCode === "plan_in_flight"; step++) {
		world.timers.advance(CLOCK_OWNER, CLOCK_STEP_MS);
		world.timers.advance(LEASE_OWNER, heartbeatMs);
	}
	const timedOut = decision();
	expect(
		{ action: timedOut.action, reasonCode: timedOut.reasonCode, message: timedOut.message },
		`${LABEL}: the wait runs out on the orchestration clock that stamped the plan's last movement`,
	).toEqual({ action: "continue", reasonCode: "worker_wait_timeout", message: TIMEOUT_MESSAGE });
	expect(
		world.timers.armedDelays(WAKE_OWNER),
		`${LABEL}: the plan's wake is still the alarm armed before the wait ran out, because nothing fired`,
	).toEqual(alarmBeforeDeadline);
	expect(rootRequests().length, `${LABEL}: the timed-out wait makes no root request of its own`).toBe(
		rootsBeforeDeadline,
	);

	// 7. The owner's budget leaves room for exactly one more turn: the one wake that fires submits one root request, and its
	// charge stops the goal.
	const tokensUsed = session.getGoalStateSnapshot()?.tokensUsed ?? 0;
	const edited = editPersistedGoal(session, { userGoal: GOAL, tokenBudget: tokensUsed + TIMEOUT_TURN_TOKENS });
	expect(edited.ok, `${LABEL}: the owner's budget edit is applied`).toBe(true);
	const passSeen: { action?: string; reasonCode?: string; message?: string; told: string[] } = { told: [] };
	const passReached = createBarrier();
	enqueueRoot(world, {
		name: `${LABEL}-timeout-pass`,
		check: (request) => {
			const current = decision();
			passSeen.action = current.action;
			passSeen.reasonCode = current.reasonCode;
			passSeen.message = current.message;
			passSeen.told = deliveredLines(request).filter((line) => GOAL_TURN_LINES.includes(line));
			passReached.release();
		},
		reply: {
			content: [{ type: "text", text: "The plan's steps are still running." }],
			usage: { ...createEmptyUsage(), output: TIMEOUT_TURN_TOKENS, totalTokens: TIMEOUT_TURN_TOKENS },
		},
	});
	const wakeMark = world.warnings.length;
	const deadlineDelay = world.timers.armedDelays(WAKE_OWNER)[0]!;
	expect(
		world.timers.advance(WAKE_OWNER, deadlineDelay),
		`${LABEL}: the plan's wake fires at the deadline the orchestration clock set`,
	).toBe(1);
	await withDeadline(trace, `${LABEL}: the timeout pass reaches the root`, passReached.promise, 90_000);
	await withDeadline(trace, `${LABEL}: the timeout pass settles`, session.waitForForegroundIdle(), 90_000);
	expect(
		passSeen,
		`${LABEL}: the woken pass runs on the plan's wait timeout and submits one continuation turn`,
	).toEqual({
		action: "continue",
		reasonCode: "worker_wait_timeout",
		message: TIMEOUT_MESSAGE,
		told: GOAL_TURN_LINES,
	});
	expect(
		world.provider.reached.slice(mark).filter((name) => name.startsWith(`${ROOT_TRACK}:${LABEL}-timeout`)),
		`${LABEL}: the pass submits exactly one root request`,
	).toEqual([`${ROOT_TRACK}:${LABEL}-timeout-pass`]);
	expect(session.getGoalStateSnapshot()?.status, `${LABEL}: the turn's charge stops the goal`).toBe("budget_limited");
	expect(world.timers.armedDelays(WAKE_OWNER), `${LABEL}: the stopped goal arms nothing`).toEqual([]);
	expect(world.warnings.slice(wakeMark), `${LABEL}: the timeout pass warns nothing`).toEqual([]);

	// 8. The plan is unaffected by the goal's stop while its step still runs.
	expect(
		{ attempt: attemptOf(SECOND)?.status, goal: session.getGoalStateSnapshot()?.status },
		`${LABEL}: the plan's running step is unaffected by the goal's stop`,
	).toEqual({ attempt: "running", goal: "budget_limited" });

	// 9. Released, the step settles, the plan closes and the root is told the plan's result in one request: the only root
	// request after the timeout turn.
	const rootsAfterStop = rootRequests().length;
	enqueueRoot(
		world,
		planUpdateStep(`${LABEL}-plan-done`, "PLAN_DONE", () => done.release()),
	);
	secondMayReport.release();
	await withDeadline(trace, `${LABEL}: the plan's result reaches the root`, done.promise, 90_000);
	await withDeadline(trace, `${LABEL}: the root is idle again`, session.waitForForegroundIdle(), 90_000);
	expect(
		{ closed: plan().closed?.status, root: rootRequests().slice(rootsAfterStop) },
		`${LABEL}: the settled plan closes and the root is told its result in one request`,
	).toEqual({ closed: "settled", root: [`${ROOT_TRACK}:${LABEL}-plan-done`] });

	// 10. The owner of the plan disposes cleanly.
	expect(await world.disposeSessionInBody(session), `${LABEL}: the plan's owner disposes cleanly`).toBeUndefined();
	trace.mark("root", "j5.plan-goal-wait");
}
