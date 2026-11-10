import "../builtin-install.ts";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { createBarrier } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import {
	enqueueRoot,
	enqueueStepWorker,
	latestAttemptOf,
	PLAN_CALL_JUDGMENTS,
	planCallSteps,
	planTitled,
	planUpdateStep,
	reportStep,
	stepReached,
	stepTrack,
	whenPlanState,
} from "./journey-5-shared.ts";

const TITLE = "Read the limits module, have the reading checked, and scan three folders for its users";
const READING = "read-limits";
const CHECK = "check-reading";
const SCANS = ["scan-source", "scan-docs", "scan-scripts"] as const;
const SUMMARY = "order-summary";

/**
 * Order under a full fleet: two workers may run, and a plan has four steps that can start at once (a reading and three
 * scans) and a verify step over the reading. The reading and the first scan run; the other two scans wait for room. The
 * reading reports and its check is released behind the two scans that were already waiting. A verify step runs before
 * ordinary steps of its plan, so the check runs before the scan that is still waiting when room next frees, although that
 * scan has waited longer.
 */
export async function runJourney5PlanOrderPhase(world: HarnessWorld, session: AgentSession): Promise<void> {
	const trace = world.trace;
	const fleet = world.settingsManager.getGlobalSettings().fleet ?? {};
	const started = createBarrier();
	const readingMayReport = createBarrier();
	const secondScanMayReport = createBarrier();
	const firstScanMayReport = createBarrier();
	const checkRead = createBarrier();
	const done = createBarrier();
	const mark = world.provider.reached.length;
	enqueueStepWorker(
		world,
		READING,
		reportStep(
			"j5-order-reading-report",
			{ status: "completed", summary: "src/limits.ts exports MAX_RETRIES." },
			readingMayReport.promise,
		),
	);
	enqueueStepWorker(
		world,
		SCANS[0],
		reportStep(
			"j5-order-scan-source-report",
			{ status: "completed", summary: "src reads MAX_RETRIES in limits.ts only." },
			// The first scan holds its place until the root has read the check, so the root's two wakes are told apart.
			firstScanMayReport.promise,
		),
	);
	enqueueStepWorker(
		world,
		SCANS[1],
		reportStep(
			"j5-order-scan-docs-report",
			{ status: "completed", summary: "No document names MAX_RETRIES." },
			// The second scan frees its place only once the check is waiting too: the next place is then asked for by the check
			// and by the third scan, which has waited since the plan started.
			secondScanMayReport.promise,
		),
	);
	enqueueStepWorker(
		world,
		SCANS[2],
		reportStep("j5-order-scan-scripts-report", { status: "completed", summary: "No script reads MAX_RETRIES." }),
	);
	enqueueStepWorker(
		world,
		CHECK,
		reportStep("j5-order-verdict", {
			status: "completed",
			summary: "src/limits.ts exports MAX_RETRIES, as the reading says.",
			verdict: "accepted",
			reasonCodes: ["reading_is_right"],
		}),
	);
	enqueueRoot(
		world,
		...planCallSteps(
			"j5-order",
			{
				action: "start",
				title: TITLE,
				final: SUMMARY,
				steps: [
					{ id: READING, do: "Read src/limits.ts and report what it exports. Change no file." },
					{ id: CHECK, do: "Confirm what src/limits.ts exports.", join: "verify", uses: [READING] },
					{ id: SCANS[0], do: "Search src for every place that reads MAX_RETRIES. Change no file." },
					{ id: SCANS[1], do: "Search docs for every place that names MAX_RETRIES. Change no file." },
					{ id: SCANS[2], do: "Search scripts for every place that reads MAX_RETRIES. Change no file." },
					{
						id: SUMMARY,
						do: "Combine the checked reading and the three scans into one result.",
						join: "collect",
						uses: [CHECK, ...SCANS],
					},
				],
			},
			"PLAN_STARTED",
			() => started.release(),
		),
		planUpdateStep("j5-order-checked", "JOIN_DONE", () => checkRead.release()),
		planUpdateStep("j5-order-wake", "PLAN_DONE", () => done.release()),
	);
	const statusOf = (nodeId: string) =>
		latestAttemptOf(session, planTitled(session, TITLE).nodes[nodeId]?.release?.taskId)?.status;
	world.settingsManager.setFleetSettings({ ...fleet, ceiling: { ...fleet.ceiling, running: 2 } });
	world.systemOne.enterPhase("j5-order", PLAN_CALL_JUDGMENTS);
	await withDeadline(
		trace,
		"J5 order turn",
		session.prompt("Read the limits module, have the reading checked, and scan three folders for its users."),
	);
	await withDeadline(trace, "J5 order: the plan started", started.promise);
	await withDeadline(
		trace,
		"J5 order: the reading and the first scan are in flight",
		Promise.all([
			world.provider.whenReached(stepReached(READING, "j5-order-reading-report"), mark),
			world.provider.whenReached(stepReached(SCANS[0], "j5-order-scan-source-report"), mark),
		]),
	);
	expect(
		[READING, ...SCANS].map(statusOf),
		"two workers run of two allowed: the reading and the first scan run, and the other two scans wait for room",
	).toEqual(["running", "running", "queued", "queued"]);
	readingMayReport.release();
	// The reading settles and its check is released. Whichever of the waiting steps took the place the reading freed, the check
	// now waits or runs, and the third scan still waits.
	await withDeadline(
		trace,
		"J5 order: the check is released",
		whenPlanState(session, () => planTitled(session, TITLE).nodes[CHECK]?.release !== undefined),
		60_000,
	);
	secondScanMayReport.release();
	await withDeadline(trace, "J5 order: the check's result woke the root", checkRead.promise, 60_000);
	await withDeadline(
		trace,
		"J5 order: the third scan ran",
		world.provider.whenReached(stepReached(SCANS[2], "j5-order-scan-scripts-report"), mark),
		60_000,
	);
	firstScanMayReport.release();
	await withDeadline(trace, "J5 order: the plan's result woke the root", done.promise, 60_000);
	await withDeadline(trace, "J5 order: root idle", session.waitForForegroundIdle());
	world.settingsManager.setFleetSettings(fleet);
	const reached = world.provider.reached.slice(mark);
	const plan = planTitled(session, TITLE);
	expect(
		{
			checkBeforeTheWaitingScan:
				reached.indexOf(stepReached(CHECK, "j5-order-verdict")) <
				reached.indexOf(stepReached(SCANS[2], "j5-order-scan-scripts-report")),
			everyStepRanOnce: [READING, CHECK, ...SCANS].map(
				(nodeId) => reached.filter((key) => key.startsWith(`${stepTrack(nodeId)}:`)).length,
			),
			closed: plan.closed?.status,
		},
		"the check, released after the third scan had started waiting, ran before it, and every step ran once",
	).toEqual({
		checkBeforeTheWaitingScan: true,
		everyStepRanOnce: [1, 1, 1, 1, 1],
		closed: "settled",
	});
	trace.mark("root", "j5.plan-order");
}
