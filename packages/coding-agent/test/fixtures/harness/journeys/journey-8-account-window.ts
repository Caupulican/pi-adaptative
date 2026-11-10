import "../builtin-install.ts";
import { expect } from "vitest";
import { WALL_ALARM_RECHECK_MS } from "../../../../src/kernel/timer-port.ts";
import {
	type Barrier,
	createBarrier,
	fail,
	type ScriptedRequest,
	type ScriptStep,
	text,
} from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import {
	accountRecord,
	carriesMarker,
	contentText,
	delegateReceipts,
	J8_INTAKE_JUDGMENTS,
	scriptedAccountKey,
	seedAccountWindow,
	startOf,
	startStep,
	submitReport,
} from "./journey-8-shared.ts";
import { expectOwnerWords } from "./shared.ts";

/**
 * Leg 1: a rate refusal narrows the account the workers share.
 *
 * Six read-only workers are started on one model under a ceiling of eight while the account's window serves four at
 * once, so the fifth and the sixth wait on that window. One held worker is released into a rate-limit refusal without a
 * reset: the window halves, nothing running stops, and the fifth begins only once enough held workers have ended for the
 * halved window to take it. Its own refusal states a reset: the account is blocked, the sixth is told until when, and the
 * fleet arms an alarm for that time. The root's own requests are on the same account, so the root hears nothing while
 * the block lasts; when the clocks pass the reset the sixth runs on the fleet's alarm, and the root then reads every
 * handoff.
 */

/** The model every worker of this leg runs on: one account, one learned window. */
const MODEL = "worker-a";
const START_PROMPT = "Start six workers to report the retry limit.";
const WAIT_PROMPT = "Wait while the workers report.";

/** The refusal that says nothing about when to come back. */
const RATE_LIMIT_WITHOUT_RESET = "429 rate limit exceeded for this account. Provider retry directive: do not retry.";
/** The refusal that states its own reset, in the words the retry classifier parses as a delay. */
const RATE_LIMIT_WITH_RESET =
	"429 rate limit exceeded for this account; retry after 60 seconds. Provider retry directive: do not retry.";
/** The reset a refusal stated, and the widest reopen jitter the fleet adds to it (a tenth of the block, capped at 30 s). */
const RESET_MS = 60_000;
const MAX_REOPEN_JITTER_MS = 6_000;
/** Room for the clock the block was recorded on to sit ahead of the fleet's own: both move with the wall clock. */
const REOPEN_SLACK_MS = 5_000;

const WORDS = ["one", "two", "three", "four", "five", "six"] as const;
type Word = (typeof WORDS)[number];

/** The words that tell one worker's task from its siblings', who share a model. */
function markerOf(word: string): string {
	return `You are worker ${word}.`;
}

function instructionsOf(word: string): string {
	return `Report the retry limit in one line. ${markerOf(word)}`;
}

export async function runJourney8AccountWindowPhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	const accountKey = scriptedAccountKey(world);
	// The account serves four at once under a ceiling of eight, so the account's window is the term that runs out first.
	// Its slow-start threshold is already four: a success on a nearly full window (the root's own requests are on this
	// account too) then adds a fraction of a worker, not a whole one, and the window stays at four while the workers start.
	seedAccountWindow(world, accountKey, 4, 4);
	const sessionManager = world.createSessionManager();
	const { session } = await world.createRootSession("root", { sessionManager });

	const holds = new Map<string, Barrier>(WORDS.map((word): [string, Barrier] => [word, createBarrier()]));
	const firstRequests = new Map<string, Barrier>(WORDS.map((word): [string, Barrier] => [word, createBarrier()]));
	/** The root holds a turn of its own while the window narrows, so no handoff turn settles on the account meanwhile. */
	const waitReached = createBarrier();
	const waitHeld = createBarrier();
	/** Released by the root request whose conversation carries the handoff of every worker of the leg. */
	const everyHandoffRead = createBarrier();
	const holdOf = (word: Word): Barrier => {
		const barrier = holds.get(word);
		if (barrier === undefined) throw new Error(`no hold for worker ${word}`);
		return barrier;
	};
	const firstRequest = (word: Word): Barrier => {
		const barrier = firstRequests.get(word);
		if (barrier === undefined) throw new Error(`no first request barrier for worker ${word}`);
		return barrier;
	};
	/** One held step whose reply ends the worker's lane, so the account sees the request settle as a success. */
	const heldReport = (word: Word, callId: string): ScriptStep => ({
		name: `j8a-${word}-report`,
		gate: holdOf(word).promise,
		check: () => firstRequest(word).release(),
		reply: submitReport(callId, `Worker ${word} read the retry limit.`),
	});
	/** One held step whose reply is a provider refusal: the lane ends there, since the refusal forbids a retry. */
	const heldFailure = (word: Word, stepName: string, message: string): ScriptStep => ({
		...fail(stepName, message),
		gate: holdOf(word).promise,
		check: () => firstRequest(word).release(),
	});

	world.provider.enqueueTrack(
		"j8a-w1",
		MODEL,
		carriesMarker(markerOf("one")),
		heldFailure("one", "j8a-one-refused", RATE_LIMIT_WITHOUT_RESET),
	);
	world.provider.enqueueTrack("j8a-w2", MODEL, carriesMarker(markerOf("two")), heldReport("two", "j8a-two-report-1"));
	world.provider.enqueueTrack(
		"j8a-w3",
		MODEL,
		carriesMarker(markerOf("three")),
		heldReport("three", "j8a-three-report-1"),
	);
	world.provider.enqueueTrack(
		"j8a-w4",
		MODEL,
		carriesMarker(markerOf("four")),
		heldReport("four", "j8a-four-report-1"),
	);
	world.provider.enqueueTrack(
		"j8a-w5",
		MODEL,
		carriesMarker(markerOf("five")),
		heldFailure("five", "j8a-five-refused", RATE_LIMIT_WITH_RESET),
	);
	world.provider.enqueueTrack("j8a-w6", MODEL, carriesMarker(markerOf("six")), {
		name: "j8a-six-report",
		check: () => firstRequest("six").release(),
		reply: submitReport("j8a-six-report-1", "Worker six read the retry limit."),
	});

	/** Whether the conversation a root request carries holds the handoff block of every lane of the leg. */
	const carriesEveryHandoff = (request: ScriptedRequest): boolean => {
		const conversation = request.context.messages.map((message) => contentText(message.content)).join("\n");
		return delegateReceipts(session)
			.map(startOf)
			.every((start) => conversation.includes(`- ${start.laneId}: `));
	};
	world.provider.enqueue(
		"root",
		...WORDS.map((word, index) =>
			startStep(session, `j8a-start-${word}`, `j8a-start-${index + 1}`, instructionsOf(word), MODEL),
		),
		text("j8a-starts-done", "Six workers were told to report the retry limit."),
		{
			name: "j8a-wait",
			gate: waitHeld.promise,
			check: () => waitReached.release(),
			reply: { content: [{ type: "text", text: "Waiting while they report." }] },
		},
		{
			// How many turns the six handoffs start is the product's decision: this step answers each of them and is done
			// with the one whose conversation holds all six.
			name: "j8a-wakes",
			maxRequests: 8,
			until: (request) => {
				if (!carriesEveryHandoff(request)) return false;
				everyHandoffRead.release();
				return true;
			},
			reply: { content: [{ type: "text", text: "Noted." }] },
		},
	);
	world.systemOne.enterPhase("j8a-account-window", J8_INTAKE_JUDGMENTS, {
		expect: expectOwnerWords({
			sessionManager: () => sessionManager,
			userRequests: [START_PROMPT, WAIT_PROMPT],
			optionalToolNames: ["secret_store"],
		}),
	});
	const workerRequests = (): number => world.provider.requests.filter((request) => request.model.id === MODEL).length;
	const rootRequests = (): number => world.provider.requests.filter((request) => request.model.id === "root").length;
	const laneOf = (laneId: string) => session.getLaneRecords().find((record) => record.laneId === laneId);
	/**
	 * Resolves once the lane of the start at `index` has ended. It only reads the lane's record: the product's own wait
	 * for a worker hands that worker's result to the caller, and the root would then not be told of it.
	 */
	const laneEnded = (index: number): Promise<void> =>
		world.io.waitForMutation(() => {
			const status = laneOf(startAt(index).laneId)?.status;
			return status === "succeeded" || status === "failed";
		});

	// The six starts arrive in one turn: four run, and the fifth and the sixth wait on the account's window.
	await withDeadline(trace, "the six starts", session.prompt(START_PROMPT));
	await withDeadline(
		trace,
		"the four running workers are held at their first request",
		Promise.all(WORDS.slice(0, 4).map((word) => firstRequest(word).promise)),
	);
	const starts = delegateReceipts(session).map(startOf);
	const startAt = (index: number) => {
		const start = starts[index];
		if (start === undefined) throw new Error(`the start at ${index} has no receipt`);
		return start;
	};
	expect(
		{
			started: starts.map((start) => start.started),
			codes: starts.map((start) => start.h),
			toldTheWindow: [4, 5].map((index) =>
				startAt(index).text.includes(
					"waiting: capacity: 4 of 4 worker(s) the account serves at once are running (since ",
				),
			),
		},
		"every start is accepted; four workers run, and the two the account has no room for are queued and told its own numbers",
	).toEqual({
		started: [true, true, true, true, true, true],
		codes: [undefined, undefined, undefined, undefined, ["QUEUED"], ["QUEUED"]],
		toldTheWindow: [true, true],
	});
	const beforeRefusal = accountRecord(world, accountKey);
	expect(
		beforeRefusal && {
			window: Math.floor(beforeRefusal.w),
			ssthresh: beforeRefusal.ssthresh,
			lastDecreaseAt: beforeRefusal.lastDecreaseAt,
			blockedUntil: beforeRefusal.blockedUntil,
		},
		"the account's record before any refusal still serves four at once at its seeded threshold, never decreased and never blocked",
	).toEqual({ window: 4, ssthresh: 4, lastDecreaseAt: 0, blockedUntil: undefined });

	// The root takes a turn of its own and stays in it: while it holds, no handoff starts a turn that would teach the
	// account's window, so the window's narrowings below are the workers' own.
	const waitingTurn = session.prompt(WAIT_PROMPT);
	await withDeadline(trace, "the root's waiting turn is held", waitReached.promise);
	const rootRequestsWhileHeld = rootRequests();

	// The first refusal: a rate limit that states no reset halves the window and blocks nothing.
	holdOf("one").release();
	await withDeadline(
		trace,
		"the refusal is folded into the account's record",
		world.io.waitForMutation(() => accountRecord(world, accountKey)?.w === 2),
	);
	const halved = accountRecord(world, accountKey);
	expect(
		halved && {
			w: halved.w,
			ssthresh: halved.ssthresh,
			decreased: halved.lastDecreaseAt > 0,
			blockedUntil: halved.blockedUntil,
		},
		"one rate refusal halves the window and its slow-start threshold, records when it decreased, and blocks nothing because no reset was stated",
	).toEqual({ w: 2, ssthresh: 2, decreased: true, blockedUntil: undefined });
	expect(
		{
			others: [1, 2, 3].map((index) => laneOf(startAt(index).laneId)?.status),
			waiting: [4, 5].map((index) => laneOf(startAt(index).laneId)?.status),
			asked: workerRequests(),
		},
		"the refusal stopped nothing: the three other workers still run, the two queued ones still wait, and only the four running workers were asked",
	).toEqual({ others: ["running", "running", "running"], waiting: ["queued", "queued"], asked: 4 });

	// The halved window serves two at once, so a queued worker needs the running count to fall to one: two of the held
	// workers must end first.
	holdOf("two").release();
	await withDeadline(trace, "the second worker ends", laneEnded(1));
	const afterOneEnd = accountRecord(world, accountKey);
	expect(
		{ asked: workerRequests(), window: afterOneEnd === undefined ? 0 : Math.floor(afterOneEnd.w) },
		"one worker's end leaves two running under a window that serves two, so no queued worker is asked yet; a success of a request sent while the window had room does not widen it",
	).toEqual({ asked: 4, window: 2 });

	// The provider admission ledger's clock moves first, so the second refusal comes from a request dispatched after the
	// first one's decrease: an account's window goes down once per congestion episode, whatever else refuses meanwhile.
	world.timers.advance("provider-admission", 1_000);
	holdOf("three").release();
	await withDeadline(trace, "the fifth worker starts for the room the third left", firstRequest("five").promise);
	const afterFifthBegan = accountRecord(world, accountKey);
	expect(
		{
			window: afterFifthBegan === undefined ? 0 : Math.floor(afterFifthBegan.w),
			blockedUntil: afterFifthBegan?.blockedUntil,
			asked: workerRequests(),
			sixth: laneOf(startAt(5).laneId)?.status,
			sixthWaitsOn: laneOf(startAt(5).laneId)?.waitReason?.includes(
				"2 of 2 worker(s) the account serves at once are running",
			),
		},
		"the fifth began when the third worker's lane ended, oldest first; the sixth still waits on the halved window, which is full again",
	).toEqual({ window: 2, blockedUntil: undefined, asked: 5, sixth: "queued", sixthWaitsOn: true });

	// The second refusal states a reset: the account is blocked until then, its window halved again.
	holdOf("five").release();
	await withDeadline(
		trace,
		"the second refusal is folded into the account's record",
		world.io.waitForMutation(() => accountRecord(world, accountKey)?.blockedUntil !== undefined),
	);
	const blocked = accountRecord(world, accountKey);
	if (blocked?.blockedUntil === undefined)
		throw new Error("the account's record carries no block after the second refusal");
	expect(
		{ w: blocked.w, ssthresh: blocked.ssthresh, blockedAt: typeof blocked.blockedAt },
		"the second refusal halves the window again and blocks the account until the reset it stated",
	).toEqual({ w: 1, ssthresh: 1, blockedAt: "number" });
	await withDeadline(trace, "the fifth worker's lane ends", laneEnded(4));

	// The last held worker ends, so nothing runs on the account: the sixth is held by the block alone.
	holdOf("four").release();
	await withDeadline(trace, "the fourth worker ends", laneEnded(3));
	const refusedUntil = new Date(blocked.blockedUntil).toISOString();
	const armed = world.timers.armedDelays("fleet");
	expect(
		{
			sixth: laneOf(startAt(5).laneId)?.status,
			toldTheReset: laneOf(startAt(5).laneId)?.waitReason?.includes(
				`the provider refused more requests on this account until ${refusedUntil}`,
			),
			asked: workerRequests(),
			// One alarm toward the reset. It is a wall alarm: it waits at most its recheck interval at a time and reads the
			// clock again, so a reset a minute away is armed as that interval, not as one long timer.
			alarmWaits: armed,
			rootHeard: rootRequests() - rootRequestsWhileHeld,
		},
		"with the account blocked the sixth waits although nothing runs, it is told when the provider refused the account until, the fleet arms one alarm toward that time, and the root made no request",
	).toEqual({
		sixth: "queued",
		toldTheReset: true,
		asked: 5,
		alarmWaits: [WALL_ALARM_RECHECK_MS],
		rootHeard: 0,
	});

	// The clocks pass the reset: the account reopens and the waiting worker runs on the fleet's own alarm.
	world.timers.advance("fleet", RESET_MS + MAX_REOPEN_JITTER_MS + REOPEN_SLACK_MS);
	world.timers.advance("provider-admission", RESET_MS + MAX_REOPEN_JITTER_MS + REOPEN_SLACK_MS);
	await withDeadline(trace, "the sixth worker runs once the account reopens", firstRequest("six").promise);
	await withDeadline(trace, "the sixth worker ends", laneEnded(5));
	expect(
		{ starts: delegateReceipts(session).length, rootHeard: rootRequests() - rootRequestsWhileHeld },
		"the reopening asked the root for nothing: the waiting worker started on the fleet's own alarm",
	).toEqual({ starts: 6, rootHeard: 0 });

	// The waiting turn ends, and the handoffs the six workers left reach the root.
	waitHeld.release();
	await withDeadline(trace, "the root's waiting turn ends", waitingTurn);
	await withDeadline(trace, "every handoff reaches the root", everyHandoffRead.promise);
	await withDeadline(trace, "the leg's turns settle", session.waitForForegroundIdle());
	expect(
		starts.map((start) => laneOf(start.laneId)?.status),
		"every lane of the leg ended: the two refusals failed their lanes and the four reports succeeded",
	).toEqual(["failed", "succeeded", "succeeded", "succeeded", "failed", "succeeded"]);
	expect(await world.disposeSessionInBody(session), "the account-window root disposes cleanly").toBeUndefined();
	world.trace.mark("root", "j8.account-window");
}
