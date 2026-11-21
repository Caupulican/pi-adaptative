/**
 * A request waiting on the worker it launched is bounded: after 60 minutes without the worker's report, one of the
 * request's three automatic continuations checks on it, and the request waits again. With every continuation spent it is
 * held for the owner, and it still settles when the worker reports: the wake that delivers the report is reviewed as the
 * request's stop.
 */
import { expect } from "vitest";
import { formatSessionAutonomyStatus } from "../../../../src/core/autonomy-status/format.ts";
import { ORDINARY_WORK_CONTINUATION_TYPE } from "../../../../src/core/ordinary-work-policy.ts";
import { ORDINARY_WORK_WORKER_WAIT_MS } from "../../../../src/core/ordinary-work-wait.ts";
import { WALL_ALARM_RECHECK_MS } from "../../../../src/kernel/timer-port.ts";
import { calls, createBarrier, text } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { J9_ROOT_JUDGMENTS, J9_ROOT_REPLY, J9_SETTINGS, workerReport } from "./journey-9-shared.ts";
import { LIMITS_PATH, latestBatchResults, ORIGINAL_LIMITS, requestTexts } from "./shared.ts";

const LABEL = "worker-wait";
const REQUEST = "Inspect the retry configuration and report the configured retry count.";
const ANSWER = "The configured retry count in src/limits.ts is three.";
const KEEP_WAITING = "Keep waiting for the worker.";
const CHECK_ON_WORKER =
	"A worker this request launched has not reported its result within 60 minutes. Check its progress, then cancel it, redirect it, or keep waiting for it, and say which. Do not redo its work while it still runs.";

export async function exerciseWorkerWaitBound(world: HarnessWorld): Promise<void> {
	const agentDir = `${world.agentDir}-${LABEL}`;
	const judgmentMark = world.systemOne.decoded.length;
	world.systemOne.enterPhase(LABEL, J9_ROOT_JUDGMENTS);
	const { session, sessionManager } = await world.createRootSession("root", {
		agentDir,
		sessionManager: world.createSessionManager(agentDir),
		settings: {
			...J9_SETTINGS,
			memorySystem: "okf",
			autoLearn: { enabled: false },
			worktreeSync: { enabled: true },
			modelRouter: { fitnessGate: false },
		},
	});
	const wait = <T>(step: string, pending: Promise<T>) => withDeadline(world.trace, `${LABEL}-${step}`, pending);
	const rows = () => session.getDecisionLedger()!.ordinaryWork.forSession(sessionManager.getSessionId());
	const attempts = () => Object.values(session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {});
	const stopReviews = () =>
		world.systemOne.decoded.slice(judgmentMark).filter((request) => "disposition" in request.questions);
	const reached = createBarrier();
	const gate = createBarrier();
	const answered = createBarrier();
	world.provider.enqueue(
		"root",
		calls(`${LABEL}-start`, [
			{
				id: `${LABEL}-delegate`,
				name: "delegate",
				arguments: {
					action: "start",
					model: "worker-a",
					instructions: "Read limits.ts and report the configured retry count.",
					path: "src",
					readOnly: true,
				},
			},
		]),
		text(`${LABEL}-accepted`, J9_ROOT_REPLY),
	);
	world.provider.enqueue(
		"worker-a",
		{
			...calls(`${LABEL}-read`, [{ id: `${LABEL}-read`, name: "read", arguments: { path: LIMITS_PATH } }]),
			check: () => reached.release(),
		},
		{
			...workerReport(`${LABEL}-report`, { status: "completed", summary: ANSWER }),
			gate: gate.promise,
			check: (request) =>
				expect(latestBatchResults(request)).toContainEqual({
					toolName: "read",
					isError: false,
					text: expect.stringContaining(ORIGINAL_LIMITS.trim()),
				}),
		},
	);
	try {
		await wait("owner-turn", session.prompt(REQUEST));
		await wait("worker-running", reached.promise);
		await wait("owner-turn-idle", session.waitForForegroundIdle());
		expect(rows(), "the request waits on the worker it launched").toEqual([
			expect.objectContaining({ status: "waiting", reason: "waiting", continuationCount: 0 }),
		]);
		expect(world.timers.armedDelays("ordinary-work"), "one alarm bounds the wait").toEqual([WALL_ALARM_RECHECK_MS]);

		// Each bound that passes spends one continuation on a check of the worker; the request then waits again.
		for (let used = 1; used <= 3; used++) {
			const asked = createBarrier();
			world.provider.enqueue("root", {
				...text(`${LABEL}-check-${used}`, J9_ROOT_REPLY),
				check: (request) => {
					expect(
						requestTexts(request).filter((value) => value.includes(CHECK_ON_WORKER)),
						"every check so far reaches the model",
					).toHaveLength(used);
					asked.release();
				},
			});
			expect(world.timers.advance("ordinary-work", ORDINARY_WORK_WORKER_WAIT_MS)).toBeGreaterThan(0);
			await wait(`check-${used}`, asked.promise);
			await wait(`check-${used}-idle`, session.waitForForegroundIdle());
			expect(rows(), `after check ${used} the request waits on its worker again`).toEqual([
				expect.objectContaining({ status: "waiting", reason: "waiting", continuationCount: used }),
			]);
			expect(attempts(), "a check never starts another worker").toHaveLength(1);
		}

		// With every continuation spent, the next bound holds the request for the owner without a model call.
		const requestsBefore = world.provider.requests.length;
		expect(world.timers.advance("ordinary-work", ORDINARY_WORK_WORKER_WAIT_MS)).toBeGreaterThan(0);
		await wait("exhausted-idle", session.waitForForegroundIdle());
		expect(world.provider.requests.length, "the exhausted wait calls no model").toBe(requestsBefore);
		expect(rows()).toEqual([
			expect.objectContaining({ status: "owner_needed", reason: "worker_wait_exhausted", continuationCount: 3 }),
		]);
		const held = await session.autonomyStatus();
		expect(held.ordinaryWork).toMatchObject({
			status: "available",
			value: { state: "owner_needed", reason: "worker_wait_exhausted", continuationsUsed: 3, continuationLimit: 3 },
		});
		const shown = formatSessionAutonomyStatus(held);
		for (const line of [
			"Request needs owner input.",
			"A worker this request launched kept it waiting past every automatic check; decide whether to keep waiting.",
			"Automatic continuations: 3/3 spent.",
		])
			expect(shown, "/status names the hold and its reason").toContain(line);

		// The owner answers the hold: the reply joins the held request, which waits on its worker again for a fresh bound and
		// is held again when that bound passes with no continuation left.
		world.systemOne.enterPhase(`${LABEL}-keep-waiting`, {});
		world.provider.enqueue("root", text(`${LABEL}-keep-waiting`, J9_ROOT_REPLY));
		await wait("keep-waiting", session.prompt(KEEP_WAITING));
		await wait("keep-waiting-idle", session.waitForForegroundIdle());
		expect(rows(), "the owner's reply joins the held request instead of opening another").toEqual([
			expect.objectContaining({ status: "waiting", reason: "waiting", continuationCount: 3 }),
		]);
		expect(world.timers.armedDelays("ordinary-work"), "the joined request is bounded again").toEqual([
			WALL_ALARM_RECHECK_MS,
		]);
		const requestsBeforeSecondBound = world.provider.requests.length;
		expect(world.timers.advance("ordinary-work", ORDINARY_WORK_WORKER_WAIT_MS)).toBeGreaterThan(0);
		await wait("exhausted-again-idle", session.waitForForegroundIdle());
		expect(world.provider.requests.length, "the second exhausted wait calls no model").toBe(
			requestsBeforeSecondBound,
		);
		expect(rows()).toEqual([
			expect.objectContaining({ status: "owner_needed", reason: "worker_wait_exhausted", continuationCount: 3 }),
		]);
		expect(stopReviews(), "no stop judgment is asked while the worker runs").toEqual([]);

		// The worker reports: the wake that delivers it is reviewed, and the held request settles.
		world.provider.enqueue("root", {
			...text(`${LABEL}-delivered`, ANSWER),
			check: (request) => {
				expect(
					requestTexts(request).some((value) => value.includes("Background worker terminal handoff")),
					"the wake carries the worker's report",
				).toBe(true);
				world.systemOne.enterPhase(`${LABEL}-delivered`, {
					disposition: { kind: "choice", choice: "fulfilled", confidence: 0.99 },
					delivered_in_answer: { kind: "noul", probability: 0.99 },
					evidence_sufficient: { kind: "noul", probability: 0.99 },
				});
				answered.release();
			},
		});
		gate.release();
		await wait("delivered", answered.promise);
		await wait("delivered-idle", session.waitForForegroundIdle());
		expect(attempts()[0]?.result, "the worker's report is its result").toMatchObject({ summary: ANSWER });
		const settled = world.systemOne.enabled ? "fulfilled" : "unverified";
		expect(rows(), "the held request settles on the worker's report").toEqual([
			expect.objectContaining({ status: settled, continuationCount: 3 }),
		]);
		const reviews = stopReviews();
		if (world.systemOne.enabled) {
			expect(reviews, "one stop judgment, on the delivered answer").toHaveLength(1);
			expect(reviews[0]?.state).toMatchObject({
				// The owner's reply to the hold joined the request, so the request judged is both of the owner's messages.
				request: `${REQUEST}\n\n${KEEP_WAITING}`,
				answer: ANSWER,
				hostFacts: {
					terminalStopReason: "stop",
					finalAnswerPresent: true,
					pendingBackgroundWork: "workers_reported",
				},
			});
		} else expect(reviews).toEqual([]);
		expect(attempts(), "the request kept its one worker").toHaveLength(1);
		expect(world.provider.reached.filter((name) => name === `worker-a:${LABEL}-report`)).toHaveLength(1);
		expect(
			sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom_message" && entry.customType === ORDINARY_WORK_CONTINUATION_TYPE)
				.map((entry) => (entry.type === "custom_message" ? entry.content : undefined)),
			"three checks, each the whole sentence",
		).toEqual([CHECK_ON_WORKER, CHECK_ON_WORKER, CHECK_ON_WORKER]);
		expect(session.getLastAssistantText()).toBe(ANSWER);
	} finally {
		gate.release();
		expect(await world.disposeSessionInBody(session), `${LABEL}: no retained work`).toBeUndefined();
	}
	world.trace.mark("root", LABEL);
}
