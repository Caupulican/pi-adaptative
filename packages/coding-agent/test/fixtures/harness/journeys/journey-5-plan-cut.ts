import "../builtin-install.ts";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { OrchestrationEventStore } from "../../../../src/core/orchestration/event-store.ts";
import { readTaskRuntimeProjection } from "../../../../src/core/orchestration/task-runtime-reader.ts";
import type { SessionManager } from "../../../../src/kernel/session/session-manager.ts";
import { createBarrier, type ScriptStep } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
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
	ROOT_TRACK,
	reportStep,
	stepReached,
	stepTaskLines,
	stepTrack,
	stepWriteAuthority,
	whenPlanState,
} from "./journey-5-shared.ts";
import { latestBatchResults } from "./shared.ts";

/**
 * A plan cut mid-way and taken up again. One step changes a file, a verify step checks the change, a third step lists the
 * file's readers and a collect join combines the check and the listing. The cut lands when the change is done, its check
 * waits for room and the listing's worker is in flight; how the owner ends there and how the session is opened again is the
 * phase's own (`PlanCut`). After the reopen the plan must go on by itself: the step that had finished is not run again;
 * the check runs as the review of that step (the verifier's prompt names the step's task, and its own task quotes the step's
 * task as dispatched); the listing's worker goes on with the task it was given; every step keeps the task and the one attempt
 * it had; the plan closes; and the reopened root is told of the check and of the plan's result, once each.
 *
 * Each phase names its own steps: a step's worker is scripted by its step id, and step ids are unique across the journey's
 * plans.
 */
export interface PlanCutScenario {
	/** The prefix of the phase's script step names, its System One phase and its deadline labels. */
	readonly name: string;
	/** The trace mark the phase leaves when it is done. */
	readonly mark: string;
	readonly title: string;
	readonly prompt: string;
	readonly change: string;
	readonly check: string;
	readonly listing: string;
	readonly summary: string;
	/** The file the change step edits: where it is, how the plan names it, the edit and the text it leaves. */
	readonly file: {
		readonly path: string;
		readonly relative: string;
		readonly oldText: string;
		readonly newText: string;
		readonly after: string;
	};
	/** Each step's task, as the plan call states it. */
	readonly tasks: {
		readonly change: string;
		readonly check: string;
		readonly listing: string;
		readonly summary: string;
	};
	/** What the change's worker, the check and the listing's worker report. */
	readonly reports: { readonly change: string; readonly check: string; readonly listing: string };
	/** The reason code of the check's accepted verdict. */
	readonly verdictCode: string;
	/** What interrupted the listing's attempt, as that attempt still names it when its worker asks its model again. */
	readonly interruption: string;
}

export type PlanCutFacts = ReturnType<typeof planCutFacts>;

/**
 * What differs between the phases that cut a plan: how the owner ends at the cut and how its session is opened again.
 * `before` are the facts at the cut. A session opened again takes its work up by itself, so workers may already have gone on
 * when this returns.
 */
export type PlanCut = (
	owner: { readonly session: AgentSession; readonly sessionManager: SessionManager },
	before: PlanCutFacts,
) => Promise<{ readonly session: AgentSession }>;

/**
 * What the plan call's review reads with System One on, beyond the plan call's own judgments: the answer of a worker that
 * changed a file, and the one pair of steps the plan leaves unordered (the change and the listing say enough to tell, and the
 * listing needs nothing only the change produces, so the review adds no edge and both start at once).
 */
const PLAN_CUT_JUDGMENTS = {
	...PLAN_CALL_JUDGMENTS,
	...CHANGED_FILE_ANSWER_CLAIMS,
	needs_output_of: { kind: "noul", probability: 0.02 },
	pair_evidence_sufficient: { kind: "noul", probability: 0.97 },
} as const;

/** The steps that run a worker, in the order every reading of them uses: the change, its check, the listing. */
function workerStepsOf(scenario: PlanCutScenario): readonly [string, string, string] {
	return [scenario.change, scenario.check, scenario.listing];
}

/** What the durable projection holds for the plan's worker steps: each step's task, its attempts and whether it is settled. */
export function planCutFacts(session: AgentSession, scenario: PlanCutScenario) {
	const plan = planTitled(session, scenario.title);
	const snapshot = session.backgroundLanes.getTaskRuntimeSnapshot();
	const steps = workerStepsOf(scenario);
	const taskOf = (nodeId: string) => plan.nodes[nodeId]?.release?.taskId;
	const attemptsOf = (nodeId: string) => {
		const taskId = taskOf(nodeId);
		const attemptIds = taskId === undefined ? [] : (snapshot?.tasks[taskId]?.attemptIds ?? []);
		return attemptIds.map((attemptId) => snapshot?.attempts[attemptId]);
	};
	return {
		tasks: steps.map(taskOf),
		attemptIds: steps.map((nodeId) => attemptsOf(nodeId).map((attempt) => attempt?.attemptId)),
		statuses: steps.map((nodeId) => attemptsOf(nodeId).map((attempt) => attempt?.status)),
		reasons: steps.map((nodeId) => attemptsOf(nodeId).map((attempt) => attempt?.reasonCode)),
		leased: steps.map((nodeId) => attemptsOf(nodeId).map((attempt) => attempt?.lease !== undefined)),
		settled: steps.map(
			(nodeId) => plan.nodes[nodeId]?.settled !== undefined || plan.nodes[nodeId]?.join !== undefined,
		),
		summarySettled: plan.nodes[scenario.summary]?.join !== undefined,
		closed: plan.closed?.status,
	};
}

/** The change step's worker: one edit of the scenario's file, then its report, held until `mayReport`. */
function changeWorkerSteps(scenario: PlanCutScenario, mayReport: Promise<void>): ScriptStep[] {
	return [
		{
			name: `${scenario.name}-change-edit`,
			reply: {
				content: [
					{
						type: "toolCall",
						id: `${scenario.name}-change-edit-1`,
						name: "edit",
						arguments: {
							path: scenario.file.path,
							edits: [{ oldText: scenario.file.oldText, newText: scenario.file.newText }],
						},
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			...reportStep(
				`${scenario.name}-change-report`,
				{
					status: "completed",
					summary: scenario.reports.change,
					changes: [{ file: scenario.file.relative, what: scenario.reports.change }],
				},
				mayReport,
			),
			check: (request) => {
				const edit = latestBatchResults(request).find((result) => result.toolName === "edit");
				if (edit?.isError) throw new Error(`the step's edit was refused: ${edit.text}`);
			},
		},
	];
}

/** The root's plan call for the scenario, and the request that carries its accepted result. */
function planCutCallSteps(scenario: PlanCutScenario, onStarted: () => void): ScriptStep[] {
	return planCallSteps(
		scenario.name,
		{
			action: "start",
			title: scenario.title,
			final: scenario.summary,
			steps: [
				{ id: scenario.change, do: scenario.tasks.change, files: [scenario.file.relative], proof: "diff" },
				{ id: scenario.check, do: scenario.tasks.check, join: "verify", uses: [scenario.change] },
				{ id: scenario.listing, do: scenario.tasks.listing },
				{
					id: scenario.summary,
					do: scenario.tasks.summary,
					join: "collect",
					uses: [scenario.check, scenario.listing],
				},
			],
		},
		"PLAN_STARTED",
		onStarted,
	);
}

/**
 * Runs the scenario's plan to the cut. The owner's prompt starts the plan; the change and the listing are in flight together;
 * the owner lowers the ceiling to one worker (neither running worker is stopped, and no other starts until one ends); the
 * change reports and settles; its check is released and waits for room behind the listing. Returns the facts at the cut,
 * after asserting them.
 */
async function runPlanToTheCut(
	world: HarnessWorld,
	scenario: PlanCutScenario,
	owner: AgentSession,
	gates: { readonly started: Promise<void>; readonly releaseChange: () => void },
	mark: number,
): Promise<PlanCutFacts> {
	const trace = world.trace;
	const fleet = world.settingsManager.getGlobalSettings().fleet ?? {};
	world.systemOne.enterPhase(scenario.name, PLAN_CUT_JUDGMENTS);
	await withDeadline(trace, `${scenario.name}: the owner's turn`, owner.prompt(scenario.prompt));
	await withDeadline(trace, `${scenario.name}: the plan started`, gates.started);
	await withDeadline(
		trace,
		`${scenario.name}: the change and the listing are in flight`,
		Promise.all([
			world.provider.whenReached(stepReached(scenario.change, `${scenario.name}-change-report`), mark),
			world.provider.whenReached(stepReached(scenario.listing, `${scenario.name}-listing-held`), mark),
		]),
	);
	world.settingsManager.setFleetSettings({ ...fleet, ceiling: { ...fleet.ceiling, running: 1 } });
	gates.releaseChange();
	await withDeadline(
		trace,
		`${scenario.name}: the check waits for room behind the listing`,
		whenPlanState(owner, () => planCutFacts(owner, scenario).statuses[1]?.[0] === "queued"),
		60_000,
	);
	const before = planCutFacts(owner, scenario);
	expect(
		{
			released: before.tasks.map((taskId) => typeof taskId === "string"),
			statuses: before.statuses,
			leased: { check: before.leased[1], listing: before.leased[2] },
			settled: before.settled,
			summarySettled: before.summarySettled,
			closed: before.closed,
			file: world.io.readFileSync(scenario.file.path, "utf8"),
		},
		`${scenario.name}: at the cut the change is done, its check waits for room with no lease, and the listing's worker is in flight`,
	).toEqual({
		released: [true, true, true],
		statuses: [["completed"], ["queued"], ["running"]],
		leased: { check: [false], listing: [true] },
		settled: [true, false, false],
		summarySettled: false,
		closed: undefined,
		file: scenario.file.after,
	});
	return before;
}

/** Runs one cut scenario in its own session: to the cut, through the phase's cut and reopen, and on to the plan's end. */
export async function runPlanCutPhase(world: HarnessWorld, scenario: PlanCutScenario, cut: PlanCut): Promise<void> {
	const trace = world.trace;
	const name = scenario.name;
	const fleet = world.settingsManager.getGlobalSettings().fleet ?? {};
	const owner = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
	const started = createBarrier();
	const changeMayReport = createBarrier();
	// Never released: the cut ends the request this step answers, and the worker's next request is the one after the reopen.
	const endedByTheCut = createBarrier();
	const checkRead = createBarrier();
	const done = createBarrier();
	let verifierPrompt = "";
	let verifierTask: string[] = [];
	let resumedTask: string[] = [];
	let resumed: { status: string | undefined; interruptedBy: string | undefined } | undefined;
	let atTheCut: PlanCutFacts | undefined;
	let checkUpdate: string[] = [];
	let doneUpdate: string[] = [];
	const mark = world.provider.reached.length;
	enqueueStepWorker(world, scenario.change, ...changeWorkerSteps(scenario, changeMayReport.promise));
	enqueueStepWorker(
		world,
		scenario.listing,
		reportStep(
			`${name}-listing-held`,
			{ status: "completed", summary: "Never delivered: the cut ends this request before its reply." },
			endedByTheCut.promise,
		),
		{
			...reportStep(
				`${name}-listing-report`,
				{ status: "completed", summary: scenario.reports.listing },
				// The listing reports after the root has read the check, so the root's two wakes are told apart.
				checkRead.promise,
			),
			check: (request) => {
				resumedTask = stepTaskLines(request);
				// The worker asks its model again: its attempt runs, and still names what interrupted it. Read from the
				// session's durable store, since the session that opened it may not have been returned to this body yet.
				const attemptId = atTheCut?.attemptIds[2]?.[0];
				const attempt =
					attemptId === undefined
						? undefined
						: readTaskRuntimeProjection(
								new OrchestrationEventStore({
									agentDir: world.agentDir,
									sessionId: owner.sessionManager.getSessionId(),
								}),
							).attempts[attemptId];
				resumed = { status: attempt?.status, interruptedBy: attempt?.reasonCode };
			},
		},
	);
	enqueueStepWorker(world, scenario.check, {
		...reportStep(`${name}-verdict`, {
			status: "completed",
			summary: scenario.reports.check,
			verdict: "accepted",
			reasonCodes: [scenario.verdictCode],
		}),
		check: (request) => {
			verifierPrompt = request.context.systemPrompt ?? "";
			verifierTask = stepTaskLines(request);
		},
	});
	enqueueRoot(
		world,
		...planCutCallSteps(scenario, () => started.release()),
		planUpdateStep(`${name}-checked`, "JOIN_DONE", (request) => {
			checkUpdate = deliveredLines(request);
			checkRead.release();
		}),
		planUpdateStep(`${name}-wake`, "PLAN_DONE", (request) => {
			doneUpdate = deliveredLines(request);
			done.release();
		}),
	);
	const before = await runPlanToTheCut(
		world,
		scenario,
		owner.session,
		{ started: started.promise, releaseChange: changeMayReport.release },
		mark,
	);
	atTheCut = before;
	const fresh = await cut(owner, before);
	// A session opened again takes its work up at the first read of it, with no prompt: this read is the host's, in case
	// nothing read it while the session was opened.
	fresh.session.getLaneRecords();
	await withDeadline(trace, `${name}: the check's result woke the reopened root`, checkRead.promise, 60_000);
	await withDeadline(trace, `${name}: the plan's result woke the reopened root`, done.promise, 60_000);
	await withDeadline(trace, `${name}: root idle`, fresh.session.waitForForegroundIdle());
	const after = planCutFacts(fresh.session, scenario);
	const plan = planTitled(fresh.session, scenario.title);
	const [changeTaskId, checkTaskId] = after.tasks;
	const change = latestAttemptOf(fresh.session, changeTaskId);
	const check = plan.nodes[scenario.check]?.join;
	const summary = plan.nodes[scenario.summary]?.join;
	// An outcome written by a newer build is opaque; this build wrote these.
	const checked = check && "status" in check.outcome ? check.outcome : undefined;
	const summed = summary && "status" in summary.outcome ? summary.outcome : undefined;
	const brief = verifierTask.indexOf("Original task as dispatched:");
	expect(
		{
			sameTasks: after.tasks,
			sameAttempts: after.attemptIds,
			statuses: after.statuses,
			settled: after.settled,
			verifierRole:
				checkTaskId === undefined
					? undefined
					: fresh.session.backgroundLanes.getTaskRuntimeSnapshot()?.tasks[checkTaskId]?.task.role,
			verifierMayChange: stepWriteAuthority(fresh.session, checkTaskId),
			promptNamesTheStep: verifierPrompt.includes(`Subject task id: '${changeTaskId}'`),
			subject: verifierTask.filter((line) => line.startsWith("Independently verify durable task ")),
			subjectTask: verifierTask.slice(brief + 1).filter((line) => line.startsWith("Task: ")),
			resumedTask: resumedTask.filter((line) => line.startsWith("Task: ")),
			resumed,
			check: checked && { status: checked.status, blocker: checked.blocker, assurance: checked.assurance },
			summary: summed && { status: summed.status, scope: summed.scope, blocker: summed.blocker },
			closed: plan.closed?.status,
			retired: plan.retired,
			file: world.io.readFileSync(scenario.file.path, "utf8"),
		},
		`${name}: after the reopen every step kept its task and its one attempt, the check ran as the review of the change, the listing went on with its task, and the plan closed`,
	).toEqual({
		sameTasks: before.tasks,
		sameAttempts: before.attemptIds,
		statuses: [["completed"], ["completed"], ["completed"]],
		settled: [true, true, true],
		verifierRole: "verifier",
		verifierMayChange: { readOnly: true, writePaths: [], editTools: [] },
		promptNamesTheStep: true,
		subject: [`Independently verify durable task '${changeTaskId}', attempt '${change?.attemptId}'.`],
		subjectTask: [`Task: ${scenario.tasks.change}`],
		resumedTask: [`Task: ${scenario.tasks.listing}`],
		resumed: { status: "running", interruptedBy: scenario.interruption },
		check: { status: "succeeded", blocker: "none", assurance: "independently_verified" },
		summary: { status: "succeeded", scope: "join", blocker: "none" },
		closed: "settled",
		retired: [],
		file: scenario.file.after,
	});
	const result = JSON.parse(String(world.io.readFileSync(summary!.artifact, "utf8"))) as {
		kind: string;
		members: { nodeId: string; status: string }[];
		gaps: string[];
	};
	expect(
		{ kind: result.kind, members: result.members.map((member) => [member.nodeId, member.status]), gaps: result.gaps },
		`${name}: the plan's result names the check and the listing as succeeded with no gap`,
	).toEqual({
		kind: "collect",
		members: [
			[scenario.check, "succeeded"],
			[scenario.listing, "succeeded"],
		],
		gaps: [],
	});
	const reached = world.provider.reached.slice(mark);
	expect(
		{
			root: reached.filter((key) => key.startsWith(`${ROOT_TRACK}:`)),
			workers: workerStepsOf(scenario).map((nodeId) =>
				reached.filter((key) => key.startsWith(`${stepTrack(nodeId)}:`)),
			),
			updates: [checkUpdate, doneUpdate].map((lines) => lines.filter((line) => line.includes("h PLAN_UPDATE,"))),
		},
		`${name}: the change was not run again, the check asked its model once and after the reopen, the listing asked again after the cut ended its first request, and the reopened root was woken by the check and by the plan's result`,
	).toEqual({
		root: [
			`${ROOT_TRACK}:${name}-call`,
			`${ROOT_TRACK}:${name}-result`,
			`${ROOT_TRACK}:${name}-checked`,
			`${ROOT_TRACK}:${name}-wake`,
		],
		workers: [
			[stepReached(scenario.change, `${name}-change-edit`), stepReached(scenario.change, `${name}-change-report`)],
			[stepReached(scenario.check, `${name}-verdict`)],
			[
				stepReached(scenario.listing, `${name}-listing-held`),
				stepReached(scenario.listing, `${name}-listing-report`),
			],
		],
		updates: [["h PLAN_UPDATE,JOIN_DONE,READ_REPORT"], ["h PLAN_UPDATE,PLAN_DONE,READ_REPORT"]],
	});
	world.settingsManager.setFleetSettings(fleet);
	expect(
		await world.disposeSessionInBody(fresh.session),
		`${name}: the reopened owner disposes cleanly`,
	).toBeUndefined();
	trace.mark("root", scenario.mark);
}
