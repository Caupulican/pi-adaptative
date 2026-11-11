import "../builtin-install.ts";
import { expect } from "vitest";
import {
	captureWorkerReceiptOrigin,
	WORKER_RECEIPT_ORIGIN_CUSTOM_TYPE,
} from "../../../../src/core/delegation/worker-receipt-origin.ts";
import { HARNESS_NOTICE_CUSTOM_TYPE } from "../../../../src/core/harness-notice.ts";
import { SessionManager } from "../../../../src/kernel/session/session-manager.ts";
import { createBarrier, HARNESS_PROVIDER, type ScriptedRequest } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, withDeadline } from "../session-fixture.ts";
import {
	deliveredLine,
	enqueueRoot,
	enqueueStepWorker,
	INTAKE_JUDGMENTS,
	latestAttemptOf,
	PLAN_CALL_JUDGMENTS,
	planCallSteps,
	planTitled,
	planUpdateStep,
	reportStep,
	stepReached,
	whenPlanState,
} from "./journey-5-shared.ts";
import { latestBatchResults, refusalDiagnostic } from "./shared.ts";

const COLLECT_TITLE = "Combine the retry limit and timeout in an in-memory session";
const CANCEL_TITLE = "Cancel an in-memory plan without touching an unrelated worker";
const STANDALONE_TASK = "Inspect src/limits.ts outside any plan and wait before reporting.";

function planRefusalOf(request: ScriptedRequest): { isError: boolean; text: string } | undefined {
	const result = latestBatchResults(request).find((entry) => entry.toolName === "plan");
	return result && { isError: result.isError, text: refusalDiagnostic(result.text) ?? result.text };
}

function collectSteps(withInvalidQuestion: boolean) {
	return [
		{ id: "mem-exports", do: "Read src/limits.ts and report the constant it exports." },
		{ id: "mem-usage", do: "Read src/timeouts.ts and report the constant it exports." },
		{
			id: "mem-combined",
			do: "Put the two exported constants together.",
			uses: ["mem-exports", "mem-usage"],
			join: "collect",
			...(withInvalidQuestion ? { question: "Which constant is larger?" } : {}),
		},
	];
}

async function waitUntil(trace: HarnessWorld["trace"], label: string, predicate: () => boolean): Promise<void> {
	await withDeadline(
		trace,
		label,
		(async () => {
			while (!predicate()) {
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
		})(),
	);
}

/**
 * In-memory plan lifecycle (in-memory delivery, collect question refusal, and plan-scoped fleet cancel):
 * 1. An unpersisted `SessionManager.inMemory(...)` session records a `harness-notice` on its empty in-memory branch
 *    (minting the origin anchor without touching disk) and surfaces it on the next owner turn.
 * 2. Starting a `collect` join with `question` is refused cleanly before recording a plan; starting the valid
 *    two-step `collect` plan runs to completion and delivers `PLAN_UPDATE,PLAN_DONE` through `ParentInputDeliveryCoordinator`
 *    into the in-memory session without requiring a durable session file.
 * 3. Starting a second plan alongside an unrelated standalone worker, then cancelling the plan (`plan` `cancel`), drives
 *    `FleetScheduler.cancel({ kind: "plan", planId })` to cancel both the plan's running step and its fleet-queued step
 *    while leaving the dependent step unreleased and the standalone worker running.
 */
export async function runJourney5PlanInMemoryPhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	const savedFleet = world.settingsManager.getGlobalSettings().fleet ?? {};
	const sessionManager = SessionManager.inMemory(HARNESS_PROJECT_CWD);
	expect(sessionManager.isPersisted(), "the root session starts purely in memory").toBe(false);
	expect(sessionManager.getSessionFile(), "an in-memory session has no backing file").toBeUndefined();
	expect(sessionManager.getLeafId(), "the fresh in-memory branch starts empty").toBeNull();
	const emptyOrigin = captureWorkerReceiptOrigin(sessionManager);
	expect(emptyOrigin.sessionFile, "in-memory origin anchor has no session file").toBeUndefined();
	expect(sessionManager.getLeafId(), "capturing origin on an empty branch mints a non-null leaf").toBe(
		emptyOrigin.leafId,
	);

	const { session } = await world.createRootSession("root", { sessionManager });
	try {
		// Registering a channel with no policy observes a `channel-state` harness notice (`next-owner-turn`) while the
		// in-memory branch is still empty (`leafId === null`), exercising origin-anchor mint + in-memory save.
		session.registerChannelProvider({
			name: "feed",
			start() {},
			send() {},
			stop() {},
		});
		await waitUntil(trace, "in-memory harness notice recorded", () =>
			sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom_message" && entry.customType === HARNESS_NOTICE_CUSTOM_TYPE),
		);
		expect(sessionManager.isPersisted(), "saving a harness notice never promotes an in-memory session to disk").toBe(
			false,
		);
		expect(
			sessionManager
				.getEntries()
				.flatMap((entry) => (entry.type === "custom" || entry.type === "custom_message" ? [entry.customType] : [])),
			"the empty in-memory branch mints its origin anchor and persists the harness notice",
		).toEqual([WORKER_RECEIPT_ORIGIN_CUSTOM_TYPE, HARNESS_NOTICE_CUSTOM_TYPE]);

		// --- Part 1: collect+question refusal, followed by a 2-step collect plan settling in memory ---
		const exportsMayReport = createBarrier();
		const usageMayReport = createBarrier();
		const collectDone = createBarrier();
		let refusedCallResult: { isError: boolean; text: string } | undefined;
		let plansAfterRefusal = -1;
		let sawNoticeInPrompt = false;
		let settledDoneHeadline = "";

		enqueueStepWorker(
			world,
			"mem-exports",
			reportStep(
				"j5-mem-exports-report",
				{ status: "completed", summary: "src/limits.ts exports MAX_RETRIES = 3." },
				exportsMayReport.promise,
			),
		);
		enqueueStepWorker(
			world,
			"mem-usage",
			reportStep(
				"j5-mem-usage-report",
				{ status: "completed", summary: "src/timeouts.ts exports TIMEOUT_MS = 1000." },
				usageMayReport.promise,
			),
		);
		enqueueRoot(
			world,
			{
				name: "j5-mem-refused-call",
				check: (request) => {
					const serialized = JSON.stringify(request.context.messages);
					sawNoticeInPrompt = serialized.includes("Harness notice:") && serialized.includes("feed");
				},
				reply: {
					content: [
						{
							type: "toolCall",
							id: "j5-mem-refused-1",
							name: "plan",
							arguments: { action: "start", title: COLLECT_TITLE, steps: collectSteps(true) },
						},
					],
					stopReason: "toolUse",
				},
			},
			{
				name: "j5-mem-accepted-call",
				check: (request) => {
					refusedCallResult = planRefusalOf(request);
					plansAfterRefusal = Object.keys(session.backgroundLanes.getTaskRuntimeSnapshot()?.plans ?? {}).length;
				},
				reply: {
					content: [
						{
							type: "toolCall",
							id: "j5-mem-accepted-1",
							name: "plan",
							arguments: { action: "start", title: COLLECT_TITLE, steps: collectSteps(false) },
						},
					],
					stopReason: "toolUse",
				},
			},
			{
				name: "j5-mem-accepted-result",
				check: (request) => {
					const result = latestBatchResults(request).find((entry) => entry.toolName === "plan");
					if (result?.isError || !result?.text.includes("PLAN_STARTED")) {
						throw new Error(`the valid in-memory plan did not start: ${result?.text ?? "no result"}`);
					}
				},
				reply: { content: [{ type: "text", text: "The in-memory plan is running." }] },
			},
			planUpdateStep("j5-mem-collect-done", "PLAN_DONE", (request) => {
				settledDoneHeadline = deliveredLine(request, "h PLAN_UPDATE,");
				collectDone.release();
			}),
		);

		world.systemOne.enterPhase("j5-in-memory-collect", PLAN_CALL_JUDGMENTS);
		await withDeadline(
			trace,
			"J5 in-memory collect start turn",
			session.prompt("Combine the exported constants from src/limits.ts and src/timeouts.ts."),
		);
		expect(sawNoticeInPrompt, "the recorded harness notice reaches the next owner turn in memory").toBe(true);
		expect(refusedCallResult?.isError, "a question on a collect join is refused").toBe(true);
		expect(refusedCallResult?.text).toContain(
			'step "mem-combined" is a collect join; question belongs to a reduce, verify, or vote step',
		);
		expect(plansAfterRefusal, "the refused collect+question plan records no durable plan").toBe(0);

		await withDeadline(
			trace,
			"J5 in-memory collect steps released",
			whenPlanState(session, () => {
				const plan = planTitled(session, COLLECT_TITLE);
				return plan.nodes["mem-exports"]?.release !== undefined && plan.nodes["mem-usage"]?.release !== undefined;
			}),
		);
		exportsMayReport.release();
		usageMayReport.release();
		await withDeadline(trace, "J5 in-memory collect update delivered", collectDone.promise);
		await withDeadline(trace, "J5 in-memory collect idle", session.waitForForegroundIdle());

		const settledPlan = planTitled(session, COLLECT_TITLE);
		expect(settledPlan.closed?.status, "the 2-step collect plan settles cleanly").toBe("settled");
		expect(settledDoneHeadline, "ParentInputDeliveryCoordinator delivers PLAN_DONE to the in-memory root").toBe(
			"PLAN_DONE,READ_REPORT",
		);
		expect(sessionManager.isPersisted(), "plan delivery keeps the session purely in memory").toBe(false);
		expect(sessionManager.getSessionFile(), "no physical session file is created").toBeUndefined();
		const branchJson = JSON.stringify(sessionManager.getBranch());
		expect(branchJson, "the in-memory branch retains the harness notice").toContain(HARNESS_NOTICE_CUSTOM_TYPE);
		expect(branchJson, "the in-memory branch retains the delivered PLAN_UPDATE").toContain(
			"PLAN_UPDATE,PLAN_DONE,READ_REPORT",
		);
		expect(branchJson, "the in-memory branch names the settled plan id").toContain(settledPlan.record.planId);

		// --- Part 2: Fleet plan-scope cancel (`cancel({ kind: "plan", planId })`) ---
		// Running ceiling of 2: the standalone worker takes slot 1, `mem-cancel-run` takes slot 2 (`running`),
		// `mem-cancel-queue` waits in `FleetScheduler` (`queued`), and `mem-cancel-after` waits on `mem-cancel-run`.
		world.settingsManager.setFleetSettings({ ...savedFleet, ceiling: { ...savedFleet.ceiling, running: 2 } });

		const standaloneRunning = createBarrier();
		const standaloneMayReport = createBarrier();
		const standaloneHandedOff = createBarrier();
		const cancelRunStarted = createBarrier();
		const cancelRunGate = createBarrier();
		const reachedBeforePlan2 = world.provider.reached.length;

		world.provider.enqueueTrack(
			"j5-mem-standalone",
			"worker-a",
			(request) => JSON.stringify(request.context.messages).includes(STANDALONE_TASK),
			{
				name: "j5-mem-standalone-hold",
				check: () => {
					standaloneRunning.release();
				},
				gate: standaloneMayReport.promise,
				reply: {
					content: [
						{
							type: "toolCall",
							id: "j5-mem-standalone-report-1",
							name: "submit_report",
							arguments: { status: "completed", summary: "Standalone inspection of MAX_RETRIES finished." },
						},
					],
					stopReason: "toolUse",
				},
			},
		);
		enqueueStepWorker(world, "mem-cancel-run", {
			name: "j5-mem-cancel-run-hold",
			check: () => {
				cancelRunStarted.release();
			},
			gate: cancelRunGate.promise,
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j5-mem-cancel-run-report-1",
						name: "submit_report",
						arguments: { status: "completed", summary: "MAX_RETRIES is 3." },
					},
				],
				stopReason: "toolUse",
			},
		});

		enqueueRoot(
			world,
			{
				name: "j5-mem-standalone-start",
				reply: {
					content: [
						{
							type: "toolCall",
							id: "j5-mem-standalone-call-1",
							name: "delegate",
							arguments: {
								action: "start",
								model: { provider: HARNESS_PROVIDER, modelId: "worker-a" },
								instructions: STANDALONE_TASK,
								readOnly: true,
							},
						},
					],
					stopReason: "toolUse",
				},
			},
			{
				name: "j5-mem-plan2-call",
				check: (request) => {
					const started = latestBatchResults(request).find((entry) => entry.toolName === "delegate");
					if (started?.isError || !started?.text.includes("delegate started (running)")) {
						throw new Error(`the standalone worker did not start running: ${started?.text ?? "no result"}`);
					}
				},
				reply: {
					content: [
						{
							type: "toolCall",
							id: "j5-mem-plan2-call-1",
							name: "plan",
							arguments: {
								action: "start",
								title: CANCEL_TITLE,
								steps: [
									{
										id: "mem-cancel-run",
										do: "Read src/limits.ts and wait before reporting MAX_RETRIES.",
									},
									{ id: "mem-cancel-queue", do: "Read src/timeouts.ts and report TIMEOUT_MS." },
									{
										id: "mem-cancel-after",
										do: "Summarize MAX_RETRIES after mem-cancel-run finishes.",
										uses: ["mem-cancel-run"],
									},
									{
										id: "mem-cancel-join",
										do: "Combine the timeout and retry summaries.",
										uses: ["mem-cancel-queue", "mem-cancel-after"],
										join: "collect",
									},
								],
							},
						},
					],
					stopReason: "toolUse",
				},
			},
			{
				name: "j5-mem-plan2-result",
				check: (request) => {
					const result = latestBatchResults(request).find((entry) => entry.toolName === "plan");
					if (result?.isError || !result?.text.includes("PLAN_STARTED")) {
						throw new Error(`the second in-memory plan did not start: ${result?.text ?? "no result"}`);
					}
				},
				reply: { content: [{ type: "text", text: "The second plan is running alongside the standalone worker." }] },
			},
		);

		world.systemOne.enterPhase("j5-in-memory-plan2-start", PLAN_CALL_JUDGMENTS);
		await withDeadline(
			trace,
			"J5 in-memory second plan start turn",
			session.prompt("Start the standalone limits inspection and the second constants plan."),
		);
		await withDeadline(trace, "standalone worker running", standaloneRunning.promise);
		await withDeadline(trace, "plan running step in flight", cancelRunStarted.promise);
		await waitUntil(trace, "queued sibling step parked in fleet", () => {
			const plan = planTitled(session, CANCEL_TITLE);
			const runTaskId = plan.nodes["mem-cancel-run"]?.release?.taskId;
			const queueTaskId = plan.nodes["mem-cancel-queue"]?.release?.taskId;
			return (
				latestAttemptOf(session, runTaskId)?.status === "running" &&
				latestAttemptOf(session, queueTaskId)?.status === "queued" &&
				plan.nodes["mem-cancel-after"]?.release === undefined
			);
		});

		const beforeCancelPlan = planTitled(session, CANCEL_TITLE);
		const runTaskId = beforeCancelPlan.nodes["mem-cancel-run"]?.release?.taskId;
		const queueTaskId = beforeCancelPlan.nodes["mem-cancel-queue"]?.release?.taskId;
		const standaloneTaskId = Object.entries(session.backgroundLanes.getTaskRuntimeSnapshot()?.tasks ?? {}).find(
			([, task]) =>
				task.attemptIds.some((id) =>
					session.backgroundLanes
						.getTaskRuntimeSnapshot()
						?.attempts[id]?.dispatch.instructions.includes(STANDALONE_TASK),
				),
		)?.[0];
		expect(standaloneTaskId, "standalone worker task is recorded").toBeDefined();

		let cancelResultText = "";
		enqueueRoot(
			world,
			...planCallSteps(
				"j5-mem-cancel",
				{ action: "cancel", reason: "The owner stopped the second in-memory plan." },
				"PLAN_UPDATE",
				(text) => {
					cancelResultText = text;
				},
			),
		);
		world.systemOne.enterPhase("j5-in-memory-plan2-cancel", INTAKE_JUDGMENTS);
		await withDeadline(trace, "J5 in-memory cancel turn", session.prompt("Cancel the second plan now."));
		expect(cancelResultText).toContain("The plan is cancelled; its running steps are stopped.");

		await waitUntil(trace, "plan running and queued lanes cancelled", () => {
			const plan = planTitled(session, CANCEL_TITLE);
			return (
				plan.closed?.status === "cancelled" &&
				latestAttemptOf(session, runTaskId)?.status === "cancelled" &&
				latestAttemptOf(session, queueTaskId)?.status === "cancelled"
			);
		});

		const cancelledPlan = planTitled(session, CANCEL_TITLE);
		const runAttempt = latestAttemptOf(session, runTaskId);
		const queueAttempt = latestAttemptOf(session, queueTaskId);
		const standaloneAttempt = latestAttemptOf(session, standaloneTaskId);
		expect(
			{
				planClosed: { status: cancelledPlan.closed?.status, reason: cancelledPlan.closed?.reason },
				hasClosedAt: typeof cancelledPlan.closed?.closedAt === "string",
				runningStepStatus: runAttempt?.status,
				queuedStep: { status: queueAttempt?.status, reasonCode: queueAttempt?.reasonCode },
				dependentReleased: cancelledPlan.nodes["mem-cancel-after"]?.release,
				queuedReachedProvider: world.provider.reached
					.slice(reachedBeforePlan2)
					.includes(stepReached("mem-cancel-queue", "any")),
				standaloneStatus: standaloneAttempt?.status,
			},
			"cancelling the plan cancels its running and fleet-queued lanes while sparing the unrelated standalone worker",
		).toEqual({
			planClosed: { status: "cancelled", reason: "The owner stopped the second in-memory plan." },
			hasClosedAt: true,
			runningStepStatus: "cancelled",
			queuedStep: { status: "cancelled", reasonCode: "plan_closed" },
			dependentReleased: undefined,
			queuedReachedProvider: false,
			standaloneStatus: "running",
		});
		expect(
			world.provider.reached.slice(reachedBeforePlan2).some((key) => key.startsWith("j5-mem-cancel-queue:")),
			"the fleet-queued step never made a provider request",
		).toBe(false);

		cancelRunGate.release();
		enqueueRoot(world, {
			name: "j5-mem-standalone-handoff",
			maxRequests: 8,
			until: (request) => {
				if (!JSON.stringify(request.context.messages).includes("Background worker terminal handoff")) return false;
				standaloneHandedOff.release();
				return true;
			},
			reply: { content: [{ type: "text", text: "Noted." }] },
		});
		standaloneMayReport.release();
		await withDeadline(trace, "J5 in-memory standalone handoff", standaloneHandedOff.promise);
		await withDeadline(trace, "J5 in-memory final idle", session.waitForForegroundIdle());
		trace.mark("root", "j5.in-memory");
	} finally {
		world.settingsManager.setFleetSettings(savedFleet);
		expect(await world.disposeSessionInBody(session), "the in-memory plan owner disposes cleanly").toBeUndefined();
	}
}
