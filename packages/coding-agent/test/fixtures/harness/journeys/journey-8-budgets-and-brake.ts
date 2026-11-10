import "../builtin-install.ts";
import { expect } from "vitest";
import { type Barrier, createBarrier, type ScriptStep, text } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import {
	carriesMarker,
	delegateReceipts,
	fleetNow,
	handoffTurn,
	harnessNotices,
	J8_INTAKE_JUDGMENTS,
	noticesSaved,
	seedSpendFile,
	settle,
	spendFile,
	startOf,
	startStep,
	submitReport,
} from "./journey-8-shared.ts";
import { expectOwnerWords } from "./shared.ts";

/**
 * Leg 2: the day budget and the spend brake, which bind only paid work.
 *
 * A priced model is one an API key pays for, so its starts carry a metered estimate; a model with no price costs nothing
 * and is never held by dollars. With today's spend already at `fleet.budgets.meteredUsdPerDay`, a paid start waits on the
 * day budget while an unpriced one runs. Then a start waits on the running ceiling, and raising that ceiling alone does
 * not start it: the terminal of the worker that was running does. Finally, with the current 15-minute window's spend over
 * the brake's line, a paid start waits on the brake, the owner is told once, unpriced work still starts, and the owner's
 * continue lifts the brake for the rest of the window so the waiting paid start runs.
 */

/** The priced model: the world configures its price, so an estimate per worker exists. */
const PAID = "worker-b";
/** The unpriced models: nothing an API key pays for, so no dollars bind them. */
const FREE_A = "worker-a";
const FREE_B = "worker-c";

const PAID_PROMPT = "Start a paid worker and an unpaid one on the retry limit.";
const CEILING_PROMPT = "Start one more unpaid worker.";
const BRAKE_PROMPT = "Start a paid worker and an unpaid one again.";

/** The day budget the leg seeds as spent. */
const DAY_BUDGET_USD = 10;
/** The spend already in the current 15-minute window when the brake's half begins, and the line it crosses. */
const WINDOW_SPEND_USD = 5;
const BRAKE_LINE_USD = 1;
/**
 * The sentence the owner reads when the brake engages, as the product words it. The notice keeps it whole: it ends with
 * what keeps running, after the command that lifts the brake.
 */
const BRAKE_NOTICE = `Paid (API-key) worker starts are paused: $${WINDOW_SPEND_USD.toFixed(2)} spent in 15 minutes is above the $${BRAKE_LINE_USD.toFixed(2)} safety line. Resume now with /estop off, or wait for the next 15-minute window. Subscription work continues and running workers finish.`;

/** One worker of the leg: its model, the word that tells its task from its siblings', and what its lane does. */
interface Worker {
	readonly word: string;
	readonly model: string;
	readonly holds: Barrier;
	readonly firstRequest: Barrier;
	/** The step that answers its first request once the leg releases it. */
	readonly step: ScriptStep;
}

function instructionsOf(word: string): string {
	return `Report the retry limit in one line. You are worker ${word}.`;
}

export async function runJourney8MeteredPhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	// Today is spent up to its budget, and the current window has nothing in it yet.
	seedSpendFile(world, { now: fleetNow(world), dayUsd: DAY_BUDGET_USD, windowUsd: 0 });
	const sessionManager = world.createSessionManager();
	const { session } = await world.createRootSession("root", { sessionManager });

	const worker = (word: string, model: string): Worker => {
		const holds = createBarrier();
		const firstRequest = createBarrier();
		return {
			word,
			model,
			holds,
			firstRequest,
			step: {
				name: `j8b-${word}-report`,
				gate: holds.promise,
				check: () => firstRequest.release(),
				reply: submitReport(`j8b-${word}-report-1`, `Worker ${word} read the retry limit.`),
			},
		};
	};
	const paidOne = worker("paid one", PAID);
	const paidTwo = worker("paid two", PAID);
	const unpaidOne = worker("unpaid one", FREE_A);
	const unpaidTwo = worker("unpaid two", FREE_A);
	const ceilingWorker = worker("ceiling", FREE_B);
	for (const each of [paidOne, paidTwo, unpaidOne, unpaidTwo, ceilingWorker])
		world.provider.enqueueTrack(
			`j8b-${each.word}`,
			each.model,
			carriesMarker(`You are worker ${each.word}.`),
			each.step,
		);

	const wakes: Barrier[] = [];
	const wake = (): Barrier => {
		const barrier = createBarrier();
		wakes.push(barrier);
		return barrier;
	};
	const wakeAt = (index: number): Barrier => {
		const barrier = wakes[index];
		if (barrier === undefined) throw new Error(`no wake barrier at ${index}`);
		return barrier;
	};
	world.provider.enqueue(
		"root",
		startStep(session, "j8b-paid", "j8b-paid-1", instructionsOf(paidOne.word), PAID),
		startStep(session, "j8b-unpaid", "j8b-unpaid-1", instructionsOf(unpaidOne.word), FREE_A),
		text("j8b-paid-and-unpaid-done", "One paid start is queued and one unpaid worker runs."),
		startStep(session, "j8b-ceiling", "j8b-ceiling-1", instructionsOf(ceilingWorker.word), FREE_B),
		text("j8b-ceiling-done", "The second unpaid worker waits for room."),
		handoffTurn("j8b-wake-unpaid-one", wake()),
		startStep(session, "j8b-brake-paid", "j8b-brake-1", instructionsOf(paidTwo.word), PAID),
		startStep(session, "j8b-brake-unpaid", "j8b-brake-2", instructionsOf(unpaidTwo.word), FREE_A),
		text("j8b-brake-done", "The second paid start waits on the brake."),
		handoffTurn("j8b-wake-unpaid-two", wake()),
		handoffTurn("j8b-wake-ceiling", wake()),
		handoffTurn("j8b-wake-paid-one", wake()),
		handoffTurn("j8b-wake-paid-two", wake()),
	);
	world.systemOne.enterPhase("j8b-metered", J8_INTAKE_JUDGMENTS, {
		expect: expectOwnerWords({
			sessionManager: () => sessionManager,
			userRequests: [PAID_PROMPT, CEILING_PROMPT, BRAKE_PROMPT],
			optionalToolNames: ["secret_store"],
		}),
	});

	// 1. The day budget holds the paid start, and only the paid start.
	await withDeadline(trace, "the paid and unpaid starts", session.prompt(PAID_PROMPT));
	await withDeadline(trace, "the unpaid worker is held at its first request", unpaidOne.firstRequest.promise);
	const [paidReceipt, unpaidReceipt] = delegateReceipts(session).map(startOf);
	if (paidReceipt === undefined || unpaidReceipt === undefined) throw new Error("the first turn has two receipts");
	expect(
		{
			paid: { started: paidReceipt.started, h: paidReceipt.h },
			paidWords: paidReceipt.text.includes(
				`waiting: capacity: today's paid (API-key) worker budget of $${DAY_BUDGET_USD.toFixed(2)} is used up (since `,
			),
			unpaidState: unpaidReceipt.h,
		},
		`with today's paid budget used up the paid start waits on the day budget while the unpaid one runs: ${paidReceipt.text}`,
	).toEqual({ paid: { started: true, h: ["QUEUED"] }, paidWords: true, unpaidState: undefined });
	expect(
		{
			paidRequests: world.provider.requests.filter((request) => request.model.id === PAID).length,
			reservations: spendFile(world)?.reservations,
			dayUsd: spendFile(world)?.dayUsd,
		},
		"the waiting paid start sent no request and reserved no money against the budget",
	).toEqual({ paidRequests: 0, reservations: {}, dayUsd: DAY_BUDGET_USD });

	// 2. A start waits for the running ceiling, and raising the ceiling alone does not start it.
	world.settingsManager.setFleetSettings({
		...world.settingsManager.getGlobalSettings().fleet,
		ceiling: { ...world.settingsManager.getGlobalSettings().fleet?.ceiling, running: 1 },
	});
	await withDeadline(trace, "the start that waits for the ceiling", session.prompt(CEILING_PROMPT));
	const ceilingReceipt = delegateReceipts(session).map(startOf)[2];
	if (ceilingReceipt === undefined) throw new Error("the ceiling start has no receipt");
	expect(
		{ h: ceilingReceipt.h, words: ceilingReceipt.text.includes("waiting: capacity: 1 running of 1 allowed (since ") },
		`the start waits for the running ceiling with the ceiling's own numbers: ${ceilingReceipt.text}`,
	).toEqual({ h: ["QUEUED"], words: true });
	world.settingsManager.setFleetSettings({
		...world.settingsManager.getGlobalSettings().fleet,
		ceiling: { ...world.settingsManager.getGlobalSettings().fleet?.ceiling, running: 2 },
	});
	await settle();
	expect(
		world.provider.requests.filter((request) => request.model.id === FREE_B).length,
		"raising the running ceiling starts nothing by itself: the waiting start needs another event",
	).toBe(0);
	// The event is the terminal of the worker that was running.
	unpaidOne.holds.release();
	await withDeadline(
		trace,
		"the ceiling start runs after the running worker ends",
		ceilingWorker.firstRequest.promise,
	);
	await withDeadline(trace, "the first handoff reaches the root", wakeAt(0).promise);
	await withDeadline(trace, "the handoff turn settles", session.waitForForegroundIdle());

	// 3. The spend brake holds new paid starts, and the owner hears of it once.
	seedSpendFile(world, { now: fleetNow(world), dayUsd: 0, windowUsd: WINDOW_SPEND_USD });
	await withDeadline(trace, "the brake's starts", session.prompt(BRAKE_PROMPT));
	await withDeadline(trace, "the second unpaid worker runs under the brake", unpaidTwo.firstRequest.promise);
	const [brakeReceipt, underBrakeReceipt] = delegateReceipts(session).map(startOf).slice(3);
	if (brakeReceipt === undefined || underBrakeReceipt === undefined)
		throw new Error("the brake's turn has two receipts");
	await withDeadline(trace, "the brake's notice is saved", noticesSaved(sessionManager, "fleet-spend-brake", 1));
	const notices = harnessNotices(sessionManager, "fleet-spend-brake");
	expect(
		{
			h: brakeReceipt.h,
			words: brakeReceipt.text.includes(
				"waiting: capacity: new paid (API-key) work is paused by the spend-rate brake (since ",
			),
			unpaidState: underBrakeReceipt.h,
		},
		`the paid start waits on the brake while unpriced work starts: ${brakeReceipt.text}`,
	).toEqual({ h: ["QUEUED"], words: true, unpaidState: undefined });
	expect(notices.length, "the owner is told exactly once that the brake engaged").toBe(1);
	expect(notices[0]?.reason, "the notice names the spend rate").toBe("spend-rate");
	expect(notices[0]?.text ?? "", "the notice states the window's spend and the line it crossed").toContain(
		BRAKE_NOTICE,
	);

	// The started unpaid workers end before the owner continues, so nothing else holds the room the paid starts need.
	unpaidTwo.holds.release();
	await withDeadline(trace, "the second unpaid worker's handoff reaches the root", wakeAt(1).promise);
	await withDeadline(trace, "its handoff turn settles", session.waitForForegroundIdle());
	ceilingWorker.holds.release();
	await withDeadline(trace, "the ceiling worker's handoff reaches the root", wakeAt(2).promise);
	await withDeadline(trace, "its handoff turn settles", session.waitForForegroundIdle());

	// 4. The owner's continue lifts the brake for the rest of the window, and the waiting paid start runs.
	session.setEmergencyStop(false);
	await withDeadline(trace, "the first waiting paid start runs on the owner's continue", paidOne.firstRequest.promise);
	await settle();
	expect(
		harnessNotices(sessionManager, "fleet-spend-brake").length,
		"the lifted brake tells the owner nothing further",
	).toBe(1);
	paidOne.holds.release();
	await withDeadline(trace, "the paid worker's handoff reaches the root", wakeAt(3).promise);
	await withDeadline(trace, "the second waiting paid start runs on the lifted brake", paidTwo.firstRequest.promise);
	paidTwo.holds.release();
	await withDeadline(trace, "the last handoff reaches the root", wakeAt(4).promise);
	await withDeadline(trace, "the leg's turns settle", session.waitForForegroundIdle());
	expect(
		delegateReceipts(session)
			.map(startOf)
			.map((start) => session.getLaneRecords().find((record) => record.laneId === start.laneId)?.status),
		"every lane of the leg ended with a report",
	).toEqual(["succeeded", "succeeded", "succeeded", "succeeded", "succeeded"]);
	expect(await world.disposeSessionInBody(session), "the metered root disposes cleanly").toBeUndefined();
	world.trace.mark("root", "j8.metered");
}
