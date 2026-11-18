import "../builtin-install.ts";
import { dirname, join } from "node:path";
import { expect } from "vitest";
import { configFile } from "../../../../src/core/agent-paths.ts";
import { readRemoteBotHost } from "../../../../src/core/bots/bot-host-state.ts";
import { enqueueBotInbox, readBotInbox } from "../../../../src/core/bots/bot-inbox.ts";
import { OWED_INBOX_SWEEP_MS } from "../../../../src/core/bots/bot-session-owed-work.ts";
import { DAEMON_TICK_MS } from "../../../../src/core/delegation/bot-daemon.ts";
import { routineBotOccurrenceRef } from "../../../../src/core/routines/routine-bot-reference.ts";
import { createBarrier, HARNESS_PROVIDER, type ScriptStep } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, SCRIPTED_TRACKS, withDeadline } from "../session-fixture.ts";
import {
	botSessionFilesText,
	carries,
	createOwnerBot,
	enqueueBot,
	MODEL_ID,
	reached,
	TRACK,
} from "./journey-7-shared.ts";
import { currentRequestCarries, flushedSessionManager } from "./shared.ts";

const AWAY_BOT = "away-answerer";
const AWAY_SOUL = "You answer owner questions about the release window with one short sentence.";
const AWAY_QUESTION = "When does the release window open?";
const AWAY_ANSWER = "The release window opens on Monday.";
/** A reader of the bot's home that hosts nothing: it sees whichever host holds the bot's lock. */
const OBSERVER = "j7-daemon-observer";

/**
 * A bot is answered while no root session is open: the owner's message waits in the bot's inbox after the root that
 * launched the detached daemon closed, and the daemon opens the bot's own session under the bot's lock (its host state
 * naming the daemon and no pi session) and answers it there, once, with no root turn. While the root was open its
 * directory was the root's, so the daemon opened nothing there. Stopping the daemon closes the bot's session and gives
 * its lock back. The daemon reads the owner's global settings file of its own agent directory: the world's own settings
 * (the scripted models as favorites, the root's as the default, legacy memory, no delegation gate) with System One off,
 * so the bot's turn asks no judgment.
 */
export async function runJourney7DaemonBotPhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	const agentDir = `${world.agentDir}-daemon-bot`;
	world.io.seed(
		configFile(agentDir, "settings.json"),
		JSON.stringify({
			defaultProvider: HARNESS_PROVIDER,
			defaultModel: MODEL_ID.root,
			modelFavorites: SCRIPTED_TRACKS.map((modelId) => ({ provider: HARNESS_PROVIDER, modelId })),
			memorySystem: "okf",
			orchestrator: { delegationGate: false },
			systemOne: { enabled: false },
		}),
	);
	if (world.systemOne.enabled) world.systemOne.enterPhase("j7-daemon-bot", {});
	const rootRequests = () => world.provider.requests.filter((request) => request.model.id === MODEL_ID.root).length;
	const botRequests = () =>
		world.provider.requests.filter((request) => (request.context.systemPrompt ?? "").includes(AWAY_SOUL)).length;
	let hostDuringTurn: unknown;
	enqueueBot(world, TRACK.awayBot, MODEL_ID.awayBot, AWAY_SOUL, {
		name: "j7-away-bot-answer",
		check: (request) => {
			if (!carries(request, AWAY_QUESTION)) throw new Error("the owner's message waiting in the inbox is missing");
			const host = readRemoteBotHost(agentDir, AWAY_BOT, OBSERVER);
			hostDuringTurn = { pid: host?.pid, hostKind: host?.hostKind, hostSessionId: host?.hostSessionId };
		},
		reply: { content: [{ type: "text", text: AWAY_ANSWER }] },
	});

	const root = await world.createRootSession(MODEL_ID.root, {
		agentDir,
		sessionManager: flushedSessionManager(world, agentDir),
	});
	let rootOpen = true;
	try {
		createOwnerBot(root.session, AWAY_BOT, MODEL_ID.awayBot, AWAY_SOUL);
		const launched = world.processes.runNextBotDaemon();
		expect(root.session.backgroundLanes.startPersistentBotDaemon().started, "the root launched the daemon").toBe(
			true,
		);
		const daemon = await launched;
		try {
			rootOpen = false;
			expect(await world.disposeSessionInBody(root.session), "the root closes cleanly").toBeUndefined();
			const rootRequestsBefore = rootRequests();
			const botRequestsBefore = botRequests();
			// The owner's words from a sender with no pi session of its own, written while no root session is open.
			const sent = enqueueBotInbox(agentDir, {
				agentId: AWAY_BOT,
				text: AWAY_QUESTION,
				from: { pid: process.pid, cwd: HARNESS_PROJECT_CWD },
				at: Date.now(),
			});
			const answered = world.provider.whenReached(reached(TRACK.awayBot, "j7-away-bot-answer"));
			// The daemon's next tick reads the roots again (the one that left gives its directory back) and its periodic
			// inbox listing comes due: either opens the bot.
			world.timers.advance("routines", DAEMON_TICK_MS);
			world.timers.advance("bot-sessions", OWED_INBOX_SWEEP_MS);
			await withDeadline(
				trace,
				"J7 daemon bot: the daemon opened the bot and its turn reached its request",
				answered,
			);
			await withDeadline(
				trace,
				"J7 daemon bot: the bot's answer is in its own session files",
				world.io.waitForMutation(() => botSessionFilesText(world, AWAY_BOT, agentDir).includes(AWAY_ANSWER)),
			);
			expect(
				{
					host: hostDuringTurn,
					inbox: readBotInbox(agentDir, AWAY_BOT, () => undefined).map((item) => item.message.id),
					asked: botSessionFilesText(world, AWAY_BOT, agentDir).includes(AWAY_QUESTION),
					botRequests: botRequests() - botRequestsBefore,
					rootRequests: rootRequests() - rootRequestsBefore,
				},
				"with no root session open, the daemon hosted the bot's own session (its host state naming the daemon and no pi session) and answered the waiting message once, taking it out of the inbox, with no root turn",
			).toEqual({
				host: { pid: process.pid, hostKind: "daemon", hostSessionId: undefined },
				inbox: [],
				asked: true,
				botRequests: 1,
				rootRequests: 0,
			});
			expect(sent.message.from.sessionId, "the sender had no pi session").toBeUndefined();
		} finally {
			expect(await daemon.stop(), "the daemon stops cleanly").toBe(0);
		}
		expect(
			readRemoteBotHost(agentDir, AWAY_BOT, OBSERVER),
			"the daemon's stop gave the bot's lock back",
		).toBeUndefined();
	} finally {
		if (rootOpen) expect(await world.disposeSessionInBody(root.session)).toBeUndefined();
	}
	trace.mark("root", "j7.daemon-bot");
}

/** A named schedule survives its author and cannot steer a bot that is busy in a different project. */
export async function runJourney7ProjectBotSchedules(world: HarnessWorld): Promise<void> {
	const agentDir = `${world.agentDir}-project-schedules`;
	const project = HARNESS_PROJECT_CWD;
	const otherProject = join(dirname(project), "schedule-neighbor");
	world.io.mkdirSync(otherProject, { recursive: true });
	const settings = { routines: { away: { enabled: false, autostart: "off" as const } } };
	world.io.seed(configFile(agentDir, "settings.json"), JSON.stringify(settings));
	world.systemOne.enterPhase("j7-project-bot-schedules", {});
	const open = async (cwd: string) =>
		(
			await world.createRootSession(MODEL_ID.root, {
				agentDir,
				cwd,
				sessionManager: flushedSessionManager(world, agentDir, cwd),
				settings,
				systemOneEnabled: false,
			})
		).session;
	const author = await open(project);
	const bot = "project-scheduler";
	const soul = "You inspect the active checkout for the owner.";
	const prompt = "Read the retry budget in the main checkout.";
	const foreignPrompt = "Read the deployment window in the neighboring checkout.";
	const track = "j7-project-scheduler";
	const intervalMs = 60_000;
	const timer = world.timers.port("routines");
	const anchor = timer.now();
	const save = (owner: typeof author, routineId: string, words: string, recurring: boolean) =>
		owner.getBotTeamStore().upsertRoutine({
			...owner.backgroundLanes.captureBotScheduleOrigin(),
			routineId,
			target: { kind: "bot", agentId: bot },
			prompt: words,
			nowMs: anchor,
			schedule: recurring ? { kind: "interval", intervalMs } : { kind: "once", at: anchor + intervalMs },
		});
	createOwnerBot(author, bot, MODEL_ID.awayBot, soul);
	const recurring = save(author, "main-checkout", prompt, true);
	const authorStore = author.getBotTeamStore();
	const file = authorStore.getStoreFilePath();
	const original = world.io.readFileSync(file, "utf8") as string;
	const replacementPrompt = prompt.replace("main", "next");
	const updated = original.replace(prompt, replacementPrompt);
	expect(updated).not.toBe(original);
	expect(Buffer.byteLength(updated)).toBe(Buffer.byteLength(original));
	const firstObservation = world.io.operations.length;
	const snapshotReads = () =>
		world.io.operations.slice(firstObservation).filter((op) => op.kind === "read" && op.path === file).length;
	for (let poll = 0; poll < 3; poll++) {
		expect(authorStore.reload(true)).toBe(false);
		expect(authorStore.queueDueRoutinesForDaemon(anchor)).toBe(0);
	}
	expect(snapshotReads(), "three unchanged schedule observations read zero store bytes").toBe(0);
	world.io.writeFileSync(`${file}.new`, updated);
	world.io.renameSync(`${file}.new`, file);
	expect(authorStore.reload(true), "same-length replacement is observed").toBe(true);
	expect(authorStore.getRoutine(recurring.routineId)?.prompt).toBe(replacementPrompt);
	expect(authorStore.reload(true)).toBe(false);
	expect(snapshotReads(), "replacement is read once and reused by the next observer").toBe(1);
	world.io.writeFileSync(file, "{");
	expect(() => authorStore.reload(true), "truncation cannot serve the cached project schedule").toThrow();
	expect(authorStore.getRoutine(recurring.routineId)?.prompt).toBe(replacementPrompt);
	world.io.writeFileSync(file, original);
	expect(authorStore.reload(true)).toBe(true);
	expect(authorStore.getRoutine(recurring.routineId)?.prompt).toBe(prompt);
	expect(snapshotReads(), "truncation and repair each read the changed file").toBe(3);
	const authorId = author.sessionId;
	expect(await world.disposeSessionInBody(author)).toBeUndefined();

	const neighbor = await open(otherProject);
	const oneShot = save(neighbor, "neighbor-checkout", foreignPrompt, false);
	const store = neighbor.getBotTeamStore();
	const runs = (routineId: string) => {
		store.reload();
		return store.listRoutineOccurrences({ routineId });
	};
	const held = createBarrier();
	const release = createBarrier();
	const host = () => readRemoteBotHost(agentDir, bot, OBSERVER)?.hostSessionId;
	enqueueBot(world, track, MODEL_ID.awayBot, soul, {
		name: "neighbor-scheduled-turn",
		gate: release.promise,
		check: (request) => {
			expect(host()).toBe(neighbor.sessionId);
			expect(currentRequestCarries(request, foreignPrompt)).toBe(true);
			expect(currentRequestCarries(request, prompt)).toBe(false);
			held.release();
		},
		reply: { content: [{ type: "text", text: "The deployment window starts at dusk." }] },
	});
	let replacement: typeof author | undefined;
	try {
		world.timers.advance("routines", intervalMs);
		await withDeadline(world.trace, "the neighbor's scheduled bot turn is in flight", held.promise);
		expect(runs(oneShot.routineId)).toHaveLength(1);
		expect(runs(recurring.routineId), "the neighbor root cannot take the closed project's slot").toEqual([]);

		const main = await open(project);
		replacement = main;
		expect(main.sessionId).not.toBe(authorId);
		const answers = ["The retry budget is three.", "The retry budget is still three."];
		enqueueBot(
			world,
			track,
			MODEL_ID.awayBot,
			soul,
			...answers.map(
				(answer, slot): ScriptStep => ({
					name: `main-scheduled-turn-${slot + 1}`,
					check: (request) => {
						expect(host()).toBe(main.sessionId);
						expect(currentRequestCarries(request, prompt)).toBe(true);
						expect(currentRequestCarries(request, foreignPrompt)).toBe(false);
					},
					reply: { content: [{ type: "text", text: answer }] },
				}),
			),
		);
		await main.tickPersistentRoutines();
		expect(runs(recurring.routineId)).toHaveLength(1);
		expect(host(), "the busy neighbor still holds the bot").toBe(neighbor.sessionId);
		expect(botSessionFilesText(world, bot, agentDir)).not.toContain(prompt);
		expect(readBotInbox(agentDir, bot, () => undefined).some(({ message }) => message.text === prompt)).toBe(true);

		release.release();
		const answered = (answer: string) =>
			withDeadline(
				world.trace,
				answer,
				world.io.waitForMutation(() => botSessionFilesText(world, bot, agentDir).includes(answer)),
			);
		await answered(answers[0]!);
		world.timers.advance("routines", intervalMs);
		await main.tickPersistentRoutines();
		await answered(answers[1]!);
		const settled = runs(recurring.routineId);
		expect(
			settled.map(({ phase, result, executor, parentOrigin }) => ({
				phase,
				outcome: result?.outcome,
				executor,
				author: parentOrigin.sessionId,
			})),
		).toEqual(
			Array.from({ length: 2 }, () => ({
				phase: "terminal",
				outcome: "succeeded",
				executor: undefined,
				author: authorId,
			})),
		);
		expect(new Set(settled.map(({ occurrenceId }) => occurrenceId)).size).toBe(2);
		expect(settled.map(({ trigger }) => trigger)).toEqual(
			expect.arrayContaining(
				[1, 2].map((slot) => ({
					kind: "schedule",
					scheduledAt: anchor + slot * intervalMs,
					missedCount: 0,
				})),
			),
		);
		const transcript = botSessionFilesText(world, bot, agentDir);
		for (const run of settled) expect(transcript).toContain(routineBotOccurrenceRef(run.occurrenceId));
		expect(runs(oneShot.routineId)).toHaveLength(1);
	} finally {
		release.release();
		if (replacement) expect(await world.disposeSessionInBody(replacement)).toBeUndefined();
		expect(await world.disposeSessionInBody(neighbor)).toBeUndefined();
	}
}
