import "../builtin-install.ts";
import { expect } from "vitest";
import { botSessionsDir } from "../../../../src/core/agent-paths.ts";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { interfaceText } from "../../../../src/core/language/interface-text.ts";
import { createBarrier } from "../scripted-provider.ts";
import { type HarnessWorld, projectPath, withDeadline } from "../session-fixture.ts";
import {
	agentsOn,
	BOT_SESSION_JUDGMENTS,
	botSessionFilesText,
	chatText,
	createOwnerBot,
	enqueueBot,
	MODEL_ID,
	offeredTools,
	reached,
	TRACK,
	waitForBotRosterState,
} from "./journey-7-shared.ts";
import {
	assertWatchWake,
	latestWatchWakeText,
	sessionLedgerWatches,
	sessionWatchOutcome,
} from "./journey-watch-wake.ts";
import { fencedToolOutput, latestBatchResults, refusalDiagnostic } from "./shared.ts";

const WATCHER = "flag-watcher";
const WATCHER_SOUL = "You wait on the deploy flag for the owner and answer in one short sentence.";
const WATCH_REQUEST = "Tell me when deploy.flag appears.";
const WATCH_ID = "deploy-flag";
const WATCH_PLAN = "Tell the owner the deploy flag is up.";
const WRITE_WATCH_ID = "touch-flag";
const WATCHER_ARMED = "I will tell you when deploy.flag appears.";
const WATCHER_WOKEN = "The deploy flag is up.";
const STOPPER = "release-watcher";
const STOPPER_SOUL = "You wait on the release file for the owner and answer in one short sentence.";
const STOPPER_REQUEST = "Tell me when release.flag appears.";
const STOPPER_REARM_REQUEST = "Wait on release.flag again, then drop that wait.";
const STOPPED_WATCH_ID = "release-flag";
const LATER_WATCH_ID = "release-flag-again";
const STOPPER_ARMED = "I will tell you when release.flag appears.";
const STOPPER_CANCELLED = "I no longer wait on release.flag.";

/**
 * Leg: a bot waits on its own work. The owner asks a read-only bot to say when a file appears; in its own session the bot
 * holds `task_watch` and no `routine` tool. A watch whose command would write is refused at arming, in the product's
 * words, since the bot's shell is read-only and a watched command is held to it; the file watch is armed for the bot's own
 * session, and the roster shows it. When the file appears, the bot's own session is woken with the event and answers in a
 * turn of its own: no root turn runs and no worker stands for the bot. The spent watch leaves the roster's count.
 */
export async function runJourney7BotWatchPhase(world: HarnessWorld): Promise<void> {
	const { session } = await world.createRootSession(MODEL_ID.root, { sessionManager: world.createSessionManager() });
	try {
		await stopEndsOwnWatches(world, session);
		await runLeg(world, session);
	} finally {
		expect(await world.disposeSessionInBody(session), "the owner's session disposes cleanly").toBeUndefined();
	}
	world.trace.mark("root", "j7.bot-watch");
}

/** The bot's live watches as the roster shows them (the operator bar's ring); 0 when it holds none. */
function rosterWatches(session: AgentSession, agentId: string): number {
	return session.listPersistentBots().find((bot) => bot.agentId === agentId)?.watchCount ?? 0;
}

/**
 * Waits until the roster's count of the bot's watches is `count`: it follows the store through the home watch, so it is
 * polled, and the poll ends with the wait, whether the count reached `count` or the deadline passed.
 */
async function untilRosterWatches(
	world: HarnessWorld,
	session: AgentSession,
	agentId: string,
	count: number,
	label: string,
): Promise<void> {
	let ended = false;
	try {
		await withDeadline(
			world.trace,
			label,
			(async () => {
				while (!ended && rosterWatches(session, agentId) !== count)
					await new Promise<void>((resolve) => setImmediate(resolve));
			})(),
		);
	} finally {
		ended = true;
	}
}

/** Whether bot `agentId`'s own session holds the live watch `watchId`, read again from its watch ledger. */
function ledgerHolds(world: HarnessWorld, agentId: string, watchId: string): boolean {
	return sessionLedgerWatches(botSessionsDir(world.agentDir, agentId)).some(
		(watch) => watch.watchId === watchId && watch.status === "live",
	);
}

/**
 * Leg: the owner's stop ends the watches a bot armed before it, and a bot cancels a watch it armed. The bot arms a watch on
 * a file that never appears; the owner stops it, and the stop ends that watch, the owner told how many it ended. Then the
 * owner's next words have the bot arm another watch, which the stop made before it leaves, and cancel it with
 * `task_watch`'s `cancel` action; the roster's count follows each. The stop ends the bot's work, not its conversation:
 * those next words start a turn on the conversation it kept ("followed_up").
 */
async function stopEndsOwnWatches(world: HarnessWorld, session: AgentSession): Promise<void> {
	const { trace } = world;
	createOwnerBot(session, STOPPER, MODEL_ID.watcher, STOPPER_SOUL);
	const flag = projectPath("release.flag");
	const expiresAt = world.timers.port("routines").now() + 3_600_000;
	const armWatch = (id: string, watchId: string) => ({
		type: "toolCall" as const,
		id,
		name: "task_watch",
		arguments: {
			action: "arm",
			watchId,
			prompt: "Tell the owner the release file is up.",
			condition: { type: "file", path: flag, on: "created" },
			expiresAt,
		},
	});
	const seen = { armed: [] as Array<[boolean, string]>, rearmed: [] as Array<[boolean, string]>, laterHeld: false };
	const results = (request: Parameters<typeof latestBatchResults>[0]) =>
		latestBatchResults(request)
			.filter((result) => result.toolName === "task_watch")
			.map((result): [boolean, string] => [result.isError, resultText(result.text)]);
	enqueueBot(
		world,
		TRACK.watchStopper,
		MODEL_ID.watcher,
		STOPPER_SOUL,
		{
			name: "j7-stopper-arm",
			reply: { content: [armWatch("j7-stopper-watch", STOPPED_WATCH_ID)], stopReason: "toolUse" },
		},
		{
			name: "j7-stopper-armed",
			check: (request) => {
				seen.armed = results(request);
			},
			reply: { content: [{ type: "text", text: STOPPER_ARMED }] },
		},
		{
			name: "j7-stopper-rearm",
			reply: { content: [armWatch("j7-stopper-again", LATER_WATCH_ID)], stopReason: "toolUse" },
		},
		{
			name: "j7-stopper-cancel",
			check: (request) => {
				seen.rearmed = results(request);
				seen.laterHeld = ledgerHolds(world, STOPPER, LATER_WATCH_ID);
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j7-stopper-drop",
						name: "task_watch",
						arguments: { action: "cancel", watchId: LATER_WATCH_ID },
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j7-stopper-cancelled",
			check: (request) => {
				seen.rearmed.push(...results(request));
			},
			reply: { content: [{ type: "text", text: STOPPER_CANCELLED }] },
		},
	);
	// Each owner message starts a turn that calls a tool: its words are judged as an owner request that calls a tool is in
	// a bot's own session, the owner-policy questions alone.
	if (world.systemOne.enabled) world.systemOne.enterPhase("j7-bot-watch-stop", BOT_SESSION_JUDGMENTS);

	const first = await session.sendOperatorMessageToBot(STOPPER, STOPPER_REQUEST);
	await withDeadline(
		trace,
		"J7 bot watch stop: the bot armed its watch",
		world.provider.whenReached(reached(TRACK.watchStopper, "j7-stopper-armed")),
	);
	await waitForBotRosterState(world, session, STOPPER, "idle");
	await untilRosterWatches(world, session, STOPPER, 1, "J7 bot watch stop: the roster shows the armed watch");

	const stopMark = world.warnings.length;
	session.stopPersistentBot(STOPPER);
	const stopWarnings = world.warnings.splice(stopMark);
	await untilRosterWatches(world, session, STOPPER, 0, "J7 bot watch stop: the stopped bot's watch left the roster");
	expect(
		{
			sent: first.mode,
			armed: seen.armed,
			warnings: stopWarnings,
			held: ledgerHolds(world, STOPPER, STOPPED_WATCH_ID),
		},
		"the owner's stop ends the watch the bot armed before it, and the owner is told how many it ended",
	).toEqual({
		sent: "started",
		armed: [
			[
				false,
				JSON.stringify({ watchId: STOPPED_WATCH_ID, expiresAt: new Date(expiresAt).toISOString(), armed: true }),
			],
		],
		warnings: [interfaceText().botTeam.botStopWatchesEnded(STOPPER, 1, 0)],
		held: false,
	});

	const second = await session.sendOperatorMessageToBot(STOPPER, STOPPER_REARM_REQUEST);
	await withDeadline(
		trace,
		"J7 bot watch stop: the bot cancelled the watch it armed after the stop",
		world.provider.whenReached(reached(TRACK.watchStopper, "j7-stopper-cancelled")),
	);
	await waitForBotRosterState(world, session, STOPPER, "idle");
	await untilRosterWatches(world, session, STOPPER, 0, "J7 bot watch stop: the cancelled watch left the roster");
	expect(
		{
			sent: second.mode,
			results: seen.rearmed,
			laterHeld: seen.laterHeld,
			held: ledgerHolds(world, STOPPER, LATER_WATCH_ID),
		},
		"a watch armed after the owner's stop stays until the bot cancels it with task_watch's cancel action",
	).toEqual({
		sent: "followed_up",
		results: [
			[
				false,
				JSON.stringify({ watchId: LATER_WATCH_ID, expiresAt: new Date(expiresAt).toISOString(), armed: true }),
			],
			[false, JSON.stringify({ watchId: LATER_WATCH_ID, cancelled: true })],
		],
		laterHeld: true,
		held: false,
	});
}

/** A tool result as the model read it: the refusal's diagnostic, or the tool's own fenced output. */
function resultText(text: string): string {
	return refusalDiagnostic(text) ?? fencedToolOutput(text).trim();
}

async function runLeg(world: HarnessWorld, session: AgentSession): Promise<void> {
	const { trace } = world;
	createOwnerBot(session, WATCHER, MODEL_ID.watcher, WATCHER_SOUL);
	const flag = projectPath("deploy.flag");
	const rootRequests = () => world.provider.requests.filter((request) => request.model.id === MODEL_ID.root).length;
	const rootBefore = rootRequests();
	// The bot's watch is one of its own session's waits (`core/watches/`): the ledger beside its transcript records it.
	const outcome = () => sessionWatchOutcome(botSessionsDir(world.agentDir, WATCHER), WATCH_ID);
	const expiresAt = world.timers.port("routines").now() + 3_600_000;
	const armed = createBarrier();
	const seen = {
		offered: [] as string[],
		results: [] as Array<[string, boolean, string]>,
	};

	enqueueBot(
		world,
		TRACK.watcher,
		MODEL_ID.watcher,
		WATCHER_SOUL,
		{
			name: "j7-watcher-arm",
			check: (request) => {
				seen.offered = offeredTools(request);
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j7-watcher-write",
						name: "task_watch",
						arguments: {
							action: "arm",
							routineId: WRITE_WATCH_ID,
							prompt: "Say the flag file was written.",
							condition: { type: "command", command: "touch deploy.flag" },
							expiresAt,
						},
					},
					{
						type: "toolCall",
						id: "j7-watcher-flag",
						name: "task_watch",
						arguments: {
							action: "arm",
							routineId: WATCH_ID,
							prompt: WATCH_PLAN,
							condition: { type: "file", path: flag, on: "created" },
							expiresAt,
						},
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j7-watcher-armed",
			check: (request) => {
				seen.results = latestBatchResults(request)
					.filter((result) => result.toolName === "task_watch")
					.map((result) => [result.toolName, result.isError, resultText(result.text)]);
				armed.release();
			},
			reply: { content: [{ type: "text", text: WATCHER_ARMED }] },
		},
		{
			name: "j7-watcher-woken",
			check: (request) => {
				assertWatchWake(latestWatchWakeText(request, WATCH_ID), {
					routineId: WATCH_ID,
					cause: "A watched file appeared: deploy.flag",
					plan: WATCH_PLAN,
					facts: { condition: "file", change: "created", label: "deploy.flag", facts: { sizeBytes: 6 } },
				});
			},
			reply: { content: [{ type: "text", text: WATCHER_WOKEN }] },
		},
	);

	// The owner's message starts a turn that calls a tool, so its words are judged as an owner request that calls a tool is
	// in a bot's own session: the owner-policy questions, and no optional-tool question, since the bot holds no optional
	// tool. The refused watch is refused by the watch's own rules before the bot's gate is asked about its command, and a
	// file watch makes no call, so nothing else is asked.
	if (world.systemOne.enabled) world.systemOne.enterPhase("j7-bot-watch", BOT_SESSION_JUDGMENTS);

	const sent = await session.sendOperatorMessageToBot(WATCHER, WATCH_REQUEST);
	await withDeadline(trace, "J7 bot watch: the bot armed its watches", armed.promise);
	await waitForBotRosterState(world, session, WATCHER, "idle");
	await untilRosterWatches(world, session, WATCHER, 1, "J7 bot watch: the roster shows the armed watch");
	const [refused, accepted] = seen.results;
	expect(
		{
			sent: sent.mode,
			holdsTaskWatch: seen.offered.includes("task_watch"),
			holdsRoutine: seen.offered.includes("routine"),
			holdsSelfCompact: seen.offered.includes("self_compact"),
			refused: refused ? [refused[1], refused[2].includes("This session has a read-only shell:")] : undefined,
			accepted: accepted ? [accepted[1], JSON.parse(accepted[2]) as unknown] : undefined,
			watches: rosterWatches(session, WATCHER),
		},
		"a bot's own session arms its own wait with task_watch and holds self_compact for its own context (read-only, System One on or off), a command its read-only shell would refuse is not armed, and the roster shows the armed watch",
	).toEqual({
		sent: "started",
		holdsTaskWatch: true,
		holdsRoutine: false,
		holdsSelfCompact: true,
		refused: [true, true],
		accepted: [false, { watchId: WATCH_ID, expiresAt: new Date(expiresAt).toISOString(), armed: true }],
		watches: 1,
	});

	// The file's absence when the watch was armed is its starting state: nothing fires for it.
	const untilFired = async (): Promise<void> => {
		for (let step = 0; step < 8 && outcome().fires === 0; step++) {
			world.timers.advance("routines", 500);
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	};
	await untilFired();
	expect(outcome().fires, "an absent file fires nothing while it stays absent").toBe(0);

	world.io.writeFileSync(flag, "ready\n");
	await untilFired();
	await withDeadline(
		trace,
		"J7 bot watch: the bot's own session was woken with the event",
		world.provider.whenReached(reached(TRACK.watcher, "j7-watcher-woken")),
	);
	await waitForBotRosterState(world, session, WATCHER, "idle");
	await untilRosterWatches(world, session, WATCHER, 0, "J7 bot watch: the spent watch left the roster");
	expect(
		{
			watch: outcome(),
			rootTurns: rootRequests() - rootBefore,
			workers: agentsOn(session, MODEL_ID.watcher).length,
			chat: chatText(session, WATCHER).includes(WATCHER_WOKEN),
			files: botSessionFilesText(world, WATCHER).includes(WATCHER_WOKEN),
		},
		"the firing is one delivered wake of the bot's own session, which answered in a turn of its own: no root turn, no worker",
	).toEqual({
		watch: { fires: 1, wakes: [["fired", true]] },
		rootTurns: 0,
		workers: 0,
		chat: true,
		files: true,
	});
}
