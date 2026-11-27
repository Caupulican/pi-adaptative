import "../builtin-install.ts";
import { resolve } from "node:path";
import { expect } from "vitest";
import { botHostLockFile } from "../../../../src/core/agent-paths.ts";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { processLockHolder } from "../../../../src/core/remote/host-lock.ts";
import type { Settings } from "../../../../src/core/settings/settings-schema.ts";
import type { ScriptedRequest } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import {
	carries,
	chatText,
	createChargedRoot,
	createOwnerBot,
	enqueueBot,
	lastResult,
	MODEL_ID,
	offeredTools,
	reached,
	TRACK,
	waitForBotRosterView,
} from "./journey-7-shared.ts";

const GOAL_BOT = "pool-keeper";
const SOUL = "You keep the connection pool's limit documented and answer the owner in one sentence.";
const GOAL_ID = "j7-bot-goal";
const ASK = "Keep the connection pool's limit of eight connections documented as a goal of your own.";
const STARTED = "The goal to document the pool's limit is started.";
const ANSWER = "The pool's limit of eight connections is documented, and the goal is complete.";
/** The owner's continuation delay, at its maximum: the wake's wall timer stays far beyond the leg. */
const DELAY_MS = 60_000;
const WAKE_OWNER = "goal-continuation";
/** The instruction the first model-driven completion is refused with, after the noticed-items rule it delivers. */
const COMPLETE_AGAIN = "Review your proof output for relevant noticed items; resolve them, then call complete again.";
/** The settings both owner sessions open with: the bot's continuation waits the owner's whole delay. */
const SETTINGS: Partial<Settings> = { autonomy: { goalAutoContinueDelayMs: DELAY_MS } };

/** The bot whose session closes with its goal unfinished; its soul tells it apart on the shared model. */
const CLOSED_BOT = "pool-auditor";
const CLOSED_SOUL = "You audit the connection pool's idle timeout and answer the owner in one sentence.";
const CLOSED_TRACK = "j7-closed-goal-bot";
const CLOSED_GOAL_ID = "j7-closed-bot-goal";
const CLOSED_ASK = "Keep the connection pool's idle timeout of thirty seconds documented as a goal of your own.";
const CLOSED_STARTED = "The goal to document the pool's idle timeout is started.";
const CLOSED_ANSWER = "The pool's idle timeout of thirty seconds is documented, and the goal is complete.";

/** What the closed bot's requests showed, read by both of its legs. */
interface ClosedBotSeen {
	holdsGoal: boolean;
	startReceipt?: ReturnType<typeof goalResult>;
	carried: boolean | undefined;
	refused: boolean | undefined;
	completed: boolean | undefined;
}

/** The goal result of the request's latest batch, as the tool reported it; fails when there is none. */
function goalResult(request: ScriptedRequest): { readonly isError: boolean; readonly text: string } {
	const result = lastResult(request, "goal");
	if (result === undefined) throw new Error("the latest batch carries no goal result");
	return result;
}

/** One goal call of the bot's, its id named by its step. */
function goalCall(step: string, args: Record<string, unknown>) {
	return {
		content: [{ type: "toolCall" as const, id: `${step}-1`, name: "goal", arguments: args }],
		stopReason: "toolUse" as const,
	};
}

/**
 * Leg: a bot keeps a goal of its own. The owner asks a bot, whose own session holds the goal tools, to keep a goal; its
 * turn starts the goal and ends, and the roster shows the unfinished goal running (no requirement, so no count). The idle
 * session holds one continuation wake at the owner's delay and no owner word follows: one millisecond short of the delay
 * nothing runs, and at the delay the wake opens the bot's continuation turn on its own, which completes the goal (the first
 * completion is refused once with the noticed-items rule, the second is accepted). The roster then shows the bot idle with
 * no goal, nothing is armed, and its chat holds its answer. System One is off, so the turns ask nothing in either mode.
 */
export async function runJourney7BotGoalPhase(world: HarnessWorld): Promise<void> {
	const { session } = await createChargedRoot(world, "bot-goal", SETTINGS, false);
	let mark = world.warnings.length;
	let seen: ClosedBotSeen;
	try {
		await runLeg(world, session);
		mark = world.warnings.length;
		seen = await startGoalBeforeClose(world, session);
	} finally {
		expect(await world.disposeSessionInBody(session), "the owner's session disposes cleanly").toBeUndefined();
	}
	await reopenedBotContinues(world, seen, mark);
	world.trace.mark("root", "j7.bot-goal");
}

async function runLeg(world: HarnessWorld, session: AgentSession): Promise<void> {
	const { trace } = world;
	world.systemOne.enterPhase("j7-bot-goal", {});
	expect(world.timers.armedDelays(WAKE_OWNER), "no goal continuation is armed before the bot's goal").toEqual([]);
	createOwnerBot(session, GOAL_BOT, MODEL_ID.goalBot, SOUL);
	const seen: ClosedBotSeen = {
		holdsGoal: false,
		carried: undefined,
		refused: undefined,
		completed: undefined,
	};
	enqueueBot(
		world,
		TRACK.goalBot,
		MODEL_ID.goalBot,
		SOUL,
		{
			name: "j7-goal-bot-start",
			check: (request) => {
				seen.holdsGoal = offeredTools(request).includes("goal");
			},
			reply: goalCall("j7-goal-bot-start", { action: "start", goalId: GOAL_ID, userGoal: ASK }),
		},
		{
			name: "j7-goal-bot-started",
			check: (request) => {
				seen.startReceipt = goalResult(request);
			},
			reply: { content: [{ type: "text", text: STARTED }] },
		},
		{
			name: "j7-goal-bot-continued",
			reply: goalCall("j7-goal-bot-continued", { action: "complete" }),
		},
		{
			name: "j7-goal-bot-complete-again",
			check: (request) => {
				const result = goalResult(request);
				seen.refused = result.isError && result.text.endsWith(COMPLETE_AGAIN);
			},
			reply: goalCall("j7-goal-bot-complete-again", { action: "complete" }),
		},
		{
			name: "j7-goal-bot-done",
			check: (request) => {
				seen.completed = !goalResult(request).isError;
			},
			reply: { content: [{ type: "text", text: ANSWER }] },
		},
	);

	const sent = await session.sendOperatorMessageToBot(GOAL_BOT, ASK);
	await withDeadline(
		trace,
		"J7 bot goal: the bot started its goal",
		world.provider.whenReached(reached(TRACK.goalBot, "j7-goal-bot-started")),
	);
	expect(seen.startReceipt?.isError, seen.startReceipt?.text).toBe(false);
	await withDeadline(trace, "J7 bot goal: the idle bot armed its continuation", world.timers.whenArmed(WAKE_OWNER));
	await waitForBotRosterView(
		world,
		session,
		GOAL_BOT,
		"with its goal running",
		(view) => view?.goal?.executing === true,
	);
	const continued = () => world.provider.reached.includes(reached(TRACK.goalBot, "j7-goal-bot-continued"));
	expect(
		{
			sent: sent.mode,
			holdsGoal: seen.holdsGoal,
			goal: session.listPersistentBots().find((bot) => bot.agentId === GOAL_BOT)?.goal,
			armed: world.timers.armedDelays(WAKE_OWNER),
			early: world.timers.advance(WAKE_OWNER, DELAY_MS - 1),
			continuedEarly: continued(),
		},
		"the bot's own session starts its goal, the roster shows it running, and its one continuation wake waits the owner's whole delay",
	).toEqual({
		sent: "started",
		holdsGoal: true,
		goal: { satisfied: 0, total: 0, executing: true },
		armed: [DELAY_MS],
		early: 0,
		continuedEarly: false,
	});
	expect(world.timers.advance(WAKE_OWNER, 1), "the last millisecond of the delay fires the bot's wake").toBe(1);
	await withDeadline(
		trace,
		"J7 bot goal: the bot settled its goal on its own",
		world.provider.whenReached(reached(TRACK.goalBot, "j7-goal-bot-done")),
	);
	await waitForBotRosterView(
		world,
		session,
		GOAL_BOT,
		"idle with no goal",
		(view) => view?.state === "idle" && view.goal === undefined,
	);
	expect(
		{
			refused: seen.refused,
			completed: seen.completed,
			armed: world.timers.armedDelays(WAKE_OWNER),
			answered: chatText(session, GOAL_BOT).includes(ANSWER),
		},
		"the continuation completes the goal on its own (refused once with the noticed-items rule), nothing stays armed, and the bot's chat holds its answer",
	).toEqual({ refused: true, completed: true, armed: [], answered: true });
}

/**
 * Leg: a closed bot's unfinished goal opens its session again. The owner asks a second bot to keep a goal; its turn starts
 * the goal and ends, and its idle session holds one continuation wake at the owner's delay. The owner's session then closes
 * before the wake fires (`runJourney7BotGoalPhase` disposes it), and the bot's session closes with it, its goal unfinished.
 */
async function startGoalBeforeClose(world: HarnessWorld, session: AgentSession): Promise<ClosedBotSeen> {
	const { trace } = world;
	expect(world.timers.armedDelays(WAKE_OWNER), "no goal continuation is armed before the second bot's goal").toEqual(
		[],
	);
	createOwnerBot(session, CLOSED_BOT, MODEL_ID.goalBot, CLOSED_SOUL);
	const seen: ClosedBotSeen = {
		holdsGoal: false,
		carried: undefined,
		refused: undefined,
		completed: undefined,
	};
	enqueueBot(
		world,
		CLOSED_TRACK,
		MODEL_ID.goalBot,
		CLOSED_SOUL,
		{
			name: "j7-closed-bot-start",
			check: (request) => {
				seen.holdsGoal = offeredTools(request).includes("goal");
			},
			reply: goalCall("j7-closed-bot-start", { action: "start", goalId: CLOSED_GOAL_ID, userGoal: CLOSED_ASK }),
		},
		{
			name: "j7-closed-bot-started",
			check: (request) => {
				seen.startReceipt = goalResult(request);
			},
			reply: { content: [{ type: "text", text: CLOSED_STARTED }] },
		},
		{
			name: "j7-closed-bot-continued",
			check: (request) => {
				// The reopened session continues the conversation the closed one saved.
				seen.carried = carries(request, CLOSED_ASK) && carries(request, CLOSED_STARTED);
			},
			reply: goalCall("j7-closed-bot-continued", { action: "complete" }),
		},
		{
			name: "j7-closed-bot-complete-again",
			check: (request) => {
				const result = goalResult(request);
				seen.refused = result.isError && result.text.endsWith(COMPLETE_AGAIN);
			},
			reply: goalCall("j7-closed-bot-complete-again", { action: "complete" }),
		},
		{
			name: "j7-closed-bot-done",
			check: (request) => {
				seen.completed = !goalResult(request).isError;
			},
			reply: { content: [{ type: "text", text: CLOSED_ANSWER }] },
		},
	);
	const sent = await session.sendOperatorMessageToBot(CLOSED_BOT, CLOSED_ASK);
	await withDeadline(
		trace,
		"J7 bot goal: the second bot started its goal",
		world.provider.whenReached(reached(CLOSED_TRACK, "j7-closed-bot-started")),
	);
	expect(seen.startReceipt?.isError, seen.startReceipt?.text).toBe(false);
	await withDeadline(
		trace,
		"J7 bot goal: the second bot's idle session armed its continuation",
		world.timers.whenArmed(WAKE_OWNER),
	);
	await waitForBotRosterView(
		world,
		session,
		CLOSED_BOT,
		"with its goal running before its session closes",
		(view) => view?.goal?.executing === true,
	);
	expect(
		{
			sent: sent.mode,
			holdsGoal: seen.holdsGoal,
			armed: world.timers.armedDelays(WAKE_OWNER),
		},
		"the second bot starts its goal and its idle session holds one continuation wake at the owner's delay",
	).toEqual({ sent: "started", holdsGoal: true, armed: [DELAY_MS] });
	return seen;
}

/**
 * Leg: the bot's session closed with the owner's, its goal unfinished: its wake ended with it, its lock is given back and
 * nothing continued the goal. The next owner session's host opens the bot's session for the goal its saved session holds
 * (the bot's owed work), with no message: the reopened session takes the goal up and arms one continuation wake at the
 * owner's whole delay, which fires nothing a millisecond early; at the delay the wake opens the bot's continuation turn,
 * which carries its saved conversation and completes the goal (refused once with the noticed-items rule, then accepted).
 * The roster then shows the bot idle with no goal, nothing stays armed, and no warning was told from the close on. System
 * One is off in both owner sessions, so the turns ask nothing in either mode.
 */
async function reopenedBotContinues(world: HarnessWorld, seen: ClosedBotSeen, mark: number): Promise<void> {
	const { trace } = world;
	const lock = resolve(botHostLockFile(world.agentDir, CLOSED_BOT));
	await withDeadline(
		trace,
		"J7 bot goal: the closed owner's host let the second bot's session go",
		world.io.waitForMutation(() => processLockHolder(lock) === undefined),
	);
	const continued = () => world.provider.reached.includes(reached(CLOSED_TRACK, "j7-closed-bot-continued"));
	expect(
		{ armed: world.timers.armedDelays(WAKE_OWNER), continued: continued() },
		"the bot's session closed with its goal unfinished: its continuation wake ended with it and nothing continued the goal",
	).toEqual({ armed: [], continued: false });
	const { session } = await createChargedRoot(world, "bot-goal-reopened", SETTINGS, false);
	try {
		await withDeadline(
			trace,
			"J7 bot goal: the next owner's host opened the closed bot for its goal, which armed its continuation",
			world.timers.whenArmed(WAKE_OWNER),
		);
		await waitForBotRosterView(
			world,
			session,
			CLOSED_BOT,
			"with its goal running in its reopened session",
			(view) => view?.goal?.executing === true,
		);
		expect(
			{
				hosted: processLockHolder(lock) !== undefined,
				goal: session.listPersistentBots().find((bot) => bot.agentId === CLOSED_BOT)?.goal,
				armed: world.timers.armedDelays(WAKE_OWNER),
				early: world.timers.advance(WAKE_OWNER, DELAY_MS - 1),
				continuedEarly: continued(),
			},
			"the next owner's host opens the closed bot's session for its unfinished goal, unasked, and its one continuation wake waits the owner's whole delay",
		).toEqual({
			hosted: true,
			goal: { satisfied: 0, total: 0, executing: true },
			armed: [DELAY_MS],
			early: 0,
			continuedEarly: false,
		});
		expect(
			world.timers.advance(WAKE_OWNER, 1),
			"the last millisecond of the delay fires the reopened bot's wake",
		).toBe(1);
		await withDeadline(
			trace,
			"J7 bot goal: the reopened bot settled its goal on its own",
			world.provider.whenReached(reached(CLOSED_TRACK, "j7-closed-bot-done")),
		);
		await waitForBotRosterView(
			world,
			session,
			CLOSED_BOT,
			"idle with no goal after its reopened session settled it",
			(view) => view?.state === "idle" && view.goal === undefined,
		);
		expect(
			{
				carried: seen.carried,
				refused: seen.refused,
				completed: seen.completed,
				armed: world.timers.armedDelays(WAKE_OWNER),
				answered: chatText(session, CLOSED_BOT).includes(CLOSED_ANSWER),
				warnings: world.warnings.slice(mark),
			},
			"the reopened session's continuation carries its saved conversation and completes the goal on its own (refused once with the noticed-items rule), nothing stays armed, the bot's chat holds its answer, and nothing was told from the close on",
		).toEqual({ carried: true, refused: true, completed: true, armed: [], answered: true, warnings: [] });
	} finally {
		expect(
			await world.disposeSessionInBody(session),
			"the reopened owner's session disposes cleanly",
		).toBeUndefined();
	}
}
