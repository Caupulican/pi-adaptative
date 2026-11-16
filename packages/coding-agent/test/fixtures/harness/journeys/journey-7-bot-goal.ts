import "../builtin-install.ts";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import type { ScriptedRequest } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import {
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
const GOAL = "Document the connection pool's limit of eight connections.";
const ASK = "Keep the connection pool's limit documented as a goal of your own.";
const STARTED = "The goal to document the pool's limit is started.";
const ANSWER = "The pool's limit of eight connections is documented, and the goal is complete.";
/** The owner's continuation delay, at its maximum: the wake's wall timer stays far beyond the leg. */
const DELAY_MS = 60_000;
const WAKE_OWNER = "goal-continuation";
/** The instruction the first model-driven completion is refused with, after the noticed-items rule it delivers. */
const COMPLETE_AGAIN = "Review your proof output for relevant noticed items; resolve them, then call complete again.";

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
	const { session } = await createChargedRoot(
		world,
		"bot-goal",
		{ autonomy: { goalAutoContinueDelayMs: DELAY_MS } },
		false,
	);
	try {
		await runLeg(world, session);
	} finally {
		expect(await world.disposeSessionInBody(session), "the owner's session disposes cleanly").toBeUndefined();
	}
	world.trace.mark("root", "j7.bot-goal");
}

async function runLeg(world: HarnessWorld, session: AgentSession): Promise<void> {
	const { trace } = world;
	world.systemOne.enterPhase("j7-bot-goal", {});
	expect(world.timers.armedDelays(WAKE_OWNER), "no goal continuation is armed before the bot's goal").toEqual([]);
	createOwnerBot(session, GOAL_BOT, MODEL_ID.goalBot, SOUL);
	const seen = {
		holdsGoal: false,
		started: undefined as boolean | undefined,
		refused: undefined as boolean | undefined,
		completed: undefined as boolean | undefined,
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
			reply: goalCall("j7-goal-bot-start", { action: "start", goalId: GOAL_ID, userGoal: GOAL }),
		},
		{
			name: "j7-goal-bot-started",
			check: (request) => {
				seen.started = !goalResult(request).isError;
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
			started: seen.started,
			goal: session.listPersistentBots().find((bot) => bot.agentId === GOAL_BOT)?.goal,
			armed: world.timers.armedDelays(WAKE_OWNER),
			early: world.timers.advance(WAKE_OWNER, DELAY_MS - 1),
			continuedEarly: continued(),
		},
		"the bot's own session starts its goal, the roster shows it running, and its one continuation wake waits the owner's whole delay",
	).toEqual({
		sent: "started",
		holdsGoal: true,
		started: true,
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
