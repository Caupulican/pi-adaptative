import "../builtin-install.ts";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { createBarrier } from "../scripted-provider.ts";
import { type HarnessWorld, projectPath, withDeadline } from "../session-fixture.ts";
import {
	agentsOn,
	botSessionFilesText,
	chatText,
	createOwnerBot,
	enqueueBot,
	MODEL_ID,
	offeredTools,
	PHASE_JUDGMENTS,
	reached,
	TRACK,
	waitForBotRosterState,
} from "./journey-7-shared.ts";
import { assertWatchWake, latestWatchWakeText } from "./journey-watch-wake.ts";
import { fencedToolOutput, latestBatchResults, refusalDiagnostic } from "./shared.ts";

const WATCHER = "flag-watcher";
const WATCHER_SOUL = "You wait on the deploy flag for the owner and answer in one short sentence.";
const WATCH_REQUEST = "Tell me when deploy.flag appears.";
const WATCH_ID = "deploy-flag";
const WATCH_PLAN = "Tell the owner the deploy flag is up.";
const WRITE_WATCH_ID = "touch-flag";
const WATCHER_ARMED = "I will tell you when deploy.flag appears.";
const WATCHER_WOKEN = "The deploy flag is up.";

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
	const occurrences = () => {
		const store = session.getBotTeamStore();
		store.reload(true);
		return store.listRoutineOccurrences({ routineId: WATCH_ID });
	};
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

	// The owner's message starts a turn that calls a tool, so its words are judged as an owner request that calls a tool is.
	// The refused watch is refused by the watch's own rules before the bot's gate is asked about its command, and a file
	// watch makes no call, so nothing else is asked.
	if (world.systemOne.enabled) world.systemOne.enterPhase("j7-bot-watch", PHASE_JUDGMENTS);

	// The roster's count follows the store through the home watch: it is polled, and the poll ends with the wait, whether the
	// count reached `count` or the deadline passed.
	const untilRosterWatches = async (count: number, label: string): Promise<void> => {
		let ended = false;
		try {
			await withDeadline(
				trace,
				label,
				(async () => {
					while (!ended && rosterWatches(session, WATCHER) !== count)
						await new Promise<void>((resolve) => setImmediate(resolve));
				})(),
			);
		} finally {
			ended = true;
		}
	};

	const sent = await session.sendOperatorMessageToBot(WATCHER, WATCH_REQUEST);
	await withDeadline(trace, "J7 bot watch: the bot armed its watches", armed.promise);
	await waitForBotRosterState(world, session, WATCHER, "idle");
	await untilRosterWatches(1, "J7 bot watch: the roster shows the armed watch");
	const [refused, accepted] = seen.results;
	expect(
		{
			sent: sent.mode,
			holdsTaskWatch: seen.offered.includes("task_watch"),
			holdsRoutine: seen.offered.includes("routine"),
			refused: refused ? [refused[1], refused[2].includes("This session has a read-only shell:")] : undefined,
			accepted: accepted ? [accepted[1], JSON.parse(accepted[2]) as unknown] : undefined,
			watches: rosterWatches(session, WATCHER),
		},
		"a bot's own session arms its own wait with task_watch, a command its read-only shell would refuse is not armed, and the roster shows the armed watch",
	).toEqual({
		sent: "started",
		holdsTaskWatch: true,
		holdsRoutine: false,
		refused: [true, true],
		accepted: [false, { routineId: WATCH_ID, revision: 1, armed: true }],
		watches: 1,
	});

	// The file's absence when the watch was armed is its starting state: nothing fires for it.
	const untilFired = async (): Promise<void> => {
		for (let step = 0; step < 8 && occurrences().length === 0; step++) {
			world.timers.advance("routines", 500);
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	};
	await untilFired();
	expect(occurrences(), "an absent file fires nothing while it stays absent").toHaveLength(0);

	world.io.writeFileSync(flag, "ready\n");
	await untilFired();
	await withDeadline(
		trace,
		"J7 bot watch: the bot's own session was woken with the event",
		world.provider.whenReached(reached(TRACK.watcher, "j7-watcher-woken")),
	);
	await waitForBotRosterState(world, session, WATCHER, "idle");
	await untilRosterWatches(0, "J7 bot watch: the spent watch left the roster");
	expect(
		{
			runs: occurrences().map((run) => [run.phase, run.result?.outcome, run.result?.delivery]),
			rootTurns: rootRequests() - rootBefore,
			workers: agentsOn(session, MODEL_ID.watcher).length,
			chat: chatText(session, WATCHER).includes(WATCHER_WOKEN),
			files: botSessionFilesText(world, WATCHER).includes(WATCHER_WOKEN),
		},
		"the firing is one delivered wake of the bot's own session, which answered in a turn of its own: no root turn, no worker",
	).toEqual({
		runs: [["terminal", "succeeded", "acknowledged"]],
		rootTurns: 0,
		workers: 0,
		chat: true,
		files: true,
	});
}
