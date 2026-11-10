import "../builtin-install.ts";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { createBarrier } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { TIMEOUTS_PATH } from "./journey-5-plan-verify-rejected.ts";
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

const TITLE = "Raise the request timeout to 4000, have the change checked, and list who reads it";
const CHANGE = "raise-timeout";
const CHECK = "check-raise";
const LISTING = "list-readers";
const SUMMARY = "raise-summary";
const WORKER_STEPS = [CHANGE, CHECK, LISTING] as const;

/**
 * What the plan call's review reads for the one pair of steps the plan leaves unordered, the change and the listing: the two
 * say enough to tell, and the listing needs nothing only the change produces. The review adds no edge, so both start at once.
 */
const INDEPENDENT_PAIR_JUDGMENTS = {
	needs_output_of: { kind: "noul", probability: 0.02 },
	pair_evidence_sufficient: { kind: "noul", probability: 0.97 },
} as const;

/** What the durable projection holds for the plan's worker steps: each step's task, its attempts and whether it is settled. */
function workerStepFacts(session: AgentSession) {
	const plan = planTitled(session, TITLE);
	const snapshot = session.backgroundLanes.getTaskRuntimeSnapshot();
	const taskOf = (nodeId: string) => plan.nodes[nodeId]?.release?.taskId;
	const attemptsOf = (nodeId: string) => {
		const taskId = taskOf(nodeId);
		const attemptIds = taskId === undefined ? [] : (snapshot?.tasks[taskId]?.attemptIds ?? []);
		return attemptIds.map((attemptId) => snapshot?.attempts[attemptId]);
	};
	return {
		tasks: WORKER_STEPS.map(taskOf),
		attemptIds: WORKER_STEPS.map((nodeId) => attemptsOf(nodeId).map((attempt) => attempt?.attemptId)),
		statuses: WORKER_STEPS.map((nodeId) => attemptsOf(nodeId).map((attempt) => attempt?.status)),
		reasons: WORKER_STEPS.map((nodeId) => attemptsOf(nodeId).map((attempt) => attempt?.reasonCode)),
		leased: WORKER_STEPS.map((nodeId) => attemptsOf(nodeId).map((attempt) => attempt?.lease !== undefined)),
		settled: WORKER_STEPS.map(
			(nodeId) => plan.nodes[nodeId]?.settled !== undefined || plan.nodes[nodeId]?.join !== undefined,
		),
		summarySettled: plan.nodes[SUMMARY]?.join !== undefined,
		closed: plan.closed?.status,
	};
}

/**
 * Restart mid-plan. A plan changes a file, has the change checked and lists the file's readers. The owner closes the
 * session while the listing step's worker is in flight and the check's worker waits for room, and opens it again. The
 * step that had finished is not run again; the check runs as the review of that step (the verifier's prompt names the
 * step's task, and its own task quotes the step's task as dispatched); the listing step's worker goes on with the task
 * it was given; every step keeps the task and the one attempt it had; the plan closes; and the reopened root is told of
 * the check and of the plan's result, once each.
 */
export async function runJourney5PlanRestartPhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	const fleet = world.settingsManager.getGlobalSettings().fleet ?? {};
	const owner = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
	const started = createBarrier();
	const changeMayReport = createBarrier();
	// Never released: the close ends the request this step answers, and the worker's next request is the one after the reopen.
	const endedByTheClose = createBarrier();
	const checkRead = createBarrier();
	const done = createBarrier();
	let verifierPrompt = "";
	let verifierTask: string[] = [];
	let resumedTask: string[] = [];
	let checkUpdate: string[] = [];
	let doneUpdate: string[] = [];
	const mark = world.provider.reached.length;
	enqueueStepWorker(
		world,
		CHANGE,
		{
			name: "j5-restart-change-edit",
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j5-restart-change-edit-1",
						name: "edit",
						arguments: {
							path: TIMEOUTS_PATH,
							edits: [{ oldText: "TIMEOUT_MS = 3000", newText: "TIMEOUT_MS = 4000" }],
						},
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			...reportStep(
				"j5-restart-change-report",
				{
					status: "completed",
					summary: "TIMEOUT_MS is 4000.",
					changes: [{ file: "src/timeouts.ts", what: "TIMEOUT_MS is 4000." }],
				},
				changeMayReport.promise,
			),
			check: (request) => {
				const edit = latestBatchResults(request).find((result) => result.toolName === "edit");
				if (edit?.isError) throw new Error(`the step's edit was refused: ${edit.text}`);
			},
		},
	);
	enqueueStepWorker(
		world,
		LISTING,
		reportStep(
			"j5-restart-listing-held",
			{ status: "completed", summary: "Never delivered: the session closes before this reply." },
			endedByTheClose.promise,
		),
		{
			...reportStep(
				"j5-restart-listing-report",
				{ status: "completed", summary: "TIMEOUT_MS is read in src/timeouts.ts only." },
				// The listing reports after the root has read the check, so the root's two wakes are told apart.
				checkRead.promise,
			),
			check: (request) => {
				resumedTask = stepTaskLines(request);
			},
		},
	);
	enqueueStepWorker(world, CHECK, {
		...reportStep("j5-restart-verdict", {
			status: "completed",
			summary: "src/timeouts.ts sets TIMEOUT_MS to 4000, as the task asked.",
			verdict: "accepted",
			reasonCodes: ["timeout_is_4000"],
		}),
		check: (request) => {
			verifierPrompt = request.context.systemPrompt ?? "";
			verifierTask = stepTaskLines(request);
		},
	});
	enqueueRoot(
		world,
		...planCallSteps(
			"j5-restart",
			{
				action: "start",
				title: TITLE,
				final: SUMMARY,
				steps: [
					{
						id: CHANGE,
						do: "In src/timeouts.ts set TIMEOUT_MS to 4000.",
						files: ["src/timeouts.ts"],
						proof: "diff",
					},
					{
						id: CHECK,
						do: "Confirm that src/timeouts.ts sets TIMEOUT_MS to 4000.",
						join: "verify",
						uses: [CHANGE],
					},
					{
						id: LISTING,
						do: "Search the project for every place that reads TIMEOUT_MS and report each file and line. Change no file.",
					},
					{
						id: SUMMARY,
						do: "Combine the checked change and the list of readers into one result.",
						join: "collect",
						uses: [CHECK, LISTING],
					},
				],
			},
			"PLAN_STARTED",
			() => started.release(),
		),
		planUpdateStep("j5-restart-checked", "JOIN_DONE", (request) => {
			checkUpdate = deliveredLines(request);
			checkRead.release();
		}),
		planUpdateStep("j5-restart-wake", "PLAN_DONE", (request) => {
			doneUpdate = deliveredLines(request);
			done.release();
		}),
	);
	world.systemOne.enterPhase("j5-restart", {
		...PLAN_CALL_JUDGMENTS,
		...INDEPENDENT_PAIR_JUDGMENTS,
		...CHANGED_FILE_ANSWER_CLAIMS,
	});
	await withDeadline(
		trace,
		"J5 restart turn",
		owner.session.prompt("Raise the request timeout to 4000, have the change checked, and list who reads it."),
	);
	await withDeadline(trace, "J5 restart: the plan started", started.promise);
	await withDeadline(
		trace,
		"J5 restart: the change and the listing are in flight",
		Promise.all([
			world.provider.whenReached(stepReached(CHANGE, "j5-restart-change-report"), mark),
			world.provider.whenReached(stepReached(LISTING, "j5-restart-listing-held"), mark),
		]),
	);
	// The owner lowers the ceiling to one worker while two run: neither is stopped, and no other starts until one ends.
	world.settingsManager.setFleetSettings({ ...fleet, ceiling: { ...fleet.ceiling, running: 1 } });
	changeMayReport.release();
	// The change settles and its check is released. One worker runs of one allowed, so the check waits for room.
	await withDeadline(
		trace,
		"J5 restart: the check waits for room behind the listing",
		whenPlanState(owner.session, () => workerStepFacts(owner.session).statuses[1]?.[0] === "queued"),
		60_000,
	);
	const before = workerStepFacts(owner.session);
	expect(
		{
			released: before.tasks.map((taskId) => typeof taskId === "string"),
			statuses: before.statuses,
			leased: { check: before.leased[1], listing: before.leased[2] },
			settled: before.settled,
			summarySettled: before.summarySettled,
			closed: before.closed,
			file: world.io.readFileSync(TIMEOUTS_PATH, "utf8"),
		},
		"at the close the change is done, its check waits for room with no lease, and the listing's worker is in flight",
	).toEqual({
		released: [true, true, true],
		statuses: [["completed"], ["queued"], ["running"]],
		leased: { check: [false], listing: [true] },
		settled: [true, false, false],
		summarySettled: false,
		closed: undefined,
		file: "export const TIMEOUT_MS = 4000;\n",
	});
	const sessionFile = owner.sessionManager.getSessionFile();
	if (sessionFile === undefined) throw new Error("the plan's owner has no session file");
	expect(await world.disposeSessionInBody(owner.session), "the plan's owner closes cleanly mid-plan").toBeUndefined();
	await world.provider.waitForProducers();
	world.certifyDisposedOwner(owner.session, []);
	const closed = workerStepFacts(owner.session);
	expect(
		{
			sameTasks: closed.tasks,
			sameAttempts: closed.attemptIds,
			statuses: closed.statuses,
			interrupted: closed.reasons[2],
			settled: closed.settled,
			closed: closed.closed,
		},
		"the close interrupts the worker in flight and leaves the waiting check and the plan as they were: nothing is cancelled",
	).toEqual({
		sameTasks: before.tasks,
		sameAttempts: before.attemptIds,
		statuses: [["completed"], ["queued"], ["suspended"]],
		interrupted: ["agent_process_interrupted"],
		settled: [true, false, false],
		closed: undefined,
	});
	const fresh = await world.createRootSession("root", { sessionManager: world.openSessionManager(sessionFile) });
	// The host's first read of the session's work is where a reopened session takes its workers up again.
	fresh.session.getLaneRecords();
	await withDeadline(trace, "J5 restart: the check's result woke the reopened root", checkRead.promise, 60_000);
	await withDeadline(trace, "J5 restart: the plan's result woke the reopened root", done.promise, 60_000);
	await withDeadline(trace, "J5 restart: root idle", fresh.session.waitForForegroundIdle());
	const after = workerStepFacts(fresh.session);
	const plan = planTitled(fresh.session, TITLE);
	const [changeTaskId, checkTaskId] = after.tasks;
	const change = latestAttemptOf(fresh.session, changeTaskId);
	const check = plan.nodes[CHECK]?.join;
	const summary = plan.nodes[SUMMARY]?.join;
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
			check: checked && { status: checked.status, blocker: checked.blocker, assurance: checked.assurance },
			summary: summed && { status: summed.status, scope: summed.scope, blocker: summed.blocker },
			closed: plan.closed?.status,
			retired: plan.retired,
			file: world.io.readFileSync(TIMEOUTS_PATH, "utf8"),
		},
		"after the reopen every step kept its task and its one attempt, the check ran as the review of the change, the listing went on with its task, and the plan closed",
	).toEqual({
		sameTasks: before.tasks,
		sameAttempts: before.attemptIds,
		statuses: [["completed"], ["completed"], ["completed"]],
		settled: [true, true, true],
		verifierRole: "verifier",
		verifierMayChange: { readOnly: true, writePaths: [], editTools: [] },
		promptNamesTheStep: true,
		subject: [`Independently verify durable task '${changeTaskId}', attempt '${change?.attemptId}'.`],
		subjectTask: ["Task: In src/timeouts.ts set TIMEOUT_MS to 4000."],
		resumedTask: [
			"Task: Search the project for every place that reads TIMEOUT_MS and report each file and line. Change no file.",
		],
		check: { status: "succeeded", blocker: "none", assurance: "independently_verified" },
		summary: { status: "succeeded", scope: "join", blocker: "none" },
		closed: "settled",
		retired: [],
		file: "export const TIMEOUT_MS = 4000;\n",
	});
	const result = JSON.parse(String(world.io.readFileSync(summary!.artifact, "utf8"))) as {
		kind: string;
		members: { nodeId: string; status: string }[];
		gaps: string[];
	};
	expect(
		{ kind: result.kind, members: result.members.map((member) => [member.nodeId, member.status]), gaps: result.gaps },
		"the plan's result names the check and the listing as succeeded with no gap",
	).toEqual({
		kind: "collect",
		members: [
			[CHECK, "succeeded"],
			[LISTING, "succeeded"],
		],
		gaps: [],
	});
	const reached = world.provider.reached.slice(mark);
	expect(
		{
			root: reached.filter((key) => key.startsWith(`${ROOT_TRACK}:`)),
			workers: WORKER_STEPS.map((nodeId) => reached.filter((key) => key.startsWith(`${stepTrack(nodeId)}:`))),
			updates: [checkUpdate, doneUpdate].map((lines) => lines.filter((line) => line.includes("h PLAN_UPDATE,"))),
		},
		"the change was not run again, the check asked its model once and after the reopen, the listing asked again after the close ended its first request, and the reopened root was woken by the check and by the plan's result",
	).toEqual({
		root: [
			`${ROOT_TRACK}:j5-restart-call`,
			`${ROOT_TRACK}:j5-restart-result`,
			`${ROOT_TRACK}:j5-restart-checked`,
			`${ROOT_TRACK}:j5-restart-wake`,
		],
		workers: [
			[stepReached(CHANGE, "j5-restart-change-edit"), stepReached(CHANGE, "j5-restart-change-report")],
			[stepReached(CHECK, "j5-restart-verdict")],
			[stepReached(LISTING, "j5-restart-listing-held"), stepReached(LISTING, "j5-restart-listing-report")],
		],
		updates: [["h PLAN_UPDATE,JOIN_DONE,READ_REPORT"], ["h PLAN_UPDATE,PLAN_DONE,READ_REPORT"]],
	});
	world.settingsManager.setFleetSettings(fleet);
	expect(await world.disposeSessionInBody(fresh.session), "the reopened owner disposes cleanly").toBeUndefined();
	trace.mark("root", "j5.plan-restart");
}
